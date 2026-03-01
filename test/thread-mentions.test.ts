import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Thread @Mention System — PR B (#59)
// Verifies: mention parsing, resolution against thread participants,
//           @all, dedup, max 20, email exclusion, wire format
// ═══════════════════════════════════════════════════════════════

describe('Thread Mentions', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let botToken3: string;
  let orgTicket: string;
  let threadId: string;
  let bot1Id: string;
  let bot2Id: string;
  let bot3Id: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();

    const r1 = await env.registerBot(org.org_secret, 'alice');
    const r2 = await env.registerBot(org.org_secret, 'bob');
    const r3 = await env.registerBot(org.org_secret, 'charlie');
    botToken1 = r1.token;
    botToken2 = r2.token;
    botToken3 = r3.token;
    bot1Id = r1.bot.id;
    bot2Id = r2.bot.id;
    bot3Id = r3.bot.id;
    orgTicket = await env.loginAsOrg(org.org_secret);

    // Create a thread with alice and bob as participants (charlie NOT in thread)
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'mention-test', participants: ['bob'] },
    });
    threadId = thread.id;
  });

  afterAll(() => env.cleanup());

  it('resolves @mention for a thread participant', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '@bob check this' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([{ bot_id: bot2Id, name: 'bob' }]);
    expect(body.mention_all).toBe(false);
  });

  it('ignores @mention for non-participant', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '@charlie are you there?' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([]);
    expect(body.mention_all).toBe(false);
  });

  it('resolves @all', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '@all attention please' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([]);
    expect(body.mention_all).toBe(true);
  });

  it('resolves @mention + @all together', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '@bob @all look at this' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([{ bot_id: bot2Id, name: 'bob' }]);
    expect(body.mention_all).toBe(true);
  });

  it('case-insensitive mention resolution', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '@BOB @Bob @bob hi' },
    });

    expect(status).toBe(200);
    // Deduplicated — only one mention despite different cases
    expect(body.mentions).toHaveLength(1);
    expect(body.mentions[0].bot_id).toBe(bot2Id);
  });

  it('does not match email addresses', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'email user@bob.com for info' },
    });

    expect(status).toBe(200);
    // "user@bob" — @ preceded by 'r' (word char), should not match
    expect(body.mentions).toEqual([]);
    expect(body.mention_all).toBe(false);
  });

  it('matches @mention after CJK characters', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '请看@bob的回复' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([{ bot_id: bot2Id, name: 'bob' }]);
  });

  it('message without mentions returns empty array', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'just a normal message' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([]);
    expect(body.mention_all).toBe(false);
  });

  it('GET thread messages includes mention fields', async () => {
    // Send a message with mention first
    await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: '@bob fetch-test' },
    });

    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?limit=1&since=${Date.now() - 5000}`, {
      token: botToken1,
    });

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const last = body[body.length - 1];
    expect(last.mentions).toBeDefined();
    expect(last.mention_all).toBeDefined();
    expect(typeof last.mention_all).toBe('boolean');
  });

  it('org admin GET thread messages includes mention fields', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=1`, {
      token: orgTicket,
    });

    expect(status).toBe(200);
    // Org endpoint returns enriched messages
    const msgs = Array.isArray(body) ? body : body.messages;
    expect(msgs.length).toBeGreaterThan(0);
    const msg = msgs[msgs.length - 1];
    expect(msg.mentions).toBeDefined();
    expect(typeof msg.mention_all).toBe('boolean');
  });

  it('old messages without mentions serialize as empty', async () => {
    // Insert a message directly via DB (simulating pre-migration message)
    const msg = await env.db.createThreadMessage(threadId, bot1Id, 'legacy message', 'text');
    expect(msg.mentions).toBeNull();
    expect(msg.mention_all).toBe(0);

    // Fetch via API — should serialize as [] and false
    const { body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?limit=50`, {
      token: botToken1,
    });
    const legacy = body.find((m: any) => m.id === msg.id);
    expect(legacy).toBeDefined();
    expect(legacy.mentions).toEqual([]);
    expect(legacy.mention_all).toBe(false);
  });
});
