/**
 * Tests for Web UI flows via /api/ routes
 * - Session-based auth (login via /api/auth/login type:bot, logout, session)
 * - CSRF protection (Origin header validation)
 * - Provenance auto-injection on thread messages from bot_owner sessions
 * - Workspace, thread, and artifact browsing via session cookie
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

// ─── Helper: login as bot_owner and get session cookie ──────

async function loginAsBot(token: string, ownerName: string): Promise<string> {
  const res = await fetch(`${env.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'bot', token, owner_name: ownerName }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/hxa_session=([^;]+)/);
  if (!match) throw new Error('No session cookie in login response');
  return match[1];
}

// ─── Login / Logout ────────────────────────────────────────

describe('Web UI auth via /api/auth', () => {
  it('login with valid token returns session info and cookie', async () => {
    const res = await fetch(`${env.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bot', token: botA.token, owner_name: 'Howard' }),
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('hxa_session=');

    const body = await res.json() as any;
    expect(body.session.role).toBe('bot_owner');
    expect(body.session.bot_id).toBe(botA.bot.id);
  });

  it('login with invalid token returns 401', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'bot', token: 'invalid-token', owner_name: 'Howard' },
    });
    expect(status).toBe(401);
  });

  it('session cookie is HttpOnly and SameSite=Strict', async () => {
    const res = await fetch(`${env.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bot', token: botA.token, owner_name: 'Howard' }),
    });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('GET /api/auth/session returns session info with valid cookie', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'GET', '/api/auth/session', { cookie });

    expect(status).toBe(200);
    expect(body.role).toBe('bot_owner');
    expect(body.bot_id).toBe(botA.bot.id);
    expect(body.owner_name).toBe('Howard');
  });

  it('request without cookie returns 401', async () => {
    const { status } = await api(env.baseUrl, 'GET', '/api/auth/session', {});
    expect(status).toBe(401);
  });

  it('logout clears session', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');

    // Logout
    const { status: logoutStatus } = await api(env.baseUrl, 'POST', '/api/auth/logout', { cookie });
    expect(logoutStatus).toBe(200);

    // Subsequent request fails
    const { status } = await api(env.baseUrl, 'GET', '/api/auth/session', { cookie });
    expect(status).toBe(401);
  });
});

// ─── CSRF Protection ───────────────────────────────────────

describe('CSRF protection', () => {
  it('rejects POST with mismatched Origin header on authenticated request', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/logout', {
      cookie,
      headers: { 'Origin': 'https://evil.com' },
    });

    expect(status).toBe(403);
    expect(body.code).toBe('CSRF_ERROR');
  });

  it('allows POST with matching Origin header', async () => {
    const originUrl = new URL(env.baseUrl);
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'bot', token: botA.token, owner_name: 'Howard' },
      headers: { 'Origin': originUrl.origin },
    });
    expect(status).toBe(200);
  });

  it('allows GET requests regardless of Origin', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status } = await api(env.baseUrl, 'GET', '/api/auth/session', {
      cookie,
      headers: { 'Origin': 'https://evil.com' },
    });
    expect(status).toBe(200);
  });
});

// ─── Workspace ─────────────────────────────────────────────

describe('Web UI workspace via /api', () => {
  beforeAll(async () => {
    // Create some DM data
    await api(env.baseUrl, 'POST', '/api/send', {
      token: botA.token,
      body: { to: botB.bot.id, content: 'Hello from Alice' },
    });
  });

  it('GET /api/me/workspace returns bot info, DMs and threads', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me/workspace', { cookie });

    expect(status).toBe(200);
    expect(body.bot.id).toBe(botA.bot.id);
    expect(body.dms).toBeDefined();
    expect(body.dms.items).toBeInstanceOf(Array);
    expect(body.threads).toBeDefined();
    expect(body.threads.items).toBeInstanceOf(Array);
  });

  it('reads DM channel messages via session cookie', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { body: workspace } = await api(env.baseUrl, 'GET', '/api/me/workspace', { cookie });

    if (workspace.dms.items.length > 0) {
      const channelId = workspace.dms.items[0].channel.id;
      const { status, body } = await api(env.baseUrl, 'GET', `/api/channels/${channelId}/messages`, { cookie });

      expect(status).toBe(200);
      // Legacy format (no cursor): flat array
      expect(body).toBeInstanceOf(Array);
    }
  });
});

// ─── DM Send Block ─────────────────────────────────────────

describe('DM send block for bot_owner sessions', () => {
  it('blocks POST /api/send for bot_owner session', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'POST', '/api/send', {
      cookie,
      body: { to: botB.bot.id, content: 'should be blocked' },
    });

    expect(status).toBe(403);
    expect(body.code).toBe('DM_SEND_BLOCKED');
  });

  it('allows POST /api/send for Bearer token auth', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/send', {
      token: botA.token,
      body: { to: botB.bot.id, content: 'allowed via token' },
    });

    expect(status).toBe(200);
  });
});

// ─── Thread Operations ─────────────────────────────────────

describe('Web UI threads via /api', () => {
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
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'GET', '/api/threads?limit=10', { cookie });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.has_more).toBe('boolean');
  });

  it('gets thread detail with participants', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}`, { cookie });

    expect(status).toBe(200);
    expect(body.topic).toBe('Test Discussion');
    expect(body.participants).toBeInstanceOf(Array);
    expect(body.participants.length).toBe(2);
  });

  it('gets thread messages with cursor pagination', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?cursor=start&limit=10`, { cookie });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    // Messages should have sender_name
    expect(body.items[0].sender_name).toBeDefined();
  });

  it('gets thread artifacts', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/artifacts`, { cookie });

    expect(status).toBe(200);
    expect(body).toBeInstanceOf(Array);
  });

  it('returns 404 for nonexistent thread', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status } = await api(env.baseUrl, 'GET', '/api/threads/nonexistent-id', { cookie });
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
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
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
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?cursor=start&limit=10`, { cookie });

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

    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      cookie,
      body: { content: 'Should fail' },
    });

    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });

  it('requires content for thread message', async () => {
    // Reopen thread first
    await api(env.baseUrl, 'PATCH', `/api/threads/${threadId}`, {
      token: botA.token,
      body: { status: 'active' },
    });

    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      cookie,
      body: {},
    });

    expect(status).toBe(400);
  });

  it('handles malformed metadata string gracefully with provenance injection', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      cookie,
      body: { content: 'Message with bad metadata', metadata: 'not-valid-json' },
    });

    expect(status).toBe(200);
    // Provenance should still be injected even if user metadata was malformed
    expect(body.metadata).toBeDefined();
    expect(body.metadata.provenance.authored_by).toBe('human');
  });
});

// ─── WebSocket Ticket ──────────────────────────────────────

describe('WebSocket ticket via session', () => {
  it('issues a ws-ticket from session', async () => {
    const cookie = await loginAsBot(botA.token, 'Howard');
    const { status, body } = await api(env.baseUrl, 'POST', '/api/ws-ticket', { cookie });

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

    const css = fs.readFileSync(path.join(webDir, 'ui.css'), 'utf8');
    expect(css).toContain('--accent');
  });
});
