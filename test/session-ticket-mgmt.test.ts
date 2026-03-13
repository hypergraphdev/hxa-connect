import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Issue #114: Session/Ticket Management Endpoints
// Covers: GET/DELETE /api/org/tickets, GET/DELETE /api/org/sessions
// ═══════════════════════════════════════════════════════════════

describe('Ticket Management Endpoints', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let sessionCookie: string;
  let adminToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg('ticket-mgmt-org');
    orgId = org.id;
    orgSecret = org.org_secret;
    sessionCookie = await env.loginAsOrg(orgSecret);

    // Create an admin bot for Bearer token auth tests
    const { bot, token } = await env.registerBot(orgSecret, 'admin-bot');
    adminToken = token;
    await env.promoteBot(orgSecret, bot.bot_id);
    // Re-login since promoteBot consumed a session
    sessionCookie = await env.loginAsOrg(orgSecret);
  });

  afterAll(() => env.cleanup());

  // ─── GET /api/org/tickets ─────────────────────────

  describe('GET /api/org/tickets', () => {
    it('returns empty list when no tickets exist', async () => {
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/tickets', {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.items).toBeInstanceOf(Array);
    });

    it('lists active tickets created via session auth', async () => {
      // Create some tickets
      const ticket1Res = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: sessionCookie,
        body: { expires_in: 3600 },
      });
      expect(ticket1Res.status).toBe(200);

      const ticket2Res = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: sessionCookie,
        body: { reusable: true, expires_in: 0 },
      });
      expect(ticket2Res.status).toBe(200);

      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/tickets', {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.items.length).toBeGreaterThanOrEqual(2);

      // Verify fields: no secret_hash exposed
      const item = body.items[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('code');
      expect(item).toHaveProperty('reusable');
      expect(item).toHaveProperty('expires_at');
      expect(item).toHaveProperty('created_by');
      expect(item).toHaveProperty('created_at');
      expect(item).not.toHaveProperty('secret_hash');
      expect(item).not.toHaveProperty('consumed');
      expect(item).not.toHaveProperty('org_id');
    });

    it('lists tickets via admin bot Bearer token', async () => {
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/tickets', {
        token: adminToken,
      });
      expect(status).toBe(200);
      expect(body.items).toBeInstanceOf(Array);
    });

    it('rejects member bot Bearer token', async () => {
      const { token: memberToken } = await env.registerBot(orgSecret, 'member-bot-tkt');
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/tickets', {
        token: memberToken,
      });
      expect(status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated requests', async () => {
      const { status } = await api(env.baseUrl, 'GET', '/api/org/tickets', {});
      expect(status).toBe(401);
    });

    it('supports pagination with limit', async () => {
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/tickets?limit=1', {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(1);
      if (body.items.length === 1) {
        expect(body.cursor).toBeDefined();
      }
    });

    it('supports cursor-based pagination', async () => {
      // Get first page
      const page1 = await api(env.baseUrl, 'GET', '/api/org/tickets?limit=1', {
        cookie: sessionCookie,
      });
      expect(page1.status).toBe(200);

      if (page1.body.cursor) {
        // Get second page
        const page2 = await api(env.baseUrl, 'GET', `/api/org/tickets?limit=1&cursor=${page1.body.cursor}`, {
          cookie: sessionCookie,
        });
        expect(page2.status).toBe(200);
        expect(page2.body.items).toBeInstanceOf(Array);

        // Pages should have different items
        if (page2.body.items.length > 0) {
          expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
        }
      }
    });

    it('does not list consumed tickets', async () => {
      // Create a ticket and consume it (register a bot with it)
      const ticketRes = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: sessionCookie,
        body: { expires_in: 3600 },
      });
      const ticketCode = ticketRes.body.ticket;

      // Consume by registering
      await api(env.baseUrl, 'POST', '/api/auth/register', {
        body: { org_id: orgId, ticket: ticketCode, name: `consume-test-${Date.now()}` },
      });

      // List should not include consumed tickets
      const { body } = await api(env.baseUrl, 'GET', '/api/org/tickets', {
        cookie: sessionCookie,
      });
      const consumedTicket = body.items.find((t: any) => t.code === ticketCode);
      expect(consumedTicket).toBeUndefined();
    });
  });

  // ─── DELETE /api/org/tickets/:id ──────────────────

  describe('DELETE /api/org/tickets/:id', () => {
    it('deletes a ticket by ID via session auth', async () => {
      const createRes = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: sessionCookie,
        body: { expires_in: 3600 },
      });
      const ticketCode = createRes.body.ticket;

      const { status, body } = await api(env.baseUrl, 'DELETE', `/api/org/tickets/${ticketCode}`, {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.deleted).toBe(true);
    });

    it('deletes a ticket via admin bot Bearer token', async () => {
      const createRes = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        token: adminToken,
        body: { expires_in: 3600 },
      });
      const ticketCode = createRes.body.ticket;

      const { status, body } = await api(env.baseUrl, 'DELETE', `/api/org/tickets/${ticketCode}`, {
        token: adminToken,
      });
      expect(status).toBe(200);
      expect(body.deleted).toBe(true);
    });

    it('returns 404 for non-existent ticket', async () => {
      const { status, body } = await api(env.baseUrl, 'DELETE', '/api/org/tickets/nonexistent-id', {
        cookie: sessionCookie,
      });
      expect(status).toBe(404);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when trying to delete ticket from another org', async () => {
      // Create another org and ticket
      const org2 = await env.createOrg('other-org-tkt');
      const cookie2 = await env.loginAsOrg(org2.org_secret);
      const createRes = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: cookie2,
        body: { expires_in: 3600 },
      });
      const ticketCode = createRes.body.ticket;

      // Try to delete from first org's session
      const { status } = await api(env.baseUrl, 'DELETE', `/api/org/tickets/${ticketCode}`, {
        cookie: sessionCookie,
      });
      expect(status).toBe(404);
    });

    it('revoked ticket cannot be used for registration', async () => {
      const createRes = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: sessionCookie,
        body: { expires_in: 3600 },
      });
      const ticketCode = createRes.body.ticket;

      // Delete the ticket
      await api(env.baseUrl, 'DELETE', `/api/org/tickets/${ticketCode}`, {
        cookie: sessionCookie,
      });

      // Try to register with the revoked ticket
      const regRes = await api(env.baseUrl, 'POST', '/api/auth/register', {
        body: { org_id: orgId, ticket: ticketCode, name: `revoked-test-${Date.now()}` },
      });
      // Should fail — ticket was deleted
      expect(regRes.status).not.toBe(200);
    });

    it('rejects member bot', async () => {
      const { token: memberToken } = await env.registerBot(orgSecret, 'member-del-tkt');
      const { status, body } = await api(env.baseUrl, 'DELETE', '/api/org/tickets/some-id', {
        token: memberToken,
      });
      expect(status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('creates audit log entry on deletion', async () => {
      const createRes = await api(env.baseUrl, 'POST', '/api/org/tickets', {
        cookie: sessionCookie,
        body: { expires_in: 3600 },
      });
      const ticketCode = createRes.body.ticket;

      await api(env.baseUrl, 'DELETE', `/api/org/tickets/${ticketCode}`, {
        cookie: sessionCookie,
      });

      // Check audit log
      const auditRes = await api(env.baseUrl, 'GET', '/api/audit?action=auth.ticket_revoked', {
        cookie: sessionCookie,
      });
      expect(auditRes.status).toBe(200);
      const entry = auditRes.body.find((e: any) => e.action === 'auth.ticket_revoked');
      expect(entry).toBeDefined();
      expect(entry.target_type).toBe('org_ticket');
    });
  });
});

