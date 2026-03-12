import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';
import { HubDB } from '../src/db.js';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════
// Phase 5-7 Integration Tests
// Covers: login-to-register flow, pagination, secret rotation,
//         ticket invalidation, role management, X-Org-Id validation
// ═══════════════════════════════════════════════════════════════

async function loginAsSuperAdmin(baseUrl: string, adminSecret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'super_admin', admin_secret: adminSecret }),
  });
  if (!res.ok) throw new Error(`Super admin login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/hxa_session=([^;]+)/);
  if (!match) throw new Error('No session cookie');
  return match[1];
}

// ─── 1. Login-to-Register Full Auth Flow ─────────────────────

describe('Login-to-Register Auth Flow', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg('auth-flow-org');
    orgId = org.id;
    orgSecret = org.org_secret;
  });

  afterAll(() => env.cleanup());

  it('Step 1: POST /api/auth/login with valid org_secret returns a session', async () => {
    const res = await fetch(`${env.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'org_admin', org_id: orgId, org_secret: orgSecret }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toMatch(/hxa_session=/);
    const body = await res.json() as any;
    expect(body.session.role).toBe('org_admin');
    expect(body.session.org_id).toBe(orgId);
    expect(body.session.expires_at).toBeDefined();
  });

  it('Step 2: POST /api/auth/register with ticket registers bot as member', async () => {
    // Create ticket via DB
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });

    // Register first bot — all bots default to member
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'alpha-bot', bio: 'first bot' },
    });
    expect(status).toBe(200);
    expect(body.bot_id).toBeTypeOf('string');
    expect(body.token).toBeTypeOf('string');
    expect(body.name).toBe('alpha-bot');
    expect(body.auth_role).toBe('member');
    expect(body.bio).toBe('first bot');
  });

  it('Step 3: subsequent registered bots are also members', async () => {
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'beta-bot' },
    });
    expect(status).toBe(200);
    expect(body.auth_role).toBe('member');
  });

  it('Step 4: bot token authenticates API calls (GET /api/me)', async () => {
    // Get a token via DB ticket + register
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'gamma-bot' },
    });

    const { status, body } = await api(env.baseUrl, 'GET', '/api/me', {
      token: regBody.token,
    });
    expect(status).toBe(200);
    expect(body.name).toBe('gamma-bot');
    expect(body.org_id).toBe(orgId);
  });

  it('Step 5: bot can send a message via thread', async () => {
    // DB ticket + register
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'delta-bot' },
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
      body: { type: 'org_admin', org_id: orgId, org_secret: 'wrong-secret' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects login with nonexistent org_id', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'org_admin', org_id: 'nonexistent-org-id', org_secret: orgSecret },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_CREDENTIALS');
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
    // Create a second org and a ticket for it
    const org2 = await env.createOrg('other-org');
    const ticket = await env.db.createOrgTicket(org2.id, 'test-hash', { expiresAt: Date.now() + 3600000 });

    // Try to register in the first org using the second org's ticket
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'cross-org-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('rejects register with duplicate bot name via ticket without consuming it', async () => {
    // First: register a bot with a ticket
    const ticket1 = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket1.id, name: 'duplicate-name-bot' },
    });
    expect(s1).toBe(200);

    // Second: try to register another bot with the same name using a new ticket
    const ticket2 = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { status: s2, body: b2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket2.id, name: 'duplicate-name-bot' },
    });
    expect(s2).toBe(409);
    expect(b2.code).toBe('NAME_CONFLICT');

    // Verify the ticket was NOT consumed (can still be used for a different name)
    const { status: s3, body: b3 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket2.id, name: 'unique-name-bot' },
    });
    expect(s3).toBe(200);
    expect(b3.token).toBeDefined();
  });

  it('one-time ticket cannot be reused', async () => {
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });

    // First registration consumes the ticket
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'single-use-1' },
    });
    expect(s1).toBe(200);

    // Second registration fails — ticket consumed
    const { status: s2, body: b2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'single-use-2' },
    });
    expect(s2).toBe(401);
    expect(b2.code).toBe('TICKET_CONSUMED');
  });

  it('reusable ticket can be used multiple times', async () => {
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { reusable: true, expiresAt: Date.now() + 3600000 });

    // First registration
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'reuse-1' },
    });
    expect(s1).toBe(200);

    // Second registration with same ticket
    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'reuse-2' },
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
    const org = await env.createOrg('orgid-test');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Register a bot via DB ticket
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'orgid-bot' },
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
    const org = await env.createOrg('rotation-org');
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
      body: { type: 'org_admin', org_id: orgId, org_secret: orgSecret },
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
      body: { type: 'org_admin', org_id: orgId, org_secret: orgSecret },
    });
    expect(oldStatus).toBe(401);
    expect(oldBody.code).toBe('INVALID_CREDENTIALS');

    // New secret works
    const { status: newStatus, body: newBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'org_admin', org_id: orgId, org_secret: newSecret },
    });
    expect(newStatus).toBe(200);
    expect(newBody.session).toBeDefined();

    // Update for subsequent tests
    orgSecret = newSecret;
  });

  it('outstanding tickets are invalidated on rotation', async () => {
    // Create a ticket via DB
    const preRotationTicket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });

    // Rotate the secret
    const { body: rotateBody } = await api(env.baseUrl, 'POST', '/api/org/rotate-secret', {
      token: adminToken,
    });
    orgSecret = rotateBody.org_secret;

    // Pre-rotation ticket should be invalidated
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: preRotationTicket.id, name: 'orphan-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');

    // Create new ticket via DB and register works
    const newTicket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { status: regStatus, body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: newTicket.id, name: 'post-rotation-bot' },
    });
    expect(regStatus).toBe(200);
    expect(regBody.name).toBe('post-rotation-bot');
  });

  it('non-admin bot cannot rotate secret', async () => {
    // Register a member via DB ticket
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: memberBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'member-no-rotate' },
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
    const org = await env.createOrg('role-org');
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
    // Create another org + bot via DB ticket
    const org2 = await env.createOrg('role-org-2');
    const ticket2 = await env.db.createOrgTicket(org2.id, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: otherAgent } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: org2.id, ticket: ticket2.id, name: 'other-org-bot' },
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
    const org = await env.createOrg('pag-bots-org');

    // Register 5 bots
    for (let i = 1; i <= 5; i++) {
      await env.registerBot(org.org_secret, `bot-${String(i).padStart(2, '0')}`);
    }
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('returns unpaginated array when no cursor/limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots', {
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
  });

  it('returns paginated response with limit param', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots?limit=2', {
      cookie: orgTicket,
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
        cookie: orgTicket,
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
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('clamps limit to maximum of 200', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/bots?limit=999', {
      cookie: orgTicket,
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
    const org = await env.createOrg('pag-threads-org');

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
      cookie: orgTicket,
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
        cookie: orgTicket,
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
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(1);
    expect(body.items[0].status).toBe('closed');
    expect(body.has_more).toBe(false);
  });

  it('returns empty result when no threads match filter', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?status=resolved&limit=50', {
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('returns empty for cursor past end', async () => {
    // Use composite cursor with timestamp 0 — older than any thread
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?limit=10&cursor=0|z', {
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.items.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('clamps limit over 200', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org/threads?limit=500', {
      cookie: orgTicket,
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
    const org = await env.createOrg('pag-artifacts-org');

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
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
  });

  it('returns paginated response with limit', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/artifacts?limit=2`, {
      cookie: orgTicket,
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
        cookie: orgTicket,
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
    const org = await env.createOrg('pag-msgs-org');

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
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    // Without before=id, returns legacy flat array (backward compat)
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
  });

  it('paginates with before=message_id (cursor)', async () => {
    // Get newest message ID first (flat array, newest first)
    const { body: initial } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=1`, {
      cookie: orgTicket,
    });
    const newestId = initial[0].id;

    // Now use cursor-based pagination starting after the newest
    const { body: page1 } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=3&before=${newestId}`, {
      cookie: orgTicket,
    });
    expect(page1.messages).toBeDefined();
    expect(page1.messages.length).toBe(3);
    expect(page1.has_more).toBe(true);

    // Use the oldest message from page 1 as cursor
    const lastId = page1.messages[page1.messages.length - 1].id;

    const { body: page2 } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=3&before=${lastId}`, {
      cookie: orgTicket,
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
      cookie: orgTicket,
    });
    const allMsgs: any[] = [...initial];
    // Legacy response is oldest-first; use oldest message as cursor to avoid overlap
    let before = initial[0].id;

    for (let page = 0; page < 10; page++) {
      const { body } = await api(env.baseUrl, 'GET', `/api/org/threads/${threadId}/messages?limit=2&before=${before}`, {
        cookie: orgTicket,
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
  let superAdminCookie: string;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: 'super-secret' });
    superAdminCookie = await loginAsSuperAdmin(env.baseUrl, 'super-secret');
    const { body: orgBody } = await api(env.baseUrl, 'POST', '/api/orgs', {
      cookie: superAdminCookie,
      body: { name: 'lifecycle-org' },
    });
    orgId = orgBody.id;
    orgSecret = orgBody.org_secret;
  });

  afterAll(() => env.cleanup());

  it('login works on active org', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'org_admin', org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(200);
  });

  it('login is blocked on suspended org', async () => {
    // Suspend org
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      cookie: superAdminCookie,
      body: { status: 'suspended' },
    });

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'org_admin', org_id: orgId, org_secret: orgSecret },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_INACTIVE');

    // Reactivate
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      cookie: superAdminCookie,
      body: { status: 'active' },
    });
  });

  it('tickets from pre-suspend are invalidated', async () => {
    // Create a ticket via DB
    const preTicket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });

    // Suspend (invalidates tickets)
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      cookie: superAdminCookie,
      body: { status: 'suspended' },
    });

    // Reactivate
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      cookie: superAdminCookie,
      body: { status: 'active' },
    });

    // Pre-suspend ticket should be invalidated
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: preTicket.id, name: 'stale-ticket-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_TICKET');
  });

  it('bot token is blocked when org is suspended', async () => {
    // Register a bot while active via DB ticket
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'suspended-test-bot' },
    });

    // Verify it works
    const { status: okStatus } = await api(env.baseUrl, 'GET', '/api/me', {
      token: regBody.token,
    });
    expect(okStatus).toBe(200);

    // Suspend
    await api(env.baseUrl, 'PATCH', `/api/orgs/${orgId}`, {
      cookie: superAdminCookie,
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
      cookie: superAdminCookie,
      body: { status: 'active' },
    });
  });
});

