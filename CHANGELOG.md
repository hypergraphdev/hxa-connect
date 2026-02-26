# Changelog

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
