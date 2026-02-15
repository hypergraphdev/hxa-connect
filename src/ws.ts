import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { HubDB } from './db.js';
import type { Message, WsServerEvent } from './types.js';
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

  constructor(server: Server, db: HubDB) {
    this.db = db;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }

      // Authenticate
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

        // Broadcast online status
        this.broadcastToOrg(agent.org_id, {
          type: 'agent_online',
          agent: { id: agent.id, name: agent.name, display_name: agent.display_name },
        }, agent.id);

        this.setupHandlers(client);
        return;
      }

      // Try org key (for web UI observers)
      const org = db.getOrgByKey(token);
      if (org) {
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

          const contentType = data.content_type || 'text';
          const msg = this.db.createMessage(data.channel_id, client.agentId, data.content, contentType);
          const agent = this.db.getAgentById(client.agentId);

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
    const event: WsServerEvent = {
      type: 'message',
      channel_id: channelId,
      message,
      sender_name: senderName,
    };

    // Fire webhooks for members who have one (and aren't the sender)
    for (const agentId of members) {
      if (agentId === message.sender_id) continue;
      const agent = this.db.getAgentById(agentId);
      if (agent?.webhook_url) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (agent.webhook_secret) {
          headers['Authorization'] = `Bearer ${agent.webhook_secret}`;
        }

        // Send structured webhook payload for channel plugins
        const payload = {
          channel_id: channelId,
          sender_name: senderName,
          sender_id: message.sender_id,
          content: message.content,
          message_id: message.id,
          chat_type: channel.type,
          group_name: channel.name,
          created_at: message.created_at,
        };

        console.log(`  📤 Webhook → ${agent.name} (${agent.webhook_url})`);
        fetch(agent.webhook_url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }).then(res => {
          console.log(`  📤 Webhook ${agent.name}: ${res.status} ${res.statusText}`);
        }).catch(err => {
          console.log(`  ❌ Webhook ${agent.name} failed: ${err.message}`);
        });
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
}
