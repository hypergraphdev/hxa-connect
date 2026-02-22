import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HubDB } from './db.js';
import type { HubWS } from './ws.js';
import { authMiddleware, requireAgent, requireOrg } from './auth.js';
import { validateParts, type HubConfig, type Agent, type AgentProfileInput, type Thread, type ThreadStatus, type ThreadType, type CloseReason, type ArtifactType, type MessagePart, type Message, type ThreadMessage, type WireMessage, type WireThreadMessage, type CatchupResponse, type CatchupCountResponse, type OrgSettings } from './types.js';

function parseJsonField<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toAgentResponse(agent: Agent) {
  return {
    id: agent.id,
    org_id: agent.org_id,
    name: agent.name,
    display_name: agent.display_name,
    online: agent.online,
    last_seen_at: agent.last_seen_at,
    created_at: agent.created_at,
    metadata: parseJsonField<Record<string, unknown>>(agent.metadata),
    bio: agent.bio,
    role: agent.role,
    function: agent.function,
    team: agent.team,
    tags: parseJsonField<string[]>(agent.tags),
    languages: parseJsonField<string[]>(agent.languages),
    protocols: parseJsonField<Record<string, unknown>>(agent.protocols),
    status_text: agent.status_text,
    timezone: agent.timezone,
    active_hours: agent.active_hours,
    version: agent.version,
    runtime: agent.runtime,
  };
}

function getQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

// ─── MessageV2 Helpers ───────────────────────────────────────
// validateParts is imported from types.ts

/**
 * Extract a plain text content string from parts array for backward compat.
 * Uses the first text or markdown part.
 */
function contentFromParts(parts: MessagePart[]): string {
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'markdown') return part.content;
  }
  // Fallback: describe what the message contains
  const types = parts.map(p => p.type);
  return `[${types.join(', ')}]`;
}

/**
 * Enrich a Message for wire format: parse parts JSON string into array.
 * When parts is null (legacy message), auto-generate from content.
 */
function enrichMessage(msg: Message): WireMessage {
  let parsed: MessagePart[];
  try {
    parsed = msg.parts
      ? JSON.parse(msg.parts)
      : [{ type: 'text', content: msg.content }];
  } catch {
    parsed = [{ type: 'text', content: msg.content }];
  }
  return { ...msg, parts: parsed };
}

/**
 * Enrich a ThreadMessage for wire format: parse parts JSON string into array.
 * When parts is null (legacy message), auto-generate from content.
 */
function enrichThreadMessage(msg: ThreadMessage): WireThreadMessage {
  let parsed: MessagePart[];
  try {
    parsed = msg.parts
      ? JSON.parse(msg.parts)
      : [{ type: 'text', content: msg.content }];
  } catch {
    parsed = [{ type: 'text', content: msg.content }];
  }
  return { ...msg, parts: parsed };
}

const THREAD_TYPES = new Set<ThreadType>(['discussion', 'request', 'collab']);
const THREAD_STATUSES = new Set<ThreadStatus>(['open', 'active', 'blocked', 'reviewing', 'resolved', 'closed']);
const CLOSE_REASONS = new Set<CloseReason>(['manual', 'timeout', 'error']);
const ARTIFACT_TYPES = new Set<ArtifactType>(['text', 'markdown', 'json', 'code', 'file', 'link']);
const ARTIFACT_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;

