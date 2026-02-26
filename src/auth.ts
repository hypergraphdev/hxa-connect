import type { Request, Response, NextFunction } from 'express';
import type { HubDB } from './db.js';
import type { Bot, Org, TokenScope } from './types.js';
import { SCOPE_REQUIREMENTS } from './types.js';

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      bot?: Bot;
      org?: Org;
      authType?: 'bot' | 'org';
      /** Token scopes for the current request. Primary bot tokens have ['full']. */
      tokenScopes?: TokenScope[];
      /** ID of the scoped token used (null if primary bot token or org ticket). */
      scopedTokenId?: string;
      /** The raw plaintext token from the request (for ws-ticket exchange). */
      rawToken?: string;
      /** Unique request ID for log correlation. */
      requestId?: string;
    }
  }
}

/**
 * Extract bearer token from Authorization header or query param
 */
function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return (req.query.token as string) || undefined;
}

/**
 * Middleware: Authenticate as bot (via bot token) or org (via reusable ticket)
 * Sets req.bot, req.org, and req.tokenScopes
 */
export function authMiddleware(db: HubDB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);

    if (!token) {
      res.status(401).json({ error: 'Missing authentication token', code: 'AUTH_REQUIRED' });
      return;
    }

    // Store raw token for downstream handlers (e.g. ws-ticket exchange)
    req.rawToken = token;

    // Try primary bot token first
    const bot = db.getBotByToken(token);
    if (bot) {
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
      req.org = db.getOrgById(bot.org_id);
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
      db.touchBotLastSeen(bot.id);
      next();
      return;
    }

    // Try scoped bot token
    const scopedToken = db.getBotTokenByToken(token);
    if (scopedToken) {
      // Check expiration
      if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
        res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        return;
      }
      const scopedBot = db.getBotById(scopedToken.bot_id);
      if (scopedBot) {
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
        req.org = db.getOrgById(scopedBot.org_id);
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
        db.touchBotLastSeen(scopedBot.id);
        db.touchBotToken(scopedToken.id);
        next();
        return;
      }
    }

    // Try org ticket (reusable session token from login)
    const ticket = db.getOrgTicket(token);
    if (ticket && ticket.reusable && !ticket.consumed && ticket.expires_at > Date.now()) {
      const ticketOrg = db.getOrgById(ticket.org_id);
      if (ticketOrg) {
        if (ticketOrg.status === 'suspended') {
          res.status(403).json({ error: 'Organization is suspended', code: 'ORG_SUSPENDED' });
          return;
        }
        if (ticketOrg.status === 'destroyed') {
          res.status(403).json({ error: 'Organization is destroyed', code: 'ORG_DESTROYED' });
          return;
        }
        req.org = ticketOrg;
        req.authType = 'org';
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
 * Middleware: Require org admin authentication
 */
export function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (!req.org || req.authType !== 'org') {
    res.status(403).json({ error: 'Organization authentication required', code: 'FORBIDDEN' });
    return;
  }
  next();
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
    // Org-level auth bypasses scope checks
    if (req.authType === 'org') {
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
