# Implementation Plan: Unified Session Auth (ADR-002)

**Issue:** [#111](https://github.com/coco-xyz/hxa-connect/issues/111)
**Design:** [ADR-002](./ADR-002-unified-session-auth.md)
**Estimated scope:** ~1500 LOC across 13 files (4 new, 9 modified)

## File Inventory

### New Files

| File | Purpose | ~LOC |
|------|---------|------|
| `src/session.ts` | Session interface, SessionStore abstraction, SqliteSessionStore, RedisSessionStore | ~250 |
| `src/session-middleware.ts` | Express middleware: cookie parsing, session loading, CSRF validation, sliding expiry | ~120 |
| `src/rate-limit.ts` | Login rate limiter (composite key, in-memory with periodic cleanup) | ~100 |
| `src/db/migrations/007-sessions.ts` | Database migration: sessions table + indexes | ~30 |

### Modified Files

| File | Current LOC | Changes |
|------|-------------|---------|
| `src/types.ts` (493 LOC) | Add `Session`, `SessionRole` types; extend `AuditAction` with auth events |
| `src/auth.ts` (232 LOC) | Add `requireSessionRole()` middleware; extend `Request` with `session` field |
| `src/routes.ts` (3274 LOC) | Rework `/api/auth/login`, add 6 new endpoints, migrate all `requireAdmin`/`requireOrgAdmin` guards |
| `src/ws-tickets.ts` (60 LOC) | Extend `WsTicket` to carry session identity (bot_id, org_id, role, scopes) instead of raw token |
| `src/ws/index.ts` (414 LOC) | Add session-based WS client path, sessionId→WsClient mapping, session revocation hooks, 60s heartbeat |
| `src/web-ui.ts` (671 LOC) | Migrate to shared SessionStore (remove in-memory Map), remove token from session |
| `src/index.ts` (256 LOC) | Initialize SessionStore, mount session middleware, start purge timer |
| `src/db.ts` (2867 LOC) | Add session CRUD methods to HubDB (delegates to SessionStore) |
| `docs/B2B-PROTOCOL.md` | Update auth sections: WS handshake, HTTP auth matrix, security model |

## Phases

Implementation is split into 6 phases, each independently testable and committable.

---

### Phase 1: Foundation — SessionStore + types + migration

**Goal:** Session infrastructure exists and passes unit tests. No behavior changes yet.

#### 1.1 Types (`src/types.ts`)

Add after the `BotToken` interface block (~line 237):

```ts
// ─── Sessions (ADR-002) ──────────────────────────────────────

export type SessionRole = 'bot_owner' | 'org_admin' | 'super_admin';

export interface Session {
  id: string;
  role: SessionRole;
  bot_id: string | null;       // set for bot_owner
  org_id: string | null;       // null for super_admin
  owner_name: string | null;   // set for bot_owner
  scopes: TokenScope[] | null; // carried from login token
  is_scoped_token: boolean;
  created_at: number;
  expires_at: number;
}
```

Extend `AuditAction` (line 272) to include:
```ts
| 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.session_revoked'
```

#### 1.2 SessionStore (`src/session.ts`)

```ts
export interface SessionStore {
  get(id: string): Promise<Session | null>;
  set(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByBotId(botId: string): Promise<number>;
  deleteByRole(role: string, orgId?: string): Promise<number>;
  countByRole(role: string, orgId?: string, botId?: string): Promise<number>;
  purgeExpired(): Promise<void>;
}
```

**SqliteSessionStore** — implements SessionStore using the existing `DatabaseDriver`:
- `get`: `SELECT * FROM sessions WHERE id = ? AND expires_at > ?`
- `set`: `INSERT OR REPLACE INTO sessions ...`
- `delete`: `DELETE FROM sessions WHERE id = ?`
- `deleteByBotId`: `DELETE FROM sessions WHERE bot_id = ?`
- `deleteByRole('org_admin', orgId)`: `DELETE FROM sessions WHERE role = ? AND org_id = ?`
- `deleteByRole('super_admin')`: `DELETE FROM sessions WHERE role = ?`
- `countByRole`: `SELECT COUNT(*) FROM sessions WHERE role = ? AND ...`
- `purgeExpired`: `DELETE FROM sessions WHERE expires_at < ?`

**RedisSessionStore** — for multi-replica deployments. Uses `ioredis` client. Key: `hxa:session:{id}`, TTL-based expiry. Secondary indexes via sorted sets for role/org/bot-based queries (deleteByRole, deleteByBotId, countByRole). Configured via `SESSION_STORE=redis` + `REDIS_URL` env vars.

#### 1.3 Database migration (`src/db/migrations/007-sessions.ts`)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  org_id TEXT,
  bot_id TEXT,
  owner_name TEXT,
  scopes TEXT,
  is_scoped_token INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_org_role ON sessions(org_id, role);
CREATE INDEX IF NOT EXISTS idx_sessions_bot ON sessions(bot_id);
```

Register migration in `src/db.ts` `init()` method alongside existing migrations.

---

### Phase 2: Login + session middleware + logout

**Goal:** `POST /api/auth/login` creates sessions. Session middleware loads session from cookie. No existing auth paths changed yet — new and old coexist.

#### 2.1 Session middleware (`src/session-middleware.ts`)

Express middleware that runs before route handlers:

1. Parse `hxa_session` cookie from `Cookie` header
2. Look up session in SessionStore
3. If valid: set `req.session` on the request object, apply sliding expiry (extend if past halfway)
4. If expired/missing: `req.session` remains undefined (not an error — Bearer auth still works)
5. CSRF validation for mutating requests (POST/PUT/PATCH/DELETE) with cookie auth:
   - Skip if `Authorization` header present (Bearer auth)
   - Check `Origin` header against `DOMAIN` env var or `Host`/`X-Forwarded-Host`
   - Reject if Origin missing or mismatched

Mount in `src/index.ts` before API routes — after `express.json()`, before `createRouter()`.

#### 2.2 Extend Request type (`src/auth.ts`)

Add to the global `Express.Request` interface:
```ts
session?: Session;
```

#### 2.3 Login endpoint (`src/routes.ts`)

Rework `POST /api/auth/login` (currently at `routes.ts:702-706`, creates org ticket):

```ts
// POST /api/auth/login — unified session login
// No auth middleware — this IS the auth endpoint
router.post('/api/auth/login', async (req, res) => {
  const { type } = req.body;

  switch (type) {
    case 'bot': {
      // Validate token, create bot_owner session
      const { token, owner_name } = req.body;
      // ... authenticate via db.getBotByToken or db.getBotTokenByToken
      // ... check concurrent session limit (5 per bot)
      // ... evict oldest if over limit
      // ... create session, set cookie, audit log
      break;
    }
    case 'org_admin': {
      // Validate org_secret, create org_admin session
      const { org_id, org_secret } = req.body;
      // ... timing-safe compare against org.org_secret
      // ... check concurrent session limit (5 per org)
      // ... create session (org_id set, bot_id null), set cookie, audit log
      break;
    }
    case 'super_admin': {
      // Validate admin_secret, create super_admin session
      const { admin_secret } = req.body;
      // ... timing-safe compare against config.admin_secret
      // ... check concurrent session limit (3)
      // ... create session (org_id null, bot_id null), set cookie, audit log
      break;
    }
    default:
      return res.status(400).json({ error: 'Invalid login type' });
  }
});
```

Cookie setting:
```ts
res.cookie(SESSION_COOKIE, session.id, {
  httpOnly: true,
  sameSite: 'strict',
  secure: !isDev,       // Secure only in production (HTTPS)
  path: '/',
  maxAge: ttlMs,
});
```

#### 2.4 Logout + session info endpoints

```ts
// POST /api/auth/logout — clear session
router.post('/api/auth/logout', (req, res) => {
  // Read session from cookie, delete from store, clear cookie
});

// GET /api/auth/session — current session info
router.get('/api/auth/session', (req, res) => {
  // Return session role, org, bot, expiry (never return token)
});
```

#### 2.5 Rate limiter (`src/rate-limit.ts`)

In-memory rate limiter with composite keys:

```ts
interface RateLimitEntry {
  failures: number;
  locked_until: number | null;
}

const limitStore = new Map<string, RateLimitEntry>();
```

- Key format: `${ip}:${type}:${identifier}`
- IP aggregate key: `ip:${ip}`
- Periodic cleanup: clear entries older than 30 minutes (setInterval in index.ts)
- Called at the top of POST /api/auth/login before any credential check

---

### Phase 3: Migrate auth guards

**Goal:** All admin endpoints accept session cookies. Legacy token auth still works (parallel paths).

#### 3.1 New middleware (`src/auth.ts`)

```ts
/**
 * Require session with one of the given roles.
 * Also accepts bot Bearer token with admin auth_role for backward compat (Phase 5 removes this).
 */
export function requireSessionRole(...roles: SessionRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Check session first
    if (req.session && roles.includes(req.session.role)) {
      // For org-scoped roles, verify org_id matches route context
      return next();
    }
    // Fallback: existing auth mechanisms (removed in Phase 5)
    // ...
    res.status(403).json({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
  };
}
```

#### 3.2 Migrate routes (`src/routes.ts`)

Replace guards one-by-one (each is a targeted edit):

| Current guard | Location | New guard |
|---------------|----------|-----------|
| `requireAdmin()` | Platform endpoints (POST/GET/PATCH/DELETE /api/orgs, invite codes) ~line 224-239 | `requireSessionRole('super_admin')` |
| `requireOrgAdmin()` | Org management endpoints ~line 248-255 | `requireSessionRole('org_admin', 'super_admin')` |
| Ticket auth in `authMiddleware` | `auth.ts:140-162` | Keep for now (Phase 5 removes) |

#### 3.3 Register with org_secret (`src/routes.ts`)

Update `POST /api/auth/register` (currently at `routes.ts:762-766`) to accept `{ org_id, org_secret }` as alternative to `{ org_id, ticket }`:
- If `org_secret` present: verify against org, register with `auth_role: 'admin'`
- If `ticket` present: existing flow, register with `auth_role: 'member'`

---

### Phase 4: WebSocket integration

**Goal:** Session-based WS connections work. Org ticket WS path still works (Phase 5 removes).

#### 4.1 Extend WsTicket (`src/ws-tickets.ts`)

```ts
export interface WsTicket {
  // Existing (kept for bot API flow)
  token?: string;
  orgId?: string;
  expiresAt: number;
  // New (session-based flow)
  sessionId?: string;
  role?: SessionRole;
  botId?: string;
  scopes?: TokenScope[] | null;
  isScopedToken?: boolean;
}
```

Update `issueWsTicket()` to accept either token (existing) or session identity (new):

```ts
export function issueWsTicket(auth: { token: string; orgId?: string } | {
  sessionId: string; role: SessionRole; botId?: string;
  orgId: string; scopes?: TokenScope[] | null; isScopedToken?: boolean;
}): string
```

#### 4.2 Update ws-ticket endpoint (`src/routes.ts`)

`POST /api/ws-ticket` (currently at `routes.ts:3216-3223`) — add session cookie support:

```ts
// If req.session exists (cookie auth):
if (req.session) {
  if (req.session.role === 'super_admin') {
    return res.status(403).json({ error: 'super_admin cannot use WebSocket' });
  }
  const ticketId = issueWsTicket({
    sessionId: req.session.id,
    role: req.session.role,
    botId: req.session.bot_id || undefined,
    orgId: req.session.org_id!,
    scopes: req.session.scopes,
    isScopedToken: req.session.is_scoped_token,
  });
  return res.json({ ticket: ticketId });
}
// Existing Bearer token flow unchanged
```

#### 4.3 Session-based WS connection (`src/ws/index.ts`)

In the `wss.on('connection')` handler, after redeeming the ticket:

```ts
if (redeemedTicket.sessionId) {
  // Session-based connection (human/admin via Web UI)
  const client: WsClient = {
    ws,
    sessionId: redeemedTicket.sessionId,
    role: redeemedTicket.role,
    botId: redeemedTicket.botId,
    orgId: redeemedTicket.orgId!,
    isOrgAdmin: redeemedTicket.role === 'org_admin',
    scopes: redeemedTicket.scopes ?? null,
    alive: true,
    subscriptions: new Set(),
  };
  this.clients.add(client);
  this.setupHandlers(client);
  return;
}
// Existing token-based flow continues below...
```

#### 4.4 WsClient type update (`src/ws/protocol.ts`)

Add to WsClient interface (`src/ws/protocol.ts:32-43`):
```ts
sessionId?: string;
role?: SessionRole;
```

#### 4.5 Session revocation hooks

Add to HubWS class:

```ts
/** Disconnect all WS clients tied to a specific session */
disconnectBySessionId(sessionId: string): void {
  for (const client of this.clients) {
    if (client.sessionId === sessionId) {
      client.ws.close(4002, 'Session revoked');
      this.clients.delete(client);
    }
  }
}
```

**Session heartbeat** — add to the existing 30s ping interval (or a separate 60s interval):

```ts
// Every 60s: validate session-based clients still have active sessions
setInterval(async () => {
  for (const client of this.clients) {
    if (client.sessionId) {
      const session = await sessionStore.get(client.sessionId);
      if (!session) {
        client.ws.close(4002, 'Session expired');
        this.clients.delete(client);
      }
    }
  }
}, 60_000);
```

#### 4.6 Wire up credential rotation → session + WS invalidation

Add a `disconnectByRole` method to HubWS (complements `disconnectBySessionId`):

```ts
/** Disconnect all WS clients with a given role (and optional org scope) */
disconnectByRole(role: SessionRole, orgId?: string): void {
  for (const client of this.clients) {
    if (client.role === role && (!orgId || client.orgId === orgId)) {
      client.ws.close(4002, 'Credential rotated');
      this.clients.delete(client);
    }
  }
}

/** Disconnect all WS clients tied to a specific bot */
disconnectByBotId(botId: string): void {
  for (const client of this.clients) {
    if (client.botId === botId) {
      client.ws.close(4002, 'Token regenerated');
      this.clients.delete(client);
    }
  }
}
```

This avoids the need to retrieve deleted session IDs — `deleteByRole`/`deleteByBotId` return counts only, so WS disconnection targets clients directly by role/org/bot metadata already present on `WsClient`.

Credential rotation handlers:

| Event | SessionStore call | HubWS call |
|-------|-------------------|------------|
| `org_secret` rotated | `sessionStore.deleteByRole('org_admin', orgId)` | `hubWs.disconnectByRole('org_admin', orgId)` |
| `admin_secret` changed | `sessionStore.deleteByRole('super_admin')` | (no WS — super_admin cannot use WS) |
| Bot token regenerated | `sessionStore.deleteByBotId(botId)` | `hubWs.disconnectByBotId(botId)` |

---

### Phase 5: Remove legacy auth + cleanup

**Goal:** All legacy token-based admin auth removed. Only session + bot Bearer remain.

#### 5.1 Remove org ticket admin auth (`src/auth.ts`)

Delete lines 140-162 (the `// Try org ticket` block in `authMiddleware`). After this, `authMiddleware` only handles bot tokens (primary + scoped).

#### 5.2 Remove `requireAdmin()` Bearer check (`src/routes.ts`)

Delete the `requireAdmin()` function (lines 224-239). All platform admin endpoints now use `requireSessionRole('super_admin')` exclusively.

#### 5.3 Remove org ticket WS auth (`src/ws/index.ts`)

Delete lines 184-213 (the `// Try org ticket` block in the WS connection handler). Admin WS connections now use session-based ws-tickets only.

#### 5.4 Migrate web-ui.ts to shared SessionStore

`src/web-ui.ts` currently has its own in-memory session Map (line 38). Migrate to the shared SessionStore:
- Remove `const sessions = new Map<string, Session>()`
- Remove `purgeExpiredSessions()`
- Use `sessionStore.get()` / `sessionStore.set()` / `sessionStore.delete()`
- Remove `token` field from session creation (use `bot_id` + `scopes` instead)
- Update ws-ticket issuance to use session identity instead of raw token

The `/ui/api/login` endpoint becomes a convenience wrapper around the main `POST /api/auth/login` with `type: 'bot'`.

#### 5.5 Remove old Dashboard

Delete `web/index.html` if still present (already replaced by Next.js Web UI). Remove the legacy admin routes in `src/index.ts` (lines 124-129).

#### 5.6 Update `requireOrg()` and `requireOrgOrBot()`

These existing helpers in `auth.ts` and `routes.ts` currently check `req.authType === 'org'`. Update to also accept session-based org_admin auth via `req.session?.role`.

---

### Phase 6: Documentation + audit

#### 6.1 Update B2B-PROTOCOL.md

Specific sections to update:
- **WS handshake** (~line 380): Add session-based ws-ticket flow alongside bot token flow
- **HTTP auth matrix** (~line 500): Add session cookie as auth option for org-admin endpoints
- **Security model** (~line 622): Replace org_secret→ticket description with unified session model
- **All org-admin endpoint descriptions**: Add "session cookie (org_admin/super_admin)" as auth option

#### 6.2 Add auth audit events

In each login/logout/revoke handler, call the existing audit log. Note: `audit_log.org_id` is a foreign key to `orgs(id)`, so audit calls must use a real org_id. For `super_admin` sessions (which have `org_id = null`), audit is only recorded when the action targets a specific org (e.g., rotating an org's secret). Platform-wide super_admin events (login/logout) are logged to the application log only — no `audit_log` row — because there is no org to attribute them to.

```ts
// bot_owner / org_admin — always have org_id
await db.recordAudit(
  session.org_id!,       // guaranteed non-null for bot_owner and org_admin
  session.bot_id,
  'auth.login',
  'session',
  session.id,
  { role: session.role, ip: req.ip, user_agent: req.headers['user-agent'] },
);

// super_admin — log to application log only (no org_id for FK)
logger.info('auth.login', { sessionId: session.id, role: 'super_admin', ip: req.ip });
```

---

## Dependency Graph

```
Phase 1 (foundation)
  ↓
Phase 2 (login + middleware)
  ↓
Phase 3 (migrate guards) ←── can test session login + admin endpoints
  ↓
Phase 4 (WebSocket)       ←── can test session WS connections
  ↓
Phase 5 (remove legacy)   ←── breaking change, must update all clients first
  ↓
Phase 6 (docs + audit)    ←── docs + runtime audit code; can run in parallel with Phase 5
```

## Testing Strategy

Each phase should pass existing tests before proceeding:

1. **Phase 1:** `npm test` — no behavior changes, new code only
2. **Phase 2:** Manual test: login via curl, verify cookie set, session in DB
3. **Phase 3:** Manual test: admin endpoints accept cookie; verify old Bearer still works
4. **Phase 4:** Manual test: Web UI WS connection via session cookie; verify bot WS still works
5. **Phase 5:** `npm test` + manual: verify legacy paths return 401, session paths work
6. **Phase 6:** Doc review + manual test: verify audit log entries for login/logout/revoke events (bot_owner, org_admin); verify super_admin login/logout logged to app log

## Rollback

Each phase is a separate commit. If issues are found post-merge:
- Phase 5 is the only breaking change — can be reverted independently
- Phases 1-4 are additive and safe to keep even if Phase 5 is reverted

## Deferred Scope

The following org management endpoints are deferred to a follow-up issue:

- `GET /api/org/tickets` — List active tickets
- `DELETE /api/org/tickets/:id` — Revoke ticket
- `GET /api/org/sessions` — List active sessions
- `DELETE /api/org/sessions/:id` — Force-logout session

These require Web UI integration and are not needed for the core auth system to function.

## Open Questions

None — all design decisions resolved in ADR-002 review (5 rounds, CLEAN).
