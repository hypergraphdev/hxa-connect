import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HubDB } from '../db.js';
import type { WebhookManager } from '../webhook.js';
import type { HubConfig, Message, SessionRole, TokenScope, WsServerEvent } from '../types.js';
import { URL } from 'node:url';
import { redeemWsTicket, type WsTicket } from '../ws-tickets.js';
import { wsLogger } from '../logger.js';
import type { SessionStore } from '../session.js';

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
  private sessionHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionStore: SessionStore | null = null;
  private startedAt = Date.now();
  private recentConnections: number[] = [];

  /** Track a new connection and prune entries older than 5 minutes. */
  private trackConnection(): void {
    const now = Date.now();
    this.recentConnections.push(now);
    // Prune on every insert to bound memory
    if (this.recentConnections.length > 100) {
      const fiveMinAgo = now - 300_000;
      this.recentConnections = this.recentConnections.filter(t => t > fiveMinAgo);
    }
  }

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

    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const ticketParam = url.searchParams.get('ticket');

      let redeemedTicket: WsTicket | undefined;

      if (ticketParam) {
        redeemedTicket = redeemWsTicket(ticketParam);
        if (!redeemedTicket) {
          ws.close(4001, 'Invalid or expired ticket');
          return;
        }
      } else {
        ws.close(4001, 'Missing ticket. Use POST /api/ws-ticket to obtain a one-time ticket.');
        return;
      }

      const token = redeemedTicket.token ?? null;

      // Session-based connection (ADR-002)
      if (redeemedTicket?.sessionId) {
        // Re-check org status (may have changed since ticket was issued)
        if (redeemedTicket.orgId) {
          const org = await db.getOrgById(redeemedTicket.orgId);
          if (!org || org.status !== 'active') {
            ws.close(4100, 'Organization is not active');
            return;
          }
        }

        const client: WsClient = {
          ws,
          sessionId: redeemedTicket.sessionId,
          role: redeemedTicket.role,
          botId: redeemedTicket.botId,
          orgId: redeemedTicket.orgId!,
          isOrgAdmin: redeemedTicket.role === 'org_admin',
          scopes: redeemedTicket.scopes ?? null,
          alive: true,
          subscriptions: new Set(),
          connectedAt: Date.now(),
        };
        this.clients.add(client);
        this.trackConnection();
        // Track session-based bot connections so close handler can decrement correctly
        if (client.botId) {
          incrementBotConnections(client.botId);
        }
        this.setupHandlers(client);
        return;
      }

      // Token-based paths require a token from the redeemed ticket
      if (!token) {
        ws.close(4001, 'Invalid ticket');
        return;
      }

      // Authenticate as bot via primary token
      const bot = await db.getBotByToken(token);
      if (bot) {
        // Phase 3: Validate org binding if ticket specifies an orgId
        if (redeemedTicket?.orgId && redeemedTicket.orgId !== bot.org_id) {
          ws.close(4003, 'Bot does not belong to ticket org');
          return;
        }

        // Phase 4: Check org status before allowing connection
        const botOrg = await db.getOrgById(bot.org_id);
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
          connectedAt: Date.now(),
        };
        this.clients.add(client);
        this.trackConnection();
        const connCount = incrementBotConnections(bot.id);
        await db.setBotOnline(bot.id, true);

        // Reset degraded webhook status on reconnect
        await db.resetWebhookDegraded(bot.id);

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
      const scopedToken = await db.getBotTokenByToken(token);
      if (scopedToken) {
        // Check expiration
        if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
          ws.close(4001, 'Token expired');
          return;
        }
        const scopedBot = await db.getBotById(scopedToken.bot_id);
        if (scopedBot) {
          // Phase 3: Validate org binding if ticket specifies an orgId
          if (redeemedTicket?.orgId && redeemedTicket.orgId !== scopedBot.org_id) {
            ws.close(4003, 'Bot does not belong to ticket org');
            return;
          }

          // Phase 4: Check org status before allowing connection
          const scopedOrg = await db.getOrgById(scopedBot.org_id);
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
            connectedAt: Date.now(),
          };
          this.clients.add(client);
          this.trackConnection();
          const scopedConnCount = incrementBotConnections(scopedBot.id);
          await db.setBotOnline(scopedBot.id, true);
          await db.touchBotToken(scopedToken.id);

          // Reset degraded webhook status on reconnect
          await db.resetWebhookDegraded(scopedBot.id);

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
    client.ws.on('message', async (raw) => {
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
          if (client.subscriptions.size >= 100) {
            this.send(client, { type: 'error', message: 'Maximum subscription limit reached (100)' });
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
          case 'send': await handleSend(this, client, data); break;
          case 'send_dm': await handleSendDm(this, client, data); break;
          case 'send_thread_message': await handleSendThreadMessage(this, client, data); break;
          case 'thread_create': await handleThreadCreate(this, client, data); break;
          case 'thread_update': await handleThreadUpdate(this, client, data); break;
          case 'thread_invite': await handleThreadInvite(this, client, data); break;
          case 'thread_join': await handleThreadJoin(this, client, data); break;
          case 'thread_leave': await handleThreadLeave(this, client, data); break;
          case 'thread_remove_participant': await handleThreadRemoveParticipant(this, client, data); break;
          case 'artifact_add': await handleArtifactAdd(this, client, data); break;
          case 'artifact_update': await handleArtifactUpdate(this, client, data); break;
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

    client.ws.on('close', async () => {
      this.clients.delete(client);
      if (client.botId) {
        // W2: Only mark offline when last connection closes
        const remaining = decrementBotConnections(client.botId);
        if (remaining === 0) {
          await this.db.setBotOnline(client.botId, false);
          const bot = await this.db.getBotById(client.botId);
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

  async broadcastMessage(channelId: string, message: Message, senderName: string): Promise<void> {
    await doBroadcastMessage(this.clients, this.db, this.webhookManager, channelId, message, senderName);
  }

  async broadcastThreadEvent(orgId: string, threadId: string, event: WsServerEvent): Promise<void> {
    await doBroadcastThreadEvent(this.clients, this.db, this.webhookManager, orgId, threadId, event);
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

  // ─── Session integration (ADR-002) ──────────────────────

  /** Set the session store and start 60s session validation heartbeat. */
  setSessionStore(store: SessionStore): void {
    this.sessionStore = store;
    this.sessionHeartbeatInterval = setInterval(async () => {
      if (!this.sessionStore) return;
      for (const client of [...this.clients]) {
        if (client.sessionId) {
          const session = await this.sessionStore.get(client.sessionId);
          if (!session) {
            // Let the close event handler clean up (decrement bot connections, etc.)
            client.ws.close(4002, 'Session expired');
          }
        }
      }
    }, 60_000);
  }

  // ─── Session revocation (ADR-002) ────────────────────────

  /** Disconnect all WS clients tied to a specific session. */
  disconnectBySessionId(sessionId: string): void {
    for (const client of [...this.clients]) {
      if (client.sessionId === sessionId) {
        // Let the close event handler clean up (decrement bot connections, etc.)
        client.ws.close(4002, 'Session revoked');
      }
    }
  }

  /** Disconnect all WS clients with a given role (and optional org scope). */
  disconnectByRole(role: SessionRole, orgId?: string): void {
    for (const client of [...this.clients]) {
      if (client.role === role && (!orgId || client.orgId === orgId)) {
        // Let the close event handler clean up (decrement bot connections, etc.)
        client.ws.close(4002, 'Credential rotated');
      }
    }
  }

  /** Disconnect all WS clients tied to a specific bot (token + session). */
  disconnectByBotId(botId: string): void {
    for (const client of [...this.clients]) {
      if (client.botId === botId) {
        // Let the close event handler clean up (decrement bot connections, etc.)
        client.ws.close(4002, 'Token regenerated');
      }
    }
  }

  /** Disconnect only session-based WS clients for a specific bot (preserves token-auth M2M connections). */
  disconnectSessionClientsByBotId(botId: string): void {
    for (const client of [...this.clients]) {
      if (client.botId === botId && client.sessionId) {
        // Let the close event handler clean up (decrement bot connections, etc.)
        client.ws.close(4002, 'Session evicted');
      }
    }
  }

  /** O1: Return health stats for the /health endpoint */
  getHealthStats(): {
    uptime_ms: number;
    connected_clients: number;
    connected_bots: number;
    ws_metrics: import('./metrics.js').WsMetrics;
    client_breakdown: {
      by_type: { bot_token: number; session: number };
      by_bot: Array<{ bot_id: string; count: number }>;
      by_age: { under_1m: number; under_10m: number; under_1h: number; over_1h: number };
      not_alive: number;
      reconnect_rate_5m: number;
    };
  } {
    const now = Date.now();
    const botIds = new Set<string>();
    for (const client of this.clients) {
      if (client.botId) botIds.add(client.botId);
    }

    // Prune stale entries for accurate rate
    const fiveMinAgo = now - 300_000;
    this.recentConnections = this.recentConnections.filter(t => t > fiveMinAgo);

    // Diagnostic breakdown
    let botTokenCount = 0;
    let sessionCount = 0;
    let notAlive = 0;
    const botConnCounts = new Map<string, number>();
    let ageUnder1m = 0, ageUnder10m = 0, ageUnder1h = 0, ageOver1h = 0;

    for (const client of this.clients) {
      if (client.sessionId) sessionCount++;
      else botTokenCount++;
      if (!client.alive) notAlive++;
      if (client.botId) {
        botConnCounts.set(client.botId, (botConnCounts.get(client.botId) ?? 0) + 1);
      }
      const age = now - client.connectedAt;
      if (age < 60_000) ageUnder1m++;
      else if (age < 600_000) ageUnder10m++;
      else if (age < 3_600_000) ageUnder1h++;
      else ageOver1h++;
    }

    const topBots = [...botConnCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([bot_id, count]) => ({ bot_id, count }));

    return {
      uptime_ms: Date.now() - this.startedAt,
      connected_clients: this.clients.size,
      connected_bots: botIds.size,
      ws_metrics: getMetrics(),
      client_breakdown: {
        by_type: { bot_token: botTokenCount, session: sessionCount },
        by_bot: topBots,
        by_age: { under_1m: ageUnder1m, under_10m: ageUnder10m, under_1h: ageUnder1h, over_1h: ageOver1h },
        not_alive: notAlive,
        reconnect_rate_5m: this.recentConnections.length,
      },
    };
  }

  /**
   * O2: Graceful shutdown — close all WS connections with close frame.
   * @param code WebSocket close code: 1012 for service restart (clients reconnect immediately), 1001 for going away.
   */
  async shutdown(code: number = 1001): Promise<void> {
    // Stop heartbeats
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.sessionHeartbeatInterval) {
      clearInterval(this.sessionHeartbeatInterval);
      this.sessionHeartbeatInterval = null;
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
