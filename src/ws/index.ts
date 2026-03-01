import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HubDB } from '../db.js';
import type { WebhookManager } from '../webhook.js';
import type { HubConfig, Message, TokenScope, WsServerEvent } from '../types.js';
import { URL } from 'node:url';
import { redeemWsTicket, type WsTicket } from '../ws-tickets.js';
import { wsLogger } from '../logger.js';

import type { WsClient, WsHub } from './protocol.js';
import { incrementBotConnections, decrementBotConnections } from './protocol.js';
import { incOp, incAck, incError, getMetrics } from './metrics.js';
import {
  broadcastMessage as doBroadcastMessage,
  broadcastThreadEvent as doBroadcastThreadEvent,
  broadcastToOrg as doBroadcastToOrg,
  sendToClient,
} from './broadcast.js';
import {
  handleSend,
  handleSendDm,
  handleSendThreadMessage,
  handleThreadCreate,
  handleThreadUpdate,
  handleThreadInvite,
  handleThreadJoin,
  handleThreadLeave,
  handleThreadRemoveParticipant,
  handleArtifactAdd,
  handleArtifactUpdate,
} from './handlers.js';

export type { WsClient, WsHub } from './protocol.js';

export class HubWS implements WsHub {
  private wss: WebSocketServer;
  readonly clients: Set<WsClient> = new Set();
  readonly db: HubDB;
  readonly webhookManager: WebhookManager;
  readonly config: HubConfig;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();

