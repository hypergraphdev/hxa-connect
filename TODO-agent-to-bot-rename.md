# Plan: Rename "agent" → "bot" + rebrand "BotsHub" → "HXA Connect"

## Context
Two renames in one pass:
1. **agent → bot**: The codebase uses "agent" to refer to AI bots, but the UI already says "Bot". Unify terminology. DB tables also rename.
2. **BotsHub → HXA Connect**: Product rebrand. Package name, env vars, display name, Docker all change.

No backward compatibility needed. Work on branch `refactor/agent-to-bot` off `main`.

## Current Mixed State
Some newer tables already use `bot_id` (thread_participants, catchup_events, rate_limit_events, audit_log). Older parts still use `agent`/`agent_id`. This rename completes the unification.

---

## Key Design Decisions

### Product rebrand naming convention

| Context | Old | New |
|---|---|---|
| npm package | `bots-hub` | `hxa-connect` |
| SDK npm package | `@botshub/sdk` | `@hxa-connect/sdk` |
| Display name | `BotsHub` | `HXA Connect` |
| Env var prefix | `BOTSHUB_*` | `HXA_CONNECT_*` |
| Version endpoint | `server: 'botshub'` | `server: 'hxa-connect'` |
| Docker user/group | `botshub` | `hxa` |
| Docker service/volume | `botshub` / `botshub-data` | `hxa-connect` / `hxa-connect-data` |
| Install script banner | `BotsHub` | `HXA Connect` |
| Protocol name | `B2B Protocol` | keep as-is (protocol identity) |

### `/api/bots` route consolidation
Current state: two separate list endpoints with different auth:
- `GET /api/agents` — org-only (`requireOrg`), paginated (`{items, has_more, next_cursor}`), with `search/cursor/limit` params
- `GET /api/bots` — org or agent (`requireScope('read')`), returns flat array, with `role/tag/status/q` filter params

**Decision:** Consolidate into single handler under unified path:
- `GET /api/bots` — the main list endpoint, auth `requireScope('read')`:
  - If caller is org (ticket): paginated behavior with `search/cursor/limit` (migrated from old `/api/agents`)
  - If caller is bot (token): returns flat array with `role/tag/status/q` filters (current `/api/bots` behavior)
  - Response shape is caller-specific (org gets `{items, has_more, next_cursor}`, bot gets flat array)
  - Note: org callers previously using `/api/bots` (flat array) will see new paginated shape — acceptable since web UI is updated simultaneously and no backward compat is needed
- `GET /api/bots/:id` — single bot by ID (migrated from `/api/agents/:id`)
- `DELETE /api/bots/:id` — delete bot (migrated from `/api/agents/:id`)

### `listAgents`/`listBots` method collision
Current state: `listAgents(orgId)` (unfiltered) and `listBots(orgId, filters?)` (with filters) coexist.

**Decision:** Remove `listAgents`, keep only `listBots(orgId, filters?)`. Callers that don't need filters pass no filter arg. The existing `listBots` already handles this — `listAgents` is just the older unfiltered version.

### Token prefix — no change
Existing tokens use `agent_` prefix. Changing this would invalidate all issued tokens. Token prefix stays `agent_` for backward compatibility. This is an internal implementation detail not visible to users.

### Audit `target_type` values
`target_type: 'agent'` in audit records → change to `'bot'`. Existing audit rows keep old value (historical data, no migration needed for stored strings).

---

## Execution Order

### Step 1: Create branch
```
git checkout -b refactor/agent-to-bot
```

### Step 2: `src/types.ts` — Core type definitions
- `Agent` → `Bot`
- `AgentProfileInput` → `BotProfileInput`
- `AgentToken` → `BotToken`
- Field: `AgentToken.agent_id` → `BotToken.bot_id`
- Field: `ChannelMember.agent_id` → `ChannelMember.bot_id`
- WS events: `agent_online`/`agent_offline` → `bot_online`/`bot_offline`, payload key `agent` → `bot`
- Response types: `agent_id` → `bot_id` in RegisterResponse etc.
- Keep `AuthRole` as-is

