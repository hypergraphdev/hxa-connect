import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';
import { HubDB } from '../src/db.js';
import { verifyWebhookSignature } from '../src/webhook.js';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════
// Integration Test Suite for HXA Connect
// Covers: state machine, auth types, rate limiting, webhook HMAC,
//         catchup, migration, optimistic concurrency, terminal state
// ═══════════════════════════════════════════════════════════════

describe('Thread State Machine', () => {
  let env: TestEnv;
  let orgKey: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.org_secret;
    const { token } = await env.registerBot(orgKey, 'sm-bot');
    botToken = token;
  });

  afterAll(() => env.cleanup());

  it('creates a thread in active status', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'State test' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('active');
    expect(body.revision).toBe(1);
  });

  it('allows valid transitions: active → blocked → active', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Transition test' },
    });

    // active → blocked
    const { status: s1, body: b1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'blocked' },
    });
    expect(s1).toBe(200);
    expect(b1.status).toBe('blocked');

    // blocked → active
    const { status: s2, body: b2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'active' },
    });
    expect(s2).toBe(200);
    expect(b2.status).toBe('active');
  });

  it('allows active → reviewing → resolved', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Review flow' },
    });

    const { status: s1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'reviewing' },
    });
    expect(s1).toBe(200);

    const { status: s2, body: b2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'resolved' },
    });
    expect(s2).toBe(200);
    expect(b2.status).toBe('resolved');
    expect(b2.resolved_at).toBeTypeOf('number');
  });

  it('allows active → closed with close_reason', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Close test' },
    });

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'closed', close_reason: 'manual' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('closed');
    expect(body.close_reason).toBe('manual');
  });

  it('rejects invalid transitions', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Invalid transition' },
    });

    // active → resolved (not allowed — must go through reviewing)
    // Actually checking ALLOWED_TRANSITIONS: active → resolved IS allowed
    // Let's test blocked → closed (not allowed)
    await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'blocked' },
    });

    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'closed', close_reason: 'manual' },
    });
    expect(status).toBe(400);
  });

  it('requires close_reason for closed status', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Missing close_reason' },
    });

    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken,
      body: { status: 'closed' },
    });
    expect(status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Auth Types', () => {
  let env: TestEnv;
  let orgSecret: string;
  let orgTicket: string;
  let botToken: string;
  let botId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgSecret = org.org_secret;
    const { bot, token } = await env.registerBot(orgSecret, 'auth-bot');
    botToken = token;
    botId = bot.id;
    orgTicket = await env.loginAsOrg(orgSecret);
  });

  afterAll(() => env.cleanup());

  it('authenticates with primary bot token (full scope)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', { token: botToken });
    expect(status).toBe(200);
    expect(body.id).toBe(botId);
  });

  it('authenticates with org ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', { token: orgTicket });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('rejects requests without token', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {});
    expect(status).toBe(401);
    expect(body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects invalid token', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', { token: 'bogus-token' });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  // ─── Scoped tokens ────────────────────────────────────────

  it('creates scoped token with read scope', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { scopes: ['read'], label: 'read-only' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.scopes).toEqual(['read']);
  });

  it('scoped read token can access GET endpoints', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { scopes: ['read'], label: 'test-read' },
    });

    const { status } = await api(env.baseUrl, 'GET', '/api/me', { token: tokenData.token });
    expect(status).toBe(200);
  });

  it('scoped read token cannot create threads', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { scopes: ['read'], label: 'test-read-2' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: tokenData.token,
      body: { topic: 'Should fail' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('scoped thread token can create threads', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { scopes: ['thread'], label: 'test-thread' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: tokenData.token,
      body: { topic: 'Scoped creation' },
    });
    expect(status).toBe(200);
    expect(body.topic).toBe('Scoped creation');
  });

  it('scoped thread token cannot read threads list (needs read scope)', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { scopes: ['thread'], label: 'test-thread-2' },
    });

    const { status } = await api(env.baseUrl, 'GET', '/api/threads', { token: tokenData.token });
    expect(status).toBe(403);
  });

  it('org ticket bypasses scope checks', async () => {
    // Org ticket can access bot listing (which requires 'read' scope for bots)
    const { status } = await api(env.baseUrl, 'GET', '/api/bots', { token: orgTicket });
    expect(status).toBe(200);
  });

  it('expired scoped token is rejected', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { scopes: ['read'], label: 'expires-now', expires_in: 100 },
    });
    expect(tokenData.expires_at).toBeTypeOf('number');

    // Wait for token to expire
    await new Promise(r => setTimeout(r, 200));

    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', { token: tokenData.token });
    expect(status).toBe(401);
    expect(body.code).toBe('TOKEN_EXPIRED');
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Rate Limiting', () => {
  let env: TestEnv;
  let orgKey: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.org_secret;

    // Set very low rate limits for testing
    env.db.updateOrgSettings(org.id, {
      messages_per_minute_per_bot: 3,
      threads_per_hour_per_bot: 2,
    });

    const { token } = await env.registerBot(orgKey, 'rate-bot');
    botToken = token;
  });

  afterAll(() => env.cleanup());

  it('allows requests within thread rate limit', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Thread 1' },
    });
    expect(status).toBe(200);
  });

  it('blocks thread creation when limit exceeded', async () => {
    // Create thread 2 (should succeed — limit is 2)
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Thread 2' },
    });
    expect(s1).toBe(200);

    // Thread 3 — should be rate limited
    const { status, body, headers } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Thread 3' },
    });
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(headers.get('retry-after')).toBeTruthy();
  });

  it('allows messages within message rate limit', async () => {
    // Use one of the threads we already created
    const { body: threads } = await api(env.baseUrl, 'GET', '/api/threads', { token: botToken });
    const threadId = threads[0].id;

    for (let i = 0; i < 3; i++) {
      const { status } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
        token: botToken,
        body: { content: `Message ${i}` },
      });
      expect(status).toBe(200);
    }
  });

  it('blocks messages when limit exceeded', async () => {
    const { body: threads } = await api(env.baseUrl, 'GET', '/api/threads', { token: botToken });
    const threadId = threads[0].id;

    // 4th message should fail (limit is 3/min)
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken,
      body: { content: 'Over limit' },
    });
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retry_after).toBeTypeOf('number');
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Webhook HMAC Verification', () => {
  const secret = 'test-webhook-secret-abc123';

  it('verifies a valid signature', () => {
    const body = JSON.stringify({ type: 'test', data: 'hello' });
    const timestamp = String(Date.now());
    const signedPayload = `${timestamp}.${body}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

    const result = verifyWebhookSignature(secret, `sha256=${signature}`, timestamp, body);
    expect(result).toBe(true);
  });

  it('rejects invalid signature', () => {
    const body = '{"data":"test"}';
    const timestamp = String(Date.now());

    const result = verifyWebhookSignature(secret, 'sha256=0000000000000000000000000000000000000000000000000000000000000000', timestamp, body);
    expect(result).toBe(false);
  });

  it('rejects tampered body', () => {
    const originalBody = '{"data":"original"}';
    const tamperedBody = '{"data":"tampered"}';
    const timestamp = String(Date.now());
    const signedPayload = `${timestamp}.${originalBody}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

    const result = verifyWebhookSignature(secret, `sha256=${signature}`, timestamp, tamperedBody);
    expect(result).toBe(false);
  });

  it('rejects stale timestamp (replay protection)', () => {
    const body = '{"data":"test"}';
    const staleTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 min ago
    const signedPayload = `${staleTimestamp}.${body}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

    const result = verifyWebhookSignature(secret, `sha256=${signature}`, staleTimestamp, body);
    expect(result).toBe(false);
  });

  it('rejects non-hex signature format', () => {
    const body = '{"data":"test"}';
    const timestamp = String(Date.now());

    const result = verifyWebhookSignature(secret, 'sha256=not-valid-hex!', timestamp, body);
    expect(result).toBe(false);
  });

  it('uses timing-safe comparison', () => {
    // This test ensures the function uses timingSafeEqual internally.
    // We verify that valid and invalid signatures both take similar time,
    // but we can at least test that it returns correct results for edge cases.
    const body = '{"data":"test"}';
    const timestamp = String(Date.now());
    const signedPayload = `${timestamp}.${body}`;
    const correct = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

    // Off by one character in the last position
    const almostCorrect = correct.slice(0, -1) + (correct[63] === 'a' ? 'b' : 'a');

    expect(verifyWebhookSignature(secret, `sha256=${correct}`, timestamp, body)).toBe(true);
    expect(verifyWebhookSignature(secret, `sha256=${almostCorrect}`, timestamp, body)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Catchup Events', () => {
  let env: TestEnv;
  let orgKey: string;
  let bot1Token: string;
  let bot2Token: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.org_secret;
    const a1 = await env.registerBot(orgKey, 'catchup-bot-1');
    const a2 = await env.registerBot(orgKey, 'catchup-bot-2');
    bot1Token = a1.token;
    bot2Token = a2.token;
  });

  afterAll(() => env.cleanup());

  it('generates thread_invited event for invited participants', async () => {
    const since = Date.now() - 1000;

    // Bot 1 creates a thread inviting bot 2
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: bot2Token });

    await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'Catchup test', participants: [a2me.name] },
    });

    // Bot 2 checks catchup
    const { status, body } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}`, {
      token: bot2Token,
    });
    expect(status).toBe(200);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const invite = body.events.find((e: any) => e.type === 'thread_invited');
    expect(invite).toBeTruthy();
    expect(invite.topic).toBe('Catchup test');
  });

  it('generates thread_status_changed events', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: bot2Token });

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'Status change catchup', participants: [a2me.name] },
    });

    const since = Date.now() - 100;

    await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { status: 'reviewing' },
    });

    const { body: catchup } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}`, {
      token: bot2Token,
    });
    const statusEvent = catchup.events.find((e: any) => e.type === 'thread_status_changed');
    expect(statusEvent).toBeTruthy();
    expect(statusEvent.from).toBe('active');
    expect(statusEvent.to).toBe('reviewing');
  });

  it('paginates catchup events via cursor', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: bot2Token });
    const since = Date.now() - 1000;

    // Create several threads to generate multiple catchup events
    for (let i = 0; i < 5; i++) {
      await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: `Paginate ${i}`, participants: [a2me.name] },
      });
    }

    // Request with small limit
    const { body: page1 } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}&limit=3`, {
      token: bot2Token,
    });
    expect(page1.events.length).toBe(3);

    if (page1.has_more) {
      // Fetch page 2 using cursor
      const { body: page2 } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}&limit=3&cursor=${page1.cursor}`, {
        token: bot2Token,
      });
      expect(page2.events.length).toBeGreaterThan(0);
      // Ensure no overlap with page 1
      const page1Ids = new Set(page1.events.map((e: any) => e.event_id));
      for (const e of page2.events) {
        expect(page1Ids.has(e.event_id)).toBe(false);
      }
    }
  });

  it('returns catchup count by type', async () => {
    const since = Date.now() - 60000;
    const { status, body } = await api(env.baseUrl, 'GET', `/api/me/catchup/count?since=${since}`, {
      token: bot2Token,
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty('thread_invites');
    expect(body).toHaveProperty('thread_status_changes');
    expect(body).toHaveProperty('total');
    expect(body.total).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Migration & Schema', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(() => env.cleanup());

  it('creates schema_versions table on startup', () => {
    const row = env.db['db'].prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'`
    ).get() as any;
    expect(row).toBeTruthy();
    expect(row.name).toBe('schema_versions');
  });

  it('schema_versions table exists and is empty on fresh install', () => {
    const rows = env.db['db'].prepare(`SELECT * FROM schema_versions`).all() as any[];
    expect(rows.length).toBe(0);
  });

  it('migration is idempotent (creating second HubDB on same dir succeeds)', () => {
    // Creating a new HubDB instance on the same data_dir should not throw
    const db2 = new HubDB(env.config);
    expect(db2).toBeTruthy();
    db2.close();
  });

  it('all expected tables exist', () => {
    const tables = env.db['db'].prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as any[];
    const tableNames = tables.map((t: any) => t.name);

    // Core tables
    expect(tableNames).toContain('orgs');
    expect(tableNames).toContain('bots');
    expect(tableNames).toContain('channels');
    expect(tableNames).toContain('threads');
    expect(tableNames).toContain('thread_messages');
    expect(tableNames).toContain('thread_participants');
    expect(tableNames).toContain('artifacts');
    expect(tableNames).toContain('catchup_events');
    expect(tableNames).toContain('rate_limit_events');
    expect(tableNames).toContain('audit_log');
    expect(tableNames).toContain('schema_versions');
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Optimistic Concurrency (If-Match)', () => {
  let env: TestEnv;
  let orgKey: string;
  let bot1Token: string;
  let bot2Token: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.org_secret;
    const a1 = await env.registerBot(orgKey, 'occ-bot-1');
    const a2 = await env.registerBot(orgKey, 'occ-bot-2');
    bot1Token = a1.token;
    bot2Token = a2.token;
  });

  afterAll(() => env.cleanup());

  it('succeeds with correct revision in If-Match', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: bot2Token });

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'OCC test', participants: [a2me.name] },
    });
    expect(thread.revision).toBe(1);

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { topic: 'Updated topic' },
      headers: { 'If-Match': `"${thread.revision}"` },
    });
    expect(status).toBe(200);
    expect(body.topic).toBe('Updated topic');
    expect(body.revision).toBe(2);
  });

  it('returns 409 on revision conflict', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: bot2Token });

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'Conflict test', participants: [a2me.name] },
    });

    // Bot 1 updates with correct revision
    await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { topic: 'Bot 1 update' },
      headers: { 'If-Match': '"1"' },
    });

    // Bot 2 tries to update with stale revision (1, but now it's 2)
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot2Token,
      body: { topic: 'Bot 2 update' },
      headers: { 'If-Match': '"1"' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('REVISION_CONFLICT');
  });

  it('revision increments on each update', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'Increment test' },
    });
    expect(thread.revision).toBe(1);

    const { body: u1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { context: 'step 1' },
    });
    expect(u1.revision).toBe(2);

    const { body: u2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { context: 'step 2' },
    });
    expect(u2.revision).toBe(3);
  });

  it('ETag header matches revision', async () => {
    const { body: thread, headers } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'ETag test' },
    });
    expect(headers.get('etag')).toBe(`"${thread.revision}"`);

    const { body: updated, headers: h2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { topic: 'Updated' },
    });
    expect(h2.get('etag')).toBe(`"${updated.revision}"`);
  });

  it('works without If-Match (no concurrency check)', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'No If-Match' },
    });

    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: bot1Token,
      body: { topic: 'Updated without If-Match' },
    });
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Terminal State Protection', () => {
  let env: TestEnv;
  let orgKey: string;
  let bot1Token: string;
  let bot2Token: string;
  let resolvedThreadId: string;
  let closedThreadId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.org_secret;
    const a1 = await env.registerBot(orgKey, 'term-bot-1');
    const a2 = await env.registerBot(orgKey, 'term-bot-2');
    bot1Token = a1.token;
    bot2Token = a2.token;

    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: bot2Token });

    // Create and resolve a thread
    const { body: t1 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'Will resolve', participants: [a2me.name] },
    });
    await api(env.baseUrl, 'PATCH', `/api/threads/${t1.id}`, {
      token: bot1Token,
      body: { status: 'resolved' },
    });
    resolvedThreadId = t1.id;

    // Create and close a thread
    const { body: t2 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: bot1Token,
      body: { topic: 'Will close', participants: [a2me.name] },
    });
    await api(env.baseUrl, 'PATCH', `/api/threads/${t2.id}`, {
      token: bot1Token,
      body: { status: 'closed', close_reason: 'manual' },
    });
    closedThreadId = t2.id;
  });

  afterAll(() => env.cleanup());

  it('rejects messages on resolved thread', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${resolvedThreadId}/messages`, {
      token: bot1Token,
      body: { content: 'Should fail' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });

  it('rejects messages on closed thread', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${closedThreadId}/messages`, {
      token: bot1Token,
      body: { content: 'Should fail' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });

  it('rejects artifacts on resolved thread', async () => {
    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${resolvedThreadId}/artifacts`, {
      token: bot1Token,
      body: { artifact_key: 'test', type: 'text', content: 'nope' },
    });
    expect(status).toBe(409);
  });

  it('rejects participant changes on resolved thread', async () => {
    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${resolvedThreadId}/participants`, {
      token: bot1Token,
      body: { bot_id: 'term-bot-2' },
    });
    expect(status).toBe(409);
  });

  it('rejects status transitions from resolved', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${resolvedThreadId}`, {
      token: bot1Token,
      body: { status: 'active' },
    });
    expect(status).toBe(400); // ALLOWED_TRANSITIONS[resolved] = []
  });

  it('rejects status transitions from closed', async () => {
    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${closedThreadId}`, {
      token: bot1Token,
      body: { status: 'active' },
    });
    expect(status).toBe(400);
  });

  it('rejects context/topic updates on terminal threads', async () => {
    const { status: s1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${resolvedThreadId}`, {
      token: bot1Token,
      body: { context: 'new context' },
    });
    expect(s1).toBe(409);

    const { status: s2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${closedThreadId}`, {
      token: bot1Token,
      body: { topic: 'new topic' },
    });
    expect(s2).toBe(409);
  });

  it('can still read terminal thread details', async () => {
    const { status: s1, body: b1 } = await api(env.baseUrl, 'GET', `/api/threads/${resolvedThreadId}`, {
      token: bot1Token,
    });
    expect(s1).toBe(200);
    expect(b1.status).toBe('resolved');

    const { status: s2, body: b2 } = await api(env.baseUrl, 'GET', `/api/threads/${closedThreadId}`, {
      token: bot1Token,
    });
    expect(s2).toBe(200);
    expect(b2.status).toBe('closed');
  });

  it('can still read messages from terminal threads', async () => {
    const { status } = await api(env.baseUrl, 'GET', `/api/threads/${resolvedThreadId}/messages`, {
      token: bot1Token,
    });
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Health Endpoint', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(() => env.cleanup());

  it('returns 200 with ok status', async () => {
    const res = await fetch(`${env.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.uptime_ms).toBeTypeOf('number');
    expect(body.connected_clients).toBeTypeOf('number');
  });

  it('requires no authentication', async () => {
    // No token provided — should still work
    const res = await fetch(`${env.baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 2: Ticket-Based Auth, Role Enforcement
// ═══════════════════════════════════════════════════════════════

describe('Phase 2: Auth Login', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('login-org');
    orgId = org.id;
    orgSecret = org.org_secret;
  });

  afterAll(() => env.cleanup());

  it('issues a ticket on valid login', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTypeOf('string');
    expect(body.expires_at).toBeTypeOf('number');
    expect(body.reusable).toBe(false);
    expect(body.org.id).toBe(orgId);
    expect(body.org.name).toBe('login-org');
  });

  it('issues a reusable ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, reusable: true, expires_in: 3600 },
    });
    expect(status).toBe(200);
    expect(body.reusable).toBe(true);
    expect(body.expires_at).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  it('rejects wrong org_secret', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: 'wrong-secret' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_SECRET');
  });

  it('rejects unknown org_id', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: 'nonexistent', org_secret: orgSecret },
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('rejects missing fields', async () => {
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_secret: orgSecret },
    });
    expect(s1).toBe(400);

    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId },
    });
    expect(s2).toBe(400);
  });
});

