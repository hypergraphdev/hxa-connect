import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HubDB } from './db.js';
import type { WebhookManager } from './webhook.js';
import { validateParts, type HubConfig, type Message, type MessagePart, type WireMessage, type WsServerEvent } from './types.js';
import { URL } from 'node:url';

interface WsClient {
  ws: WebSocket;
  agentId?: string;
  orgId: string;
  isOrgAdmin: boolean; // org-level viewer (web UI)
}

export class HubWS {
  private wss: WebSocketServer;
  private clients: Set<WsClient> = new Set();
  private db: HubDB;
  private webhookManager: WebhookManager;
  private config: HubConfig;

  constructor(server: Server, db: HubDB, webhookManager: WebhookManager, config: HubConfig) {
    this.db = db;
    this.webhookManager = webhookManager;
    this.config = config;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }

      // Authenticate as agent
      const agent = db.getAgentByToken(token);
      if (agent) {
        const client: WsClient = {
          ws,
          agentId: agent.id,
          orgId: agent.org_id,
          isOrgAdmin: false,
        };
        this.clients.add(client);
        db.setAgentOnline(agent.id, true);

        // Reset degraded webhook status on reconnect
        db.resetWebhookDegraded(agent.id);

        // Broadcast online status
        this.broadcastToOrg(agent.org_id, {
          type: 'agent_online',
          agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
        }, agent.id);

        this.setupHandlers(client);
        return;
      }

      // Try org key + org admin secret (for web UI / human admins)
      const org = db.getOrgByKey(token);
      if (org) {
        // Require org-scoped admin secret
        const adminToken = url.searchParams.get('admin');
        if (!adminToken || !db.verifyOrgAdminSecret(org.id, adminToken)) {
          ws.close(4003, 'Org admin secret required for console access');
          return;
        }

        const client: WsClient = {
          ws,
          orgId: org.id,
          isOrgAdmin: true,
        };
        this.clients.add(client);
        this.setupHandlers(client);
        return;
      }

      ws.close(4001, 'Invalid token');
    });
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
              });
            }
          }

          this.broadcastMessage(data.channel_id, msg, agent?.name || 'unknown');
        }
      } catch {
        this.send(client, { type: 'error', message: 'Invalid message format' });
      }
    });

    client.ws.on('close', () => {
      this.clients.delete(client);
      if (client.agentId) {
        this.db.setAgentOnline(client.agentId, false);
        const agent = this.db.getAgentById(client.agentId);
        if (agent) {
          this.broadcastToOrg(agent.org_id, {
            type: 'agent_offline',
            agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
          }, agent.id);
        }
      }
    });

    client.ws.on('error', () => {
      this.clients.delete(client);
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
    for (const agentId of members) {
      if (agentId === message.sender_id) continue;
      const agent = this.db.getAgentById(agentId);
      if (agent?.webhook_url) {
        // Send structured webhook payload for channel plugins
        const payload = {
          channel_id: channelId,
          sender_name: senderName,
          sender_id: message.sender_id,
          content: message.content,
          parts: parsedParts,
          message_id: message.id,
          chat_type: channel.type,
          group_name: channel.name,
          created_at: message.created_at,
        };

        console.log(`  \ud83d\udce4 Webhook \u2192 ${agent.name} (${agent.webhook_url})`);
        // Fire-and-forget — retries happen in background
        void this.webhookManager.deliver(agent.id, agent.webhook_url, agent.webhook_secret, payload);
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

  private fireThreadWebhooks(participantIds: string[], event: WsServerEvent, excludeBotId?: string) {
    for (const agentId of participantIds) {
      if (excludeBotId && agentId === excludeBotId) continue;

      const agent = this.db.getAgentById(agentId);
      if (!agent?.webhook_url) continue;

      console.log(`  \ud83d\udce4 Thread webhook \u2192 ${agent.name} (${agent.webhook_url})`);
      // Fire-and-forget — retries happen in background
      void this.webhookManager.deliver(agent.id, agent.webhook_url, agent.webhook_secret, event);
    }
  }
}
