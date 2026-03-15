import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Implicit Reply Mention — Issue #219
// When a message has reply_to, the parent message's sender is
// automatically added to the mentions array (implicit @mention).
// ═══════════════════════════════════════════════════════════════

describe('Implicit Reply Mention (#219)', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let botToken3: string;
  let threadId: string;
  let bot1Id: string;
  let bot2Id: string;
  let bot3Id: string;

  // Message IDs for reply_to references
  let msgFromBot1: string;
  let msgFromBot2: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();

    const r1 = await env.registerBot(org.org_secret, 'alpha');
    const r2 = await env.registerBot(org.org_secret, 'bravo');
    const r3 = await env.registerBot(org.org_secret, 'charlie');
    botToken1 = r1.token;
    botToken2 = r2.token;
    botToken3 = r3.token;
    bot1Id = r1.bot.id;
    bot2Id = r2.bot.id;
    bot3Id = r3.bot.id;

    // Create a thread with all three bots
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'implicit-mention-test', participants: ['bravo', 'charlie'] },
    });
    threadId = thread.id;

    // Seed messages for reply_to
    const { body: m1 } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'Hello from alpha' },
    });
    msgFromBot1 = m1.id;

    const { body: m2 } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: 'Hello from bravo' },
    });
    msgFromBot2 = m2.id;
  });

  afterAll(() => env.cleanup());

  // ─── Core Behavior ─────────────────────────────────────────

  it('reply_to injects parent sender into mentions', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: 'replying to alpha', reply_to: msgFromBot1 },
    });

    expect(status).toBe(200);
    expect(body.reply_to_id).toBe(msgFromBot1);
    // alpha should be implicitly mentioned
    expect(body.mentions).toEqual(
      expect.arrayContaining([{ bot_id: bot1Id, name: 'alpha' }]),
    );
  });

  it('reply_to + explicit @mention deduplicates', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: '@alpha check this', reply_to: msgFromBot1 },
    });

    expect(status).toBe(200);
    // alpha appears exactly once (not duplicated)
    const alphaRefs = body.mentions.filter((m: any) => m.bot_id === bot1Id);
    expect(alphaRefs).toHaveLength(1);
  });

  it('reply to own message does NOT self-mention', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'follow-up on my own message', reply_to: msgFromBot1 },
    });

    expect(status).toBe(200);
    // Sender replying to own message — no implicit mention (you don't @-mention yourself)
    expect(body.mentions).toEqual([]);
  });

  it('message without reply_to has no implicit mentions', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'no reply, just a message' },
    });

    expect(status).toBe(200);
    expect(body.mentions).toEqual([]);
    expect(body.reply_to_id).toBeNull();
  });

  it('reply_to preserves explicit mentions of other bots', async () => {
    // Reply to bot1's message while also mentioning bot3
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: '@charlie FYI', reply_to: msgFromBot1 },
    });

    expect(status).toBe(200);
    // Should have both: charlie (explicit) + alpha (implicit from reply)
    expect(body.mentions).toEqual(
      expect.arrayContaining([
        { bot_id: bot3Id, name: 'charlie' },
        { bot_id: bot1Id, name: 'alpha' },
      ]),
    );
    expect(body.mentions).toHaveLength(2);
  });

  it('reply_to with @all still adds implicit mention', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken3,
      body: { content: '@all heads up', reply_to: msgFromBot2 },
    });

    expect(status).toBe(200);
    expect(body.mention_all).toBe(true);
    // bravo should be in mentions (implicit from reply)
    expect(body.mentions).toEqual(
      expect.arrayContaining([{ bot_id: bot2Id, name: 'bravo' }]),
    );
  });

  // ─── Wire Format ───────────────────────────────────────────

  it('GET messages returns implicit mentions in wire format', async () => {
    // Send a reply with implicit mention
    const { body: sent } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken3,
      body: { content: 'wire-format-test', reply_to: msgFromBot1 },
    });

    // Fetch via GET
    const { status, body: messages } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?limit=1&since=${Date.now() - 5000}`, {
      token: botToken1,
    });

    expect(status).toBe(200);
    const last = messages[messages.length - 1];
    expect(last.id).toBe(sent.id);
    expect(last.mentions).toEqual(
      expect.arrayContaining([{ bot_id: bot1Id, name: 'alpha' }]),
    );
    expect(last.reply_to_id).toBe(msgFromBot1);
    expect(typeof last.mention_all).toBe('boolean');
  });

  // ─── Edge Cases ────────────────────────────────────────────

  it('reply_to invalid message ID returns 400', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'bad reply', reply_to: 'nonexistent-id' },
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/not found/i);
  });

  it('reply chain: A→B reply, C→(B reply) gets B mentioned', async () => {
    // bot2 replies to bot1's message
    const { body: replyMsg } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken2,
      body: { content: 'bravo replies to alpha', reply_to: msgFromBot1 },
    });

    // bot3 replies to bot2's reply
    const { body: chainReply } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken3,
      body: { content: 'charlie replies to bravo reply', reply_to: replyMsg.id },
    });

    // bot2 (bravo) should be implicitly mentioned (direct parent sender)
    expect(chainReply.mentions).toEqual(
      expect.arrayContaining([{ bot_id: bot2Id, name: 'bravo' }]),
    );
    // bot1 (alpha) should NOT be mentioned (grandparent, only 1 level)
    const alphaRef = chainReply.mentions.find((m: any) => m.bot_id === bot1Id);
    expect(alphaRef).toBeUndefined();
  });

  it('reply to null-sender message injects no mention', async () => {
    // Insert a message with null sender_id directly via DB (simulates system message)
    const sysMsg = await env.db.createThreadMessage(threadId, null as any, 'system notification', 'text');

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
      token: botToken1,
      body: { content: 'replying to system message', reply_to: sysMsg.id },
    });

    expect(status).toBe(200);
    // No implicit mention — parent has no sender
    expect(body.mentions).toEqual([]);
  });
});
