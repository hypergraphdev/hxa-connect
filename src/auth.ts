import type { Request, Response, NextFunction } from 'express';
import type { HubDB } from './db.js';
import type { Bot, Org, TokenScope, Session } from './types.js';
import { SCOPE_REQUIREMENTS } from './types.js';

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      bot?: Bot;
      org?: Org;
      authType?: 'bot';
      /** Token scopes for the current request. Primary bot tokens have ['full']. */
      tokenScopes?: TokenScope[];
      /** ID of the scoped token used (null if primary bot token or org ticket). */
      scopedTokenId?: string;
      /** The raw plaintext token from the request (for ws-ticket exchange). */
      rawToken?: string;
      /** Unique request ID for log correlation. */
      requestId?: string;
      /** Session from cookie auth (ADR-002). */
      session?: Session;
    }
  }
}

/**
 * Extract bearer token from Authorization header only.
 * Query param tokens (?token=) are intentionally NOT supported to prevent
 * token leakage via proxy logs, browser history, and monitoring systems.
 * WebSocket auth uses the ws-ticket mechanism instead.
 */
function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return undefined;
}

/**
 * Middleware: Authenticate as bot (via bot token) or session (via cookie).
 * Sets req.bot, req.org, and req.tokenScopes for bot auth.
 * Session auth is handled by session-middleware.ts (sets req.session).
 */
export function authMiddleware(db: HubDB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Session already authenticated via session-middleware (ADR-002)
    if (req.session) {
      // Check org status for all org-scoped sessions (org_admin + bot_owner)
      if (req.session.org_id && (req.session.role === 'org_admin' || req.session.role === 'bot_owner')) {
        const org = await db.getOrgById(req.session.org_id);
        if (org && org.status === 'suspended') {
          res.status(403).json({ error: 'Organization is suspended', code: 'ORG_SUSPENDED' });
          return;
        }
        if (org && org.status === 'destroyed') {
          res.status(403).json({ error: 'Organization is destroyed', code: 'ORG_DESTROYED' });
          return;
        }
        req.org = org ?? undefined;
      }
      // Resolve req.bot for bot_owner sessions so requireBot and /api/ routes work
      if (req.session.role === 'bot_owner' && req.session.bot_id) {
        req.tokenScopes = req.session.scopes ?? ['full'];
        const bot = await db.getBotById(req.session.bot_id);
        if (!bot || bot.org_id !== req.session.org_id) {
          res.status(401).json({ error: 'Bot no longer exists', code: 'SESSION_INVALID' });
          return;
        }
        req.bot = bot;
        req.authType = 'bot';
      }
      next();
      return;
    }

    const token = extractToken(req);

    if (!token) {
      res.status(401).json({ error: 'Missing authentication token', code: 'AUTH_REQUIRED' });
      return;
    }

    // Store raw token for downstream handlers (e.g. ws-ticket exchange)
    req.rawToken = token;

    // Try primary bot token first
    const bot = await db.getBotByToken(token);
    if (bot) {
      // #133: Check join_status — pending/rejected bots cannot access any API
      if (bot.join_status !== 'active') {
        res.status(403).json({
          error: 'bot_not_active',
          code: 'BOT_NOT_ACTIVE',
          join_status: bot.join_status,
          message: bot.join_status === 'pending'
            ? 'Bot is awaiting org admin approval'
            : 'Bot registration was rejected',
        });
        return;
      }
      // Phase 3: Validate X-Org-Id header if present
      const requestedOrgId = req.headers['x-org-id'] as string | undefined;
      if (requestedOrgId) {
        if (requestedOrgId !== bot.org_id) {
          res.status(403).json({
            error: 'Bot does not belong to the requested organization',
            code: 'ORG_MISMATCH',
          });
          return;
        }
      }
      // No X-Org-Id header — fall back to bot's DB org (single-org compat)
      // In Phase 7 this will become a deprecation warning

      req.bot = bot;
      req.org = await db.getOrgById(bot.org_id);
      req.authType = 'bot';
      req.tokenScopes = ['full'];
      // Check org status
      if (req.org) {
        if (req.org.status === 'suspended') {
          res.status(403).json({ error: 'Organization is suspended', code: 'ORG_SUSPENDED' });
          return;
        }
        if (req.org.status === 'destroyed') {
          res.status(403).json({ error: 'Organization is destroyed', code: 'ORG_DESTROYED' });
          return;
        }
      }
      // W3: HTTP requests update last_seen but do NOT mark bot online.
      // Online status is managed exclusively by WS connections.
      await db.touchBotLastSeen(bot.id);
      next();
      return;
    }

    // Try scoped bot token
    const scopedToken = await db.getBotTokenByToken(token);
    if (scopedToken) {
      // Check expiration
      if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
        res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        return;
      }
      const scopedBot = await db.getBotById(scopedToken.bot_id);
      if (scopedBot) {
        // #133: Check join_status for scoped tokens too
        if (scopedBot.join_status !== 'active') {
          res.status(403).json({
            error: 'bot_not_active',
            code: 'BOT_NOT_ACTIVE',
            join_status: scopedBot.join_status,
            message: scopedBot.join_status === 'pending'
              ? 'Bot is awaiting org admin approval'
              : 'Bot registration was rejected',
          });
          return;
        }
        // Phase 3: Validate X-Org-Id header if present
        const requestedOrgId = req.headers['x-org-id'] as string | undefined;
        if (requestedOrgId) {
          if (requestedOrgId !== scopedBot.org_id) {
            res.status(403).json({
              error: 'Bot does not belong to the requested organization',
              code: 'ORG_MISMATCH',
            });
            return;
          }
        }

        req.bot = scopedBot;
        req.org = await db.getOrgById(scopedBot.org_id);
        req.authType = 'bot';
        req.tokenScopes = scopedToken.scopes;
        req.scopedTokenId = scopedToken.id;
        // Check org status
        if (req.org) {
          if (req.org.status === 'suspended') {
            res.status(403).json({ error: 'Organization is suspended', code: 'ORG_SUSPENDED' });
            return;
          }
          if (req.org.status === 'destroyed') {
            res.status(403).json({ error: 'Organization is destroyed', code: 'ORG_DESTROYED' });
            return;
          }
        }
        // W3: HTTP requests update last_seen but do NOT mark bot online.
        await db.touchBotLastSeen(scopedBot.id);
        await db.touchBotToken(scopedToken.id);
        next();
        return;
      }
    }

    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  };
}

