# Changelog

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