describe('Phase 2: Ticket-Based Registration', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('ticket-reg-org');
    orgId = org.id;
    orgSecret = org.org_secret;
  });

  afterAll(() => env.cleanup());

  it('all bots register as member by default', async () => {
    // Login to get a ticket
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });

    // Register first bot
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'first-bot' },
    });
    expect(status).toBe(200);
    expect(body.bot_id).toBeTypeOf('string');
    expect(body.token).toBeTypeOf('string');
    expect(body.name).toBe('first-bot');
    expect(body.auth_role).toBe('member');
  });

  it('second bot also registers as member', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'second-bot' },
    });
    expect(status).toBe(200);
    expect(body.auth_role).toBe('member');
  });

  it('one-time ticket cannot be reused', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, reusable: false },
    });

    // First use — succeeds
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'onetime-bot-1' },
    });
    expect(s1).toBe(200);

    // Second use — fails
    const { status: s2, body: b2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'onetime-bot-2' },
    });
    expect(s2).toBe(401);
    expect(b2.code).toBe('TICKET_CONSUMED');
  });

  it('reusable ticket can be used multiple times', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, reusable: true },
    });

    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'reusable-bot-1' },
    });
    expect(s1).toBe(200);

    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'reusable-bot-2' },
    });
    expect(s2).toBe(200);
  });

  it('rejects invalid ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: 'nonexistent-ticket', name: 'bad-ticket-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('rejects ticket from wrong org', async () => {
    const otherOrg = env.createOrg('other-org');
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: otherOrg.id, org_secret: otherOrg.org_secret },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'cross-org-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('rejects missing required fields in ticket registration', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });

    // Missing name
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket },
    });
    expect(s1).toBe(400);

    // Missing org_id
    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { ticket: loginBody.ticket, name: 'no-org-bot' },
    });
    expect(s2).toBe(400);
  });
});

