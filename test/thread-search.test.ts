import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Thread Search by Name (scope=org)
// Verifies: GET /api/threads?q=<term>&scope=org
// - Searches all org threads (not just joined)
// - Returns is_participant flag
// - Pagination, status filter, edge cases
// ═══════════════════════════════════════════════════════════════

describe('Thread Search (scope=org)', () => {
  let env: TestEnv;
  let orgSecret: string;
  let botToken1: string; // creator of threads
  let botToken2: string; // searcher (not joined to some threads)
  let bot2Id: string;
  let threadIdDev: string;
  let threadIdDevTest: string;
  let threadIdDesign: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    orgSecret = org.org_secret;

    const r1 = await env.registerBot(orgSecret, 'creator-bot');
    const r2 = await env.registerBot(orgSecret, 'searcher-bot');
    botToken1 = r1.token;
    botToken2 = r2.token;
    bot2Id = r2.bot.id;

    // Create 3 threads with bot1: "HxA-Dev", "HxA-Dev-Testing", "Design Review"
    const { body: t1 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'HxA-Dev', tags: ['dev'] },
    });
    threadIdDev = t1.id;

    const { body: t2 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'HxA-Dev-Testing', tags: ['dev', 'test'] },
    });
    threadIdDevTest = t2.id;

    const { body: t3 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'Design Review' },
    });
    threadIdDesign = t3.id;

    // Bot2 joins only "HxA-Dev" — NOT "HxA-Dev-Testing" or "Design Review"
    await api(env.baseUrl, 'POST', `/api/threads/${threadIdDev}/join`, {
      token: botToken2,
    });
  });

  afterAll(() => env.cleanup());

  // ── Basic search ──────────────────────────────────────────

  it('finds threads by topic substring (scope=org)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org', {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    const topics = body.items.map((t: any) => t.topic).sort();
    expect(topics).toEqual(['HxA-Dev', 'HxA-Dev-Testing']);
  });

  it('returns is_participant correctly', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org', {
      token: botToken2,
    });
    const dev = body.items.find((t: any) => t.topic === 'HxA-Dev');
    const devTest = body.items.find((t: any) => t.topic === 'HxA-Dev-Testing');
    // bot2 joined HxA-Dev but not HxA-Dev-Testing
    expect(dev.is_participant).toBe(true);
    expect(devTest.is_participant).toBe(false);
  });

  it('returns participant_count', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org', {
      token: botToken2,
    });
    const dev = body.items.find((t: any) => t.topic === 'HxA-Dev');
    // HxA-Dev has bot1 (creator) + bot2 (joined) = 2 participants
    expect(dev.participant_count).toBe(2);
  });

  it('finds threads bot has NOT joined (core use case)', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=Design&scope=org', {
      token: botToken2,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0].topic).toBe('Design Review');
    expect(body.items[0].is_participant).toBe(false);
  });

  // ── Compared to default scope ─────────────────────────────

  it('default scope (no scope param) only returns joined threads', async () => {
    // Bot2 only joined HxA-Dev, so searching without scope=org should not find HxA-Dev-Testing
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&limit=50', {
      token: botToken2,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0].topic).toBe('HxA-Dev');
  });

  // ── Status filter ─────────────────────────────────────────

  it('filters by status', async () => {
    // Close one thread
    await api(env.baseUrl, 'PATCH', `/api/threads/${threadIdDevTest}`, {
      token: botToken1,
      body: { status: 'closed', close_reason: 'manual' },
    });

    // Search active only
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org&status=active', {
      token: botToken2,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0].topic).toBe('HxA-Dev');

    // Search closed only
    const { body: closed } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org&status=closed', {
      token: botToken2,
    });
    expect(closed.items).toHaveLength(1);
    expect(closed.items[0].topic).toBe('HxA-Dev-Testing');

    // Restore for subsequent tests
    await api(env.baseUrl, 'PATCH', `/api/threads/${threadIdDevTest}`, {
      token: botToken1,
      body: { status: 'active' },
    });
  });

  // ── Pagination ────────────────────────────────────────────

  it('respects limit and returns has_more + next_cursor', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org&limit=1', {
      token: botToken2,
    });
    expect(body.items).toHaveLength(1);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeDefined();

    // Fetch next page
    const { body: page2 } = await api(
      env.baseUrl, 'GET',
      `/api/threads?q=HxA-Dev&scope=org&limit=1&cursor=${body.next_cursor}`,
      { token: botToken2 },
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.has_more).toBe(false);

    // Two pages together should cover both threads
    const allTopics = [body.items[0].topic, page2.items[0].topic].sort();
    expect(allTopics).toEqual(['HxA-Dev', 'HxA-Dev-Testing']);
  });

  // ── Validation / edge cases ───────────────────────────────

  it('lists all visible threads when scope=org without q', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/threads?scope=org', {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('rejects q longer than 200 chars', async () => {
    const longQ = 'a'.repeat(201);
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads?q=${longQ}&scope=org`, {
      token: botToken2,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('q too long');
  });

  it('returns empty items for no matches', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/threads?q=nonexistent-xyz&scope=org', {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it('search is case-insensitive (ASCII)', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=hxa-dev&scope=org', {
      token: botToken2,
    });
    // SQLite LIKE is case-insensitive for ASCII by default
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const topics = body.items.map((t: any) => t.topic);
    expect(topics).toContain('HxA-Dev');
  });

  // ── Cross-org isolation ───────────────────────────────────

  it('cannot see threads from another org', async () => {
    // Create a second org with a thread
    const org2 = await env.createOrg('other-org');
    const { token: otherBotToken } = await env.registerBot(org2.org_secret, 'other-bot');
    await api(env.baseUrl, 'POST', '/api/threads', {
      token: otherBotToken,
      body: { topic: 'HxA-Dev-Secret' },
    });

    // Bot2 (in org1) should NOT find org2's thread
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org', {
      token: botToken2,
    });
    const topics = body.items.map((t: any) => t.topic);
    expect(topics).not.toContain('HxA-Dev-Secret');
  });

  // ── Invalid status filter ─────────────────────────────────

  it('rejects invalid status filter', async () => {
    const { status } = await api(env.baseUrl, 'GET', '/api/threads?q=test&scope=org&status=invalid', {
      token: botToken2,
    });
    expect(status).toBe(400);
  });

  // ── Response shape ────────────────────────────────────────

  it('response items have correct shape', async () => {
    const { body } = await api(env.baseUrl, 'GET', '/api/threads?q=HxA-Dev&scope=org&limit=1', {
      token: botToken2,
    });
    const item = body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('topic');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('org_id');
    expect(item).toHaveProperty('participant_count');
    expect(item).toHaveProperty('is_participant');
    expect(item).toHaveProperty('created_at');
    expect(item).toHaveProperty('last_activity_at');
    expect(typeof item.participant_count).toBe('number');
    expect(typeof item.is_participant).toBe('boolean');
  });
});
