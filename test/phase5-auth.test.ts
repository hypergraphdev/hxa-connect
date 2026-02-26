import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';
import { HubDB } from '../src/db.js';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════
// Phase 5-7 Integration Tests
// Covers: login-to-register flow, pagination, secret rotation,
//         ticket invalidation, role management, X-Org-Id validation
// ═══════════════════════════════════════════════════════════════

// ─── 1. Login-to-Register Full Auth Flow ─────────────────────

describe('Login-to-Register Auth Flow', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('auth-flow-org');
    orgId = org.id;
    orgSecret = org.org_secret;
  });

  afterAll(() => env.cleanup());

  it('Step 1: POST /api/auth/login with valid org_secret returns a ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTypeOf('string');
    expect(body.expires_at).toBeTypeOf('number');
    expect(body.expires_at).toBeGreaterThan(Date.now());
    expect(body.reusable).toBe(false);
    expect(body.org).toEqual({ id: orgId, name: 'auth-flow-org' });
  });

  it('Step 2: POST /api/auth/register with ticket registers bot as member', async () => {
    // Login to get a ticket
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const ticket = loginBody.ticket;

    // Register first bot — all bots default to member
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket, name: 'alpha-bot', bio: 'first bot' },
    });
    expect(status).toBe(200);
    expect(body.bot_id).toBeTypeOf('string');
    expect(body.token).toBeTypeOf('string');
    expect(body.name).toBe('alpha-bot');
    expect(body.auth_role).toBe('member');
    expect(body.bio).toBe('first bot');
  });

  it('Step 3: subsequent registered bots are also members', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'beta-bot' },
    });
    expect(status).toBe(200);
    expect(body.auth_role).toBe('member');
  });

  it('Step 4: bot token authenticates API calls (GET /api/me)', async () => {
    // Get a token via login+register
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'gamma-bot' },
    });

    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: regBody.token,
    });
    expect(status).toBe(200);
    expect(body.name).toBe('gamma-bot');
    expect(body.org_id).toBe(orgId);
  });

  it('Step 5: bot can send a message via thread', async () => {
    // Login + register
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'delta-bot' },
    });

    // Create a thread
    const { status: tStatus, body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: regBody.token,
      body: { topic: 'Test thread via new auth' },
    });
    expect(tStatus).toBe(200);
    expect(thread.topic).toBe('Test thread via new auth');

    // Post a message to the thread
    const { status: mStatus, body: msg } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/messages`, {
      token: regBody.token,
      body: { content: 'Hello from new auth flow' },
    });
    expect(mStatus).toBe(200);
    expect(msg.content).toBe('Hello from new auth flow');
  });

  it('rejects login with wrong org_secret', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: 'wrong-secret' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_SECRET');
  });

  it('rejects login with nonexistent org_id', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: 'nonexistent-org-id', org_secret: orgSecret },
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('rejects login with missing org_id', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_secret: orgSecret },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects login with missing org_secret', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects register with invalid ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: 'invalid-ticket-id', name: 'hacker-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('rejects register with missing ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, name: 'hacker-bot' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects register when ticket belongs to different org', async () => {
    // Create a second org
    const org2 = env.createOrg('other-org');
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: org2.id, org_secret: org2.org_secret },
    });

    // Try to register in the first org using the second org's ticket
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'cross-org-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('one-time ticket cannot be reused', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, reusable: false },
    });

    // First registration consumes the ticket
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'single-use-1' },
    });
    expect(s1).toBe(200);

    // Second registration fails — ticket consumed
    const { status: s2, body: b2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'single-use-2' },
    });
    expect(s2).toBe(401);
    expect(b2.code).toBe('TICKET_CONSUMED');
  });

  it('reusable ticket can be used multiple times', async () => {
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, reusable: true },
    });

    // First registration
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'reuse-1' },
    });
    expect(s1).toBe(200);

    // Second registration with same ticket
    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'reuse-2' },
    });
    expect(s2).toBe(200);
  });
});

// ─── 2. X-Org-Id Header Validation ──────────────────────────

describe('X-Org-Id Header Validation', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('orgid-test');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Register a bot via the new auth flow
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'orgid-bot' },
    });
    botToken = regBody.token;
  });

  afterAll(() => env.cleanup());

  it('succeeds when X-Org-Id matches bot org', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
      headers: { 'X-Org-Id': orgId },
    });
    expect(status).toBe(200);
    expect(body.name).toBe('orgid-bot');
  });

  it('rejects when X-Org-Id does not match bot org', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
      headers: { 'X-Org-Id': 'wrong-org-id' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
  });

  it('succeeds when X-Org-Id is absent (backward compat)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(body.name).toBe('orgid-bot');
  });
});

// ─── 3. Secret Rotation + Ticket Invalidation ───────────────

describe('Secret Rotation and Ticket Invalidation', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let adminToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('rotation-org');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Register bot and promote to admin
    const { bot, token } = await env.registerBot(orgSecret, 'rotation-admin');
    await env.promoteBot(orgSecret, bot.bot_id);
    adminToken = token;
  });

  afterAll(() => env.cleanup());

  it('login works with initial secret', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(200);
  });

  it('rotate-secret returns a new secret', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });
    expect(status).toBe(200);
    expect(body.org_secret).toBeTypeOf('string');
    expect(body.org_secret).not.toBe(orgSecret);
  });

  it('old secret no longer works after rotation', async () => {
    // Rotate
    const { body: rotateBody } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });
    const newSecret = rotateBody.org_secret;

    // Old secret fails
    const { status: oldStatus, body: oldBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(oldStatus).toBe(401);
    expect(oldBody.code).toBe('INVALID_SECRET');

    // New secret works
    const { status: newStatus, body: newBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: newSecret },
    });
    expect(newStatus).toBe(200);
    expect(newBody.ticket).toBeTypeOf('string');

    // Update for subsequent tests
    orgSecret = newSecret;
  });

  it('outstanding tickets are invalidated on rotation', async () => {
    // Login to get a ticket
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const preRotationTicket = loginBody.ticket;

    // Rotate the secret
    const { body: rotateBody } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });
    orgSecret = rotateBody.org_secret;

    // Pre-rotation ticket should be invalidated
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: preRotationTicket, name: 'orphan-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');

    // Login with new secret and register works
    const { body: newLogin } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const { status: regStatus, body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: newLogin.ticket, name: 'post-rotation-bot' },
    });
    expect(regStatus).toBe(200);
    expect(regBody.name).toBe('post-rotation-bot');
  });

  it('non-admin bot cannot rotate secret', async () => {
    // Register a member
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const { body: memberBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'member-no-rotate' },
    });
    // member-no-rotate is a member (not first bot)

    // Try to rotate
    const { status, body } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: memberBody.token,
    });
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });
});

// ─── 4. Role Management ─────────────────────────────────────

describe('Role Management', () => {
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

    // Register bots (both default to member)
    const { bot: adminBot, token: aToken } = await env.registerBot(orgSecret, 'role-admin');
    adminToken = aToken;
    adminId = adminBot.bot_id;

    const { bot: memberBot, token: mToken } = await env.registerBot(orgSecret, 'role-member');
    memberToken = mToken;
    memberId = memberBot.bot_id;

    // Promote admin bot via org admin
    await env.promoteBot(orgSecret, adminId);
  });

  afterAll(() => env.cleanup());

  it('bots default to member, org admin promotes via API', async () => {
    // admin-bot was promoted by org admin in beforeAll
    const { body: adminMe } = await api(env.baseUrl, 'GET', '/api/me', {
      token: adminToken,
    });
    expect(adminMe.auth_role).toBe('admin');

    const { body: memberMe } = await api(env.baseUrl, 'GET', '/api/me', {
      token: memberToken,
    });
    expect(memberMe.auth_role).toBe('member');
  });

  it('admin can promote member to admin', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'admin' },
    });
    expect(status).toBe(200);
    expect(body.auth_role).toBe('admin');
    expect(body.bot_id).toBe(memberId);

    // Verify via GET /api/me
    const { body: memberMe } = await api(env.baseUrl, 'GET', '/api/me', {
      token: memberToken,
    });
    expect(memberMe.auth_role).toBe('admin');
  });

  it('admin can demote another admin to member', async () => {
    // member was promoted to admin above; demote back
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'member' },
    });
    expect(status).toBe(200);
    expect(body.auth_role).toBe('member');
  });

  it('admin cannot demote self (lockout prevention)', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${adminId}/role`, {
      token: adminToken,
      body: { auth_role: 'member' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('SELF_DEMOTION');
  });

  it('member cannot change roles', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${adminId}/role`, {
      token: memberToken,
      body: { auth_role: 'member' },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('rejects invalid auth_role values', async () => {
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${memberId}/role`, {
      token: adminToken,
      body: { auth_role: 'superadmin' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects role change for bot in different org', async () => {
    // Create another org + bot
    const org2 = env.createOrg('role-org-2');
    const { body: login2 } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: org2.id, org_secret: org2.org_secret },
    });
    const { body: otherAgent } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: org2.id, ticket: login2.ticket, name: 'other-org-bot' },
    });

    // Try to change cross-org bot role
    const { status, body } = await api(env.baseUrl, 'PATCH', `/api/org/bots/${otherAgent.bot_id}/role`, {
      token: adminToken,
      body: { auth_role: 'admin' },
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});