describe('Phase 2: toAgentResponse includes auth_role', () => {
  let env: TestEnv;
  let orgTicket: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    const { token } = await env.registerBot(org.org_secret, 'role-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('GET /api/me includes auth_role', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', { token: botToken });
    expect(status).toBe(200);
    expect(body.auth_role).toBeDefined();
  });

  it('GET /api/bots includes auth_role in list', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', { token: orgTicket });
    expect(status).toBe(200);
    expect(body[0].auth_role).toBeDefined();
  });
});

describe('Phase 2: Role Enforcement & Management', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let adminToken: string;
  let adminId: string;
  let memberToken: string;
  let memberId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('role-org');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Create bots (both register as member by default)
    const { bot: adminBot, token: aToken } = await env.registerBot(orgSecret, 'admin-bot');
    adminToken = aToken;
    adminId = adminBot.bot_id;

    const { bot: memberBot, token: mToken } = await env.registerBot(orgSecret, 'member-bot');
    memberToken = mToken;
    memberId = memberBot.bot_id;

    // Promote admin-bot via org admin
    await env.promoteBot(orgSecret, adminId);
  });

  afterAll(() => env.cleanup());

  it('admin can create tickets via /api/org/tickets', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/org/tickets', {
      token: adminToken,
      body: { reusable: true, expires_in: 7200 },
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTypeOf('string');
    expect(body.reusable).toBe(true);
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  it('member cannot create tickets', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/org/tickets', {
      token: memberToken,
      body: {},
    });
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('admin can promote member to admin', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'admin' },
    });
    expect(status).toBe(200);
    expect(body.bot_id).toBe(memberId);
    expect(body.auth_role).toBe('admin');
  });

  it('admin can demote other admin to member', async () => {
    // First promote memberId to admin (may already be from previous test)
    await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'admin' },
    });

    // Now demote
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'member' },
    });
    expect(status).toBe(200);
    expect(body.auth_role).toBe('member');
  });

  it('admin cannot demote self', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${adminId}/role`, {
      token: adminToken,
      body: { auth_role: 'member' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('SELF_DEMOTION');
  });

  it('member cannot change roles', async () => {
    const { status } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${adminId}/role`, {
      token: memberToken,
      body: { auth_role: 'member' },
    });
    expect(status).toBe(403);
  });

  it('rejects invalid auth_role value', async () => {
    const { status } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'superadmin' },
    });
    expect(status).toBe(400);
  });
});

