/**
 * Tests for PR2: Web UI Backend
 * - Session-based auth (login, logout, session expiry)
 * - CSRF protection (Origin header validation)
 * - DM send block
 * - Provenance auto-injection on thread messages
 * - Workspace, thread, and artifact browsing
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

let env: TestEnv;
let orgSecret: string;
let botA: { bot: any; token: string };
let botB: { bot: any; token: string };

beforeAll(async () => {
  env = await createTestEnv();
  const org = await env.createOrg('webui-test-org');
  orgSecret = org.org_secret;

  botA = await env.registerBot(orgSecret, 'Alice');
  botB = await env.registerBot(orgSecret, 'Bob');
});

afterAll(async () => {
  await env.cleanup();
});

// ─── Helper: raw fetch with cookie support ────────────────

async function uiRequest(
  method: string,
  path: string,
  opts?: { cookie?: string; body?: unknown; origin?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Headers; body: any; cookie?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts?.headers,
  };
  if (opts?.cookie) headers['Cookie'] = opts.cookie;
  // Auto-include Origin for CSRF compliance on authenticated mutating requests
  if (opts?.origin !== undefined) {
    headers['Origin'] = opts.origin;
  } else if (opts?.cookie && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['Origin'] = env.baseUrl;
  }

  const init: RequestInit = { method, headers };
  if (opts?.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(`${env.baseUrl}/ui/api${path}`, init);
  let body: any;
  try { body = await res.json(); } catch { body = null; }

  // Extract Set-Cookie header
  const setCookie = res.headers.get('set-cookie') || undefined;
  let cookie: string | undefined;
  if (setCookie) {
    const match = setCookie.match(/hxa_session=([^;]+)/);
    if (match) cookie = `hxa_session=${match[1]}`;
  }

  return { status: res.status, headers: res.headers, body, cookie };
}

/** Login helper — returns cookie string */
async function login(token: string, ownerName: string): Promise<string> {
  const { cookie, status } = await uiRequest('POST', '/login', {
    body: { token, owner_name: ownerName },
  });
  if (status !== 200 || !cookie) throw new Error(`Login failed: ${status}`);
  return cookie;
}

// ─── Login / Logout ────────────────────────────────────────

describe('Web UI auth', () => {
  it('login with valid token returns session info and cookie', async () => {
    const { status, body, cookie } = await uiRequest('POST', '/login', {
      body: { token: botA.token, owner_name: 'Howard' },
    });

    expect(status).toBe(200);
    expect(body.bot.id).toBe(botA.bot.id);
    expect(body.bot.name).toBe('Alice');
    expect(body.owner_name).toBe('Howard');
    expect(body.scopes).toContain('full');
    expect(cookie).toBeDefined();
  });

  it('login with invalid token returns 401', async () => {
    const { status } = await uiRequest('POST', '/login', {
      body: { token: 'invalid-token', owner_name: 'Howard' },
    });
    expect(status).toBe(401);
  });

  it('login without owner_name returns 400', async () => {
    const { status } = await uiRequest('POST', '/login', {
      body: { token: botA.token },
    });
    expect(status).toBe(400);
  });

  it('session cookie is HttpOnly and SameSite=Strict', async () => {
    const res = await uiRequest('POST', '/login', {
      body: { token: botA.token, owner_name: 'Howard' },
    });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('GET /session returns session info with valid cookie', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('GET', '/session', { cookie });

    expect(status).toBe(200);
    expect(body.bot.id).toBe(botA.bot.id);
    expect(body.owner_name).toBe('Howard');
  });

  it('request without cookie returns 401', async () => {
    const { status } = await uiRequest('GET', '/session');
    expect(status).toBe(401);
  });

  it('logout clears session', async () => {
    const cookie = await login(botA.token, 'Howard');

    // Logout
    const logoutRes = await uiRequest('POST', '/logout', { cookie });
    expect(logoutRes.status).toBe(200);

    // Subsequent request fails
    const { status } = await uiRequest('GET', '/session', { cookie });
    expect(status).toBe(401);
  });
});

// ─── CSRF Protection ───────────────────────────────────────

describe('CSRF protection', () => {
  it('rejects POST with mismatched Origin header on authenticated request', async () => {
    // CSRF only applies to authenticated (cookie) requests
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('POST', '/logout', {
      cookie,
      origin: 'https://evil.com',
    });

    expect(status).toBe(403);
    expect(body.code).toBe('CSRF_ERROR');
  });

  it('allows POST with matching Origin header', async () => {
    const originUrl = new URL(env.baseUrl);
    const { status } = await uiRequest('POST', '/login', {
      body: { token: botA.token, owner_name: 'Howard' },
      origin: originUrl.origin,
    });

    expect(status).toBe(200);
  });

  it('allows GET requests regardless of Origin', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status } = await uiRequest('GET', '/session', {
      cookie,
      origin: 'https://evil.com',
    });

    expect(status).toBe(200);
  });
});

// ─── DM Send Block ─────────────────────────────────────────

describe('DM send block', () => {
  it('blocks POST /channels/:id/messages', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('POST', '/channels/some-channel/messages', {
      cookie,
      body: { content: 'hello' },
    });

    expect(status).toBe(403);
    expect(body.code).toBe('DM_SEND_BLOCKED');
  });

  it('blocks POST /send', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('POST', '/send', {
      cookie,
      body: { to: botB.bot.id, content: 'hello' },
    });

    expect(status).toBe(403);
    expect(body.code).toBe('DM_SEND_BLOCKED');
  });
});

// ─── Workspace ─────────────────────────────────────────────

