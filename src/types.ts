// ─── MessageV2: Structured Message Parts ─────────────────────

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'markdown'; content: string }
  | { type: 'json'; content: Record<string, unknown> }
  | { type: 'file'; url: string; name: string; mime_type: string; size?: number }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'link'; url: string; title?: string };

// ─── Core Entities ───────────────────────────────────────────

export type OrgStatus = 'active' | 'suspended' | 'destroyed';
export type AuthRole = 'admin' | 'member';

export interface Org {
  id: string;
  name: string;
  org_secret: string;
  /**
   * Reserved for SaaS deployment — non-persistent mode is a post-GA feature.
   * Currently always true. The field is accepted at org creation for forward
   * compatibility, but toggling it to false has no effect on message storage.
   */
  persist_messages: boolean;
  status: OrgStatus;
  created_at: number;
}

export interface Bot {
  id: string;
  org_id: string;
  name: string;
  token: string;
  metadata: string | null; // JSON string
  webhook_url: string | null;
  webhook_secret: string | null;
  bio: string | null;
  role: string | null;
  function: string | null;
  team: string | null;
  tags: string | null; // JSON string of string[]
  languages: string | null; // JSON string of string[]
  protocols: string | null; // JSON string
  status_text: string | null;
  timezone: string | null;
  active_hours: string | null;
  version: string;
  runtime: string | null;
  auth_role: AuthRole;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
  join_status: 'pending' | 'active' | 'rejected';
  join_status_changed_by: string | null;
  join_status_changed_at: number | null;
  join_status_reason: string | null;
}

export interface OrgTicket {
  id: string;
  org_id: string;
  secret_hash: string;
  code: string | null;
  reusable: boolean;
  skip_approval: boolean;
  expires_at: number;
  consumed: boolean;
  created_by: string | null;
  created_at: number;
}

/** Wire format returned by POST /api/org/tickets */
export interface OrgTicketResponse {
  ticket: string;       // ticket code (tkt_ prefix) or UUID fallback
  expires_at: number;
  reusable: boolean;
  skip_approval: boolean;
}

export interface Channel {
  id: string;
  org_id: string;
  type: 'direct';
  name: string | null;
  created_at: number;
}

export interface ChannelMember {
  channel_id: string;
  bot_id: string;
  joined_at: number;
}

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  content: string;
  content_type: 'text' | 'json' | 'system';
  parts: string | null; // JSON string of MessagePart[]
  created_at: number;
}

export type ThreadStatus = 'active' | 'blocked' | 'reviewing' | 'resolved' | 'closed';
export type CloseReason = 'manual' | 'timeout' | 'error';
export type ThreadVisibility = 'public' | 'members' | 'private';
export type ThreadJoinPolicy = 'open' | 'approval' | 'invite_only';
export type JoinRequestStatus = 'pending' | 'approved' | 'rejected';

export interface Thread {
  id: string;
  org_id: string;
  topic: string;
  tags: string[] | null;
  status: ThreadStatus;
  initiator_id: string | null;
  channel_id: string | null;
  context: string | null; // JSON string
  close_reason: CloseReason | null;
  permission_policy: string | null; // JSON string of ThreadPermissionPolicy
  visibility: ThreadVisibility;
  join_policy: ThreadJoinPolicy;
  revision: number; // Optimistic concurrency control — increments on every update
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  resolved_at: number | null;
}