### Step 3: `src/db.ts` — Database layer (~196 agent occurrences + 1 botshub)
- DB filename: `botshub.db` → `hxa-connect.db`. At startup, if `hxa-connect.db` doesn't exist but `botshub.db` does, rename it automatically (+ rename `botshub.db-wal` and `botshub.db-shm` if present)

**DB Migration (new migration `014_rename_agents_to_bots`):**
- Wrap entire migration in a transaction for atomicity
- **Guard**: check if `agents` table exists before renaming (on fresh DBs, schema init already creates `bots`/`bot_tokens` directly — migration should be a no-op)
- Rename table `agents` → `bots` (via `ALTER TABLE agents RENAME TO bots`)
- Rename table `agent_tokens` → `bot_tokens`
- Recreate `channel_members` with `bot_id` replacing `agent_id` (SQLite no ALTER COLUMN)
- Recreate `webhook_status` with `bot_id` replacing `agent_id`
- Recreate `bot_tokens` with `bot_id` replacing `agent_id`
- Recreate all affected indexes with new names

**Old migrations — leave unchanged but add try/catch guards:**
Older migrations (002, 007, 012 etc.) hardcode `agents`/`agent_tokens` table names. Do NOT rename references — instead ensure every statement is wrapped in try/catch so they no-op gracefully on fresh DBs where tables have new names:
- On **existing DBs**: they've already run and won't re-run (recorded in migrations table). Migration 014 then renames the tables.
- On **fresh DBs**: schema init creates `bots`/`bot_tokens` directly. Old migrations attempt queries against `agents`/`agent_tokens` → fail silently via try/catch. Migration 014 sees no `agents` table → no-op.
- Specific guards needed:
  - `002_add_agent_profile_fields`: the `UPDATE agents SET version = '1.0.0'` at the end is NOT in try/catch — wrap it
  - `007_hash_plaintext_tokens` / `migrateHashTokens()`: `SELECT ... FROM agents` and `SELECT ... FROM agent_tokens` are NOT in try/catch — wrap entire method body
  - `012_add_agent_auth_role`: already has try/catch (ALTER TABLE) — verify the UPDATE also has it

**Schema init (CREATE TABLE statements):**
- `agents` → `bots`
- `agent_tokens` → `bot_tokens`
- `channel_members.agent_id` → `channel_members.bot_id`
- `webhook_status.agent_id` → `webhook_status.bot_id`
- All `REFERENCES agents(id)` → `REFERENCES bots(id)` throughout (threads.initiator_id, thread_messages.sender_id, messages.sender_id, channel_members, webhook_status, etc.)
- Update all index names
- Also update FK refs in migration 008 table-recreate SQL (threads, thread_messages, thread_participants, files)

**Method renames:**
- `registerAgent` → `registerBot`
- `getAgentByToken` → `getBotByToken`
- `getAgentById` → `getBotById`
- `getAgentByName` → `getBotByName`
- Remove `listAgents(orgId)` — callers use existing `listBots(orgId, filters?)` instead
- `listAgentsPaginated` → `listBotsPaginated`
- `deleteAgent` → `deleteBot`
- `setAgentOnline` → `setBotOnline`
- `setAgentAuthRole` → `setBotAuthRole`
- `touchAgentLastSeen` → `touchBotLastSeen`
- `listChannelsForAgent` → `listChannelsForBot`
- `listThreadsForAgent` → `listThreadsForBot`
- `rowToAgent` → `rowToBot`
- `createAgentToken` → `createBotToken`
- `getAgentTokenByToken` → `getBotTokenByToken`
- `listAgentTokens` → `listBotTokens`
- `revokeAgentToken` → `revokeBotToken`
- `touchAgentToken` → `touchBotToken`
- `rowToAgentToken` → `rowToBotToken`
- All parameter names `agentId` → `botId`
- All SQL strings referencing `agents`/`agent_tokens` table names → `bots`/`bot_tokens`

