import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HubDB } from './db.js';
import type { HubWS } from './ws.js';
import { authMiddleware, requireAgent, requireOrg, requireScope } from './auth.js';
import { validateWebhookUrl } from './webhook.js';
import { validateParts, VALID_TOKEN_SCOPES, type HubConfig, type Agent, type AgentProfileInput, type Thread, type ThreadStatus, type CloseReason, type ArtifactType, type MessagePart, type Message, type ThreadMessage, type WireMessage, type WireThreadMessage, type CatchupResponse, type CatchupCountResponse, type OrgSettings, type TokenScope, type ThreadPermissionPolicy } from './types.js';
import { issueWsTicket } from './ws-tickets.js';
// routeLogger available for future use: import { routeLogger } from './logger.js';

// S6: Per-field size limits (bytes)
const FIELD_LIMITS = {
  name: 128,
  display_name: 256,
  metadata: 16384,       // 16 KB
  content_type: 128,
  webhook_url: 2048,
  bio: 1024,
  role: 256,
  function: 256,
  team: 256,
  status_text: 512,
  timezone: 64,
  active_hours: 256,
  version: 64,
  runtime: 128,
  tags: 4096,            // 4 KB
  languages: 2048,       // 2 KB
  protocols: 16384,      // 16 KB
} as const;

function checkFieldLimits(fields: Record<string, unknown>, limits: Partial<typeof FIELD_LIMITS> = FIELD_LIMITS): string | null {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const limit = (limits as Record<string, number>)[key];
    if (!limit) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(str, 'utf8') > limit) {
      return `${key} exceeds size limit (${limit} bytes)`;
    }
  }
  return null;
}

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

