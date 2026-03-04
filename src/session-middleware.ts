import type { Request, Response, NextFunction } from 'express';
import type { SessionStore } from './session.js';
import { SESSION_COOKIE, SESSION_TTL } from './session.js';

/**
 * Session middleware: parse cookie, load session, sliding expiry, CSRF validation.
 * Runs before route handlers. Does NOT reject unauthenticated requests — Bearer auth still works.
 */
export function sessionMiddleware(sessionStore: SessionStore) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // 1. Parse session cookie
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return next();

    const sessionId = parseCookie(cookieHeader, SESSION_COOKIE);
    if (!sessionId) return next();

    // 2. Look up session
    const session = await sessionStore.get(sessionId);
    if (!session) return next();

    // 3. Set session on request
    req.session = session;

    // 4. Sliding expiry: extend if past halfway
    const ttl = SESSION_TTL[session.role];
    const halflife = session.created_at + ttl / 2;
    if (Date.now() > halflife) {
      session.expires_at = Date.now() + ttl;
      await sessionStore.set(session);
    }

    next();
  };
}

/**
 * CSRF validation middleware for mutating requests with cookie auth.
 * Must run after sessionMiddleware.
 */
export function csrfMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only check mutating methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    // Skip if using Bearer auth (not cookie)
    if (req.headers.authorization) return next();

    // Skip if no session (no cookie auth)
    if (!req.session) return next();

    // CSRF: require valid Origin header for cookie-auth requests
    const origin = req.headers.origin;
    if (!origin) {
      res.status(403).json({ error: 'Origin header required for cookie-authenticated requests', code: 'CSRF_ERROR' });
      return;
    }

    // Use req.hostname which respects Express's "trust proxy" setting,
    // falling back to DOMAIN env var or raw Host header.
    const expectedHost = process.env.DOMAIN || req.hostname || req.headers.host;

    if (!expectedHost) {
      res.status(403).json({ error: 'Unable to validate request origin', code: 'CSRF_ERROR' });
      return;
    }

    try {
      const originUrl = new URL(origin);
      // Compare hostname (without port) since req.hostname strips port.
      // For non-standard ports, also accept full host match.
      if (originUrl.hostname !== expectedHost && originUrl.host !== expectedHost) {
        res.status(403).json({ error: 'Origin mismatch', code: 'CSRF_ERROR' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Origin header', code: 'CSRF_ERROR' });
      return;
    }

    next();
  };
}

/** Parse a specific cookie value from the Cookie header string. */
function parseCookie(header: string, name: string): string | undefined {
  const prefix = name + '=';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return undefined;
}