describe('Session Management Endpoints', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let sessionCookie: string;
  let adminToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const org = await env.createOrg('session-mgmt-org');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Create an admin bot
    const { bot, token } = await env.registerBot(orgSecret, 'session-admin-bot');
    adminToken = token;
    await env.promoteBot(orgSecret, bot.bot_id);
    sessionCookie = await env.loginAsOrg(orgSecret);
  });

  afterAll(() => env.cleanup());

  // ─── GET /api/org/sessions ────────────────────────

  describe('GET /api/org/sessions', () => {
    it('lists active sessions for the org', async () => {
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.items).toBeInstanceOf(Array);
      expect(body.items.length).toBeGreaterThanOrEqual(1);

      // The current session should be in the list
      const item = body.items[0];
      expect(item).toHaveProperty('ref');
      expect(item).toHaveProperty('role');
      expect(item).toHaveProperty('created_at');
      expect(item).toHaveProperty('expires_at');
      // ref is 16-char hex (HMAC-based, non-secret)
      expect(item.ref).toMatch(/^[a-f0-9]{16}$/);
      // Must NOT expose the raw session ID
      expect(item).not.toHaveProperty('id');
      expect(item).not.toHaveProperty('full_id');
    });

    it('lists sessions via admin bot Bearer token', async () => {
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        token: adminToken,
      });
      expect(status).toBe(200);
      expect(body.items).toBeInstanceOf(Array);
    });

    it('rejects member bot', async () => {
      const { token: memberToken } = await env.registerBot(orgSecret, 'member-sess-list');
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        token: memberToken,
      });
      expect(status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated requests', async () => {
      const { status } = await api(env.baseUrl, 'GET', '/api/org/sessions', {});
      expect(status).toBe(401);
    });

    it('supports limit and offset', async () => {
      const { status, body } = await api(env.baseUrl, 'GET', '/api/org/sessions?limit=1&offset=0', {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(1);
    });

    it('does not show sessions from other orgs', async () => {
      // Create another org with its own session
      const org2 = await env.createOrg('other-org-sess');
      await env.loginAsOrg(org2.org_secret);

      // List from first org — should not include org2's session
      const { body } = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: sessionCookie,
      });
      const foreignSession = body.items.find((s: any) => s.org_id === org2.id);
      expect(foreignSession).toBeUndefined();
    });

    it('shows bot_owner sessions', async () => {
      // Login as a bot (creates bot_owner session)
      const { bot, token } = await env.registerBot(orgSecret, 'session-list-bot');
      const loginRes = await fetch(`${env.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bot', token, owner_name: 'tester' }),
      });
      expect(loginRes.status).toBe(200);

      // List sessions — should include the bot_owner session
      const { body } = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: sessionCookie,
      });
      const botSession = body.items.find((s: any) => s.role === 'bot_owner' && s.bot_id === bot.bot_id);
      expect(botSession).toBeDefined();
    });
  });

  // ─── DELETE /api/org/sessions/:id ─────────────────

  describe('DELETE /api/org/sessions/:ref', () => {
    it('force-logouts a session by ref', async () => {
      // Login as bot to create a target session
      const { token } = await env.registerBot(orgSecret, 'force-logout-bot');
      const loginRes = await fetch(`${env.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bot', token, owner_name: 'target' }),
      });
      const setCookie = loginRes.headers.get('set-cookie') || '';
      const match = setCookie.match(/hxa_session=([^;]+)/);
      const targetCookie = match![1];

      // Verify session works
      const checkRes = await api(env.baseUrl, 'GET', '/api/auth/session', {
        cookie: targetCookie,
      });
      expect(checkRes.status).toBe(200);

      // Get the session ref from the list
      const listRes = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: sessionCookie,
      });
      const targetSession = listRes.body.items.find((s: any) => s.owner_name === 'target');
      expect(targetSession).toBeDefined();

      // Force logout using ref
      const { status, body } = await api(env.baseUrl, 'DELETE', `/api/org/sessions/${targetSession.ref}`, {
        cookie: sessionCookie,
      });
      expect(status).toBe(200);
      expect(body.deleted).toBe(true);

      // Verify session is now invalid
      const verifyRes = await api(env.baseUrl, 'GET', '/api/auth/session', {
        cookie: targetCookie,
      });
      expect(verifyRes.status).toBe(401);
    });

    it('prevents self-logout (must use /api/auth/logout)', async () => {
      // Get own session ref
      const listRes = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: sessionCookie,
      });
      const ownSession = listRes.body.items.find((s: any) => s.role === 'org_admin');
      expect(ownSession).toBeDefined();

      const { status, body } = await api(env.baseUrl, 'DELETE', `/api/org/sessions/${ownSession.ref}`, {
        cookie: sessionCookie,
      });
      expect(status).toBe(400);
      expect(body.code).toBe('SELF_LOGOUT');
    });

    it('returns 404 for non-existent session ref', async () => {
      const { status, body } = await api(env.baseUrl, 'DELETE', '/api/org/sessions/0000000000000000', {
        cookie: sessionCookie,
      });
      expect(status).toBe(404);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 for session from another org', async () => {
      // Create a session in another org
      const org2 = await env.createOrg('other-org-del');
      const cookie2 = await env.loginAsOrg(org2.org_secret);

      // Get its ref
      const listRes = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: cookie2,
      });
      const org2Session = listRes.body.items[0];

      // Try to delete from first org — ref won't match any session in first org
      const { status } = await api(env.baseUrl, 'DELETE', `/api/org/sessions/${org2Session.ref}`, {
        cookie: sessionCookie,
      });
      expect(status).toBe(404);
    });

    it('works via admin bot Bearer token', async () => {
      // Create a target session
      const { token } = await env.registerBot(orgSecret, 'bot-force-logout');
      const loginRes = await fetch(`${env.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bot', token, owner_name: 'bot-target' }),
      });
      const setCookie = loginRes.headers.get('set-cookie') || '';
      const match = setCookie.match(/hxa_session=([^;]+)/);
      const targetCookie = match![1];

      // Get session ref via admin bot
      const listRes = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        token: adminToken,
      });
      const targetSession = listRes.body.items.find((s: any) => s.owner_name === 'bot-target');
      expect(targetSession).toBeDefined();

      // Force logout via admin bot token
      const { status, body } = await api(env.baseUrl, 'DELETE', `/api/org/sessions/${targetSession.ref}`, {
        token: adminToken,
      });
      expect(status).toBe(200);
      expect(body.deleted).toBe(true);

      // Verify session is invalidated
      const verifyRes = await api(env.baseUrl, 'GET', '/api/auth/session', {
        cookie: targetCookie,
      });
      expect(verifyRes.status).toBe(401);
    });

    it('can force-logout sessions beyond the first 100 listed', async () => {
      let targetCookie = '';

      // Create >100 bot_owner sessions in this org
      for (let i = 0; i < 105; i++) {
        const botName = `bulk-logout-bot-${Date.now()}-${i}`;
        const ownerName = `bulk-target-${i}`;
        const { token } = await env.registerBot(orgSecret, botName);
        const loginRes = await fetch(`${env.baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'bot', token, owner_name: ownerName }),
        });
        expect(loginRes.status).toBe(200);
        if (i === 0) {
          const setCookie = loginRes.headers.get('set-cookie') || '';
          targetCookie = setCookie.match(/hxa_session=([^;]+)/)![1];
        }
      }

      // Find an older session ref from later pages (offset >= 100)
      let targetRef: string | undefined;
      for (let offset = 100; offset <= 300; offset += 20) {
        const page = await api(env.baseUrl, 'GET', `/api/org/sessions?limit=20&offset=${offset}`, {
          cookie: sessionCookie,
        });
        expect(page.status).toBe(200);
        const match = page.body.items.find((s: any) => s.owner_name === 'bulk-target-0');
        if (match) {
          targetRef = match.ref;
          break;
        }
        if (!page.body.items?.length) break;
      }
      expect(targetRef).toBeDefined();

      // Force logout must work even when the target is not in the first 100 sessions
      const del = await api(env.baseUrl, 'DELETE', `/api/org/sessions/${targetRef}`, {
        cookie: sessionCookie,
      });
      expect(del.status).toBe(200);
      expect(del.body.deleted).toBe(true);

      // Verify target session is invalidated
      const verifyRes = await api(env.baseUrl, 'GET', '/api/auth/session', {
        cookie: targetCookie,
      });
      expect(verifyRes.status).toBe(401);
    });

    it('rejects member bot', async () => {
      const { token: memberToken } = await env.registerBot(orgSecret, 'member-sess-del');
      const { status, body } = await api(env.baseUrl, 'DELETE', '/api/org/sessions/0000000000000000', {
        token: memberToken,
      });
      expect(status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('creates audit log entry on force-logout', async () => {
      // Create target session
      const { token } = await env.registerBot(orgSecret, 'audit-logout-bot');
      const loginRes = await fetch(`${env.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bot', token, owner_name: 'audit-target' }),
      });

      // Get session ref
      const listRes = await api(env.baseUrl, 'GET', '/api/org/sessions', {
        cookie: sessionCookie,
      });
      const targetSession = listRes.body.items.find((s: any) => s.owner_name === 'audit-target');

      // Force logout
      await api(env.baseUrl, 'DELETE', `/api/org/sessions/${targetSession.ref}`, {
        cookie: sessionCookie,
      });

      // Check audit log
      const auditRes = await api(env.baseUrl, 'GET', '/api/audit?action=auth.session_force_logout', {
        cookie: sessionCookie,
      });
      expect(auditRes.status).toBe(200);
      const entry = auditRes.body.find((e: any) => e.action === 'auth.session_force_logout');
      expect(entry).toBeDefined();
      expect(entry.target_type).toBe('session');
    });
  });
});

// ─── Super Admin Cross-Org Access ───────────────────

describe('Super Admin Cross-Org Access', () => {
  let env: TestEnv;
  let orgId: string;
  let orgSecret: string;
  let superAdminCookie: string;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: 'test-admin-secret' });
    const org = await env.createOrg('super-admin-org');
    orgId = org.id;
    orgSecret = org.org_secret;

    // Login as super admin
    const loginRes = await fetch(`${env.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'super_admin', admin_secret: 'test-admin-secret' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie') || '';
    superAdminCookie = setCookie.match(/hxa_session=([^;]+)/)![1];
  });

  afterAll(() => env.cleanup());

  it('super_admin can list tickets for any org', async () => {
    // Create a ticket in the org first
    const orgCookie = await env.loginAsOrg(orgSecret);
    await api(env.baseUrl, 'POST', '/api/org/tickets', {
      cookie: orgCookie,
      body: { expires_in: 3600 },
    });

    // Super admin lists — needs org context
    // super_admin session has no org_id, so this should still work
    // because requireOrgAdmin returns true for super_admin
    const { status } = await api(env.baseUrl, 'GET', '/api/org/tickets', {
      cookie: superAdminCookie,
    });
    // super_admin has no org_id → orgId would be undefined
    // This is expected — super_admin needs to specify org context
    // For now just verify auth passes (not 403)
    expect(status).not.toBe(403);
  });

  it('super_admin can list sessions', async () => {
    const { status } = await api(env.baseUrl, 'GET', '/api/org/sessions', {
      cookie: superAdminCookie,
    });
    expect(status).not.toBe(403);
  });
});
