import type { RawSession, SessionData, Thread, ThreadMessage, Channel, DmMessage, DmChannelItem, Bot, Artifact } from './types';

/** Base path for the hxa-connect Express server.
 *  NEXT_PUBLIC_BASE_PATH is set when the app is behind a URL prefix (e.g. "/hub"). */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText, code: 'UNKNOWN' }));
    throw new ApiError(res.status, body.code ?? 'UNKNOWN', body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ─── Auth ───

export async function login(params: {
  token: string;
  owner_name: string;
}): Promise<{ session: { role: string; org_id: string; bot_id: string; expires_at: number } }> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ type: 'bot', ...params }),
  });
}

export async function getSession(): Promise<RawSession> {
  return request<RawSession>('/api/auth/session');
}

export async function logout(): Promise<void> {
  try {
    await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } catch {
    // Server-side logout failed — still clear client state.
    // The cookie will eventually expire on its own.
  }
}

// ─── Threads ───

/** Backend response: { items, has_more, next_cursor? } */
export interface ThreadListResponse {
  items: Thread[];
  has_more: boolean;
  next_cursor?: string;
}

export async function getThreads(params?: {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<ThreadListResponse> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set('status', params.status);
  if (params?.q) sp.set('q', params.q);
  if (params?.cursor) sp.set('cursor', params.cursor);
  if (params?.limit) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return request<ThreadListResponse>(`/api/threads${qs ? `?${qs}` : ''}`);
}

export async function getThread(id: string): Promise<Thread> {
  return request<Thread>(`/api/threads/${id}`);
}

/** Backend response: { items, has_more, next_cursor? } */
export interface MessageListResponse {
  items: ThreadMessage[];
  has_more: boolean;
  next_cursor?: string;
}

export async function getThreadMessages(threadId: string, params?: {
  cursor?: string;
  limit?: number;
}): Promise<MessageListResponse> {
  const sp = new URLSearchParams();
  // Always include cursor param (even empty) to trigger paginated response mode.
  // Backend returns {items, has_more, next_cursor?} when cursor key is present,
  // but plain array when absent (legacy mode).
  sp.set('cursor', params?.cursor ?? '');
  if (params?.limit) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return request<MessageListResponse>(`/api/threads/${threadId}/messages${qs ? `?${qs}` : ''}`);
}

/** Backend expects content (string) + optional parts */
export async function sendThreadMessage(threadId: string, content: string, parts?: Array<{ type: string; content: string }>): Promise<ThreadMessage> {
  return request<ThreadMessage>(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, parts }),
  });
}

// ─── Thread Status ───

export async function updateThreadStatus(threadId: string, status: string, closeReason?: string): Promise<Thread> {
  return request<Thread>(`/api/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...(closeReason ? { close_reason: closeReason } : {}) }),
  });
}

// ─── Artifacts ───

/** Backend returns raw Artifact[] */
export async function getThreadArtifacts(threadId: string): Promise<Artifact[]> {
  return request<Artifact[]>(`/api/threads/${threadId}/artifacts`);
}

// ─── Workspace (DM channels + threads) ───

export interface WorkspaceResponse {
  bot: { id: string; name: string; org_id: string };
  dms: {
    items: DmChannelItem[];
    has_more: boolean;
    next_cursor?: string;
  };
  threads: {
    items: Thread[];
    has_more: boolean;
    next_cursor?: string;
  };
}

export async function getWorkspace(params?: {
  dm_cursor?: string;
  dm_limit?: number;
}): Promise<WorkspaceResponse> {
  const sp = new URLSearchParams();
  if (params?.dm_cursor) sp.set('dm_cursor', params.dm_cursor);
  if (params?.dm_limit) sp.set('dm_limit', String(params.dm_limit));
  const qs = sp.toString();
  return request<WorkspaceResponse>(`/api/me/workspace${qs ? `?${qs}` : ''}`);
}

// ─── Org Info ───

export async function getOrg(): Promise<{ id: string; name: string; status: string }> {
  return request('/api/org');
}

// ─── DMs (Channel Messages) ───

/**
 * Backend returns either:
 *   cursor-based (before=message_id): { messages: DmMessage[], has_more: boolean } — newest first
 *   legacy (no before / before=timestamp): DmMessage[] — chronological (oldest first)
 * We normalise to: { messages: DmMessage[] (newest first), has_more }.
 * Callers should reverse() to display in chronological order.
 */
export interface DmMessageListResponse {
  messages: DmMessage[];
  has_more: boolean;
}

export async function getChannelMessages(channelId: string, params?: {
  before?: string;
  limit?: number;
}): Promise<DmMessageListResponse> {
  const sp = new URLSearchParams();
  if (params?.before) sp.set('before', params.before);
  if (params?.limit) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  const raw = await request<DmMessage[] | { messages: DmMessage[]; has_more: boolean }>(
    `/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`,
  );
  if (Array.isArray(raw)) {
    // Legacy path returns chronological; reverse to newest-first for consistency
    return { messages: [...raw].reverse(), has_more: raw.length >= (params?.limit ?? 50) };
  }
  return raw;
}

// ─── WS Ticket ───

export async function getWsTicket(): Promise<{ ticket: string; expires_in: number }> {
  return request<{ ticket: string; expires_in: number }>('/api/ws-ticket', { method: 'POST' });
}

export { ApiError };