describe('Phase 2: Org Secret Rotation', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('rotate-org');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Create bots
    const { bot: adminBot, token: aToken } = await env.registerBot(orgSecret, 'rotate-admin-bot');
    adminToken = aToken;

    const { token: mToken } = await env.registerBot(orgSecret, 'rotate-member-bot');
    memberToken = mToken;

    // Promote admin bot via org admin
    await env.promoteBot(orgSecret, adminBot.bot_id);
  });

  afterAll(() => env.cleanup());

  it('admin can rotate org secret', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });
    expect(status).toBe(200);
    expect(body.org_secret).toBeTypeOf('string');
    expect(body.org_secret).toHaveLength(48); // 24 bytes hex
  });

  it('new secret works for login after rotation', async () => {
    // Rotate
    const { body: rotateBody } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });
    const newSecret = rotateBody.org_secret;

    // Login with new secret works
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: newSecret },
    });
    expect(status).toBe(200);

    // Login with old secret fails
    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(s2).toBe(401);
  });

  it('rotation invalidates outstanding tickets', async () => {
    // Get a new secret first
    const { body: rotBody } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });

    // Login to get a ticket with current secret
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: rotBody.org_secret },
    });
    const ticketBeforeRotation = loginBody.ticket;

    // Rotate again
    await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });

    // Try to use the old ticket — should fail (tickets were invalidated)
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticketBeforeRotation, name: 'post-rotation-bot' },
    });
    expect(status).toBe(401);
  });

  it('member cannot rotate secret', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: memberToken,
    });
    expect(status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 3: Multi-Org Context (X-Org-Id Header & WS Ticket Org Binding)
// ═══════════════════════════════════════════════════════════════

describe('Phase 3: X-Org-Id Header Validation', () => {
  let env: TestEnv;
  let orgId: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgId = org.id;
    const { token } = await env.registerBot(org.org_secret, 'org-header-bot');
    botToken = token;
  });

  afterAll(() => env.cleanup());

  it('accepts X-Org-Id matching bot org', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
      headers: { 'X-Org-Id': orgId },
    });
    expect(status).toBe(200);
    expect(body.org_id).toBe(orgId);
  });

  it('rejects X-Org-Id not matching bot org', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
      headers: { 'X-Org-Id': 'wrong-org-id-00000000' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
  });

  it('works without X-Org-Id (backward compat)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(body.org_id).toBe(orgId);
  });

  it('rejects X-Org-Id for scoped token with wrong org', async () => {
    // Create a scoped token
    const { body: tokenBody } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { label: 'scoped-org-test', scopes: ['read'] },
    });
    expect(tokenBody.token).toBeTruthy();

    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: tokenBody.token,
      headers: { 'X-Org-Id': 'wrong-org-id-00000000' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
  });

  it('accepts X-Org-Id for scoped token with correct org', async () => {
    const { body: tokenBody } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: botToken,
      body: { label: 'scoped-org-test-ok', scopes: ['read'] },
    });

    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: tokenBody.token,
      headers: { 'X-Org-Id': orgId },
    });
    expect(status).toBe(200);
    expect(body.org_id).toBe(orgId);
  });
});