// ─── 10. Super Admin Org Creation ────────────────────────────

describe('Super Admin Org Management', () => {
  let env: TestEnv;
  let superAdminCookie: string;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: 'admin-key' });
    superAdminCookie = await loginAsSuperAdmin(env.baseUrl, 'admin-key');
  });

  afterAll(() => env.cleanup());

  it('creates org via super admin', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/orgs', {
      cookie: superAdminCookie,
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
      cookie: superAdminCookie,
      body: { name: 'org-a' },
    });
    await api(env.baseUrl, 'POST', '/api/orgs', {
      cookie: superAdminCookie,
      body: { name: 'org-b' },
    });

    const { status, body } = await api(env.baseUrl, 'GET', '/api/orgs', {
      cookie: superAdminCookie,
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
      cookie: superAdminCookie,
      body: { name: 'full-lifecycle-org' },
    });
    const orgId = orgBody.id;
    const orgSecret = orgBody.org_secret;

    // Step 2: Login with org_secret to get session
    const { status: loginStatus, body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'org_admin', org_id: orgId, org_secret: orgSecret },
    });
    expect(loginStatus).toBe(200);
    expect(loginBody.session).toBeDefined();

    // Step 3: Register bot via DB ticket
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'lifecycle-bot' },
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
    const org = await env.createOrg('expiry-org');
    orgId = org.id;
    orgSecret = org.org_secret;
  });

  afterAll(() => env.cleanup());

  it('ticket with very short TTL expires', async () => {
    // Create a ticket via DB with 1-second expiry
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 1000 });

    // Wait for ticket to expire
    await new Promise(resolve => setTimeout(resolve, 1500));

    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'expired-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('TICKET_EXPIRED');
  });

  it('custom ticket expiry is respected', async () => {
    // Create a ticket via DB with 1-hour expiry
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    // Ticket should be usable (not expired)
    const { status } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'custom-expiry-bot' },
    });
    expect(status).toBe(200);
  });

  it('expired reusable ticket returns TICKET_EXPIRED on register', async () => {
    // Create a reusable ticket with very short TTL
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { reusable: true, expiresAt: Date.now() + 1000 });

    // Wait for ticket to expire
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Use expired ticket to register
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'expired-reusable-bot' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('TICKET_EXPIRED');
  });

  it('default org_admin session TTL is 8 hours', async () => {
    const res = await fetch(`${env.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'org_admin', org_id: orgId, org_secret: orgSecret }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Default org_admin TTL should be ~8 hours
    const expectedExpiry = Date.now() + 8 * 3600 * 1000;
    const expiresAt = new Date(body.session.expires_at).getTime();
    expect(expiresAt).toBeGreaterThan(expectedExpiry - 10000);
    expect(expiresAt).toBeLessThan(expectedExpiry + 10000);
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
    const org = await env.createOrg('mixed-auth-org');
    orgId = org.id;

    const { token } = await env.registerBot(org.org_secret, 'mixed-bot');
    botToken = token;
    orgTicket = await env.loginAsOrg(org.org_secret);
  });

  afterAll(() => env.cleanup());

  it('org ticket works as Bearer for org-level endpoints', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/org', {
      cookie: orgTicket,
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
    const org = await env.createOrg('ws-ticket-org');

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
      cookie: orgTicket,
    });
    expect(status).toBe(200);
    expect(body.ticket).toBeTypeOf('string');
  });
});

// ─── N. Bot Name Tombstone (#199 A1) ─────────────────────────

describe('Bot Name Tombstone (#199 A1)', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg('tombstone-org');
    orgId = org.id;
    orgSecret = org.org_secret;
    const { bot, token } = await env.registerBot(orgSecret, 'tombstone-admin');
    adminToken = token;
    adminId = bot.bot_id;
    await env.promoteBot(orgSecret, adminId);
  });

  afterAll(() => env.cleanup());

  it('admin bot can delete another bot (management permission restored)', async () => {
    // Register a victim bot via org_secret
    const regRes = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, org_secret: orgSecret, name: 'tombstone-victim' }),
    });
    expect(regRes.status).toBe(200);
    const victim = await regRes.json() as any;

    // Admin bot deletes victim
    const { status } = await api(env.baseUrl, 'DELETE', `/api/bots/${victim.bot_id}`, {
      token: adminToken,
    });
    expect(status).toBe(200);
  });

  it('deleted bot name is tombstoned — org_secret registration rejected', async () => {
    // Register and then delete a bot
    const regRes = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, org_secret: orgSecret, name: 'tombstone-reuse' }),
    });
    expect(regRes.status).toBe(200);
    const victim2 = await regRes.json() as any;
    await api(env.baseUrl, 'DELETE', `/api/bots/${victim2.bot_id}`, { token: adminToken });

    // Try to re-register with same name via org_secret
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, org_secret: orgSecret, name: 'tombstone-reuse' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('NAME_TOMBSTONED');
  });

  it('deleted bot name is tombstoned — ticket registration also rejected', async () => {
    // Register and delete a bot
    const regRes = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, org_secret: orgSecret, name: 'tombstone-ticket' }),
    });
    expect(regRes.status).toBe(200);
    const victim3 = await regRes.json() as any;
    await api(env.baseUrl, 'DELETE', `/api/bots/${victim3.bot_id}`, { token: adminToken });

    // Try to register with same name via ticket
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', { expiresAt: Date.now() + 3600000 });
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, ticket: ticket.id, name: 'tombstone-ticket' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('NAME_TOMBSTONED');
  });

  it('org_secret registration with existing live bot name rejected (NAME_EXISTS)', async () => {
    // Register a live bot via org_secret
    const regRes = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, org_secret: orgSecret, name: 'tombstone-live' }),
    });
    expect(regRes.status).toBe(200);
    const liveBot = await regRes.json() as any;

    // Try to re-register with same name (no deletion — bot still exists)
    const { status, body } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, org_secret: orgSecret, name: 'tombstone-live' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('NAME_EXISTS');

    // Clean up
    await api(env.baseUrl, 'DELETE', `/api/bots/${liveBot.bot_id}`, { token: adminToken });
  });

  it('human org_admin session can release a tombstone', async () => {
    // Register and delete a bot to create tombstone
    const regRes = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, org_secret: orgSecret, name: 'tombstone-release' }),
    });
    expect(regRes.status).toBe(200);
    const victim4 = await regRes.json() as any;
    await api(env.baseUrl, 'DELETE', `/api/bots/${victim4.bot_id}`, { token: adminToken });

    // Verify tombstone is active
    const { status: beforeStatus } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, org_secret: orgSecret, name: 'tombstone-release' },
    });
    expect(beforeStatus).toBe(409);

    // Human org_admin releases the tombstone
    const sessionCookie = await env.loginAsOrg(orgSecret);
    const { status: releaseStatus } = await api(env.baseUrl, 'DELETE', `/api/orgs/${orgId}/tombstones/tombstone-release`, {
      cookie: sessionCookie,
    });
    expect(releaseStatus).toBe(200);

    // Now registration should succeed
    const { status: afterStatus, body: afterBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgId, org_secret: orgSecret, name: 'tombstone-release' },
    });
    expect(afterStatus).toBe(200);
    expect(afterBody.token).toBeDefined();
  });

  it('bot token cannot release a tombstone', async () => {
    // Register and delete a bot to create tombstone
    const regRes = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, org_secret: orgSecret, name: 'tombstone-bot-guard' }),
    });
    expect(regRes.status).toBe(200);
    const victim5 = await regRes.json() as any;
    await api(env.baseUrl, 'DELETE', `/api/bots/${victim5.bot_id}`, { token: adminToken });

    // Admin bot tries to release tombstone
    const { status, body } = await api(env.baseUrl, 'DELETE', `/api/orgs/${orgId}/tombstones/tombstone-bot-guard`, {
      token: adminToken,
    });
    expect(status).toBe(403);
    expect(body.code).toBe('HUMAN_SESSION_REQUIRED');
  });
});
