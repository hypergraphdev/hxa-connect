/**
 * #133: Bot Join Approval Mechanism
 *
 * Tests the org-level join_approval_required setting and bot join_status field.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';
import WebSocket from 'ws';

describe('Bot Join Approval (#133)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  // Helper: enable join approval for an org
  async function enableApproval(orgSecret: string) {
    const cookie = await env.loginAsOrg(orgSecret);
    const res = await fetch(`${env.baseUrl}/api/org/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `hxa_session=${cookie}`, Origin: env.baseUrl },
      body: JSON.stringify({ join_approval_required: true }),
    });
    expect(res.ok).toBe(true);
    return cookie;
  }

  // Helper: create ticket for an org
  async function createTicket(orgId: string) {
    const ticket = await env.db.createOrgTicket(orgId, 'test-hash', {
      expiresAt: Date.now() + 3600_000,
    });
    return ticket;
  }

  // Helper: register via ticket
  async function registerWithTicket(orgId: string, ticketId: string, name: string) {
    const res = await fetch(`${env.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, ticket: ticketId, name }),
    });
    return { res, data: await res.json() as any };
  }

  // Helper: change bot join status
  async function changeBotStatus(cookie: string, botId: string, status: string, reason?: string) {
    const res = await fetch(`${env.baseUrl}/api/org/bots/${botId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `hxa_session=${cookie}`, Origin: env.baseUrl },
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    });
    return { res, data: await res.json() as any };
  }

  describe('Org Settings', () => {
    it('join_approval_required defaults to false', async () => {
      const { org_secret } = await env.createOrg('test-default-approval');
      const cookie = await env.loginAsOrg(org_secret);
      const res = await fetch(`${env.baseUrl}/api/org/settings`, {
        headers: { Cookie: `hxa_session=${cookie}`, Origin: env.baseUrl },
      });
      const data = await res.json() as any;
      expect(data.join_approval_required).toBe(false);
    });

    it('can enable join_approval_required', async () => {
      const { org_secret } = await env.createOrg('test-enable-approval');
      const cookie = await enableApproval(org_secret);
      const res = await fetch(`${env.baseUrl}/api/org/settings`, {
        headers: { Cookie: `hxa_session=${cookie}`, Origin: env.baseUrl },
      });
      const data = await res.json() as any;
      expect(data.join_approval_required).toBe(true);
    });
  });

  describe('Registration with approval disabled', () => {
    it('bot joins immediately as active (backward compatible)', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-no-approval');
      const ticket = await createTicket(orgId);
      const { res, data } = await registerWithTicket(orgId, ticket.id, 'bot-instant');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('active');
      expect(data.message).toBeUndefined();
    });
  });

  describe('Registration with approval enabled', () => {
    it('bot is created in pending state', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-with-approval');
      await enableApproval(org_secret);
      const ticket = await createTicket(orgId);
      const { res, data } = await registerWithTicket(orgId, ticket.id, 'bot-pending');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('pending');
      expect(data.message).toBe('Awaiting org admin approval');
      expect(data.token).toBeDefined(); // Token is still returned
    });

    it('org_secret registration always creates active bot', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-secret-bypass');
      await enableApproval(org_secret);
      const res = await fetch(`${env.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, org_secret, name: 'admin-bot' }),
      });
      const data = await res.json() as any;
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('active');
    });
  });

  describe('Auth middleware blocks pending/rejected bots', () => {
    let orgId: string;
    let orgSecret: string;
    let pendingBotToken: string;
    let pendingBotId: string;
    let cookie: string;

    beforeAll(async () => {
      const org = await env.createOrg('test-auth-block');
      orgId = org.id;
      orgSecret = org.org_secret;
      cookie = await enableApproval(orgSecret);
      const ticket = await createTicket(orgId);
      const { data } = await registerWithTicket(orgId, ticket.id, 'blocked-bot');
      pendingBotToken = data.token;
      pendingBotId = data.bot_id || data.id;
    });

    it('pending bot gets 403 on API endpoints', async () => {
      const res = await fetch(`${env.baseUrl}/api/bots`, {
        headers: { Authorization: `Bearer ${pendingBotToken}` },
      });
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('BOT_NOT_ACTIVE');
      expect(data.join_status).toBe('pending');
    });

    it('rejected bot gets 403 on API endpoints', async () => {
      // Reject the bot first
      await changeBotStatus(cookie, pendingBotId, 'rejected', 'test rejection');

      const res = await fetch(`${env.baseUrl}/api/bots`, {
        headers: { Authorization: `Bearer ${pendingBotToken}` },
      });
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('BOT_NOT_ACTIVE');
      expect(data.join_status).toBe('rejected');
    });

    it('approved bot gets normal access', async () => {
      // Re-approve the bot
      await changeBotStatus(cookie, pendingBotId, 'active');

      const res = await fetch(`${env.baseUrl}/api/bots`, {
        headers: { Authorization: `Bearer ${pendingBotToken}` },
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('PATCH /api/org/bots/:bot_id/status', () => {
    let orgId: string;
    let orgSecret: string;
    let cookie: string;
    let botId: string;

    beforeAll(async () => {
      const org = await env.createOrg('test-status-change');
      orgId = org.id;
      orgSecret = org.org_secret;
      cookie = await enableApproval(orgSecret);
      const ticket = await createTicket(orgId);
      const { data } = await registerWithTicket(orgId, ticket.id, 'status-bot');
      botId = data.bot_id || data.id;
    });

    it('approve: pending → active', async () => {
      const { res, data } = await changeBotStatus(cookie, botId, 'active');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('active');
      expect(data.previous_status).toBe('pending');
    });

    it('idempotent: active → active returns 200', async () => {
      const { res, data } = await changeBotStatus(cookie, botId, 'active');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('active');
      expect(data.previous_status).toBe('active');
    });

    it('revoke: active → rejected', async () => {
      const { res, data } = await changeBotStatus(cookie, botId, 'rejected', 'policy violation');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('rejected');
      expect(data.previous_status).toBe('active');
      expect(data.join_status_reason).toBe('policy violation');
    });

    it('re-approve: rejected → active', async () => {
      const { res, data } = await changeBotStatus(cookie, botId, 'active');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('active');
      expect(data.previous_status).toBe('rejected');
    });

    it('invalid status returns 400', async () => {
      const { res } = await changeBotStatus(cookie, botId, 'invalid' as any);
      expect(res.status).toBe(400);
    });

    it('non-admin gets 403', async () => {
      // Register a member bot and try to change status with its token
      const ticket = await createTicket(orgId);
      // Re-approve first so member bot can connect
      const { data: memberData } = await registerWithTicket(orgId, ticket.id, 'member-bot-trying-admin');
      // Approve it so it can make API calls
      await changeBotStatus(cookie, memberData.bot_id || memberData.id, 'active');

      const res = await fetch(`${env.baseUrl}/api/org/bots/${botId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberData.token}` },
        body: JSON.stringify({ status: 'rejected' }),
      });
      expect(res.status).toBe(403);
    });

    it('wrong org bot returns 404', async () => {
      const otherOrg = await env.createOrg('other-org');
      const otherCookie = await env.loginAsOrg(otherOrg.org_secret);
      const { res } = await changeBotStatus(otherCookie, botId, 'rejected');
      expect(res.status).toBe(404);
    });
  });

  describe('WebSocket blocks pending/rejected bots', () => {
    it('pending bot WS connect gets 4403', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-ws-block');
      await enableApproval(org_secret);
      const ticket = await createTicket(orgId);
      const { data } = await registerWithTicket(orgId, ticket.id, 'ws-blocked-bot');

      // Get WS ticket
      const wsTicketRes = await fetch(`${env.baseUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.token}` },
      });
      // Should fail at auth level (403)
      expect(wsTicketRes.status).toBe(403);
    });
  });

  describe('Bot list visibility', () => {
    it('non-admin bots cannot see pending bots', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-visibility');
      // Register an active bot first (without approval)
      const activeBotResult = await env.registerBot(org_secret, 'active-viewer');

      // Enable approval and register a pending bot
      await enableApproval(org_secret);
      const ticket = await createTicket(orgId);
      await registerWithTicket(orgId, ticket.id, 'pending-hidden');

      // Active bot lists bots — should not see pending ones
      const res = await fetch(`${env.baseUrl}/api/bots`, {
        headers: { Authorization: `Bearer ${activeBotResult.token}` },
      });
      const bots = await res.json() as any[];
      const pendingBot = bots.find((b: any) => b.name === 'pending-hidden');
      expect(pendingBot).toBeUndefined();
    });
  });

  describe('Audit log', () => {
    it('records bot.join_status_changed on approval', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-audit');
      const cookie = await enableApproval(org_secret);
      const ticket = await createTicket(orgId);
      const { data } = await registerWithTicket(orgId, ticket.id, 'audit-bot');
      const botId = data.bot_id || data.id;

      // Approve
      await changeBotStatus(cookie, botId, 'active');

      // Check audit log
      const auditRes = await fetch(`${env.baseUrl}/api/audit?action=bot.join_status_changed`, {
        headers: { Cookie: `hxa_session=${cookie}`, Origin: env.baseUrl },
      });
      if (auditRes.ok) {
        const auditData = await auditRes.json() as any;
        const items = auditData.items || auditData;
        const entry = (Array.isArray(items) ? items : []).find(
          (a: any) => a.target_id === botId && a.action === 'bot.join_status_changed'
        );
        expect(entry).toBeDefined();
      }
    });
  });

  // ─── Plan B+C: Admin Notification Tests ─────────────────────

  /** Connect a WebSocket using an org_admin session cookie */
  async function connectAdminWs(cookie: string): Promise<WebSocket> {
    const { body } = await api(env.baseUrl, 'POST', '/api/ws-ticket', { cookie });
    const wsUrl = env.baseUrl.replace('http://', 'ws://') + `/ws?ticket=${body.ticket}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  /** Connect a WebSocket using a bot token */
  async function connectBotWs(token: string): Promise<WebSocket> {
    const { body } = await api(env.baseUrl, 'POST', '/api/ws-ticket', { token });
    const wsUrl = env.baseUrl.replace('http://', 'ws://') + `/ws?ticket=${body.ticket}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  function collectMessages(ws: WebSocket): any[] {
    const messages: any[] = [];
    ws.on('message', (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()));
    });
    return messages;
  }

  describe('Plan C: bot_join_request WS event to admins', () => {
    it('admin WS client receives bot_join_request when pending bot registers', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-ws-notify');
      const cookie = await enableApproval(org_secret);

      // Connect admin WS
      const adminWs = await connectAdminWs(cookie);
      const messages = collectMessages(adminWs);

      // Wait a bit for WS to stabilize
      await new Promise(r => setTimeout(r, 100));

      // Register a pending bot
      const ticket = await createTicket(orgId);
      await registerWithTicket(orgId, ticket.id, 'notified-bot');

      // Wait for WS events
      await new Promise(r => setTimeout(r, 300));

      const joinRequest = messages.find((m: any) => m.type === 'bot_join_request');
      expect(joinRequest).toBeDefined();
      expect(joinRequest.bot.name).toBe('notified-bot');
      expect(joinRequest.org_id).toBe(orgId);

      adminWs.close();
    });

    it('non-admin WS client does NOT receive bot_join_request', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-ws-no-notify-member');
      // Register admin bot + a member bot first (before enabling approval)
      const adminResult = await env.registerBot(org_secret, 'admin-for-notify');
      await env.promoteBot(org_secret, adminResult.bot.bot_id || adminResult.bot.id);
      const memberResult = await env.registerBot(org_secret, 'member-viewer');

      // Enable approval
      await enableApproval(org_secret);

      // Connect member WS
      const memberWs = await connectBotWs(memberResult.token);
      const messages = collectMessages(memberWs);

      await new Promise(r => setTimeout(r, 100));

      // Register a pending bot
      const ticket = await createTicket(orgId);
      await registerWithTicket(orgId, ticket.id, 'pending-no-notify');

      await new Promise(r => setTimeout(r, 300));

      // Member should get bot_registered but NOT bot_join_request
      const joinRequest = messages.find((m: any) => m.type === 'bot_join_request');
      expect(joinRequest).toBeUndefined();

      memberWs.close();
    });

    it('no bot_join_request when approval is not required', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-ws-no-approval');
      const cookie = await env.loginAsOrg(org_secret);

      // Connect admin WS (no approval enabled)
      const adminWs = await connectAdminWs(cookie);
      const messages = collectMessages(adminWs);

      await new Promise(r => setTimeout(r, 100));

      // Register a bot normally (no approval → active immediately)
      const ticket = await createTicket(orgId);
      await registerWithTicket(orgId, ticket.id, 'instant-bot');

      await new Promise(r => setTimeout(r, 300));

      // Should get bot_registered but NOT bot_join_request
      const joinRequest = messages.find((m: any) => m.type === 'bot_join_request');
      expect(joinRequest).toBeUndefined();

      const botRegistered = messages.find((m: any) => m.type === 'bot_registered' && m.bot?.name === 'instant-bot');
      expect(botRegistered).toBeDefined();
      expect(botRegistered.bot.join_status).toBe('active');

      adminWs.close();
    });
  });

  describe('Plan B: webhook notification to admin bots', () => {
    it('admin bot with webhook_url triggers delivery without breaking registration', async () => {
      const { id: orgId, org_secret } = await env.createOrg('test-webhook-notify');

      // Register admin bot normally, then set webhook_url directly in DB
      // (bypasses SSRF validation which blocks localhost in non-DEV_MODE)
      const adminResult = await env.registerBot(org_secret, 'webhook-admin');
      const adminBotId = adminResult.bot.bot_id || adminResult.bot.id;
      await env.promoteBot(org_secret, adminBotId);
      // Set webhook_url directly in DB (SSRF blocks http/localhost in tests)
      await (env.db as any).driver.run(
        'UPDATE bots SET webhook_url = ? WHERE id = ?',
        ['https://example.com/webhook', adminBotId],
      );

      // Enable approval
      await enableApproval(org_secret);

      // Register pending bot — should not throw despite webhook delivery to unreachable URL
      const ticket = await createTicket(orgId);
      const { res, data } = await registerWithTicket(orgId, ticket.id, 'pending-webhook-test');
      expect(res.ok).toBe(true);
      expect(data.join_status).toBe('pending');
    });
  });
});
