import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromFile } from 'file-type';
import { fileURLToPath } from 'node:url';
import { HubDB, encodeCursor } from './db.js';
import type { HubWS } from './ws.js';
import { authMiddleware, requireBot, requireScope, requireAuthRole } from './auth.js';
import { validateWebhookUrl } from './webhook.js';
import { validateParts, VALID_TOKEN_SCOPES, type HubConfig, type Bot, type BotProfileInput, type Thread, type ThreadStatus, type CloseReason, type ArtifactType, type MessagePart, type Message, type ThreadMessage, type MentionRef, type WireMessage, type WireThreadMessage, type CatchupResponse, type CatchupCountResponse, type OrgSettings, type TokenScope, type ThreadPermissionPolicy, type SessionRole, type RegisterResponse, type OrgTicketResponse } from './types.js';
import { issueWsTicket } from './ws-tickets.js';
import { routeLogger } from './logger.js';
import type { SessionStore } from './session.js';
import { generateSessionId, SESSION_TTL, SESSION_LIMIT, SESSION_COOKIE } from './session.js';
import { checkLoginRateLimit, recordLoginFailure } from './rate-limit.js';
import { generateSkillMd } from './skill-md.js';

/**
 * Express 4 does not forward rejected promises from async route handlers to
 * error middleware — unhandled rejections can crash the process or hang requests.
 * This utility wraps a Router so that any async handler registered via
 * .get/.post/.patch/.delete/.use/.all is automatically caught and forwarded to next(err).
 */
function wrapAsyncRouter(router: Router): Router {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'use', 'all'] as const;
  for (const method of methods) {
    const original = (router as any)[method].bind(router);
    (router as any)[method] = function (...args: any[]) {
      const wrapped = args.map((arg: any) =>
        typeof arg === 'function' && arg.constructor.name === 'AsyncFunction'
          ? (req: Request, res: Response, next: NextFunction) => { arg(req, res, next).catch(next); }
          : arg,
      );
      return original(...wrapped);
    };
  }
  return router;
}

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
  let mentions: MentionRef[];
  try {
    mentions = msg.mentions ? JSON.parse(msg.mentions) : [];
  } catch {
    mentions = [];
  }
  let metadata: Record<string, unknown> | null = null;
  if (msg.metadata) {
    try { metadata = JSON.parse(msg.metadata); } catch { /* keep null */ }
  }
  const { mentions: _m, mention_all: _ma, metadata: _md, ...rest } = msg;
  return { ...rest, parts: parsed, mentions, mention_all: !!msg.mention_all, metadata };
}

interface ReplyToMessage {
  id: string;
  sender_id: string | null;
  sender_name: string;
  content: string;
  created_at: number;
}

/** Build a reply_to_message context for a ThreadMessage (1 level). */
export async function buildReplyContext(db: any, msg: ThreadMessage): Promise<ReplyToMessage | null> {
  if (!msg.reply_to_id) return null;
  const parent = await db.getThreadMessageById(msg.reply_to_id);
  if (!parent || parent.thread_id !== msg.thread_id) return null;
  const sender = parent.sender_id ? await db.getBotById(parent.sender_id) : undefined;
  return {
    id: parent.id,
    sender_id: parent.sender_id,
    sender_name: sender?.name || 'unknown',
    content: parent.content,
    created_at: parent.created_at,
  };
}

const MENTION_REGEX = /(?<![a-zA-Z0-9_-])@([a-zA-Z0-9_-]+)/g;
const MENTION_ALL_ALIASES = /(?<![a-zA-Z0-9_-])@(所有人)(?=[\s\p{P}]|$)/gu;
const MAX_MENTIONS = 20;

async function parseMentions(
  content: string,
  participants: Array<{ bot_id: string }>,
  getBotById: (id: string) => Promise<Bot | undefined>,
): Promise<{ mentions: MentionRef[] | null; mentionAll: boolean }> {
  const seen = new Set<string>();
  const mentions: MentionRef[] = [];
  let mentionAll = false;

  const participantBots = (await Promise.all(participants.map(p => getBotById(p.bot_id))))
    .filter((b): b is Bot => !!b);

  // Check for @所有人 (CJK mention-all alias)
  MENTION_ALL_ALIASES.lastIndex = 0;
  if (MENTION_ALL_ALIASES.test(content)) {
    mentionAll = true;
  }

  let match;
  MENTION_REGEX.lastIndex = 0;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    const name = match[1];
    const key = name.toLowerCase();

    if (key === 'all') {
      mentionAll = true;
      continue;
    }

    if (seen.has(key)) continue;
    seen.add(key);

    const bot = participantBots.find(b => b.name.toLowerCase() === key);
    if (bot) {
      mentions.push({ bot_id: bot.id, name: bot.name });
    }

    if (mentions.length >= MAX_MENTIONS) break;
  }

  return {
    mentions: mentions.length > 0 ? mentions : null,
    mentionAll,
  };
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

