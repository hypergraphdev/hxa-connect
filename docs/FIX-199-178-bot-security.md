# Fix: Bot Identity Security — #199 + #178

**Date**: 2026-03-12
**Issues**: [#199 Admin bot identity hijack](https://github.com/coco-xyz/hxa-connect/issues/199), [#178 Bot registration TOCTOU](https://github.com/coco-xyz/hxa-connect/issues/178)
**Branch**: `fix/199-178-bot-security`

---

## 1. Issue Analysis

### #199 — Admin Bot Identity Hijack

**Root Cause**

`DELETE /api/bots/:id` (routes.ts) uses `requireOrgAdmin()` as its sole auth guard.
`requireOrgAdmin()` passes if `req.bot?.auth_role === 'admin'` — meaning any bot with admin role can delete any other bot in the same org.

```
// routes.ts line 278–283
function requireOrgAdmin(req, res): boolean {
  if (req.session?.role === 'org_admin' || req.session?.role === 'super_admin') return true;
  if (req.bot?.auth_role === 'admin') return true;  // ← too permissive
  ...
}
```

The handler (routes.ts:1225–1247) has NO additional check to prevent a bot from deleting another bot:

```
auth.delete('/api/bots/:id', async (req, res) => {
  if (!requireOrgAdmin(req, res)) return;
  // ← no check: is the requester a bot deleting someone else?
  const bot = await db.getBotById(req.params.id);
  await db.deleteBot(bot.id);   // proceeds unconditionally
  ...
});
```

**Attack Vector** (reproduced from live demo)

1. Admin bot calls `DELETE /api/bots/<victim_id>` → succeeds
2. Admin bot calls `POST /api/auth/register` with same name + `org_secret` → gets fresh token
3. Victim bot's WS connection drops; attacker now impersonates it in threads

**Impact**: Message forgery, identity hijack, no audit trail distinguishing the impersonation.

---

### #178 — Bot Registration TOCTOU Race Condition

**Root Cause**

The ticket registration path in `POST /api/auth/register` has three non-atomic steps:

```
Step 1  getBotByName(org, name)         → no conflict (line 1133)
Step 2  redeemOrgTicket(ticketId)       → ticket consumed (line 1139)
Step 3  registerBot(org, name, ...)     → INSERT bot (line 1160)
```

Between Step 1 and Step 3 there is a race window. With two concurrent requests using **different tickets** but the **same bot name**:

| Time | Request A | Request B |
|------|-----------|-----------|
| T1 | getBotByName → null | — |
| T2 | — | getBotByName → null |
| T3 | redeemOrgTicket(A) → success | — |
| T4 | — | redeemOrgTicket(B) → success |
| T5 | registerBot → INSERT (created=true, token returned) | — |
| T6 | — | registerBot → finds existing bot → UPDATE (created=false, token=null) |

**Result**: Request B gets HTTP 200 with no token. Ticket B is permanently consumed but unusable.

**Note**: PR #177 already fixed the same-ticket concurrent case via `UPDATE WHERE consumed=0` optimistic locking. This issue is the remaining different-ticket same-name race.

**Practical Risk**: Low — bot registration is a setup-time operation. But correctness is violated: a ticket is silently burned with no recovery path.

**Key DB fact**: `bots` table already has `UNIQUE(org_id, name)` constraint (db.ts:102), so the INSERT would fail at the DB level if it races.

---

## 2. Proposed Solution

### Fix A — #199: Restrict DELETE /api/bots/:id

**Principle**: A bot acting as admin should only be able to delete **itself**. Deletion of other bots must come from a human-operated session (org_admin or super_admin), not from another bot.

**Change** (routes.ts, `DELETE /api/bots/:id` handler):

```typescript
auth.delete('/api/bots/:id', async (req, res) => {
  if (!requireOrgAdmin(req, res)) return;

  // NEW: Bot tokens may only delete themselves.
  // Human sessions (org_admin / super_admin) may delete any bot.
  if (req.bot && req.bot.id !== req.params.id) {
    res.status(403).json({
      error: 'Bots may only delete themselves. Use DELETE /api/me.',
      code: 'FORBIDDEN',
    });
    return;
  }

  const orgId = req.session?.org_id || req.bot?.org_id || req.org?.id;
  const bot = await db.getBotById(req.params.id as string);
  if (!bot || bot.org_id !== orgId) {
    res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' });
    return;
  }

  await db.deleteBot(bot.id);
  await db.recordAudit(orgId!, bot.id, 'bot.delete', 'bot', bot.id, {
    name: bot.name,
    deleted_by: req.bot?.id ?? req.session?.id ?? 'unknown',
  });

  ws.broadcastToOrg(bot.org_id, {
    type: 'bot_offline',
    bot: { id: bot.id, name: bot.name },
  });

  res.json({ ok: true, message: `Bot "${bot.name}" deleted` });
});
```

**Key changes**:
1. Add self-only guard for bot requesters (3 lines)
2. Enrich audit log with `deleted_by` field (improves traceability)

**Considered alternatives**:
- Full bot ownership model (#199 long-term suggestion): overkill for now, requires DB migration. Deferred.
- Token rotation endpoint (`POST /api/bots/:id/rotate-token`): separate feature, not blocking this fix.

---

### Fix B — #178: Atomic Ticket Consumption + Bot Registration

**Principle**: Validate ticket, insert bot, and consume ticket must be a single atomic unit. If bot name already exists (UNIQUE constraint fires), the ticket is **not** consumed and the caller gets a clear NAME_CONFLICT error.

**New db.ts method**: `atomicRegisterBotWithTicket()`

```typescript
async atomicRegisterBotWithTicket(
  orgId: string,
  ticketId: string,
  name: string,
  metadata?: ...,
  ...profile
): Promise<{ bot: Bot; plaintextToken: string } | { conflict: 'NAME_CONFLICT' | 'TICKET_CONSUMED' | 'TICKET_EXPIRED' }> {

  return await this.driver.transaction(async (txn) => {
    // 1. Lock and re-validate ticket inside transaction
    const ticket = await txn.get(
      'SELECT * FROM org_tickets WHERE (id = ? OR code = ?) AND consumed = 0 AND (expires_at = 0 OR expires_at > ?)',
      [ticketId, ticketId, Date.now()]
    );
    if (!ticket) return { conflict: 'TICKET_CONSUMED' };   // expired or already consumed

    // 2. Attempt INSERT bot — UNIQUE(org_id, name) will throw on conflict
    const plaintextToken = `bot_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = HubDB.hashToken(plaintextToken);
    const botId = crypto.randomUUID();
    const now = Date.now();

    try {
      await txn.run(
        `INSERT INTO bots (id, org_id, name, token, ...) VALUES (?, ?, ?, ?, ...)`,
        [botId, orgId, name, tokenHash, ...]
      );
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE constraint')) {
        return { conflict: 'NAME_CONFLICT' };  // ticket NOT consumed (transaction not yet committed)
      }
      throw err;
    }

    // 3. Consume ticket (only reached if INSERT succeeded)
    if (!ticket.reusable) {
      await txn.run('UPDATE org_tickets SET consumed = 1 WHERE id = ? AND consumed = 0', [ticket.id]);
    }

    const bot = await txn.get('SELECT * FROM bots WHERE id = ?', [botId]);
    return { bot: this.rowToBot(bot), plaintextToken };
  });
}
```

**Route change** (routes.ts, ticket path in `POST /api/auth/register`):

```typescript
// Replace the existing ticket path (lines 1108–1156) with:
const result = await db.atomicRegisterBotWithTicket(org_id, ticketId, validated.name, ...);
if ('conflict' in result) {
  if (result.conflict === 'NAME_CONFLICT')
    return res.status(409).json({ error: 'A bot with this name already exists', code: 'NAME_CONFLICT' });
  if (result.conflict === 'TICKET_CONSUMED')
    return res.status(401).json({ error: 'Ticket already consumed or expired', code: 'TICKET_CONSUMED' });
}
// result is { bot, plaintextToken } — proceed with audit log + response
```

**Guarantee**: Either (bot created + ticket consumed) or (bot not created + ticket untouched). No partial state.

---

## 3. Solution Review — Multi-Angle

### Security Review

| Concern | Fix A (#199) | Fix B (#178) |
|---------|-------------|-------------|
| Admin bot self-delete via `/api/bots/:id` still works? | ✅ Yes (req.bot.id === req.params.id passes) | n/a |
| Human org_admin session can still delete any bot? | ✅ Yes (req.bot is undefined for session auth) | n/a |
| Can attacker bypass by spoofing req.bot? | N/A — req.bot is set by auth middleware from verified token | n/a |
| Ticket burned on name conflict? | n/a | ✅ No — conflict returns before ticket consumed |
| Ticket double-spend (same ticket, concurrent)? | n/a | ✅ Still protected by the `consumed=0` WHERE clause inside transaction |
| Rollback safety on INSERT error? | n/a | ✅ Transaction wraps INSERT + ticket consume; any error rolls both back |

### Edge Cases

**Fix A — #199**:
1. `DELETE /api/bots/:id` where `:id` is the calling bot itself → passes guard, proceeds normally ✅
2. `DELETE /api/bots/:id` called from `org_admin` session (human) → `req.bot` is undefined → guard skipped, full delete allowed ✅
3. `DELETE /api/bots/:id` called from `super_admin` session → same as above ✅
4. `DELETE /api/bots/:id` called from admin bot targeting another bot → 403 FORBIDDEN ✅
5. What if admin bot uses `DELETE /api/me` to delete itself? → unaffected, that endpoint uses `requireBot` not `requireOrgAdmin` ✅

**Fix B — #178**:
1. Reusable ticket: ticket is NOT consumed regardless of outcome → fine, reusable tickets skip the consume step ✅
2. Expired ticket: caught by `expires_at > ?` in the SELECT inside transaction → returns TICKET_CONSUMED ✅
3. Bot name conflict with existing bot: INSERT fails → UNIQUE constraint → NAME_CONFLICT returned, ticket untouched ✅
4. DB driver error mid-transaction (e.g., disk full): transaction rolls back; ticket not consumed, bot not created ✅
5. The `atomicRegisterBotWithTicket` is only for the **ticket path**. The `org_secret` path (admin registration) doesn't use tickets — no change needed there ✅

### Backwards Compatibility

- Fix A: No API contract change. 403 FORBIDDEN for a previously-allowed operation. This is intentional — the previous behavior was a security bug.
- Fix B: No API contract change. The 409 NAME_CONFLICT response already existed. The difference is internal (when exactly the ticket is consumed).

### Audit Logging

- Fix A: Added `deleted_by` to audit record. Previously, the audit only logged `{ name }`, which didn't identify WHO performed the deletion.
- Fix B: Audit record for `bot.register` remains unchanged — still logged after successful registration.

### Issues Found in Solution (Round 1)

1. **Fix B — PostgreSQL compatibility**: SQLite throws `SQLITE_CONSTRAINT_UNIQUE`. PostgreSQL throws error code `23505` with `constraint` field. The error catch must handle both. → Need `err.code === '23505'` check alongside SQLite check.

2. **Fix B — `txn` interface**: The `driver.transaction()` callback receives a transaction object. Must verify that `txn.get()`, `txn.run()`, and `txn.all()` are available on the transaction interface (vs just the driver). Check `db.ts` driver abstraction.

3. **Fix B — `atomicRegisterBotWithTicket` signature**: The full bot profile params (bio, role, webhook_url, etc.) make the signature unwieldy. Should accept a single `params` object matching `validateRegistrationBody` output to stay maintainable.

4. **Fix A — Audit `deleted_by` for session**: `req.session?.id` exposes the session ID. Better to use `req.session?.owner_name` or just record `{ via: 'session' }` to avoid leaking session IDs.

5. **Fix B — `rowToBot` not available inside transaction**: `this.rowToBot()` / `this.rowToOrgTicket()` are instance methods — they are accessible within the callback (closure over `this`), but note that the final SELECT must use `txn.get`, not `this.driver.get`, to read within the same transaction for consistency.

---

## 4. Revised Solution (after Round 1 review)

### Fix A (revised)
- Use `req.session ? 'session' : req.bot?.id` for `deleted_by` in audit (avoids leaking session ID)

### Fix B (revised)
- Accept `params` object instead of positional args
- Handle both SQLite (`SQLITE_CONSTRAINT_UNIQUE`) and PostgreSQL (`23505`) unique constraint errors
- Use `txn.get` for all reads inside transaction
- Move complex bot field construction outside transaction (it's pure computation, no DB side effects)

---

## 5. Implementation Plan

### Files to change
1. **`src/db.ts`**: Add `atomicRegisterBotWithTicket()` method
2. **`src/routes.ts`**:
   - `DELETE /api/bots/:id`: add self-only guard for bot callers
   - `POST /api/auth/register` ticket path: replace with `atomicRegisterBotWithTicket()` call

### No schema changes required
- `UNIQUE(org_id, name)` already exists on `bots` table
- No new tables or columns

### Testing
- Unit test: concurrent registration (two tickets, same name) → exactly one token, one ticket consumed
- Unit test: admin bot delete another bot → 403
- Unit test: admin bot delete self → 200
- Unit test: org_admin session delete any bot → 200
