/**
 * Admin API client — Super Admin Console (session cookie auth)
 * and Org Admin Dashboard (session cookie auth) helpers.
 */

import type { MessagePart } from './types';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// ─── Super Admin (session cookie) ───

export interface Org {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'destroyed';
  org_secret?: string;
  bot_count: number;
  created_at: string;
}

export interface InviteCode {
  id: string;
  code?: string;
  label: string | null;
  max_uses: number;
  use_count: number;
  expires_at: string | null;
  created_at: string;
}

class AdminApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function adminRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE_PATH}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new AdminApiError(res.status, body.error ?? res.statusText);
  }
  // DELETE may return 204
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Super Admin endpoints
export const superAdmin = {
  listOrgs: () =>
    adminRequest<Org[]>('/api/orgs'),

  createOrg: (name: string) =>
    adminRequest<{ id: string; name: string; org_secret: string }>('/api/orgs', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  updateOrgStatus: (orgId: string, status: 'active' | 'suspended') =>
    adminRequest<Org>(`/api/orgs/${orgId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  destroyOrg: (orgId: string) =>
    adminRequest<void>(`/api/orgs/${orgId}`, { method: 'DELETE' }),

  rotateSecret: (orgId: string) =>
    adminRequest<{ org_secret: string }>(`/api/orgs/${orgId}/rotate-secret`, {
      method: 'POST',
    }),

  listInviteCodes: () =>
    adminRequest<InviteCode[]>('/api/platform/invite-codes'),

  createInviteCode: (params: { label?: string; max_uses?: number; expires_in?: number }) =>
    adminRequest<InviteCode>('/api/platform/invite-codes', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  revokeInviteCode: (codeId: string) =>
    adminRequest<void>(`/api/platform/invite-codes/${codeId}`, { method: 'DELETE' }),
};

// ─── Org Admin (session cookie) ───

export interface OrgBot {
  id: string;
  name: string;
  display_name?: string;
  bio?: string;
  role?: string;
  function?: string;
  team?: string;
  languages?: string[];
  timezone?: string;
  version?: string;
  tags?: string[];
  auth_role: 'admin' | 'member';
  join_status?: 'active' | 'pending' | 'rejected';
  join_status_reason?: string | null;
  online: boolean;
  created_at: string | number;
  last_seen_at?: string | number;
}

export interface OrgThread {
  id: string;
  org_id: string;
  topic: string;
  status: string;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  message_count: number;
  participant_count: number;
  participants?: Array<{ bot_id: string; bot_name?: string; name?: string; online?: boolean; label?: string; joined_at: string }>;
  visibility?: 'public' | 'members' | 'private';
  join_policy?: 'open' | 'approval' | 'invite_only';
  permission_policy?: string | null;
}

export interface ChannelMember {
  id: string;
  name: string;
  online?: boolean;
}

export interface OrgChannel {
  id: string;
  org_id: string;
  type?: string;
  name?: string | null;
  members: ChannelMember[];
  created_at: number;
  last_activity_at?: number;
}

export interface OrgChannelMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  parts: string | null | MessagePart[];
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface OrgThreadMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  content?: string;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface OrgArtifact {
  id: string;
  thread_id: string;
  artifact_key: string;
  type: string;
  title: string | null;
  content: string | null;
  language: string | null;
  version: number;
  created_at: number;
}

async function orgRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE_PATH}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new AdminApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

interface Paginated<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}

export const orgAdmin = {
  login: async (orgId: string, orgSecret: string) => {
    const res = await fetch(`${BASE_PATH}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'org_admin', org_id: orgId, org_secret: orgSecret }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new AdminApiError(res.status, body.error ?? res.statusText);
    }
    return res.json() as Promise<{
      session: { role: string; org_id: string; expires_at: number };
    }>;
  },

  getOrg: () =>
    orgRequest<{ id: string; name: string }>('/api/org'),

  listBots: (params?: { search?: string; cursor?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.search) sp.set('search', params.search);
    if (params?.cursor) sp.set('cursor', params.cursor);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return orgRequest<Paginated<OrgBot>>(`/api/bots${qs ? `?${qs}` : ''}`);
  },

  getBot: (botId: string) =>
    orgRequest<OrgBot>(`/api/bots/${botId}`),

  deleteBot: (botId: string) =>
    orgRequest<void>(`/api/bots/${botId}`, { method: 'DELETE' }),

  updateBotRole: (botId: string, role: 'admin' | 'member') =>
    orgRequest<void>(`/api/org/bots/${botId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ auth_role: role }),
    }),

  updateBotStatus: (botId: string, status: 'active' | 'rejected', reason?: string) =>
    orgRequest<{ bot_id: string; name: string; join_status: string; previous_status: string }>(`/api/org/bots/${botId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    }),

  getBotChannels: (botId: string) =>
    orgRequest<OrgChannel[] | Paginated<OrgChannel>>(`/api/bots/${botId}/channels`),

  listThreads: (params?: { search?: string; status?: string; cursor?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.search) sp.set('search', params.search);
    if (params?.status) sp.set('status', params.status);
    if (params?.cursor) sp.set('cursor', params.cursor);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return orgRequest<Paginated<OrgThread>>(`/api/org/threads${qs ? `?${qs}` : ''}`);
  },

  getThread: (threadId: string) =>
    orgRequest<OrgThread>(`/api/org/threads/${threadId}`),

  updateThread: (threadId: string, updates: { status?: string; close_reason?: string; visibility?: string; join_policy?: string; permission_policy?: Record<string, string[] | null> | null }) =>
    orgRequest<OrgThread>(`/api/org/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  inviteToThread: (threadId: string, botId: string, label?: string) =>
    orgRequest<unknown>(`/api/org/threads/${threadId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ bot_id: botId, ...(label ? { label } : {}) }),
    }),

  getThreadMessages: (threadId: string, params?: { before?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.before) sp.set('before', params.before);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return orgRequest<Paginated<OrgThreadMessage>>(`/api/org/threads/${threadId}/messages${qs ? `?${qs}` : ''}`);
  },

  getThreadArtifacts: (threadId: string, params?: { before?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.before) sp.set('before', params.before);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return orgRequest<Paginated<OrgArtifact>>(`/api/org/threads/${threadId}/artifacts${qs ? `?${qs}` : ''}`);
  },

  getChannelMessages: (channelId: string, params?: { before?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.before) sp.set('before', params.before);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return orgRequest<Paginated<OrgChannelMessage>>(`/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
  },

  sendMessage: (to: string, content: string) =>
    orgRequest<{ id: string }>('/api/send', {
      method: 'POST',
      body: JSON.stringify({ to, content }),
    }),

  createTicket: (params?: { reusable?: boolean; skip_approval?: boolean; expires_in?: number }) =>
    orgRequest<{ ticket: string; expires_at: number; reusable: boolean; skip_approval: boolean }>('/api/org/tickets', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    }),

  rotateSecret: () =>
    orgRequest<{ org_secret: string }>('/api/org/rotate-secret', { method: 'POST' }),

  getWsTicket: () =>
    orgRequest<{ ticket: string }>('/api/ws-ticket', { method: 'POST' }),

  getOrgSettings: () =>
    orgRequest<OrgSettings>('/api/org/settings'),

  updateOrgSettings: (updates: Partial<OrgSettingsUpdate>) =>
    orgRequest<OrgSettings>('/api/org/settings', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),
};

export interface OrgSettings {
  messages_per_minute_per_bot: number;
  threads_per_hour_per_bot: number;
  file_upload_mb_per_day_per_bot: number;
  message_ttl_days: number | null;
  thread_auto_close_days: number | null;
  artifact_retention_days: number | null;
  default_thread_permission_policy: Record<string, string[] | null> | null;
  join_approval_required: boolean;
}

export interface OrgSettingsUpdate {
  messages_per_minute_per_bot: number;
  threads_per_hour_per_bot: number;
  file_upload_mb_per_day_per_bot: number;
  message_ttl_days: number | null;
  thread_auto_close_days: number | null;
  artifact_retention_days: number | null;
  join_approval_required: boolean;
}

export { AdminApiError };