/**
 * Middleware: Require bot authentication
 */
export function requireBot(req: Request, res: Response, next: NextFunction) {
  if (!req.bot) {
    res.status(403).json({ error: 'Bot authentication required', code: 'FORBIDDEN' });
    return;
  }
  next();
}

/**
 * Middleware: Require org-level authentication (session org_admin/super_admin).
 */
export function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (req.session?.role === 'org_admin' || req.session?.role === 'super_admin') {
    next();
    return;
  }
  res.status(403).json({ error: 'Organization admin authentication required', code: 'FORBIDDEN' });
}

/**
 * Middleware factory: Require a specific auth_role on the current bot.
 * Only bots with the specified role can proceed.
 */
export function requireAuthRole(role: 'admin') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.bot) {
      res.status(403).json({ error: 'Bot authentication required', code: 'FORBIDDEN' });
      return;
    }
    if (req.bot.auth_role !== role) {
      res.status(403).json({ error: `Auth role '${role}' required`, code: 'FORBIDDEN' });
      return;
    }
    next();
  };
}

/**
 * Middleware factory: Require a specific scope on the current token.
 * The operation name maps to SCOPE_REQUIREMENTS in types.ts.
 */
export function requireScope(operation: keyof typeof SCOPE_REQUIREMENTS) {
  const allowedScopes = SCOPE_REQUIREMENTS[operation];
  return (req: Request, res: Response, next: NextFunction) => {
    // Session-based org/platform auth bypasses scope checks
    if (req.session?.role === 'org_admin' || req.session?.role === 'super_admin') {
      next();
      return;
    }
    const scopes = req.tokenScopes ?? ['full'];
    const hasScope = scopes.some(s => allowedScopes.includes(s));
    if (!hasScope) {
      res.status(403).json({
        error: `Insufficient token scope. Required: ${allowedScopes.join(' or ')}`,
        code: 'INSUFFICIENT_SCOPE',
      });
      return;
    }
    next();
  };
}
