# HXA-Connect Web UI Rewrite — Design Document

## Goal

Replace the three separate vanilla JS frontends with a single unified Next.js application inside the hxa-connect repo. After login, Org Admins and Bot users see the **same interface** — permissions determine what's visible and actionable.

## Current State (3 Frontends)

| File | Auth | Purpose |
|------|------|---------|
| `/admin.html` | Super Admin secret (header) | Platform management: orgs, invite codes |
| `/index.html` | Org ticket (sessionStorage) via `POST /api/auth/login { org_id, org_secret }` | Org admin: bots, threads, DMs (read-only) |
| `/ui/index.html` | Bot session cookie (`hxa_session`, httponly) via `POST /ui/api/login { token, owner_name }` | Bot Web UI: threads, DMs (read-only), send thread messages |

**Current Auth Contracts (server):**
- **Org admin**: `POST /api/auth/login` requires `{ org_id, org_secret }`, returns `{ ticket, expires_at }`. Ticket stored in `sessionStorage`, used as `Bearer` token. No cookie session.
- **Bot user**: `POST /ui/api/login` requires `{ token, owner_name }`, accepts bot primary or scoped token. Returns cookie-based session (`hxa_session`). Session data: `{ bot, owner_name, scopes, expires_at }` — no `role` field.
- These are two completely separate auth flows with different session models.

**Problems:**
- Two separate post-login views (org admin vs bot) with different UX, duplicated features
- Org admin can view threads/DMs but can't send messages; bot user can send but sees less context
- Three HTML files, all vanilla JS with inline scripts — hard to maintain and test
- No shared components, no type safety, no build system

## Target State (1 Unified App)

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js 16 | Matches hxa-connect-web, App Router |
| Language | TypeScript | Type safety, catch bugs at compile time |
| Styling | Tailwind CSS v4 | Matches hxa-connect-web, utility-first, existing theme variables |
| Icons | Lucide React | Matches hxa-connect-web |
| State | React hooks + context | Simple, no external lib needed |
| Build output | `export` (static SPA) | No SSR needed; Express serves static files with catch-all fallback |

### Auth Model (Unified) — NEW

Merge org admin and bot auth into a **single session model**. This requires backend changes (see Backend Changes Needed).

**Current → Target mapping:**

| Current | Target |
|---------|--------|
| `POST /api/auth/login { org_id, org_secret }` → ticket | Merged into unified `/ui/api/login` |
| `POST /ui/api/login { token, owner_name }` → cookie | Extended to also accept org credentials |

**New unified endpoint:**

```
POST /ui/api/login
  Body: { token, org_id?, owner_name? }

  Case 1 — bot_token:
    - Looks up bot by token (existing behavior)
    - Creates session with role='bot_user'
    - owner_name required

  Case 2 — org_secret:
    - org_id REQUIRED (org_secret is not globally unique — must be paired with org_id)
    - Looks up org, verifies secret hash
    - Creates session with role='org_admin'
    - owner_name optional (defaults to org name)

  Response: Set-Cookie hxa_session (httponly, secure when req.secure, samesite=strict)
```

**New session response:**

```
GET /ui/api/session
  Response: {
    role: 'org_admin' | 'bot_user',
    org: { id, name },
    bot?: { id, name },          // only for bot_user
    owner_name: string,
    scopes: string[],            // all scopes for bot_user; full access for org_admin
    expires_at: number
  }
```

**Roles after login:**

| Role | Login with | Can see | Can do |
|------|-----------|---------|--------|
| `org_admin` | org_id + org_secret | All bots, all threads, all DMs | Manage org settings, rotate secret, set bot roles, send messages (human provenance) |
| `bot_user` | bot_token + owner_name | Own threads, own DMs | Send thread messages (human provenance) |

### Super Admin Console

Kept separate at `/admin.html` — different auth model (stateless header), different audience (platform operators vs org users). Can be rewritten later if needed, out of scope for this phase.

### URL Structure

