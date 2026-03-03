import type { SessionData, Thread, ThreadMessage, Channel, DmMessage, DmChannelItem, Bot, Artifact } from './types';

/** Base path — all API calls go through the hxa-connect Express server.
 *  NEXT_PUBLIC_BASE_PATH is set when the app is behind a URL prefix (e.g. "/hub"). */
const BASE = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/ui/api`;

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
}): Promise<SessionData> {
  return request<SessionData>('/login', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function getSession(): Promise<SessionData> {
  return request<SessionData>('/session');
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/logout`, { method: 'POST', credentials: 'include' });
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
  return request<ThreadListResponse>(`/threads${qs ? `?${qs}` : ''}`);
}

export async function getThread(id: string): Promise<Thread> {
  return request<Thread>(`/threads/${id}`);
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
  if (params?.cursor) sp.set('cursor', params.cursor);
  if (params?.limit) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return request<MessageListResponse>(`/threads/${threadId}/messages${qs ? `?${qs}` : ''}`);
}

/** Backend expects content (string) + optional parts */
export async function sendThreadMessage(threadId: string, content: string, parts?: Array<{ type: string; content: string }>): Promise<ThreadMessage> {
  return request<ThreadMessage>(`/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, parts }),
  });
}

// ─── Artifacts ───

/** Backend returns raw Artifact[] */
export async function getThreadArtifacts(threadId: string): Promise<Artifact[]> {
  return request<Artifact[]>(`/threads/${threadId}/artifacts`);
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
  return request<WorkspaceResponse>(`/workspace${qs ? `?${qs}` : ''}`);
}

// ─── DMs (Channel Messages) ───

/** Backend response: { items, has_more, next_cursor? } */
export interface DmMessageListResponse {
  items: DmMessage[];
  has_more: boolean;
  next_cursor?: string;
}

export async function getChannelMessages(channelId: string, params?: {
  cursor?: string;
  limit?: number;
}): Promise<DmMessageListResponse> {
  const sp = new URLSearchParams();
  if (params?.cursor) sp.set('cursor', params.cursor);
  if (params?.limit) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return request<DmMessageListResponse>(`/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
}

// ─── WS Ticket ───

export async function getWsTicket(): Promise<{ ticket: string; expires_in: number }> {
  return request<{ ticket: string; expires_in: number }>('/ws-ticket', { method: 'POST' });
}

export { ApiError };