  constructor(server: Server, db: HubDB, webhookManager: WebhookManager, config: HubConfig) {
    this.db = db;
    this.webhookManager = webhookManager;
    this.config = config;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    // W1: Server-side heartbeat — ping every 30s, terminate if no pong within 60s
    this.heartbeatInterval = setInterval(() => {
      // Snapshot to avoid Set mutation during iteration (terminate triggers close → delete)
      for (const client of [...this.clients]) {
        if (!client.alive) {
          // No pong received since last ping — terminate
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
    }, 30_000);

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const ticketParam = url.searchParams.get('ticket');

      let token: string | null = null;

      let redeemedTicket: WsTicket | undefined;

      if (ticketParam) {
        redeemedTicket = redeemWsTicket(ticketParam);
        if (!redeemedTicket) {
          ws.close(4001, 'Invalid or expired ticket');
          return;
        }
        token = redeemedTicket.token;
      } else {
        ws.close(4001, 'Missing ticket. Use POST /api/ws-ticket to obtain a one-time ticket.');
        return;
      }

      // Authenticate as bot via primary token
      const bot = db.getBotByToken(token);
      if (bot) {
        // Phase 3: Validate org binding if ticket specifies an orgId
        if (redeemedTicket?.orgId && redeemedTicket.orgId !== bot.org_id) {
          ws.close(4003, 'Bot does not belong to ticket org');
          return;
        }

        // Phase 4: Check org status before allowing connection
        const botOrg = db.getOrgById(bot.org_id);
        if (!botOrg || botOrg.status !== 'active') {
          ws.close(4100, 'Organization is not active');
          return;
        }

        const client: WsClient = {
          ws,
          botId: bot.id,
          orgId: bot.org_id,
          isOrgAdmin: false,
          scopes: null, // primary token = full access
          alive: true,
          subscriptions: new Set(),
        };
        this.clients.add(client);
        const connCount = incrementBotConnections(bot.id);
        db.setBotOnline(bot.id, true);

        // Reset degraded webhook status on reconnect
        db.resetWebhookDegraded(bot.id);

        // W2: Only broadcast bot_online on first connection (0→1)
        if (connCount === 1) {
          this.broadcastToOrg(bot.org_id, {
            type: 'bot_online',
            bot: { id: bot.id, name: bot.name },
          }, bot.id);
        }

        this.setupHandlers(client);
        return;
      }

      // Authenticate via scoped token (bot_tokens table)
      const scopedToken = db.getBotTokenByToken(token);
      if (scopedToken) {
        // Check expiration
        if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
          ws.close(4001, 'Token expired');
          return;
        }
        const scopedBot = db.getBotById(scopedToken.bot_id);
        if (scopedBot) {
          // Phase 3: Validate org binding if ticket specifies an orgId
          if (redeemedTicket?.orgId && redeemedTicket.orgId !== scopedBot.org_id) {
            ws.close(4003, 'Bot does not belong to ticket org');
            return;
          }

          // Phase 4: Check org status before allowing connection
          const scopedOrg = db.getOrgById(scopedBot.org_id);
          if (!scopedOrg || scopedOrg.status !== 'active') {
            ws.close(4100, 'Organization is not active');
            return;
          }

          const client: WsClient = {
            ws,
            botId: scopedBot.id,
            orgId: scopedBot.org_id,
            isOrgAdmin: false,
            scopes: scopedToken.scopes, // scoped token = restricted access
            alive: true,
            subscriptions: new Set(),
          };
          this.clients.add(client);
          const scopedConnCount = incrementBotConnections(scopedBot.id);
          db.setBotOnline(scopedBot.id, true);
          db.touchBotToken(scopedToken.id);

          // Reset degraded webhook status on reconnect
          db.resetWebhookDegraded(scopedBot.id);

          // W2: Only broadcast bot_online on first connection (0→1)
          if (scopedConnCount === 1) {
            this.broadcastToOrg(scopedBot.org_id, {
              type: 'bot_online',
              bot: { id: scopedBot.id, name: scopedBot.name },
            }, scopedBot.id);
          }

          this.setupHandlers(client);
          return;
        }
        // Scoped token references an unknown bot — reject explicitly
        ws.close(4001, 'Token references unknown bot');
        return;
      }

      // Try org ticket (reusable session token from login) — for web UI / human admins
      const orgTicket = db.getOrgTicket(token);
      if (orgTicket && orgTicket.reusable && !orgTicket.consumed && orgTicket.expires_at > Date.now()) {
        const ticketOrg = db.getOrgById(orgTicket.org_id);
        if (ticketOrg) {
          // Phase 3: Validate org binding if ws-ticket specifies an orgId
          if (redeemedTicket?.orgId && redeemedTicket.orgId !== ticketOrg.id) {
            ws.close(4003, 'Token does not belong to ticket org');
            return;
          }

          // Phase 4: Check org status before allowing connection
          if (ticketOrg.status !== 'active') {
            ws.close(4100, 'Organization is not active');
            return;
          }

          const client: WsClient = {
            ws,
            orgId: ticketOrg.id,
            isOrgAdmin: true,
            scopes: null, // org admin = full access
            alive: true,
            subscriptions: new Set(),
          };
          this.clients.add(client);
          this.setupHandlers(client);
          return;
        }
      }

      ws.close(4001, 'Invalid token');
    });
  }

  /**
   * Check whether a client's scoped token grants the required scope.
   * Clients with null scopes (primary token or org key) always pass.
   * 'full' scope implies all other scopes.
   */
  clientHasScope(client: WsClient, required: TokenScope): boolean {
    if (client.scopes === null) return true; // full access
    return client.scopes.includes('full') || client.scopes.includes(required);
  }

  private setupHandlers(client: WsClient) {
    client.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'ping') {
          this.send(client, { type: 'pong' });
          return;
        }

        if (data.type === 'subscribe') {
          if (!client.isOrgAdmin) {
            this.send(client, { type: 'error', message: 'subscribe is only available for org admin connections' });
            return;
          }
          if (data.channel_id) client.subscriptions.add(data.channel_id);
          if (data.thread_id) client.subscriptions.add(data.thread_id);
          return;
        }

        if (data.type === 'unsubscribe') {
          if (!client.isOrgAdmin) {
            this.send(client, { type: 'error', message: 'unsubscribe is only available for org admin connections' });
            return;
          }
          if (data.channel_id) client.subscriptions.delete(data.channel_id);
          if (data.thread_id) client.subscriptions.delete(data.thread_id);
          return;
        }

        // All remaining types require a bot identity
        if (!client.botId) return;

        const opStart = Date.now();
        incOp();

        switch (data.type) {
          case 'send': handleSend(this, client, data); break;
          case 'send_dm': handleSendDm(this, client, data); break;
          case 'send_thread_message': handleSendThreadMessage(this, client, data); break;
          case 'thread_create': handleThreadCreate(this, client, data); break;
          case 'thread_update': handleThreadUpdate(this, client, data); break;
          case 'thread_invite': handleThreadInvite(this, client, data); break;
          case 'thread_join': handleThreadJoin(this, client, data); break;
          case 'thread_leave': handleThreadLeave(this, client, data); break;
          case 'thread_remove_participant': handleThreadRemoveParticipant(this, client, data); break;
          case 'artifact_add': handleArtifactAdd(this, client, data); break;
          case 'artifact_update': handleArtifactUpdate(this, client, data); break;
        }

        const latency = Date.now() - opStart;
        wsLogger.debug({ op: data.type, ref: data.ref, org: client.orgId, bot: client.botId, latency_ms: latency }, 'ws op');
      } catch {
        this.send(client, { type: 'error', message: 'Invalid message format' });
      }
    });

    // W1: mark alive on pong
    client.ws.on('pong', () => {
      client.alive = true;
    });

    client.ws.on('close', () => {
      this.clients.delete(client);
      if (client.botId) {
        // W2: Only mark offline when last connection closes
        const remaining = decrementBotConnections(client.botId);
        if (remaining === 0) {
          this.db.setBotOnline(client.botId, false);
          const bot = this.db.getBotById(client.botId);
          if (bot) {
            this.broadcastToOrg(bot.org_id, {
              type: 'bot_offline',
              bot: { id: bot.id, name: bot.name },
            }, bot.id);
          }
        }
      }
    });

    client.ws.on('error', () => {
      // error will be followed by close event, which handles cleanup
    });
  }

  // ─── WsHub interface: send / ack / error ───────────────────

  send(client: WsClient, event: WsServerEvent): void {
    sendToClient(client, event);
  }

  sendAck(client: WsClient, ref: string, result: Record<string, unknown>): void {
    incAck();
    this.send(client, { type: 'ack', ref, result });
  }

  sendError(client: WsClient, message: string, opts?: { ref?: string; code?: string; retry_after?: number }): void {
    incError(opts?.code);
    const event: WsServerEvent = { type: 'error', message };
    if (opts?.ref) (event as any).ref = opts.ref;
    if (opts?.code) (event as any).code = opts.code;
    if (opts?.retry_after !== undefined) (event as any).retry_after = opts.retry_after;
    this.send(client, event);
  }

  // ─── WsHub interface: broadcast ────────────────────────────

  broadcastMessage(channelId: string, message: Message, senderName: string): void {
    doBroadcastMessage(this.clients, this.db, this.webhookManager, channelId, message, senderName);
  }

  broadcastThreadEvent(orgId: string, threadId: string, event: WsServerEvent): void {
    doBroadcastThreadEvent(this.clients, this.db, this.webhookManager, orgId, threadId, event);
  }

  broadcastToOrg(orgId: string, event: WsServerEvent, excludeBotId?: string): void {
    doBroadcastToOrg(this.clients, orgId, event, excludeBotId);
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * Disconnect all WebSocket clients belonging to a specific org.
   * Used when org is suspended or destroyed.
   */
  disconnectOrg(orgId: string, closeCode: number, reason: string): void {
    for (const client of [...this.clients]) {
      if (client.orgId === orgId) {
        client.ws.close(closeCode, reason);
      }
    }
  }

  /** O1: Return health stats for the /health endpoint */
  getHealthStats(): { uptime_ms: number; connected_clients: number; connected_bots: number; ws_metrics: import('./metrics.js').WsMetrics } {
    const botIds = new Set<string>();
    for (const client of this.clients) {
      if (client.botId) botIds.add(client.botId);
    }
    return {
      uptime_ms: Date.now() - this.startedAt,
      connected_clients: this.clients.size,
      connected_bots: botIds.size,
      ws_metrics: getMetrics(),
    };
  }

  /**
   * O2: Graceful shutdown — close all WS connections with close frame.
   * @param code WebSocket close code: 1012 for service restart (clients reconnect immediately), 1001 for going away.
   */
  async shutdown(code: number = 1001): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    const reason = code === 1012 ? 'Service restart' : 'Server shutting down';

    // Send close frame to all clients
    const closePromises: Promise<void>[] = [];
    for (const client of this.clients) {
      closePromises.push(new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (client.ws.readyState !== WebSocket.CLOSED) {
            client.ws.terminate();
          }
          resolve();
        }, 5000);
        client.ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        client.ws.close(code, reason);
      }));
    }

    await Promise.all(closePromises);

    // Close the WebSocket server
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
