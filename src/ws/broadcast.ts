import { WebSocket } from 'ws';
import type { HubDB } from '../db.js';
import type { WebhookManager } from '../webhook.js';
import type { Message, MessagePart, WireMessage, WsServerEvent } from '../types.js';
import type { WsClient } from './protocol.js';
import { wsLogger } from '../logger.js';

// ─── Broadcast functions ─────────────────────────────────────
// These are extracted as standalone functions that receive dependencies.
// HubWS delegates to them from its methods.

// ─── URL helpers ─────────────────────────────────────────────

/**
 * Build the hub's public base URL from environment variables.
 * Used to rewrite relative file/image URLs to absolute before delivery.
 *
 * Priority:
 *   1. HUB_PUBLIC_URL  — explicit override, useful in Docker/intranet deployments
 *   2. DOMAIN          — production reverse-proxy domain (implies https)
 *   3. localhost:PORT  — local dev fallback
 */
function getHubBaseUrl(): string {
  if (process.env.HUB_PUBLIC_URL) return process.env.HUB_PUBLIC_URL.replace(/\/$/, '');
  const domain = process.env.DOMAIN;
  const basePath = process.env.BASE_PATH ?? '';
  if (domain) return `https://${domain}${basePath}`;
  const port = process.env.PORT ?? '4800';
  return `http://localhost:${port}${basePath}`;
}

/**
 * Rewrite relative image/file URLs (starting with '/') to absolute,
 * so receiving bots can fetch the content without knowing the server URL.
 */
function resolvePartUrls(parts: MessagePart[], baseUrl: string): MessagePart[] {
  return parts.map(part => {
    if ((part.type === 'image' || part.type === 'file') &&
        typeof part.url === 'string' &&
        part.url.startsWith('/')) {
      return { ...part, url: `${baseUrl}${part.url}` };
    }
    return part;
  });
}

/**
 * Broadcast a new message to all relevant clients + fire webhooks.
 */
export async function broadcastMessage(
  clients: Set<WsClient>,
  db: HubDB,
  webhookManager: WebhookManager,
  channelId: string,
  message: Message,
  senderName: string,
): Promise<void> {
  const channel = await db.getChannel(channelId);
  if (!channel) return;

  const members = (await db.getChannelMembers(channelId)).map(m => m.bot_id);

  // Parse parts for wire format: send parsed array, not raw JSON string
  let parsedParts: MessagePart[];
  try {
    parsedParts = message.parts
      ? JSON.parse(message.parts)
      : [{ type: 'text', content: message.content }];
  } catch {
    parsedParts = [{ type: 'text', content: message.content }];
  }

  // Rewrite relative image/file URLs to absolute so bots can fetch content
  parsedParts = resolvePartUrls(parsedParts, getHubBaseUrl());

  const wireMessage: WireMessage = { ...message, parts: parsedParts };

  const event: WsServerEvent = {
    type: 'message',
    channel_id: channelId,
    message: wireMessage,
    sender_name: senderName,
  };

  // Fire webhooks for members who have one (and aren't the sender)
  const webhookPayload = { webhook_version: '1' as const, ...event };
  for (const botId of members) {
    if (botId === message.sender_id) continue;
    const bot = await db.getBotById(botId);
    if (bot?.webhook_url) {
      wsLogger.info({ botName: bot.name }, 'Webhook dispatch for channel message');
      void webhookManager.deliver(bot.id, bot.webhook_url, bot.webhook_secret, webhookPayload);
    }
  }

  for (const client of clients) {
    if (client.orgId !== channel.org_id) continue;

    // Org admins only receive messages for subscribed channels
    if (client.isOrgAdmin) {
      if (client.subscriptions.has(channelId)) {
        sendToClient(client, event);
      }
      continue;
    }

    // Bots only see channels they're in
    if (client.botId && members.includes(client.botId)) {
      sendToClient(client, event);
    }
  }
}

/**
 * Broadcast thread event to all thread participants + org admins + participant webhooks.
 */
export async function broadcastThreadEvent(
  clients: Set<WsClient>,
  db: HubDB,
  webhookManager: WebhookManager,
  orgId: string,
  threadId: string,
  event: WsServerEvent,
): Promise<void> {
  const participantIds = (await db.getParticipants(threadId)).map(p => p.bot_id);

  // Rewrite relative image/file URLs to absolute in thread messages
  if (event.type === 'thread_message') {
    const resolved = resolvePartUrls(event.message.parts, getHubBaseUrl());
    event = { ...event, message: { ...event.message, parts: resolved } };
  }

  let excludeWebhookBotId: string | undefined;
  if (event.type === 'thread_message' && event.message.sender_id) {
    excludeWebhookBotId = event.message.sender_id;
  } else if (event.type === 'thread_artifact' && event.artifact.contributor_id) {
    excludeWebhookBotId = event.artifact.contributor_id;
  }

  await fireThreadWebhooks(db, webhookManager, participantIds, event, excludeWebhookBotId);

  // thread_created is an org-wide notification — send to all org admins
  // regardless of subscription. Other thread events require subscription.
  const isOrgWideEvent = event.type === 'thread_created';

  const participantSet = new Set(participantIds);
  for (const client of clients) {
    if (client.orgId !== orgId) continue;

    if (client.isOrgAdmin) {
      if (isOrgWideEvent || client.subscriptions.has(threadId)) {
        sendToClient(client, event);
      }
      continue;
    }

    if (client.botId && participantSet.has(client.botId)) {
      sendToClient(client, event);
    }
  }
}

/**
 * Broadcast event to all clients in an org.
 */
export function broadcastToOrg(
  clients: Set<WsClient>,
  orgId: string,
  event: WsServerEvent,
  excludeBotId?: string,
): void {
  for (const client of clients) {
    if (client.orgId !== orgId) continue;
    if (excludeBotId && client.botId === excludeBotId) continue;
    sendToClient(client, event);
  }
}

/**
 * Send an event to a single client.
 */
export function sendToClient(client: WsClient, event: WsServerEvent): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(event));
  }
}

/**
 * Fire webhooks for thread participants.
 */
async function fireThreadWebhooks(
  db: HubDB,
  webhookManager: WebhookManager,
  participantIds: string[],
  event: WsServerEvent,
  excludeBotId?: string,
): Promise<void> {
  const webhookPayload = { webhook_version: '1' as const, ...event };
  for (const botId of participantIds) {
    if (excludeBotId && botId === excludeBotId) continue;

    const bot = await db.getBotById(botId);
    if (!bot?.webhook_url) continue;

    wsLogger.info({ botName: bot.name }, 'Webhook dispatch for thread event');
    void webhookManager.deliver(bot.id, bot.webhook_url, bot.webhook_secret, webhookPayload);
  }
}
