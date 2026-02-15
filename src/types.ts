// ─── Core Entities ───────────────────────────────────────────

export interface Org {
  id: string;
  name: string;
  api_key: string;
  persist_messages: boolean;
  created_at: number;
}

export interface Agent {
  id: string;
  org_id: string;
  name: string;
  display_name: string | null;
  token: string;
  metadata: string | null; // JSON string
  webhook_url: string | null;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
}

export interface Channel {
  id: string;
  org_id: string;
  type: 'direct' | 'group';
  name: string | null;
  created_at: number;
}

export interface ChannelMember {
  channel_id: string;
  agent_id: string;
  joined_at: number;
}

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'json' | 'system';
  created_at: number;
}

// ─── API Request/Response Types ──────────────────────────────

export interface RegisterRequest {
  name: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
}

export interface RegisterResponse {
  agent_id: string;
  token: string;
  name: string;
}

export interface CreateChannelRequest {
  type: 'direct' | 'group';
  name?: string;
  members: string[]; // agent IDs or names
}

export interface SendMessageRequest {
  content: string;
  content_type?: 'text' | 'json';
}

export interface DirectSendRequest {
  to: string; // agent ID or name
  content: string;
  content_type?: 'text' | 'json';
}

// ─── WebSocket Events ────────────────────────────────────────

export type WsServerEvent =
  | { type: 'message'; channel_id: string; message: Message; sender_name: string }
  | { type: 'agent_online'; agent: Pick<Agent, 'id' | 'name' | 'display_name'> }
  | { type: 'agent_offline'; agent: Pick<Agent, 'id' | 'name' | 'display_name'> }
  | { type: 'channel_created'; channel: Channel; members: string[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type WsClientEvent =
  | { type: 'send'; channel_id: string; content: string; content_type?: string }
  | { type: 'ping' };

// ─── Config ──────────────────────────────────────────────────

export interface HubConfig {
  port: number;
  host: string;
  data_dir: string;
  default_persist: boolean;
  cors_origins: string[];
  max_message_length: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  admin_secret?: string;
}

export const DEFAULT_CONFIG: HubConfig = {
  port: 4800,
  host: '0.0.0.0',
  data_dir: './data',
  default_persist: true,
  cors_origins: ['*'],
  max_message_length: 65536,
  log_level: 'info',
  admin_secret: undefined,
};
