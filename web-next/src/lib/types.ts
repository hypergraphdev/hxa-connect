/**
 * Current backend session response from /ui/api/session.
 * Note: org_admin support is a future backend change.
 * For now, all sessions are bot_user sessions.
 */
export interface SessionData {
  bot: { id: string; name: string; org_id: string };
  owner_name: string;
  scopes: string[];
  expires_at: number;
}

export interface Bot {
  id: string;
  name: string;
  display_name?: string;
  auth_role: 'admin' | 'member';
  online: boolean;
  created_at: string;
}

export interface Thread {
  id: string;
  org_id: string;
  topic: string;
  status: ThreadStatus;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  participant_count: number;
  revision: number;
}

export type ThreadStatus = 'open' | 'active' | 'blocked' | 'reviewing' | 'resolved' | 'closed' | 'archived';

export interface ThreadMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface MessagePart {
  type: 'text' | 'file' | 'image' | 'link';
  content?: string;
  url?: string;
  filename?: string;
  mime_type?: string;
}

export interface Channel {
  id: string;
  org_id: string;
  members: string[];
  created_at: string;
  last_message_at?: string;
}

export interface DmMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  /** Legacy plain-text content (always present from DB) */
  content: string;
  /** Raw from backend: JSON string, null, or pre-parsed array */
  parts: string | null | MessagePart[];
  metadata?: Record<string, unknown>;
  created_at: string;
}

/** DM channel item from /workspace endpoint */
export interface DmChannelItem {
  channel: Channel;
  counterpart_bot: { id: string; name: string; online: boolean; bio: string | null; role: string | null };
  last_message_preview: { content: string; sender_id: string; sender_name: string; created_at: number } | null;
  last_activity_at: number;
}

export interface Artifact {
  id: string;
  thread_id: string;
  artifact_key: string;
  type: string;
  title: string | null;
  content: string | null;
  language: string | null;
  url: string | null;
  mime_type: string | null;
  contributor_id: string | null;
  version: number;
  format_warning: boolean;
  created_at: number;
  updated_at: number;
}

// WS events the frontend handles
export type WsEvent =
  | { type: 'thread_message'; thread_id: string; message: ThreadMessage }
  | { type: 'thread_created'; thread: Thread }
  | { type: 'thread_updated'; thread: Thread; changes: string[] }
  | { type: 'thread_status_changed'; thread_id: string; topic: string; from: ThreadStatus; to: ThreadStatus; by: string }
  | { type: 'thread_artifact'; thread_id: string; artifact: Artifact; action: 'added' | 'updated' }
  | { type: 'thread_participant'; thread_id: string; bot_id: string; bot_name: string; action: 'joined' | 'left'; by: string }
  | { type: 'message'; channel_id: string; message: DmMessage; sender_name: string }
  | { type: 'channel_created'; channel: Channel; members: string[] }
  | { type: 'bot_online'; bot: Pick<Bot, 'id' | 'name'> }
  | { type: 'bot_offline'; bot: Pick<Bot, 'id' | 'name'> };
