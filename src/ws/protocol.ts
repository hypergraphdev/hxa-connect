import type { WebSocket } from 'ws';
import type { HubDB } from '../db.js';
import type {
  ArtifactType,
  Bot,
  HubConfig,
  Message,
  MessagePart,
  MentionRef,
  SessionRole,
  ThreadMessage,
  ThreadStatus,
  CloseReason,
  TokenScope,
  WireThreadMessage,
  WsServerEvent,
} from '../types.js';
import type { WebhookManager } from '../webhook.js';

// ─── Constants ───────────────────────────────────────────────

export const MENTION_REGEX = /(?<![a-zA-Z0-9_-])@([a-zA-Z0-9_-]+)/g;
export const MAX_MENTIONS = 20;
export const MAX_THREAD_TAGS = 10;
export const WS_FIELD_LIMITS = { content_type: 128, metadata: 16384 } as const;
export const THREAD_STATUSES = new Set<ThreadStatus>(['active', 'blocked', 'reviewing', 'resolved', 'closed']);
export const CLOSE_REASONS = new Set<CloseReason>(['manual', 'timeout', 'error']);
export const ARTIFACT_TYPES = new Set<ArtifactType>(['text', 'markdown', 'json', 'code', 'file', 'link']);
export const ARTIFACT_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;

// ─── WsClient ────────────────────────────────────────────────

export interface WsClient {
  ws: WebSocket;
  botId?: string;
  orgId: string;
  isOrgAdmin: boolean;
  /** Scopes granted to this WS connection. null means full access (primary bot token or org key). */
  scopes: TokenScope[] | null;
  /** Whether the client has responded to the last ping. */
  alive: boolean;
  /** Subscribed channel/thread IDs for org admin clients (message-level filtering). */
  subscriptions: Set<string>;
  /** Session ID for session-based WS connections (ADR-002). */
  sessionId?: string;
  /** Session role for session-based WS connections (ADR-002). */
  role?: SessionRole;
  /** Timestamp when this client connected. */
  connectedAt: number;
}

// ─── WsHub interface (dependency injection for handlers) ─────

export interface WsHub {
  readonly db: HubDB;
  readonly config: HubConfig;
  readonly clients: Set<WsClient>;
  readonly webhookManager: WebhookManager;
  send(client: WsClient, event: WsServerEvent): void;
  sendAck(client: WsClient, ref: string, result: Record<string, unknown>): void;
  sendError(client: WsClient, message: string, opts?: { ref?: string; code?: string; retry_after?: number }): void;
  clientHasScope(client: WsClient, required: TokenScope): boolean;
  broadcastMessage(channelId: string, message: Message, senderName: string): Promise<void>;
  broadcastThreadEvent(orgId: string, threadId: string, event: WsServerEvent): Promise<void>;
  broadcastToOrg(orgId: string, event: WsServerEvent, excludeBotId?: string): void;
}

// ─── Connection tracking ─────────────────────────────────────

const botConnectionCount = new Map<string, number>();

export function incrementBotConnections(botId: string): number {
  const count = (botConnectionCount.get(botId) ?? 0) + 1;
  botConnectionCount.set(botId, count);
  return count;
}

export function decrementBotConnections(botId: string): number {
  const count = (botConnectionCount.get(botId) ?? 1) - 1;
  if (count <= 0) {
    botConnectionCount.delete(botId);
    return 0;
  }
  botConnectionCount.set(botId, count);
  return count;
}

// ─── Helper functions ────────────────────────────────────────

export function contentFromParts(parts: MessagePart[]): string {
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'markdown') return part.content;
  }
  return `[${parts.map(p => p.type).join(', ')}]`;
}

export function wsEnrichThreadMessage(msg: ThreadMessage): WireThreadMessage {
  let parsed: MessagePart[];
  try {
    parsed = msg.parts ? JSON.parse(msg.parts) : [{ type: 'text', content: msg.content }];
  } catch {
    parsed = [{ type: 'text', content: msg.content }];
  }
  let mentions: MentionRef[];
  try {
    mentions = msg.mentions ? JSON.parse(msg.mentions) : [];
  } catch {
    mentions = [];
  }
  let metadata: Record<string, unknown> | null = null;
  if (msg.metadata) {
    try { metadata = JSON.parse(msg.metadata); } catch { /* keep null */ }
  }
  const { mentions: _m, mention_all: _ma, metadata: _md, ...rest } = msg;
  return { ...rest, parts: parsed, mentions, mention_all: !!msg.mention_all, metadata };
}

export async function wsParseMentions(
  content: string,
  participants: Array<{ bot_id: string }>,
  getBotById: (id: string) => Promise<Bot | undefined>,
): Promise<{ mentions: MentionRef[] | null; mentionAll: boolean }> {
  const seen = new Set<string>();
  const mentions: MentionRef[] = [];
  let mentionAll = false;
  const participantBots = (await Promise.all(participants.map(p => getBotById(p.bot_id)))).filter((b): b is Bot => !!b);
  let match;
  MENTION_REGEX.lastIndex = 0;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    const name = match[1];
    const key = name.toLowerCase();
    if (key === 'all') { mentionAll = true; continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    const bot = participantBots.find(b => b.name.toLowerCase() === key);
    if (bot) mentions.push({ bot_id: bot.id, name: bot.name });
    if (mentions.length >= MAX_MENTIONS) break;
  }
  return { mentions: mentions.length > 0 ? mentions : null, mentionAll };
}

export async function wsResolveBot(db: HubDB, orgId: string, idOrName: string): Promise<Bot | undefined> {
  const byId = await db.getBotById(idOrName);
  if (byId && byId.org_id === orgId) return byId;
  return await db.getBotByName(orgId, idOrName);
}
