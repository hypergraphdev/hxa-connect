/**
 * /daemon/connect WebSocket endpoint.
 *
 * Serves the Slock-compatible protocol used by @slock-ai/daemon. A daemon
 * connects with `?key=<bot_token>`; we treat the token as a primary bot
 * token, set the bot online, and push `agent:start` to instruct the daemon
 * to spawn a CLI runtime (MVP: Claude only).
 *
 * Messages destined for this bot (e.g. DM arrives via /api/send) are
 * translated into `agent:deliver` and pushed here — see ws/broadcast.ts.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import type { HubDB } from '../db.js';
import type { HubWS } from '../ws.js';
import type { Bot } from '../types.js';
import { wsLogger } from '../logger.js';
import type {
  DaemonAgentConfig,
  DaemonAgentDeliver,
  DaemonAgentStart,
  DaemonDeliveredMessage,
  DaemonInbound,
  DaemonOutbound,
} from './protocol.js';

interface DaemonConn {
  ws: WebSocket;
  bot: Bot;
  alive: boolean;
  connectedAt: number;
  /** Set to true once `ready` is received. */
  ready: boolean;
}

/** botId → active daemon connection (one at a time per bot). */
const daemonConnections = new Map<string, DaemonConn>();

/**
 * Public URL the daemon + its chat-bridge should call back to.
 * Daemon uses it for the WS it already holds; chat-bridge uses it for HTTP.
 * Driven by the same env vars as ws/broadcast.ts:getHubBaseUrl.
 */
function getCallbackServerUrl(): string {
  if (process.env.HUB_PUBLIC_URL) return process.env.HUB_PUBLIC_URL.replace(/\/$/, '');
  const domain = process.env.DOMAIN;
  const basePath = process.env.BASE_PATH ?? '';
  if (domain) return `https://${domain}${basePath}`;
  const port = process.env.PORT ?? process.env.HXA_CONNECT_PORT ?? '4800';
  return `http://localhost:${port}${basePath}`;
}

function send(ws: WebSocket, msg: DaemonOutbound): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Serialize a hub DM Message into the shape daemon's formatIncomingMessage expects. */
export function toDaemonDelivered(
  messageId: string,
  senderBotName: string,
  senderBotId: string,
  content: string,
  createdAt: number,
): DaemonDeliveredMessage {
  return {
    message_id: messageId,
    channel_type: 'dm',
    channel_name: senderBotName,
    sender_id: senderBotId,
    sender_name: senderBotName,
    content,
    created_at: createdAt,
  };
}

/**
 * Serialize a hub Thread message into a daemon agent:deliver payload.
 *
 * Why we encode thread_id INSIDE channel_name instead of using Slock's
 * native channel_type='thread' + parent_channel_name convention:
 *
 *  1. Slock's system prompt teaches the LLM that a thread target must
 *     carry a `:shortid` suffix — without one, the CLI treats the message
 *     as a top-level channel it isn't a member of and tends to stay
 *     silent (which is exactly what the user hit with LOCALTEST).
 *  2. Older `npx @slock-ai/daemon@latest` snapshots don't look at
 *     parent_channel_name, so we can't rely on it producing a
 *     `#<topic>:<shortid>` target.
 *
 * By setting channel_type='channel' and channel_name=`<topic>:<thread_id>`,
 * every daemon version falls into the same fallback branch of its
 * formatMessageTarget and emits `#<topic>:<thread_id>`. The LLM sees a
 * valid thread-style target, reuses it verbatim, and our parseTarget
 * splits on the first `:` to recover the full thread id.
 */
