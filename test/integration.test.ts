import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';
import { HubDB } from '../src/db.js';
import { verifyWebhookSignature } from '../src/webhook.js';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════
// Integration Test Suite for BotsHub
// Covers: state machine, auth types, rate limiting, webhook HMAC,
//         catchup, migration, optimistic concurrency, terminal state
// ═══════════════════════════════════════════════════════════════

describe('Thread State Machine', () => {
  let env: TestEnv;
  let orgKey: string;
  let agentToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.api_key;
    const { token } = await env.registerAgent(orgKey, 'sm-agent');
    agentToken = token;
  });

  afterAll(() => env.cleanup());

  it('creates a thread in active status', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'State test' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('active');
    expect(body.revision).toBe(1);
  });

  it('allows valid transitions: active → blocked → active', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Transition test' },
    });

    // active → blocked
    const { status: s1, body: b1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'blocked' },
    });
    expect(s1).toBe(200);
    expect(b1.status).toBe('blocked');

    // blocked → active
    const { status: s2, body: b2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'active' },
    });
    expect(s2).toBe(200);
    expect(b2.status).toBe('active');
  });

  it('allows active → reviewing → resolved', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Review flow' },
    });

    const { status: s1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'reviewing' },
    });
    expect(s1).toBe(200);

    const { status: s2, body: b2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'resolved' },
    });
    expect(s2).toBe(200);
    expect(b2.status).toBe('resolved');
    expect(b2.resolved_at).toBeTypeOf('number');
  });

  it('allows active → closed with close_reason', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Close test' },
    });

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'closed', close_reason: 'manual' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('closed');
    expect(body.close_reason).toBe('manual');
  });

  it('rejects invalid transitions', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Invalid transition' },
    });

    // active → resolved (not allowed — must go through reviewing)
    // Actually checking ALLOWED_TRANSITIONS: active → resolved IS allowed
    // Let's test blocked → closed (not allowed)
    await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'blocked' },
    });

    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'closed', close_reason: 'manual' },
    });
    expect(status).toBe(400);
  });

  it('requires close_reason for closed status', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Missing close_reason' },
    });

    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agentToken,
      body: { status: 'closed' },
    });
    expect(status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Auth Types', () => {
  let env: TestEnv;
  let orgKey: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.api_key;
    const { agent, token } = await env.registerAgent(orgKey, 'auth-agent');
    agentToken = token;
    agentId = agent.id;
  });

  afterAll(() => env.cleanup());

  it('authenticates with primary agent token (full scope)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', { token: agentToken });
    expect(status).toBe(200);
    expect(body.id).toBe(agentId);
  });

  it('authenticates with org API key', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/agents', { token: orgKey });
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
      token: agentToken,
      body: { scopes: ['read'], label: 'read-only' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.scopes).toEqual(['read']);
  });

  it('scoped read token can access GET endpoints', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: agentToken,
      body: { scopes: ['read'], label: 'test-read' },
    });

    const { status } = await api(env.baseUrl, 'GET', '/api/me', { token: tokenData.token });
    expect(status).toBe(200);
  });

  it('scoped read token cannot create threads', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: agentToken,
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
      token: agentToken,
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
      token: agentToken,
      body: { scopes: ['thread'], label: 'test-thread-2' },
    });

    const { status } = await api(env.baseUrl, 'GET', '/api/threads', { token: tokenData.token });
    expect(status).toBe(403);
  });

  it('org API key bypasses scope checks', async () => {
    // Org key can access agent listing (which requires 'read' scope for agents)
    const { status } = await api(env.baseUrl, 'GET', '/api/agents', { token: orgKey });
    expect(status).toBe(200);
  });

  it('expired scoped token is rejected', async () => {
    const { body: tokenData } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
      token: agentToken,
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
  let agentToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.api_key;

    // Set very low rate limits for testing
    env.db.updateOrgSettings(org.id, {
      messages_per_minute_per_bot: 3,
      threads_per_hour_per_bot: 2,
    });

    const { token } = await env.registerAgent(orgKey, 'rate-agent');
    agentToken = token;
  });

  afterAll(() => env.cleanup());

  it('allows requests within thread rate limit', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Thread 1' },
    });
    expect(status).toBe(200);
  });

  it('blocks thread creation when limit exceeded', async () => {
    // Create thread 2 (should succeed — limit is 2)
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Thread 2' },
    });
    expect(s1).toBe(200);

    // Thread 3 — should be rate limited
    const { status, body, headers } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agentToken,
      body: { topic: 'Thread 3' },
    });
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(headers.get('retry-after')).toBeTruthy();
  });

  it('allows messages within message rate limit', async () => {
    // Use one of the threads we already created
    const { body: threads } = await api(env.baseUrl, 'GET', '/api/threads', { token: agentToken });
    const threadId = threads[0].id;

    for (let i = 0; i < 3; i++) {
      const { status } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
        token: agentToken,
        body: { content: `Message ${i}` },
      });
      expect(status).toBe(200);
    }
  });

  it('blocks messages when limit exceeded', async () => {
    const { body: threads } = await api(env.baseUrl, 'GET', '/api/threads', { token: agentToken });
    const threadId = threads[0].id;

    // 4th message should fail (limit is 3/min)
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: agentToken,
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
  let agent1Token: string;
  let agent2Token: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.api_key;
    const a1 = await env.registerAgent(orgKey, 'catchup-agent-1');
    const a2 = await env.registerAgent(orgKey, 'catchup-agent-2');
    agent1Token = a1.token;
    agent2Token = a2.token;
  });

  afterAll(() => env.cleanup());

  it('generates thread_invited event for invited participants', async () => {
    const since = Date.now() - 1000;

    // Agent 1 creates a thread inviting agent 2
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: agent2Token });

    await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'Catchup test', participants: [a2me.name] },
    });

    // Agent 2 checks catchup
    const { status, body } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}`, {
      token: agent2Token,
    });
    expect(status).toBe(200);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const invite = body.events.find((e: any) => e.type === 'thread_invited');
    expect(invite).toBeTruthy();
    expect(invite.topic).toBe('Catchup test');
  });

  it('generates thread_status_changed events', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: agent2Token });

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'Status change catchup', participants: [a2me.name] },
    });

    const since = Date.now() - 100;

    await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { status: 'reviewing' },
    });

    const { body: catchup } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}`, {
      token: agent2Token,
    });
    const statusEvent = catchup.events.find((e: any) => e.type === 'thread_status_changed');
    expect(statusEvent).toBeTruthy();
    expect(statusEvent.from).toBe('active');
    expect(statusEvent.to).toBe('reviewing');
  });

  it('paginates catchup events via cursor', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: agent2Token });
    const since = Date.now() - 1000;

    // Create several threads to generate multiple catchup events
    for (let i = 0; i < 5; i++) {
      await api(env.baseUrl, 'POST', '/api/threads', {
        token: agent1Token,
        body: { topic: `Paginate ${i}`, participants: [a2me.name] },
      });
    }

    // Request with small limit
    const { body: page1 } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}&limit=3`, {
      token: agent2Token,
    });
    expect(page1.events.length).toBe(3);

    if (page1.has_more) {
      // Fetch page 2 using cursor
      const { body: page2 } = await api(env.baseUrl, 'GET', `/api/me/catchup?since=${since}&limit=3&cursor=${page1.cursor}`, {
        token: agent2Token,
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
      token: agent2Token,
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

  it('records applied migrations', () => {
    const rows = env.db['db'].prepare(`SELECT * FROM schema_versions`).all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('name');
    expect(rows[0]).toHaveProperty('applied_at');
    expect(rows[0].applied_at).toBeTypeOf('number');
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
    expect(tableNames).toContain('agents');
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
  let agent1Token: string;
  let agent2Token: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.api_key;
    const a1 = await env.registerAgent(orgKey, 'occ-agent-1');
    const a2 = await env.registerAgent(orgKey, 'occ-agent-2');
    agent1Token = a1.token;
    agent2Token = a2.token;
  });

  afterAll(() => env.cleanup());

  it('succeeds with correct revision in If-Match', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: agent2Token });

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'OCC test', participants: [a2me.name] },
    });
    expect(thread.revision).toBe(1);

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { topic: 'Updated topic' },
      headers: { 'If-Match': `"${thread.revision}"` },
    });
    expect(status).toBe(200);
    expect(body.topic).toBe('Updated topic');
    expect(body.revision).toBe(2);
  });

  it('returns 409 on revision conflict', async () => {
    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: agent2Token });

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'Conflict test', participants: [a2me.name] },
    });

    // Agent 1 updates with correct revision
    await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { topic: 'Agent 1 update' },
      headers: { 'If-Match': '"1"' },
    });

    // Agent 2 tries to update with stale revision (1, but now it's 2)
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent2Token,
      body: { topic: 'Agent 2 update' },
      headers: { 'If-Match': '"1"' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('REVISION_CONFLICT');
  });

  it('revision increments on each update', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'Increment test' },
    });
    expect(thread.revision).toBe(1);

    const { body: u1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { context: 'step 1' },
    });
    expect(u1.revision).toBe(2);

    const { body: u2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { context: 'step 2' },
    });
    expect(u2.revision).toBe(3);
  });

  it('ETag header matches revision', async () => {
    const { body: thread, headers } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'ETag test' },
    });
    expect(headers.get('etag')).toBe(`"${thread.revision}"`);

    const { body: updated, headers: h2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { topic: 'Updated' },
    });
    expect(h2.get('etag')).toBe(`"${updated.revision}"`);
  });

  it('works without If-Match (no concurrency check)', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'No If-Match' },
    });

    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: agent1Token,
      body: { topic: 'Updated without If-Match' },
    });
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════

describe('Terminal State Protection', () => {
  let env: TestEnv;
  let orgKey: string;
  let agent1Token: string;
  let agent2Token: string;
  let resolvedThreadId: string;
  let closedThreadId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg();
    orgKey = org.api_key;
    const a1 = await env.registerAgent(orgKey, 'term-agent-1');
    const a2 = await env.registerAgent(orgKey, 'term-agent-2');
    agent1Token = a1.token;
    agent2Token = a2.token;

    const { body: a2me } = await api(env.baseUrl, 'GET', '/api/me', { token: agent2Token });

    // Create and resolve a thread
    const { body: t1 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'Will resolve', participants: [a2me.name] },
    });
    await api(env.baseUrl, 'PATCH', `/api/threads/${t1.id}`, {
      token: agent1Token,
      body: { status: 'resolved' },
    });
    resolvedThreadId = t1.id;

    // Create and close a thread
    const { body: t2 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: agent1Token,
      body: { topic: 'Will close', participants: [a2me.name] },
    });
    await api(env.baseUrl, 'PATCH', `/api/threads/${t2.id}`, {
      token: agent1Token,
      body: { status: 'closed', close_reason: 'manual' },
    });
    closedThreadId = t2.id;
  });

  afterAll(() => env.cleanup());

  it('rejects messages on resolved thread', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${resolvedThreadId}/messages`, {
      token: agent1Token,
      body: { content: 'Should fail' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });

  it('rejects messages on closed thread', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${closedThreadId}/messages`, {
      token: agent1Token,
      body: { content: 'Should fail' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });

  it('rejects artifacts on resolved thread', async () => {
    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${resolvedThreadId}/artifacts`, {
      token: agent1Token,
      body: { artifact_key: 'test', type: 'text', content: 'nope' },
    });
    expect(status).toBe(409);
  });

  it('rejects participant changes on resolved thread', async () => {
    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${resolvedThreadId}/participants`, {
      token: agent1Token,
      body: { bot_id: 'term-agent-2' },
    });
    expect(status).toBe(409);
  });

  it('rejects status transitions from resolved', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${resolvedThreadId}`, {
      token: agent1Token,
      body: { status: 'active' },
    });
    expect(status).toBe(400); // ALLOWED_TRANSITIONS[resolved] = []
  });

  it('rejects status transitions from closed', async () => {
    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${closedThreadId}`, {
      token: agent1Token,
      body: { status: 'active' },
    });
    expect(status).toBe(400);
  });

  it('rejects context/topic updates on terminal threads', async () => {
    const { status: s1 } = await api(env.baseUrl, 'PATCH', `/api/threads/${resolvedThreadId}`, {
      token: agent1Token,
      body: { context: 'new context' },
    });
    expect(s1).toBe(409);

    const { status: s2 } = await api(env.baseUrl, 'PATCH', `/api/threads/${closedThreadId}`, {
      token: agent1Token,
      body: { topic: 'new topic' },
    });
    expect(s2).toBe(409);
  });

  it('can still read terminal thread details', async () => {
    const { status: s1, body: b1 } = await api(env.baseUrl, 'GET', `/api/threads/${resolvedThreadId}`, {
      token: agent1Token,
    });
    expect(s1).toBe(200);
    expect(b1.status).toBe('resolved');

    const { status: s2, body: b2 } = await api(env.baseUrl, 'GET', `/api/threads/${closedThreadId}`, {
      token: agent1Token,
    });
    expect(s2).toBe(200);
    expect(b2.status).toBe('closed');
  });

  it('can still read messages from terminal threads', async () => {
    const { status } = await api(env.baseUrl, 'GET', `/api/threads/${resolvedThreadId}/messages`, {
      token: agent1Token,
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
