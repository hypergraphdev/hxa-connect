# Implementation: Dashboard Real-Time Updates (#225)

## Problem

Org admin dashboard users (login at `/hub/` with org_id + org_secret) do not receive real-time updates for:

1. **Thread messages** — Bot replies require page refresh to appear
2. **Thread participant changes** — Bot join/leave not reflected in real time
3. **New bot registration** — New bots don't appear in sidebar until refresh

## Session Role Architecture

Two distinct dashboard views exist, each for a different session role:

| Path | Role | `isOrgAdmin` | Event delivery |
|------|------|-------------|----------------|
| `/hub/org/` | `org_admin` (org_id + org_secret login) | `true` | Subscription-based filtering |
| `/hub/dashboard/` | `bot_owner` (bot token login) | `false` | Participant-based filtering |

**The bug only affects `/org/` (org_admin view).** Bot_owner connections receive thread events automatically if their bot is a thread participant — no subscription needed.

The `/org/` view manages its own WebSocket connection directly in `web-next/src/app/org/[[...path]]/client.tsx` (lines 200-253), separate from the `/dashboard/` shell's `useWebSocket` hook.

## Root Cause Analysis

### Issue 1 & 2: Missing WebSocket Thread Subscription

`broadcastThreadEvent()` in `src/ws/broadcast.ts` (lines 106-110) filters org admin clients:

```typescript
if (client.isOrgAdmin) {
  if (isOrgWideEvent || client.subscriptions.has(threadId)) {
    sendToClient(client, event);
  }
  continue;
}
```

Only `thread_created` is org-wide. All other thread events (`thread_message`, `thread_participant`, `thread_updated`, `thread_artifact`, `thread_status_changed`) require the client to have explicitly subscribed to the specific `threadId`.

The server-side subscribe/unsubscribe handler exists (`src/ws/index.ts` lines 265-282), but the org admin frontend never sends subscribe messages. The `handleWsEvent` callback and the ThreadDetailView message listener (lines 920-967) have complete handlers for thread events — the events just never arrive at the client.

### Issue 3: No `bot_registered` Broadcast Event

When a bot registers via `POST /api/auth/register` (`src/routes.ts` lines 1093-1248), the server returns the bot info via REST but does not broadcast any WebSocket event.

`bot_online` (broadcast via `broadcastToOrg()` when the bot connects via WS) only updates the `online` status of existing bots in the frontend sidebar — it does not add new entries to the bot list.

## Design

### Change 1: Thread Subscription in Org Admin View (Frontend)

**Where:** `web-next/src/app/org/[[...path]]/client.tsx`

The org admin view's ThreadDetailView already binds to the WebSocket for message events (lines 948-950) and polls for reconnection every 2s (lines 954-961). Extend this:

1. When binding to the WebSocket (in `bind()` function), also send `{ type: 'subscribe', thread_id }`.
2. On cleanup (thread change / unmount), send `{ type: 'unsubscribe', thread_id }` before removing the listener.
3. On reconnection detection (in the 2s poll), the new socket bind already happens — sending subscribe in `bind()` handles this automatically.

This activates real-time delivery for `thread_message`, `thread_participant`, `thread_updated`, `thread_artifact`, and `thread_status_changed` for the viewed thread.

**Scope:** Subscribe only to the currently viewed thread, matching the design intent of opt-in subscriptions for org admins.

### Change 2: `bot_registered` Event (Server + Frontend)

**Server (`src/routes.ts`):**

After successful bot registration (both ticket and org_secret paths), broadcast:
```typescript
ws.broadcastToOrg(org_id, {
  type: 'bot_registered',
  bot: { id: bot.id, name: bot.name },
});
```

Using `broadcastToOrg()` sends to all org clients (including org admins) without subscription. Event shape matches `bot_online`/`bot_offline` (`Pick<Bot, 'id' | 'name'>`).

**Server (`src/types.ts`):**

Add `bot_registered` to the `WsServerEvent` union type.

**Frontend (`web-next/src/app/org/[[...path]]/client.tsx`):**

Handle `bot_registered` in `handleWsEvent` — append new bot to the `bots` list with `online: false`.

### Change 3: Thread Subscription in Bot Owner View (Frontend)

**Where:** `web-next/src/app/dashboard/shell.tsx`

The bot_owner view uses `useWebSocket` hook. While bot_owner connections receive thread events via participant path (if the bot is a participant), the shell should also handle `bot_registered` events to show new bots in its sidebar.

Additionally, expose a `send()` method from `useWebSocket` hook and add subscribe/unsubscribe logic in shell.tsx when the active thread changes — this benefits bot_owner sessions where the bot may be viewing threads it's not a participant of (e.g., admin bots browsing all threads).

**Where:** `web-next/src/hooks/useWebSocket.ts`

Return a `send()` function alongside the existing hook. Use a ref to the current WebSocket instance. Also fire `onEvent` with a synthetic `{ type: 'reconnected' }` event on successful reconnection so the shell can re-subscribe.

## Files Changed

### Server
| File | Change |
|------|--------|
| `src/types.ts` | Add `bot_registered` to `WsServerEvent` |
| `src/routes.ts` | Broadcast `bot_registered` after successful registration |

### Frontend
| File | Change |
|------|--------|
| `web-next/src/app/org/[[...path]]/client.tsx` | Subscribe/unsubscribe in ThreadDetailView; handle `bot_registered` in handleWsEvent |
| `web-next/src/lib/types.ts` | Add `bot_registered` to `WsEvent` |
| `web-next/src/hooks/useWebSocket.ts` | Expose `send()` method; fire reconnected signal |
| `web-next/src/app/dashboard/shell.tsx` | Subscribe/unsubscribe on thread navigation; handle `bot_registered` |

### Tests
| File | Change |
|------|--------|
| `test/dashboard-realtime.test.ts` | New: test subscribe flow, bot_registered broadcast, thread event delivery after subscribe, unsubscribe cleanup |

## Edge Cases

1. **Rapid thread switching** — Unsubscribe from old thread before subscribing to new. Cleanup function in the ThreadDetailView effect handles this.
2. **WebSocket reconnection** — Org view: 2s polling detects reconnection and re-binds + re-subscribes. Dashboard: `reconnected` signal triggers re-subscribe via effect.
3. **Duplicate messages** — Both views deduplicate by message ID before rendering.
4. **Thread view unmount** — Effect cleanup sends unsubscribe to prevent stale server-side subscriptions.
5. **Bot registers but never connects** — `bot_registered` adds bot to sidebar as offline. Later `bot_online` updates status.
6. **Multiple tabs** — Each tab has independent WS connection + subscriptions. Correct behavior.
7. **Subscribe rejected** — Server silently rejects subscribe from non-org-admin clients (returns error event). Bot_owner shell should catch and ignore this gracefully.
8. **Subscription count** — Server subscribe handler has no limit. For this PR, acceptable since dashboard only subscribes to 1 thread at a time. A limit can be added as a follow-up hardening task.
