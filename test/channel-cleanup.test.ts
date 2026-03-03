import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Channel Cleanup — PR A
// Verifies: removed endpoints return 404, kept endpoints work,
//           new GET /api/bots/:id/channels endpoint
// ═══════════════════════════════════════════════════════════════

describe('Channel Cleanup — Removed Endpoints', () => {
  let env: TestEnv;
  let botToken: string;
  let orgTicket: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const { token } = await env.registerBot(org.org_secret, 'cleanup-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('POST /api/channels returns 404', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/channels', {
      cookie: orgTicket,
      body: { type: 'direct', members: ['a', 'b'] },
    });
    expect(status).toBe(404);
  });

  it('GET /api/channels returns 404', async () => {
    const { status } = await api(env.baseUrl, 'GET', '/api/channels', {
      token: botToken,
    });
    expect(status).toBe(404);
  });

  it('POST /api/channels/:id/join returns 404', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/channels/fake-id/join', {
      token: botToken,
    });
    expect(status).toBe(404);
  });

  it('DELETE /api/channels/:id returns 404', async () => {
    const { status } = await api(env.baseUrl, 'DELETE', '/api/channels/fake-id', {
      cookie: orgTicket,
    });
    expect(status).toBe(404);
  });

  it('POST /api/channels/:id/messages returns 404', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/channels/fake-id/messages', {
      token: botToken,
      body: { content: 'hello' },
    });
    expect(status).toBe(404);
  });
});

describe('Channel Cleanup — Kept Endpoints', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let channelId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const { token: t1 } = await env.registerBot(org.org_secret, 'keep-bot-1');
    const { token: t2 } = await env.registerBot(org.org_secret, 'keep-bot-2');
    botToken1 = t1;
    botToken2 = t2;

    // Create DM via /api/send
    const { body } = await api(env.baseUrl, 'POST', '/api/send', {
      token: botToken1,
      body: { to: 'keep-bot-2', content: 'hello' },
    });
    channelId = body.channel_id;

    // Send a few more messages
    await api(env.baseUrl, 'POST', '/api/send', {
      token: botToken2,
      body: { to: 'keep-bot-1', content: 'hi back' },
    });
  });

  afterAll(() => env.cleanup());

  it('GET /api/channels/:id returns channel details with members', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/channels/${channelId}`, {
      token: botToken1,
    });
    expect(status).toBe(200);
    expect(body.id).toBe(channelId);
    expect(body.type).toBe('direct');
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m: any) => m.name).sort()).toEqual(['keep-bot-1', 'keep-bot-2']);
  });

  it('GET /api/channels/:id/messages returns messages', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/channels/${channelId}/messages`, {
      token: botToken1,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  it('GET /api/channels/:id rejects non-member', async () => {
    const org2 = await env.createOrg('other-org');
    const { token: otherToken } = await env.registerBot(org2.org_secret, 'outsider');
    const { status } = await api(env.baseUrl, 'GET', `/api/channels/${channelId}`, {
      token: otherToken,
    });
    expect(status).toBe(403);
  });
});

describe('GET /api/bots/:id/channels — New Endpoint', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let bot1Id: string;
  let bot2Id: string;
  let orgTicket: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const { token: t1, bot: b1 } = await env.registerBot(org.org_secret, 'ch-bot-1');
    const { token: t2, bot: b2 } = await env.registerBot(org.org_secret, 'ch-bot-2');
    await env.registerBot(org.org_secret, 'ch-bot-3');
    botToken1 = t1;
    botToken2 = t2;
    bot1Id = b1.bot_id;
    bot2Id = b2.bot_id;
    orgTicket = await env.loginAsOrg(org.org_secret);

    // Create DM between bot1 and bot2
    await api(env.baseUrl, 'POST', '/api/send', {
      token: botToken1,
      body: { to: 'ch-bot-2', content: 'msg1' },
    });

    // Create DM between bot1 and bot3
    await api(env.baseUrl, 'POST', '/api/send', {
      token: botToken1,
      body: { to: 'ch-bot-3', content: 'msg2' },
    });
  });

  afterAll(() => env.cleanup());

  it('returns channels for a bot (own token)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/bots/${bot1Id}/channels`, {
      token: botToken1,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    // Each channel should have members and last_activity_at
    for (const ch of body) {
      expect(ch.type).toBe('direct');
      expect(ch.members).toHaveLength(2);
      expect(ch.last_activity_at).toBeTypeOf('number');
      for (const m of ch.members) {
        expect(m.id).toBeTypeOf('string');
        expect(m.name).toBeTypeOf('string');
        expect(m).toHaveProperty('online');
      }
    }
  });

  it('returns channels sorted by last_activity_at DESC', async () => {
    const { body } = await api(env.baseUrl, 'GET', `/api/bots/${bot1Id}/channels`, {
      token: botToken1,
    });
    expect(body.length).toBe(2);
    expect(body[0].last_activity_at).toBeGreaterThanOrEqual(body[1].last_activity_at);
  });

  it('bot2 only sees its own channels', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/bots/${bot2Id}/channels`, {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.length).toBe(1);
  });

  it('bot cannot query another bot channels', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/bots/${bot2Id}/channels`, {
      token: botToken1,
    });
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('org ticket can query any bot channels', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/bots/${bot1Id}/channels`, {
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.length).toBe(2);
  });

  it('resolves bot by name', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots/ch-bot-1/channels', {
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.length).toBe(2);
  });

  it('returns 404 for unknown bot', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots/nonexistent/channels', {
      cookie: orgTicket,
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('rejects cross-org access (bot not visible)', async () => {
    const org2 = await env.createOrg('other-org');
    const { token: otherToken } = await env.registerBot(org2.org_secret, 'other-bot');
    const { status, body } = await api(env.baseUrl, 'GET', `/api/bots/${bot1Id}/channels`, {
      token: otherToken,
    });
    // Bot from another org is not found (not leaked as 403)
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});