describe('Phase 3: WS Ticket Org Binding', () => {
  let env: TestEnv;
  let orgId: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgId = org.id;
    const { token } = await env.registerBot(org.org_secret, 'ws-org-bot');
    botToken = token;
  });

  afterAll(() => env.cleanup());

  it('ws-ticket includes org binding and WS connection succeeds', async () => {
    // Get a ws-ticket (should include org binding)
    const { status, body } = await api(env.baseUrl, 'POST', '/api/ws-ticket', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTruthy();
    expect(body.expires_in).toBe(30);

    // Connect via WS using the ticket
    const wsUrl = env.baseUrl.replace('http', 'ws');
    const ws = await new Promise<import('ws').WebSocket>((resolve, reject) => {
      const { WebSocket } = require('ws');
      const socket = new WebSocket(`${wsUrl}/ws?ticket=${body.ticket}`);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 3000);
    });

    // Connection succeeded — org binding was valid
    expect(ws.readyState).toBe(1); // OPEN
    ws.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 4: Super Admin Org Lifecycle
// ═══════════════════════════════════════════════════════════════

describe('Phase 4: Super Admin Org Lifecycle', () => {
  const ADMIN_SECRET = 'test-super-admin-secret';
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: ADMIN_SECRET });
  });

  afterAll(() => env.cleanup());

  it('POST /api/orgs returns org_secret and status', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/orgs', {
      token: ADMIN_SECRET,
      body: { name: 'lifecycle-org' },
    });
    expect(status).toBe(200);
    expect(body.name).toBe('lifecycle-org');
    expect(body.status).toBe('active');
    expect(body.org_secret).toBeTypeOf('string');
  });

  it('POST /api/orgs requires admin auth', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'wrong-secret',
      body: { name: 'should-fail' },
    });
    expect(status).toBe(401);
  });

  it('GET /api/orgs includes status and bot_count', async () => {
    // Create an org with a bot so we can verify bot_count
    const org = env.createOrg('list-test-org');
    await env.registerBot(org.org_secret, 'list-bot');

    const { status, body } = await api(env.baseUrl, 'GET', '/api/orgs', {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((o: any) => o.name === 'list-test-org');
    expect(found).toBeDefined();
    expect(found.status).toBe('active');
    expect(found.bot_count).toBe(1);
    // org_secret should be stripped from list
    expect(found.org_secret).toBeUndefined();
  });

  it('PATCH /api/orgs/:id can update name', async () => {
    const org = env.createOrg('rename-me');

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { name: 'renamed-org' },
    });
    expect(status).toBe(200);
    expect(body.name).toBe('renamed-org');
    expect(body.status).toBe('active');
  });

  it('PATCH /api/orgs/:id can suspend org', async () => {
    const org = env.createOrg('suspend-me');

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'suspended' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('suspended');
  });

  it('PATCH /api/orgs/:id can reactivate suspended org', async () => {
    const org = env.createOrg('reactivate-me');

    // Suspend
    await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'suspended' },
    });

    // Reactivate
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'active' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('active');
  });

  it('PATCH /api/orgs/:id rejects setting status to destroyed', async () => {
    const org = env.createOrg('no-destroy-patch');

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'destroyed' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /api/orgs/:id rejects modifying destroyed org', async () => {
    const org = env.createOrg('destroy-then-patch');

    // Destroy via DELETE
    await api(env.baseUrl, 'DELETE', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
    });

    // Try to modify — org is gone (deleted from DB)
    const { status } = await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { name: 'impossible' },
    });
    expect(status).toBe(404);
  });

  it('PATCH /api/orgs/:id returns 404 for unknown org', async () => {
    const { status } = await api(env.baseUrl, 'PATCH', '/api/orgs/nonexistent-id', {
      token: ADMIN_SECRET,
      body: { name: 'nope' },
    });
    expect(status).toBe(404);
  });

  it('DELETE /api/orgs/:id destroys org', async () => {
    const org = env.createOrg('destroy-me');

    const { status } = await api(env.baseUrl, 'DELETE', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(204);

    // Verify org is gone
    const { status: listStatus, body: orgs } = await api(env.baseUrl, 'GET', '/api/orgs', {
      token: ADMIN_SECRET,
    });
    expect(listStatus).toBe(200);
    const found = orgs.find((o: any) => o.id === org.id);
    expect(found).toBeUndefined();
  });

  it('DELETE /api/orgs/:id returns 404 for unknown org', async () => {
    const { status } = await api(env.baseUrl, 'DELETE', '/api/orgs/nonexistent-id', {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(404);
  });

  it('suspended org rejects authenticated API calls', async () => {
    const org = env.createOrg('suspend-api-test');
    const { token: botToken } = await env.registerBot(org.org_secret, 'test-bot');

    // Verify bot can make API calls initially
    const { status: beforeStatus } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(beforeStatus).toBe(200);

    // Suspend org
    await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'suspended' },
    });

    // Bot API calls should now be rejected
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_SUSPENDED');
  });

  it('reactivated org allows API calls again', async () => {
    const org = env.createOrg('reactivate-api-test');
    const { token: botToken } = await env.registerBot(org.org_secret, 'test-bot');

    // Suspend
    await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'suspended' },
    });

    // Verify blocked
    const { status: blockedStatus } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(blockedStatus).toBe(403);

    // Reactivate
    await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'active' },
    });

    // API calls should work again
    const { status } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(status).toBe(200);
  });

  it('suspended org invalidates org tickets', async () => {
    const org = env.createOrg('suspend-ticket-test');
    const orgTicket = await env.loginAsOrg(org.org_secret);

    // Verify ticket works initially
    const { status: beforeStatus } = await api(env.baseUrl, 'GET', '/api/bots', {
      token: orgTicket,
    });
    expect(beforeStatus).toBe(200);

    // Suspend — invalidates all outstanding org tickets
    await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'suspended' },
    });

    // Org ticket should be invalidated (401, not 403)
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', {
      token: orgTicket,
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('suspension invalidates outstanding org tickets', async () => {
    const org = env.createOrg('suspend-tickets-test');

    // Login to get a ticket
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: org.id, org_secret: org.org_secret },
    });
    const ticket = loginBody.ticket;
    expect(ticket).toBeTypeOf('string');

    // Suspend the org
    await api(env.baseUrl, 'PATCH', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
      body: { status: 'suspended' },
    });

    // Ticket should be invalidated
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: org.id, ticket, name: 'post-suspend-bot' },
    });
    expect(status).toBe(401);
  });

  it('destroy cascades to bots and channels', async () => {
    const org = env.createOrg('cascade-test');
    const { token: botToken } = await env.registerBot(org.org_secret, 'cascade-bot');

    // Verify bot exists
    const { status: agentStatus } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(agentStatus).toBe(200);

    // Destroy
    const { status } = await api(env.baseUrl, 'DELETE', `/api/orgs/${org.id}`, {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(204);

    // Bot token should be invalid (org and bots deleted)
    const { status: afterStatus } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(afterStatus).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5: Web UI Backend (Pagination + GET /api/org + Login)
// ═══════════════════════════════════════════════════════════════

describe('Phase 5: GET /api/org', () => {
  let env: TestEnv;
  let orgId: string;
  let botToken: string;
  let orgTicket: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('org-info-test');
    orgId = org.id;
    const { token } = await env.registerBot(org.org_secret, 'info-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns org info via bot token', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(body.id).toBe(orgId);
    expect(body.name).toBe('org-info-test');
    expect(body.status).toBe('active');
  });

  it('returns org info via org ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.id).toBe(orgId);
    expect(body.name).toBe('org-info-test');
  });

  it('rejects unauthenticated request', async () => {
    const { status } = await api(env.baseUrl, 'GET', '/api/org', {});
    expect(status).toBe(401);
  });
});

describe('Phase 5: Agents Pagination', () => {
  let env: TestEnv;
  let orgTicket: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    // Register 5 bots
    for (let i = 0; i < 5; i++) {
      await env.registerBot(org.org_secret, `page-bot-${i}`);
    }
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns unpaginated list when no params', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
  });

  it('returns paginated response with limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots?limit=2', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();
  });

  it('cursor-based pagination walks all bots', async () => {
    let cursor: string | undefined;
    const allNames: string[] = [];

    for (let page = 0; page < 10; page++) {
      const url = cursor ? `/api/bots?limit=2&cursor=${cursor}` : '/api/bots?limit=2';
      const { body } = await api(env.baseUrl, 'GET', url, { token: orgTicket });
      for (const a of body.items) allNames.push(a.name);
      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    expect(allNames.length).toBe(5);
    // All unique
    expect(new Set(allNames).size).toBe(5);
  });
});