// ─── 5. Paginated Bots Endpoint ────────────────────────────

describe('Paginated Bots (GET /api/bots)', () => {
  let env: TestEnv;
  let orgTicket: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('pag-bots-org');

    // Register 5 bots
    for (let i = 1; i <= 5; i++) {
      await env.registerBot(org.org_secret, `bot-${String(i).padStart(2, '0')}`);
    }
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns unpaginated array when no cursor/limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
  });

  it('returns paginated response with limit param', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots?limit=2', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items).toBeDefined();
    expect(body.items.length).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTypeOf('string');
  });

  it('walks all pages via cursor', async () => {
    const allItems: any[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/bots?limit=2&cursor=${cursor}`
        : '/api/bots?limit=2';
      const { body } = await api(env.baseUrl, 'GET', url, {
        token: orgTicket,
      });

      allItems.push(...body.items);

      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    expect(allItems.length).toBe(5);

    // Verify no duplicates
    const ids = allItems.map((a: any) => a.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('returns empty result for large cursor past end', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots?limit=10&cursor=zzzzzzzz', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('clamps limit to maximum of 200', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots?limit=999', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    // With only 5 bots and limit clamped to 200, all should be returned
    expect(body.items.length).toBe(5);
    expect(body.has_more).toBe(false);
  });
});

// ─── 6. Paginated Org Threads Endpoint ───────────────────────

describe('Paginated Org Threads (GET /api/org/threads)', () => {
  let env: TestEnv;
  let orgTicket: string;
  let botToken: string;
  const threadIds: string[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('pag-threads-org');

    // Register a bot
    const { token } = await env.registerBot(org.org_secret, 'thread-maker');
    botToken = token;

    // Create 7 threads
    for (let i = 1; i <= 7; i++) {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: botToken,
        body: { topic: `Thread ${i}` },
      });
      threadIds.push(body.id);
    }

    // Close one thread to test status filter
    await api(env.baseUrl, 'PATCH', `/api/threads/${threadIds[0]}`, {
      token: botToken,
      body: { status: 'closed', close_reason: 'manual' },
    });

    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns paginated response with limit param', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?limit=3', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items).toBeDefined();
    expect(body.items.length).toBe(3);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTypeOf('string');
  });

  it('walks all pages via cursor', async () => {
    const allItems: any[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/org/threads?limit=3&cursor=${cursor}`
        : '/api/org/threads?limit=3';
      const { body } = await api(env.baseUrl, 'GET', url, {
        token: orgTicket,
      });

      allItems.push(...body.items);

      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    expect(allItems.length).toBe(7);
    // No duplicates
    const ids = allItems.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(7);
  });

  it('filters by status', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?status=closed&limit=50', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(1);
    expect(body.items[0].status).toBe('closed');
    expect(body.has_more).toBe(false);
  });

  it('returns empty result when no threads match filter', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?status=resolved&limit=50', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('returns empty for cursor past end', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?limit=10&cursor=zzzzzzzz', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('clamps limit over 200', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?limit=500', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    // All 7 threads fit under clamped limit of 200
    expect(body.items.length).toBe(7);
    expect(body.has_more).toBe(false);
  });
});