export function createRouter(db: HubDB, ws: HubWS, config: HubConfig): Router {
  const router = Router();

  // ─── Public: Setup ────────────────────────────────────────

  // Admin secret check helper
  function requireAdmin(req: import('express').Request, res: import('express').Response): boolean {
    if (!config.admin_secret) return true; // No secret = open (local/dev mode)
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!token) {
      res.status(401).json({ error: 'Admin authentication required' });
      return false;
    }
    const expected = Buffer.from(config.admin_secret, 'utf8');
    const actual = Buffer.from(token, 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      res.status(401).json({ error: 'Admin authentication required' });
      return false;
    }
    return true;
  }

  function requireOrgOrAgent(req: import('express').Request, res: import('express').Response): string | undefined {
    if (req.agent) return req.agent.org_id;
    if (req.org) return req.org.id;
    res.status(403).json({ error: 'Authentication required' });
    return undefined;
  }

  function requireOrgAdmin(req: import('express').Request, res: import('express').Response): boolean {
    if (!req.org) {
      res.status(403).json({ error: 'Organization authentication required' });
      return false;
    }
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || !db.verifyOrgAdminSecret(req.org.id, adminSecret)) {
      res.status(403).json({ error: 'Org admin secret required' });
      return false;
    }
    return true;
  }

  function checkMessageRateLimit(req: import('express').Request, res: import('express').Response): boolean {
    if (!req.agent) return true; // org-level requests don't have per-bot rate limits
    const result = db.checkAndRecordRateLimit(req.agent.org_id, req.agent.id, 'message');
    if (!result.allowed) {
      res.status(429).set('Retry-After', String(result.retryAfter)).json({
        error: 'Rate limit exceeded: messages per minute',
        retry_after: result.retryAfter,
      });
      return false;
    }
    return true;
  }

  function checkThreadRateLimit(req: import('express').Request, res: import('express').Response): boolean {
    if (!req.agent) return true;
    const result = db.checkAndRecordRateLimit(req.agent.org_id, req.agent.id, 'thread');
    if (!result.allowed) {
      res.status(429).set('Retry-After', String(result.retryAfter)).json({
        error: 'Rate limit exceeded: threads per hour',
        retry_after: result.retryAfter,
      });
      return false;
    }
    return true;
  }

  function resolveAgent(orgId: string, idOrName: unknown): Agent | undefined {
    if (typeof idOrName !== 'string') return undefined;
    // Check ID first, but only accept if it belongs to this org
    const byId = db.getAgentById(idOrName);
    if (byId && byId.org_id === orgId) return byId;
    // Fall back to name lookup within the org
    const byName = db.getAgentByName(orgId, idOrName);
    if (byName) return byName;
    return undefined;
  }

  function requireThreadParticipant(
    req: import('express').Request,
    res: import('express').Response,
    threadId: string,
  ): Thread | undefined {
    const thread = db.getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return undefined;
    }

    if (!req.agent || !db.isParticipant(thread.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a participant of this thread' });
      return undefined;
    }

    return thread;
  }

  /**
   * POST /api/orgs — Create an organization
   * Body: { name, persist_messages? }
   * Auth: Admin secret (if BOTSHUB_ADMIN_SECRET is set)
   * Returns: org with api_key
   */
  router.post('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, persist_messages } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const org = db.createOrg(name, persist_messages ?? config.default_persist);
    res.json(org);
  });

  /**
   * GET /api/orgs — List all orgs
   * Auth: Admin secret (if BOTSHUB_ADMIN_SECRET is set)
   */
  router.get('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(db.listOrgs());
  });

  // ─── Authenticated Routes ─────────────────────────────────

  const auth = Router();
  auth.use(authMiddleware(db));

  /**
   * POST /api/register — Register an agent
   * Auth: Org API key
   * Body: { name, display_name?, metadata? }
   * Returns: { agent_id, token, name }
   */
  auth.post('/api/register', requireOrg, (req, res) => {
    const {
      name,
      display_name,
      metadata,
      webhook_url,
      webhook_secret,
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, _, -)' });
      return;
    }

    // Validate profile field types
    const stringFields = { bio, role, function: functionName, team, status_text, timezone, active_hours, version, runtime };
    for (const [key, val] of Object.entries(stringFields)) {
      if (val !== undefined && val !== null && typeof val !== 'string') {
        res.status(400).json({ error: `${key} must be a string or null` });
        return;
      }
    }
    for (const [key, val] of Object.entries({ tags, languages }) as [string, unknown][]) {
      if (val !== undefined && val !== null && (!Array.isArray(val) || !val.every((v: unknown) => typeof v === 'string'))) {
        res.status(400).json({ error: `${key} must be an array of strings or null` });
        return;
      }
    }
    if (protocols !== undefined && protocols !== null && typeof protocols !== 'object') {
      res.status(400).json({ error: 'protocols must be an object or null' });
      return;
    }

    const profile: AgentProfileInput = {
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    };

    const agent = db.registerAgent(req.org!.id, name, display_name, metadata, webhook_url, webhook_secret, profile);

    // Audit
    db.recordAudit(req.org!.id, agent.id, 'bot.register', 'agent', agent.id, { name: agent.name });

    // Broadcast agent online to all org viewers (Web UI etc.)
    ws.broadcastToOrg(req.org!.id, {
      type: 'agent_online',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    res.json({
      agent_id: agent.id,
      token: agent.token,
      ...toAgentResponse(agent),
    });
  });

  /**
   * GET /api/agents — List agents in the org
   */
  auth.get('/api/agents', requireOrg, (req, res) => {
    const agents = db.listAgents(req.org!.id);
    res.json(agents.map(a => toAgentResponse(a)));
  });

  /**
   * DELETE /api/agents/:id — Remove an agent (org admin only)
   * Auth: Org API Key + Org Admin Secret (via X-Admin-Secret header)
   */
  auth.delete('/api/agents/:id', requireOrg, (req, res) => {
    // Require org admin secret
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || !db.verifyOrgAdminSecret(req.org!.id, adminSecret)) {
      res.status(403).json({ error: 'Org admin secret required' });
      return;
    }

    const agent = db.getAgentById(req.params.id as string);
    if (!agent || agent.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    db.deleteAgent(agent.id);

    // Audit
    db.recordAudit(req.org!.id, agent.id, 'bot.delete', 'agent', agent.id, { name: agent.name });

    // Broadcast agent offline
    ws.broadcastToOrg(agent.org_id, {
      type: 'agent_offline',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    res.json({ ok: true, message: `Agent "${agent.name}" deleted` });
  });

  /**
   * DELETE /api/me — Deregister self (agent unregisters itself)
   * Auth: Agent token
   */
  auth.delete('/api/me', requireAgent, (req, res) => {
    const agent = req.agent!;
    db.deleteAgent(agent.id);

    // Audit
    db.recordAudit(agent.org_id, agent.id, 'bot.delete', 'agent', agent.id, { name: agent.name, self: true });

    // Broadcast agent offline
    ws.broadcastToOrg(agent.org_id, {
      type: 'agent_offline',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    res.json({ ok: true, message: `Agent "${agent.name}" deregistered` });
  });

  /**
   * GET /api/me — Get current agent info
   */
  auth.get('/api/me', requireAgent, (req, res) => {
    const a = req.agent!;
    res.json(toAgentResponse(a));
  });

  /**
   * PATCH /api/me/profile — Update current bot profile fields
   */
  auth.patch('/api/me/profile', requireAgent, (req, res) => {
    const {
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    } = req.body;

    const fields: AgentProfileInput = {
      bio,
      role,
      function: functionName,
      team,
      tags,
      languages,
      protocols,
      status_text,
      timezone,
      active_hours,
      version,
      runtime,
    };

    if (Object.values(fields).every(v => v === undefined)) {
      res.status(400).json({ error: 'No profile fields provided' });
      return;
    }

    // Validate field types to prevent 500s and invalid stored data
    const stringFields = { bio, role, function: functionName, team, status_text, timezone, active_hours, version, runtime };
    for (const [key, val] of Object.entries(stringFields)) {
      if (val !== undefined && val !== null && typeof val !== 'string') {
        res.status(400).json({ error: `${key} must be a string or null` });
        return;
      }
    }
    for (const [key, val] of Object.entries({ tags, languages }) as [string, unknown][]) {
      if (val !== undefined && val !== null && (!Array.isArray(val) || !val.every((v: unknown) => typeof v === 'string'))) {
        res.status(400).json({ error: `${key} must be an array of strings or null` });
        return;
      }
    }
    if (protocols !== undefined && protocols !== null && typeof protocols !== 'object') {
      res.status(400).json({ error: 'protocols must be an object or null' });
      return;
    }

    const updated = db.updateProfile(req.agent!.id, fields);
    if (!updated) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Audit
    const changedFields = Object.keys(fields).filter(k => (fields as any)[k] !== undefined);
    db.recordAudit(req.agent!.org_id, req.agent!.id, 'bot.profile_update', 'agent', req.agent!.id, { fields: changedFields });

    req.agent = updated;
    res.json(toAgentResponse(updated));
  });

  /**
   * GET /api/peers — List other agents in my org (from agent perspective)
   */
  auth.get('/api/peers', requireAgent, (req, res) => {
    const agents = db.listAgents(req.agent!.org_id);
    res.json(agents
      .filter(a => a.id !== req.agent!.id)
      .map(a => toAgentResponse(a))
    );
  });

  /**
   * GET /api/bots — Discover bots in org
   * Query: role?, tag?, status?, q?
   * Auth: org API key or agent token
   */
  auth.get('/api/bots', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const role = getQueryString(req.query.role);
    const tag = getQueryString(req.query.tag);
    const status = getQueryString(req.query.status);
    const q = getQueryString(req.query.q);

    const bots = db.listBots(orgId, { role, tag, status, q });
    res.json(bots.map(bot => toAgentResponse(bot)));
  });

  /**
   * GET /api/bots/:name/webhook/health — Check webhook health for a bot
   * Auth: agent token or org API key
   * Org-scoped: only check bots in the same org
   */
  auth.get('/api/bots/:name/webhook/health', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const bot = db.getAgentByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    const health = db.getWebhookHealth(bot.id);
    if (!health) {
      // No webhook activity recorded yet
      res.json({
        healthy: true,
        last_success: null,
        last_failure: null,
        consecutive_failures: 0,
        degraded: false,
      });
      return;
    }

    res.json(health);
  });

  /**
   * GET /api/bots/:name/profile — Get full profile by bot name
   * Auth: org API key or agent token
   */
  auth.get('/api/bots/:name/profile', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const bot = db.getAgentByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    res.json(toAgentResponse(bot));
  });

  // ─── Channels ─────────────────────────────────────────────

  /**
   * POST /api/channels — Create a channel
   * Body: { type: 'direct'|'group', members: [agent_id_or_name, ...], name? }
   */
  auth.post('/api/channels', requireOrg, (req, res) => {
    const { type, members, name } = req.body;
    const orgId = req.org!.id;

    if (!type || !members || !Array.isArray(members) || members.length < 2) {
      res.status(400).json({ error: 'type and members (≥2) are required' });
      return;
    }

    // Resolve member names to IDs
    const memberIds: string[] = [];
    for (const m of members) {
      const agent = db.getAgentById(m) || db.getAgentByName(orgId, m);
      if (!agent || agent.org_id !== orgId) {
        res.status(400).json({ error: `Agent not found: ${m}` });
        return;
      }
      memberIds.push(agent.id);
    }

    const channel = db.createChannel(orgId, type, memberIds, name);

    // Audit
    db.recordAudit(orgId, null, 'channel.create', 'channel', channel.id, { type, name: name ?? null, members: memberIds });

    // Broadcast channel creation
    ws.broadcastToOrg(orgId, {
      type: 'channel_created',
      channel,
      members: memberIds,
    });

    res.json({ ...channel, members: memberIds });
  });

  /**
   * GET /api/channels — List channels
   * For agents: channels they're in
   * For org admins: all channels
   */
  auth.get('/api/channels', (req, res) => {
    if (req.agent) {
      res.json(db.listChannelsForAgent(req.agent.id));
    } else if (req.org) {
      res.json(db.listChannelsForOrg(req.org.id));
    } else {
      res.status(403).json({ error: 'Authentication required' });
    }
  });

  /**
   * GET /api/channels/:id — Get channel details
   */
  auth.get('/api/channels/:id', (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Check access
    if (req.agent && !db.isChannelMember(channel.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org' });
      return;
    }

    const members = db.getChannelMembers(channel.id).map(m => {
      const agent = db.getAgentById(m.agent_id);
      return {
        id: m.agent_id,
        name: agent?.name,
        display_name: agent?.display_name,
        online: agent?.online,
      };
    });

    res.json({ ...channel, members });
  });

  /**
   * POST /api/channels/:id/join — Join a group channel (agent)
   */
  auth.post('/api/channels/:id/join', requireAgent, (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.type !== 'group') {
      res.status(404).json({ error: 'Group channel not found' });
      return;
    }
    if (channel.org_id !== req.agent!.org_id) {
      res.status(403).json({ error: 'Channel not in your org' });
      return;
    }
    db.addChannelMember(channel.id, req.agent!.id);
    res.json({ ok: true });
  });

  /**
   * DELETE /api/channels/:id — Delete a channel (org admin only)
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.delete('/api/channels/:id', requireOrg, (req, res) => {
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || !db.verifyOrgAdminSecret(req.org!.id, adminSecret)) {
      res.status(403).json({ error: 'Org admin secret required' });
      return;
    }

    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    db.deleteChannel(channel.id);

    // Audit
    db.recordAudit(req.org!.id, null, 'channel.delete', 'channel', channel.id, { name: channel.name });

    // Broadcast channel deletion
    ws.broadcastToOrg(req.org!.id, {
      type: 'channel_deleted' as any,
      channel_id: channel.id,
    });

    res.json({ ok: true, message: `Channel deleted` });
  });

  // ─── Org Admin Thread Endpoints ──────────────────────────

  /**
   * GET /api/org/threads — List all threads in the org
   * Query: status? (filter by thread status)
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.get('/api/org/threads', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const statusRaw = getQueryString(req.query.status);
    if (statusRaw && !THREAD_STATUSES.has(statusRaw as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const status = statusRaw as ThreadStatus | undefined;
    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const offset = Math.max(parseInt(getQueryString(req.query.offset) || '') || 0, 0);

    const threads = db.listThreadsForOrg(req.org!.id, status, limit, offset);
    res.json(threads);
  });

  /**
   * GET /api/org/threads/:id — Thread detail with participants
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.get('/api/org/threads/:id', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const participants = db.getParticipants(thread.id).map(p => {
      const bot = db.getAgentById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
        display_name: bot?.display_name,
        online: bot?.online,
        label: p.label,
        joined_at: p.joined_at,
      };
    });

    res.setHeader('ETag', `"${thread.revision}"`);
    res.json({ ...thread, participants });
  });

  /**
   * GET /api/org/threads/:id/messages — Thread messages (enriched with parts)
   * Query: limit?, before?
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.get('/api/org/threads/:id/messages', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    const messages = db.getThreadMessages(thread.id, limit, before);
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getAgentById(m.sender_id) : undefined;
      return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse());
  });

  /**
   * GET /api/org/threads/:id/artifacts — Thread artifacts
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.get('/api/org/threads/:id/artifacts', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    res.json(db.listArtifacts(thread.id));
  });

  // ─── Threads ─────────────────────────────────────────────

  /**
   * POST /api/threads — Create a thread
   * Body: { topic, type?, participants?, channel_id?, context? }
   */
  auth.post('/api/threads', requireAgent, (req, res) => {
    if (!checkThreadRateLimit(req, res)) return;

    const { topic, type, participants, channel_id, context } = req.body;
    const orgId = req.agent!.org_id;

    if (!topic || typeof topic !== 'string') {
      res.status(400).json({ error: 'topic is required' });
      return;
    }

    const threadType = (typeof type === 'string' ? type : 'discussion') as ThreadType;
    if (!THREAD_TYPES.has(threadType)) {
      res.status(400).json({ error: 'Invalid thread type' });
      return;
    }

    if (participants !== undefined && !Array.isArray(participants)) {
      res.status(400).json({ error: 'participants must be an array' });
      return;
    }

    const resolvedParticipantIds: string[] = [];
    for (const p of (participants || [])) {
      const bot = resolveAgent(orgId, p);
      if (!bot) {
        res.status(400).json({ error: `Agent not found: ${p}` });
        return;
      }
      resolvedParticipantIds.push(bot.id);
    }

    let resolvedChannelId: string | undefined;
    if (channel_id !== undefined && channel_id !== null) {
      if (typeof channel_id !== 'string') {
        res.status(400).json({ error: 'channel_id must be a string' });
        return;
      }

      const channel = db.getChannel(channel_id);
      if (!channel || channel.org_id !== orgId) {
        res.status(400).json({ error: 'Invalid channel_id' });
        return;
      }
      resolvedChannelId = channel.id;
    }

    let contextJson: string | null | undefined;
    if (context !== undefined) {
      if (context === null) {
        contextJson = null;
      } else if (typeof context === 'string') {
        contextJson = context;
      } else {
        try {
          contextJson = JSON.stringify(context);
        } catch {
          res.status(400).json({ error: 'context must be JSON-serializable' });
          return;
        }
      }
    }

    try {
      const thread = db.createThread(
        orgId,
        req.agent!.id,
        topic,
        threadType,
        resolvedParticipantIds,
        resolvedChannelId,
        contextJson,
      );

      // Audit (rate limit event already recorded atomically in checkThreadRateLimit)
      db.recordAudit(orgId, req.agent!.id, 'thread.create', 'thread', thread.id, { topic, type: threadType });

      // Record catchup events: thread_invited for each participant (except initiator)
      const allParticipantIds = Array.from(new Set([req.agent!.id, ...resolvedParticipantIds]));
      for (const pid of allParticipantIds) {
        if (pid === req.agent!.id) continue;
        db.recordCatchupEvent(orgId, pid, 'thread_invited', {
          thread_id: thread.id,
          topic: thread.topic,
          inviter: req.agent!.id,
        });
      }

      ws.broadcastThreadEvent(orgId, thread.id, {
        type: 'thread_created',
        thread,
      });

      res.setHeader('ETag', `"${thread.revision}"`);
      res.json(thread);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to create thread' });
    }
  });

  /**
   * GET /api/threads — List my threads
   * Query: status?
   */
  auth.get('/api/threads', requireAgent, (req, res) => {
    const statusRaw = getQueryString(req.query.status);
    if (statusRaw && !THREAD_STATUSES.has(statusRaw as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const status = statusRaw as ThreadStatus | undefined;
    const threads = db.listThreadsForAgent(req.agent!.id, status);
    res.json(threads);
  });

  /**
   * GET /api/threads/:id — Thread details with participants
   */
  auth.get('/api/threads/:id', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const participants = db.getParticipants(thread.id).map(p => {
      const bot = db.getAgentById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
        display_name: bot?.display_name,
        online: bot?.online,
        label: p.label,
        joined_at: p.joined_at,
      };
    });

    res.setHeader('ETag', `"${thread.revision}"`);
    res.json({ ...thread, participants });
  });

  /**
   * PATCH /api/threads/:id — Update thread status/context/topic
   * Body: { status?, close_reason?, context?, topic? }
   */
  auth.patch('/api/threads/:id', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    // Optimistic concurrency: If-Match header carries expected revision
    let expectedRevision: number | undefined;
    const ifMatch = req.headers['if-match'];
    if (ifMatch) {
      // Strip surrounding quotes: "3" → 3
      const raw = typeof ifMatch === 'string' ? ifMatch.replace(/^"|"$/g, '') : '';
      const parsed = parseInt(raw, 10);
      if (isNaN(parsed)) {
        res.status(400).json({ error: 'Invalid If-Match header; expected a revision number' });
        return;
      }
      expectedRevision = parsed;
    }

    const { status: statusInput, close_reason, context, topic } = req.body;
    if (statusInput === undefined && context === undefined && close_reason === undefined && topic === undefined) {
      res.status(400).json({ error: 'No updatable fields provided' });
      return;
    }

    // Block all mutations on terminal threads (status transitions handled separately in updateThreadStatus)
    if ((thread.status === 'resolved' || thread.status === 'closed') && statusInput === undefined) {
      res.status(409).json({ error: 'Thread is in terminal state; no updates allowed' });
      return;
    }

    if (topic !== undefined && (typeof topic !== 'string' || topic.trim().length === 0)) {
      res.status(400).json({ error: 'topic must be a non-empty string' });
      return;
    }

    let status: ThreadStatus | undefined;
    if (statusInput !== undefined) {
      if (typeof statusInput !== 'string' || !THREAD_STATUSES.has(statusInput as ThreadStatus)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }
      status = statusInput as ThreadStatus;
    }

    let closeReason: CloseReason | undefined;
    if (close_reason !== undefined) {
      if (typeof close_reason !== 'string' || !CLOSE_REASONS.has(close_reason as CloseReason)) {
        res.status(400).json({ error: 'Invalid close_reason' });
        return;
      }
      closeReason = close_reason as CloseReason;
    }

    if (status === 'closed' && closeReason === undefined) {
      res.status(400).json({ error: 'close_reason is required for closed status' });
      return;
    }
    if (status !== 'closed' && closeReason !== undefined) {
      res.status(400).json({ error: 'close_reason is only allowed with closed status' });
      return;
    }

    let contextJson: string | null | undefined;
    if (context !== undefined) {
      if (context === null) {
        contextJson = null;
      } else if (typeof context === 'string') {
        contextJson = context;
      } else {
        try {
          contextJson = JSON.stringify(context);
        } catch {
          res.status(400).json({ error: 'context must be JSON-serializable' });
          return;
        }
      }
    }

    const changes: string[] = [];
    let updated: Thread | undefined = thread;
    // Revision check applies only to the first DB update; subsequent updates in the same
    // PATCH are trusted (the first write proves we held the correct revision).
    let revCheck = expectedRevision;

    try {
      if (status !== undefined) {
        const previousStatus = thread.status;
        updated = db.updateThreadStatus(thread.id, status, closeReason, revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        changes.push('status');
        if (status === 'closed') changes.push('close_reason');
        if (status === 'resolved') changes.push('resolved_at');

        // Audit
        db.recordAudit(thread.org_id, req.agent!.id, 'thread.status_changed', 'thread', thread.id, {
          from: previousStatus,
          to: status,
          close_reason: closeReason ?? null,
        });

        // Record catchup event for all participants
        const participants = db.getParticipants(thread.id);
        for (const p of participants) {
          db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_status_changed', {
            thread_id: thread.id,
            topic: thread.topic,
            from: previousStatus,
            to: status,
            by: req.agent!.id,
          });
        }
      }

      if (context !== undefined) {
        updated = db.updateThreadContext(thread.id, contextJson ?? null, revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        changes.push('context');
      }

      if (topic !== undefined) {
        updated = db.updateThreadTopic(thread.id, topic.trim(), revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        changes.push('topic');
      }
    } catch (error: any) {
      if (error.message === 'REVISION_CONFLICT') {
        res.status(409).json({ error: 'Conflict: thread was modified concurrently' });
        return;
      }
      res.status(400).json({ error: error.message || 'Failed to update thread' });
      return;
    }

    ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_updated',
      thread: updated!,
      changes,
    });

    res.setHeader('ETag', `"${updated!.revision}"`);
    res.json(updated);
  });

  /**
   * POST /api/threads/:id/participants — Invite bot (id or name)
   * Body: { bot_id, label? }
   */
  auth.post('/api/threads/:id/participants', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: 'Thread is in terminal state; no participant changes allowed' });
      return;
    }

    const { bot_id, label } = req.body;
    if (!bot_id || typeof bot_id !== 'string') {
      res.status(400).json({ error: 'bot_id is required' });
      return;
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      res.status(400).json({ error: 'label must be a string' });
      return;
    }

    const bot = resolveAgent(thread.org_id, bot_id);
    if (!bot) {
      res.status(404).json({ error: `Agent not found: ${bot_id}` });
      return;
    }

    const alreadyParticipant = db.isParticipant(thread.id, bot.id);
    try {
      const participant = db.addParticipant(thread.id, bot.id, label);

      if (!alreadyParticipant) {
        // Audit
        db.recordAudit(thread.org_id, req.agent!.id, 'thread.invite', 'thread', thread.id, {
          invited_bot_id: bot.id,
          invited_bot_name: bot.name,
        });

        // Record catchup event for the invited bot
        db.recordCatchupEvent(thread.org_id, bot.id, 'thread_invited', {
          thread_id: thread.id,
          topic: thread.topic,
          inviter: req.agent!.id,
        });

        ws.broadcastThreadEvent(thread.org_id, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: bot.id,
          action: 'joined',
        });
      }

      res.json(participant);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to add participant' });
    }
  });

  /**
   * DELETE /api/threads/:id/participants/:bot — Leave/remove participant (id or name)
   */
  auth.delete('/api/threads/:id/participants/:bot', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: 'Thread is in terminal state; no participant changes allowed' });
      return;
    }

    const target = resolveAgent(thread.org_id, req.params.bot as string);
    if (!target) {
      res.status(404).json({ error: `Agent not found: ${req.params.bot}` });
      return;
    }

    if (!db.isParticipant(thread.id, target.id)) {
      res.status(404).json({ error: 'Bot is not a participant in this thread' });
      return;
    }

    const participants = db.getParticipants(thread.id);
    if (participants.length <= 1) {
      res.status(400).json({ error: 'Cannot remove the last participant from a thread' });
      return;
    }

    // Broadcast leave event BEFORE removing participant, so the removed bot
    // is still in the recipient list and receives the notification
    ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_participant',
      thread_id: thread.id,
      bot_id: target.id,
      action: 'left',
    });
    db.removeParticipant(thread.id, target.id);

    res.json({ ok: true });
  });

  /**
   * POST /api/threads/:id/messages — Send a thread message
   * Body: { content, content_type?, metadata? }
   */
  auth.post('/api/threads/:id/messages', requireAgent, (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: 'Thread is in terminal state; no new messages allowed' });
      return;
    }

    const { content, content_type, metadata, parts } = req.body;

    // Validate parts if provided
    let partsJson: string | null = null;
    if (parts !== undefined) {
      const partsError = validateParts(parts);
      if (partsError) {
        res.status(400).json({ error: partsError });
        return;
      }
      partsJson = JSON.stringify(parts);
    }

    // Resolve content: explicit content, or auto-generate from parts
    const resolvedContent: string | undefined = content ?? (parts ? contentFromParts(parts as MessagePart[]) : undefined);
    if (!resolvedContent || typeof resolvedContent !== 'string') {
      res.status(400).json({ error: 'content or parts is required' });
      return;
    }

    if (resolvedContent.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    let metadataJson: string | null | undefined;
    if (metadata !== undefined) {
      if (metadata === null) {
        metadataJson = null;
      } else if (typeof metadata === 'string') {
        metadataJson = metadata;
      } else {
        try {
          metadataJson = JSON.stringify(metadata);
        } catch {
          res.status(400).json({ error: 'metadata must be JSON-serializable' });
          return;
        }
      }
    }

    const message = db.createThreadMessage(
      thread.id,
      req.agent!.id,
      resolvedContent,
      typeof content_type === 'string' ? content_type : 'text',
      metadataJson,
      partsJson,
    );

    const enriched = enrichThreadMessage(message);

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    db.recordAudit(thread.org_id, req.agent!.id, 'message.send', 'thread_message', message.id, { thread_id: thread.id });

    // Record catchup events for all participants except the sender
    const threadParticipants = db.getParticipants(thread.id);
    for (const p of threadParticipants) {
      if (p.bot_id === req.agent!.id) continue;
      db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_message_summary', {
        thread_id: thread.id,
        topic: thread.topic,
        count: 1,
        last_at: message.created_at,
      });
    }

    ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_message',
      thread_id: thread.id,
      message: enriched,
    });

    res.json(enriched);
  });

  /**
   * GET /api/threads/:id/messages — Get thread messages
   * Query: limit?, before?
   */
  auth.get('/api/threads/:id/messages', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    const messages = db.getThreadMessages(thread.id, limit, before);
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getAgentById(m.sender_id) : undefined;
      return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse());
  });

  /**
   * POST /api/threads/:id/artifacts — Add new artifact (new key only)
   * Use PATCH to update existing artifacts with new versions.
   */
  auth.post('/api/threads/:id/artifacts', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: 'Thread is in terminal state; no new artifacts allowed' });
      return;
    }

    const {
      artifact_key,
      type,
      title,
      content,
      language,
      url,
      mime_type,
    } = req.body;

    if (!artifact_key || typeof artifact_key !== 'string' || !ARTIFACT_KEY_PATTERN.test(artifact_key)) {
      res.status(400).json({ error: 'artifact_key is required and must be URL-safe' });
      return;
    }

    const artifactType = (typeof type === 'string' ? type : 'text') as ArtifactType;
    if (!ARTIFACT_TYPES.has(artifactType)) {
      res.status(400).json({ error: 'Invalid artifact type' });
      return;
    }

    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }
    if (content !== undefined && content !== null && typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string or null' });
      return;
    }
    if (language !== undefined && language !== null && typeof language !== 'string') {
      res.status(400).json({ error: 'language must be a string or null' });
      return;
    }
    if (url !== undefined && url !== null && typeof url !== 'string') {
      res.status(400).json({ error: 'url must be a string or null' });
      return;
    }
    if (mime_type !== undefined && mime_type !== null && typeof mime_type !== 'string') {
      res.status(400).json({ error: 'mime_type must be a string or null' });
      return;
    }

    // POST only creates new artifact keys; use PATCH to update existing ones
    const existing = db.getArtifact(thread.id, artifact_key);
    if (existing) {
      res.status(409).json({ error: `Artifact key "${artifact_key}" already exists. Use PATCH to update it.` });
      return;
    }

    try {
      const artifact = db.addArtifact(
        thread.id,
        req.agent!.id,
        artifact_key,
        artifactType,
        title === undefined ? undefined : (title ?? null),
        content === undefined ? undefined : (content ?? null),
        language === undefined ? undefined : (language ?? null),
        url === undefined ? undefined : (url ?? null),
        mime_type === undefined ? undefined : (mime_type ?? null),
      );

      // Audit
      db.recordAudit(thread.org_id, req.agent!.id, 'artifact.add', 'artifact', artifact.id, {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      });

      // Record catchup events for all participants except the contributor
      const participants = db.getParticipants(thread.id);
      for (const p of participants) {
        if (p.bot_id === req.agent!.id) continue;
        db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_artifact_added', {
          thread_id: thread.id,
          artifact_key: artifact.artifact_key,
          version: artifact.version,
        });
      }

      ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_artifact',
        thread_id: thread.id,
        artifact,
        action: 'added',
      });

      res.json(artifact);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to add artifact' });
    }
  });

  /**
   * PATCH /api/threads/:id/artifacts/:key — Update artifact (new version)
   */
  auth.patch('/api/threads/:id/artifacts/:key', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: 'Thread is in terminal state; no artifact updates allowed' });
      return;
    }

    const key = req.params.key as string;
    if (!key || !ARTIFACT_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Invalid artifact key' });
      return;
    }

    const { content, title } = req.body;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }

    try {
      const artifact = db.updateArtifact(
        thread.id,
        key,
        req.agent!.id,
        content,
        title === undefined ? undefined : (title ?? null),
      );

      if (!artifact) {
        res.status(404).json({ error: 'Artifact not found' });
        return;
      }

      // Audit
      db.recordAudit(thread.org_id, req.agent!.id, 'artifact.update', 'artifact', artifact.id, {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      });

      // Record catchup events for all participants except the contributor
      const participants = db.getParticipants(thread.id);
      for (const p of participants) {
        if (p.bot_id === req.agent!.id) continue;
        db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_artifact_added', {
          thread_id: thread.id,
          artifact_key: artifact.artifact_key,
          version: artifact.version,
        });
      }

      ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_artifact',
        thread_id: thread.id,
        artifact,
        action: 'updated',
      });

      res.json(artifact);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to update artifact' });
    }
  });

  /**
   * GET /api/threads/:id/artifacts — List latest artifact version for each key
   */
  auth.get('/api/threads/:id/artifacts', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    res.json(db.listArtifacts(thread.id));
  });

  /**
   * GET /api/threads/:id/artifacts/:key/versions — List all versions for a key
   */
  auth.get('/api/threads/:id/artifacts/:key/versions', requireAgent, (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const key = req.params.key as string;
    if (!key || !ARTIFACT_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Invalid artifact key' });
      return;
    }

    res.json(db.getArtifactVersions(thread.id, key));
  });

  // ─── Messages ─────────────────────────────────────────────

  /**
   * POST /api/channels/:id/messages — Send a message to a channel
   * Body: { content, content_type? }
   */
  auth.post('/api/channels/:id/messages', requireAgent, (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    if (!db.isChannelMember(channel.id, req.agent!.id)) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }

    const { content, content_type, parts } = req.body;

    // Validate parts if provided
    let partsJson: string | null = null;
    if (parts !== undefined) {
      const partsError = validateParts(parts);
      if (partsError) {
        res.status(400).json({ error: partsError });
        return;
      }
      partsJson = JSON.stringify(parts);
    }

    // Resolve content: explicit content, or auto-generate from parts
    const resolvedContent: string | undefined = content ?? (parts ? contentFromParts(parts as MessagePart[]) : undefined);
    if (!resolvedContent) {
      res.status(400).json({ error: 'content or parts is required' });
      return;
    }

    if (resolvedContent.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    const msg = db.createMessage(channel.id, req.agent!.id, resolvedContent, content_type || 'text', partsJson);

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    db.recordAudit(channel.org_id, req.agent!.id, 'message.send', 'channel_message', msg.id, { channel_id: channel.id });

    // Record catchup events for all channel members except the sender
    const members = db.getChannelMembers(channel.id);
    for (const m of members) {
      if (m.agent_id === req.agent!.id) continue;
      db.recordCatchupEvent(channel.org_id, m.agent_id, 'channel_message_summary', {
        channel_id: channel.id,
        channel_name: channel.name ?? undefined,
        count: 1,
        last_at: msg.created_at,
      });
    }

    // Broadcast via WebSocket
    ws.broadcastMessage(channel.id, msg, req.agent!.name);

    res.json(enrichMessage(msg));
  });

  /**
   * GET /api/channels/:id/messages — Get messages from a channel
   * Query: limit?, before? (timestamp)
   */
  auth.get('/api/channels/:id/messages', (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Check access
    if (req.agent && !db.isChannelMember(channel.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a member of this channel' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    const messages = db.getMessages(channel.id, limit, before);

    // Enrich with sender names and parsed parts
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getAgentById(m.sender_id) : undefined;
      return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse()); // Return in chronological order
  });

  /**
   * POST /api/send — Quick send: DM an agent by name/id (auto-creates channel)
   * Body: { to, content, content_type? }
   */
  auth.post('/api/send', requireAgent, (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const { to, content, content_type, parts } = req.body;

    // Validate parts if provided
    let partsJson: string | null = null;
    if (parts !== undefined) {
      const partsError = validateParts(parts);
      if (partsError) {
        res.status(400).json({ error: partsError });
        return;
      }
      partsJson = JSON.stringify(parts);
    }

    // Resolve content: explicit content, or auto-generate from parts
    const resolvedContent: string | undefined = content ?? (parts ? contentFromParts(parts as MessagePart[]) : undefined);

    if (!to || !resolvedContent) {
      res.status(400).json({ error: 'to and content (or parts) are required' });
      return;
    }

    const orgId = req.agent!.org_id;
    const target = db.getAgentById(to) || db.getAgentByName(orgId, to);

    if (!target || target.org_id !== orgId) {
      res.status(404).json({ error: `Agent not found: ${to}` });
      return;
    }

    if (target.id === req.agent!.id) {
      res.status(400).json({ error: 'Cannot send to yourself' });
      return;
    }

    if (resolvedContent.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    // Find or create direct channel
    const channel = db.createChannel(orgId, 'direct', [req.agent!.id, target.id]);

    // Broadcast channel creation if new
    if (channel.isNew) {
      ws.broadcastToOrg(orgId, {
        type: 'channel_created',
        channel: { id: channel.id, org_id: channel.org_id, type: channel.type, name: channel.name, created_at: channel.created_at },
        members: [req.agent!.id, target.id],
      });
    }

    const msg = db.createMessage(channel.id, req.agent!.id, resolvedContent, content_type || 'text', partsJson);

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    db.recordAudit(req.agent!.org_id, req.agent!.id, 'message.send', 'channel_message', msg.id, { channel_id: channel.id, to: target.id });

    // Record catchup event for the target
    db.recordCatchupEvent(req.agent!.org_id, target.id, 'channel_message_summary', {
      channel_id: channel.id,
      channel_name: channel.name ?? undefined,
      count: 1,
      last_at: msg.created_at,
    });

    // Broadcast
    ws.broadcastMessage(channel.id, msg, req.agent!.name);

    res.json({ channel_id: channel.id, message: enrichMessage(msg) });
  });

  // ─── Catchup (Offline Event Replay) ───────────────────────

  /**
   * GET /api/me/catchup — Get missed events since timestamp
   * Query: since (required, ms timestamp), cursor?, limit?
   */
  auth.get('/api/me/catchup', requireAgent, (req, res) => {
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : NaN;
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const limitRaw = parseInt(getQueryString(req.query.limit) || '') || 50;
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const cursor = getQueryString(req.query.cursor);

    const { events, has_more } = db.getCatchupEvents(req.agent!.id, since, limit, cursor);

    const response: CatchupResponse = {
      events,
      has_more,
    };

    if (has_more && events.length > 0) {
      response.cursor = events[events.length - 1].event_id;
    }

    res.json(response);
  });

  /**
   * GET /api/me/catchup/count — Get count of missed events by type
   * Query: since (required, ms timestamp)
   */
  auth.get('/api/me/catchup/count', requireAgent, (req, res) => {
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : NaN;
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const counts: CatchupCountResponse = db.getCatchupCount(req.agent!.id, since);
    res.json(counts);
  });

  // ─── Inbox ─────────────────────────────────────────────────

  /**
   * GET /api/inbox — Get new messages since timestamp
   * Query: since (timestamp, required)
   */
  auth.get('/api/inbox', requireAgent, (req, res) => {
    const since = parseInt(getQueryString(req.query.since) || '');
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const messages = db.getNewMessages(req.agent!.id, since);
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getAgentById(m.sender_id) : undefined;
      return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched);
  });

  // ─── Files ───────────────────────────────────────────────

  const filesDir = path.join(config.data_dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, filesDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: {
      fileSize: config.max_file_size_mb * 1024 * 1024,
    },
  });

  /**
   * POST /api/files/upload — Upload a file (multipart/form-data)
   * Auth: agent token
   * Returns: { id, name, mime_type, size, url, created_at }
   */
  auth.post('/api/files/upload', requireAgent, upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided (field name must be "file")' });
      return;
    }

    const orgId = req.agent!.org_id;

    // Enforce daily upload quota
    const dailyBytes = db.getDailyUploadBytes(orgId);
    const dailyLimitBytes = config.file_upload_mb_per_day * 1024 * 1024;
    if (dailyBytes + file.size > dailyLimitBytes) {
      // Clean up the uploaded file since we're rejecting it
      try { fs.unlinkSync(file.path); } catch { /* temp file may already be gone */ }
      const usedMb = Math.round(dailyBytes / 1024 / 1024);
      res.status(429).json({
        error: `Daily upload quota exceeded (${usedMb}MB / ${config.file_upload_mb_per_day}MB used today)`,
      });
      return;
    }

    const relativePath = `files/${file.filename}`;

    const record = db.createFile(
      orgId,
      req.agent!.id,
      file.originalname,
      file.mimetype || null,
      file.size,
      relativePath,
    );

    // Audit
    db.recordAudit(orgId, req.agent!.id, 'file.upload', 'file', record.id, {
      name: record.name,
      mime_type: record.mime_type,
      size: record.size,
    });

    res.json({
      id: record.id,
      name: record.name,
      mime_type: record.mime_type,
      size: record.size,
      url: `/api/files/${record.id}`,
      created_at: record.created_at,
    });
  });

  /**
   * GET /api/files/:id — Download a file
   * Auth: agent token or org API key
   * Org-scoped: only agents/admins in the same org can download
   */
  auth.get('/api/files/:id', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const record = db.getFile(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    if (record.org_id !== orgId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const diskPath = path.resolve(config.data_dir, record.path);
    // Path traversal guard: ensure resolved path stays inside data_dir
    if (!diskPath.startsWith(path.resolve(config.data_dir) + path.sep)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (!fs.existsSync(diskPath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    res.setHeader('Content-Type', record.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.name)}"`);
    res.setHeader('Content-Length', record.size);

    const stream = fs.createReadStream(diskPath);
    stream.pipe(res);
  });

  /**
   * GET /api/files/:id/info — Get file metadata
   * Auth: agent token or org API key
   * Org-scoped access check
   */
  auth.get('/api/files/:id/info', (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const record = db.getFileInfo(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    if (record.org_id !== orgId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({
      id: record.id,
      name: record.name,
      mime_type: record.mime_type,
      size: record.size,
      uploader_id: record.uploader_id,
      url: `/api/files/${record.id}`,
      created_at: record.created_at,
    });
  });

  // ─── Org Settings (Admin) ──────────────────────────────────

  /**
   * GET /api/org/settings — Get org settings
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.get('/api/org/settings', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    res.json(db.getOrgSettings(req.org!.id));
  });

  /**
   * PATCH /api/org/settings — Update org settings
   * Auth: Org API Key + X-Admin-Secret
   * Body: partial OrgSettings fields
   */
  auth.patch('/api/org/settings', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const {
      messages_per_minute_per_bot,
      threads_per_hour_per_bot,
      message_ttl_days,
      thread_auto_close_days,
      artifact_retention_days,
    } = req.body;

    // Validate numeric fields (reject NaN, Infinity, non-integers)
    const numericFields: Record<string, unknown> = {
      messages_per_minute_per_bot,
      threads_per_hour_per_bot,
    };
    for (const [key, val] of Object.entries(numericFields)) {
      if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 1)) {
        res.status(400).json({ error: `${key} must be a positive integer` });
        return;
      }
    }

    const nullableFields: Record<string, unknown> = {
      message_ttl_days,
      thread_auto_close_days,
      artifact_retention_days,
    };
    for (const [key, val] of Object.entries(nullableFields)) {
      if (val !== undefined && val !== null && (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 1)) {
        res.status(400).json({ error: `${key} must be a positive integer or null` });
        return;
      }
    }

    const updates: Partial<OrgSettings> = {};
    if (messages_per_minute_per_bot !== undefined) updates.messages_per_minute_per_bot = messages_per_minute_per_bot;
    if (threads_per_hour_per_bot !== undefined) updates.threads_per_hour_per_bot = threads_per_hour_per_bot;
    if (message_ttl_days !== undefined) updates.message_ttl_days = message_ttl_days;
    if (thread_auto_close_days !== undefined) updates.thread_auto_close_days = thread_auto_close_days;
    if (artifact_retention_days !== undefined) updates.artifact_retention_days = artifact_retention_days;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No settings fields provided' });
      return;
    }

    const settings = db.updateOrgSettings(req.org!.id, updates);

    // Audit
    db.recordAudit(req.org!.id, null, 'settings.update', 'org_settings', req.org!.id, updates);

    res.json(settings);
  });

  // ─── Audit Log (Admin) ───────────────────────────────────

  /**
   * GET /api/audit — Query audit log
   * Auth: Org API Key + X-Admin-Secret
   * Query: since?, action?, target_type?, target_id?, bot_id?, limit?
   */
  auth.get('/api/audit', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid timestamp' });
      return;
    }
    const action = getQueryString(req.query.action);
    const target_type = getQueryString(req.query.target_type);
    const target_id = getQueryString(req.query.target_id);
    const bot_id = getQueryString(req.query.bot_id);
    const limitRaw = parseInt(getQueryString(req.query.limit) || '') || 50;
    const limit = Math.min(Math.max(limitRaw, 1), 200);

    const entries = db.getAuditLog(req.org!.id, { since, action, target_type, target_id, bot_id, limit });
    res.json(entries);
  });

  // Mount authenticated routes
  router.use(auth);

  return router;
}