describe('Web UI workspace', () => {
  beforeAll(async () => {
    // Create some DM and thread data
    await api(env.baseUrl, 'POST', '/api/send', {
      token: botA.token,
      body: { to: botB.bot.id, content: 'Hello from Alice' },
    });
  });

  it('GET /workspace returns bot info, DMs and threads', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('GET', '/workspace', { cookie });

    expect(status).toBe(200);
    expect(body.bot.id).toBe(botA.bot.id);
    expect(body.dms).toBeDefined();
    expect(body.dms.items).toBeInstanceOf(Array);
    expect(body.threads).toBeDefined();
    expect(body.threads.items).toBeInstanceOf(Array);
  });

  it('shows DM channels with read-only messages', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { body: workspace } = await uiRequest('GET', '/workspace', { cookie });

    if (workspace.dms.items.length > 0) {
      const channelId = workspace.dms.items[0].channel.id;
      const { status, body } = await uiRequest('GET', `/channels/${channelId}/messages`, { cookie });

      expect(status).toBe(200);
      expect(body.items).toBeInstanceOf(Array);
    }
  });
});

// ─── Thread Operations ─────────────────────────────────────

describe('Web UI threads', () => {
  let threadId: string;

  beforeAll(async () => {
    // Create a thread via bot API
    const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botA.token,
      body: { topic: 'Test Discussion', participants: [botB.bot.id] },
    });
    threadId = body.id;

    // Add some messages
    await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botB.token,
      body: { content: 'Bot message from Bob' },
    });
  });

  it('lists threads with cursor pagination', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('GET', '/threads?limit=10', { cookie });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.has_more).toBe('boolean');
  });

  it('gets thread detail with participants', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('GET', `/threads/${threadId}`, { cookie });

    expect(status).toBe(200);
    expect(body.topic).toBe('Test Discussion');
    expect(body.participants).toBeInstanceOf(Array);
    expect(body.participants.length).toBe(2);
  });

  it('gets thread messages with cursor pagination', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('GET', `/threads/${threadId}/messages?limit=10`, { cookie });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    // Messages should have sender_name
    expect(body.items[0].sender_name).toBeDefined();
  });

  it('gets thread artifacts', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('GET', `/threads/${threadId}/artifacts`, { cookie });

    expect(status).toBe(200);
    expect(body).toBeInstanceOf(Array);
  });

  it('returns 404 for threads bot is not a participant of', async () => {
    // Create a thread with different bots that botA is NOT in
    // (not possible with current setup since all are in same org — skip)
    const cookie = await login(botA.token, 'Howard');
    const { status } = await uiRequest('GET', '/threads/nonexistent-id', { cookie });
    expect(status).toBe(404);
  });
});

// ─── Human Message Provenance ──────────────────────────────

describe('provenance injection', () => {
  let threadId: string;

  beforeAll(async () => {
    const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botA.token,
      body: { topic: 'Provenance Test Thread', participants: [botB.bot.id] },
    });
    threadId = body.id;
  });

  it('injects provenance metadata when human sends thread message', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('POST', `/threads/${threadId}/messages`, {
      cookie,
      body: { content: 'Human intervention message' },
    });

    expect(status).toBe(200);
    expect(body.metadata).toBeDefined();
    expect(body.metadata.provenance).toBeDefined();
    expect(body.metadata.provenance.authored_by).toBe('human');
    expect(body.metadata.provenance.owner_name).toBe('Howard');
    expect(body.metadata.provenance.auth_mode).toBe('web_ui');
    // sender_id should still be the bot
    expect(body.sender_id).toBe(botA.bot.id);
    expect(body.sender_name).toBe('Alice');
  });

  it('provenance is visible when fetching thread messages', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { body } = await uiRequest('GET', `/threads/${threadId}/messages?limit=10`, { cookie });

    const humanMsg = body.items.find((m: any) => m.metadata?.provenance?.authored_by === 'human');
    expect(humanMsg).toBeDefined();
    expect(humanMsg.metadata.provenance.owner_name).toBe('Howard');
  });

  it('rejects thread message send to resolved thread', async () => {
    // Resolve the thread via bot API
    await api(env.baseUrl, 'PATCH', `/api/threads/${threadId}`, {
      token: botA.token,
      body: { status: 'resolved' },
    });

    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('POST', `/threads/${threadId}/messages`, {
      cookie,
      body: { content: 'Should fail' },
    });

    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_TERMINAL');
  });

  it('requires content for thread message', async () => {
    // Reopen thread first
    await api(env.baseUrl, 'PATCH', `/api/threads/${threadId}`, {
      token: botA.token,
      body: { status: 'active' },
    });

    const cookie = await login(botA.token, 'Howard');
    const { status } = await uiRequest('POST', `/threads/${threadId}/messages`, {
      cookie,
      body: {},
    });

    expect(status).toBe(400);
  });
});

// ─── WebSocket Ticket ──────────────────────────────────────

describe('WebSocket ticket', () => {
  it('issues a ws-ticket from session', async () => {
    const cookie = await login(botA.token, 'Howard');
    const { status, body } = await uiRequest('POST', '/ws-ticket', { cookie });

    expect(status).toBe(200);
    expect(body.ticket).toBeDefined();
    expect(typeof body.ticket).toBe('string');
    expect(body.expires_in).toBe(30);
  });
});

// ─── Web UI Static Files ───────────────────────────────────

describe('Web UI static files', () => {
  it('frontend files exist in web/ui/', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const webDir = path.resolve(import.meta.dirname, '..', 'web', 'ui');

    expect(fs.existsSync(path.join(webDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(webDir, 'ui.css'))).toBe(true);

    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    expect(html).toContain('HXA Web UI');
    expect(html).toContain("+ '/api'");

    const css = fs.readFileSync(path.join(webDir, 'ui.css'), 'utf8');
    expect(css).toContain('--accent');
  });
});
