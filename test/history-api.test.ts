/**
 * Tests for PR1: History Browsing API
 * - GET /api/me/workspace aggregate endpoint
 * - GET /api/threads cursor pagination
 * - GET /api/threads/:id/messages cursor-id pagination
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

let env: TestEnv;
let orgSecret: string;
let botA: { bot: any; token: string };
let botB: { bot: any; token: string };
let botC: { bot: any; token: string };

beforeAll(async () => {
  env = await createTestEnv();
  const org = await env.createOrg('history-test-org');
  orgSecret = org.org_secret;

  botA = await env.registerBot(orgSecret, 'Alice');
  botB = await env.registerBot(orgSecret, 'Bob');
  botC = await env.registerBot(orgSecret, 'Charlie');
});

afterAll(async () => {
  await env.cleanup();
});

// ─── Helper: send a DM between two bots ───────────────────
async function sendDM(senderToken: string, recipientId: string, content: string) {
  const { body } = await api(env.baseUrl, 'POST', '/api/send', {
    token: senderToken,
    body: { to: recipientId, content },
  });
  return body;
}

// ─── Helper: create a thread and post messages ────────────
async function createThread(token: string, topic: string, participantIds: string[]) {
  const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
    token,
    body: { topic, participants: participantIds },
  });
  return body;
}

async function postThreadMessage(token: string, threadId: string, content: string) {
  const { body } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
    token,
    body: { content },
  });
  return body;
}

// ─── GET /api/me/workspace ─────────────────────────────────

describe('GET /api/me/workspace', () => {
  it('returns bot info, empty DMs and threads for new bot', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me/workspace', {
      token: botA.token,
    });

    expect(status).toBe(200);
    expect(body.bot.id).toBe(botA.bot.id);
    expect(body.bot.name).toBe('Alice');
    expect(body.dms).toBeDefined();
    expect(body.dms.items).toBeInstanceOf(Array);
    expect(body.dms.has_more).toBe(false);
    expect(body.threads).toBeDefined();
    expect(body.threads.items).toBeInstanceOf(Array);
    expect(body.threads.has_more).toBe(false);
  });

  it('shows DMs with counterpart info and last message preview', async () => {
    // Send a DM from Alice to Bob
    await sendDM(botA.token, botB.bot.id, 'Hello Bob!');

    const { body } = await api(env.baseUrl, 'GET', '/api/me/workspace', {
      token: botA.token,
    });

    expect(body.dms.items.length).toBeGreaterThanOrEqual(1);
    const dm = body.dms.items.find((d: any) => d.counterpart_bot.id === botB.bot.id);
    expect(dm).toBeDefined();
    expect(dm.counterpart_bot.name).toBe('Bob');
    expect(dm.last_message_preview).toBeDefined();
    expect(dm.last_message_preview.content).toBe('Hello Bob!');
    expect(dm.last_message_preview.sender_name).toBe('Alice');
    expect(dm.channel.type).toBe('direct');
  });

  it('shows threads with participant count', async () => {
    const thread = await createThread(botA.token, 'Test Thread', [botB.bot.id]);

    const { body } = await api(env.baseUrl, 'GET', '/api/me/workspace', {
      token: botA.token,
    });

    const found = body.threads.items.find((t: any) => t.id === thread.id);
    expect(found).toBeDefined();
    expect(found.topic).toBe('Test Thread');
    expect(found.participant_count).toBe(2); // Alice + Bob
  });

  it('respects dm_limit and thread_limit params', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/me/workspace?dm_limit=1&thread_limit=1', {
      token: botA.token,
    });

    expect(body.dms.items.length).toBeLessThanOrEqual(1);
    expect(body.threads.items.length).toBeLessThanOrEqual(1);
  });

  it('paginates DMs via dm_cursor', async () => {
    // Send DMs to multiple bots to create multiple channels
    await sendDM(botA.token, botC.bot.id, 'Hello Charlie!');

    // First page
    const { body: page1 } = await api(env.baseUrl, 'GET', '/api/me/workspace?dm_limit=1', {
      token: botA.token,
    });

    expect(page1.dms.items.length).toBe(1);

    if (page1.dms.has_more) {
      // Second page
      const { body: page2 } = await api(env.baseUrl, 'GET', `/api/me/workspace?dm_limit=1&dm_cursor=${page1.dms.next_cursor}`, {
        token: botA.token,
      });

      expect(page2.dms.items.length).toBeGreaterThanOrEqual(1);
      // Should not overlap
      expect(page2.dms.items[0].channel.id).not.toBe(page1.dms.items[0].channel.id);
    }
  });

  it('paginates threads via thread_cursor', async () => {
    // Create more threads
    await createThread(botA.token, 'Thread 2', [botB.bot.id]);
    await createThread(botA.token, 'Thread 3', [botC.bot.id]);

    // First page
    const { body: page1 } = await api(env.baseUrl, 'GET', '/api/me/workspace?thread_limit=1', {
      token: botA.token,
    });

    expect(page1.threads.items.length).toBe(1);

    if (page1.threads.has_more) {
      const { body: page2 } = await api(env.baseUrl, 'GET', `/api/me/workspace?thread_limit=1&thread_cursor=${page1.threads.next_cursor}`, {
        token: botA.token,
      });

      expect(page2.threads.items.length).toBeGreaterThanOrEqual(1);
      expect(page2.threads.items[0].id).not.toBe(page1.threads.items[0].id);
    }
  });
});

// ─── GET /api/threads (cursor pagination) ──────────────────

describe('GET /api/threads cursor pagination', () => {
  it('returns paginated response with cursor param', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/threads?limit=2', {
      token: botA.token,
    });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
    expect(typeof body.has_more).toBe('boolean');
  });

  it('walks all pages without duplicates', async () => {
    const allItems: any[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/threads?limit=1&cursor=${cursor}`
        : '/api/threads?limit=1';
      const { body } = await api(env.baseUrl, 'GET', url, {
        token: botA.token,
      });

      allItems.push(...body.items);

      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    // At least 3 threads created in previous tests
    expect(allItems.length).toBeGreaterThanOrEqual(3);

    // No duplicate IDs
    const ids = allItems.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes participant_count in paginated response', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?limit=10', {
      token: botA.token,
    });

    for (const item of body.items) {
      expect(typeof item.participant_count).toBe('number');
      expect(item.participant_count).toBeGreaterThanOrEqual(2);
    }
  });

  it('filters by status in paginated mode', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?limit=10&status=active', {
      token: botA.token,
    });

    expect(body.items).toBeInstanceOf(Array);
    for (const item of body.items) {
      expect(item.status).toBe('active');
    }
  });

  it('searches by topic (q param)', async () => {
    await createThread(botA.token, 'Unique Search Target XYZ', [botB.bot.id]);

    const { body } = await api(env.baseUrl, 'GET', '/api/threads?limit=10&q=Unique+Search', {
      token: botA.token,
    });

    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0].topic).toContain('Unique Search');
  });

  it('preserves legacy flat array when no pagination params', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads', {
      token: botA.token,
    });

    // Legacy: flat array, no items/has_more wrapper
    expect(Array.isArray(body)).toBe(true);
  });
});

// ─── GET /api/threads/:id/messages (cursor pagination) ─────

describe('GET /api/threads/:id/messages cursor pagination', () => {
  let threadId: string;
  const messageIds: string[] = [];

  beforeAll(async () => {
    // Create a thread with several messages
    const thread = await createThread(botA.token, 'Messages Test Thread', [botB.bot.id]);
    threadId = thread.id;

    for (let i = 0; i < 5; i++) {
      const msg = await postThreadMessage(botA.token, threadId, `Message ${i + 1}`);
      messageIds.push(msg.id);
    }
  });

  it('returns paginated first page with empty cursor param', async () => {
    // cursor= (empty) triggers paginated mode, returns newest messages
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?cursor=&limit=3`, {
      token: botA.token,
    });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
    expect(typeof body.has_more).toBe('boolean');
    expect(body.items.length).toBeLessThanOrEqual(3);
  });

  it('returns cursor-paginated response with has_more and next_cursor', async () => {
    const { body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?cursor=&limit=2`, {
      token: botA.token,
    });

    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeDefined();
  });

  it('walks all messages via cursor without duplicates', async () => {
    const allItems: any[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/threads/${threadId}/messages?limit=2&cursor=${cursor}`
        : `/api/threads/${threadId}/messages?limit=2&cursor=`;
      const { body } = await api(env.baseUrl, 'GET', url, {
        token: botA.token,
      });

      allItems.push(...body.items);

      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    // Should get all 5 messages
    expect(allItems.length).toBe(5);

    // No duplicate IDs
    const ids = allItems.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('preserves legacy timestamp-based response when no cursor', async () => {
    const { body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages`, {
      token: botA.token,
    });

    // Legacy: flat array of messages (reversed to chronological order)
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(5);
  });

  it('returns enriched messages with sender_name in cursor mode', async () => {
    const { body } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}/messages?cursor=&limit=3`, {
      token: botA.token,
    });

    for (const msg of body.items) {
      expect(msg.sender_name).toBeDefined();
      expect(typeof msg.sender_name).toBe('string');
    }
  });
});

// ─── Edge cases ────────────────────────────────────────────

describe('edge cases', () => {
  it('workspace with invalid cursor returns results from start', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me/workspace?dm_cursor=invalid-cursor', {
      token: botA.token,
    });

    expect(status).toBe(200);
    expect(body.dms.items).toBeInstanceOf(Array);
  });

  it('thread cursor with invalid cursor returns results from start', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/threads?limit=10&cursor=not-valid-base64', {
      token: botA.token,
    });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
  });

  it('thread message cursor with nonexistent message id falls back gracefully', async () => {
    // Create a thread for this test
    const thread = await createThread(botA.token, 'Edge Case Thread', [botB.bot.id]);
    await postThreadMessage(botA.token, thread.id, 'Test message');

    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${thread.id}/messages?cursor=nonexistent-id&limit=10`, {
      token: botA.token,
    });

    expect(status).toBe(200);
    expect(body.items).toBeInstanceOf(Array);
  });

  it('workspace DMs only include direct channels', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/me/workspace', {
      token: botA.token,
    });

    for (const dm of body.dms.items) {
      expect(dm.channel.type).toBe('direct');
    }
  });

  it('DM last_message_preview truncates long content', async () => {
    // Send a very long message
    const longMsg = 'A'.repeat(300);
    await sendDM(botA.token, botB.bot.id, longMsg);

    const { body } = await api(env.baseUrl, 'GET', '/api/me/workspace', {
      token: botA.token,
    });

    const dm = body.dms.items.find((d: any) => d.counterpart_bot.id === botB.bot.id);
    expect(dm).toBeDefined();
    expect(dm.last_message_preview.content.length).toBeLessThanOrEqual(201); // 200 + ellipsis char
  });
});
