import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

describe('Thread participant removal', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('org_admin session can remove a bot from a thread without removing it from the org', async () => {
    const org = await env.createOrg('remove-org-admin');
    const creator = await env.registerBot(org.org_secret, 'creator');
    const member = await env.registerBot(org.org_secret, 'member');
    const adminCookie = await env.loginAsOrg(org.org_secret);

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: creator.token,
      body: { topic: 'admin-remove', participants: [member.bot.bot_id] },
    });

    const removeRes = await api(env.baseUrl, 'DELETE', `/api/org/threads/${thread.id}/participants/${member.bot.bot_id}`, {
      cookie: adminCookie,
    });
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.ok).toBe(true);

    const threadRes = await api(env.baseUrl, 'GET', `/api/org/threads/${thread.id}`, {
      cookie: adminCookie,
    });
    expect(threadRes.status).toBe(200);
    expect(threadRes.body.participants.some((p: { bot_id: string }) => p.bot_id === member.bot.bot_id)).toBe(false);

    const botRes = await api(env.baseUrl, 'GET', `/api/bots/${member.bot.bot_id}`, {
      cookie: adminCookie,
    });
    expect(botRes.status).toBe(200);
    expect(botRes.body.id).toBe(member.bot.bot_id);
  });

  it('thread initiator can remove another participant via bot API', async () => {
    const org = await env.createOrg('remove-initiator');
    const creator = await env.registerBot(org.org_secret, 'owner');
    const member = await env.registerBot(org.org_secret, 'guest');

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: creator.token,
      body: { topic: 'initiator-remove', participants: [member.bot.bot_id] },
    });

    const removeRes = await api(env.baseUrl, 'DELETE', `/api/threads/${thread.id}/participants/${member.bot.bot_id}`, {
      token: creator.token,
    });
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.ok).toBe(true);
  });

  it('non-initiator is denied when remove permission is initiator-only', async () => {
    const org = await env.createOrg('remove-policy');
    const creator = await env.registerBot(org.org_secret, 'lead');
    const member = await env.registerBot(org.org_secret, 'worker');
    const target = await env.registerBot(org.org_secret, 'observer');

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: creator.token,
      body: {
        topic: 'initiator-only-remove',
        participants: [member.bot.bot_id, target.bot.bot_id],
        permission_policy: { remove: ['initiator'] },
      },
    });

    const removeRes = await api(env.baseUrl, 'DELETE', `/api/threads/${thread.id}/participants/${target.bot.bot_id}`, {
      token: member.token,
    });
    expect(removeRes.status).toBe(403);
    expect(removeRes.body.code).toBe('FORBIDDEN');
  });

  it('org_admin cannot remove the last participant from a thread', async () => {
    const org = await env.createOrg('remove-last');
    const creator = await env.registerBot(org.org_secret, 'solo');
    const adminCookie = await env.loginAsOrg(org.org_secret);

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: creator.token,
      body: { topic: 'last-participant' },
    });

    const removeRes = await api(env.baseUrl, 'DELETE', `/api/org/threads/${thread.id}/participants/${creator.bot.bot_id}`, {
      cookie: adminCookie,
    });
    expect(removeRes.status).toBe(400);
    expect(removeRes.body.code).toBe('VALIDATION_ERROR');
  });
});