export function createRouter(db: HubDB, ws: HubWS, config: HubConfig, sessionStore: SessionStore): Router {
  const router = wrapAsyncRouter(Router());

  // ─── Public: Setup ────────────────────────────────────────

  // Admin check: session cookie (super_admin) or dev mode (no secret configured)
  function requireAdmin(req: import('express').Request, res: import('express').Response): boolean {
    if (req.session?.role === 'super_admin') return true;
    if (!config.admin_secret) return true; // No secret = open (dev mode only)
    res.status(401).json({ error: 'Admin authentication required. Use POST /api/auth/login with type=super_admin', code: 'AUTH_REQUIRED' });
    return false;
  }

  function requireOrgOrBot(req: import('express').Request, res: import('express').Response): string | undefined {
    if (req.session?.org_id) return req.session.org_id;
    if (req.bot) return req.bot.org_id;
    res.status(403).json({ error: 'Authentication required', code: 'FORBIDDEN' });
    return undefined;
  }

  // Org admin check: session (org_admin/super_admin) or admin bot Bearer token
  function requireOrgAdmin(req: import('express').Request, res: import('express').Response): boolean {
    if (req.session?.role === 'org_admin' || req.session?.role === 'super_admin') return true;
    if (req.bot?.auth_role === 'admin') return true;
    res.status(403).json({ error: 'Organization admin authentication required', code: 'FORBIDDEN' });
    return false;
  }

  async function checkMessageRateLimit(req: import('express').Request, res: import('express').Response): Promise<boolean> {
    if (!req.bot) return true; // org-level requests don't have per-bot rate limits
    const result = await db.checkAndRecordRateLimit(req.bot.org_id, req.bot.id, 'message');
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

  async function checkThreadRateLimit(req: import('express').Request, res: import('express').Response): Promise<boolean> {
    if (!req.bot) return true;
    const result = await db.checkAndRecordRateLimit(req.bot.org_id, req.bot.id, 'thread');
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

  async function resolveBot(orgId: string, idOrName: unknown): Promise<Bot | undefined> {
    if (typeof idOrName !== 'string') return undefined;
    // Check ID first, but only accept if it belongs to this org
    const byId = await db.getBotById(idOrName);
    if (byId && byId.org_id === orgId) return byId;
    // Fall back to name lookup within the org
    const byName = await db.getBotByName(orgId, idOrName);
    if (byName) return byName;
    return undefined;
  }

  async function requireThreadParticipant(
    req: import('express').Request,
    res: import('express').Response,
    threadId: string,
    opts?: { rejectTerminal?: boolean },
  ): Promise<Thread | undefined> {
    const thread = await db.getThread(threadId);
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

    if (!req.bot || !await db.isParticipant(thread.id, req.bot.id)) {
      res.status(403).json({ error: 'Not a participant of this thread', code: 'JOIN_REQUIRED', hint: `Call POST /api/threads/${thread.id}/join to join this thread first` });
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
   * GET /api/stats — Public platform statistics
   * Returns aggregate counts (no sensitive data). Cached for 60s.
   */
  let statsCache: { data: unknown; expires: number } | null = null;
  router.get('/api/stats', async (_req, res) => {
    try {
      const now = Date.now();
      if (statsCache && statsCache.expires > now) {
        return res.json(statsCache.data);
      }
      const stats = await db.getPlatformStats();
      statsCache = { data: stats, expires: now + 60_000 };
      res.json(stats);
    } catch (err) {
      routeLogger.error({ err }, 'stats.error');
      res.status(500).json({ error: 'Internal server error' });
    }
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
  router.post('/api/orgs', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, persist_messages } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return;
    }
    const org = await db.createOrg(name, persist_messages ?? config.default_persist);
    // Return full org including org_secret for super admin
    res.json(org);
  });

  /**
   * GET /api/orgs — List all orgs
   * Auth: Admin secret (if HXA_CONNECT_ADMIN_SECRET is set)
   */
  router.get('/api/orgs', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const allOrgs = await db.listOrgs();
    const orgs = [];
    for (const { org_secret, ...safe } of allOrgs) {
      const bots = await db.listBots(safe.id);
      orgs.push({ ...safe, bot_count: bots.length });
    }
    res.json(orgs);
  });

  /**
   * PATCH /api/orgs/:org_id — Update org name or status
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Body: { name?: string, status?: 'active' | 'suspended' }
   */
  router.patch('/api/orgs/:org_id', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const org = await db.getOrgById(req.params.org_id);
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
      await db.updateOrgStatus(org.id, status);

      if (status === 'suspended') {
        // Invalidate all outstanding org tickets
        await db.invalidateOrgTickets(org.id);
        // Disconnect all WS clients
        ws.disconnectOrg(org.id, 4100, 'Organization suspended');
      }
    }

    if (name !== undefined) {
      await db.updateOrgName(org.id, name);
    }

    // Re-fetch to return current state
    const updated = (await db.getOrgById(org.id))!;
    res.json({ id: updated.id, name: updated.name, status: updated.status });
  });

  /**
   * DELETE /api/orgs/:org_id — Destroy an org (irreversible)
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Response: 204 No Content
   */
  router.delete('/api/orgs/:org_id', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const org = await db.getOrgById(req.params.org_id);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // Disconnect all WS clients before deletion
    ws.disconnectOrg(org.id, 4101, 'Organization destroyed');

    // Destroy org (sets status, then deletes — CASCADE handles related data)
    await db.destroyOrg(org.id);

    res.status(204).end();
  });

  /**
   * POST /api/orgs/:org_id/rotate-secret — Rotate org secret (super admin)
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Returns: { org_secret }
   */
  router.post('/api/orgs/:org_id/rotate-secret', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const org = await db.getOrgById(req.params.org_id);
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
    await db.rotateOrgSecret(org.id, newSecretHash);
    await db.invalidateOrgTickets(org.id);

    // Revoke existing org_admin sessions and disconnect WS clients
    await sessionStore.deleteByRole('org_admin', org.id);
    ws.disconnectByRole('org_admin', org.id);

    res.json({ org_secret: newSecret });
  });

  // ─── Platform Invite Codes (Self-Service Org Creation) ────

  /**
   * POST /api/platform/invite-codes — Create a reusable invite code
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   * Body: { label?, max_uses?, expires_in? }
   * Returns: { id, code, label, max_uses, use_count, expires_at, created_at }
   */
  router.post('/api/platform/invite-codes', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { label, max_uses, expires_in } = req.body;

    // Validate max_uses
    if (max_uses !== undefined && (typeof max_uses !== 'number' || max_uses < 0 || !Number.isInteger(max_uses))) {
      res.status(400).json({ error: 'max_uses must be a non-negative integer', code: 'VALIDATION_ERROR' });
      return;
    }

    // Validate expires_in (seconds, default 90 days; 0 = never expires)
    const expiresAt = (typeof expires_in === 'number' && expires_in === 0)
      ? 0
      : Date.now() + ((typeof expires_in === 'number' && expires_in > 0 ? expires_in : 90 * 86400) * 1000);

    // Validate label
    if (label !== undefined && (typeof label !== 'string' || label.length > 256)) {
      res.status(400).json({ error: 'label must be a string up to 256 characters', code: 'VALIDATION_ERROR' });
      return;
    }

    // Generate a plaintext invite code (hxa_ prefix + 16 hex chars)
    const plaintextCode = `hxa_${crypto.randomBytes(8).toString('hex')}`;
    const codeHash = HubDB.hashToken(plaintextCode);

    const inviteCode = await db.createInviteCode(codeHash, plaintextCode, {
      label: label ?? undefined,
      maxUses: max_uses ?? 0,
      expiresAt,
    });

    // Return with plaintext code (shown only once)
    res.status(201).json({
      id: inviteCode.id,
      code: plaintextCode,
      label: inviteCode.label,
      max_uses: inviteCode.max_uses,
      use_count: inviteCode.use_count,
      expires_at: inviteCode.expires_at,
      created_at: inviteCode.created_at,
    });
  });

  /**
   * GET /api/platform/invite-codes — List all invite codes
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   */
  router.get('/api/platform/invite-codes', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const codes = (await db.listInviteCodes()).map(c => ({
      id: c.id,
      code: c.code,
      label: c.label,
      max_uses: c.max_uses,
      use_count: c.use_count,
      expires_at: c.expires_at,
      created_at: c.created_at,
      expired: c.expires_at !== 0 && c.expires_at <= Date.now(),
      exhausted: c.max_uses > 0 && c.use_count >= c.max_uses,
    }));

    res.json(codes);
  });

  /**
   * DELETE /api/platform/invite-codes/:id — Revoke an invite code
   * Auth: Super admin (HXA_CONNECT_ADMIN_SECRET)
   */
  router.delete('/api/platform/invite-codes/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const deleted = await db.deleteInviteCode(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Invite code not found', code: 'NOT_FOUND' });
      return;
    }

    res.status(204).end();
  });

  /**
   * POST /api/platform/orgs — Create an org using an invite code (self-service)
   * No auth required — the invite code IS the authorization.
   * Body: { invite_code, name }
   * Returns: { org_id, name, org_secret }
   */
  router.post('/api/platform/orgs', async (req, res) => {
    const { invite_code, name } = req.body;

    if (!invite_code || typeof invite_code !== 'string') {
      res.status(400).json({ error: 'invite_code is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (name.length > 128) {
      res.status(400).json({ error: 'name must be 128 characters or fewer', code: 'VALIDATION_ERROR' });
      return;
    }

    const codeHash = HubDB.hashToken(invite_code);
    const result = await db.createOrgWithInviteCode(codeHash, name, config.default_persist);
    if ('error' in result) {
      res.status(401).json({ error: result.error, code: 'INVALID_INVITE_CODE' });
      return;
    }

    res.status(201).json({
      org_id: result.org.id,
      name: result.org.name,
      org_secret: result.org.org_secret,
    });
  });

  // ─── Reserved Names ────────────────────────────────────────

  const RESERVED_BOT_NAMES = new Set(['all', '所有人']);

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

    if (RESERVED_BOT_NAMES.has(name.toLowerCase())) {
      res.status(400).json({ error: 'This name is reserved', code: 'RESERVED_NAME' });
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

  // ─── Public: Bot Onboarding Guide ───────────────────────

  /**
   * GET /skill.md — Bot onboarding guide (public, no auth)
   * Returns text/markdown with the server URL dynamically interpolated.
   */
  router.get('/skill.md', (req, res) => {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const host = process.env.DOMAIN || req.get('x-forwarded-host') || req.get('host');
    const basePath = process.env.BASE_PATH || '';
    const serverUrl = `${proto}://${host}${basePath}`;

    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(generateSkillMd(serverUrl));
  });

  // ─── Public Auth Routes ─────────────────────────────────

  const isDev = process.env.DEV_MODE === 'true';

  /**
   * POST /api/auth/login — Unified session login (ADR-002)
   * Body: { type: 'bot', token, owner_name }
   *     | { type: 'org_admin', org_id, org_secret }
   *     | { type: 'super_admin', admin_secret }
   * Returns: { session: { role, org_id?, bot_id?, expires_at } }
   * Sets HttpOnly session cookie.
   */
  router.post('/api/auth/login', async (req, res) => {
    const { type } = req.body;

    if (!type || !['bot', 'org_admin', 'super_admin'].includes(type)) {
      res.status(400).json({ error: 'Invalid login type. Must be: bot, org_admin, or super_admin', code: 'VALIDATION_ERROR' });
      return;
    }

    const ip = req.ip || 'unknown';

    switch (type as string) {
      case 'bot': {
        const { token, owner_name } = req.body;
        if (!token || typeof token !== 'string') {
          res.status(400).json({ error: 'token is required', code: 'VALIDATION_ERROR' });
          return;
        }

        const identifier = token.slice(0, 8);
        const rateCheck = checkLoginRateLimit(ip, 'bot', identifier);
        if (!rateCheck.allowed) {
          res.status(429).set('Retry-After', String(rateCheck.retryAfter)).json({
            error: 'Too many failed login attempts', code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter,
          });
          return;
        }

        // Try primary bot token
        let bot = await db.getBotByToken(token);
        let scopes: TokenScope[] = ['full'];
        let isScopedToken = false;

        // Try scoped token if primary not found
        if (!bot) {
          const scopedToken = await db.getBotTokenByToken(token);
          if (scopedToken) {
            if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
              recordLoginFailure(ip, 'bot', identifier);
              res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
              return;
            }
            bot = await db.getBotById(scopedToken.bot_id);
            scopes = scopedToken.scopes;
            isScopedToken = true;
          }
        }

        if (!bot) {
          recordLoginFailure(ip, 'bot', identifier);
          res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
          return;
        }

        const org = await db.getOrgById(bot.org_id);
        if (!org || org.status !== 'active') {
          res.status(403).json({ error: `Organization is ${org?.status || 'not found'}`, code: 'ORG_INACTIVE' });
          return;
        }

        // Enforce concurrent session limit (5 per bot)
        await enforceSessionLimit(sessionStore, 'bot_owner', org.id, bot.id);

        const session = createSession('bot_owner', org.id, bot.id, owner_name || null, scopes, isScopedToken);
        await sessionStore.set(session);
        setSessionCookie(res, session);

        // Audit
        await db.recordAudit(org.id, bot.id, 'auth.login', 'session', session.id, {
          role: 'bot_owner', ip, user_agent: req.headers['user-agent'],
        });

        res.json({
          session: { role: session.role, org_id: session.org_id, bot_id: session.bot_id, expires_at: session.expires_at },
        });
        return;
      }

      case 'org_admin': {
        const { org_id, org_secret } = req.body;
        if (!org_id || typeof org_id !== 'string') {
          res.status(400).json({ error: 'org_id is required', code: 'VALIDATION_ERROR' });
          return;
        }
        if (!org_secret || typeof org_secret !== 'string') {
          res.status(400).json({ error: 'org_secret is required', code: 'VALIDATION_ERROR' });
          return;
        }

        const rateCheck = checkLoginRateLimit(ip, 'org_admin', org_id);
        if (!rateCheck.allowed) {
          res.status(429).set('Retry-After', String(rateCheck.retryAfter)).json({
            error: 'Too many failed login attempts', code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter,
          });
          return;
        }

        const org = await db.getOrgById(org_id);
        if (!org) {
          recordLoginFailure(ip, 'org_admin', org_id);
          res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
          return;
        }

        if (!await db.verifyOrgSecret(org.id, org_secret)) {
          recordLoginFailure(ip, 'org_admin', org_id);
          res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
          return;
        }

        if (org.status !== 'active') {
          res.status(403).json({ error: `Organization is ${org.status}`, code: 'ORG_INACTIVE' });
          return;
        }

        await enforceSessionLimit(sessionStore, 'org_admin', org.id);

        const session = createSession('org_admin', org.id, null, null, null, false);
        await sessionStore.set(session);
        setSessionCookie(res, session);

        await db.recordAudit(org.id, null, 'auth.login', 'session', session.id, {
          role: 'org_admin', ip, user_agent: req.headers['user-agent'],
        });

        res.json({
          session: { role: session.role, org_id: session.org_id, expires_at: session.expires_at },
        });
        return;
      }

      case 'super_admin': {
        const { admin_secret } = req.body;
        if (!admin_secret || typeof admin_secret !== 'string') {
          res.status(400).json({ error: 'admin_secret is required', code: 'VALIDATION_ERROR' });
          return;
        }

        const rateCheck = checkLoginRateLimit(ip, 'super_admin', '');
        if (!rateCheck.allowed) {
          res.status(429).set('Retry-After', String(rateCheck.retryAfter)).json({
            error: 'Too many failed login attempts', code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter,
          });
          return;
        }

        if (!config.admin_secret) {
          res.status(500).json({ error: 'Admin secret not configured', code: 'SERVER_ERROR' });
          return;
        }

        const expected = Buffer.from(config.admin_secret, 'utf8');
        const actual = Buffer.from(admin_secret, 'utf8');
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
          recordLoginFailure(ip, 'super_admin', '');
          res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
          return;
        }

        await enforceSessionLimit(sessionStore, 'super_admin');

        const session = createSession('super_admin', null, null, null, null, false);
        await sessionStore.set(session);
        setSessionCookie(res, session);

        // super_admin has no org_id — log to app log only (audit_log.org_id is FK)
        routeLogger.info({ sessionId: session.id, role: 'super_admin', ip }, 'auth.login');

        res.json({
          session: { role: session.role, expires_at: session.expires_at },
        });
        return;
      }
    }
  });

  /**
   * POST /api/auth/logout — Clear session
   */
  router.post('/api/auth/logout', async (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'No active session', code: 'AUTH_REQUIRED' });
      return;
    }

    const session = req.session;
    await sessionStore.delete(session.id);

    // Disconnect any active WS connections for this session
    ws.disconnectBySessionId(session.id);

    // Clear cookie
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: !isDev, path: '/' });

    // Audit (only for roles with org_id)
    if (session.org_id) {
      await db.recordAudit(session.org_id, session.bot_id, 'auth.logout', 'session', session.id, {
        role: session.role, ip: req.ip,
      });
    } else {
      routeLogger.info({ sessionId: session.id, role: session.role, ip: req.ip }, 'auth.logout');
    }

    res.json({ ok: true });
  });

  /**
   * GET /api/auth/session — Current session info
   */
  router.get('/api/auth/session', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'No active session', code: 'AUTH_REQUIRED' });
      return;
    }
    const s = req.session;
    res.json({
      role: s.role,
      org_id: s.org_id,
      bot_id: s.bot_id,
      owner_name: s.owner_name,
      scopes: s.scopes,
      is_scoped_token: s.is_scoped_token,
      expires_at: s.expires_at,
      config: {
        max_file_size_mb: config.max_file_size_mb,
      },
    });
  });

  // Session helper functions
  function createSession(
    role: SessionRole, orgId: string | null, botId: string | null,
    ownerName: string | null, scopes: TokenScope[] | null, isScopedToken: boolean,
  ) {
    const now = Date.now();
    return {
      id: generateSessionId(),
      role,
      org_id: orgId,
      bot_id: botId,
      owner_name: ownerName,
      scopes,
      is_scoped_token: isScopedToken,
      created_at: now,
      expires_at: now + SESSION_TTL[role],
    };
  }

  function setSessionCookie(res: Response, session: { id: string; role: SessionRole; expires_at: number }) {
    const ttlMs = session.expires_at - Date.now();
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: !isDev,
      path: '/',
      maxAge: ttlMs,
    });
  }

  async function enforceSessionLimit(store: SessionStore, role: SessionRole, orgId?: string, botId?: string) {
    const limit = SESSION_LIMIT[role];
    const count = await store.countByRole(role, orgId || undefined, botId || undefined);
    if (count >= limit) {
      // Evict oldest sessions over the limit
      // For simplicity, delete all sessions of this role/scope and the new one replaces them
      // A more refined approach would keep (limit - 1) newest, but this is simpler
      // and the limit is generous enough (3-5) that hitting it is rare
      if (botId) {
        await store.deleteByBotId(botId);
        ws.disconnectSessionClientsByBotId(botId);
      } else {
        await store.deleteByRole(role, orgId || undefined);
        ws.disconnectByRole(role, orgId);
      }
    }
  }

  /**
   * POST /api/auth/register — Register a bot using a ticket or org_secret (ADR-002)
   * Body: { org_id, ticket, name, ...profile }           → auth_role: 'member'
   *     | { org_id, org_secret, name, ...profile }        → auth_role: 'admin'
   * Returns: { bot_id, token, name, auth_role }
   */
  router.post('/api/auth/register', async (req, res) => {
    const { org_id, ticket: ticketId, org_secret } = req.body;

    // Validate required fields
    if (!org_id || typeof org_id !== 'string') {
      res.status(400).json({ error: 'org_id is required', code: 'VALIDATION_ERROR' });
      return;
    }
    if (!ticketId && !org_secret) {
      res.status(400).json({ error: 'ticket or org_secret is required', code: 'VALIDATION_ERROR' });
      return;
    }

    // Validate registration body fields
    const validated = await validateRegistrationBody(req.body, res);
    if (!validated) return; // response already sent

    let authRole: 'admin' | 'member' = 'member';

    if (org_secret && typeof org_secret === 'string') {
      // org_secret path — register as admin
      const org = await db.getOrgById(org_id);
      if (!org) {
        res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      if (!await db.verifyOrgSecret(org.id, org_secret)) {
        res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      if (org.status !== 'active') {
        const code = org.status === 'suspended' ? 'ORG_SUSPENDED' : 'ORG_DESTROYED';
        res.status(403).json({ error: `Organization is ${org.status}`, code });
        return;
      }
      authRole = 'admin';
    } else {
      // ticket path — register as member
      if (!ticketId || typeof ticketId !== 'string') {
        res.status(400).json({ error: 'ticket is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Quick pre-checks (non-atomic) for immediate, user-friendly error messages
      const ticket = await db.getOrgTicket(ticketId);
      if (!ticket) {
        res.status(401).json({ error: 'Invalid ticket', code: 'INVALID_TICKET' });
        return;
      }
      if (ticket.org_id !== org_id) {
        res.status(401).json({ error: 'Invalid ticket', code: 'INVALID_TICKET' });
        return;
      }
      // Check not expired (0 = never expires)
      if (ticket.expires_at !== 0 && ticket.expires_at <= Date.now()) {
        res.status(401).json({ error: 'Ticket expired', code: 'TICKET_EXPIRED' });
        return;
      }
      if (!ticket.reusable && ticket.consumed) {
        res.status(401).json({ error: 'Ticket already consumed', code: 'TICKET_CONSUMED' });
        return;
      }

      // Check org status before entering transaction
      const org = await db.getOrgById(org_id);
      if (!org) {
        res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
        return;
      }
      if (org.status !== 'active') {
        const statusCode = org.status === 'suspended' ? 'ORG_SUSPENDED' : 'ORG_DESTROYED';
        res.status(403).json({ error: `Organization is ${org.status}`, code: statusCode });
        return;
      }

      // #178: Atomically consume ticket + insert bot to prevent TOCTOU race condition.
      // Guarantees: either (bot created + ticket consumed) or (nothing changed).
      const atomicResult = await db.atomicRegisterBotWithTicket(
        org_id,
        ticketId,
        validated.name,
        authRole,
        validated.metadata,
        validated.webhook_url,
        validated.webhook_secret,
        validated.profile,
      );

      if ('conflict' in atomicResult) {
        if (atomicResult.conflict === 'NAME_TOMBSTONED') {
          res.status(409).json({
            error: 'Bot name is reserved. An org admin must release it via DELETE /api/orgs/:org_id/tombstones/:name.',
            code: 'NAME_TOMBSTONED',
          });
          return;
        }
        if (atomicResult.conflict === 'NAME_CONFLICT') {
          res.status(409).json({ error: 'A bot with this name already exists', code: 'NAME_CONFLICT' });
          return;
        }
        // Ticket was consumed concurrently between pre-check and transaction
        res.status(401).json({ error: 'Ticket already consumed', code: 'TICKET_CONSUMED' });
        return;
      }

      // Ticket path success — audit + respond
      const { bot: ticketBot, plaintextToken: ticketToken } = atomicResult;
      await db.recordAudit(org_id, ticketBot.id, 'bot.register', 'bot', ticketBot.id, {
        name: ticketBot.name, reregister: false, via: 'ticket', auth_role: authRole,
      });
      const ticketResponse: RegisterResponse = {
        bot_id: ticketBot.id,
        ...toBotResponse(ticketBot),
        token: ticketToken,
      };
      res.json(ticketResponse);
      return;
    }

    // org_secret path — register as admin bot
    const result = await db.registerBot(
      org_id,
      validated.name,
      validated.metadata,
      validated.webhook_url,
      validated.webhook_secret,
      validated.profile,
      authRole,
    );

    if ('conflict' in result) {
      if (result.conflict === 'NAME_TOMBSTONED') {
        res.status(409).json({
          error: 'Bot name is reserved. An org admin must release it via DELETE /api/orgs/:org_id/tombstones/:name.',
          code: 'NAME_TOMBSTONED',
        });
      } else {
        res.status(409).json({ error: 'A bot with this name already exists', code: 'NAME_CONFLICT' });
      }
      return;
    }

    const { bot, plaintextToken } = result;

    // Audit
    await db.recordAudit(org_id, bot.id, 'bot.register', 'bot', bot.id, {
      name: bot.name, reregister: false, via: 'org_secret', auth_role: authRole,
    });

    const response: RegisterResponse = {
      bot_id: bot.id,
      ...toBotResponse(bot),
      token: plaintextToken,
    };
    res.json(response);
  });

  // ─── Authenticated Routes ─────────────────────────────────

  const auth = wrapAsyncRouter(Router());
  auth.use(authMiddleware(db));

  /**
   * GET /api/org — Get current org info
   * Auth: Bot token or org ticket
   */
  auth.get('/api/org', async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;
    const org = await db.getOrgById(orgId);
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
  auth.get('/api/bots/:id', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;
    const bot = await db.getBotById(req.params.id as string);
    if (!bot || bot.org_id !== orgId) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }
    res.json(toBotResponse(bot));
  });

  /**
   * DELETE /api/bots/:id — Remove a bot (org admin only)
   * Auth: Org ticket or admin bot token
   * Security: Bot name is tombstoned on deletion to prevent identity hijack via
   *           delete + re-register (Issue #199 A1). Name can only be released by
   *           a human org admin via DELETE /api/orgs/:org_id/tombstones/:name.
   */
  auth.delete('/api/bots/:id', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const orgId = req.session?.org_id || req.bot?.org_id || req.org?.id;
    const bot = await db.getBotById(req.params.id as string);
    if (!bot || bot.org_id !== orgId) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    // #199 A1: Atomically tombstone the bot's name and delete the bot row in
    // a single transaction. This eliminates the race window entirely — there is
    // no point in time where the name is freed but the tombstone is not in place.
    const deletedBy = req.bot ? req.bot.id : 'session';
    await db.deleteBotWithTombstone(bot.id, bot.name, orgId!, deletedBy);
    await db.recordAudit(orgId!, bot.id, 'bot.delete', 'bot', bot.id, { name: bot.name, deleted_by: deletedBy });

    // Terminate the deleted bot's active WebSocket connection immediately.
    // Without this, the victim bot's connection stays open and can still receive messages.
    ws.disconnectByBotId(bot.id);

    // Broadcast bot offline to remaining org members
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
  auth.delete('/api/me', requireBot, requireScope('full'), async (req, res) => {
    const bot = req.bot!;

    // #199 A1: Atomically tombstone the bot's name and delete the bot row in
    // a single transaction (same reasoning as DELETE /api/bots/:id above).
    await db.deleteBotWithTombstone(bot.id, bot.name, bot.org_id, bot.id);

    // Terminate the self-deleting bot's active WebSocket connection immediately.
    // Without this, the connection stays open even though the token is now invalid.
    ws.disconnectByBotId(bot.id);

    // Audit
    await db.recordAudit(bot.org_id, bot.id, 'bot.delete', 'bot', bot.id, { name: bot.name, self: true });

    // Broadcast bot offline
    ws.broadcastToOrg(bot.org_id, {
      type: 'bot_offline',
      bot: { id: bot.id, name: bot.name },
    });

    res.json({ ok: true, message: `Bot "${bot.name}" deregistered` });
  });

  /**
   * DELETE /api/orgs/:org_id/tombstones/:name — Release a bot name tombstone
   * Auth: Human session (org_admin or super_admin) only — bot tokens are not accepted.
   * This allows org admins to re-enable a bot name after intentional deletion.
   */
  auth.delete('/api/orgs/:org_id/tombstones/:name', async (req, res) => {
    // Require human session (org_admin or super_admin) — bot tokens cannot release tombstones.
    if (!req.session || (req.session.role !== 'org_admin' && req.session.role !== 'super_admin')) {
      res.status(403).json({
        error: 'Human session required to release a bot name tombstone',
        code: 'HUMAN_SESSION_REQUIRED',
      });
      return;
    }

    const orgId = req.params.org_id as string;
    const name = req.params.name as string;

    // Verify the org exists
    const org = await db.getOrgById(orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // org_admin may only manage their own org
    if (req.session.role === 'org_admin' && req.session.org_id !== orgId) {
      res.status(403).json({ error: 'Cannot manage tombstones for a different organization', code: 'FORBIDDEN' });
      return;
    }

    const cleared = await db.clearBotNameTombstone(orgId, name);
    if (!cleared) {
      res.status(404).json({ error: 'No tombstone found for this bot name', code: 'NOT_FOUND' });
      return;
    }

    await db.recordAudit(orgId, null, 'bot.tombstone_cleared', 'bot', name, {
      cleared_by_session: req.session.id,
      cleared_by_role: req.session.role,
    });

    res.json({ ok: true, message: `Bot name "${name}" is now available for registration` });
  });

  /**
   * GET /api/me — Get current bot info
   */
  auth.get('/api/me', requireBot, requireScope('read'), async (req, res) => {
    const a = req.bot!;
    res.json(toBotResponse(a));
  });

  /**
   * GET /api/me/workspace — Aggregate endpoint for Web UI initial load.
   * Returns bot info + paginated DM list + paginated thread list.
   */
  auth.get('/api/me/workspace', requireBot, requireScope('read'), async (req, res) => {
    const bot = req.bot!;

    const dmLimit = Math.min(Math.max(parseInt(getQueryString(req.query.dm_limit) || '') || 20, 1), 100);
    const threadLimit = Math.min(Math.max(parseInt(getQueryString(req.query.thread_limit) || '') || 20, 1), 100);
    const dmCursor = getQueryString(req.query.dm_cursor);
    const threadCursor = getQueryString(req.query.thread_cursor);

    const [dmRows, threadRows] = await Promise.all([
      db.getWorkspaceDMs(bot.id, dmCursor, dmLimit),
      db.listThreadsForBotPaginated(bot.id, { cursor: threadCursor, limit: threadLimit }),
    ]);

    const dmHasMore = dmRows.length > dmLimit;
    const dmItems = dmHasMore ? dmRows.slice(0, dmLimit) : dmRows;
    const threadHasMore = threadRows.length > threadLimit;
    const threadItems = threadHasMore ? threadRows.slice(0, threadLimit) : threadRows;

    const response: Record<string, unknown> = {
      bot: toBotResponse(bot),
      dms: {
        items: dmItems,
        has_more: dmHasMore,
        ...(dmHasMore && dmItems.length > 0 ? {
          next_cursor: encodeCursor(dmItems[dmItems.length - 1].last_activity_at, dmItems[dmItems.length - 1].channel.id),
        } : {}),
      },
      threads: {
        items: threadItems,
        has_more: threadHasMore,
        ...(threadHasMore && threadItems.length > 0 ? {
          next_cursor: encodeCursor(threadItems[threadItems.length - 1].last_activity_at, threadItems[threadItems.length - 1].id),
        } : {}),
      },
    };

    res.json(response);
  });

  /**
   * PATCH /api/me/profile — Update current bot profile fields
   */
  auth.patch('/api/me/profile', requireBot, requireScope('profile'), async (req, res) => {
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

    const updated = await db.updateProfile(req.bot!.id, fields);
    if (!updated) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    // Audit
    const changedFields = Object.keys(fields).filter(k => (fields as any)[k] !== undefined);
    await db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.profile_update', 'bot', req.bot!.id, { fields: changedFields });

    req.bot = updated;
    res.json(toBotResponse(updated));
  });

  /**
   * PATCH /api/me/name — Rename current bot
   */
  auth.patch('/api/me/name', requireBot, requireScope('profile'), async (req, res) => {
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric (a-z, 0-9, _, -)', code: 'VALIDATION_ERROR' });
      return;
    }

    if (RESERVED_BOT_NAMES.has(name.toLowerCase())) {
      res.status(400).json({ error: 'This name is reserved', code: 'RESERVED_NAME' });
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
    const result = await db.renameBot(req.bot!.id, name);

    if (result.conflict) {
      if (result.conflict === 'NAME_TOMBSTONED') {
        res.status(409).json({
          error: 'Bot name is reserved. An org admin must release it via DELETE /api/orgs/:org_id/tombstones/:name.',
          code: 'NAME_TOMBSTONED',
        });
      } else {
        res.status(409).json({ error: 'A bot with that name already exists in this org', code: 'NAME_CONFLICT' });
      }
      return;
    }

    // Audit
    await db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.rename', 'bot', req.bot!.id, { old_name, new_name: name });

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
  auth.get('/api/peers', requireBot, requireScope('read'), async (req, res) => {
    const bots = await db.listBots(req.bot!.org_id);
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
  auth.post('/api/me/tokens', requireBot, requireScope('full'), async (req, res) => {
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
    const token = await db.createBotToken(req.bot!.id, scopes as TokenScope[], label, expiresAt);

    await db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.token_create', 'token', token.id, {
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
  auth.get('/api/me/tokens', requireBot, requireScope('full'), async (req, res) => {
    const tokens = await db.listBotTokens(req.bot!.id);
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
  auth.delete('/api/me/tokens/:id', requireBot, requireScope('full'), async (req, res) => {
    const deleted = await db.revokeBotToken(req.params.id as string, req.bot!.id);
    if (!deleted) {
      res.status(404).json({ error: 'Token not found', code: 'NOT_FOUND' });
      return;
    }
    await db.recordAudit(req.bot!.org_id, req.bot!.id, 'bot.token_revoke', 'token', req.params.id as string);
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
  auth.get('/api/bots', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    // Session caller (org_admin/super_admin): paginated behavior
    if (req.session?.role === 'org_admin' || req.session?.role === 'super_admin') {
      const cursor = getQueryString(req.query.cursor);
      const limitParam = getQueryString(req.query.limit);
      const search = getQueryString(req.query.search)?.trim();

      // When no pagination params and no search, fall back to unpaginated behavior
      if (!cursor && !limitParam && !search) {
        const bots = await db.listBots(orgId);
        res.json(bots.map(a => toBotResponse(a)));
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
      const rows = await db.listBotsPaginated(orgId, cursor, limit, search);
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

    const bots = await db.listBots(orgId, { role, tag, status, q });
    res.json(bots.map(bot => toBotResponse(bot)));
  });

  /**
   * GET /api/bots/:name/webhook/health — Check webhook health for a bot
   * Auth: bot token or org API key
   * Org-scoped: only check bots in the same org
   */
  auth.get('/api/bots/:name/webhook/health', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const bot = await db.getBotByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    const health = await db.getWebhookHealth(bot.id);
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
  auth.get('/api/bots/:name/profile', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const bot = await db.getBotByName(orgId, req.params.name as string);
    if (!bot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    res.json(toBotResponse(bot));
  });

  // ─── Channels ─────────────────────────────────────────────

  /**
   * GET /api/channels/:id — Get channel details
   */
  auth.get('/api/channels/:id', requireScope('read'), async (req, res) => {
    const channel = await db.getChannel(req.params.id as string);
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
    if (req.bot && !(await db.isChannelMember(channel.id, req.bot.id))) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }
    if (req.session?.org_id && channel.org_id !== req.session.org_id) {
      res.status(403).json({ error: 'Channel not in your org', code: 'FORBIDDEN' });
      return;
    }

    const members = await Promise.all((await db.getChannelMembers(channel.id)).map(async (m) => {
      const bot = await db.getBotById(m.bot_id);
      return {
        id: m.bot_id,
        name: bot?.name,
        online: bot?.online,
      };
    }));

    res.json({ ...channel, members });
  });

  /**
   * GET /api/bots/:id/channels — List channels a bot participates in
   * Auth: Bot token (same org) or session/admin bot
   * Returns: [{ id, type, name, created_at, last_activity_at, members }]
   */
  auth.get('/api/bots/:id/channels', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const targetBot = await resolveBot(orgId, req.params.id);
    if (!targetBot) {
      res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
      return;
    }

    // Cross-org isolation
    if (targetBot.org_id !== orgId) {
      res.status(403).json({ error: 'Bot not in your org', code: 'FORBIDDEN' });
      return;
    }

    // Bots can only query their own channels; org ticket can query any bot
    if (req.bot && req.bot.id !== targetBot.id) {
      res.status(403).json({ error: 'Bots can only query their own channels', code: 'FORBIDDEN' });
      return;
    }

    res.json(await db.getChannelsForBot(targetBot.id));
  });

  // ─── Org Admin Thread Endpoints ──────────────────────────

  /**
   * GET /api/org/threads — List all threads in the org
   * Query: status?, cursor? (thread id), limit? (default 50, max 200), offset? (legacy)
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

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

    // Helper: enrich threads with participants
    async function enrichWithParticipants(threads: Array<Thread & { participant_count: number }>) {
      return Promise.all(threads.map(async (t) => {
        const parts = await db.getParticipants(t.id);
        const participants = await Promise.all(parts.map(async (p) => {
          const bot = await db.getBotById(p.bot_id);
          return { bot_id: p.bot_id, name: bot?.name, online: bot?.online, label: p.label, joined_at: p.joined_at };
        }));
        return { ...t, participants };
      }));
    }

    // When cursor is present, or search/limit specified, use paginated behavior
    if (cursor || search || (limitParam && !offsetParam)) {
      const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
      const rows = await db.listThreadsForOrgPaginated(orgId, status, cursor, limit, search);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const enriched = await enrichWithParticipants(items);
      const response: Record<string, unknown> = {
        items: enriched,
        has_more: hasMore,
      };
      if (hasMore) {
        const last = items[items.length - 1];
        response.next_cursor = `${last.last_activity_at}|${last.id}`;
      }
      res.json(response);
      return;
    }

    // Legacy offset-based behavior
    const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam || '') || 0, 0);
    const threads = await db.listThreadsForOrg(orgId, status, limit, offset);
    res.json(await enrichWithParticipants(threads));
  });

  /**
   * GET /api/org/threads/:id — Thread detail with participants
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads/:id', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

    const thread = await db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== orgId) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const participants = await Promise.all((await db.getParticipants(thread.id)).map(async (p) => {
      const bot = await db.getBotById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
        online: bot?.online,
        label: p.label,
        joined_at: p.joined_at,
      };
    }));

    res.setHeader('ETag', `"${thread.revision}"`);
    res.json({ ...thread, participant_count: participants.length, participants });
  });

  /**
   * GET /api/org/threads/:id/messages — Thread messages (enriched with parts)
   * Query: limit?, before? (message id for pagination, or timestamp for legacy), since?
   * When before is a message id (not numeric), uses cursor-based pagination and returns
   * { messages: [...], has_more: boolean } with messages sorted newest first.
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads/:id/messages', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

    const thread = await db.getThread(req.params.id as string);
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
      const rows = await db.getThreadMessagesPaginated(thread.id, isBeforeId ? beforeStr : undefined, limit);
      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;

      const enriched = await Promise.all(messages.map(async (m) => {
        const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
        const reply_to_message = await buildReplyContext(db, m);
        return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown', ...(reply_to_message && { reply_to_message }) };
      }));

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

    const messages = await db.getThreadMessages(thread.id, limit, before, since);
    const enriched = await Promise.all(messages.map(async (m) => {
      const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
      const reply_to_message = await buildReplyContext(db, m);
      return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown', ...(reply_to_message && { reply_to_message }) };
    }));

    res.json(enriched.reverse());
  });

  /**
   * GET /api/org/threads/:id/artifacts — Thread artifacts
   * Query: cursor? (artifact key), limit? (default 50, max 200)
   * Auth: Org ticket or admin bot token
   */
  auth.get('/api/org/threads/:id/artifacts', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

    const thread = await db.getThread(req.params.id as string);
    if (!thread || thread.org_id !== orgId) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const cursor = getQueryString(req.query.cursor);
    const limitParam = getQueryString(req.query.limit);

    // When no pagination params, fall back to existing unpaginated behavior
    if (!cursor && !limitParam) {
      res.json(await db.listArtifacts(thread.id));
      return;
    }

    const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
    const rows = await db.listArtifactsPaginated(thread.id, cursor, limit);
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
  auth.patch('/api/org/threads/:id', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

    const thread = await db.getThread(req.params.id as string);
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
      const updated = await db.updateThreadStatus(thread.id, status, closeReason);
      if (!updated) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      // Broadcast status change (fire-and-forget — don't block HTTP response)
      const by = req.org ? `org:${orgId}` : req.bot!.name;
      void ws.broadcastThreadEvent(orgId, thread.id, {
        type: 'thread_status_changed',
        thread_id: thread.id,
        topic: updated.topic,
        from: thread.status,
        to: updated.status,
        by,
      }).catch(err => routeLogger.error({ err }, 'broadcast thread_status_changed failed'));

      // Catchup events for offline bots
      const participants = await db.getParticipants(thread.id);
      for (const p of participants) {
        await db.recordCatchupEvent(orgId, p.bot_id, 'thread_status_changed', {
          thread_id: thread.id,
          topic: updated.topic,
          from: thread.status,
          to: updated.status,
          by,
        });
      }

      // Audit
      const actorId = req.bot?.id || `org:${orgId}`;
      await db.recordAudit(orgId, actorId, 'thread.status_changed', 'thread', thread.id, {
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
  auth.post('/api/threads', requireBot, requireScope('thread'), async (req, res) => {
    if (!(await checkThreadRateLimit(req, res))) return;

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
      const bot = await resolveBot(orgId, p);
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

      const channel = await db.getChannel(channel_id);
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
      const thread = await db.createThread(
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
      await db.recordAudit(orgId, req.bot!.id, 'thread.create', 'thread', thread.id, { topic, tags: resolvedTags });

      // Record catchup events: thread_invited for each participant (except initiator)
      const allParticipantIds = Array.from(new Set([req.bot!.id, ...resolvedParticipantIds]));
      for (const pid of allParticipantIds) {
        if (pid === req.bot!.id) continue;
        await db.recordCatchupEvent(orgId, pid, 'thread_invited', {
          thread_id: thread.id,
          topic: thread.topic,
          inviter: req.bot!.id,
        });
      }

      void ws.broadcastThreadEvent(orgId, thread.id, {
        type: 'thread_created',
        thread,
      }).catch(err => routeLogger.error({ err }, 'broadcast thread_created failed'));

      // Emit individual join events for all participants (including initiator)
      for (const pid of allParticipantIds) {
        const bot = await db.getBotById(pid);
        if (!bot) continue;
        void ws.broadcastThreadEvent(orgId, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: pid,
          bot_name: bot.name,
          action: 'joined',
          by: req.bot!.id,
        }).catch(err => routeLogger.error({ err }, 'broadcast thread_participant failed'));
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
  auth.get('/api/threads', requireBot, requireScope('read'), async (req, res) => {
    const statusRaw = getQueryString(req.query.status);
    if (statusRaw && !THREAD_STATUSES.has(statusRaw as ThreadStatus)) {
      res.status(400).json({ error: 'Invalid status filter' });
      return;
    }

    const status = statusRaw as ThreadStatus | undefined;
    const cursor = getQueryString(req.query.cursor);
    const limitParam = getQueryString(req.query.limit);
    const search = getQueryString(req.query.q)?.trim();

    // When cursor, search, or limit specified → paginated response
    if (cursor || search || limitParam) {
      const limit = Math.min(Math.max(parseInt(limitParam || '') || 50, 1), 200);
      const rows = await db.listThreadsForBotPaginated(req.bot!.id, { status, cursor, limit, search });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const response: Record<string, unknown> = {
        items,
        has_more: hasMore,
      };
      if (hasMore && items.length > 0) {
        response.next_cursor = encodeCursor(items[items.length - 1].last_activity_at, items[items.length - 1].id);
      }
      res.json(response);
      return;
    }

    // Legacy: no pagination params → return flat array
    const threads = await db.listThreadsForBot(req.bot!.id, status);
    res.json(threads);
  });

  /**
   * GET /api/threads/:id — Thread details with participants
   */
  auth.get('/api/threads/:id', requireBot, requireScope('read'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const participants = await Promise.all((await db.getParticipants(thread.id)).map(async (p) => {
      const bot = await db.getBotById(p.bot_id);
      return {
        bot_id: p.bot_id,
        name: bot?.name,
        online: bot?.online,
        label: p.label,
        joined_at: p.joined_at,
      };
    }));

    res.setHeader('ETag', `"${thread.revision}"`);
    res.json({ ...thread, participant_count: participants.length, participants });
  });

  /**
   * PATCH /api/threads/:id — Update thread status/context/topic
   * Body: { status?, close_reason?, context?, topic? }
   */
  auth.patch('/api/threads/:id', requireBot, requireScope('thread'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string);
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

    // Only the thread initiator or a participating admin bot can change permission_policy
    if (permPolicyInput !== undefined && thread.initiator_id !== req.bot!.id && req.bot!.auth_role !== 'admin') {
      res.status(403).json({ error: 'Only the thread initiator or a participating admin bot can change permission_policy', code: 'FORBIDDEN' });
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

    // Block non-status mutations on terminal threads (status change = reopen is allowed)
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
      if (policyAction && !(await db.checkThreadPermission(thread, req.bot!.id, policyAction))) {
        await db.recordAudit(thread.org_id, req.bot!.id, 'thread.permission_denied', 'thread', thread.id, {
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
        updated = await db.updateThreadStatus(thread.id, status, closeReason, revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
          return;
        }
        changes.push('status');
        if (status === 'closed') changes.push('close_reason');
        if (status === 'resolved') changes.push('resolved_at');

        // Audit
        await db.recordAudit(thread.org_id, req.bot!.id, 'thread.status_changed', 'thread', thread.id, {
          from: previousStatus,
          to: status,
          close_reason: closeReason ?? null,
        });

        // Record catchup event for all participants
        const participants = await db.getParticipants(thread.id);
        for (const p of participants) {
          await db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_status_changed', {
            thread_id: thread.id,
            topic: thread.topic,
            from: previousStatus,
            to: status,
            by: req.bot!.id,
          });
        }
      }

      if (context !== undefined) {
        updated = await db.updateThreadContext(thread.id, contextJson ?? null, revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
          return;
        }
        changes.push('context');
      }

      if (topic !== undefined) {
        updated = await db.updateThreadTopic(thread.id, topic.trim(), revCheck);
        revCheck = undefined; // consumed
        if (!updated) {
          res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
          return;
        }
        changes.push('topic');
      }

      if (permPolicyJson !== undefined) {
        updated = await db.updateThreadPermissionPolicy(thread.id, permPolicyJson, revCheck);
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

    void ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_updated',
      thread: updated!,
      changes,
    }).catch(err => routeLogger.error({ err }, 'broadcast thread_updated failed'));

    res.setHeader('ETag', `"${updated!.revision}"`);
    res.json(updated);
  });

  /**
   * POST /api/threads/:id/join — Self-join a thread (same org)
   * No body required. Any bot in the same org can join.
   */
  auth.post('/api/threads/:id/join', requireBot, requireScope('thread'), async (req, res) => {
    const threadId = req.params.id as string;
    const thread = await db.getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    // Cross-org isolation
    if (thread.org_id !== req.bot!.org_id) {
      res.status(403).json({ error: 'Thread not in your org', code: 'FORBIDDEN' });
      return;
    }

    // Cannot join terminal threads
    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: `Thread is ${thread.status}; cannot join`, code: 'THREAD_CLOSED' });
      return;
    }

    // Already a participant — idempotent success
    if (await db.isParticipant(thread.id, req.bot!.id)) {
      res.json({ status: 'already_joined' });
      return;
    }

    try {
      const participant = await db.addParticipant(thread.id, req.bot!.id);

      // Broadcast join event (fire-and-forget)
      void ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_participant',
        thread_id: thread.id,
        bot_id: req.bot!.id,
        bot_name: req.bot!.name,
        action: 'joined',
        by: req.bot!.id,
      }).catch(err => routeLogger.error({ err }, 'broadcast thread_participant failed'));

      await db.recordAudit(thread.org_id, req.bot!.id, 'thread.join', 'thread', thread.id);

      res.json({ status: 'joined', joined_at: participant.joined_at });
    } catch (error: any) {
      res.status(409).json({ error: error.message || 'Failed to join thread', code: 'JOIN_FAILED' });
    }
  });

  /**
   * POST /api/threads/:id/participants — Invite bot (id or name)
   * Body: { bot_id, label? }
   */
  auth.post('/api/threads/:id/participants', requireBot, requireScope('thread'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    // Permission policy check for invite
    if (!(await db.checkThreadPermission(thread, req.bot!.id, 'invite'))) {
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

    const bot = await resolveBot(thread.org_id, bot_id);
    if (!bot) {
      res.status(404).json({ error: `Bot not found: ${bot_id}` });
      return;
    }

    const alreadyParticipant = await db.isParticipant(thread.id, bot.id);

    // Prevent label relabeling via invite — only new participants can have labels set.
    // Relabeling existing participants would bypass label-based permission policies.
    if (alreadyParticipant && label !== undefined) {
      res.status(409).json({ error: 'Participant already exists; cannot change label via invite' });
      return;
    }

    try {
      const participant = await db.addParticipant(thread.id, bot.id, label);

      if (!alreadyParticipant) {
        // Audit
        await db.recordAudit(thread.org_id, req.bot!.id, 'thread.invite', 'thread', thread.id, {
          invited_bot_id: bot.id,
          invited_bot_name: bot.name,
        });

        // Record catchup event for the invited bot
        await db.recordCatchupEvent(thread.org_id, bot.id, 'thread_invited', {
          thread_id: thread.id,
          topic: thread.topic,
          inviter: req.bot!.id,
        });

        void ws.broadcastThreadEvent(thread.org_id, thread.id, {
          type: 'thread_participant',
          thread_id: thread.id,
          bot_id: bot.id,
          bot_name: bot.name,
          action: 'joined',
          by: req.bot!.id,
          label: participant.label,
        }).catch(err => routeLogger.error({ err }, 'broadcast thread_participant failed'));
      }

      res.json(participant);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to add participant' });
    }
  });

  /**
   * DELETE /api/threads/:id/participants/:bot — Leave/remove participant (id or name)
   */
  auth.delete('/api/threads/:id/participants/:bot', requireBot, requireScope('thread'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    const target = await resolveBot(thread.org_id, req.params.bot as string);
    if (!target) {
      res.status(404).json({ error: `Bot not found: ${req.params.bot}` });
      return;
    }

    // Permission policy check for remove (skip if leaving self)
    if (target.id !== req.bot!.id && !(await db.checkThreadPermission(thread, req.bot!.id, 'remove'))) {
      res.status(403).json({ error: 'Permission denied: your label does not allow removing participants', code: 'FORBIDDEN' });
      return;
    }

    if (!(await db.isParticipant(thread.id, target.id))) {
      res.status(404).json({ error: 'Bot is not a participant in this thread', code: 'NOT_FOUND' });
      return;
    }

    const participants = await db.getParticipants(thread.id);
    if (participants.length <= 1) {
      res.status(400).json({ error: 'Cannot remove the last participant from a thread' });
      return;
    }

    // Broadcast leave event BEFORE removing participant, so the removed bot
    // is still in the recipient list and receives the notification.
    // NOTE: This broadcast must complete before removeParticipant is called,
    // so we intentionally await it here (unlike other fire-and-forget broadcasts).
    await ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_participant',
      thread_id: thread.id,
      bot_id: target.id,
      bot_name: target.name,
      action: 'left',
      by: req.bot!.id,
    });

    // Record catchup event so the removed bot sees it even if offline
    await db.recordCatchupEvent(thread.org_id, target.id, 'thread_participant_removed', {
      thread_id: thread.id,
      topic: thread.topic,
      removed_by: req.bot!.id,
    });

    await db.removeParticipant(thread.id, target.id);

    // Audit
    await db.recordAudit(thread.org_id, req.bot!.id, 'thread.remove_participant', 'thread', thread.id, {
      removed_bot_id: target.id,
      removed_bot_name: target.name,
    });

    res.json({ ok: true });
  });

  /**
   * POST /api/threads/:id/messages — Send a thread message
   * Body: { content, content_type?, metadata? }
   */
  auth.post('/api/threads/:id/messages', requireBot, requireScope('thread'), async (req, res) => {
    if (!(await checkMessageRateLimit(req, res))) return;

    const thread = await requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
    if (!thread) return;

    const { content, content_type, metadata, parts, reply_to } = req.body;

    // Validate reply_to if provided
    if (reply_to !== undefined && reply_to !== null) {
      if (typeof reply_to !== 'string') {
        res.status(400).json({ error: 'reply_to must be a string (message ID)' });
        return;
      }
      const parentMsg = await db.getThreadMessageById(reply_to);
      if (!parentMsg || parentMsg.thread_id !== thread.id) {
        res.status(400).json({ error: 'reply_to message not found in this thread', code: 'NOT_FOUND' });
        return;
      }
    }

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

    // Inject human provenance for bot_owner session requests (Web UI)
    if (req.session?.role === 'bot_owner') {
      let base: Record<string, unknown> = {};
      if (metadataJson) {
        try {
          const parsed = JSON.parse(metadataJson);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
        } catch { /* ignore malformed, start fresh */ }
      }
      base.provenance = {
        authored_by: 'human',
        owner_name: req.session.owner_name,
        auth_mode: 'web_ui',
      };
      metadataJson = JSON.stringify(base);
    }

    // Parse @mentions from content against thread participants
    const threadParticipants = await db.getParticipants(thread.id);
    const { mentions: mentionRefs, mentionAll } = await parseMentions(
      resolvedContent,
      threadParticipants,
      async (id) => await db.getBotById(id),
    );

    const message = await db.createThreadMessage(
      thread.id,
      req.bot!.id,
      resolvedContent,
      typeof content_type === 'string' ? content_type : 'text',
      metadataJson,
      partsJson,
      mentionRefs ? JSON.stringify(mentionRefs) : null,
      mentionAll ? 1 : 0,
      reply_to || null,
    );

    const replyContext = await buildReplyContext(db, message);
    const enriched = { ...enrichThreadMessage(message), sender_name: req.bot!.name, ...(replyContext && { reply_to_message: replyContext }) };

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    await db.recordAudit(thread.org_id, req.bot!.id, 'message.send', 'thread_message', message.id, { thread_id: thread.id });

    // Record catchup events for all participants except the sender
    for (const p of threadParticipants) {
      if (p.bot_id === req.bot!.id) continue;
      await db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_message_summary', {
        thread_id: thread.id,
        topic: thread.topic,
        count: 1,
        last_at: message.created_at,
      }, thread.id);
    }

    void ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_message',
      thread_id: thread.id,
      message: enriched,
    }).catch(err => routeLogger.error({ err }, 'broadcast thread_message failed'));

    res.json(enriched);
  });

  /**
   * GET /api/threads/:id/messages — Get thread messages
   * Query: limit?, before?, since?
   */
  auth.get('/api/threads/:id/messages', requireBot, requireScope('read'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const limit = Math.min(Math.max(parseInt(getQueryString(req.query.limit) || '') || 50, 1), 200);
    const cursorParam = getQueryString(req.query.cursor);

    // Cursor-based pagination: cursor is a message ID (or undefined for first page).
    // Enter paginated mode when 'cursor' query key is present (even if empty string).
    if (req.query.cursor !== undefined) {
      const rows = await db.getThreadMessagesPaginated(thread.id, cursorParam || undefined, limit);
      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;

      const enriched = await Promise.all(messages.map(async (m) => {
        const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
        const reply_to_message = await buildReplyContext(db, m);
        return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown', ...(reply_to_message && { reply_to_message }) };
      }));

      const response: Record<string, unknown> = {
        items: enriched,
        has_more: hasMore,
      };
      if (hasMore && messages.length > 0) {
        response.next_cursor = messages[messages.length - 1].id;
      }
      res.json(response);
      return;
    }

    // Legacy timestamp-based path
    const beforeStr = getQueryString(req.query.before);
    const before = beforeStr ? parseInt(beforeStr) : undefined;
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr !== undefined ? parseInt(sinceStr) : undefined;
    if (since !== undefined && isNaN(since)) {
      res.status(400).json({ error: 'since must be a valid integer timestamp' });
      return;
    }

    const messages = await db.getThreadMessages(thread.id, limit, before, since);
    const enriched = await Promise.all(messages.map(async (m) => {
      const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
      const reply_to_message = await buildReplyContext(db, m);
      return { ...enrichThreadMessage(m), sender_name: sender?.name || 'unknown', ...(reply_to_message && { reply_to_message }) };
    }));

    res.json(enriched.reverse());
  });

  /**
   * POST /api/threads/:id/artifacts — Add new artifact (new key only)
   * Use PATCH to update existing artifacts with new versions.
   */
  auth.post('/api/threads/:id/artifacts', requireBot, requireScope('thread'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
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
    const existing = await db.getArtifact(thread.id, artifact_key);
    if (existing) {
      res.status(409).json({ error: `Artifact key "${artifact_key}" already exists. Use PATCH to update it.` });
      return;
    }

    try {
      const artifact = await db.addArtifact(
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
      await db.recordAudit(thread.org_id, req.bot!.id, 'artifact.add', 'artifact', artifact.id, {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      });

      // Record catchup events for all participants except the contributor
      const participants = await db.getParticipants(thread.id);
      for (const p of participants) {
        if (p.bot_id === req.bot!.id) continue;
        await db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_artifact_added', {
          thread_id: thread.id,
          artifact_key: artifact.artifact_key,
          version: artifact.version,
        }, thread.id);
      }

      void ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_artifact',
        thread_id: thread.id,
        artifact,
        action: 'added',
      }).catch(err => routeLogger.error({ err }, 'broadcast thread_artifact failed'));

      res.json(artifact);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to add artifact' });
    }
  });

  /**
   * PATCH /api/threads/:id/artifacts/:key — Update artifact (new version)
   */
  auth.patch('/api/threads/:id/artifacts/:key', requireBot, requireScope('thread'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string, { rejectTerminal: true });
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
      const artifact = await db.updateArtifact(
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
      await db.recordAudit(thread.org_id, req.bot!.id, 'artifact.update', 'artifact', artifact.id, {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      });

      // Record catchup events for all participants except the contributor
      const participants = await db.getParticipants(thread.id);
      for (const p of participants) {
        if (p.bot_id === req.bot!.id) continue;
        await db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_artifact_added', {
          thread_id: thread.id,
          artifact_key: artifact.artifact_key,
          version: artifact.version,
        }, thread.id);
      }

      void ws.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_artifact',
        thread_id: thread.id,
        artifact,
        action: 'updated',
      }).catch(err => routeLogger.error({ err }, 'broadcast thread_artifact failed'));

      res.json(artifact);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to update artifact' });
    }
  });

  /**
   * GET /api/threads/:id/artifacts — List latest artifact version for each key
   */
  auth.get('/api/threads/:id/artifacts', requireBot, requireScope('read'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    res.json(await db.listArtifacts(thread.id));
  });

  /**
   * GET /api/threads/:id/artifacts/:key/versions — List all versions for a key
   */
  auth.get('/api/threads/:id/artifacts/:key/versions', requireBot, requireScope('read'), async (req, res) => {
    const thread = await requireThreadParticipant(req, res, req.params.id as string);
    if (!thread) return;

    const key = req.params.key as string;
    if (!key || !ARTIFACT_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Invalid artifact key' });
      return;
    }

    res.json(await db.getArtifactVersions(thread.id, key));
  });

  // ─── Messages ─────────────────────────────────────────────

  /**
   * GET /api/channels/:id/messages — Get messages from a channel
   * Query: limit?, before? (message id for pagination, or timestamp for legacy), since? (timestamps)
   * When before is a message id (not numeric), uses cursor-based pagination and returns
   * { messages: [...], has_more: boolean } with messages sorted newest first.
   */
  auth.get('/api/channels/:id/messages', requireScope('read'), async (req, res) => {
    const channel = await db.getChannel(req.params.id as string);
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
    if (req.bot && !(await db.isChannelMember(channel.id, req.bot.id))) {
      res.status(403).json({ error: 'Not a member of this channel', code: 'FORBIDDEN' });
      return;
    }
    if (req.session?.org_id && channel.org_id !== req.session.org_id) {
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
      const rows = await db.getMessagesPaginated(channel.id, isBeforeId ? beforeStr : undefined, limit);
      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;

      const enriched = await Promise.all(messages.map(async (m) => {
        const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
        return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
      }));

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

    const messages = await db.getMessages(channel.id, limit, before, since);

    // Enrich with sender names and parsed parts
    const enriched = await Promise.all(messages.map(async (m) => {
      const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
      return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
    }));

    res.json(enriched.reverse()); // Return in chronological order
  });

  /**
   * POST /api/send — Quick send: DM a bot by name/id (auto-creates channel)
   * Body: { to, content, content_type? }
   */
  auth.post('/api/send', requireBot, requireScope('message'), async (req, res) => {
    // Block DM sending for bot_owner sessions (Web UI) — DMs are read-only for human operators
    if (req.session?.role === 'bot_owner') {
      res.status(403).json({ error: 'DM sending is not available for Web UI sessions', code: 'DM_SEND_BLOCKED' });
      return;
    }

    if (!(await checkMessageRateLimit(req, res))) return;

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
    const target = await db.getBotById(to) || await db.getBotByName(orgId, to);

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
    const channel = await db.createChannel(orgId, [req.bot!.id, target.id]);

    // Broadcast channel creation if new
    if (channel.isNew) {
      ws.broadcastToOrg(orgId, {
        type: 'channel_created',
        channel: { id: channel.id, org_id: channel.org_id, type: channel.type, name: channel.name, created_at: channel.created_at },
        members: [req.bot!.id, target.id],
      });
    }

    const msg = await db.createMessage(channel.id, req.bot!.id, resolvedContent, content_type || 'text', partsJson);

    // Audit (rate limit event already recorded atomically in checkMessageRateLimit)
    await db.recordAudit(req.bot!.org_id, req.bot!.id, 'message.send', 'channel_message', msg.id, { channel_id: channel.id, to: target.id });

    // Record catchup event for the target
    await db.recordCatchupEvent(req.bot!.org_id, target.id, 'channel_message_summary', {
      channel_id: channel.id,
      channel_name: channel.name ?? undefined,
      count: 1,
      last_at: msg.created_at,
    }, channel.id);

    // Broadcast (fire-and-forget)
    void ws.broadcastMessage(channel.id, msg, req.bot!.name)
      .catch(err => routeLogger.error({ err }, 'broadcast channel message failed'));

    res.json({ channel_id: channel.id, message: enrichMessage(msg) });
  });

  // ─── Catchup (Offline Event Replay) ───────────────────────

  /**
   * GET /api/me/catchup — Get missed events since timestamp
   * Query: since (required, ms timestamp), cursor?, limit?
   */
  auth.get('/api/me/catchup', requireBot, requireScope('read'), async (req, res) => {
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : NaN;
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const limitRaw = parseInt(getQueryString(req.query.limit) || '') || 50;
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const cursor = getQueryString(req.query.cursor);

    const { events, has_more } = await db.getCatchupEvents(req.bot!.id, since, limit, cursor);

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
  auth.get('/api/me/catchup/count', requireBot, requireScope('read'), async (req, res) => {
    const sinceStr = getQueryString(req.query.since);
    const since = sinceStr ? parseInt(sinceStr) : NaN;
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const counts: CatchupCountResponse = await db.getCatchupCount(req.bot!.id, since);
    res.json(counts);
  });

  // ─── Inbox ─────────────────────────────────────────────────

  /**
   * GET /api/inbox — Get new messages since timestamp
   * Query: since (timestamp, required)
   */
  auth.get('/api/inbox', requireBot, requireScope('read'), async (req, res) => {
    const since = parseInt(getQueryString(req.query.since) || '');
    if (isNaN(since)) {
      res.status(400).json({ error: 'since (timestamp) is required' });
      return;
    }

    const messages = await db.getNewMessages(req.bot!.id, since);
    const enriched = await Promise.all(messages.map(async (m) => {
      const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
      return { ...enrichMessage(m), sender_name: sender?.name || 'unknown' };
    }));

    res.json(enriched);
  });

  // ─── Files ───────────────────────────────────────────────

  const filesDir = path.join(config.data_dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  // Single source of truth: MIME → safe disk extension. ALLOWED_MIME_TYPES is derived from this.
  const MIME_TO_EXT: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
  };
  const ALLOWED_MIME_TYPES = new Set(Object.keys(MIME_TO_EXT));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, filesDir),
      filename: (_req, file, cb) => {
        // Use safe extension derived from MIME (falls back to original extension for unknown types)
        const ext = MIME_TO_EXT[file.mimetype] ?? path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: {
      fileSize: config.max_file_size_mb * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        const err = new Error(`File type not allowed: ${file.mimetype}`);
        (err as any).code = 'UNSUPPORTED_MEDIA_TYPE';
        cb(err);
      }
    },
  });

  /**
   * POST /api/files/upload — Upload a file (multipart/form-data)
   * Auth: bot token
   * Returns: { id, name, mime_type, size, url, created_at }
   */
  auth.post('/api/files/upload', requireBot, requireScope('upload'), async (req, res, next) => {
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
        // fileFilter rejection (identified by error code, not fragile string match)
        if ((err as any).code === 'UNSUPPORTED_MEDIA_TYPE') {
          res.status(415).json({ error: err.message, code: 'UNSUPPORTED_MEDIA_TYPE' });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  }, async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided (field name must be "file")' });
      return;
    }

    // Validate actual file content via magic bytes (client Content-Type can be spoofed)
    try {
      const detected = await fileTypeFromFile(file.path);
      if (detected) {
        // File has recognizable magic bytes — verify against whitelist
        if (!ALLOWED_MIME_TYPES.has(detected.mime)) {
          try { fs.unlinkSync(file.path); } catch { /* ignore */ }
          res.status(415).json({
            error: `File content type not allowed: ${detected.mime}`,
            code: 'UNSUPPORTED_MEDIA_TYPE',
          });
          return;
        }
        // Override client-provided MIME with detected one for accuracy
        (file as any).mimetype = detected.mime;
      } else {
        // file-type returned null — no recognizable binary magic bytes.
        // SVG/XML files are text-based and not detected by file-type.
        // Check the first bytes for XML/SVG signatures to block SVG bypass.
        const head = Buffer.alloc(256);
        const fd = fs.openSync(file.path, 'r');
        try { fs.readSync(fd, head, 0, 256, 0); } finally { fs.closeSync(fd); }
        const headStr = head.toString('utf8').trimStart().toLowerCase();
        if (headStr.startsWith('<?xml') || headStr.startsWith('<svg') || headStr.startsWith('<!doctype svg')) {
          try { fs.unlinkSync(file.path); } catch { /* ignore */ }
          res.status(415).json({
            error: 'File content type not allowed: image/svg+xml',
            code: 'UNSUPPORTED_MEDIA_TYPE',
          });
          return;
        }
      }
      // If no magic bytes and not SVG/XML, trust the client MIME (already checked by fileFilter).
    } catch {
      // fileTypeFromFile failed (e.g. file disappeared) — reject safely
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
      res.status(500).json({ error: 'Failed to validate file content', code: 'VALIDATION_ERROR' });
      return;
    }

    // Multer decodes multipart filenames as Latin-1 (per RFC). Re-decode as UTF-8
    // so that CJK characters and emoji are preserved correctly.
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const orgId = req.bot!.org_id;
    const relativePath = `files/${file.filename}`;
    const dailyLimitBytes = config.file_upload_mb_per_day * 1024 * 1024;
    const settings = await db.getOrgSettings(orgId);
    const perBotDailyLimitBytes = settings.file_upload_mb_per_day_per_bot * 1024 * 1024;

    // Atomically check quota (org-level + per-bot) and create file record
    const result = await db.createFileWithQuotaCheck(
      orgId,
      req.bot!.id,
      originalName,
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
    await db.recordAudit(orgId, req.bot!.id, 'file.upload', 'file', record.id, {
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
  auth.get('/api/files/:id', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const record = await db.getFile(req.params.id as string);
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

    // Serve with safe Content-Type — reject dangerous MIME types (e.g., SVG with scripts)
    const safeMime = ALLOWED_MIME_TYPES.has(record.mime_type || '') ? record.mime_type! : 'application/octet-stream';
    const isInlineType = safeMime.startsWith('image/');
    res.setHeader('Content-Type', safeMime);
    const encodedName = encodeURIComponent(record.name);
    res.setHeader('Content-Disposition', isInlineType
      ? `inline; filename*=UTF-8''${encodedName}`
      : `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Length', record.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const stream = fs.createReadStream(diskPath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read file', code: 'READ_ERROR' });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });

  /**
   * GET /api/files/:id/info — Get file metadata
   * Auth: bot token or org API key
   * Org-scoped access check
   */
  auth.get('/api/files/:id/info', requireScope('read'), async (req, res) => {
    const orgId = requireOrgOrBot(req, res);
    if (!orgId) return;

    const record = await db.getFileInfo(req.params.id as string);
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
  auth.get('/api/org/settings', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;
    res.json(await db.getOrgSettings(orgId));
  });

  /**
   * PATCH /api/org/settings — Update org settings
   * Auth: Org ticket or admin bot token
   * Body: partial OrgSettings fields
   */
  auth.patch('/api/org/settings', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

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

    const settings = await db.updateOrgSettings(orgId, updates);

    // Audit
    await db.recordAudit(orgId, null, 'settings.update', 'org_settings', orgId, updates);

    res.json(settings);
  });

  // ─── Org Auth Management (Admin Bot) ─────────────────────

  /**
   * POST /api/org/tickets — Create an org ticket (org admin or admin bot)
   * Auth: Org ticket (org_secret login) or Bot token (admin role)
   * Body: { reusable?: boolean, expires_in?: number }
   * Returns: { ticket, expires_at, reusable }
   */
  auth.post('/api/org/tickets', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const { reusable, expires_in } = req.body;

    const orgId = req.session?.org_id || req.bot?.org_id || req.org?.id;
    const org = orgId ? await db.getOrgById(orgId) : undefined;
    if (!org) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // Calculate expiry (0 = never expires)
    const expiresAt = (typeof expires_in === 'number' && expires_in === 0)
      ? 0
      : Date.now() + ((typeof expires_in === 'number' && expires_in > 0 ? expires_in : 1800) * 1000);

    // Use the org's stored org_secret hash as the secret_hash for the ticket
    // This allows rotation invalidation: when org_secret changes, the hash
    // won't match new tickets' secret_hash
    const secretHash = org.org_secret;

    const isReusable = reusable === true;
    const ticket = await db.createOrgTicket(orgId!, secretHash, {
      reusable: isReusable,
      expiresAt,
      createdBy: req.bot?.id,
    });

    const ticketResponse: OrgTicketResponse = {
      ticket: ticket.code ?? ticket.id,
      expires_at: ticket.expires_at,
      reusable: ticket.reusable,
    };
    res.json(ticketResponse);
  });

  /**
   * GET /api/org/tickets — List active (unredeemed, unexpired) org tickets
   * Auth: Session (org_admin/super_admin) or admin bot Bearer token
   * Query: limit?, cursor?
   * Returns: { items: OrgTicket[], cursor? }
   */
  auth.get('/api/org/tickets', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

    const limitRaw = parseInt(getQueryString(req.query.limit) || '') || 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const cursor = getQueryString(req.query.cursor) || undefined;

    const result = await db.listOrgTickets(orgId, { limit, cursor });

    // Sanitize: never expose secret_hash
    const items = result.items.map(t => ({
      id: t.id,
      code: t.code,
      reusable: t.reusable,
      expires_at: t.expires_at,
      created_by: t.created_by,
      created_at: t.created_at,
    }));

    res.json({ items, cursor: result.cursor });
  });

  /**
   * DELETE /api/org/tickets/:id — Revoke a specific org ticket
   * Auth: Session (org_admin/super_admin) or admin bot Bearer token
   * Returns: 200 { deleted: true } or 404
   */
  auth.delete('/api/org/tickets/:id', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;
    const ticketId = req.params.id;

    const deleted = await db.deleteOrgTicket(ticketId, orgId);
    if (!deleted) {
      res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
      return;
    }

    const actorId = req.bot?.id || (req.session?.role ?? 'org_admin');
    await db.recordAudit(orgId, req.bot?.id ?? null, 'auth.ticket_revoked', 'org_ticket', ticketId, { revoked_by: actorId });

    res.json({ deleted: true });
  });

  /**
   * GET /api/org/sessions — List active sessions for the org
   * Auth: Session (org_admin/super_admin) or admin bot Bearer token
   * Query: limit?, offset?
   * Returns: { items: Session[] } (session IDs are truncated for security)
   */
  auth.get('/api/org/sessions', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

    const limitRaw = parseInt(getQueryString(req.query.limit) || '') || 20;
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offsetRaw = parseInt(getQueryString(req.query.offset) || '') || 0;
    const offset = Math.max(offsetRaw, 0);

    const sessions = await sessionStore.listByOrg(orgId, { limit, offset });

    // Sanitize: use HMAC-based reference ID instead of exposing the secret session ID.
    // The ref is a deterministic, non-reversible identifier derived from the session ID.
    const items = sessions.map(s => ({
      ref: crypto.createHmac('sha256', 'hxa-session-ref').update(s.id).digest('hex').slice(0, 16),
      role: s.role,
      bot_id: s.bot_id,
      owner_name: s.owner_name,
      created_at: s.created_at,
      expires_at: s.expires_at,
    }));

    res.json({ items });
  });

  /**
   * DELETE /api/org/sessions/:ref — Force-logout a specific session
   * Auth: Session (org_admin/super_admin) or admin bot Bearer token
   * :ref is the HMAC-based reference from GET /api/org/sessions (not the raw session ID)
   * Returns: 200 { deleted: true } or 404
   */
  auth.delete('/api/org/sessions/:ref', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;
    const targetRef = req.params.ref;

    // Look up the session by iterating org sessions and matching the HMAC ref.
    // This avoids exposing the real session ID in the API.
    // SESSION_LIMIT caps concurrency (5 org_admin + 5 per bot), so 100 is more than enough.
    const sessions = await sessionStore.listByOrg(orgId, { limit: 100 });
    const targetSession = sessions.find(s =>
      crypto.createHmac('sha256', 'hxa-session-ref').update(s.id).digest('hex').slice(0, 16) === targetRef
    );

    if (!targetSession) {
      res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
      return;
    }

    // Prevent self-deletion (admin deleting own session)
    if (req.session && targetSession.id === req.session.id) {
      res.status(400).json({ error: 'Cannot force-logout your own session. Use POST /api/auth/logout instead.', code: 'SELF_LOGOUT' });
      return;
    }

    // Delete session from store
    await sessionStore.delete(targetSession.id);

    // Disconnect any WS clients using this session
    ws.disconnectBySessionId(targetSession.id);

    const actorId = req.bot?.id || (req.session?.role ?? 'org_admin');
    await db.recordAudit(orgId, req.bot?.id ?? null, 'auth.session_force_logout', 'session', targetRef, {
      target_role: targetSession.role,
      target_bot_id: targetSession.bot_id,
      revoked_by: actorId,
    });

    res.json({ deleted: true });
  });

  /**
   * POST /api/org/rotate-secret — Rotate the org secret (org admin or admin bot)
   * Auth: Org ticket (org_secret login) or Bot token (admin role)
   * Returns: { org_secret }
   */
  auth.post('/api/org/rotate-secret', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const orgId = req.session?.org_id || req.bot?.org_id || req.org?.id;
    const org = orgId ? await db.getOrgById(orgId) : undefined;
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
    await db.rotateOrgSecret(orgId!, newSecretHash);

    // Invalidate all unredeemed org_tickets for this org
    await db.invalidateOrgTickets(orgId!);

    // Revoke existing org_admin sessions and disconnect WS clients
    await sessionStore.deleteByRole('org_admin', orgId!);
    ws.disconnectByRole('org_admin', orgId!);

    res.json({ org_secret: newSecret });
  });

  /**
   * PATCH /api/org/bots/:bot_id/role — Update a bot's auth_role (org admin or admin bot)
   * Auth: Org ticket (org_secret login) or Bot token (admin role)
   * Body: { auth_role: 'admin' | 'member' }
   * Returns: { bot_id, auth_role }
   */
  auth.patch('/api/org/bots/:bot_id/role', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;

    const { auth_role } = req.body;

    // Validate auth_role
    if (auth_role !== 'admin' && auth_role !== 'member') {
      res.status(400).json({ error: "auth_role must be 'admin' or 'member'", code: 'VALIDATION_ERROR' });
      return;
    }

    const orgId = req.session?.org_id || req.bot?.org_id || req.org?.id;
    const targetBotId = req.params.bot_id as string;
    const targetBot = await db.getBotById(targetBotId);
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

    await db.setBotAuthRole(targetBotId, auth_role);

    const actorId = req.bot?.id || 'org_admin';
    await db.recordAudit(orgId!, actorId, 'bot.role_change', 'bot', targetBotId, { auth_role });

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
  auth.post('/api/ws-ticket', async (req, res) => {
    // Session cookie auth (ADR-002)
    if (req.session) {
      if (req.session.role === 'super_admin') {
        res.status(403).json({ error: 'super_admin cannot use WebSocket', code: 'FORBIDDEN' });
        return;
      }
      const ticketId = issueWsTicket({
        sessionId: req.session.id,
        role: req.session.role,
        botId: req.session.bot_id || undefined,
        orgId: req.session.org_id!,
        scopes: req.session.scopes,
        isScopedToken: req.session.is_scoped_token,
      });
      res.json({ ticket: ticketId, expires_in: 30 });
      return;
    }

    // Bot Bearer token flow
    const token = req.rawToken;
    if (!token) {
      res.status(401).json({ error: 'Authentication token required for ticket exchange', code: 'AUTH_REQUIRED' });
      return;
    }

    const orgId = req.bot?.org_id || req.org?.id;
    const ticketId = issueWsTicket({ token, orgId });

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
  auth.get('/api/audit', async (req, res) => {
    if (!requireOrgAdmin(req, res)) return;
    const orgId = (req.session?.org_id || req.org?.id || req.bot?.org_id)!;

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

    const entries = await db.getAuditLog(orgId, { since, action, target_type, target_id, bot_id, limit });
    res.json(entries);
  });

  // Mount authenticated routes
  router.use(auth);

  return router;
}