### Step 4: `src/auth.ts` — Auth middleware (~39 occurrences)
- `req.agent` → `req.bot` (Express Request augmentation)
- `authType: 'agent'` → `authType: 'bot'`
- `requireAgent` middleware → `requireBot`
- Internal variable names: `agent` → `bot`
- Error messages: "Agent" → "Bot"

### Step 5: `src/routes.ts` — API routes (~290 occurrences)

**Endpoint path renames:**
- `GET /api/agents` → merge into `GET /api/bots` (see design decision above)
- `GET /api/agents/:id` → `GET /api/bots/:id`
- `DELETE /api/agents/:id` → `DELETE /api/bots/:id`
- `PATCH /api/org/agents/:agent_id/role` → `PATCH /api/org/bots/:bot_id/role`

**Existing `/api/bots` routes** (keep paths):
- `GET /api/bots/:name/profile`
- `GET /api/bots/:name/webhook/health`

**Handler code:**
- All `req.agent` → `req.bot`
- All `req.agent!.id` → `req.bot!.id`
- All `req.agent!.org_id` → `req.bot!.org_id`
- Variable names `agent`/`agentId` → `bot`/`botId`
- Response fields: `agent_id` → `bot_id`, `agent_count` → `bot_count`
- Helper: `requireAgent` → `requireBot` calls
- Helper: `requireOrgOrAgent` → `requireOrgOrBot`
- Helper: `toAgentResponse` → `toBotResponse`
- Audit strings: `target_type: 'agent'` → `target_type: 'bot'`
- Version endpoint: `server: 'botshub'` → `server: 'hxa-connect'` (in `/api/version` handler)
- JSDoc comments: `BOTSHUB_ADMIN_SECRET` → `HXA_CONNECT_ADMIN_SECRET` (~4 occurrences in route comments)

### Step 6: `src/ws.ts` — WebSocket (~88 occurrences)
- `WsClient.agentId` → `WsClient.botId`
- `agentConnectionCount` → `botConnectionCount`
- `incrementAgentConnections` → `incrementBotConnections`
- `decrementAgentConnections` → `decrementBotConnections`
- `connected_agents` → `connected_bots` (in getHealthStats)
- Event types: `agent_online`/`agent_offline` → `bot_online`/`bot_offline`
- Event payload: `agent: { id, name }` → `bot: { id, name }`
- All internal `agent`/`agentId` variables → `bot`/`botId`

### Step 7: `src/webhook.ts` — Webhook (~10 occurrences)
- Parameter names `agentId` → `botId`
- Internal variable renames

### Step 8: `src/index.ts` — Startup + health + env vars
- Console messages: "Agent-to-Agent" → "Bot-to-Bot"
- Health endpoint: `connected_agents` → `connected_bots`
- All `BOTSHUB_*` env var references → `HXA_CONNECT_*`:
  - `BOTSHUB_PORT` → `HXA_CONNECT_PORT`
  - `BOTSHUB_HOST` → `HXA_CONNECT_HOST`
  - `BOTSHUB_DATA_DIR` → `HXA_CONNECT_DATA_DIR`
  - `BOTSHUB_PERSIST` → `HXA_CONNECT_PERSIST`
  - `BOTSHUB_CORS_ORIGINS` / `BOTSHUB_CORS` → `HXA_CONNECT_CORS_ORIGINS` / `HXA_CONNECT_CORS`
  - `BOTSHUB_MAX_MSG_LEN` → `HXA_CONNECT_MAX_MSG_LEN`
  - `BOTSHUB_LOG_LEVEL` → `HXA_CONNECT_LOG_LEVEL`
  - `BOTSHUB_ADMIN_SECRET` → `HXA_CONNECT_ADMIN_SECRET`
  - `BOTSHUB_FILE_UPLOAD_MB_PER_DAY` → `HXA_CONNECT_FILE_UPLOAD_MB_PER_DAY`
  - `BOTSHUB_MAX_FILE_SIZE_MB` → `HXA_CONNECT_MAX_FILE_SIZE_MB`
### Step 8b: `src/logger.ts` — Logger env var
- `BOTSHUB_LOG_LEVEL` → `HXA_CONNECT_LOG_LEVEL`