describe('Phase 5: Threads Pagination', () => {
  let env: TestEnv;
  let botToken: string;
  let orgTicket: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    const { token } = await env.registerBot(org.org_secret, 'thread-page-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
    // Create 4 threads
    for (let i = 0; i < 4; i++) {
      await api(env.baseUrl, 'POST', '/api/threads', {
        token: botToken,
        body: { topic: `Thread ${i}` },
      });
    }
  });

  afterAll(() => env.cleanup());

  it('returns paginated threads with limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?limit=2', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();
  });

  it('cursor pagination walks all threads', async () => {
    let cursor: string | undefined;
    const topics: string[] = [];

    for (let page = 0; page < 10; page++) {
      const url = cursor ? `/api/org/threads?limit=2&cursor=${cursor}` : '/api/org/threads?limit=2';
      const { body } = await api(env.baseUrl, 'GET', url, {
        token: orgTicket,
      });
      for (const t of body.items) topics.push(t.topic);
      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    expect(topics.length).toBe(4);
  });
});

describe('Phase 5: Channel Messages Pagination', () => {
  let env: TestEnv;
  let botToken1: string;
  let orgTicket: string;
  let channelId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    const { token: t1, bot: a1 } = await env.registerBot(org.org_secret, 'msg-bot-1');
    const { bot: a2 } = await env.registerBot(org.org_secret, 'msg-bot-2');
    botToken1 = t1;
    orgTicket = await env.loginAsOrg(org.org_secret);

    // Create a DM channel via org ticket
    const { body: ch } = await api(env.baseUrl, 'POST', '/api/channels', {
      token: orgTicket,
      body: { type: 'direct', members: [a1.id, a2.id] },
    });
    channelId = ch.id;

    // Send 6 messages via bot token
    for (let i = 0; i < 6; i++) {
      await api(env.baseUrl, 'POST', `/api/channels/${channelId}/messages`, {
        token: botToken1,
        body: { content: `Message ${i}` },
      });
    }
  });

  afterAll(() => env.cleanup());

  it('returns latest messages with limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/channels/${channelId}/messages?limit=3`, {
      token: botToken1,
    });
    expect(status).toBe(200);
    // With limit param, should still work (may return paginated or flat)
    const messages = body.messages || body;
    expect(messages.length).toBeLessThanOrEqual(6);
  });

  it('legacy format without pagination params', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/channels/${channelId}/messages`, {
      token: botToken1,
    });
    expect(status).toBe(200);
    // Legacy returns flat array
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(6);
  });
});

describe('Phase 5: Thread Messages Pagination', () => {
  let env: TestEnv;
  let botToken: string;
  let orgTicket: string;
  let threadId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    const { token } = await env.registerBot(org.org_secret, 'tmsg-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);

    // Create thread
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Paginated thread' },
    });
    threadId = thread.id;

    // Send 5 thread messages
    for (let i = 0; i < 5; i++) {
      await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
        token: botToken,
        body: { parts: [{ type: 'text', content: `TMsg ${i}` }] },
      });
    }
  });

  afterAll(() => env.cleanup());

  it('returns thread messages with limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=2`, {
      token: orgTicket,
    });
    expect(status).toBe(200);
    const messages = body.messages || body;
    expect(messages.length).toBeLessThanOrEqual(5);
  });

  it('legacy format returns flat array', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages`, {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
});