// ─── 7. Paginated Artifacts Endpoint ─────────────────────────

describe('Paginated Artifacts (GET /api/org/threads/:id/artifacts)', () => {
  let env: TestEnv;
  let orgTicket: string;
  let botToken: string;
  let threadId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('pag-artifacts-org');

    // Register bot
    const { token } = await env.registerBot(org.org_secret, 'artifact-maker');
    botToken = token;

    // Create a thread
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Artifact pagination test' },
    });
    threadId = thread.id;

    // Create 5 artifacts with distinct keys (POST with artifact_key in body)
    for (let i = 1; i <= 5; i++) {
      await api(env.baseUrl, 'POST', `/api/threads/${threadId}/artifacts`, {
        token: botToken,
        body: { artifact_key: `artifact-${String(i).padStart(2, '0')}`, type: 'text', content: `Content ${i}` },
      });
    }

    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns unpaginated array when no cursor/limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/artifacts`, {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
  });

  it('returns paginated response with limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/artifacts?limit=2`, {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTypeOf('string');
  });

  it('walks all pages via cursor', async () => {
    const allItems: any[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/org/threads/${threadId}/artifacts?limit=2&cursor=${cursor}`
        : `/api/org/threads/${threadId}/artifacts?limit=2`;
      const { body } = await api(env.baseUrl, 'GET', url, {
        token: orgTicket,
      });

      allItems.push(...body.items);

      if (!body.has_more) break;
      cursor = body.next_cursor;
    }

    expect(allItems.length).toBe(5);
    const keys = allItems.map((a: any) => a.artifact_key);
    expect(new Set(keys).size).toBe(5);
  });
});

// ─── 8. Paginated Thread Messages (cursor-based) ────────────

describe('Paginated Thread Messages (GET /api/org/threads/:id/messages)', () => {
  let env: TestEnv;
  let orgTicket: string;
  let botToken: string;
  let threadId: string;
  const messageIds: string[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('pag-msgs-org');

    const { token } = await env.registerBot(org.org_secret, 'msg-maker');
    botToken = token;

    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: botToken,
      body: { topic: 'Message pagination test' },
    });
    threadId = thread.id;

    // Post 6 messages
    for (let i = 1; i <= 6; i++) {
      const { body: msg } = await api(env.baseUrl, 'POST', `/api/threads/${threadId}/messages`, {
        token: botToken,
        body: { content: `Message ${i}` },
      });
      messageIds.push(msg.id);
    }

    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns flat array without before param (backward compat)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=3`, {
      token: orgTicket,
    });
    expect(status).toBe(200);
    // Without before=id, returns legacy flat array (backward compat)
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
  });

  it('paginates with before=message_id (cursor)', async () => {
    // Get newest message ID first (flat array, newest first)
    const { body: initial } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=1`, {
      token: orgTicket,
    });
    const newestId = initial[0].id;

    // Now use cursor-based pagination starting after the newest
    const { body: page1 } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=3&before=${newestId}`, {
      token: orgTicket,
    });
    expect(page1.messages).toBeDefined();
    expect(page1.messages.length).toBe(3);
    expect(page1.has_more).toBe(true);

    // Use the oldest message from page 1 as cursor
    const lastId = page1.messages[page1.messages.length - 1].id;

    const { body: page2 } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=3&before=${lastId}`, {
      token: orgTicket,
    });
    expect(page2.messages.length).toBe(2); // 6 total - 1 newest - 3 page1 = 2 remaining
    expect(page2.has_more).toBe(false);

    // No overlap between pages
    const page1Ids = new Set(page1.messages.map((m: any) => m.id));
    for (const msg of page2.messages) {
      expect(page1Ids.has(msg.id)).toBe(false);
    }
  });

  it('returns all 6 messages across pages with no duplicates', async () => {
    // Start with flat array (newest first)
    const { body: initial } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=2`, {
      token: orgTicket,
    });
    const allMsgs: any[] = [...initial];
    // Legacy response is oldest-first; use oldest message as cursor to avoid overlap
    let before = initial[0].id;

    for (let page = 0; page < 10; page++) {
      const { body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=2&before=${before}`, {
        token: orgTicket,
      });

      allMsgs.push(...body.messages);

      if (!body.has_more) break;
      before = body.messages[body.messages.length - 1].id;
    }

    expect(allMsgs.length).toBe(6);
    const ids = allMsgs.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(6);
  });
});

// ─── 9. Org Lifecycle (Suspended Org Blocks Login) ───────────

describe('Org Lifecycle and Auth', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: 'super-secret' });
    const { body: orgBody } = await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'super-secret',
      body: { name: 'lifecycle-org' },
    });
    orgId = orgBody.id;
    orgSecret = orgBody.org_secret;
  });

  afterAll(() => env.cleanup());

  it('login works on active org', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(200);
  });

  it('login is blocked on suspended org', async () => {
    // Suspend org
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      token: 'super-secret',
      body: { status: 'suspended' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_SUSPENDED');

    // Reactivate
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      token: 'super-secret',
      body: { status: 'active' },
    });
  });

  it('tickets from pre-suspend are invalidated', async () => {
    // Login to get a ticket
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const preTicket = loginBody.ticket;

    // Suspend (invalidates tickets)
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      token: 'super-secret',
      body: { status: 'suspended' },
    });

    // Reactivate
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      token: 'super-secret',
      body: { status: 'active' },
    });

    // Pre-suspend ticket should be invalidated
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: preTicket, name: 'stale-ticket-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('bot token is blocked when org is suspended', async () => {
    // Register a bot while active
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'suspended-test-bot' },
    });

    // Verify it works
    const { status: okStatus } = await api(env.baseUrl, 'GET', '/api/me', {
      token: regBody.token,
    });
    expect(okStatus).toBe(200);

    // Suspend
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      token: 'super-secret',
      body: { status: 'suspended' },
    });

    // Bot API call blocked
    const { status: suspStatus, body: suspBody } = await api(env.baseUrl, 'GET', '/api/me', {
      token: regBody.token,
    });
    expect(suspStatus).toBe(403);
    expect(suspBody.code).toBe('ORG_SUSPENDED');

    // Reactivate for cleanup
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      token: 'super-secret',
      body: { status: 'active' },
    });
  });
});

// ─── 10. Super Admin Org Creation ────────────────────────────

describe('Super Admin Org Management', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: 'admin-key' });
  });

  afterAll(() => env.cleanup());

  it('creates org via super admin', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'admin-key',
      body: { name: 'admin-created-org' },
    });
    expect(status).toBe(200);
    expect(body.id).toBeTypeOf('string');
    expect(body.org_secret).toBeTypeOf('string');
    expect(body.name).toBe('admin-created-org');
  });

  it('rejects org creation without admin secret', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/orgs', {
      body: { name: 'unauthorized-org' },
    });
    expect(status).toBe(401);
  });

  it('rejects org creation with wrong admin secret', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'wrong-key',
      body: { name: 'unauthorized-org' },
    });
    expect(status).toBe(401);
  });

  it('lists orgs via super admin (without exposing keys)', async () => {
    // Create a couple of orgs
    await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'admin-key',
      body: { name: 'org-a' },
    });
    await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'admin-key',
      body: { name: 'org-b' },
    });

    const { status, body } = await api(env.baseUrl, 'GET', '/api/orgs', {
      token: 'admin-key',
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);

    // Verify keys are NOT exposed in list response
    for (const org of body) {
      expect(org.org_secret).toBeUndefined();
      expect(org.org_secret).toBeUndefined();
    }
  });

  it('full lifecycle: create org, login, register, use API', async () => {
    // Step 1: Super admin creates org
    const { body: orgBody } = await api(env.baseUrl, 'POST', '/api/orgs', {
      token: 'admin-key',
      body: { name: 'full-lifecycle-org' },
    });
    const orgId = orgBody.id;
    const orgSecret = orgBody.org_secret;

    // Step 2: Login with org_secret
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret },
    });
    expect(loginBody.ticket).toBeTypeOf('string');

    // Step 3: Register bot
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'lifecycle-bot' },
    });
    expect(regBody.token).toBeTypeOf('string');
    expect(regBody.auth_role).toBe('member'); // all bots default to member

    // Step 4: Use bot token
    const { status, body: meBody } = await api(env.baseUrl, 'GET', '/api/me', {
      token: regBody.token,
    });
    expect(status).toBe(200);
    expect(meBody.name).toBe('lifecycle-bot');

    // Step 5: Create thread
    const { body: thread } = await api(env.baseUrl, 'POST', '/api/threads', {
      token: regBody.token,
      body: { topic: 'Lifecycle thread' },
    });
    expect(thread.id).toBeTypeOf('string');
    expect(thread.org_id).toBe(orgId);

    // Step 6: Send message
    const { body: msg } = await api(env.baseUrl, 'POST', `/api/threads/${thread.id}/messages`, {
      token: regBody.token,
      body: { content: 'Full lifecycle test' },
    });
    expect(msg.content).toBe('Full lifecycle test');
  });
});

// ─── 11. Expired Ticket ──────────────────────────────────────

describe('Ticket Expiration', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('expiry-org');
    orgId = org.id;
    orgSecret = org.org_secret;
  });

  afterAll(() => env.cleanup());

  it('ticket with very short TTL expires', async () => {
    // Login with expires_in=1 (1 second)
    const { body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, expires_in: 1 },
    });

    // Wait for ticket to expire
    await new Promise(resolve => setTimeout(resolve, 1500));

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: loginBody.ticket, name: 'expired-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('TICKET_EXPIRED');
  });

  it('custom expires_in is respected', async () => {
    const { body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgId, org_secret: orgSecret, expires_in: 3600 },
    });
    // Ticket should expire in ~3600s from now
    const expectedExpiry = Date.now() + 3600 * 1000;
    // Allow 5s tolerance for test execution time
    expect(body.expires_at).toBeGreaterThan(expectedExpiry - 5000);
    expect(body.expires_at).toBeLessThan(expectedExpiry + 5000);
  });
});

// ─── 12. Mixed Auth Types ────────────────────────────────────

describe('Mixed Auth Types', () => {
  let env: TestEnv;
  let orgId: string;
  let orgTicket: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('mixed-auth-org');
    orgId = org.id;

    const { token } = await env.registerBot(org.org_secret, 'mixed-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('org ticket works as Bearer for org-level endpoints', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.id).toBe(orgId);
    expect(body.name).toBe('mixed-auth-org');
  });

  it('bot token works for bot-level endpoints', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(body.name).toBe('mixed-bot');
  });

  it('bot token can access GET /api/bots (returns flat array for bots)', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('invalid token is rejected', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: 'completely-invalid-token',
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('no token is rejected', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {});
    // authMiddleware returns 401 when no token provided
    expect(status).toBe(401);
    expect(body.code).toBe('AUTH_REQUIRED');
  });
});

// ─── 13. WS Ticket Exchange ─────────────────────────────────

describe('WS Ticket Exchange (POST /api/ws-ticket)', () => {
  let env: TestEnv;
  let orgTicket: string;
  let botToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = env.createOrg('ws-ticket-org');

    const { token } = await env.registerBot(org.org_secret, 'ws-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('bot can exchange token for ws-ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/ws-ticket', {
      token: botToken,
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTypeOf('string');
    expect(body.expires_in).toBeTypeOf('number');
  });

  it('org ticket can exchange for ws-ticket', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/ws-ticket', {
      token: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTypeOf('string');
  });
});
