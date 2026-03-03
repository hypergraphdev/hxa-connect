/**
 * Web UI Backend — Session-authenticated proxy for human operators.
 *
 * Provides cookie-based auth (HttpOnly, Secure, SameSite=Strict) on top of
 * the existing bot token system. Humans log in with their bot's token and
 * can browse DMs (read-only) and participate in threads.
 *
 * Uses the shared SessionStore (ADR-002) for session management.
 * CSRF protection and session middleware are handled globally by session-middleware.ts.
 *
 * Mount this router at a prefix (e.g. /ui) on the main Express app.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { HubDB } from './db.js';
import { encodeCursor } from './db.js';
import type { HubWS } from './ws.js';
import { issueWsTicket } from './ws-tickets.js';
import type { Bot, TokenScope, SessionRole } from './types.js';
import { SCOPE_REQUIREMENTS, validateParts } from './types.js';
import type { HubConfig } from './types.js';
import type { SessionStore } from './session.js';
import { generateSessionId, SESSION_TTL, SESSION_LIMIT, SESSION_COOKIE } from './session.js';
import { logger } from './logger.js';
import { checkLoginRateLimit, recordLoginFailure } from './rate-limit.js';

// ─── Middleware ───────────────────────────────────────────────

/** Extend Express Request for Web UI bot context. */
declare global {
  namespace Express {
    interface Request {
      uiBot?: Bot;
    }
  }
}

/**
 * Session authentication middleware for Web UI.
 * Relies on global session middleware (req.session). Only accepts bot_owner sessions.
 */
function sessionAuth(db: HubDB, sessionStore: SessionStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // req.session is set by global session middleware (session-middleware.ts)
    if (!req.session) {
      res.status(401).json({ error: 'Not authenticated', code: 'SESSION_REQUIRED' });
      return;
    }

    // Web UI only supports bot_owner sessions
    if (req.session.role !== 'bot_owner' || !req.session.bot_id) {
      res.status(403).json({ error: 'Bot owner session required for Web UI', code: 'FORBIDDEN' });
      return;
    }

    // Verify bot still exists
    const bot = await db.getBotById(req.session.bot_id);
    if (!bot) {
      await sessionStore.delete(req.session.id);
      res.status(401).json({ error: 'Bot no longer exists', code: 'SESSION_INVALID' });
      return;
    }

    // Re-check org status (mirrors main API auth behavior)
    const org = await db.getOrgById(bot.org_id);
    if (!org || org.status === 'suspended' || org.status === 'destroyed') {
      await sessionStore.delete(req.session.id);
      res.status(403).json({ error: 'Organization is not accessible', code: 'ORG_INACCESSIBLE' });
      return;
    }

    req.uiBot = bot;
    next();
  };
}

/** Require a specific token scope for the session. */
function requireUIScope(operation: keyof typeof SCOPE_REQUIREMENTS) {
  const allowedScopes = SCOPE_REQUIREMENTS[operation];
  return (req: Request, res: Response, next: NextFunction) => {
    const scopes = req.session?.scopes ?? [];
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

export function createWebUIRouter(db: HubDB, ws: HubWS, config: HubConfig, sessionStore: SessionStore): Router {
  const maxMessageLength = config?.max_message_length ?? 65536;
  const isDev = process.env.DEV_MODE === 'true';
  const router = Router();

  // CSRF and session middleware are applied globally in index.ts

  // ── Login ───────────────────────────────────────────────

  /**
   * POST /login — Authenticate with bot token + owner name.
   * Body: { token: string, owner_name: string }
   * Returns: session info. Sets HttpOnly session cookie.
   * Creates a bot_owner session in the shared SessionStore.
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

    // Rate limit check (matches main API)
    const ip = req.ip || 'unknown';
    const identifier = token.slice(0, 8);
    const rateCheck = checkLoginRateLimit(ip, 'bot', identifier);
    if (!rateCheck.allowed) {
      res.status(429).set('Retry-After', String(rateCheck.retryAfter)).json({
        error: 'Too many failed login attempts', code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter,
      });
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
          recordLoginFailure(ip, 'bot', identifier);
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
      recordLoginFailure(ip, 'bot', identifier);
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

    // Enforce concurrent session limit (matches main API)
    const limit = SESSION_LIMIT['bot_owner'];
    const count = await sessionStore.countByRole('bot_owner', bot.org_id, bot.id);
    if (count >= limit) {
      await sessionStore.deleteByBotId(bot.id);
      ws.disconnectSessionClientsByBotId(bot.id);
    }

    // Create session in shared SessionStore
    const now = Date.now();
    const session = {
      id: generateSessionId(),
      role: 'bot_owner' as SessionRole,
      org_id: bot.org_id,
      bot_id: bot.id,
      owner_name: owner_name.trim(),
      scopes,
      is_scoped_token: isScopedToken,
      created_at: now,
      expires_at: now + SESSION_TTL['bot_owner'],
    };
    await sessionStore.set(session);

    // Audit log — bot_owner always has org_id
    await db.recordAudit(bot.org_id, bot.id, 'auth.login', 'session', session.id, {
      role: 'bot_owner', ip: req.ip, user_agent: req.headers['user-agent'], source: 'web-ui',
    });

    // Set cookie — HttpOnly, SameSite=Strict
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: !isDev,
      path: '/',
      maxAge: SESSION_TTL['bot_owner'],
    });

    res.json({
      bot: { id: bot.id, name: bot.name, org_id: bot.org_id },
      owner_name: session.owner_name,
      scopes: session.scopes,
      expires_at: session.expires_at,
    });
  });

  // ── All routes below require session ────────────────────

  const auth = Router();
  auth.use(sessionAuth(db, sessionStore));
  router.use(auth);

  // ── Logout ──────────────────────────────────────────────

  auth.post('/logout', async (req: Request, res: Response) => {
    if (req.session) {
      // Audit log — bot_owner always has org_id
      if (req.session.org_id) {
        await db.recordAudit(req.session.org_id, req.session.bot_id, 'auth.logout', 'session', req.session.id, {
          role: req.session.role, ip: req.ip, source: 'web-ui',
        });
      }
      await sessionStore.delete(req.session.id);
      ws.disconnectBySessionId(req.session.id);
    }
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: !isDev, path: '/' });
    res.json({ ok: true });
  });

  // ── Session Info ────────────────────────────────────────

  auth.get('/session', (req: Request, res: Response) => {
    const s = req.session!;
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
    const session = req.session!;
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
      metadata,
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
    const session = req.session!;
    const ticketId = issueWsTicket({
      sessionId: session.id,
      role: session.role,
      botId: session.bot_id || undefined,
      orgId: session.org_id!,
      scopes: session.scopes,
      isScopedToken: session.is_scoped_token,
    });
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
