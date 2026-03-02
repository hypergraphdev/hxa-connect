/**
 * Web UI Backend — Session-authenticated proxy for human operators.
 *
 * Provides cookie-based auth (HttpOnly, Secure, SameSite=Strict) on top of
 * the existing bot token system. Humans log in with their bot's token and
 * can browse DMs (read-only) and participate in threads.
 *
 * Mount this router at a prefix (e.g. /ui) on the main Express app.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import type { HubDB } from './db.js';
import { encodeCursor } from './db.js';
import type { HubWS } from './ws.js';
import { issueWsTicket } from './ws-tickets.js';
import type { Bot, TokenScope, MessagePart } from './types.js';
import { SCOPE_REQUIREMENTS, validateParts } from './types.js';
import type { HubConfig } from './types.js';

// ─── Session Store ───────────────────────────────────────────

interface Session {
  id: string;
  bot_id: string;
  org_id: string;
  owner_name: string;
  /** The raw bot token (primary or scoped) — used for ws-ticket issuance */
  token: string;
  scopes: TokenScope[];
  /** Whether the session was created with a scoped token (vs primary bot token) */
  is_scoped_token: boolean;
  created_at: number;
  expires_at: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_COOKIE = 'hxa_session';
const sessions = new Map<string, Session>();

function purgeExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires_at < now) {
      sessions.delete(id);
    }
  }
}

/** Parse cookies from the Cookie header. */
function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try { result[key] = decodeURIComponent(val); } catch { result[key] = val; }
  }
  return result;
}

// ─── Middleware ───────────────────────────────────────────────

/** Extend Express Request for Web UI session context. */
declare global {
  namespace Express {
    interface Request {
      uiSession?: Session;
      uiBot?: Bot;
    }
  }
}

/** CSRF protection: validate Origin header on mutating requests. */
function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (!origin) {
    // No Origin header — could be same-origin request (browsers always send
    // Origin for cross-origin). Allow it; SameSite=Strict cookie provides
    // defense-in-depth.
    next();
    return;
  }

  // Validate Origin matches the request host
  const host = req.headers.host;
  if (!host) {
    res.status(403).json({ error: 'Missing Host header', code: 'CSRF_REJECTED' });
    return;
  }

  try {
    const originUrl = new URL(origin);
    // Compare hostname:port (Origin includes scheme but not path)
    const originHost = originUrl.port
      ? `${originUrl.hostname}:${originUrl.port}`
      : originUrl.hostname;
    // Host header may or may not include port
    const reqHost = host.split(':')[0];
    const originHostname = originUrl.hostname;

    if (originHostname !== reqHost && originHost !== host) {
      res.status(403).json({ error: 'Origin mismatch', code: 'CSRF_REJECTED' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'Invalid Origin header', code: 'CSRF_REJECTED' });
    return;
  }

  next();
}

/** Session authentication middleware — resolves session cookie to bot. */
function sessionAuth(db: HubDB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    purgeExpiredSessions();

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE];

    if (!sessionId) {
      res.status(401).json({ error: 'Not authenticated', code: 'SESSION_REQUIRED' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.expires_at < Date.now()) {
      if (session) sessions.delete(sessionId);
      res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
      return;
    }

    // Verify bot still exists
    const bot = await db.getBotById(session.bot_id);
    if (!bot) {
      sessions.delete(sessionId);
      res.status(401).json({ error: 'Bot no longer exists', code: 'SESSION_INVALID' });
      return;
    }

    // Re-check org status (mirrors main API auth behavior)
    const org = await db.getOrgById(bot.org_id);
    if (!org || org.status === 'suspended' || org.status === 'destroyed') {
      sessions.delete(sessionId);
      res.status(403).json({ error: 'Organization is not accessible', code: 'ORG_INACCESSIBLE' });
      return;
    }

    // Re-check scoped token validity (if session was created with a scoped token)
    if (session.is_scoped_token) {
      const scopedToken = await db.getBotTokenByToken(session.token);
      if (!scopedToken) {
        sessions.delete(sessionId);
        res.status(401).json({ error: 'Token revoked', code: 'TOKEN_REVOKED' });
        return;
      }
      if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
        sessions.delete(sessionId);
        res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        return;
      }
    }

    req.uiSession = session;
    req.uiBot = bot;
    next();
  };
}

