# ADR-002: Unified Session Auth

**Date:** 2026-03-03
**Status:** Accepted
**Issue:** [#111](https://github.com/coco-xyz/hxa-connect/issues/111)
**Participants:** Howard Zhou (owner), Zylos (design), Codex (independent review — 5 rounds, CLEAN)

## Context

The current auth system conflates org tickets with admin sessions. Org tickets were designed for bot registration, but are also used as Bearer tokens for admin API access. This creates a privilege escalation risk: any reusable invite ticket can be used as an admin session token.

The new Web UI (`web-ui.ts`) implements cookie-based sessions for bot owners, though it still stores raw tokens in session state for WS ticket issuance and allows missing Origin on mutating requests. Org admins and super admins still use raw tokens (org ticket / admin_secret) as Bearer auth. This redesign addresses all of these issues.

### Current Problems

1. **Ticket/session conflation** — `org_tickets` table serves dual purpose (invite + admin auth), with no `purpose` field
2. **No session management** — Admins can't be force-logged-out; credential rotation doesn't invalidate active connections
3. **Token exposure** — Old Dashboard stores tickets in `sessionStorage`; admin_secret sent as Bearer on every request
4. **Inconsistent auth** — Three different auth mechanisms (bot token, org ticket, admin_secret) with different security properties

## Decision

Replace all human-facing token auth with unified cookie-based sessions. One login endpoint, three roles, HttpOnly cookies.

### Design Principle

Each credential type has **one primary purpose**:

| Credential | Purpose |
|-----------|---------|
| **Org ticket** | Bot registration only |
| **Platform invite code** | Org creation only |
| **org_secret** | Org-level root credential: org admin login, admin bot registration, ticket generation |
| **admin_secret** | Super admin login only |
| **Bot token** | Bot identity: owner login, API auth, WS connection |

## Specification

### 1. Unified Login

**`POST /api/auth/login`** — single entry point with `type` field:

```jsonc
// Bot Owner
{ "type": "bot", "token": "bot-token-xxx", "owner_name": "Howard" }

// Org Admin
{ "type": "org_admin", "org_id": "org-xxx", "org_secret": "secret-xxx" }

// Super Admin
{ "type": "super_admin", "admin_secret": "admin-secret-xxx" }
```

Returns an **HttpOnly session cookie** (`hxa_session`). Credentials transmitted once at login only.

### 2. Session Structure

```ts
interface Session {
  id: string;
  role: 'bot_owner' | 'org_admin' | 'super_admin';
  bot_id?: string;
  org_id: string | null;       // null for super_admin (cross-org)
  owner_name?: string;
  scopes?: TokenScope[];        // carried from login token, not stored as token
  is_scoped_token?: boolean;
  created_at: number;
  expires_at: number;
}
```

Sessions do **NOT** store bot tokens — only identity metadata. This limits blast radius if the sessions table is exposed.

### 3. Authorization Middleware

| Guard | Allows |
|-------|--------|
| `requireBotOwner()` | `bot_owner` (scoped to own bot) |
| `requireOrgAdmin()` | `org_admin` + `super_admin` |
| `requireSuperAdmin()` | `super_admin` only |

- `super_admin` implicitly has org admin permissions for all orgs (skip org_id matching)
- `org_admin` is scoped to their own org
- `bot_owner` is scoped to their own bot

### 4. Session Storage

#### SessionStore Interface

```ts
interface SessionStore {
  get(id: string): Promise<Session | null>;
  set(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByRole(role: string, orgId?: string): Promise<number>;
  purgeExpired(): Promise<void>;
}
```

`deleteByRole` behavior:
- `deleteByRole('org_admin', orgId)` — all org_admin sessions for a specific org
- `deleteByRole('super_admin')` — all super_admin sessions (no orgId)
- `deleteByRole('bot_owner', orgId)` — all bot_owner sessions in an org

#### SqliteSessionStore (default)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  org_id TEXT,                 -- NULL for super_admin
  bot_id TEXT,
  owner_name TEXT,
  scopes TEXT,                 -- JSON array of TokenScope
  is_scoped_token INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_org_role ON sessions(org_id, role);
```

#### RedisSessionStore (optional)

For multi-replica deployments. Key: `hxa:session:{id}`, TTL-based expiry, secondary index `hxa:sessions:role:{role}`.

```env
SESSION_STORE=redis
REDIS_URL=redis://localhost:6379
```

### 5. Session Expiry

| Role | TTL |
|------|-----|
| `bot_owner` | 24h |
| `org_admin` | 8h |
| `super_admin` | 4h |

**Sliding expiry:** Extend on request if past halfway point. Background purge every 15 minutes.

**Forced logout on credential rotation:**

| Event | Action |
|-------|--------|
| `org_secret` rotated | Delete all `org_admin` sessions for that org + close WS |
| `admin_secret` changed | Delete all `super_admin` sessions |
| Bot token regenerated | Delete all `bot_owner` sessions for that bot + close WS |

### 6. Cookie Security

```
Set-Cookie: hxa_session={id};
  HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age={ttl}
```

**CSRF:** `SameSite=Strict` + Origin header validation on mutating requests.

**Origin validation:**
1. Origin present → must match `DOMAIN` env var or `Host` header
2. Origin missing → reject for cookie-auth requests (Bearer token requests skip)
3. Behind proxy → trust `X-Forwarded-Host` only if `TRUST_PROXY=true`

```ts
function validateOrigin(req: Request): boolean {
  if (req.headers.authorization) return true;  // skip for Bearer
  const origin = req.headers.origin;
  if (!origin) return false;
  const expectedHost = process.env.DOMAIN
    || (process.env.TRUST_PROXY
      ? (req.headers['x-forwarded-host'] || req.headers.host)
      : req.headers.host);
  return new URL(origin).host === expectedHost;
}
```

Session ID: `crypto.randomBytes(32).toString('hex')` (256-bit).

### 7. WebSocket Integration

**Endpoint:** `POST /api/ws-ticket` (single endpoint, two auth methods).

**Eligible sessions:** `bot_owner` and `org_admin` only. `super_admin` does not use WS — all super_admin operations are HTTP-only. Rejects `super_admin` sessions with 403.

#### Session-based flow

```
Browser → POST /api/ws-ticket (Cookie) → { ticket }
Browser → WS /ws?ticket=xxx → connected (with session identity + scopes)
```

ws-ticket carries identity metadata (bot_id, org_id, role, scopes) directly from the session. It does **NOT** look up the bot's primary token from the bots table. This prevents scoped-token privilege escalation.

#### Bot API flow (unchanged)

Bots use `POST /api/ws-ticket` with Bearer token. Endpoint detects auth method:
- Cookie → session-based flow
- Bearer → bot API flow

#### WsClient

```ts
interface WsClient {
  ws: WebSocket;
  sessionId?: string;
  role?: SessionRole;       // 'bot_owner' | 'org_admin'
  botId?: string;
  orgId: string;
  isOrgAdmin: boolean;
  scopes: TokenScope[] | null;
  alive: boolean;
  subscriptions: Set<string>;
}
```

#### WS Session Revocation

1. **Immediate:** Session delete triggers WS disconnect via `sessionId → WsClient` lookup
2. **Periodic heartbeat** (60s): Validate session existence, close if expired/deleted

### 8. Login Rate Limiting

Composite key: `IP + login_type + identifier`

| Login type | Key |
|-----------|-----|
| `bot` | IP + "bot" + token_prefix (8 chars) |
| `org_admin` | IP + "org_admin" + org_id |
| `super_admin` | IP + "super_admin" |

- 5 failures per key → 15 min lockout
- 20 failures per IP (all keys) → 15 min IP-wide lockout
- `super_admin`: 3 failures → 30 min lockout

### 9. Audit Log

- `auth.login` — success (role, IP, user-agent)
- `auth.login_failed` — failure (type, IP)
- `auth.logout` — voluntary
- `auth.session_revoked` — forced (rotation, admin kick)

### 10. Concurrent Session Limits

| Role | Limit |
|------|-------|
| `bot_owner` | 5 per bot |
| `org_admin` | 5 per org |
| `super_admin` | 3 |

Oldest session evicted (FIFO) when limit reached.

## API Changes

### Simplified Bot Onboarding (2 steps)

```
1. POST /api/platform/orgs  { invite_code, name }
   → { org_id, org_secret }

2. POST /api/auth/register  { org_id, org_secret, name, ...profile }
   → { bot_id, token, auth_role: 'admin' }
```

Invited bots use ticket: `{ org_id, ticket, ... }` → `auth_role: 'member'`

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/auth/login` | Rework: unified session login, returns HttpOnly cookie |
| `POST /api/auth/register` | Add org_secret path for admin bot registration |
| `POST /api/org/tickets` | Auth: session (`org_admin`/`super_admin`) or admin bot Bearer |
| `POST /api/org/rotate-secret` | Auth: session or admin bot token |
| `PATCH /api/org/settings` | Auth: session (`org_admin`/`super_admin`) or admin bot token |
| `GET /api/org/settings` | Same |
| `GET /api/org/threads` | Same |
| `PATCH /api/org/bots/:bot_id/role` | Same |
| `GET /api/audit` | Same |
| All `requireAdmin()` endpoints | Auth: session (`super_admin`) only |
| `POST /api/ws-ticket` | Add session cookie support alongside bot Bearer |

### New Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/auth/logout` | Session cookie | Clear session, unset cookie |
| `GET /api/auth/session` | Session cookie | Current session info |

### Removed

| Item | Reason |
|------|--------|
| Org ticket as admin auth (`auth.ts:140-162`) | Tickets for registration only |
| `requireAdmin()` Bearer check (`routes.ts:224-239`) | Super admin uses session |
| Org ticket WS auth (`ws/index.ts:184-213`) | Session-based ws-ticket |
| Old Dashboard (`web/index.html`) | Replaced by Web UI |

## B2B Protocol Update

`B2B-PROTOCOL.md` must be updated in lockstep:
- Org-admin endpoint auth: org ticket → session cookie or admin bot token
- WS subscribe/unsubscribe: org-ticket-auth → session-auth
- WS handshake: token-only auth description → add session-based ws-ticket path (~line 380)
- WS/HTTP auth matrix: update row to reflect session cookie option (~line 500)
- Security model: org_secret→ticket flow → unified session auth (~line 622)
- Any other references to org ticket as admin credential or admin_secret as Bearer

## Migration Steps

1. Add `sessions` table, `SessionStore` interface + SQLite implementation
2. Add `POST /api/auth/login` (unified) + `POST /api/auth/logout` + `GET /api/auth/session`
3. Add session middleware: cookie parsing, session loading, sliding expiry
4. Refactor `requireOrgAdmin()` → check session role
5. Refactor `requireAdmin()` → check session role
6. Update `POST /api/ws-ticket` to accept session cookies (bot_owner and org_admin only; reject super_admin)
7. Add WS session revocation (immediate + heartbeat)
8. Add login rate limiting
9. Update `POST /api/auth/register` to accept org_secret for admin registration
10. Remove legacy auth paths (org ticket admin, admin_secret Bearer, old Dashboard)
11. Update `B2B-PROTOCOL.md`
12. Add audit log events

## Deferred Scope / Future Work

The following management endpoints are out of scope for this PR and will be implemented in a follow-up issue:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/org/tickets` | Session or admin bot | List active tickets |
| `DELETE /api/org/tickets/:id` | Session or admin bot | Revoke ticket |
| `GET /api/org/sessions` | Session (`org_admin`+) | List active sessions |
| `DELETE /api/org/sessions/:id` | Session (`org_admin`+) | Force-logout session |

These endpoints require additional UX design for the Web UI and are not needed for the core auth redesign to function.

## Review History

| Round | Findings | Key Issues |
|-------|----------|------------|
| R1 | 3P1 + 4P2 + 2P3 | org_secret powers (dismissed), WS revocation, token in session, endpoint naming |
| R2 | 1P1 + 5P2 | Scoped-token WS escalation, doc contradictions from amendments |
| R3 | 2P2 | Principle text incomplete, super_admin WS undefined |
| R4 | 1P3 | WS revocation wording for super_admin |
| Final | CLEAN | Dismissed rationale validated |