export function toDaemonDeliveredThread(
  messageId: string,
  senderBotName: string,
  senderBotId: string,
  content: string,
  createdAt: number,
  threadId: string,
  threadTopic: string,
): DaemonDeliveredMessage {
  const parent = (threadTopic || `t-${threadId.slice(0, 6)}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40) || 'thread';
  return {
    message_id: messageId,
    channel_type: 'channel',
    channel_name: `${parent}:${threadId}`,
    sender_id: senderBotId,
    sender_name: senderBotName,
    content,
    created_at: createdAt,
    thread_id: threadId,
  };
}

/** Push an agent:deliver to a bot's daemon, if connected. Returns true if delivered. */
export function deliverToDaemon(botId: string, message: DaemonDeliveredMessage): boolean {
  const conn = daemonConnections.get(botId);
  if (!conn || !conn.ready) return false;
  const event: DaemonAgentDeliver = {
    type: 'agent:deliver',
    agentId: botId,
    seq: Date.now(),
    message,
  };
  send(conn.ws, event);
  return true;
}

/** Is there a ready daemon for this bot? */
export function hasDaemonFor(botId: string): boolean {
  const conn = daemonConnections.get(botId);
  return !!conn && conn.ready;
}

export interface DaemonServerDeps {
  db: HubDB;
  /** Used to mark bot online/offline + broadcast bot_online/bot_offline to the org. */
  ws: HubWS;
}

export class DaemonServer {
  private wss: WebSocketServer;
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(private deps: DaemonServerDeps) {
    // noServer mode — HTTP upgrade is routed in src/index.ts by URL path.
    this.wss = new WebSocketServer({ noServer: true });

    this.heartbeat = setInterval(() => {
      for (const [botId, conn] of daemonConnections) {
        if (!conn.alive) {
          wsLogger.info({ botId }, 'daemon: no pong — terminating');
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }, 30_000);
  }

  /** Call from the HTTP upgrade listener when path matches /daemon/connect. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.onConnection(ws, req);
    });
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const key = url.searchParams.get('key');
    if (!key) {
      ws.close(4001, 'Missing ?key=<api_key>');
      return;
    }

    const bot = await this.deps.db.getBotByToken(key);
    if (!bot) {
      ws.close(4001, 'Invalid api_key');
      return;
    }
    if (bot.join_status !== 'active') {
      ws.close(4403, bot.join_status === 'pending' ? 'bot_pending_approval' : 'bot_rejected');
      return;
    }

    const org = await this.deps.db.getOrgById(bot.org_id);
    if (!org || org.status !== 'active') {
      ws.close(4100, 'Organization is not active');
      return;
    }

    // Replace any prior daemon for this bot — 1 daemon per bot.
    const prior = daemonConnections.get(bot.id);
    if (prior) {
      try { prior.ws.close(4004, 'Replaced by new daemon'); } catch { /* ignore */ }
      daemonConnections.delete(bot.id);
    }

    const conn: DaemonConn = {
      ws,
      bot,
      alive: true,
      connectedAt: Date.now(),
      ready: false,
    };
    daemonConnections.set(bot.id, conn);
    wsLogger.info({ botId: bot.id, botName: bot.name }, 'daemon: connected');

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', async (raw) => {
      let msg: DaemonInbound;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      await this.onInbound(conn, msg);
    });

    ws.on('close', async () => {
      if (daemonConnections.get(bot.id)?.ws !== ws) return;
      daemonConnections.delete(bot.id);
      await this.deps.db.setBotOnline(bot.id, false);
      this.deps.ws.broadcastToOrg(bot.org_id, {
        type: 'bot_offline',
        bot: { id: bot.id, name: bot.name },
      });
      wsLogger.info({ botId: bot.id, botName: bot.name }, 'daemon: disconnected');
    });

    ws.on('error', (err) => {
      wsLogger.error({ botId: bot.id, err: err.message }, 'daemon: ws error');
    });
  }

  private async onInbound(conn: DaemonConn, msg: DaemonInbound): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        conn.ready = true;
        await this.deps.db.setBotOnline(conn.bot.id, true);
        this.deps.ws.broadcastToOrg(conn.bot.org_id, {
          type: 'bot_online',
          bot: { id: conn.bot.id, name: conn.bot.name },
        });
        wsLogger.info(
          { botId: conn.bot.id, runtimes: (msg as { runtimes?: string[] }).runtimes, chosen: conn.bot.runtime },
          'daemon: ready',
        );
        // The daemon knows which local CLI to spawn from config.runtime.
        // We pick it from the bot's profile — set at register time by the
        // product console. Any unknown / missing value falls back to claude
        // so older bots registered before this feature existed still work.
        const SUPPORTED: DaemonAgentConfig['runtime'][] = ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'kimi'];
        const runtime = SUPPORTED.includes(conn.bot.runtime as DaemonAgentConfig['runtime'])
          ? (conn.bot.runtime as DaemonAgentConfig['runtime'])
          : 'claude';
        // Default model per runtime.
        // - claude: 'sonnet' (driver expects a short alias)
        // - gemini: 'gemini-2.5-flash' — the CLI otherwise defaults to Pro,
        //   whose free quota exhausts in a single session (observed 429 on
        //   very first turn).
        // - others: leave unset so the CLI honors its own user-level default.
        const DEFAULT_MODEL: Partial<Record<DaemonAgentConfig['runtime'], string>> = {
          claude: 'sonnet',
          // Newest + most capable Gemini tier. Note: Pro has the tightest
          // free daily quota — a long session can exhaust it and the CLI
          // will then return 429. If that happens we can fall back to
          // gemini-3-flash-preview which has far more headroom.
          gemini: 'gemini-3.1-pro',
        };
        const start: DaemonAgentStart = {
          type: 'agent:start',
          agentId: conn.bot.id,
          config: {
            runtime,
            model: DEFAULT_MODEL[runtime],
            name: conn.bot.name,
            displayName: conn.bot.name,
            description: conn.bot.bio || 'Local AI agent',
            serverUrl: getCallbackServerUrl(),
            authToken: (conn.bot as Bot & { token?: string }).token ?? undefined,
          },
        };
        // Note: bot.token is a hash in DB; chat-bridge actually uses the
        // original api-key (passed via --api-key) as daemonApiKey when
        // authToken isn't set on config. Leaving authToken undefined is
        // safe — daemon falls back to daemonApiKey.
        start.config.authToken = undefined;
        send(conn.ws, start);
        break;
      }
      case 'pong':
        conn.alive = true;
        break;
      case 'agent:status':
      case 'agent:activity':
      case 'agent:session':
      case 'agent:deliver:ack':
        // Record-only in MVP; surface in logs for debugging.
        wsLogger.debug({ botId: conn.bot.id, msg }, 'daemon: status update');
        break;
      default:
        wsLogger.debug({ botId: conn.bot.id, type: msg.type }, 'daemon: ignored message');
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const [, conn] of daemonConnections) {
      try { conn.ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    daemonConnections.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** For /health diagnostics. */
  getStats(): { connected_daemons: number; ready_daemons: number } {
    let ready = 0;
    for (const conn of daemonConnections.values()) if (conn.ready) ready++;
    return { connected_daemons: daemonConnections.size, ready_daemons: ready };
  }
}
