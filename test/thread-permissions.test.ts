/**
 * Thread Permission Control — E2E Tests (Issue #220)
 *
 * P0 tests: Security boundaries, permission isolation, data leakage prevention
 * P1 tests: Core flow correctness, backward compatibility, settings changes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

describe('Thread Permissions — P0: Visibility & Error Semantics', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let bot1Id: string;
  let bot2Id: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    orgSecret = org.org_secret;
    const r1 = await env.registerBot(org.org_secret, 'perm-bot1');
    const r2 = await env.registerBot(org.org_secret, 'perm-bot2');
    botToken1 = r1.token;
    botToken2 = r2.token;
    bot1Id = r1.bot.id;
    bot2Id = r2.bot.id;
  });

  afterAll(() => env.cleanup());

  it('P0-01: non-participant gets 404 for private thread detail', async () => {
    // Create private thread with bot1 only
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'private-thread', visibility: 'private' },
    });
    expect(thread.visibility).toBe('private');
    expect(thread.join_policy).toBe('invite_only'); // forced

    // bot2 tries to get details — should get 404 (not 403)
    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${thread.id}`, {
      token: botToken2,
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('P0-01: non-participant gets 404 for members thread detail', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'members-thread', visibility: 'members' },
    });
    expect(thread.visibility).toBe('members');

    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${thread.id}`, {
      token: botToken2,
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('P0-01: non-participant gets 404 for private thread join', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'private-no-join', visibility: 'private' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('P0-01: participant CAN see private thread', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'private-visible', visibility: 'private', participants: [bot2Id] },
    });

    const { status, body } = await api(env.baseUrl, 'GET', `/api/threads/${thread.id}`, {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.topic).toBe('private-visible');
  });
});

describe('Thread Permissions — P0: Write Permission', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let bot2Id: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const r1 = await env.registerBot(org.org_secret, 'writer');
    const r2 = await env.registerBot(org.org_secret, 'observer');
    botToken1 = r1.token;
    botToken2 = r2.token;
    bot2Id = r2.bot.id;
  });

  afterAll(() => env.cleanup());

  it('P0-03: observer (no write) cannot send message via HTTP', async () => {
    // Create thread with write restricted to initiator only, include bot2 as participant
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: {
        topic: 'restricted-write',
        participants: [bot2Id],
        permission_policy: { write: ['initiator'] },
      },
    });

    // bot2 is participant but has no write permission
    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/messages`, {
      token: botToken2,
      body: { content: 'should fail' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('WRITE_PERMISSION_DENIED');
  });

  it('P0-03: initiator CAN send message to write-restricted thread', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: {
        topic: 'write-test',
        permission_policy: { write: ['initiator'] },
      },
    });

    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/messages`, {
      token: botToken1,
      body: { content: 'should succeed' },
    });
    expect(status).toBe(200);
  });

  it('P0-03: observer cannot add artifact', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: {
        topic: 'artifact-restrict',
        participants: [bot2Id],
        permission_policy: { write: ['initiator'] },
      },
    });

    const { status } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/artifacts`, {
      token: botToken2,
      body: { artifact_key: 'test', type: 'text', content: 'should fail' },
    });
    expect(status).toBe(403);
  });
});

describe('Thread Permissions — P0: manage Permission', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;
  let bot2Id: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const r1 = await env.registerBot(org.org_secret, 'manager');
    const r2 = await env.registerBot(org.org_secret, 'member');
    botToken1 = r1.token;
    botToken2 = r2.token;
    bot2Id = r2.bot.id;
  });

  afterAll(() => env.cleanup());

  it('P0-06: manage=null defaults to initiator-only', async () => {
    // Create thread without explicit manage policy (null)
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'manage-test', participants: [bot2Id] },
    });

    // Non-initiator tries to change visibility
    const { status } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken2,
      body: { visibility: 'members' },
    });
    expect(status).toBe(403);
  });

  it('P0-06: initiator CAN change settings when manage=null', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'manage-ok' },
    });

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken1,
      body: { visibility: 'members' },
    });
    expect(status).toBe(200);
    expect(body.visibility).toBe('members');
  });

  it('P0-07: private forces invite_only', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'force-invite', visibility: 'private', join_policy: 'open' },
    });
    expect(thread.visibility).toBe('private');
    expect(thread.join_policy).toBe('invite_only'); // forced regardless of input
  });
});

describe('Thread Permissions — P0: Join Policy', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const r1 = await env.registerBot(org.org_secret, 'host');
    const r2 = await env.registerBot(org.org_secret, 'guest');
    botToken1 = r1.token;
    botToken2 = r2.token;
  });

  afterAll(() => env.cleanup());

  it('join_policy=open allows direct join (default)', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'open-join' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(status).toBe(200);
    expect(body.status).toBe('joined');
  });

  it('join_policy=invite_only blocks self-join with 403', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'invite-only', join_policy: 'invite_only' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(status).toBe(403);
    expect(body.code).toBe('INVITE_ONLY');
  });

  it('join_policy=approval returns 202 with pending request', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'approval-required', join_policy: 'approval' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(status).toBe(202);
    expect(body.status).toBe('pending');
    expect(body.request_id).toBeDefined();
  });

  it('duplicate pending request returns 409', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'dup-request', join_policy: 'approval' },
    });

    await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, { token: botToken2 });

    const { status, body } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(status).toBe(409);
    expect(body.code).toBe('ALREADY_REQUESTED');
  });

  it('P0-10: approve join request adds participant', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'approve-test', join_policy: 'approval' },
    });

    const { body: joinRes } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });

    // Approve
    const { status, body } = await api(env.baseUrl, 'POST',
      `/api/threads/${thread.id}/join-requests/${joinRes.request_id}/approve`, {
        token: botToken1,
      });
    expect(status).toBe(200);
    expect(body.status).toBe('approved');

    // Verify bot2 is now a participant
    const { status: detailStatus } = await api(env.baseUrl, 'GET', `/api/threads/${thread.id}`, {
      token: botToken2,
    });
    expect(detailStatus).toBe(200);
  });

  it('P0-10: reject join request', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'reject-test', join_policy: 'approval' },
    });

    const { body: joinRes } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });

    const { status, body } = await api(env.baseUrl, 'POST',
      `/api/threads/${thread.id}/join-requests/${joinRes.request_id}/reject`, {
        token: botToken1,
      });
    expect(status).toBe(200);
    expect(body.status).toBe('rejected');
  });
});

describe('Thread Permissions — P1: Backward Compatibility', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const r1 = await env.registerBot(org.org_secret, 'compat-bot1');
    const r2 = await env.registerBot(org.org_secret, 'compat-bot2');
    botToken1 = r1.token;
    botToken2 = r2.token;
  });

  afterAll(() => env.cleanup());

  it('P1-01: thread created without new fields defaults to public + open', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'legacy-thread' },
    });
    expect(thread.visibility).toBe('public');
    expect(thread.join_policy).toBe('open');
  });

  it('P1-01: default thread allows join and messaging (backward compat)', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'compat-test' },
    });

    // bot2 can join
    const { status: joinStatus } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(joinStatus).toBe(200);

    // bot2 can send message
    const { status: msgStatus } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/messages`, {
      token: botToken2,
      body: { content: 'hello' },
    });
    expect(msgStatus).toBe(200);
  });
});

describe('Thread Permissions — P1: Visibility Switching', () => {
  let env: TestEnv;
  let botToken1: string;
  let botToken2: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const r1 = await env.registerBot(org.org_secret, 'switch-bot1');
    const r2 = await env.registerBot(org.org_secret, 'switch-bot2');
    botToken1 = r1.token;
    botToken2 = r2.token;
  });

  afterAll(() => env.cleanup());

  it('P1-03: changing visibility from public to private', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'switch-visibility' },
    });
    expect(thread.visibility).toBe('public');

    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/threads/${thread.id}`, {
      token: botToken1,
      body: { visibility: 'private' },
    });
    expect(status).toBe(200);
    expect(body.visibility).toBe('private');
    expect(body.join_policy).toBe('invite_only'); // forced
  });

  it('P1-03: non-participant cannot see thread after downgrade', async () => {
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'downgrade-test' },
    });

    // bot2 can see public thread
    const { status: beforeStatus } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/join`, {
      token: botToken2,
    });
    expect(beforeStatus).toBe(200);

    // Create new thread, then downgrade it before bot2 joins
    const { body: thread2 } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'will-downgrade' },
    });

    await api(env.baseUrl, 'PATCH', `/api/threads/${thread2.id}`, {
      token: botToken1,
      body: { visibility: 'private' },
    });

    // bot2 cannot see downgraded thread
    const { status } = await api(env.baseUrl, 'GET', `/api/threads/${thread2.id}`, {
      token: botToken2,
    });
    expect(status).toBe(404);
  });
});

describe('Thread Permissions — P1: Permission Policy Validation', () => {
  let env: TestEnv;
  let botToken1: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg();
    const r1 = await env.registerBot(org.org_secret, 'validator');
    botToken1 = r1.token;
  });

  afterAll(() => env.cleanup());

  it('accepts write and manage in permission_policy', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: {
        topic: 'full-policy',
        permission_policy: {
          write: ['contributor', 'admin'],
          manage: ['initiator'],
          invite: ['*'],
          remove: ['initiator', 'admin'],
          resolve: ['initiator'],
          close: ['initiator'],
        },
      },
    });
    expect(status).toBe(200);
    expect(body.permission_policy).toBeDefined();
  });

  it('rejects invalid permission_policy keys', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: {
        topic: 'bad-policy',
        permission_policy: { execute: ['*'] },
      },
    });
    expect(status).toBe(400);
  });

  it('rejects invalid visibility value', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'bad-vis', visibility: 'secret' },
    });
    expect(status).toBe(400);
  });

  it('rejects invalid join_policy value', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken1,
      body: { topic: 'bad-jp', join_policy: 'always' },
    });
    expect(status).toBe(400);
  });
});
