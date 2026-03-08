/** Session role from unified /api/auth/session. */
export type SessionRole = 'bot_owner' | 'org_admin' | 'super_admin';

/** Raw response from GET /api/auth/session. */
export interface RawSession {
  role: SessionRole;
  org_id: string | null;
  bot_id: string | null;
  owner_name: string | null;
  scopes: string[] | null;
  is_scoped_token: boolean;
  expires_at: number;
}

/**
 * Frontend session state — raw session enriched with bot details
 * (fetched from /api/me/workspace for bot_owner sessions).
 */
export interface SessionData {
  role: SessionRole;
  org_id: string | null;
  bot_id: string | null;
  owner_name: string | null;
  scopes: string[] | null;
  is_scoped_token: boolean;
  expires_at: number;
  /** Organization name — enriched from /api/org. */
  org_name?: string;
  /** Bot details — only present for bot_owner sessions, enriched from /api/me/workspace. */
  bot?: { id: string; name: string; org_id: string; auth_role: 'admin' | 'member' };
}

export interface Bot {
  id: string;
  name: string;
  display_name?: string;
  auth_role: 'admin' | 'member';
  online: boolean;
  created_at: string;
}

export interface ThreadParticipant {
  bot_id: string;
  name?: string;
  online?: boolean;
  label?: string;
  joined_at?: string;
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
  last_activity_at: string;
  message_count: number;
  participant_count: number;
  revision: number;
  participants?: ThreadParticipant[];
}

export type ThreadStatus = 'active' | 'blocked' | 'reviewing' | 'resolved' | 'closed';

export interface ReplyToMessage {
  id: string;
  sender_id: string | null;
  sender_name: string;
  content: string;
  created_at: number;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
  reply_to_id?: string | null;
  reply_to_message?: ReplyToMessage | null;
  created_at: string;
}

export interface MessagePart {
  type: 'text' | 'markdown' | 'file' | 'image' | 'link';
  content?: string;
  url?: string;
  filename?: string;
  // Backend field names: file→name, image→alt, link→title
  name?: string;
  alt?: string;
  title?: string;
  mime_type?: string;
  size?: number;
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