export interface ThreadJoinRequest {
  id: string;
  thread_id: string;
  bot_id: string;
  status: JoinRequestStatus;
  requested_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

export interface ThreadParticipant {
  thread_id: string;
  bot_id: string;
  label: string | null;
  joined_at: number;
}

export interface MentionRef {
  bot_id: string;
  name: string;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  sender_id: string | null;
  content: string;
  content_type: string;
  parts: string | null; // JSON string of MessagePart[]
  metadata: string | null; // JSON string
  mentions: string | null; // JSON string of MentionRef[]
  mention_all: number; // 0 or 1
  reply_to_id: string | null;
  created_at: number;
}

export type ArtifactType = 'text' | 'markdown' | 'json' | 'code' | 'file' | 'link';

export interface Artifact {
  id: string;
  thread_id: string;
  artifact_key: string;
  type: ArtifactType;
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

export interface PlatformInviteCode {
  id: string;
  code_hash: string;
  code: string | null;
  label: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
  created_at: number;
}

export interface FileRecord {
  id: string;
  org_id: string;
  uploader_id: string;
  name: string;
  mime_type: string | null;
  size: number;
  path: string;  // disk path relative to data_dir
  created_at: number;
}

// ─── Catchup (Offline Event Replay) ─────────────────────────

export interface CatchupEventEnvelope {
  event_id: string;
  occurred_at: number;
}

export type CatchupEvent = CatchupEventEnvelope & (
  | { type: 'thread_invited'; thread_id: string; topic: string; inviter: string }
  | { type: 'thread_status_changed'; thread_id: string; topic: string; from: ThreadStatus; to: ThreadStatus; by: string }
  | { type: 'thread_message_summary'; thread_id: string; topic: string; count: number; last_at: number }
  | { type: 'thread_artifact_added'; thread_id: string; artifact_key: string; version: number }
  | { type: 'channel_message_summary'; channel_id: string; channel_name?: string; count: number; last_at: number }
  | { type: 'thread_participant_removed'; thread_id: string; topic: string; removed_by: string }
);

export interface CatchupResponse {
  events: CatchupEvent[];
  has_more: boolean;
  cursor?: string;
}

export interface CatchupCountResponse {
  thread_invites: number;
  thread_status_changes: number;
  thread_activities: number;
  channel_messages: number;
  total: number;
}

// ─── Scoped Tokens ──────────────────────────────────────────

/** Token permission scopes. 'full' implies all other scopes. */
export type TokenScope = 'full' | 'read' | 'thread' | 'message' | 'profile';

export const VALID_TOKEN_SCOPES = new Set<TokenScope>(['full', 'read', 'thread', 'message', 'profile']);

/** Mapping from operations to required scopes (any one grants access). */
export const SCOPE_REQUIREMENTS: Record<string, TokenScope[]> = {
  // Full access (token management, self-delete)
  full: ['full'],
  // Read operations (GET)
  read: ['full', 'read'],
  // Thread operations (create/update threads, thread messages, artifacts)
  thread: ['full', 'thread'],
  // Channel messaging
  message: ['full', 'message'],
  // File upload — shared utility used by both thread and DM contexts
  upload: ['full', 'thread', 'message'],
  // Profile update
  profile: ['full', 'profile'],
};

export interface BotToken {
  id: string;
  bot_id: string;
  token: string;
  scopes: TokenScope[];
  label: string | null;
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
}

// ─── Sessions (ADR-002) ──────────────────────────────────────

export type SessionRole = 'bot_owner' | 'org_admin' | 'super_admin';

export interface Session {
  id: string;
  role: SessionRole;
  bot_id: string | null;       // set for bot_owner
  org_id: string | null;       // null for super_admin
  owner_name: string | null;   // set for bot_owner
  scopes: TokenScope[] | null; // carried from login token
  is_scoped_token: boolean;
  created_at: number;
  expires_at: number;
}

// ─── Thread Permission Policies ─────────────────────────────

/**
 * Per-thread permission policy based on participant labels.
 * Each field is an array of labels that are allowed to perform the action.
 * Special values:
 * - "*" means any participant (default behavior)
 * - "initiator" matches the thread initiator regardless of label
 * If a field is omitted or null, the action is unrestricted (any participant).
 *
 * EXCEPTION: For 'manage', null means initiator-only (safe default).
 * This prevents accidental permission escalation on existing threads.
 */
export interface ThreadPermissionPolicy {
  resolve?: string[] | null;   // Who can set status to 'resolved'
  close?: string[] | null;     // Who can set status to 'closed'
  invite?: string[] | null;    // Who can invite new participants
  remove?: string[] | null;    // Who can remove participants
  write?: string[] | null;     // Who can send messages and add artifacts
  manage?: string[] | null;    // Who can modify thread settings (visibility, join_policy, permission_policy)
}

export const PERMISSION_POLICY_KEYS: (keyof ThreadPermissionPolicy)[] =
  ['resolve', 'close', 'invite', 'remove', 'write', 'manage'];

// ─── Org Settings / Rate Limiting ────────────────────────────

export interface OrgSettings {
  org_id: string;
  messages_per_minute_per_bot: number;
  threads_per_hour_per_bot: number;
  file_upload_mb_per_day_per_bot: number;
  message_ttl_days: number | null;
  thread_auto_close_days: number | null;
  artifact_retention_days: number | null;
  default_thread_permission_policy: ThreadPermissionPolicy | null;
  updated_at: number;
}

// ─── Audit Log ──────────────────────────────────────────────

export type AuditAction =
  | 'bot.register' | 'bot.delete' | 'bot.profile_update' | 'bot.rename' | 'bot.role_change'
  | 'bot.token_create' | 'bot.token_revoke'
  | 'thread.create' | 'thread.status_changed' | 'thread.join' | 'thread.leave' | 'thread.invite' | 'thread.remove_participant'
  | 'thread.permission_denied' | 'thread.write_denied'
  | 'thread.visibility_changed' | 'thread.join_policy_changed'
  | 'thread.join_requested' | 'thread.join_approved' | 'thread.join_rejected'
  | 'message.send'
  | 'artifact.add' | 'artifact.update'
  | 'file.upload'
  | 'settings.update'
  | 'lifecycle.cleanup'
  | 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.session_revoked'
  | 'auth.session_force_logout' | 'auth.ticket_revoked'
  | 'bot.tombstone_cleared'
  | 'bot.join_status_changed';

export interface AuditEntry {
  id: string;
  org_id: string;
  bot_id: string | null;
  action: AuditAction;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  created_at: number;
}

// ─── API Request/Response Types ──────────────────────────────

export interface BotProtocols {
  version: string;
  messaging: boolean;
  threads: boolean;
  streaming: boolean;
}

export interface BotProfileInput {
  bio?: string | null;
  role?: string | null;
  function?: string | null;
  team?: string | null;
  tags?: string[] | null;
  languages?: string[] | null;
  protocols?: BotProtocols | null;
  status_text?: string | null;
  timezone?: string | null;
  active_hours?: string | null;
  version?: string;
  runtime?: string | null;
}

export interface RegisterRequest {
  name: string;
  bio?: string | null;
  role?: string | null;
  function?: string | null;
  team?: string | null;
  tags?: string[] | null;
  languages?: string[] | null;
  protocols?: BotProtocols | null;
  status_text?: string | null;
  timezone?: string | null;
  active_hours?: string | null;
  version?: string;
  runtime?: string | null;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
  webhook_secret?: string; // Sent as Authorization: Bearer <secret>
}

export interface RegisterResponse {
  bot_id: string;
  id: string;
  org_id: string;
  name: string;
  auth_role: string;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
  metadata: Record<string, unknown> | null;
  bio: string | null;
  role: string | null;
  function: string | null;
  team: string | null;
  tags: string[] | null;
  languages: string[] | null;
  protocols: Record<string, unknown> | null;
  status_text: string | null;
  timezone: string | null;
  active_hours: string | null;
  version: string;
  runtime: string | null;
  token?: string; // Only present when a new bot is created
}

export interface UpdateProfileRequest extends BotProfileInput {}

export interface ListBotsFilters {
  role?: string;
  tag?: string;
  status?: string;
  q?: string;
}

export interface SendMessageRequest {
  content?: string;
  content_type?: 'text' | 'json';
  parts?: MessagePart[];
}

export interface DirectSendRequest {
  to: string; // bot ID or name
  content?: string;
  content_type?: 'text' | 'json';
  parts?: MessagePart[];
}

// ─── Wire-format messages (parts as parsed array) ────────────

export interface WireMessage extends Omit<Message, 'parts'> {
  parts: MessagePart[];
}

export interface WireThreadMessage extends Omit<ThreadMessage, 'parts' | 'mentions' | 'mention_all' | 'metadata'> {
  parts: MessagePart[];
  mentions: MentionRef[];
  mention_all: boolean;
  metadata: Record<string, unknown> | null;
}

// ─── WebSocket Events ────────────────────────────────────────

export type WsServerEvent =
  | { type: 'message'; channel_id: string; message: WireMessage; sender_name: string }
  | { type: 'bot_online'; bot: Pick<Bot, 'id' | 'name'> }
  | { type: 'bot_offline'; bot: Pick<Bot, 'id' | 'name'> }
  | { type: 'bot_registered'; bot: Pick<Bot, 'id' | 'name' | 'join_status'> }
  | { type: 'bot_join_request'; bot: Pick<Bot, 'id' | 'name'>; org_id: string }
  | { type: 'bot_status_changed'; bot_id: string; name: string; join_status: string; previous_status: string; reason: string | null }
  | { type: 'bot_renamed'; bot_id: string; old_name: string; new_name: string }
  | { type: 'channel_created'; channel: Channel; members: string[] }
  | { type: 'thread_created'; thread: Thread }
  | { type: 'thread_updated'; thread: Thread; changes: string[] }
  | { type: 'thread_message'; thread_id: string; message: WireThreadMessage }
  | { type: 'thread_artifact'; thread_id: string; artifact: Artifact; action: 'added' | 'updated' }
  | { type: 'thread_participant'; thread_id: string; bot_id: string; bot_name: string; action: 'joined' | 'left'; by: string; label?: string | null }
  | { type: 'thread_join_request'; thread_id: string; request_id: string; bot_id: string; bot_name: string }
  | { type: 'thread_join_resolved'; thread_id: string; request_id: string; bot_id: string; status: 'approved' | 'rejected' }
  | { type: 'thread_visibility_changed'; thread_id: string; visibility: ThreadVisibility; join_policy: ThreadJoinPolicy }
  | { type: 'thread_status_changed'; thread_id: string; topic: string; from: ThreadStatus; to: ThreadStatus; by: string }
  | { type: 'ack'; ref: string; result: Record<string, unknown> }
  | { type: 'error'; message: string; code?: string; retry_after?: number; ref?: string }
  | { type: 'pong' };

export type WsClientEvent =
  | { type: 'send'; channel_id: string; content?: string; content_type?: string; parts?: MessagePart[]; ref?: string }
  | { type: 'send_dm'; to: string; content?: string; content_type?: string; parts?: MessagePart[]; ref?: string }
  | { type: 'send_thread_message'; thread_id: string; content?: string; content_type?: string; parts?: MessagePart[]; metadata?: unknown; ref?: string }
  | { type: 'thread_create'; topic: string; tags?: string[]; participants?: string[]; channel_id?: string; context?: unknown; ref?: string }
  | { type: 'thread_update'; thread_id: string; status?: string; close_reason?: string; topic?: string; context?: unknown; expected_revision?: number; ref?: string }
  | { type: 'thread_invite'; thread_id: string; bot_id: string; label?: string; ref?: string }
  | { type: 'thread_join'; thread_id: string; ref?: string }
  | { type: 'thread_leave'; thread_id: string; ref?: string }
  | { type: 'thread_remove_participant'; thread_id: string; bot_id: string; ref?: string }
  | { type: 'artifact_add'; thread_id: string; artifact_key: string; artifact_type?: string; title?: string | null; content?: string | null; language?: string | null; url?: string | null; mime_type?: string | null; ref?: string }
  | { type: 'artifact_update'; thread_id: string; artifact_key: string; content: string; title?: string | null; ref?: string }
  | { type: 'subscribe'; channel_id?: string; thread_id?: string }
  | { type: 'unsubscribe'; channel_id?: string; thread_id?: string }
  | { type: 'ping' };

// ─── Webhook Health ──────────────────────────────────────────

export interface WebhookHealth {
  healthy: boolean;
  last_success: number | null;
  last_failure: number | null;
  consecutive_failures: number;
  degraded: boolean;  // true when consecutive_failures >= 10
}

// ─── Config ──────────────────────────────────────────────────

export interface HubConfig {
  port: number;
  host: string;
  data_dir: string;
  /**
   * Default value for org persist_messages on creation.
   * Reserved for SaaS deployment — non-persistent mode is a post-GA feature.
   */
  default_persist: boolean;
  cors_origins: string | string[];
  max_message_length: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  admin_secret?: string;
  file_upload_mb_per_day: number;
  max_file_size_mb: number;
}

// ─── Shared Validation ──────────────────────────────────────

const VALID_PART_TYPES = new Set(['text', 'markdown', 'json', 'file', 'image', 'link']);
const MAX_PARTS_PER_MESSAGE = 50;

/**
 * Validate an array of message parts. Returns an error string or null.
 * Shared by REST routes and WebSocket handler.
 */
export function validateParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return 'parts must be an array';
  if (parts.length > MAX_PARTS_PER_MESSAGE) return `parts exceeds maximum of ${MAX_PARTS_PER_MESSAGE} items`;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || typeof part !== 'object') return `parts[${i}] must be an object`;
    if (!VALID_PART_TYPES.has(part.type)) return `parts[${i}].type is invalid (got "${part.type}")`;

    switch (part.type) {
      case 'text':
      case 'markdown':
        if (typeof part.content !== 'string') return `parts[${i}].content must be a string`;
        break;
      case 'json':
        if (part.content === null || typeof part.content !== 'object') return `parts[${i}].content must be an object`;
        break;
      case 'file':
        if (typeof part.url !== 'string') return `parts[${i}].url is required`;
        if (typeof part.name !== 'string') return `parts[${i}].name is required`;
        if (typeof part.mime_type !== 'string') return `parts[${i}].mime_type is required`;
        break;
      case 'image':
        if (typeof part.url !== 'string') return `parts[${i}].url is required`;
        break;
      case 'link':
        if (typeof part.url !== 'string') return `parts[${i}].url is required`;
        break;
    }
  }

  return null;
}

export const DEFAULT_CONFIG: HubConfig = {
  port: 4800,
  host: '0.0.0.0',
  data_dir: './data',
  default_persist: true,
  cors_origins: '*',
  max_message_length: 65536,
  log_level: 'info',
  admin_secret: undefined,
  file_upload_mb_per_day: 500,
  max_file_size_mb: 50,
};
