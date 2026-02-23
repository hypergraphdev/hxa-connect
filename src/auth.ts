import type { Request, Response, NextFunction } from 'express';
import type { HubDB } from './db.js';
import type { Agent, Org, TokenScope } from './types.js';
import { SCOPE_REQUIREMENTS } from './types.js';

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      agent?: Agent;
      org?: Org;
      authType?: 'agent' | 'org';
      /** Token scopes for the current request. Primary agent tokens have ['full']. */
      tokenScopes?: TokenScope[];
      /** ID of the scoped token used (null if primary agent token or org key). */
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
 * Middleware: Authenticate as agent (via agent token) or org admin (via org API key)
 * Sets req.agent, req.org, and req.tokenScopes
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

    // Try primary agent token first
    const agent = db.getAgentByToken(token);
    if (agent) {
      req.agent = agent;
      req.org = db.getOrgById(agent.org_id);
      req.authType = 'agent';
      req.tokenScopes = ['full'];
      // W3: HTTP requests update last_seen but do NOT mark agent online.
      // Online status is managed exclusively by WS connections.
      db.touchAgentLastSeen(agent.id);
      next();
      return;
    }

    // Try scoped agent token
    const scopedToken = db.getAgentTokenByToken(token);
    if (scopedToken) {
      // Check expiration
      if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
        res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        return;
      }
      const scopedAgent = db.getAgentById(scopedToken.agent_id);
      if (scopedAgent) {
        req.agent = scopedAgent;
        req.org = db.getOrgById(scopedAgent.org_id);
        req.authType = 'agent';
        req.tokenScopes = scopedToken.scopes;
        req.scopedTokenId = scopedToken.id;
        // W3: HTTP requests update last_seen but do NOT mark agent online.
        db.touchAgentLastSeen(scopedAgent.id);
        db.touchAgentToken(scopedToken.id);
        next();
        return;
      }
    }

    // Try org API key
    const org = db.getOrgByKey(token);
    if (org) {
      req.org = org;
      req.authType = 'org';
      next();
      return;
    }

    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  };
}

/**
 * Middleware: Require agent authentication
 */
export function requireAgent(req: Request, res: Response, next: NextFunction) {
  if (!req.agent) {
    res.status(403).json({ error: 'Agent authentication required', code: 'FORBIDDEN' });
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
