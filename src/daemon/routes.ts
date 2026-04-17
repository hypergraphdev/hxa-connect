/**
 * HTTP endpoints called by @slock-ai/daemon's chat-bridge MCP server.
 *
 * chat-bridge.js hits these paths:
 *   POST   /internal/agent/:agentId/send
 *   GET    /internal/agent/:agentId/receive
 *   POST   /internal/agent/:agentId/resolve-channel
 *   POST   /internal/agent/:agentId/upload            (MVP: not implemented — returns 501)
 *
 * Authorization: `Bearer <bot_token>`. The :agentId path parameter must
 * equal the bot's id. We reuse the hub's existing createChannel/createMessage
 * flows so broadcasts reach both the daemon owner (over WS) and whoever
 * else is in the channel.
 */

import { Router, type Request, type Response } from 'express';
import type { HubDB } from '../db.js';
import type { HubWS } from '../ws.js';
import type { HubConfig, Bot } from '../types.js';
import { routeLogger } from '../logger.js';

function extractBearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}

async function authBot(db: HubDB, req: Request, res: Response): Promise<Bot | undefined> {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }
  const bot = await db.getBotByToken(token);
  if (!bot) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  if (bot.join_status !== 'active') {
    res.status(403).json({ error: 'bot_not_active' });
    return;
  }
  const agentId = req.params.agentId;
  if (agentId !== bot.id) {
    res.status(403).json({ error: 'agentId does not match authenticated bot' });
    return;
  }
  return bot;
}

/**
 * Parse the Slock `target` string.
 *   dm:@<name>               → DM
 *   dm:@<name>:<shortid>     → DM (shortid ignored for MVP — hub has no DM threads)
 *   #<topic>                 → not supported (no parent-less top-level channels)
 *   #<topic>:<thread_id>     → Thread reply. The daemon sends the full thread id
 *                              here because we seeded channel_name=`thread-<id>`
 *                              in toDaemonDeliveredThread, and Slock's
 *                              getMessageShortId strips the `thread-` prefix.
 */
type ParsedTarget =
  | { kind: 'dm'; name: string }
  | { kind: 'thread'; threadId: string };

function parseTarget(target: string): ParsedTarget | null {
  const trimmed = target.trim();
  if (trimmed.startsWith('dm:@')) {
    const rest = trimmed.slice(4);
    const name = rest.split(':', 1)[0];
    return name ? { kind: 'dm', name } : null;
  }
  if (trimmed.startsWith('#')) {
    const rest = trimmed.slice(1);
    // Preferred shape produced by newer slock daemons that honor
    // parent_channel_name:   #<topic>:<thread_id>
    const colon = rest.indexOf(':');
    if (colon > 0) {
      const threadId = rest.slice(colon + 1).trim();
      return threadId ? { kind: 'thread', threadId } : null;
    }
    // Fallback: older daemons ignore parent_channel_name and render the
    // raw channel_name, which we seed as `thread-<uuid>`. Recover the id.
    if (rest.startsWith('thread-')) {
      const threadId = rest.slice('thread-'.length).trim();
      return threadId ? { kind: 'thread', threadId } : null;
    }
    return null;
  }
  // Bare name → treat as DM peer for backward compat.
  return trimmed ? { kind: 'dm', name: trimmed } : null;
}

