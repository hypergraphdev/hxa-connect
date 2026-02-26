import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HubDB } from './db.js';
import type { WebhookManager } from './webhook.js';
import { validateParts, type HubConfig, type Message, type MessagePart, type WireMessage, type WsServerEvent } from './types.js';
import { URL } from 'node:url';
import { redeemWsTicket, type WsTicket } from './ws-tickets.js';
import { wsLogger } from './logger.js';

interface WsClient {
  ws: WebSocket;
  botId?: string;
  orgId: string;
  isOrgAdmin: boolean; // org-level viewer (web UI)
  /** Scopes granted to this WS connection. null means full access (primary bot token or org key). */
  scopes: import('./types.js').TokenScope[] | null;
  /** Whether the client has responded to the last ping. */
  alive: boolean;
}

// W2: Track active WS connection count per bot
const botConnectionCount = new Map<string, number>();

function incrementBotConnections(botId: string): number {
  const count = (botConnectionCount.get(botId) ?? 0) + 1;
  botConnectionCount.set(botId, count);
  return count;
}

function decrementBotConnections(botId: string): number {
  const count = (botConnectionCount.get(botId) ?? 1) - 1;
  if (count <= 0) {
    botConnectionCount.delete(botId);
    return 0;
  }
  botConnectionCount.set(botId, count);
  return count;
}

export class HubWS {
  private wss: WebSocketServer;
  private clients: Set<WsClient> = new Set();
  private db: HubDB;
  private webhookManager: WebhookManager;
  private config: HubConfig;
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
      const tokenParam = url.searchParams.get('token');

      let token: string | null = null;

      let redeemedTicket: WsTicket | undefined;