```
/                         → Login page (single form, auto-detects token type)
/dashboard                → Main view (redirects to login if no session)
/dashboard/threads/:id    → Thread detail view
/dashboard/dms/:id        → DM detail view
/dashboard/bots/:id       → Bot profile view (org admin only)
/dashboard/settings       → Org settings (org admin only)
/admin.html               → Super admin console (unchanged)
```

**Routing strategy:** Static export produces pre-rendered HTML for known paths. Dynamic segments (`threads/:id`, `dms/:id`, `bots/:id`) are handled client-side. Express serves the catch-all `index.html` for any path not matching a static file, enabling SPA-style client-side routing.

### Directory Structure

```
web-next/                          # New Next.js app (inside hxa-connect repo)
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout (fonts, theme)
│   │   ├── page.tsx               # Login page
│   │   └── dashboard/
│   │       ├── layout.tsx         # Auth gate + sidebar + header
│   │       ├── page.tsx           # Empty state / overview
│   │       ├── threads/
│   │       │   └── [id]/
│   │       │       └── page.tsx   # Thread detail
│   │       ├── dms/
│   │       │   └── [id]/
│   │       │       └── page.tsx   # DM detail
│   │       ├── bots/
│   │       │   └── [id]/
│   │       │       └── page.tsx   # Bot profile (org admin)
│   │       └── settings/
│   │           └── page.tsx       # Org settings (org admin)
│   ├── components/
│   │   ├── ui/                    # Reusable atoms
│   │   │   ├── Badge.tsx
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── Toast.tsx
│   │   │   └── Modal.tsx
│   │   ├── layout/
│   │   │   ├── Header.tsx         # Top bar: brand, user info, logout
│   │   │   └── Sidebar.tsx        # Tabs: Threads, DMs, Bots (admin)
│   │   ├── thread/
│   │   │   ├── ThreadList.tsx     # Sidebar list with search + filter
│   │   │   ├── ThreadView.tsx     # Message list + composer
│   │   │   └── ArtifactPanel.tsx  # Side panel for artifacts
│   │   ├── dm/
│   │   │   ├── DMList.tsx         # Sidebar DM list
│   │   │   └── DMView.tsx         # DM message view
│   │   ├── bot/
│   │   │   ├── BotList.tsx        # Sidebar bot list (admin)
│   │   │   └── BotProfile.tsx     # Bot detail view (admin)
│   │   └── message/
│   │       ├── MessageBubble.tsx  # Single message with provenance badge
│   │       └── Composer.tsx       # Textarea + send button
│   ├── hooks/
│   │   ├── useSession.ts         # Auth state (role, bot info, org info)
│   │   ├── useWebSocket.ts       # Real-time events
│   │   ├── useThreads.ts         # Thread list + pagination
│   │   ├── useDMs.ts             # DM list + pagination
│   │   └── useApi.ts             # Fetch wrapper with error handling
│   ├── lib/
│   │   ├── api.ts                # API client (typed)
│   │   ├── types.ts              # Shared type definitions
│   │   └── utils.ts              # Helpers (date format, etc.)
│   └── styles/
│       └── globals.css           # Tailwind + theme variables (from ui.css)
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── package.json
└── tailwind.config.ts
```

### Build & Deployment Integration

**Static export (SPA mode):**
- `next build` with `output: 'export'` in `next.config.ts` → produces static HTML/JS/CSS in `web-next/out/`
- Express serves static files from `web-next/out/`
- **Catch-all fallback**: Express returns `out/index.html` for any request that doesn't match a static file or API route — this enables client-side routing for dynamic segments like `/dashboard/threads/:id`
- No SSR needed — this is an internal dashboard, not a public-facing site
- Build step: `cd web-next && npm run build` (adds to existing build pipeline)
- Runtime: zero extra dependencies beyond the existing Express server

**next.config.ts:**
```ts
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  // All dynamic routes use generateStaticParams returning [] (empty)
  // — client-side JS handles ID resolution via URL params
};
```

### Sidebar Design (Unified)

```
┌─────────────────────┐
│  HXA-Connect        │  ← Header: brand + user info + logout
├─────────────────────┤
│ Threads │ DMs │ Bots │  ← Tabs (Bots tab: org admin only)
├─────────────────────┤
│ Search              │
│ Status: [All ▾]     │
├─────────────────────┤
│ > Deployment thread │
│ > Code review       │
│ > Bug report        │
│   ...               │
│ [Load more]         │
└─────────────────────┘
```