const MAX_THREAD_TAGS = 10;
const THREAD_STATUSES = new Set<ThreadStatus>(['active', 'blocked', 'reviewing', 'resolved', 'closed']);
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
      res.status(401).json({ error: 'Admin authentication required', code: 'AUTH_REQUIRED' });
      return false;
    }
    const expected = Buffer.from(config.admin_secret, 'utf8');
    const actual = Buffer.from(token, 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      res.status(401).json({ error: 'Admin authentication required', code: 'AUTH_REQUIRED' });
      return false;
    }
    return true;
  }

  function requireOrgOrAgent(req: import('express').Request, res: import('express').Response): string | undefined {
    if (req.agent) return req.agent.org_id;
    if (req.org) return req.org.id;
    res.status(403).json({ error: 'Authentication required', code: 'FORBIDDEN' });
    return undefined;
  }

  function requireOrgAdmin(req: import('express').Request, res: import('express').Response): boolean {
    if (!req.org || req.authType !== 'org') {
      res.status(403).json({ error: 'Organization authentication required', code: 'FORBIDDEN' });
      return false;
    }
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || !db.verifyOrgAdminSecret(req.org.id, adminSecret)) {
      res.status(403).json({ error: 'Org admin secret required', code: 'FORBIDDEN' });
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
        code: 'RATE_LIMITED',
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
        code: 'RATE_LIMITED',
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
    opts?: { rejectTerminal?: boolean },
  ): Thread | undefined {
    const thread = db.getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return undefined;
    }

    // O9: Check terminal state BEFORE participant membership so that
    // non-participants get "thread is closed" rather than "not a participant"
    // when the thread is in a terminal state.
    if (opts?.rejectTerminal && (thread.status === 'resolved' || thread.status === 'closed')) {
      res.status(409).json({ error: `Thread is ${thread.status}; operation not allowed`, code: 'THREAD_CLOSED' });
      return undefined;
    }

    if (!req.agent || !db.isParticipant(thread.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a participant of this thread', code: 'FORBIDDEN' });
      return undefined;
    }

    return thread;
  }

  /**
   * POST /api/orgs — Create an organization
   * Body: { name, persist_messages? }
   * Auth: Admin secret (if BOTSHUB_ADMIN_SECRET is set)
   * Returns: org with api_key
   *
   * Note: persist_messages is reserved for SaaS deployment — non-persistent
   * mode is a post-GA feature. The field is accepted for forward compatibility
   * but toggling it to false has no effect on message storage yet.
   */
  router.post('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, persist_messages } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return;
    }
    const org = db.createOrg(name, persist_messages ?? config.default_persist);
    const { admin_secret: _stripped, ...safeOrg } = org;
    res.json(safeOrg);
  });

  /**
   * GET /api/orgs — List all orgs
   * Auth: Admin secret (if BOTSHUB_ADMIN_SECRET is set)
   */
  router.get('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const orgs = db.listOrgs().map(({ api_key, admin_secret, ...safe }) => safe);
    res.json(orgs);
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
  auth.post('/api/register', requireOrg, async (req, res) => {
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
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, _, -)', code: 'VALIDATION_ERROR' });
      return;
    }

    // Per-field size limits
    const fieldError = checkFieldLimits({ name, display_name, metadata, webhook_url, bio, role, function: functionName, team, tags, languages, protocols, status_text, timezone, active_hours, version, runtime });
    if (fieldError) {
      res.status(400).json({ error: fieldError });
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

    // SSRF protection: validate webhook URL at set time
    if (webhook_url) {
      const urlError = await validateWebhookUrl(webhook_url);
      if (urlError) {
        res.status(400).json({ error: urlError });
        return;
      }
    }

    const { agent, created, plaintextToken } = db.registerAgent(req.org!.id, name, display_name, metadata, webhook_url, webhook_secret, profile);

    // Audit
    db.recordAudit(req.org!.id, agent.id, 'bot.register', 'agent', agent.id, { name: agent.name, reregister: !created });

    // Broadcast agent online to all org viewers (Web UI etc.)
    ws.broadcastToOrg(req.org!.id, {
      type: 'agent_online',
      agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
    });

    const response: Record<string, unknown> = {
      agent_id: agent.id,
      ...toAgentResponse(agent),
    };
    // Only include token on initial registration (S13: atomic check + S4: plaintext only at creation)
    if (created && plaintextToken !== null) {
      response.token = plaintextToken;
    }
    res.json(response);
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
      res.status(403).json({ error: 'Org admin secret required', code: 'FORBIDDEN' });
      return;
    }

    const agent = db.getAgentById(req.params.id as string);
    if (!agent || agent.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
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
  auth.delete('/api/me', requireAgent, requireScope('full'), (req, res) => {
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
  auth.get('/api/me', requireAgent, requireScope('read'), (req, res) => {
    const a = req.agent!;
    res.json(toAgentResponse(a));
  });

  /**
   * PATCH /api/me/profile — Update current bot profile fields
   */
  auth.patch('/api/me/profile', requireAgent, requireScope('profile'), (req, res) => {
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
      res.status(400).json({ error: 'No profile fields provided', code: 'VALIDATION_ERROR' });
      return;
    }

    // Per-field size limits (S6)
    const fieldError = checkFieldLimits({ bio, role, function: functionName, team, tags, languages, protocols, status_text, timezone, active_hours, version, runtime });
    if (fieldError) {
      res.status(400).json({ error: fieldError });
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
      res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
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
  auth.get('/api/peers', requireAgent, requireScope('read'), (req, res) => {
    const agents = db.listAgents(req.agent!.org_id);
    res.json(agents
      .filter(a => a.id !== req.agent!.id)
      .map(a => toAgentResponse(a))
    );
  });

  // ─── Scoped Token Management ─────────────────────────────

  /**
   * POST /api/me/tokens — Create a scoped token
   * Body: { scopes: TokenScope[], label?, expires_in?: number (ms) }
   */
  auth.post('/api/me/tokens', requireAgent, requireScope('full'), (req, res) => {
    const { scopes, label, expires_in } = req.body;
    if (!Array.isArray(scopes) || scopes.length === 0) {
      res.status(400).json({ error: 'scopes must be a non-empty array' });
      return;
    }
    for (const scope of scopes) {
      if (!VALID_TOKEN_SCOPES.has(scope as TokenScope)) {
        res.status(400).json({ error: `Invalid scope: ${scope}. Valid: full, read, thread, message, profile` });
        return;
      }
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      res.status(400).json({ error: 'label must be a string' });
      return;
    }
    if (expires_in !== undefined && (typeof expires_in !== 'number' || expires_in <= 0)) {
      res.status(400).json({ error: 'expires_in must be a positive number (milliseconds)' });
      return;
    }
    const expiresAt = expires_in ? Date.now() + expires_in : null;
    const token = db.createAgentToken(req.agent!.id, scopes as TokenScope[], label, expiresAt);

    db.recordAudit(req.agent!.org_id, req.agent!.id, 'bot.token_create', 'token', token.id, {
      scopes,
      label: label ?? null,
      expires_at: expiresAt,
    });

    res.json({
      id: token.id,
      token: token.token,
      scopes: token.scopes,
      label: token.label,
      expires_at: token.expires_at,
      created_at: token.created_at,
      last_used_at: null,
    });
  });

  /**
   * GET /api/me/tokens — List my scoped tokens
   */
  auth.get('/api/me/tokens', requireAgent, requireScope('full'), (req, res) => {
    const tokens = db.listAgentTokens(req.agent!.id);
    res.json(tokens.map(t => ({
      id: t.id,
      scopes: t.scopes,
      label: t.label,
      expires_at: t.expires_at,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      // Never return the actual token value in list
    })));
  });

  /**
   * DELETE /api/me/tokens/:id — Revoke a scoped token
   */
  auth.delete('/api/me/tokens/:id', requireAgent, requireScope('full'), (req, res) => {
    const deleted = db.revokeAgentToken(req.params.id as string, req.agent!.id);
    if (!deleted) {
      res.status(404).json({ error: 'Token not found', code: 'NOT_FOUND' });
      return;
    }
    db.recordAudit(req.agent!.org_id, req.agent!.id, 'bot.token_revoke', 'token', req.params.id as string);
    res.json({ ok: true });
  });

  /**
   * GET /api/bots — Discover bots in org
   * Query: role?, tag?, status?, q?
   * Auth: org API key or agent token
   */
  auth.get('/api/bots', requireScope('read'), (req, res) => {
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
  auth.get('/api/bots/:name/webhook/health', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const bot = db.getAgentByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
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
  auth.get('/api/bots/:name/profile', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const bot = db.getAgentByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
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

    if (type === 'direct' && members.length !== 2) {
      res.status(400).json({ error: 'Direct channels require exactly 2 members' });
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
  auth.get('/api/channels', requireScope('read'), (req, res) => {
    if (req.agent) {
      res.json(db.listChannelsForAgent(req.agent.id));
    } else if (req.org) {
      res.json(db.listChannelsForOrg(req.org.id));
    } else {
      res.status(403).json({ error: 'Authentication required', code: 'FORBIDDEN' });
    }
  });

  /**
   * GET /api/channels/:id — Get channel details
   */
  auth.get('/api/channels/:id', requireScope('read'), (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    // Check access
    if (req.agent && !db.isChannelMember(channel.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
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
  auth.post('/api/channels/:id/join', requireAgent, requireScope('message'), (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.type !== 'group') {
      res.status(404).json({ error: 'Group channel not found', code: 'NOT_FOUND' });
      return;
    }
    if (channel.org_id !== req.agent!.org_id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
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
      res.status(403).json({ error: 'Org admin secret required', code: 'FORBIDDEN' });
      return;
    }

    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    db.deleteChannel(channel.id);

    // Audit
    db.recordAudit(req.org!.id, null, 'channel.delete', 'channel', channel.id, { name: channel.name });

    // Broadcast channel deletion
    ws.broadcastToOrg(req.org!.id, {
      type: 'channel_deleted',
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
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
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
   * Query: limit?, before?, since?
   * Auth: Org API Key + X-Admin-Secret
   */
  auth.get('/api/org/threads/:id/messages', requireOrg, (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== req.org!.id) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr !== undefined ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid integer timestamp' });
      return;
    }

    const messages = db.getThreadMessages(thread.id, limit, before, since);
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
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    res.json(db.listArtifacts(thread.id));
  });

  // ─── Threads ─────────────────────────────────────────────

  /**
   * POST /api/threads — Create a thread
   * Body: { topic, tags?, participants?, channel_id?, context? }
   */
  auth.post('/api/threads', requireAgent, requireScope('thread'), (req, res) => {
    if (!checkThreadRateLimit(req, res)) return;

    const { topic, tags, participants, channel_id, context, permission_policy } = req.body;
    const orgId = req.agent!.org_id;

    if (!topic || typeof topic !== 'string') {
      res.status(400).json({ error: 'topic is required', code: 'VALIDATION_ERROR' });
      return;
    }

    // Validate tags: optional array of strings
    let resolvedTags: string[] | null = null;
    if (tags !== undefined && tags !== null) {
      if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string')) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }
      if (tags.length > MAX_THREAD_TAGS) {
        res.status(400).json({ error: `tags must have at most ${MAX_THREAD_TAGS} items` });
        return;
      }
      resolvedTags = tags.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
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

    // Validate and serialize permission_policy
    let policyJson: string | null = null;
    if (permission_policy !== undefined && permission_policy !== null) {
      if (typeof permission_policy !== 'object') {
        res.status(400).json({ error: 'permission_policy must be an object' });
        return;
      }
      const policyKeys = Object.keys(permission_policy);
      const validPolicyKeys = new Set(['resolve', 'close', 'invite', 'remove']);
      for (const key of policyKeys) {
        if (!validPolicyKeys.has(key)) {
          res.status(400).json({ error: `permission_policy has invalid key: ${key}` });
          return;
        }
        const val = permission_policy[key];
        if (val !== null && (!Array.isArray(val) || !val.every((v: unknown) => typeof v === 'string'))) {
          res.status(400).json({ error: `permission_policy.${key} must be an array of strings or null` });
          return;
        }
      }
      policyJson = JSON.stringify(permission_policy);
    }

    try {
      const thread = db.createThread(
        orgId,
        req.agent!.id,
        topic,
        resolvedTags,
        resolvedParticipantIds,
        resolvedChannelId,
        contextJson,
        policyJson,
      );

      // Audit (rate limit event already recorded atomically in checkThreadRateLimit)
      db.recordAudit(orgId, req.agent!.id, 'thread.create', 'thread', thread.id, { topic, tags: resolvedTags });

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

      // Emit individual join events for all participants (including initiator)
      for (const pid of allParticipantIds) {
        const bot = db.getAgentById(pid);
        if (!bot) continue;
        ws.broadcastThreadEvent(orgId, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: pid,
          bot_name: bot.name,
          action: 'joined',
          by: req.agent!.id,
        });
      }

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
  auth.get('/api/threads', requireAgent, requireScope('read'), (req, res) => {
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
  auth.get('/api/threads/:id', requireAgent, requireScope('read'), (req, res) => {
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
  auth.patch('/api/threads/:id', requireAgent, requireScope('thread'), (req, res) => {
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

    const { status: statusInput, close_reason, context, topic, permission_policy: permPolicyInput } = req.body;
    if (statusInput === undefined && context === undefined && close_reason === undefined && topic === undefined && permPolicyInput === undefined) {
      res.status(400).json({ error: 'No updatable fields provided', code: 'VALIDATION_ERROR' });
      return;
    }

    // Only the thread initiator can change permission_policy
    if (permPolicyInput !== undefined && thread.initiator_id !== req.agent!.id) {
      res.status(403).json({ error: 'Only the thread initiator can change permission_policy', code: 'FORBIDDEN' });
      return;
    }

    // Validate permission_policy if provided
    let permPolicyJson: string | null | undefined;
    if (permPolicyInput !== undefined) {
      if (permPolicyInput === null) {
        permPolicyJson = null;
      } else if (typeof permPolicyInput === 'object') {
        const validPolicyKeys = new Set(['resolve', 'close', 'invite', 'remove']);
        for (const key of Object.keys(permPolicyInput)) {
          if (!validPolicyKeys.has(key)) {
            res.status(400).json({ error: `permission_policy has invalid key: ${key}` });
            return;
          }
          const val = permPolicyInput[key];
          if (val !== null && (!Array.isArray(val) || !val.every((v: unknown) => typeof v === 'string'))) {
            res.status(400).json({ error: `permission_policy.${key} must be an array of strings or null` });
            return;
          }
        }
        permPolicyJson = JSON.stringify(permPolicyInput);
      } else {
        res.status(400).json({ error: 'permission_policy must be an object or null' });
        return;
      }
    }

    // Block all mutations on terminal threads (status transitions handled separately in updateThreadStatus)
    if ((thread.status === 'resolved' || thread.status === 'closed') && statusInput === undefined) {
      res.status(409).json({ error: 'Thread is in terminal state; no updates allowed', code: 'THREAD_CLOSED' });
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

    // Thread permission policy check for status changes
    if (status !== undefined) {
      const policyAction = status === 'resolved' ? 'resolve' as const
        : status === 'closed' ? 'close' as const
        : null;
      if (policyAction && !db.checkThreadPermission(thread, req.agent!.id, policyAction)) {
        db.recordAudit(thread.org_id, req.agent!.id, 'thread.permission_denied', 'thread', thread.id, {
          action: policyAction,
          status,
        });
        res.status(403).json({
          error: `Permission denied: your label does not allow '${policyAction}' on this thread`,
          code: 'FORBIDDEN',
        });
        return;
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
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
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
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
          return;
        }
        changes.push('context');
      }

      if (topic !== undefined) {
        updated = db.updateThreadTopic(thread.id, topic.trim(), revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
          return;
        }
        changes.push('topic');
      }

      if (permPolicyJson !== undefined) {
        updated = db.updateThreadPermissionPolicy(thread.id, permPolicyJson, revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
          return;
        }
        changes.push('permission_policy');
      }
    } catch (error: any) {
      if (error.message === 'REVISION_CONFLICT') {
        res.status(409).json({ error: 'Conflict: thread was modified concurrently', code: 'REVISION_CONFLICT' });
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
  auth.post('/api/threads/:id/participants', requireAgent, requireScope('thread'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    // Permission policy check for invite
    if (!db.checkThreadPermission(thread, req.agent!.id, 'invite')) {
      res.status(403).json({ error: 'Permission denied: your label does not allow inviting participants', code: 'FORBIDDEN' });
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

    // Prevent label relabeling via invite — only new participants can have labels set.
    // Relabeling existing participants would bypass label-based permission policies.
    if (alreadyParticipant && label !== undefined) {
      res.status(409).json({ error: 'Participant already exists; cannot change label via invite' });
      return;
    }

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
          bot_name: bot.name,
          action: 'joined',
          by: req.agent!.id,
          label: participant.label,
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
  auth.delete('/api/threads/:id/participants/:bot', requireAgent, requireScope('thread'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    const target = resolveAgent(thread.org_id, req.params.bot as string);
    if (!target) {
      res.status(404).json({ error: `Agent not found: ${req.params.bot}` });
      return;
    }

    // Permission policy check for remove (skip if leaving self)
    if (target.id !== req.agent!.id && !db.checkThreadPermission(thread, req.agent!.id, 'remove')) {
      res.status(403).json({ error: 'Permission denied: your label does not allow removing participants', code: 'FORBIDDEN' });
      return;
    }

    if (!db.isParticipant(thread.id, target.id)) {
      res.status(404).json({ error: 'Bot is not a participant in this thread', code: 'NOT_FOUND' });
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
      bot_name: target.name,
      action: 'left',
      by: req.agent!.id,
    });

    // Record catchup event so the removed bot sees it even if offline
    db.recordCatchupEvent(thread.org_id, target.id, 'thread_participant_removed', {
      thread_id: thread.id,
      topic: thread.topic,
      removed_by: req.agent!.id,
    });

    db.removeParticipant(thread.id, target.id);

    // Audit
    db.recordAudit(thread.org_id, req.agent!.id, 'thread.remove_participant', 'thread', thread.id, {
      removed_bot_id: target.id,
      removed_bot_name: target.name,
    });

    res.json({ ok: true });
  });

  /**
   * POST /api/threads/:id/messages — Send a thread message
   * Body: { content, content_type?, metadata? }
   */
  auth.post('/api/threads/:id/messages', requireAgent, requireScope('thread'), (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    const { content, content_type, metadata, parts } = req.body;

    // S6: content_type size limit
    if (content_type !== undefined && typeof content_type === 'string' && Buffer.byteLength(content_type, 'utf8') > FIELD_LIMITS.content_type) {
      res.status(400).json({ error: `content_type exceeds size limit (${FIELD_LIMITS.content_type} bytes)` });
      return;
    }

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
      res.status(400).json({ error: 'content or parts is required', code: 'VALIDATION_ERROR' });
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
      if (metadataJson && Buffer.byteLength(metadataJson, 'utf8') > FIELD_LIMITS.metadata) {
        res.status(400).json({ error: `metadata exceeds size limit (${FIELD_LIMITS.metadata} bytes)` });
        return;
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
      }, thread.id);
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
   * Query: limit?, before?, since?
   */
  auth.get('/api/threads/:id/messages', requireAgent, requireScope('read'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr !== undefined ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid integer timestamp' });
      return;
    }

    const messages = db.getThreadMessages(thread.id, limit, before, since);
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
  auth.post('/api/threads/:id/artifacts', requireAgent, requireScope('thread'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

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
        }, thread.id);
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
  auth.patch('/api/threads/:id/artifacts/:key', requireAgent, requireScope('thread'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

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
        res.status(404).json({ error: 'Artifact not found', code: 'NOT_FOUND' });
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
        }, thread.id);
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
  auth.get('/api/threads/:id/artifacts', requireAgent, requireScope('read'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    res.json(db.listArtifacts(thread.id));
  });

  /**
   * GET /api/threads/:id/artifacts/:key/versions — List all versions for a key
   */
  auth.get('/api/threads/:id/artifacts/:key/versions', requireAgent, requireScope('read'), (req, res) => {
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
  auth.post('/api/channels/:id/messages', requireAgent, requireScope('message'), (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    if (!db.isChannelMember(channel.id, req.agent!.id)) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }

    const { content, content_type, parts } = req.body;

    // S6: content_type size limit
    if (content_type !== undefined && typeof content_type === 'string' && Buffer.byteLength(content_type, 'utf8') > FIELD_LIMITS.content_type) {
      res.status(400).json({ error: `content_type exceeds size limit (${FIELD_LIMITS.content_type} bytes)` });
      return;
    }

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
      res.status(400).json({ error: 'content or parts is required', code: 'VALIDATION_ERROR' });
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
      }, channel.id);
    }

    // Broadcast via WebSocket
    ws.broadcastMessage(channel.id, msg, req.agent!.name);

    res.json(enrichMessage(msg));
  });

  /**
   * GET /api/channels/:id/messages — Get messages from a channel
   * Query: limit?, before?, since? (timestamps)
   */
  auth.get('/api/channels/:id/messages', requireScope('read'), (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    // Check access
    if (req.agent && !db.isChannelMember(channel.id, req.agent.id)) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr !== undefined ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid integer timestamp' });
      return;
    }

    const messages = db.getMessages(channel.id, limit, before, since);

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
  auth.post('/api/send', requireAgent, requireScope('message'), (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const { to, content, content_type, parts } = req.body;

    // S6: content_type size limit
    if (content_type !== undefined && typeof content_type === 'string' && Buffer.byteLength(content_type, 'utf8') > FIELD_LIMITS.content_type) {
      res.status(400).json({ error: `content_type exceeds size limit (${FIELD_LIMITS.content_type} bytes)` });
      return;
    }

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
    }, channel.id);

    // Broadcast
    ws.broadcastMessage(channel.id, msg, req.agent!.name);

    res.json({ channel_id: channel.id, message: enrichMessage(msg) });
  });

  // ─── Catchup (Offline Event Replay) ───────────────────────

  /**
   * GET /api/me/catchup — Get missed events since timestamp
   * Query: since (required, ms timestamp), cursor?, limit?
   */
  auth.get('/api/me/catchup', requireAgent, requireScope('read'), (req, res) => {
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
  auth.get('/api/me/catchup/count', requireAgent, requireScope('read'), (req, res) => {
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
  auth.get('/api/inbox', requireAgent, requireScope('read'), (req, res) => {
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
  auth.post('/api/files/upload', requireAgent, requireScope('message'), (req, res, next) => {
    // O5: Wrap multer middleware to catch MulterError and return JSON
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: `File too large (max ${config.max_file_size_mb}MB)`, code: 'FILE_TOO_LARGE' });
            return;
          }
          res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
          return;
        }
        // Non-multer error (e.g. disk failure)
        next(err);
        return;
      }
      next();
    });
  }, (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided (field name must be "file")' });
      return;
    }

    const orgId = req.agent!.org_id;
    const relativePath = `files/${file.filename}`;
    const dailyLimitBytes = config.file_upload_mb_per_day * 1024 * 1024;

    // Atomically check quota and create file record in a single transaction
    const result = db.createFileWithQuotaCheck(
      orgId,
      req.agent!.id,
      file.originalname,
      file.mimetype || null,
      file.size,
      relativePath,
      dailyLimitBytes,
    );

    if (!result.ok) {
      // Clean up the uploaded file since we're rejecting it
      try { fs.unlinkSync(file.path); } catch { /* temp file may already be gone */ }
      const usedMb = Math.round(result.dailyBytes / 1024 / 1024);
      res.status(429).json({
        error: `Daily upload quota exceeded (${usedMb}MB / ${config.file_upload_mb_per_day}MB used today)`,
        code: 'RATE_LIMITED',
      });
      return;
    }

    const record = result.file;

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
  auth.get('/api/files/:id', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const record = db.getFile(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
      return;
    }

    if (record.org_id !== orgId) {
      res.status(403).json({ error: 'Access denied', code: 'FORBIDDEN' });
      return;
    }

    const diskPath = path.resolve(config.data_dir, record.path);
    // Path traversal guard: ensure resolved path stays inside data_dir
    if (!diskPath.startsWith(path.resolve(config.data_dir) + path.sep)) {
      res.status(403).json({ error: 'Access denied', code: 'FORBIDDEN' });
      return;
    }
    if (!fs.existsSync(diskPath)) {
      res.status(404).json({ error: 'File not found on disk', code: 'NOT_FOUND' });
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
  auth.get('/api/files/:id/info', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrAgent(req, res);
    if (!orgId) return;

    const record = db.getFileInfo(req.params.id as string);
    if (!record) {
      res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
      return;
    }

    if (record.org_id !== orgId) {
      res.status(403).json({ error: 'Access denied', code: 'FORBIDDEN' });
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
      default_thread_permission_policy,
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

    // Validate default_thread_permission_policy
    if (default_thread_permission_policy !== undefined && default_thread_permission_policy !== null) {
      if (typeof default_thread_permission_policy !== 'object') {
        res.status(400).json({ error: 'default_thread_permission_policy must be an object or null' });
        return;
      }
      const validPolicyKeys = new Set(['resolve', 'close', 'invite', 'remove']);
      for (const [key, val] of Object.entries(default_thread_permission_policy)) {
        if (!validPolicyKeys.has(key)) {
          res.status(400).json({ error: `default_thread_permission_policy has invalid key: ${key}` });
          return;
        }
        if (val !== null && (!Array.isArray(val) || !val.every((v: unknown) => typeof v === 'string'))) {
          res.status(400).json({ error: `default_thread_permission_policy.${key} must be a string array or null` });
          return;
        }
      }
    }

    const updates: Partial<OrgSettings> = {};
    if (messages_per_minute_per_bot !== undefined) updates.messages_per_minute_per_bot = messages_per_minute_per_bot;
    if (threads_per_hour_per_bot !== undefined) updates.threads_per_hour_per_bot = threads_per_hour_per_bot;
    if (message_ttl_days !== undefined) updates.message_ttl_days = message_ttl_days;
    if (thread_auto_close_days !== undefined) updates.thread_auto_close_days = thread_auto_close_days;
    if (artifact_retention_days !== undefined) updates.artifact_retention_days = artifact_retention_days;
    if (default_thread_permission_policy !== undefined) updates.default_thread_permission_policy = default_thread_permission_policy;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No settings fields provided', code: 'VALIDATION_ERROR' });
      return;
    }

    const settings = db.updateOrgSettings(req.org!.id, updates);

    // Audit
    db.recordAudit(req.org!.id, null, 'settings.update', 'org_settings', req.org!.id, updates);

    res.json(settings);
  });

  // ─── WS Ticket Exchange ──────────────────────────────────

  /**
   * POST /api/ws-ticket — Exchange a Bearer token for a one-time WS connection ticket
   * Auth: Bearer token (agent token, scoped token, or org key)
   * Returns: { ticket: string, expires_in: number } — ticket is valid for 30s and single-use
   *
   * The ticket should be passed as ?ticket=xxx when opening a WS connection.
   * This avoids leaking the token in server logs via the URL query param.
   */
  auth.post('/api/ws-ticket', (req, res) => {
    // Use the raw token stored by authMiddleware (works for both Bearer header and ?token= query param)
    const token = req.rawToken;

    if (!token) {
      res.status(401).json({ error: 'Authentication token required for ticket exchange', code: 'AUTH_REQUIRED' });
      return;
    }

    const ticketId = issueWsTicket(token);

    res.json({
      ticket: ticketId,
      expires_in: 30,
    });
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
