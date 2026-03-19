import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Thread Self-Join (#70)
// Verifies: POST /api/threads/:id/join, JOIN_REQUIRED error,
//           idempotent re-join, cross-org isolation, terminal state
// ═══════════════════════════════════════════════════════════════

describe('Thread Self-Join', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let botToken3: string;
  let bot1Id: string;
  let bot2Id: string;
  let bot3Id: string;
  let threadId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();

    const r1 = await env.registerBot(org.org_secret, 'alpha');
    const r2 = await env.registerBot(org.org_secret, 'beta');
    const r3 = await env.registerBot(org.org_secret, 'gamma');
    botToken1 = r1.token;
    botToken2 = r2.token;
    botToken3 = r3.token;
    bot1Id = r1.bot.id;
    bot2Id = r2.bot.id;
    bot3Id = r3.bot.id;

    // Create a thread with only alpha as participant
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'join-test' },
    });
    threadId = thread.id;
  });

  afterAll(() => env.cleanup());

  it('non-participant gets JOIN_REQUIRED error when sending a message', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: 'hello' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('JOIN_REQUIRED');
    expect(body.hint).toContain('/join');
  });

  it('POST /api/threads/:id/join allows same-org bot to join', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/join`, {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.status).toBe('joined');
    expect(body.joined_at).toBeTypeOf('number');
  });

  it('joined bot can now send messages', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: 'I joined!' },
    });
    expect(status).toBe(200);
    expect(body.content).toBe('I joined!');
  });

  it('re-joining is idempotent (already_joined)', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/join`, {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.status).toBe('already_joined');
  });

  it('joined bot appears in participant list', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}`, {
      token: botToken1,
    });
    expect(status).toBe(200);
    const ids = body.participants.map((p: any) => p.bot_id);
    expect(ids).toContain(bot2Id);
  });

  it('cannot join a non-existent thread', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/threads/nonexistent/join', {
      token: botToken3,
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('cannot join a resolved thread', async () => {
    // Create a separate thread and resolve it
    const { body: t } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'resolved-thread' },
    });
    await api(env.baseUrl, 'PATCH', `/api/threads/${t.id}`, {
      token: botToken1,
      body: { status: 'resolved' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${t.id}/join`, {
      token: botToken3,
    });
    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });

  it('cannot join a closed thread', async () => {
    const { body: t } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'closed-thread' },
    });
    await api(env.baseUrl, 'PATCH', `/api/threads/${t.id}`, {
      token: botToken1,
      body: { status: 'closed', close_reason: 'manual' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${t.id}/join`, {
      token: botToken3,
    });
    expect(status).toBe(409);
    expect(body.code).toBe('THREAD_CLOSED');
  });
});

describe('Thread Self-Join — Cross-Org Isolation', () => {
  let env: TestEnv;
  let botTokenOrg1: string;
  let botTokenOrg2: string;
  let threadId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org1 = await env.createOrg();
    const org2 = await env.createOrg();

    const r1 = await env.registerBot(org1.org_secret, 'org1-bot');
    const r2 = await env.registerBot(org2.org_secret, 'org2-bot');
    botTokenOrg1 = r1.token;
    botTokenOrg2 = r2.token;

    // Create thread in org1
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botTokenOrg1,
      body: { topic: 'org1-thread' },
    });
    threadId = thread.id;
  });

  afterAll(() => env.cleanup());

  it('bot from different org cannot join thread', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/join`, {
      token: botTokenOrg2,
    });
    // Returns 404 (not 403) to prevent cross-org thread existence disclosure
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});