- **Threads tab**: Same for both roles. Org admin sees all org threads; bot user sees own threads.
- **DMs tab**: Org admin sees all bot DMs; bot user sees own DMs.
- **Bots tab**: Org admin only. List of bots in org with online status.

### Permissions Matrix

These are **target** capabilities. Items marked with (*) require new backend endpoints (see Backend Changes Needed).

| Feature | org_admin | bot_user |
|---------|-----------|----------|
| View all threads | ✅ (*) | ❌ (own only) |
| View all DMs | ✅ (*) | ❌ (own only) |
| Send thread messages | ✅ (*) (human provenance) | ✅ (human provenance) |
| Send DM messages | ✅ (*) (human provenance) | ❌ (read-only) |
| View bot list | ✅ (*) | ❌ |
| View bot profiles | ✅ (*) | ❌ |
| Manage org settings | ✅ (*) | ❌ |
| Rotate org secret | ✅ (*) (existing Bearer-token route needs `/ui/api` wrapper) | ❌ |
| Set bot roles | ✅ (*) (existing Bearer-token route needs `/ui/api` wrapper) | ❌ |
| View artifacts | ✅ | ✅ |
| Change thread status | ✅ (*) | ❌ |

### Key UI Components

**MessageBubble**: Renders a single message with:
- Sender name (with provenance badge for human-authored)
- Timestamp
- Markdown content (using marked + DOMPurify, same as current)
- Code blocks, tables, images

**Composer**: Textarea with:
- Shift+Enter for newlines, Enter to send
- Disabled state for read-only views
- Character count for long messages

**ThreadView**:
- Header: topic, status badge, participant count, artifact toggle
- Message list: paginated, "load older" at top
- Composer at bottom
- Artifact panel: slide-in from right

### WebSocket Integration

Same approach as current — request ticket via `/ui/api/ws-ticket`, connect to WebSocket.

**Full event set from server** (events the frontend must handle):

| Event | Purpose | Used in |
|-------|---------|---------|
| `thread_message` | New message in a thread | Thread detail view |
| `thread_created` | New thread created | Thread list sidebar |
| `thread_updated` | Thread metadata changed (topic, context, revision) | Thread detail header |
| `thread_status_changed` | Thread status changed (open/closed/etc.) | Thread list + detail |
| `thread_artifact` | Artifact added or updated | Artifact panel |
| `thread_participant` | Bot joined/left/invited/removed from thread | Thread detail participant list |
| `message` | New DM message in a channel | DM detail view |
| `channel_created` | New DM channel created | DM list sidebar |
| `bot_online` | Bot connected | Bot list (admin) |
| `bot_offline` | Bot disconnected | Bot list (admin) |

**Org-admin WS auth path**: Current WS auth (`/ui/api/ws-ticket`) issues tickets using the session's stored bot token. For org_admin sessions (which have no bot token), this path needs an alternative:
- Option A: On org_admin login, also issue an internal org ticket (via `db.createOrgTicket`) and store it in the session. Use this ticket for WS auth.
- Option B: Extend WS ticket issuance to accept org_admin sessions directly — generate a WS ticket scoped to the org, and extend WS auth to recognize org-scoped tickets.
- Either way, the org_admin WS connection must receive events for ALL bots in the org (org-wide subscription). See backend change #14.

### Migration Plan

**Phase 1: Foundation** (scaffold + login + layout)
- Create `web-next/` with Next.js + TypeScript + Tailwind
- Port theme variables from `ui.css`
- Build login page (unified: auto-detect org secret vs bot token)
- Build dashboard layout: header + sidebar + main area
- Build session hook + API client

**Phase 2: Thread views** (core functionality)
- Thread list (sidebar) with search + status filter + pagination
- Thread detail: message list + composer + real-time updates
- Artifact panel
- WebSocket hook

**Phase 3: DM + Bot views** (complete feature parity)
- DM list + DM message view (read-only for bot, sendable for admin)
- Bot list + bot profile (admin only)
- Org settings page (admin only)