export function createDaemonRouter(db: HubDB, ws: HubWS, config: HubConfig): Router {
  const r = Router();

  // ─── POST /internal/agent/:agentId/send ─────────────────────
  r.post('/internal/agent/:agentId/send', async (req, res) => {
    const bot = await authBot(db, req, res);
    if (!bot) return;

    const { target, content, attachmentIds: _attachmentIds } = req.body ?? {};
    if (typeof target !== 'string' || typeof content !== 'string' || !content) {
      res.status(400).json({ error: 'target and content are required' });
      return;
    }
    if (content.length > config.max_message_length) {
      res.status(400).json({ error: `Message too long (max ${config.max_message_length} chars)` });
      return;
    }

    const parsed = parseTarget(target);
    if (!parsed) {
      res.status(400).json({ error: `Invalid target: ${target}` });
      return;
    }

    if (parsed.kind === 'dm') {
      const peer = await db.getBotByName(bot.org_id, parsed.name);
      if (!peer) {
        res.status(404).json({ error: `Bot not found: ${parsed.name}` });
        return;
      }
      if (peer.id === bot.id) {
        res.status(400).json({ error: 'Cannot send to yourself' });
        return;
      }

      const channel = await db.createChannel(bot.org_id, [bot.id, peer.id]);
      if (channel.isNew) {
        ws.broadcastToOrg(bot.org_id, {
          type: 'channel_created',
          channel: {
            id: channel.id,
            org_id: channel.org_id,
            type: channel.type,
            name: channel.name,
            created_at: channel.created_at,
          },
          members: [bot.id, peer.id],
        });
      }

      const msg = await db.createMessage(channel.id, bot.id, content, 'text', null);
      await db.recordAudit(bot.org_id, bot.id, 'message.send', 'channel_message', msg.id, {
        channel_id: channel.id,
        to: peer.id,
        via: 'daemon',
      });
      await db.recordCatchupEvent(bot.org_id, peer.id, 'channel_message_summary', {
        channel_id: channel.id,
        channel_name: channel.name ?? undefined,
        count: 1,
        last_at: msg.created_at,
      }, channel.id);

      void ws.broadcastMessage(channel.id, msg, bot.name).catch((err) => {
        routeLogger.error({ err }, 'daemon.send: broadcast failed');
      });

      res.json({
        messageId: msg.id,
        channelId: channel.id,
        target,
        recentUnread: [],
      });
      return;
    }

    // parsed.kind === 'thread'
    const thread = await db.getThread(parsed.threadId);
    if (!thread || thread.org_id !== bot.org_id) {
      res.status(404).json({ error: `Thread not found: ${parsed.threadId}` });
      return;
    }
    if (thread.status === 'closed' || thread.status === 'resolved') {
      res.status(409).json({ error: `Thread is ${thread.status}, cannot post` });
      return;
    }
    const participants = await db.getParticipants(thread.id);
    if (!participants.some((p) => p.bot_id === bot.id)) {
      res.status(403).json({ error: 'Not a participant of this thread' });
      return;
    }
    if (!(await db.checkThreadPermission(thread, bot.id, 'write'))) {
      res.status(403).json({ error: 'No write permission on this thread' });
      return;
    }

    const threadMsg = await db.createThreadMessage(
      thread.id,
      bot.id,
      content,
      'text',
      null, // metadata
      null, // parts
      null, // mentions
      0,    // mentionAll
      null, // replyToId
    );

    await db.recordAudit(thread.org_id, bot.id, 'message.send', 'thread_message', threadMsg.id, {
      thread_id: thread.id,
      via: 'daemon',
    });
    for (const p of participants) {
      if (p.bot_id === bot.id) continue;
      await db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_message_summary', {
        thread_id: thread.id,
        topic: thread.topic,
        count: 1,
        last_at: threadMsg.created_at,
      }, thread.id);
    }

    // Wire shape matches what the thread message endpoint broadcasts
    // (see routes.ts /api/threads/:id/messages).
    const enriched = {
      ...threadMsg,
      parts: [{ type: 'text' as const, content }],
      mentions: [],
      mention_all: false,
      metadata: null,
      sender_name: bot.name,
    };
    void ws.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_message',
      thread_id: thread.id,
      message: enriched as unknown as import('../types.js').WireThreadMessage,
    }).catch((err) => {
      routeLogger.error({ err }, 'daemon.send: thread broadcast failed');
    });

    res.json({
      messageId: threadMsg.id,
      threadId: thread.id,
      target,
      recentUnread: [],
    });
  });

  // ─── GET /internal/agent/:agentId/receive ───────────────────
  // check_messages tool calls this. MVP returns empty (messages are pushed
  // via agent:deliver over the WS, so the LLM already saw them via stdin).
  r.get('/internal/agent/:agentId/receive', async (req, res) => {
    const bot = await authBot(db, req, res);
    if (!bot) return;
    res.json({ messages: [] });
  });

  // ─── POST /internal/agent/:agentId/resolve-channel ──────────
  r.post('/internal/agent/:agentId/resolve-channel', async (req, res) => {
    const bot = await authBot(db, req, res);
    if (!bot) return;

    const { target } = req.body ?? {};
    if (typeof target !== 'string') {
      res.status(400).json({ error: 'target is required' });
      return;
    }
    const parsed = parseTarget(target);
    if (!parsed) {
      res.status(400).json({ error: `Invalid target: ${target}` });
      return;
    }
    if (parsed.kind === 'dm') {
      const peer = await db.getBotByName(bot.org_id, parsed.name);
      if (!peer) {
        res.status(404).json({ error: `Bot not found: ${parsed.name}` });
        return;
      }
      const channel = await db.createChannel(bot.org_id, [bot.id, peer.id]);
      res.json({ channelId: channel.id });
      return;
    }
    // Thread — uploads aren't implemented yet (see /upload below); return the
    // thread id so chat-bridge has something to pass along, but upload will 501.
    const thread = await db.getThread(parsed.threadId);
    if (!thread || thread.org_id !== bot.org_id) {
      res.status(404).json({ error: `Thread not found: ${parsed.threadId}` });
      return;
    }
    res.json({ channelId: thread.id });
  });

  // ─── POST /internal/agent/:agentId/upload — MVP not implemented
  r.post('/internal/agent/:agentId/upload', async (req, res) => {
    const bot = await authBot(db, req, res);
    if (!bot) return;
    res.status(501).json({ error: 'upload not implemented in MVP' });
  });

  return r;
}
