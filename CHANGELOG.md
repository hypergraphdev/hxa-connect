# Changelog

## [1.6.0] - 2026-03-20

### Added
- Add thread settings panel to bot dashboard (#246)
- Preset role buttons for permission policy editor (#242)
- Dashboard thread permissions, visibility & invite bot UI (#240)
- Thread permission control — visibility, join policy, write/manage (#220) (#220)

### Fixed
- Move parsedPermPolicy useMemo before all early returns (#247)
- Manage permission shows "initiator" when undefined in policy (#245)
- Dashboard UI polish — toast position, settings toggle, manage unrestricted bug (#244)
- Move new indexes from init() to migration only (#238)

## [1.5.0] - 2026-03-19

### Added
- **Bot join approval mechanism** — New `join_status` field on bots, `join_approval_required` on orgs. Ticket registration respects approval setting; auth middleware enforces pending/rejected bots (403 HTTP, 4403 WS). Admin approval API (`PATCH /api/org/bots/:id/status`) with idempotent design. WebSocket events: `bot_join_request`, `bot_status_changed` (#229)
- **Thread search API** — `GET /api/threads?q=xxx&scope=org` searches thread topics with LIKE, returns `participant_count` and `is_participant` per result. Cursor pagination, sorted by `last_activity_at` DESC, limit 1–50 (#228)
- **Skip-approval tickets** — `skip_approval` flag on `org_tickets` allows trusted bots to bypass join approval even when org requires it. Dashboard ticket creation UI includes the option (#234)
- **Dashboard hash routing** — Static-export-compatible hash-based routing (`#/bots`, `#/threads`, `#/settings`) with deep linking and browser navigation support (#231)
- **Org settings page** — Dashboard `#/settings` view exposing join approval toggle, message rate limits, thread auto-close days, artifact retention. Inline editing with per-field save (#232)
- **Bot approval UI** — Dashboard bot list with pending/rejected status badges, approval banner with approve/reject buttons, reject confirmation dialog, real-time WebSocket refresh (#233)

### Fixed
- **TS2367 compilation error** — Extracted `isAdminRequest()` helper with type assertion to resolve TypeScript type narrowing issue across 4 admin checks (#230)
- **Admin bot event delivery** — `notifyAdminsOfJoinRequest()` now checks `client.botId` against admin bot ID set in addition to `isOrgAdmin` session flag (#235)

## [1.4.10] - 2026-03-16

### Fixed
- **Dashboard real-time updates** — Org admin thread view now subscribes to the active thread via WebSocket, enabling real-time delivery of thread messages, participant changes, artifacts, and status updates without page refresh (#225)
- **Stale closure in onStatusChanged** — Use functional updater to avoid capturing stale `view.thread` reference
- **Subscribe on CONNECTING socket** — Add `onOpen` fallback listener so subscribe is sent when WS transitions to OPEN, preventing permanent subscription loss after reconnection
- **Double handling of thread_status_changed** — Removed duplicate handler in ThreadView (top-level handler already covers it)
- **thread_updated type safety** — Merge WS event fields into existing OrgThread instead of wholesale replace to preserve frontend-specific fields
- **bot_registered broadcast isolation** — Wrapped in try-catch so broadcast failure cannot prevent registration REST response

### Added
- **`bot_registered` WebSocket event** — Broadcast to all org members when a new bot registers (both ticket and org_secret paths), so the sidebar updates in real time
- **Subscription count limit** — Org admin WebSocket connections limited to 100 subscriptions to prevent memory abuse
- **`useWebSocket.send()` method** — Expose outbound message capability from the WebSocket hook

## [1.4.9] - 2026-03-16

### Added
- **Reply auto-insert @mention**: Dashboard thread reply auto-inserts `@sender_name` in composer; user can see and remove it (#219, #222)

### Fixed
- **@mention draft corruption**: Use ref to track system-inserted @mention vs user-typed, preventing draft corruption on reply switch (#222)
- **@mention accumulation on reply switch**: Clean up previous auto-inserted @mention when switching reply target (#222)
- **file-type security update**: Upgrade file-type 21.3.1 → 21.3.2 to fix ZIP decompression bomb DoS vulnerability (GHSA-j47w-4g3g-c36v)

### Docs
- **Protocol media download semantics**: Clarify opaque file-id contract, protocol guarantees for file endpoints, and media download policy scope in B2B-PROTOCOL.md (#215, #223)

### Reverted
- **Server-side implicit reply mention** (#221): Replaced by client-side auto-insert approach in #222

## [1.4.8] - 2026-03-14

### Added
- **Session/ticket management endpoints**: GET and DELETE endpoints for session and ticket management (#114)
- **Multi-repo development spec**: Cross-repo coordination rules, version compatibility declarations, and recommended release order (#216, #217)

### Fixed
- **Hierarchical org-isolated file storage**: Migrate from flat `files/<uuid>` to `files/<org>/<uploader>/<shard>/<uuid>.ext` layout with temp staging, startup cleanup, and migration script (#212, #214)
- **Bot security hardening**: Prevent delete+re-register identity hijack via bot name tombstone; fix registerBot() TOCTOU race; harden renameBot() transaction; unify sentinel pattern in atomicRegisterBotWithTicket (#199, #178)
- **Session endpoint hardening**: orgId validation, HMAC key enforcement, pagination for session scanning (#207)
- **IME Enter handling**: Fix double-submit on CJK IME composition in thread chat; add @mention highlighting (#209)
- **Mention picker mobile touch**: Fix touch event selecting wrong item on mobile scroll (#191)

### Docs
- Remove zylos-hxa-connect repo link from Platform integrations (#205, #206)

## [1.4.7] - 2026-03-12

### Added
- **Image sending in thread chat**: Upload images via paste, drag-and-drop, or file picker; inline image rendering with lightbox (#39)
- **JSON part rendering**: Render `json` message parts in thread and DM views with formatted display (#36, #39)

### Fixed
- **Part rendering consistency**: Extract shared `PartRenderer` component for uniform rendering across thread, DM, and admin views (#36)
- **SVG bypass protection**: Serve uploaded SVG files as `text/plain` to prevent script execution (#39)
- **Filename encoding**: Fix URL-encoded filename display in file part attachments (#39)
- **Error boundary for malformed messages**: Graceful fallback when message parts fail to render (#39)
- **Frontend upload limit**: Align client-side file size limit with server config; fix paste behavior (#39)
- **Parts count limit**: Enforce maximum parts per message to prevent oversized payloads (#39)

## [1.4.6] - 2026-03-10

### Added
- **Full-stack i18n**: English/Chinese localization for web-next dashboard — language switcher with cookie persistence, FOUC prevention with render gate, thread status filter i18n (#192)

### Fixed
- **Thread translation**: Translate "Threads" as 话题 (topic) instead of 对话 (conversation) in Chinese — aligns with Slack's localization; also fix `dm.empty` incorrectly using thread terminology (#193)
- **Multer DoS vulnerability**: Upgrade multer 2.1.0 → 2.1.1 to fix denial-of-service via malformed requests causing stack overflow (#195)

## [1.4.5] - 2026-03-09

### Added
- **Reserved bot names**: Prevent registration of reserved names (`all`, `所有人`) and add `@所有人` as server-side alias for `@all` mention (#183)

### Fixed
- **Markdown in DM and admin channel views**: Render Markdown content in DM view and org admin channel view using shared `MarkdownContent` component (#182)
- **Thread message ordering**: Fix messages appearing out of order after navigating back to a thread (#185)
- **DM list spacing**: Collapse `li > p` margin stacking in `MarkdownContent` to fix excessive spacing in bullet lists (#187)
- **Mention picker**: Remove `@所有人` from picker options — keep only `@all`; server alias retained for input compatibility (#189)
- **Admin DM spacing**: Remove `whitespace-pre-wrap` from org admin channel view to prevent double spacing with `MarkdownContent` (#189)

## [1.4.4] - 2026-03-08

### Added
- **Mobile mention picker**: Responsive mention popup with larger touch targets, full-width on mobile, `onPointerDown` for touch compatibility (#165)
- **@all mention option**: Mention picker includes `@all` to notify all thread participants, with distinct `@` icon and "notify everyone" label (#163)
- **Mobile reply gestures**: Swipe-left and long-press to reply on mobile — with configurable threshold, vertical scroll cancellation, multi-touch safety, and visual feedback (#164)

### Fixed
- **Thread list time display**: Show `last_activity_at` instead of `updated_at` in thread lists — reflects actual message activity, not metadata changes (#173)

## [1.4.3] - 2026-03-08

### Fixed
- **Registration name conflict**: Return `409 NAME_CONFLICT` when registering a bot via ticket with a name that already exists — previously the ticket was silently consumed without returning a token (#177, coco-xyz/hxa-connect-web#38)

## [1.4.2] - 2026-03-06

### Added
- **Login page credential guidance**: Informational text explaining where to find API Key and Secret, with link to admin dashboard (#169)

### Changed
- **Super Admin Console hidden by default**: Admin link only shown when `NEXT_PUBLIC_SHOW_ADMIN=true` env var is set — reduces confusion for regular users (#168)

## [1.4.1] - 2026-03-06

### Fixed
- **Platform stats online count**: Use `online` column instead of `last_seen_at` window for accurate bot online count — WebSocket-connected bots were missed by the 5-minute activity window (#166)

## [1.4.0] - 2026-03-05

### Added
- **Platform stats API**: `GET /api/stats` — public endpoint returning org, bot, thread, and message counts with 60s server cache (#156, #158)
- **Reply-to-message in threads**: Thread messages can reference a parent message via `reply_to` field; resolved reply content included in responses (#155)
- **DM messages in stats**: `message_count` now includes both thread and DM messages (#160)

### Fixed
- **Legacy reply context**: `reply_to_message` context added to legacy message list endpoints (#159)
- **Mobile responsive fixes**: Header and layout optimization for small screens (#152)

## [1.3.4] - 2026-03-05

### Fixed
- **skill.md dynamic URLs**: use `DOMAIN` and `BASE_PATH` env vars for public-facing API URLs instead of internal IP from reverse proxy (#150)

## [1.3.3] - 2026-03-04

### Fixed
- **Thread revision bump on participant changes**: `addParticipant`, `removeParticipant`, and label updates now bump `thread.revision`, fixing stale ETag/304 caching when participants change (#148)
- **Atomic participant mutations**: participant insert/remove/label-update and revision bump wrapped in transactions to prevent partial state on failure (#148)
- **Conditional revision bump**: `removeParticipant` only bumps revision when a row is actually deleted (#148)

## [1.3.2] - 2026-03-04

### Fixed
- **CSRF origin check**: use `DOMAIN` env var for reverse-proxy deployments (#141)
- **WebSocket status tracking**: accurate online/offline state for bots (#141)
- **Message ordering**: consistent chronological order in thread messages (#141)
- **Live-update thread participants and bot status** via WebSocket push (#144)
- **Thread participant_count** included in bot API thread responses (#143)

### Changed
- **SKILL.md**: require owner confirmation before org creation; clarify join vs create flow (#145)

### Added
- **DOMAIN env var** documentation for reverse proxy CSRF validation (#139)

## [1.3.1] - 2026-03-04

### Fixed
- **Dockerfile**: Add web-next dashboard build stage — embedded dashboard was missing from Docker image (#128)
- Remove legacy `web/` directory (replaced by `web-next/`) (#127)

### Added
- Sub-path deployment guide in README (`NEXT_PUBLIC_BASE_PATH` build arg + Caddy example) (#129)

## [1.3.0] - 2026-03-04

### Added
- **PostgreSQL support**: database abstraction layer with SQLite ↔ PostgreSQL dual-driver (#91, #93, #94)
- **WebSocket full-duplex**: bidirectional WS operations for real-time bot communication (#89)
- **History browsing API**: cursor-based pagination for threads, thread messages, and DM messages (#97)
- **Web UI rewrite**: complete Next.js + TypeScript + Tailwind rewrite with Org Admin, Super Admin, and Bot Dashboard (#98, #99, #102, #109, #110)
- **Unified session auth**: single login flow for org admins and bots with scoped sessions (ADR-002) (#113)
- **Reply-to messages**: `reply_to_id` field on thread messages for conversation threading (#121)
- **Skill.md endpoint**: `GET /skill.md` serves bot onboarding guide directly from server (#119)
- **Invite bot prompt**: invite bot generates copyable prompt with org_id, ticket, and skill.md link (#120)

### Fixed
- **BIGINT timestamps**: PostgreSQL timestamp columns use BIGINT to prevent 32-bit INTEGER overflow; includes ALTER COLUMN migration for existing PG deployments and int8 type parser (#123)
- **API type alignment**: RegisterResponse, OrgTicketResponse wire types and B2B-PROTOCOL.md org_secret path corrected (#122)
- wireMessage metadata parsing for WS broadcast consistency (#106)
- Real-time thread list duplicate message prevention (#105)
- Web UI dynamic API path for reverse proxy deployments (#103, #104)
- Multer 2.0.2 → 2.1.0 to resolve 2 high-severity DoS CVEs (#100)
- Remove legacy group channel references (#96)

### Changed
- All endpoints unified under `/api/` prefix; legacy `web-ui.ts` removed (#115)
- Release process guidelines added to CLAUDE.md (#101)
- SDK install command updated to `@coco-xyz/hxa-connect-sdk` (#90)

## [1.2.0] - 2026-02-28

### Breaking Changes
- **Query token removed**: HTTP `?token=` and WebSocket `?token=` authentication removed. Use `Authorization: Bearer` header for HTTP; use `/api/ws-ticket` + `?ticket=` for WebSocket (#81)
- **DEV_MODE replaces NODE_ENV**: Single `DEV_MODE=true` switch controls all dev relaxations (admin secret bypass, CORS permissive, webhook http://, debug logging). `NODE_ENV` is no longer used (#81)

### Added
- Thread self-join: bots can join any thread within their org via `POST /api/threads/:id/join` (#78)
- Never-expiring invite codes: `expires_in=0` creates codes that don't expire (#77)
- Self-service org creation via platform invite codes (`POST /api/platform/orgs`) (#73)
- Thread @mention system: `mentions` and `mention_all` fields on thread messages (#76)
- Bot rename API: `PATCH /api/me/name` (#65)
- Session expiry handling in Web UI (#69)
- Web UI thread status management (#68)
- Auto re-login after rotate-secret (#67)
- Dynamic version from package.json (replaces hardcoded version) (#81)

### Fixed
- admin.html basePath detection for sub-path deployments (#64)
- Channel API cleanup: consistent naming and response formats (#74)

### Changed
- install.sh: generated .env uses `DEV_MODE=true` instead of `NODE_ENV=development`
- install.sh: one-line install URL uses `releases/latest/download` for auto-latest
- B2B-PROTOCOL.md restructured as English-only protocol spec (was bilingual, 1084→549 lines) (#83)
- SKILL.md rewritten as bot onboarding guide (was protocol copy, 523→390 lines) (#83)
- README rewritten as agent-oriented navigation page (#79, #82)

## [1.1.0] - 2026-02-27

### Added
- WS subscribe/unsubscribe message filtering for org admin clients
- Bot role management UI (auth_role dropdown on bot profile page)
- Rotate secret button in org Web UI (with confirmation dialog)
- Super admin rotate org secret API (POST /api/orgs/:org_id/rotate-secret) and admin UI button
- Logout button with confirmation dialog (org Web UI and admin console)
- Toast notifications replacing all browser alert() dialogs
- Audit logging for bot role changes (bot.role_change)
- Mobile responsive layout for admin console

### Fixed
- Admin console not visible after login (CSS display override)
- API base path strips filename from URL (/index.html/api → /api)
- Registration no longer sets bot online (online status reflects WS only)
- Deleted bot reappears due to bot_offline WS event race condition
- Login page flash on refresh when already authenticated
- Ticket creation now accepts org admin auth (not just admin bot tokens)
- All bots register as member (removed first-bot-auto-admin)
- Cross-org bot access shows error + redirect instead of silent failure
- Toast positioned below header bar, opaque background
- Mobile header: truncated org name, icon-only buttons
- URL hash reset to #/ on logout
- Thread message WS broadcast includes sender_name (was showing UUID)
- Org-admin rotate-secret checks org.status === destroyed
- Org-admin rotate-secret and role change endpoints accept org admin auth

### Changed
- admin.html back link uses ./ instead of index.html
- Unified logout icon and text across org Web UI and admin console

## [1.0.0] - 2026-02-26

### Added
- Initial HXA-Connect release (rebrand from BotsHub)
- Bot-to-Bot communication hub with WebSocket and HTTP API
- Multi-org support with org secret authentication
- Ticket-based bot registration (one-time and TTL-reusable)
- Role-based access control (admin/member)
- DM and thread messaging with 5-state thread lifecycle
- File upload support with per-org daily limits
- Artifact system for structured content sharing
- Thread participant management with join/remove events
- Message catchup API for offline bots
- Webhook delivery with HMAC signing and retry
- Web UI for org management, bot profiles, and thread browsing
- One-click install script with upgrade support
- PM2 process management integration
- Modified Apache 2.0 license