**Phase 4: Integration + cutover**
- Build pipeline: `npm run build:web` in hxa-connect
- Express serves static output with catch-all fallback
- Remove old `web/` directory
- Update Caddy config if needed

### Backend Changes Needed

Changes to the hxa-connect server required to support the unified UI:

**Auth (Phase 1):**
1. **Extend `/ui/api/login`** to accept org credentials: `{ token, org_id?, owner_name? }`. When `org_id` is present, treat `token` as `org_secret`, verify via `db.verifyOrgSecret(org_id, token)`, and create a session with `role: 'org_admin'`.
2. **Extend `/ui/api/session`** to include `role` field (`'org_admin' | 'bot_user'`), and for org_admin sessions include `org: { id, name }` instead of `bot`.
3. **Extend session store** (`Session` interface in `web-ui.ts`): add `role` field, make `bot_id` optional (null for org_admin sessions).

**Org-Admin Data Access (Phase 2-3):**
4. **Org-wide thread list**: New endpoint `GET /ui/api/org/threads` — returns all threads across all bots in the org. Currently `/ui/api/threads` is scoped to the session's bot.
5. **Org-wide thread send**: Allow org_admin sessions to post messages to any thread in their org via `/ui/api/threads/:id/messages`, with human provenance metadata.
6. **Org-wide DM list**: New endpoint `GET /ui/api/org/channels` — aggregate DMs across all bots. Implementation approach: query all channels for all bots in the org, paginated. Scale note: this is O(bots * channels); acceptable for current org sizes (<100 bots).
7. **Org-admin DM send**: New endpoint `POST /ui/api/org/channels/:id/messages` — allow org_admin to send DMs on behalf of a bot (requires specifying which bot).
8. **Bot list for org**: New endpoint `GET /ui/api/org/bots` — list all bots in org with online status.
9. **Bot profile**: New endpoint `GET /ui/api/org/bots/:id` — bot details + stats.
10. **Org settings**: New endpoint `GET /ui/api/org/settings` and `PATCH /ui/api/org/settings`.
11. **Thread status change**: Allow org_admin to change thread status via `/ui/api/threads/:id/status`.
12. **Rotate secret wrapper**: New `/ui/api/org/rotate-secret` that proxies to the existing `POST /api/org/rotate-secret` (which uses Bearer-token auth via `requireOrgAdmin`). The wrapper reads the cookie session and makes the internal call.
13. **Set bot role wrapper**: New `/ui/api/org/bots/:id/role` that proxies to the existing `PATCH /api/org/bots/:bot_id/role`. Same cookie-to-Bearer bridge pattern.

**WebSocket (Phase 2):**
14. **Org-wide WS subscriptions**: Extend WS ticket issuance for org_admin sessions. Current WS auth only handles bot tokens. For org_admin sessions, either (a) issue an internal org ticket during login and store it in the session for WS ticket generation, or (b) extend WS ticket issuance to accept org-scoped sessions directly. The org_admin WS connection must receive events for ALL bots in their org.

**Static Serving (Phase 4):**
15. **Catch-all route**: Add Express middleware to serve `web-next/out/index.html` for any GET request that doesn't match an API route or static file.

### Non-Functional Requirements

**Error Handling:**
- API errors display as toast notifications with retry option
- Network disconnection shows a persistent banner with auto-reconnect
- WebSocket reconnection with exponential backoff (existing pattern in `ui/index.html`)

**Loading States:**
- Skeleton loaders for thread/DM lists during initial fetch
- Inline spinners for message send operations
- Optimistic updates for sent messages (show immediately, rollback on failure)

**Mobile Responsiveness:**
- Responsive sidebar: collapses to bottom nav or drawer on narrow screens
- Touch-friendly tap targets (minimum 44px)
- Readable on 320px+ viewport width

**Accessibility:**
- Keyboard navigation for thread/DM lists and message composer
- ARIA labels for interactive elements
- Focus management on view transitions

**i18n:**
- English only for v1 (matches current state)
- String extraction pattern ready for future i18n if needed (all user-visible strings in constants)
