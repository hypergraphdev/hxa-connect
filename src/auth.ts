import type { Request, Response, NextFunction } from 'express';
import type { HubDB } from './db.js';
import type { Agent, Org } from './types.js';

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      agent?: Agent;
      org?: Org;
      authType?: 'agent' | 'org';
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
 * Sets req.agent and/or req.org
 */
export function authMiddleware(db: HubDB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);

    if (!token) {
      res.status(401).json({ error: 'Missing authentication token' });
      return;
    }

    // Try agent token first
    const agent = db.getAgentByToken(token);
    if (agent) {
      req.agent = agent;
      req.org = db.getOrgById(agent.org_id);
      req.authType = 'agent';
      // Update last seen
      db.setAgentOnline(agent.id, true);
      next();
      return;
    }

    // Try org API key
    const org = db.getOrgByKey(token);
    if (org) {
      req.org = org;
      req.authType = 'org';
      next();
      return;
    }

    res.status(401).json({ error: 'Invalid token' });
  };
}

/**
 * Middleware: Require agent authentication
 */
export function requireAgent(req: Request, res: Response, next: NextFunction) {
  if (!req.agent) {
    res.status(403).json({ error: 'Agent authentication required' });
    return;
  }
  next();
}

/**
 * Middleware: Require org admin authentication
 */
export function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (!req.org) {
    res.status(403).json({ error: 'Organization authentication required' });
    return;
  }
  next();
}
