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
 * Supported (MVP):
 *   dm:@<name>             → { kind: 'dm', peer: '<name>' }
 *   #<channel>             → { kind: 'channel', channel: '<channel>' }
 *   dm:@<name>:<threadId>  → { kind: 'dm_thread' } — not supported, falls back to dm
 *   #<channel>:<threadId>  → { kind: 'channel_thread' } — not supported
 */
function parseTarget(target: string): { kind: 'dm' | 'channel'; name: string } | null {
  const trimmed = target.trim();
  if (trimmed.startsWith('dm:@')) {
    const rest = trimmed.slice(4);
    const name = rest.split(':', 1)[0];
    if (!name) return null;
    return { kind: 'dm', name };
  }
  if (trimmed.startsWith('#')) {
    const rest = trimmed.slice(1);
    const name = rest.split(':', 1)[0];
    if (!name) return null;
    return { kind: 'channel', name };
  }
  // Bare name → treat as DM peer.
  return { kind: 'dm', name: trimmed };
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

    // MVP: only DM is supported. Channels/threads return a clear error that
    // chat-bridge will surface to the LLM.
    if (parsed.kind !== 'dm') {
      res.status(400).json({ error: 'Only DM targets are supported in MVP (dm:@name)' });
      return;
    }

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
      // chat-bridge looks at recentUnread — MVP returns empty.
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
    if (!parsed || parsed.kind !== 'dm') {
      res.status(400).json({ error: 'Only DM targets are supported in MVP' });
      return;
    }
    const peer = await db.getBotByName(bot.org_id, parsed.name);
    if (!peer) {
      res.status(404).json({ error: `Bot not found: ${parsed.name}` });
      return;
    }
    const channel = await db.createChannel(bot.org_id, [bot.id, peer.id]);
    res.json({ channelId: channel.id });
  });

  // ─── POST /internal/agent/:agentId/upload — MVP not implemented
  r.post('/internal/agent/:agentId/upload', async (req, res) => {
    const bot = await authBot(db, req, res);
    if (!bot) return;
    res.status(501).json({ error: 'upload not implemented in MVP' });
  });

  return r;
}
