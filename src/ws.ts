import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HubDB } from './db.js';
import type { WebhookManager } from './webhook.js';
import { validateParts, type HubConfig, type Message, type MessagePart, type WireMessage, type WsServerEvent } from './types.js';
import { URL } from 'node:url';
import { redeemWsTicket } from './ws-tickets.js';
import { wsLogger } from './logger.js';

interface WsClient {
  ws: WebSocket;
  agentId?: string;
  orgId: string;
  isOrgAdmin: boolean; // org-level viewer (web UI)
  /** Scopes granted to this WS connection. null means full access (primary agent token or org key). */
  scopes: import('./types.js').TokenScope[] | null;
  /** Whether the client has responded to the last ping. */
  alive: boolean;
}

// W2: Track active WS connection count per agent
const agentConnectionCount = new Map<string, number>();

function incrementAgentConnections(agentId: string): number {
  const count = (agentConnectionCount.get(agentId) ?? 0) + 1;
  agentConnectionCount.set(agentId, count);
  return count;
}

function decrementAgentConnections(agentId: string): number {
  const count = (agentConnectionCount.get(agentId) ?? 1) - 1;
  if (count <= 0) {
    agentConnectionCount.delete(agentId);
    return 0;
  }
  agentConnectionCount.set(agentId, count);
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

      let ticketAdminSecret: string | undefined;

      if (ticketParam) {
        // Preferred: one-time ticket exchange
        const ticket = redeemWsTicket(ticketParam);
        if (!ticket) {
          ws.close(4001, 'Invalid or expired ticket');
          return;
        }
        token = ticket.token;
        ticketAdminSecret = ticket.adminSecret;
      } else if (tokenParam) {
        // Backward compat: direct token in URL (deprecated — logs a warning)
        wsLogger.warn('Deprecation: WS connection using ?token= in URL. Use POST /api/ws-ticket instead.');
        token = tokenParam;
      } else {
        ws.close(4001, 'Missing token or ticket');
        return;
      }

      // Authenticate as agent via primary token
      const agent = db.getAgentByToken(token);
      if (agent) {
        const client: WsClient = {
          ws,
          agentId: agent.id,
          orgId: agent.org_id,
          isOrgAdmin: false,
          scopes: null, // primary token = full access
          alive: true,
        };
        this.clients.add(client);
        const connCount = incrementAgentConnections(agent.id);
        db.setAgentOnline(agent.id, true);

        // Reset degraded webhook status on reconnect
        db.resetWebhookDegraded(agent.id);

        // W2: Only broadcast agent_online on first connection (0→1)
        if (connCount === 1) {
          this.broadcastToOrg(agent.org_id, {
            type: 'agent_online',
            agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
          }, agent.id);
        }

        this.setupHandlers(client);
        return;
      }

      // Authenticate via scoped token (agent_tokens table)
      const scopedToken = db.getAgentTokenByToken(token);
      if (scopedToken) {
        // Check expiration
        if (scopedToken.expires_at !== null && scopedToken.expires_at < Date.now()) {
          ws.close(4001, 'Token expired');
          return;
        }
        const scopedAgent = db.getAgentById(scopedToken.agent_id);
        if (scopedAgent) {
          const client: WsClient = {
            ws,
            agentId: scopedAgent.id,
            orgId: scopedAgent.org_id,
            isOrgAdmin: false,
            scopes: scopedToken.scopes, // scoped token = restricted access
            alive: true,
          };
          this.clients.add(client);
          const scopedConnCount = incrementAgentConnections(scopedAgent.id);
          db.setAgentOnline(scopedAgent.id, true);
          db.touchAgentToken(scopedToken.id);

          // Reset degraded webhook status on reconnect
          db.resetWebhookDegraded(scopedAgent.id);

          // W2: Only broadcast agent_online on first connection (0→1)
          if (scopedConnCount === 1) {
            this.broadcastToOrg(scopedAgent.org_id, {
              type: 'agent_online',
              agent: { id: scopedAgent.id, name: scopedAgent.name, display_name: scopedAgent.display_name },
            }, scopedAgent.id);
          }

          this.setupHandlers(client);
          return;
        }
        // Scoped token references an unknown agent — reject explicitly
        ws.close(4001, 'Token references unknown agent');
        return;
      }

      // Try org key + org admin secret (for web UI / human admins)
      const org = db.getOrgByKey(token);
      if (org) {
        // Require org-scoped admin secret (from ticket or deprecated URL param)
        const adminUrlParam = url.searchParams.get('admin');
        if (adminUrlParam && !ticketAdminSecret) {
          wsLogger.warn('Deprecation: WS connection using ?admin= in URL. Use POST /api/ws-ticket with X-Admin-Secret header instead.');
        }
        const adminToken = ticketAdminSecret || adminUrlParam;
        if (!adminToken || !db.verifyOrgAdminSecret(org.id, adminToken)) {
          ws.close(4003, 'Org admin secret required for console access');
          return;
        }

        const client: WsClient = {
          ws,
          orgId: org.id,
          isOrgAdmin: true,
          scopes: null, // org admin = full access
          alive: true,
        };
        this.clients.add(client);
        this.setupHandlers(client);
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

        if (data.type === 'send' && client.agentId) {
          // Scope check: sending messages requires 'message' scope
          if (!this.clientHasScope(client, 'message')) {
            this.send(client, { type: 'error', message: 'Insufficient token scope: message scope required to send messages' });
            return;
          }

          // Validate channel membership
          if (!this.db.isChannelMember(data.channel_id, client.agentId)) {
            this.send(client, { type: 'error', message: 'Not a member of this channel' });
            return;
          }

          // Atomic rate limit check + record
          const rateCheck = this.db.checkAndRecordRateLimit(client.orgId, client.agentId, 'message');
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
          const msg = this.db.createMessage(data.channel_id, client.agentId, content, contentType, partsJson);
          const agent = this.db.getAgentById(client.agentId);

          // Audit (rate limit event already recorded atomically above)
          this.db.recordAudit(client.orgId, client.agentId, 'message.send', 'channel_message', msg.id, { channel_id: data.channel_id, via: 'ws' });

          // Record catchup events for channel members except sender
          const channel = this.db.getChannel(data.channel_id);
          if (channel) {
            const members = this.db.getChannelMembers(data.channel_id);
            for (const m of members) {
              if (m.agent_id === client.agentId) continue;
              this.db.recordCatchupEvent(channel.org_id, m.agent_id, 'channel_message_summary', {
                channel_id: channel.id,
                channel_name: channel.name ?? undefined,
                count: 1,
                last_at: msg.created_at,
              }, channel.id);
            }
          }

          this.broadcastMessage(data.channel_id, msg, agent?.name || 'unknown');
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
      if (client.agentId) {
        // W2: Only mark offline when last connection closes
        const remaining = decrementAgentConnections(client.agentId);
        if (remaining === 0) {
          this.db.setAgentOnline(client.agentId, false);
          const agent = this.db.getAgentById(client.agentId);
          if (agent) {
            this.broadcastToOrg(agent.org_id, {
              type: 'agent_offline',
              agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
            }, agent.id);
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

    const members = this.db.getChannelMembers(channelId).map(m => m.agent_id);

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
    for (const agentId of members) {
      if (agentId === message.sender_id) continue;
      const agent = this.db.getAgentById(agentId);
      if (agent?.webhook_url) {
        wsLogger.info({ agentName: agent.name }, 'Webhook dispatch for channel message');
        // Fire-and-forget — retries happen in background
        void this.webhookManager.deliver(agent.id, agent.webhook_url, agent.webhook_secret, webhookPayload);
      }
    }

    for (const client of this.clients) {
      if (client.orgId !== channel.org_id) continue;

      // Org admins see everything
      if (client.isOrgAdmin) {
        this.send(client, event);
        continue;
      }

      // Agents only see channels they're in
      if (client.agentId && members.includes(client.agentId)) {
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

      if (client.agentId && participantSet.has(client.agentId)) {
        this.send(client, event);
      }
    }
  }

  /**
   * Broadcast event to all clients in an org
   */
  broadcastToOrg(orgId: string, event: WsServerEvent, excludeAgentId?: string) {
    for (const client of this.clients) {
      if (client.orgId !== orgId) continue;
      if (excludeAgentId && client.agentId === excludeAgentId) continue;
      this.send(client, event);
    }
  }

  private send(client: WsClient, event: WsServerEvent) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(event));
    }
  }

  /** O1: Return health stats for the /health endpoint */
  getHealthStats(): { uptime_ms: number; connected_clients: number; connected_agents: number } {
    const agentIds = new Set<string>();
    for (const client of this.clients) {
      if (client.agentId) agentIds.add(client.agentId);
    }
    return {
      uptime_ms: Date.now() - this.startedAt,
      connected_clients: this.clients.size,
      connected_agents: agentIds.size,
    };
  }

  /** O2: Graceful shutdown — close all WS connections with close frame */
  async shutdown(): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Send close frame to all clients
    const closePromises: Promise<void>[] = [];
    for (const client of this.clients) {
      closePromises.push(new Promise<void>((resolve) => {
        client.ws.once('close', resolve);
        client.ws.close(1001, 'Server shutting down');
        // Force terminate after 5s if close handshake doesn't complete
        setTimeout(() => {
          if (client.ws.readyState !== WebSocket.CLOSED) {
            client.ws.terminate();
          }
          resolve();
        }, 5000);
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
    for (const agentId of participantIds) {
      if (excludeBotId && agentId === excludeBotId) continue;

      const agent = this.db.getAgentById(agentId);
      if (!agent?.webhook_url) continue;

      wsLogger.info({ agentName: agent.name }, 'Webhook dispatch for thread event');
      // Fire-and-forget — retries happen in background
      void this.webhookManager.deliver(agent.id, agent.webhook_url, agent.webhook_secret, webhookPayload);
    }
  }
}