### Step 9: `sdk/src/types.ts` + `sdk/src/client.ts` — SDK
- Same type renames as src/types.ts
- Method names, imports
- `sdk/src/protocol-guide.ts`, `sdk/src/thread-context.ts` — update BotsHub references → HXA Connect
- `sdk/src/index.ts` — update any BotsHub references

### Step 10: `web/index.html` — Main frontend (~41 agent + ~10 botshub occurrences)
- API call URLs: `/api/agents` → `/api/bots`
- JS variable names: `agents` object → `bots`, `agentId` → `botId`
- Display text referencing "agent"
- deleteAgent → deleteBot function name
- Title/display: "BotsHub" → "HXA Connect"

### Step 11: `web/admin.html` — Admin UI (~7 agent + ~1 botshub occurrences)
- `agent_count` → `bot_count` references
- `stat-agents` → `stat-bots` element ID
- Display labels
- `BOTSHUB_ADMIN_SECRET` placeholder → `HXA_CONNECT_ADMIN_SECRET`
- Title/display: "BotsHub" → "HXA Connect"

### Step 12: `web/styles.css`
- `.agent-status` → `.bot-status` (and any other agent class names)

### Step 13: Test files
- `test/integration.test.ts` (~214 occurrences) — agent renames + "BotsHub" comment
- `test/phase5-auth.test.ts` (~105 occurrences)
- `test/helpers.ts` (~8 occurrences) — `connected_agents` → `connected_bots`, `botshub-test-` → `hxa-connect-test-`
- Function names, variables, assertions, API paths

### Step 14: Documentation & config
- `README.md` — all agent→bot renames + all `BOTSHUB_*` → `HXA_CONNECT_*` env var refs + "BotsHub" → "HXA Connect" display name (~41 botshub occurrences)
- `docs/B2B-PROTOCOL.md` — "BotsHub" → "HXA Connect" (~29 occurrences); keep "Agent" in A2A protocol concept comparisons (external standard name)
- `docs/org-auth-implementation-plan.md` — `BOTSHUB_ADMIN_SECRET` refs (~12 occurrences)
- `docs/org-auth-redesign.md` — `BOTSHUB_ADMIN_SECRET` refs (~7 occurrences)
- `package.json` — `name: "hxa-connect"`, description/keywords, version bump to `0.2.0`
- `sdk/package.json` — `name: "@hxa-connect/sdk"`, description, version bump to `0.2.0`
- Run `npm install` to regenerate `package-lock.json` with updated versions
- `install.sh` — "Agent-to-Agent" → "Bot-to-Bot", all `BOTSHUB_*` → `HXA_CONNECT_*`, "BotsHub" → "HXA Connect" (~37 occurrences)
- `skill/SKILL.md` — update agent references to bot + "BotsHub" → "HXA Connect" (~12 occurrences)

### Step 15: Docker & deployment
- `Dockerfile` — user/group `botshub` → `hxa`, env var defaults `BOTSHUB_*` → `HXA_CONNECT_*`
- `docker-compose.yml` — service name `botshub` → `hxa-connect`, volume `botshub-data` → `hxa-connect-data`, env vars

---

## Verification
1. `npm run build` — TypeScript compiles without errors
2. `npm test` — All tests pass (after installing deps)
3. Start dev server — login, dashboard, bot profile, channels, threads all work
4. Verify DB migration: start with existing `agents` table → auto-migrates to `bots` table
5. Agent grep check: `rg -i 'agent' --glob '!node_modules' --glob '!package-lock.json' .` — allowed residuals:
   - Token prefix `agent_` in auth code (backward compat)
   - `docs/B2B-PROTOCOL.md` — keeps "Agent" in A2A protocol concept comparisons (external standard name)
   - Comments/docs explaining the rename itself
6. BotsHub grep check: `rg -i 'botshub|bots-hub|bots_hub' --glob '!node_modules' --glob '!package-lock.json' .` — should return zero matches
7. Env var check: `rg 'BOTSHUB_' --glob '!node_modules' --glob '!package-lock.json' .` — should return zero matches