/** Require a specific token scope for the session. */
function requireUIScope(operation: keyof typeof SCOPE_REQUIREMENTS) {
  const allowedScopes = SCOPE_REQUIREMENTS[operation];
  return (req: Request, res: Response, next: NextFunction) => {
    const scopes = req.uiSession?.scopes ?? [];
    const hasScope = scopes.some(s => allowedScopes.includes(s));
    if (!hasScope) {
      res.status(403).json({
        error: `Insufficient scope. Required: ${allowedScopes.join(' or ')}`,
        code: 'INSUFFICIENT_SCOPE',
      });
      return;
    }
    next();
  };
}

// ─── Router Factory ──────────────────────────────────────────

export function createWebUIRouter(db: HubDB, ws: HubWS, config?: HubConfig): Router {
  const maxMessageLength = config?.max_message_length ?? 65536;
  const router = Router();

  // Apply CSRF protection to all routes
  router.use(csrfMiddleware);

  // ── Parse JSON body ─────────────────────────────────────
  // (relies on parent app's express.json() already being applied)

  // ── Login ───────────────────────────────────────────────

  /**
   * POST /login — Authenticate with bot token + owner name.
   * Body: { token: string, owner_name: string }
   * Returns: session info. Sets HttpOnly session cookie.
   */
  router.post('/login', async (req: Request, res: Response) => {
    const { token, owner_name } = req.body;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (!owner_name || typeof owner_name !== 'string' || owner_name.length > 128) {
      res.status(400).json({ error: 'owner_name is required (1-128 chars)' });
      return;
    }

    // Verify token — try primary bot token first, then scoped token
    let bot: Bot | undefined;
    let scopes: TokenScope[] = ['full'];
    let isScopedToken = false;

    bot = await db.getBotByToken(token);
    if (!bot) {
      const scopedToken = await db.getBotTokenByToken(token);
      if (scopedToken) {
        if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
          res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
          return;
        }
        bot = await db.getBotById(scopedToken.bot_id);
        scopes = scopedToken.scopes;
        isScopedToken = true;
        if (scopedToken.id) await db.touchBotToken(scopedToken.id);
      }
    }

    if (!bot) {
      res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
      return;
    }

    // Require at least 'read' scope
    const hasRead = scopes.some(s => ['full', 'read'].includes(s));
    if (!hasRead) {
      res.status(403).json({ error: 'Token requires at least read scope', code: 'INSUFFICIENT_SCOPE' });
      return;
    }

    // Check org status
    const org = await db.getOrgById(bot.org_id);
    if (!org || org.status === 'suspended' || org.status === 'destroyed') {
      res.status(403).json({ error: 'Organization is not accessible', code: 'ORG_INACCESSIBLE' });
      return;
    }

    // Create session
    purgeExpiredSessions();
    const sessionId = crypto.randomBytes(32).toString('hex');
    const session: Session = {
      id: sessionId,
      bot_id: bot.id,
      org_id: bot.org_id,
      owner_name: owner_name.trim(),
      token,
      scopes,
      is_scoped_token: isScopedToken,
      created_at: Date.now(),
      expires_at: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(sessionId, session);

    // Set cookie — HttpOnly, SameSite=Strict
    // Secure flag based on actual protocol (respects trust proxy + x-forwarded-proto)
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/ui${req.secure ? '; Secure' : ''}; Max-Age=${SESSION_TTL_MS / 1000}`,
    );

    res.json({
      bot: { id: bot.id, name: bot.name, org_id: bot.org_id },
      owner_name: session.owner_name,
      scopes: session.scopes,
      expires_at: session.expires_at,
    });
  });

  // ── All routes below require session ────────────────────

  const auth = Router();
  auth.use(sessionAuth(db));
  router.use(auth);

  // ── Logout ──────────────────────────────────────────────

  auth.post('/logout', (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE];
    if (sessionId) sessions.delete(sessionId);

    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=0`,
    );
    res.json({ ok: true });
  });

  // ── Session Info ────────────────────────────────────────

  auth.get('/session', (req: Request, res: Response) => {
    const s = req.uiSession!;
    const bot = req.uiBot!;
    res.json({
      bot: { id: bot.id, name: bot.name, org_id: bot.org_id },
      owner_name: s.owner_name,
      scopes: s.scopes,
      expires_at: s.expires_at,
    });
  });

  // ── Workspace ───────────────────────────────────────────

  auth.get('/workspace', requireUIScope('read'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const dmLimit = Math.min(Math.max(parseInt(qs(req.query.dm_limit)) || 20, 1), 100);
    const threadLimit = Math.min(Math.max(parseInt(qs(req.query.thread_limit)) || 20, 1), 100);
    const dmCursor = qs(req.query.dm_cursor) || undefined;
    const threadCursor = qs(req.query.thread_cursor) || undefined;

    const [dmRows, threadRows] = await Promise.all([
      db.getWorkspaceDMs(bot.id, dmCursor, dmLimit),
      db.listThreadsForBotPaginated(bot.id, { cursor: threadCursor, limit: threadLimit }),
    ]);

    const dmHasMore = dmRows.length > dmLimit;
    const dmItems = dmHasMore ? dmRows.slice(0, dmLimit) : dmRows;
    const threadHasMore = threadRows.length > threadLimit;
    const threadItems = threadHasMore ? threadRows.slice(0, threadLimit) : threadRows;

    res.json({
      bot: { id: bot.id, name: bot.name, org_id: bot.org_id },
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
    });
  });

  // ── DM Messages (read-only) ─────────────────────────────

  auth.get('/channels/:id/messages', requireUIScope('read'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const channelId = req.params.id as string;

    // Verify bot is a member of this channel
    const isMember = await db.isChannelMember(channelId, bot.id);
    if (!isMember) {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    // Verify it's a direct channel
    const channel = await db.getChannel(channelId);
    if (!channel || channel.type !== 'direct') {
      res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(qs(req.query.limit)) || 50, 1), 200);
    const cursor = qs(req.query.cursor) || undefined;

    const rows = await db.getMessagesPaginated(channelId, cursor, limit);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;

    // Enrich with sender names
    const enriched = await Promise.all(messages.map(async (m) => {
      const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
      return {
        ...m,
        sender_name: sender?.name || 'unknown',
      };
    }));

    res.json({
      items: enriched,
      has_more: hasMore,
      ...(hasMore && messages.length > 0 ? { next_cursor: messages[messages.length - 1].id } : {}),
    });
  });

  // ── DM Send Block ───────────────────────────────────────
  // Explicitly block any DM send attempt — DMs are read-only in Web UI

  auth.post('/channels/:id/messages', (_req: Request, res: Response) => {
    res.status(403).json({
      error: 'DM sending is not available in Web UI. DMs are read-only.',
      code: 'DM_SEND_BLOCKED',
    });
  });

  auth.post('/send', (_req: Request, res: Response) => {
    res.status(403).json({
      error: 'DM sending is not available in Web UI. DMs are read-only.',
      code: 'DM_SEND_BLOCKED',
    });
  });

  // ── Threads ─────────────────────────────────────────────

  auth.get('/threads', requireUIScope('read'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const limit = Math.min(Math.max(parseInt(qs(req.query.limit)) || 50, 1), 200);
    const cursor = qs(req.query.cursor) || undefined;
    const search = qs(req.query.q)?.trim() || undefined;
    const status = qs(req.query.status) || undefined;

    const rows = await db.listThreadsForBotPaginated(bot.id, { status: status as any, cursor, limit, search });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      items,
      has_more: hasMore,
      ...(hasMore && items.length > 0 ? {
        next_cursor: encodeCursor(items[items.length - 1].last_activity_at, items[items.length - 1].id),
      } : {}),
    });
  });

  auth.get('/threads/:id', requireUIScope('read'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const threadId = req.params.id as string;

    const thread = await db.getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    // Verify bot is a participant
    const participants = await db.getParticipants(threadId);
    if (!participants.some(p => p.bot_id === bot.id)) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const enrichedParticipants = await Promise.all(participants.map(async (p) => {
      const pBot = await db.getBotById(p.bot_id);
      return { bot_id: p.bot_id, name: pBot?.name, online: pBot?.online, joined_at: p.joined_at };
    }));

    res.json({ ...thread, participants: enrichedParticipants });
  });

  auth.get('/threads/:id/messages', requireUIScope('read'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const threadId = req.params.id as string;

    // Verify participation
    const participants = await db.getParticipants(threadId);
    if (!participants.some(p => p.bot_id === bot.id)) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(qs(req.query.limit)) || 50, 1), 200);
    const cursor = qs(req.query.cursor) || undefined;

    const rows = await db.getThreadMessagesPaginated(threadId, cursor, limit);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;

    // Enrich with sender names (defensive JSON parsing for legacy/corrupt data)
    const enriched = await Promise.all(messages.map(async (m) => {
      const sender = m.sender_id ? await db.getBotById(m.sender_id) : undefined;
      return {
        ...m,
        parts: safeJsonParse(m.parts, [{ type: 'text', content: m.content }]),
        mentions: safeJsonParse(m.mentions, []),
        mention_all: !!m.mention_all,
        metadata: safeJsonParse(m.metadata, null),
        sender_name: sender?.name || 'unknown',
      };
    }));

    res.json({
      items: enriched,
      has_more: hasMore,
      ...(hasMore && messages.length > 0 ? { next_cursor: messages[messages.length - 1].id } : {}),
    });
  });

  // ── Thread Message Send (with provenance) ───────────────

  auth.post('/threads/:id/messages', requireUIScope('thread'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const session = req.uiSession!;
    const threadId = req.params.id as string;

    const thread = await db.getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    // Verify bot is a participant
    const participants = await db.getParticipants(threadId);
    if (!participants.some(p => p.bot_id === bot.id)) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    // Thread must not be terminal
    if (thread.status === 'resolved' || thread.status === 'closed') {
      res.status(409).json({ error: `Cannot send message to ${thread.status} thread`, code: 'THREAD_TERMINAL' });
      return;
    }

    // Rate limit check (same as core API)
    const rateResult = await db.checkAndRecordRateLimit(bot.org_id, bot.id, 'message');
    if (!rateResult.allowed) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        retry_after: rateResult.retryAfter,
      });
      return;
    }

    const { content, content_type, parts, mentions, mention_all } = req.body;

    // Validate content_type size
    if (content_type !== undefined && typeof content_type === 'string' && Buffer.byteLength(content_type, 'utf8') > 128) {
      res.status(400).json({ error: 'content_type exceeds size limit (128 bytes)' });
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

    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    if (content.length > maxMessageLength) {
      res.status(400).json({ error: `Message too long (max ${maxMessageLength} chars)` });
      return;
    }

    // Build metadata with human provenance
    const metadata = {
      provenance: {
        authored_by: 'human' as const,
        owner_name: session.owner_name,
        auth_mode: 'web_ui' as const,
      },
    };

    const metadataJson = JSON.stringify(metadata);

    const message = await db.createThreadMessage(
      threadId,
      bot.id,
      content,
      typeof content_type === 'string' ? content_type : 'text',
      metadataJson,
      partsJson,
      mentions ? JSON.stringify(mentions) : null,
      mention_all ? 1 : 0,
    );

    // Build wire-format message for broadcast
    const wireMessage = {
      ...message,
      parts: message.parts ? JSON.parse(message.parts) : [{ type: 'text', content: message.content }],
      mentions: message.mentions ? JSON.parse(message.mentions) : [],
      mention_all: !!message.mention_all,
      sender_name: bot.name,
    };

    // Audit logging (matches core API)
    await db.recordAudit(thread.org_id, bot.id, 'message.send', 'thread_message', message.id, { thread_id: threadId });

    // Catchup events for offline participants (matches core API)
    for (const p of participants) {
      if (p.bot_id === bot.id) continue;
      await db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_message_summary', {
        thread_id: threadId,
        topic: thread.topic,
        count: 1,
        last_at: message.created_at,
      }, threadId);
    }

    // Broadcast via WebSocket
    void ws.broadcastThreadEvent(thread.org_id, threadId, {
      type: 'thread_message',
      thread_id: threadId,
      message: wireMessage,
    } as any).catch(() => {});

    // Return enriched response with parsed metadata for the Web UI client
    res.json({ ...wireMessage, metadata });
  });

  // ── Thread Artifacts ────────────────────────────────────

  auth.get('/threads/:id/artifacts', requireUIScope('read'), async (req: Request, res: Response) => {
    const bot = req.uiBot!;
    const threadId = req.params.id as string;

    // Verify participation
    const participants = await db.getParticipants(threadId);
    if (!participants.some(p => p.bot_id === bot.id)) {
      res.status(404).json({ error: 'Thread not found', code: 'NOT_FOUND' });
      return;
    }

    const artifacts = await db.listArtifacts(threadId);
    res.json(artifacts);
  });

  // ── WebSocket Ticket ────────────────────────────────────

  auth.post('/ws-ticket', (req: Request, res: Response) => {
    const session = req.uiSession!;
    const ticketId = issueWsTicket(session.token, session.org_id);
    res.json({ ticket: ticketId, expires_in: 30 });
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────────────────

function qs(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function safeJsonParse(value: string | null | undefined, fallback: any): any {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