      if (ticketParam) {
        // Preferred: one-time ticket exchange
        redeemedTicket = redeemWsTicket(ticketParam);
        if (!redeemedTicket) {
          ws.close(4001, 'Invalid or expired ticket');
          return;
        }
        token = redeemedTicket.token;
      } else if (tokenParam) {
        // Backward compat: direct token in URL (deprecated — logs a warning)
        wsLogger.warn('Deprecation: WS connection using ?token= in URL. Use POST /api/ws-ticket instead.');
        token = tokenParam;
      } else {
        ws.close(4001, 'Missing token or ticket');
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
  private clientHasScope(client: WsClient, required: import('./types.js').TokenScope): boolean {
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

        if (data.type === 'send' && client.botId) {
          // Scope check: sending messages requires 'message' scope
          if (!this.clientHasScope(client, 'message')) {
            this.send(client, { type: 'error', message: 'Insufficient token scope: message scope required to send messages' });
            return;
          }

          // Validate channel membership
          if (!this.db.isChannelMember(data.channel_id, client.botId)) {
            this.send(client, { type: 'error', message: 'Not a member of this channel' });
            return;
          }

          // Atomic rate limit check + record
          const rateCheck = this.db.checkAndRecordRateLimit(client.orgId, client.botId, 'message');
          if (!rateCheck.allowed) {
            this.send(client, { type: 'error', code: 'rate_limited', message: `Rate limit exceeded. Retry after ${rateCheck.retryAfter}s`, retry_after: rateCheck.retryAfter });
            return;
          }

          // Validate and handle parts
          let partsJson: string | null = null;
          if (data.parts && Array.isArray(data.parts)) {
            const partsError = validateParts(data.parts);
            if (partsError) {
              this.send(client, { type: 'error', message: partsError });
              return;
            }
            partsJson = JSON.stringify(data.parts);
          }

          // Resolve content from parts if not provided
          let content = data.content;
          if (!content && data.parts && Array.isArray(data.parts)) {
            for (const part of data.parts) {
              if ((part.type === 'text' || part.type === 'markdown') && typeof part.content === 'string') {
                content = part.content;
                break;
              }
            }
            if (!content) {
              content = `[${data.parts.map((p: any) => p.type).join(', ')}]`;
            }
          }

          if (!content) {
            this.send(client, { type: 'error', message: 'content or parts is required' });
            return;
          }

          if (content.length > this.config.max_message_length) {
            this.send(client, { type: 'error', message: `Message too long (max ${this.config.max_message_length} chars)` });
            return;
          }

          const contentType = data.content_type || 'text';
          const msg = this.db.createMessage(data.channel_id, client.botId, content, contentType, partsJson);
          const bot = this.db.getBotById(client.botId);

          // Audit (rate limit event already recorded atomically above)
          this.db.recordAudit(client.orgId, client.botId, 'message.send', 'channel_message', msg.id, { channel_id: data.channel_id, via: 'ws' });

          // Record catchup events for channel members except sender
          const channel = this.db.getChannel(data.channel_id);
          if (channel) {
            const members = this.db.getChannelMembers(data.channel_id);
            for (const m of members) {
              if (m.bot_id === client.botId) continue;
              this.db.recordCatchupEvent(channel.org_id, m.bot_id, 'channel_message_summary', {
                channel_id: channel.id,
                channel_name: channel.name ?? undefined,
                count: 1,
                last_at: msg.created_at,
              }, channel.id);
            }
          }

          this.broadcastMessage(data.channel_id, msg, bot?.name || 'unknown');
        }
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

  /**
   * Broadcast a new message to all relevant clients + fire webhooks
   */
  broadcastMessage(channelId: string, message: Message, senderName: string) {
    const channel = this.db.getChannel(channelId);
    if (!channel) return;

    const members = this.db.getChannelMembers(channelId).map(m => m.bot_id);

    // Parse parts for wire format: send parsed array, not raw JSON string
    let parsedParts: MessagePart[];
    try {
      parsedParts = message.parts
        ? JSON.parse(message.parts)
        : [{ type: 'text', content: message.content }];
    } catch {
      parsedParts = [{ type: 'text', content: message.content }];
    }

    const wireMessage: WireMessage = { ...message, parts: parsedParts };

    const event: WsServerEvent = {
      type: 'message',
      channel_id: channelId,
      message: wireMessage,
      sender_name: senderName,
    };

    // Fire webhooks for members who have one (and aren't the sender)
    // Webhook payload uses the same WsServerEvent envelope as WS events
    const webhookPayload = { webhook_version: '1' as const, ...event };
    for (const botId of members) {
      if (botId === message.sender_id) continue;
      const bot = this.db.getBotById(botId);
      if (bot?.webhook_url) {
        wsLogger.info({ botName: bot.name }, 'Webhook dispatch for channel message');
        // Fire-and-forget — retries happen in background
        void this.webhookManager.deliver(bot.id, bot.webhook_url, bot.webhook_secret, webhookPayload);
      }
    }

    for (const client of this.clients) {
      if (client.orgId !== channel.org_id) continue;

      // Org admins see everything
      if (client.isOrgAdmin) {
        this.send(client, event);
        continue;
      }

      // Bots only see channels they're in
      if (client.botId && members.includes(client.botId)) {
        this.send(client, event);
      }
    }
  }

  /**
   * Broadcast thread event to all thread participants + org admins + participant webhooks
   */
  broadcastThreadEvent(orgId: string, threadId: string, event: WsServerEvent) {
    const participantIds = this.db.getParticipants(threadId).map(p => p.bot_id);

    let excludeWebhookBotId: string | undefined;
    if (event.type === 'thread_message' && event.message.sender_id) {
      excludeWebhookBotId = event.message.sender_id;
    } else if (event.type === 'thread_artifact' && event.artifact.contributor_id) {
      excludeWebhookBotId = event.artifact.contributor_id;
    }

    this.fireThreadWebhooks(participantIds, event, excludeWebhookBotId);

    const participantSet = new Set(participantIds);
    for (const client of this.clients) {
      if (client.orgId !== orgId) continue;

      if (client.isOrgAdmin) {
        this.send(client, event);
        continue;
      }

      if (client.botId && participantSet.has(client.botId)) {
        this.send(client, event);
      }
    }
  }

  /**
   * Broadcast event to all clients in an org
   */
  broadcastToOrg(orgId: string, event: WsServerEvent, excludeBotId?: string) {
    for (const client of this.clients) {
      if (client.orgId !== orgId) continue;
      if (excludeBotId && client.botId === excludeBotId) continue;
      this.send(client, event);
    }
  }

  private send(client: WsClient, event: WsServerEvent) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(event));
    }
  }

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
  getHealthStats(): { uptime_ms: number; connected_clients: number; connected_bots: number } {
    const botIds = new Set<string>();
    for (const client of this.clients) {
      if (client.botId) botIds.add(client.botId);
    }
    return {
      uptime_ms: Date.now() - this.startedAt,
      connected_clients: this.clients.size,
      connected_bots: botIds.size,
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

  private fireThreadWebhooks(participantIds: string[], event: WsServerEvent, excludeBotId?: string) {
    const webhookPayload = { webhook_version: '1' as const, ...event };
    for (const botId of participantIds) {
      if (excludeBotId && botId === excludeBotId) continue;

      const bot = this.db.getBotById(botId);
      if (!bot?.webhook_url) continue;

      wsLogger.info({ botName: bot.name }, 'Webhook dispatch for thread event');
      // Fire-and-forget — retries happen in background
      void this.webhookManager.deliver(bot.id, bot.webhook_url, bot.webhook_secret, webhookPayload);
    }
  }
}
