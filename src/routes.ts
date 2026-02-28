import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubDB } from './db.js';
import type { HubWS } from './ws.js';
import { authMiddleware, requireBot, requireOrg, requireScope, requireAuthRole } from './auth.js';
import { validateWebhookUrl } from './webhook.js';
import { validateParts, VALID_TOKEN_SCOPES, type HubConfig, type Bot, type BotProfileInput, type Thread, type ThreadStatus, type CloseReason, type ArtifactType, type MessagePart, type Message, type ThreadMessage, type WireMessage, type WireThreadMessage, type CatchupResponse, type CatchupCountResponse, type OrgSettings, type TokenScope, type ThreadPermissionPolicy } from './types.js';
import { issueWsTicket } from './ws-tickets.js';
// routeLogger available for future use: import { routeLogger } from './logger.js';

// S6: Per-field size limits (bytes)
const FIELD_LIMITS = {
  name: 128,
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

function toBotResponse(bot: Bot) {
  return {
    id: bot.id,
    org_id: bot.org_id,
    name: bot.name,
    auth_role: bot.auth_role,
    online: bot.online,
    last_seen_at: bot.last_seen_at,
    created_at: bot.created_at,
    metadata: parseJsonField<Record<string, unknown>>(bot.metadata),
    bio: bot.bio,
    role: bot.role,
    function: bot.function,
    team: bot.team,
    tags: parseJsonField<string[]>(bot.tags),
    languages: parseJsonField<string[]>(bot.languages),
    protocols: parseJsonField<Record<string, unknown>>(bot.protocols),
    status_text: bot.status_text,
    timezone: bot.timezone,
    active_hours: bot.active_hours,
    version: bot.version,
    runtime: bot.runtime,
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

// Read version from package.json at startup
const __routes_dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__routes_dirname, '..', 'package.json'), 'utf8'));
const SERVER_VERSION: string = pkgJson.version;
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

  function requireOrgOrBot(req: import('express').Request, res: import('express').Response): string | undefined {
    if (req.bot) return req.bot.org_id;
    if (req.org) return req.org.id;
    res.status(403).json({ error: 'Authentication required', code: 'FORBIDDEN' });
    return undefined;
  }

  function requireOrgAdmin(req: import('express').Request, res: import('express').Response): boolean {
    // Ticket auth (authType='org') proves org_secret knowledge — that's admin
    if (req.authType === 'org' && req.org) return true;
    // Admin bots also qualify
    if (req.bot?.auth_role === 'admin') return true;
    res.status(403).json({ error: 'Organization admin authentication required', code: 'FORBIDDEN' });
    return false;
  }

  function checkMessageRateLimit(req: import('express').Request, res: import('express').Response): boolean {
    if (!req.bot) return true; // org-level requests don't have per-bot rate limits
    const result = db.checkAndRecordRateLimit(req.bot.org_id, req.bot.id, 'message');
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
    if (!req.bot) return true;
    const result = db.checkAndRecordRateLimit(req.bot.org_id, req.bot.id, 'thread');
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

  function resolveBot(orgId: string, idOrName: unknown): Bot | undefined {
    if (typeof idOrName !== 'string') return undefined;
    // Check ID first, but only accept if it belongs to this org
    const byId = db.getBotById(idOrName);
    if (byId && byId.org_id === orgId) return byId;
    // Fall back to name lookup within the org
    const byName = db.getBotByName(orgId, idOrName);
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

    // Cross-org isolation: verify the thread belongs to the bot's org
    if (req.bot && thread.org_id !== req.bot.org_id) {
      res.status(403).json({ error: 'Thread not in your org', code: 'FORBIDDEN' });
      return undefined;
    }

    // O9: Check terminal state BEFORE participant membership so that
    // non-participants get "thread is closed" rather than "not a participant"
    // when the thread is in a terminal state.
    if (opts?.rejectTerminal && (thread.status === 'resolved' || thread.status === 'closed')) {
      res.status(409).json({ error: `Thread is ${thread.status}; operation not allowed`, code: 'THREAD_CLOSED' });
      return undefined;
    }

    if (!req.bot || !db.isParticipant(thread.id, req.bot.id)) {
      res.status(403).json({ error: 'Not a participant of this thread', code: 'FORBIDDEN' });
      return undefined;
    }

    return thread;
  }

  /**
   * GET /api/version — Public server version info
   */
  router.get('/api/version', (_req, res) => {
    res.json({ version: SERVER_VERSION, server: 'hxa-connect' });
  });

  /**
   * POST /api/orgs — Create an organization
   * Body: { name, persist_messages? }
   * Auth: Admin secret (if HXA_CONNECT_ADMIN_SECRET is set)
   * Returns: org with org_secret
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
    // Return full org including org_secret for super admin
    res.json(org);
  });

  /**
   * GET /api/orgs — List all orgs
   * Auth: Admin secret (if HXA_CONNECT_ADMIN_SECRET is set)
   */
  router.get('/api/orgs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const orgs = db.listOrgs().map(({ org_secret, ...safe }) => ({
      ...safe,
      bot_count: db.listBots(safe.id).length,
    }));
    res.json(orgs);
  });

  /**
   * PATCH /api/orgs/:org_id — Update org name or status
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Body: { name?: string, status?: 'active' | 'suspended' }
   */
  router.patch('/api/orgs/:org_id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const org = db.getOrgById(req.params.org_id);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    if (org.status === 'destroyed') {
      res.status(409).json({ error: 'Cannot modify destroyed org', code: 'ORG_DESTROYED' });
      return;
    }

    const { name, status } = req.body;

    // Validate all fields before mutating
    if (status !== undefined && status !== 'active' && status !== 'suspended') {
      res.status(400).json({ error: 'status must be "active" or "suspended" (use DELETE to destroy)', code: 'VALIDATION_ERROR' });
      return;
    }
    if (name !== undefined && (!name || typeof name !== 'string')) {
      res.status(400).json({ error: 'name must be a non-empty string', code: 'VALIDATION_ERROR' });
      return;
    }

    // Apply mutations after all validation passes
    if (status !== undefined && status !== org.status) {
      db.updateOrgStatus(org.id, status);

      if (status === 'suspended') {
        // Invalidate all outstanding org tickets
        db.invalidateOrgTickets(org.id);
        // Disconnect all WS clients
        ws.disconnectOrg(org.id, 4100, 'Organization suspended');
      }
    }

    if (name !== undefined) {
      db.updateOrgName(org.id, name);
    }

    // Re-fetch to return current state
    const updated = db.getOrgById(org.id)!;
    res.json({ id: updated.id, name: updated.name, status: updated.status });
  });

  /**
   * DELETE /api/orgs/:org_id — Destroy an org (irreversible)
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Response: 204 No Content
   */
  router.delete('/api/orgs/:org_id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const org = db.getOrgById(req.params.org_id);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // Disconnect all WS clients before deletion
    ws.disconnectOrg(org.id, 4101, 'Organization destroyed');

    // Destroy org (sets status, then deletes — CASCADE handles related data)
    db.destroyOrg(org.id);

    res.status(204).end();
  });

  /**
   * POST /api/orgs/:org_id/rotate-secret — Rotate org secret (super admin)
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Returns: { org_secret }
   */
  router.post('/api/orgs/:org_id/rotate-secret', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const org = db.getOrgById(req.params.org_id);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    if (org.status === 'destroyed') {
      res.status(409).json({ error: 'Cannot rotate secret for destroyed org', code: 'ORG_DESTROYED' });
      return;
    }

    const newSecret = crypto.randomBytes(24).toString('hex');
    const newSecretHash = HubDB.hashToken(newSecret);
    db.rotateOrgSecret(org.id, newSecretHash);
    db.invalidateOrgTickets(org.id);

    res.json({ org_secret: newSecret });
  });

  // ─── Shared Registration Validation ───────────────────────

  /**
   * Validate and extract bot registration fields from a request body.
   * Returns the validated fields or sends an error response and returns null.
   */
  async function validateRegistrationBody(
    body: any,
    res: import('express').Response,
  ): Promise<{
    name: string;
    metadata?: Record<string, unknown> | null;
    webhook_url?: string | null;
    webhook_secret?: string | null;
    profile: BotProfileInput;
  } | null> {
    const {
      name,
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
    } = body;

    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return null;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, _, -)', code: 'VALIDATION_ERROR' });
      return null;
    }

    // Per-field size limits
    const fieldError = checkFieldLimits({ name, metadata, webhook_url, bio, role, function: functionName, team, tags, languages, protocols, status_text, timezone, active_hours, version, runtime });
    if (fieldError) {
      res.status(400).json({ error: fieldError });
      return null;
    }

    // Validate profile field types
    const stringFields = { bio, role, function: functionName, team, status_text, timezone, active_hours, version, runtime };
    for (const [key, val] of Object.entries(stringFields)) {
      if (val !== undefined && val !== null && typeof val !== 'string') {
        res.status(400).json({ error: `${key} must be a string or null` });
        return null;
      }
    }
    for (const [key, val] of Object.entries({ tags, languages }) as [string, unknown][]) {
      if (val !== undefined && val !== null && (!Array.isArray(val) || !val.every((v: unknown) => typeof v === 'string'))) {
        res.status(400).json({ error: `${key} must be an array of strings or null` });
        return null;
      }
    }
    if (protocols !== undefined && protocols !== null && typeof protocols !== 'object') {
      res.status(400).json({ error: 'protocols must be an object or null' });
      return null;
    }

    const profile: BotProfileInput = {
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
        return null;
      }
    }

    return { name, metadata, webhook_url, webhook_secret, profile };
  }

  // ─── Public Auth Routes (Ticket-Based) ──────────────────

  /**
   * POST /api/auth/login — Authenticate with org credentials and receive a ticket
   * Body: { org_id, org_secret, reusable?, expires_in? }
   * Returns: { ticket, expires_at, reusable, org: { id, name } }
   */
  router.post('/api/auth/login', (req, res) => {
    const { org_id, org_secret, reusable, expires_in } = req.body;

    // Validate required fields
    if (!org_id || typeof org_id !== 'string') {
      res.status(400).json({ error: 'org_id is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (!org_secret || typeof org_secret !== 'string') {
      res.status(400).json({ error: 'org_secret is required', code: 'VALIDATION_ERROR' });
      return;
    }

    // Look up org
    const org = db.getOrgById(org_id);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // Verify org_secret
    if (!db.verifyOrgSecret(org.id, org_secret)) {
      res.status(401).json({ error: 'Invalid org secret', code: 'INVALID_SECRET' });
      return;
    }

    // Check org status
    if (org.status !== 'active') {
      const code = org.status === 'suspended' ? 'ORG_SUSPENDED' : 'ORG_DESTROYED';
      res.status(403).json({ error: `Organization is ${org.status}`, code });
      return;
    }

    // Calculate expiry (default 24 hours for web UI sessions)
    const expiresInSec = typeof expires_in === 'number' && expires_in > 0 ? expires_in : 86400;
    const expiresAt = Date.now() + expiresInSec * 1000;

    // Store the hash of the plaintext org_secret in the ticket for rotation binding
    const secretHash = HubDB.hashToken(org_secret);

    const isReusable = reusable === true;
    const ticket = db.createOrgTicket(org.id, secretHash, {
      reusable: isReusable,
      expiresAt,
      createdBy: 'login',
    });

    res.json({
      ticket: ticket.id,
      expires_at: ticket.expires_at,
      reusable: ticket.reusable,
      org: { id: org.id, name: org.name },
    });
  });

  /**
   * POST /api/auth/register — Register a bot using a ticket (no Bearer auth needed)
   * Body: { org_id, ticket, name, ...profile fields }
   * Returns: { bot_id, token, name, auth_role }
   */
  router.post('/api/auth/register', async (req, res) => {
    const { org_id, ticket: ticketId } = req.body;

    // Validate required fields
    if (!org_id || typeof org_id !== 'string') {
      res.status(400).json({ error: 'org_id is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (!ticketId || typeof ticketId !== 'string') {
      res.status(400).json({ error: 'ticket is required', code: 'VALIDATION_ERROR' });
      return;
    }

    // Validate registration body fields
    const validated = await validateRegistrationBody(req.body, res);
    if (!validated) return; // response already sent

    // Get and validate the ticket
    const ticket = db.getOrgTicket(ticketId);
    if (!ticket) {
      res.status(401).json({ error: 'Invalid ticket', code: 'INVALID_TICKET' });
      return;
    }

    // Check ticket belongs to this org
    if (ticket.org_id !== org_id) {
      res.status(401).json({ error: 'Invalid ticket', code: 'INVALID_TICKET' });
      return;
    }

    // Check not expired
    if (ticket.expires_at <= Date.now()) {
      res.status(401).json({ error: 'Ticket expired', code: 'TICKET_EXPIRED' });
      return;
    }

    // Check not already consumed (for one-time tickets)
    if (!ticket.reusable && ticket.consumed) {
      res.status(401).json({ error: 'Ticket already consumed', code: 'TICKET_CONSUMED' });
      return;
    }

    // Redeem the ticket (atomic consume for one-time tickets)
    if (!ticket.reusable) {
      const redeemed = db.redeemOrgTicket(ticketId);
      if (!redeemed) {
        res.status(401).json({ error: 'Ticket already consumed', code: 'TICKET_CONSUMED' });
        return;
      }
    }

    // Get org and check status
    const org = db.getOrgById(org_id);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }
    if (org.status !== 'active') {
      const code = org.status === 'suspended' ? 'ORG_SUSPENDED' : 'ORG_DESTROYED';
      res.status(403).json({ error: `Organization is ${org.status}`, code });
      return;
    }

    // Register the bot (always as member — org admin promotes via Web UI)
    const { bot, created, plaintextToken } = db.registerBot(
      org_id,
      validated.name,
      validated.metadata,
      validated.webhook_url,
      validated.webhook_secret,
      validated.profile,
    );

    // Audit
    db.recordAudit(org_id, bot.id, 'bot.register', 'bot', bot.id, { name: bot.name, reregister: !created, via: 'ticket' });

    const response: Record<string, unknown> = {
      bot_id: bot.id,
      ...toBotResponse(bot),
    };
    // Only include token on initial registration
    if (created && plaintextToken !== null) {
      response.token = plaintextToken;
    }
    res.json(response);
  });

  // ─── Authenticated Routes ─────────────────────────────────

  const auth = Router();
  auth.use(authMiddleware(db));

  /**
   * GET /api/org — Get current org info
   * Auth: Bot token or org ticket
   */
  auth.get('/api/org', (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;
    const org = db.getOrgById(orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ id: org.id, name: org.name, status: org.status });
  });

  /**
   * GET /api/bots/:id — Get a single bot by ID
   * Auth: Org ticket or bot token (same org)
   */
  auth.get('/api/bots/:id', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;
    const bot = db.getBotById(req.params.id as string);
    if (!bot || bot.org_id !== orgId) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }
    res.json(toBotResponse(bot));
  });

  /**
   * DELETE /api/bots/:id — Remove a bot (org admin only)
   * Auth: Org ticket or admin bot token
   */
  auth.delete('/api/bots/:id', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const orgId = req.org?.id || req.bot?.org_id;
    const bot = db.getBotById(req.params.id as string);
    if (!bot || bot.org_id !== orgId) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    db.deleteBot(bot.id);

    // Audit
    db.recordAudit(orgId!, bot.id, 'bot.delete', 'bot', bot.id, { name: bot.name });

    // Broadcast bot offline
    ws.broadcastToOrg(bot.org_id, {
      type: 'bot_offline',
      bot: { id: bot.id, name: bot.name },
    });

    res.json({ ok: true, message: `Bot "${bot.name}" deleted` });
  });

  /**
   * DELETE /api/me — Deregister self (bot unregisters itself)
   * Auth: Bot token
   */
  auth.delete('/api/me', requireBot, requireScope('full'), (req, res) => {
    const bot = req.bot!;
    db.deleteBot(bot.id);

    // Audit
    db.recordAudit(bot.org_id, bot.id, 'bot.delete', 'bot', bot.id, { name: bot.name, self: true });

    // Broadcast bot offline
    ws.broadcastToOrg(bot.org_id, {
      type: 'bot_offline',
      bot: { id: bot.id, name: bot.name },
    });

    res.json({ ok: true, message: `Bot "${bot.name}" deregistered` });
  });

  /**
   * GET /api/me — Get current bot info
   */
  auth.get('/api/me', requireBot, requireScope('read'), (req, res) => {
    const a = req.bot!;
    res.json(toBotResponse(a));
  });

  /**
   * PATCH /api/me/profile — Update current bot profile fields
   */
  auth.patch('/api/me/profile', requireBot, requireScope('profile'), (req, res) => {
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

    const fields: BotProfileInput = {
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

    const updated = db.updateProfile(req.bot!.id, fields);
    if (!updated) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    // Audit
    const changedFields = Object.keys(fields).filter(k => (fields as any)[k] !== undefined);
    db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.profile_update', 'bot', req.bot!.id, { fields: changedFields });

    req.bot = updated;
    res.json(toBotResponse(updated));
  });

  /**
   * PATCH /api/me/name — Rename current bot
   */
  auth.patch('/api/me/name', requireBot, requireScope('profile'), (req, res) => {
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, _, -)', code: 'VALIDATION_ERROR' });
      return;
    }

    const fieldError = checkFieldLimits({ name }, { name: FIELD_LIMITS.name } as any);
    if (fieldError) {
      res.status(400).json({ error: fieldError });
      return;
    }

    if (name === req.bot!.name) {
      res.status(400).json({ error: 'New name is the same as current name', code: 'VALIDATION_ERROR' });
      return;
    }

    const old_name = req.bot!.name;
    const result = db.renameBot(req.bot!.id, name);

    if (result.conflict) {
      res.status(409).json({ error: 'A bot with that name already exists in this org', code: 'NAME_CONFLICT' });
      return;
    }

    // Audit
    db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.rename', 'bot', req.bot!.id, { old_name, new_name: name });

    // Broadcast to org
    ws.broadcastToOrg(req.bot!.org_id, {
      type: 'bot_renamed',
      bot_id: req.bot!.id,
      old_name,
      new_name: name,
    });

    req.bot = result.bot;
    res.json(toBotResponse(result.bot));
  });

  /**
   * GET /api/peers — List other bots in my org (from bot perspective)
   */
  auth.get('/api/peers', requireBot, requireScope('read'), (req, res) => {
    const bots = db.listBots(req.bot!.org_id);
    res.json(bots
      .filter(a => a.id !== req.bot!.id)
      .map(a => toBotResponse(a))
    );
  });

  // ─── Scoped Token Management ─────────────────────────────

  /**
   * POST /api/me/tokens — Create a scoped token
   * Body: { scopes: TokenScope[], label?, expires_in?: number (ms) }
   */
  auth.post('/api/me/tokens', requireBot, requireScope('full'), (req, res) => {
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
    const token = db.createBotToken(req.bot!.id, scopes as TokenScope[], label, expiresAt);

    db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.token_create', 'token', token.id, {
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
  auth.get('/api/me/tokens', requireBot, requireScope('full'), (req, res) => {
    const tokens = db.listBotTokens(req.bot!.id);
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
  auth.delete('/api/me/tokens/:id', requireBot, requireScope('full'), (req, res) => {
    const deleted = db.revokeBotToken(req.params.id as string, req.bot!.id);
    if (!deleted) {
      res.status(404).json({ error: 'Token not found', code: 'NOT_FOUND' });
      return;
    }
    db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.token_revoke', 'token', req.params.id as string);
    res.json({ ok: true });
  });

  /**
   * GET /api/bots — List/discover bots in org
   * Auth: org ticket or bot token
   *
   * Org callers get paginated behavior:
   *   Query: search?, cursor? (bot id), limit? (default 50, max 200)
   *   Returns: { items, has_more, next_cursor? } (or flat array when no pagination params)
   *
   * Bot callers get flat array with filters:
   *   Query: role?, tag?, status?, q?
   *   Returns: Bot[]
   */
  auth.get('/api/bots', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    // Org caller: paginated behavior (migrated from old GET /api/bots)
    if (req.authType === 'org') {
      const cursor = getQueryString(req.query.cursor);
      const limitParam = getQueryString(req.query.limit);
      const search = getQueryString(req.query.search)?.trim();

      // When no pagination params and no search, fall back to unpaginated behavior
      if (!cursor && !limitParam && !search) {
        const bots = db.listBots(req.org!.id);
        res.json(bots.map(a => toBotResponse(a)));
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
      const rows = db.listBotsPaginated(req.org!.id, cursor, limit, search);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const response: Record<string, unknown> = {
        items: items.map(a => toBotResponse(a)),
        has_more: hasMore,
      };
      if (hasMore) {
        response.next_cursor = items[items.length - 1].id;
      }
      res.json(response);
      return;
    }

    // Bot caller: flat array with filters
    const role = getQueryString(req.query.role);
    const tag = getQueryString(req.query.tag);
    const status = getQueryString(req.query.status);
    const q = getQueryString(req.query.q);

    const bots = db.listBots(orgId, { role, tag, status, q });
    res.json(bots.map(bot => toBotResponse(bot)));
  });

  /**
   * GET /api/bots/:name/webhook/health — Check webhook health for a bot
   * Auth: bot token or org API key
   * Org-scoped: only check bots in the same org
   */
  auth.get('/api/bots/:name/webhook/health', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const bot = db.getBotByName(orgId, req.params.name as string);
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
   * Auth: org API key or bot token
   */
  auth.get('/api/bots/:name/profile', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const bot = db.getBotByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    res.json(toBotResponse(bot));
  });

  // ─── Channels ─────────────────────────────────────────────

  /**
   * POST /api/channels — Create a channel
   * Auth: Org ticket or admin bot token
   * Body: { type: 'direct'|'group', members: [bot_id_or_name, ...], name? }
   */
  auth.post('/api/channels', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const { type, members, name } = req.body;
    const orgId = (req.org?.id || req.bot?.org_id)!;

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
      const bot = db.getBotById(m) || db.getBotByName(orgId, m);
      if (!bot || bot.org_id !== orgId) {
        res.status(400).json({ error: `Bot not found: ${m}` });
        return;
      }
      memberIds.push(bot.id);
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
   * For bots: channels they're in
   * For org admins: all channels
   */
  auth.get('/api/channels', requireScope('read'), (req, res) => {
    if (req.bot) {
      res.json(db.listChannelsForBot(req.bot.id));
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

    // Cross-org isolation
    if (req.bot && channel.org_id !== req.bot.org_id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }
    // Check access
    if (req.bot && !db.isChannelMember(channel.id, req.bot.id)) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }

    const members = db.getChannelMembers(channel.id).map(m => {
      const bot = db.getBotById(m.bot_id);
      return {
        id: m.bot_id,
        name: bot?.name,
        online: bot?.online,
      };
    });

    res.json({ ...channel, members });
  });

  /**
   * POST /api/channels/:id/join — Join a group channel (bot)
   */
  auth.post('/api/channels/:id/join', requireBot, requireScope('message'), (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.type !== 'group') {
      res.status(404).json({ error: 'Group channel not found', code: 'NOT_FOUND' });
      return;
    }
    if (channel.org_id !== req.bot!.org_id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }
    db.addChannelMember(channel.id, req.bot!.id);
    res.json({ ok: true });
  });

  /**
   * DELETE /api/channels/:id — Delete a channel (org admin only)
   * Auth: Org ticket or admin bot token
   */
  auth.delete('/api/channels/:id', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const channel = db.getChannel(req.params.id as string);
    if (!channel || channel.org_id !== orgId) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    db.deleteChannel(channel.id);

    // Audit
    db.recordAudit(orgId, null, 'channel.delete', 'channel', channel.id, { name: channel.name });

    // Broadcast channel deletion
    ws.broadcastToOrg(orgId, {
      type: 'channel_deleted',
      channel_id: channel.id,
    });

    res.json({ ok: true, message: `Channel deleted` });
  });

  // ─── Org Admin Thread Endpoints ──────────────────────────

  /**
   * GET /api/org/threads — List all threads in the org
   * Query: status?, cursor? (thread id), limit? (default 50, max 200), offset? (legacy)
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const statusRaw = getQueryString(req.query.status);
    if (statusRaw && !THREAD_STATUSES.has(statusRaw as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const status = statusRaw as ThreadStatus | undefined;
    const cursor = getQueryString(req.query.cursor);
    const limitParam = getQueryString(req.query.limit);
    const offsetParam = getQueryString(req.query.offset);
    const search = getQueryString(req.query.search)?.trim();

    // When cursor is present, or search/limit specified, use paginated behavior
    if (cursor || search || (limitParam && !offsetParam)) {
      const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
      const rows = db.listThreadsForOrgPaginated(orgId, status, cursor, limit, search);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const response: Record<string, unknown> = {
        items,
        has_more: hasMore,
      };
      if (hasMore) {
        response.next_cursor = items[items.length - 1].id;
      }
      res.json(response);
      return;
    }

    // Legacy offset-based behavior
    const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam || '') || 0, 0);
    const threads = db.listThreadsForOrg(orgId, status, limit, offset);
    res.json(threads);
  });

  /**
   * GET /api/org/threads/:id — Thread detail with participants
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads/:id', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== orgId) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const participants = db.getParticipants(thread.id).map(p => {
      const bot = db.getBotById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
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
   * Query: limit?, before? (message id for pagination, or timestamp for legacy), since?
   * When before is a message id (not numeric), uses cursor-based pagination and returns
   * { messages: [...], has_more: boolean } with messages sorted newest first.
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads/:id/messages', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== orgId) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const sinceStr = getQueryString(req.query.since);

    // Detect cursor-based pagination: before is a non-numeric string (message id)
    const isBeforeId = beforeStr !== undefined && isNaN(Number(beforeStr));

    if (isBeforeId) {
      // Cursor-based pagination path (newest first)
      const rows = db.getThreadMessagesPaginated(thread.id, isBeforeId ? beforeStr : undefined, limit);
      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;

      const enriched = messages.map(m => {
        const sender = m.sender_id ? db.getBotById(m.sender_id) : undefined;
        return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown' };
      });

      res.json({ messages: enriched, has_more: hasMore });
      return;
    }

    // Legacy timestamp-based path
    const before = beforeStr ? parseInt(beforeStr) : undefined;
    const since = sinceStr !== undefined ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid integer timestamp' });
      return;
    }

    const messages = db.getThreadMessages(thread.id, limit, before, since);
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getBotById(m.sender_id) : undefined;
      return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse());
  });

  /**
   * GET /api/org/threads/:id/artifacts — Thread artifacts
   * Query: cursor? (artifact key), limit? (default 50, max 200)
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads/:id/artifacts', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== orgId) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const cursor = getQueryString(req.query.cursor);
    const limitParam = getQueryString(req.query.limit);

    // When no pagination params, fall back to existing unpaginated behavior
    if (!cursor && !limitParam) {
      res.json(db.listArtifacts(thread.id));
      return;
    }

    const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
    const rows = db.listArtifactsPaginated(thread.id, cursor, limit);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const response: Record<string, unknown> = {
      items,
      has_more: hasMore,
    };
    if (hasMore) {
      response.next_cursor = items[items.length - 1].artifact_key;
    }
    res.json(response);
  });

  /**
   * PATCH /api/org/threads/:id — Update thread status (org admin)
   * Body: { status, close_reason? }
   */
  auth.patch('/api/org/threads/:id', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const thread = db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== orgId) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const { status: statusInput, close_reason } = req.body;
    if (statusInput === undefined) {
      res.status(400).json({ error: 'status is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (typeof statusInput !== 'string' || !THREAD_STATUSES.has(statusInput as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }
    const status = statusInput as ThreadStatus;

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

    try {
      const updated = db.updateThreadStatus(thread.id, status, closeReason);
      if (!updated) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      // Broadcast status change
      const by = req.org ? `org:${orgId}` : req.bot!.name;
      ws.broadcastThreadEvent(orgId, thread.id, {
        type: 'thread_status_changed',
        thread_id: thread.id,
        topic: updated.topic,
        from: thread.status,
        to: updated.status,
        by,
      });

      // Catchup events for offline bots
      const participants = db.getParticipants(thread.id);
      for (const p of participants) {
        db.recordCatchupEvent(orgId, p.bot_id, 'thread_status_changed', {
          thread_id: thread.id,
          topic: updated.topic,
          from: thread.status,
          to: updated.status,
          by,
        });
      }

      // Audit
      const actorId = req.bot?.id || `org:${orgId}`;
      db.recordAudit(orgId, actorId, 'thread.status_changed', 'thread', thread.id, {
        from: thread.status,
        to: updated.status,
        close_reason: closeReason || null,
      });

      res.json(updated);
    } catch (err: any) {
      if (err.message?.startsWith('Cannot transition')) {
        res.status(409).json({ error: err.message, code: 'INVALID_TRANSITION' });
      } else {
        throw err;
      }
    }
  });

  // ─── Threads ─────────────────────────────────────────────

  /**
   * POST /api/threads — Create a thread
   * Body: { topic, tags?, participants?, channel_id?, context? }
   */
  auth.post('/api/threads', requireBot, requireScope('thread'), (req, res) => {
    if (!checkThreadRateLimit(req, res)) return;

    const { topic, tags, participants, channel_id, context, permission_policy } = req.body;
    const orgId = req.bot!.org_id;

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
      const bot = resolveBot(orgId, p);
      if (!bot) {
        res.status(400).json({ error: `Bot not found: ${p}` });
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
        req.bot!.id,
        topic,
        resolvedTags,
        resolvedParticipantIds,
        resolvedChannelId,
        contextJson,
        policyJson,
      );

      // Audit (rate limit event already recorded atomically in checkThreadRateLimit)
      db.recordAudit(orgId, req.bot!.id, 'thread.create', 'thread', thread.id, { topic, tags: resolvedTags });

      // Record catchup events: thread_invited for each participant (except initiator)
      const allParticipantIds = Array.from(new Set([req.bot!.id, ...resolvedParticipantIds]));
      for (const pid of allParticipantIds) {
        if (pid === req.bot!.id) continue;
        db.recordCatchupEvent(orgId, pid, 'thread_invited', {
          thread_id: thread.id,
          topic: thread.topic,
          inviter: req.bot!.id,
        });
      }

      ws.broadcastThreadEvent(orgId, thread.id, {
        type: 'thread_created',
        thread,
      });

      // Emit individual join events for all participants (including initiator)
      for (const pid of allParticipantIds) {
        const bot = db.getBotById(pid);
        if (!bot) continue;
        ws.broadcastThreadEvent(orgId, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: pid,
          bot_name: bot.name,
          action: 'joined',
          by: req.bot!.id,
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
  auth.get('/api/threads', requireBot, requireScope('read'), (req, res) => {
    const statusRaw = getQueryString(req.query.status);
    if (statusRaw && !THREAD_STATUSES.has(statusRaw as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const status = statusRaw as ThreadStatus | undefined;
    const threads = db.listThreadsForBot(req.bot!.id, status);
    res.json(threads);
  });

  /**
   * GET /api/threads/:id — Thread details with participants
   */
  auth.get('/api/threads/:id', requireBot, requireScope('read'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const participants = db.getParticipants(thread.id).map(p => {
      const bot = db.getBotById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
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
  auth.patch('/api/threads/:id', requireBot, requireScope('thread'), (req, res) => {
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
    if (permPolicyInput !== undefined && thread.initiator_id !== req.bot!.id) {
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

    // Only org admins can reopen terminal threads
    if (status === 'active' && (thread.status === 'resolved' || thread.status === 'closed')) {
      res.status(403).json({ error: 'Only org admin can reopen resolved/closed threads', code: 'FORBIDDEN' });
      return;
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
      if (policyAction && !db.checkThreadPermission(thread, req.bot!.id, policyAction)) {
        db.recordAudit(thread.org_id, req.bot!.id, 'thread.permission_denied', 'thread', thread.id, {
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
        db.recordAudit(thread.org_id, req.bot!.id, 'thread.status_changed', 'thread', thread.id, {
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
            by: req.bot!.id,
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
  auth.post('/api/threads/:id/participants', requireBot, requireScope('thread'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    // Permission policy check for invite
    if (!db.checkThreadPermission(thread, req.bot!.id, 'invite')) {
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

    const bot = resolveBot(thread.org_id, bot_id);
    if (!bot) {
      res.status(404).json({ error: `Bot not found: ${bot_id}` });
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
        db.recordAudit(thread.org_id, req.bot!.id, 'thread.invite', 'thread', thread.id, {
          invited_bot_id: bot.id,
          invited_bot_name: bot.name,
        });

        // Record catchup event for the invited bot
        db.recordCatchupEvent(thread.org_id, bot.id, 'thread_invited', {
          thread_id: thread.id,
          topic: thread.topic,
          inviter: req.bot!.id,
        });

        ws.broadcastThreadEvent(thread.org_id, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: bot.id,
          bot_name: bot.name,
          action: 'joined',
          by: req.bot!.id,
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
  auth.delete('/api/threads/:id/participants/:bot', requireBot, requireScope('thread'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    const target = resolveBot(thread.org_id, req.params.bot as string);
    if (!target) {
      res.status(404).json({ error: `Bot not found: ${req.params.bot}` });
      return;
    }

    // Permission policy check for remove (skip if leaving self)
    if (target.id !== req.bot!.id && !db.checkThreadPermission(thread, req.bot!.id, 'remove')) {
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
      by: req.bot!.id,
    });

    // Record catchup event so the removed bot sees it even if offline
    db.recordCatchupEvent(thread.org_id, target.id, 'thread_participant_removed', {
      thread_id: thread.id,
      topic: thread.topic,
      removed_by: req.bot!.id,
    });

    db.removeParticipant(thread.id, target.id);

    // Audit
    db.recordAudit(thread.org_id, req.bot!.id, 'thread.remove_participant', 'thread', thread.id, {
      removed_bot_id: target.id,
      removed_bot_name: target.name,
    });

    res.json({ ok: true });
  });

  /**
   * POST /api/threads/:id/messages — Send a thread message
   * Body: { content, content_type?, metadata? }
   */
  auth.post('/api/threads/:id/messages', requireBot, requireScope('thread'), (req, res) => {
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
      req.bot!.id,
      resolvedContent,
      typeof content_type === 'string' ? content_type : 'text',
      metadataJson,
      partsJson,
    );

    const enriched = { ...enrichThreadMessage(message), sender_name: req.bot!.name };

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    db.recordAudit(thread.org_id, req.bot!.id, 'message.send', 'thread_message', message.id, { thread_id: thread.id });

    // Record catchup events for all participants except the sender
    const threadParticipants = db.getParticipants(thread.id);
    for (const p of threadParticipants) {
      if (p.bot_id === req.bot!.id) continue;
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
  auth.get('/api/threads/:id/messages', requireBot, requireScope('read'), (req, res) => {
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
      const sender = m.sender_id ? db.getBotById(m.sender_id) : undefined;
      return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse());
  });

  /**
   * POST /api/threads/:id/artifacts — Add new artifact (new key only)
   * Use PATCH to update existing artifacts with new versions.
   */
  auth.post('/api/threads/:id/artifacts', requireBot, requireScope('thread'), (req, res) => {
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
        req.bot!.id,
        artifact_key,
        artifactType,
        title === undefined ? undefined : (title ?? null),
        content === undefined ? undefined : (content ?? null),
        language === undefined ? undefined : (language ?? null),
        url === undefined ? undefined : (url ?? null),
        mime_type === undefined ? undefined : (mime_type ?? null),
      );

      // Audit
      db.recordAudit(thread.org_id, req.bot!.id, 'artifact.add', 'artifact', artifact.id, {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      });

      // Record catchup events for all participants except the contributor
      const participants = db.getParticipants(thread.id);
      for (const p of participants) {
        if (p.bot_id === req.bot!.id) continue;
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
  auth.patch('/api/threads/:id/artifacts/:key', requireBot, requireScope('thread'), (req, res) => {
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
        req.bot!.id,
        content,
        title === undefined ? undefined : (title ?? null),
      );

      if (!artifact) {
        res.status(404).json({ error: 'Artifact not found', code: 'NOT_FOUND' });
        return;
      }

      // Audit
      db.recordAudit(thread.org_id, req.bot!.id, 'artifact.update', 'artifact', artifact.id, {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      });

      // Record catchup events for all participants except the contributor
      const participants = db.getParticipants(thread.id);
      for (const p of participants) {
        if (p.bot_id === req.bot!.id) continue;
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
  auth.get('/api/threads/:id/artifacts', requireBot, requireScope('read'), (req, res) => {
    const thread = requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    res.json(db.listArtifacts(thread.id));
  });

  /**
   * GET /api/threads/:id/artifacts/:key/versions — List all versions for a key
   */
  auth.get('/api/threads/:id/artifacts/:key/versions', requireBot, requireScope('read'), (req, res) => {
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
  auth.post('/api/channels/:id/messages', requireBot, requireScope('message'), (req, res) => {
    if (!checkMessageRateLimit(req, res)) return;

    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    // Cross-org isolation
    if (channel.org_id !== req.bot!.org_id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }

    if (!db.isChannelMember(channel.id, req.bot!.id)) {
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

    const msg = db.createMessage(channel.id, req.bot!.id, resolvedContent, content_type || 'text', partsJson);

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    db.recordAudit(channel.org_id, req.bot!.id, 'message.send', 'channel_message', msg.id, { channel_id: channel.id });

    // Record catchup events for all channel members except the sender
    const members = db.getChannelMembers(channel.id);
    for (const m of members) {
      if (m.bot_id === req.bot!.id) continue;
      db.recordCatchupEvent(channel.org_id, m.bot_id, 'channel_message_summary', {
        channel_id: channel.id,
        channel_name: channel.name ?? undefined,
        count: 1,
        last_at: msg.created_at,
      }, channel.id);
    }

    // Broadcast via WebSocket
    ws.broadcastMessage(channel.id, msg, req.bot!.name);

    res.json(enrichMessage(msg));
  });

  /**
   * GET /api/channels/:id/messages — Get messages from a channel
   * Query: limit?, before? (message id for pagination, or timestamp for legacy), since? (timestamps)
   * When before is a message id (not numeric), uses cursor-based pagination and returns
   * { messages: [...], has_more: boolean } with messages sorted newest first.
   */
  auth.get('/api/channels/:id/messages', requireScope('read'), (req, res) => {
    const channel = db.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    // Cross-org isolation
    if (req.bot && channel.org_id !== req.bot.org_id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }
    // Check access
    if (req.bot && !db.isChannelMember(channel.id, req.bot.id)) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }
    if (req.org && channel.org_id !== req.org.id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const beforeStr = getQueryString(req.query.before);
    const sinceStr = getQueryString(req.query.since);

    // Detect cursor-based pagination: before is a non-numeric string (message id)
    const isBeforeId = beforeStr !== undefined && isNaN(Number(beforeStr));

    if (isBeforeId) {
      // Cursor-based pagination path (newest first)
      const rows = db.getMessagesPaginated(channel.id, isBeforeId ? beforeStr : undefined, limit);
      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;

      const enriched = messages.map(m => {
        const sender = m.sender_id ? db.getBotById(m.sender_id) : undefined;
        return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
      });

      res.json({ messages: enriched, has_more: hasMore });
      return;
    }

    // Legacy timestamp-based path
    const before = beforeStr ? parseInt(beforeStr) : undefined;
    const since = sinceStr !== undefined ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid integer timestamp' });
      return;
    }

    const messages = db.getMessages(channel.id, limit, before, since);

    // Enrich with sender names and parsed parts
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getBotById(m.sender_id) : undefined;
      return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
    });

    res.json(enriched.reverse()); // Return in chronological order
  });

  /**
   * POST /api/send — Quick send: DM a bot by name/id (auto-creates channel)
   * Body: { to, content, content_type? }
   */
  auth.post('/api/send', requireBot, requireScope('message'), (req, res) => {
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

    const orgId = req.bot!.org_id;
    const target = db.getBotById(to) || db.getBotByName(orgId, to);

    if (!target || target.org_id !== orgId) {
      res.status(404).json({ error: `Bot not found: ${to}` });
      return;
    }

    if (target.id === req.bot!.id) {
      res.status(400).json({ error: 'Cannot send to yourself' });
      return;
    }

    if (resolvedContent.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    // Find or create direct channel
    const channel = db.createChannel(orgId, 'direct', [req.bot!.id, target.id]);

    // Broadcast channel creation if new
    if (channel.isNew) {
      ws.broadcastToOrg(orgId, {
        type: 'channel_created',
        channel: { id: channel.id, org_id: channel.org_id, type: channel.type, name: channel.name, created_at: channel.created_at },
        members: [req.bot!.id, target.id],
      });
    }

    const msg = db.createMessage(channel.id, req.bot!.id, resolvedContent, content_type || 'text', partsJson);

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    db.recordAudit(req.bot!.org_id, req.bot!.id, 'message.send', 'channel_message', msg.id, { channel_id: channel.id, to: target.id });

    // Record catchup event for the target
    db.recordCatchupEvent(req.bot!.org_id, target.id, 'channel_message_summary', {
      channel_id: channel.id,
      channel_name: channel.name ?? undefined,
      count: 1,
      last_at: msg.created_at,
    }, channel.id);

    // Broadcast
    ws.broadcastMessage(channel.id, msg, req.bot!.name);

    res.json({ channel_id: channel.id, message: enrichMessage(msg) });
  });

  // ─── Catchup (Offline Event Replay) ───────────────────────

  /**
   * GET /api/me/catchup — Get missed events since timestamp
   * Query: since (required, ms timestamp), cursor?, limit?
   */
  auth.get('/api/me/catchup', requireBot, requireScope('read'), (req, res) => {
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : NaN;
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const limitRaw = parseInt(getQueryString(req.query.limit) || '') || 50;
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const cursor = getQueryString(req.query.cursor);

    const { events, has_more } = db.getCatchupEvents(req.bot!.id, since, limit, cursor);

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
  auth.get('/api/me/catchup/count', requireBot, requireScope('read'), (req, res) => {
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : NaN;
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const counts: CatchupCountResponse = db.getCatchupCount(req.bot!.id, since);
    res.json(counts);
  });

  // ─── Inbox ─────────────────────────────────────────────────

  /**
   * GET /api/inbox — Get new messages since timestamp
   * Query: since (timestamp, required)
   */
  auth.get('/api/inbox', requireBot, requireScope('read'), (req, res) => {
    const since = parseInt(getQueryString(req.query.since) || '');
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const messages = db.getNewMessages(req.bot!.id, since);
    const enriched = messages.map(m => {
      const sender = m.sender_id ? db.getBotById(m.sender_id) : undefined;
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
   * Auth: bot token
   * Returns: { id, name, mime_type, size, url, created_at }
   */
  auth.post('/api/files/upload', requireBot, requireScope('message'), (req, res, next) => {
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

    const orgId = req.bot!.org_id;
    const relativePath = `files/${file.filename}`;
    const dailyLimitBytes = config.file_upload_mb_per_day * 1024 * 1024;
    const settings = db.getOrgSettings(orgId);
    const perBotDailyLimitBytes = settings.file_upload_mb_per_day_per_bot * 1024 * 1024;

    // Atomically check quota (org-level + per-bot) and create file record
    const result = db.createFileWithQuotaCheck(
      orgId,
      req.bot!.id,
      file.originalname,
      file.mimetype || null,
      file.size,
      relativePath,
      dailyLimitBytes,
      perBotDailyLimitBytes,
    );

    if (!result.ok) {
      // Clean up the uploaded file since we're rejecting it
      try { fs.unlinkSync(file.path); } catch { /* temp file may already be gone */ }
      const usedMb = Math.round(result.dailyBytes / 1024 / 1024);
      const limitMb = Math.round(result.limitBytes / 1024 / 1024);
      const scope = result.reason === 'bot' ? 'Per-bot daily' : 'Org daily';
      res.status(429).json({
        error: `${scope} upload quota exceeded (${usedMb}MB / ${limitMb}MB used today)`,
        code: 'RATE_LIMITED',
      });
      return;
    }

    const record = result.file;

    // Audit
    db.recordAudit(orgId, req.bot!.id, 'file.upload', 'file', record.id, {
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
   * Auth: bot token or org API key
   * Org-scoped: only bots/admins in the same org can download
   */
  auth.get('/api/files/:id', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrBot(req, res);
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
   * Auth: bot token or org API key
   * Org-scoped access check
   */
  auth.get('/api/files/:id/info', requireScope('read'), (req, res) => {
    const orgId = requireOrgOrBot(req, res);
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
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/settings', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;
    res.json(db.getOrgSettings(orgId));
  });

  /**
   * PATCH /api/org/settings — Update org settings
   * Auth: Org ticket or admin bot token
   * Body: partial OrgSettings fields
   */
  auth.patch('/api/org/settings', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

    const {
      messages_per_minute_per_bot,
      threads_per_hour_per_bot,
      file_upload_mb_per_day_per_bot,
      message_ttl_days,
      thread_auto_close_days,
      artifact_retention_days,
      default_thread_permission_policy,
    } = req.body;

    // Validate numeric fields (reject NaN, Infinity, non-integers)
    const numericFields: Record<string, unknown> = {
      messages_per_minute_per_bot,
      threads_per_hour_per_bot,
      file_upload_mb_per_day_per_bot,
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
    if (file_upload_mb_per_day_per_bot !== undefined) updates.file_upload_mb_per_day_per_bot = file_upload_mb_per_day_per_bot;
    if (message_ttl_days !== undefined) updates.message_ttl_days = message_ttl_days;
    if (thread_auto_close_days !== undefined) updates.thread_auto_close_days = thread_auto_close_days;
    if (artifact_retention_days !== undefined) updates.artifact_retention_days = artifact_retention_days;
    if (default_thread_permission_policy !== undefined) updates.default_thread_permission_policy = default_thread_permission_policy;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No settings fields provided', code: 'VALIDATION_ERROR' });
      return;
    }

    const settings = db.updateOrgSettings(orgId, updates);

    // Audit
    db.recordAudit(orgId, null, 'settings.update', 'org_settings', orgId, updates);

    res.json(settings);
  });

  // ─── Org Auth Management (Admin Bot) ─────────────────────

  /**
   * POST /api/org/tickets — Create an org ticket (org admin or admin bot)
   * Auth: Org ticket (org_secret login) or Bot token (admin role)
   * Body: { reusable?: boolean, expires_in?: number }
   * Returns: { ticket, expires_at, reusable }
   */
  auth.post('/api/org/tickets', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const { reusable, expires_in } = req.body;

    const orgId = req.bot?.org_id || req.org?.id;
    const org = orgId ? db.getOrgById(orgId) : undefined;
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // Calculate expiry
    const expiresInSec = typeof expires_in === 'number' && expires_in > 0 ? expires_in : 1800;
    const expiresAt = Date.now() + expiresInSec * 1000;

    // Use the org's stored org_secret hash as the secret_hash for the ticket
    // This allows rotation invalidation: when org_secret changes, the hash
    // won't match new tickets' secret_hash
    const secretHash = org.org_secret;

    const isReusable = reusable === true;
    const ticket = db.createOrgTicket(orgId!, secretHash, {
      reusable: isReusable,
      expiresAt,
      createdBy: req.bot?.id,
    });

    res.json({
      ticket: ticket.id,
      expires_at: ticket.expires_at,
      reusable: ticket.reusable,
    });
  });

  /**
   * POST /api/org/rotate-secret — Rotate the org secret (org admin or admin bot)
   * Auth: Org ticket (org_secret login) or Bot token (admin role)
   * Returns: { org_secret }
   */
  auth.post('/api/org/rotate-secret', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const orgId = req.bot?.org_id || req.org?.id;
    const org = orgId ? db.getOrgById(orgId) : undefined;
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    if (org.status === 'destroyed') {
      res.status(409).json({ error: 'Cannot rotate secret for destroyed org', code: 'ORG_DESTROYED' });
      return;
    }

    // Generate new secret
    const newSecret = crypto.randomBytes(24).toString('hex');
    const newSecretHash = HubDB.hashToken(newSecret);

    // Update in DB
    db.rotateOrgSecret(orgId!, newSecretHash);

    // Invalidate all unredeemed org_tickets for this org
    db.invalidateOrgTickets(orgId!);

    res.json({ org_secret: newSecret });
  });

  /**
   * PATCH /api/org/bots/:bot_id/role — Update a bot's auth_role (org admin or admin bot)
   * Auth: Org ticket (org_secret login) or Bot token (admin role)
   * Body: { auth_role: 'admin' | 'member' }
   * Returns: { bot_id, auth_role }
   */
  auth.patch('/api/org/bots/:bot_id/role', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const { auth_role } = req.body;

    // Validate auth_role
    if (auth_role !== 'admin' && auth_role !== 'member') {
      res.status(400).json({ error: "auth_role must be 'admin' or 'member'", code: 'VALIDATION_ERROR' });
      return;
    }

    const orgId = req.bot?.org_id || req.org?.id;
    const targetBotId = req.params.bot_id as string;
    const targetBot = db.getBotById(targetBotId);
    if (!targetBot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    // Verify same org
    if (targetBot.org_id !== orgId) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    // Guard: admin bot cannot demote self (prevent lockout)
    if (req.bot && targetBotId === req.bot.id && auth_role === 'member') {
      res.status(400).json({ error: 'Cannot demote yourself', code: 'SELF_DEMOTION' });
      return;
    }

    db.setBotAuthRole(targetBotId, auth_role);

    const actorId = req.bot?.id || 'org_admin';
    db.recordAudit(orgId!, actorId, 'bot.role_change', 'bot', targetBotId, { auth_role });

    res.json({ bot_id: targetBotId, auth_role });
  });

  // ─── WS Ticket Exchange ──────────────────────────────────

  /**
   * POST /api/ws-ticket — Exchange a Bearer token for a one-time WS connection ticket
   * Auth: Bearer token (bot token, scoped token, or org key)
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

    // Phase 3: Include org context in the ticket for WS org binding
    const orgId = req.bot?.org_id || req.org?.id;
    const ticketId = issueWsTicket(token, orgId);

    res.json({
      ticket: ticketId,
      expires_in: 30,
    });
  });

  // ─── Audit Log (Admin) ───────────────────────────────────

  /**
   * GET /api/audit — Query audit log
   * Auth: Org ticket or admin bot token
   * Query: since?, action?, target_type?, target_id?, bot_id?, limit?
   */
  auth.get('/api/audit', (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.org?.id || req.bot?.org_id)!;

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

    const entries = db.getAuditLog(orgId, { since, action, target_type, target_id, bot_id, limit });
    res.json(entries);
  });

  // Mount authenticated routes
  router.use(auth);

  return router;
}
