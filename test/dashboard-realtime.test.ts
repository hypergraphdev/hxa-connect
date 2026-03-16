import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Dashboard Real-Time Updates (#225)
// Tests: org_admin subscribe/unsubscribe, bot_registered broadcast,
//        thread event delivery after subscribe, unsubscribe cleanup
// ═══════════════════════════════════════════════════════════════

/** Connect a WebSocket using a bot token */
async function connectBotWs(baseUrl: string, token: string): Promise<WebSocket> {
  const { body } = await api(baseUrl, 'POST', '/api/ws-ticket', { token });
  const wsUrl = baseUrl.replace('http://', 'ws://') + `/ws?ticket=${body.ticket}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

/** Connect a WebSocket using an org_admin session cookie */
async function connectAdminWs(baseUrl: string, cookie: string): Promise<WebSocket> {
  const { body } = await api(baseUrl, 'POST', '/api/ws-ticket', { cookie });
  const wsUrl = baseUrl.replace('http://', 'ws://') + `/ws?ticket=${body.ticket}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

function waitFor(ws: WebSocket, predicate: (data: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      const data = JSON.parse(raw.toString());
      if (predicate(data)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(data);
      }
    };
    ws.on('message', handler);
  });
}

/** Collect all messages received within a time window */
function collectMessages(ws: WebSocket, durationMs = 500): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const handler = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()));
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

describe('Dashboard Real-Time Updates (#225)', () => {
  let env: TestEnv;
  let org: { id: string; org_secret: string };
  let bot1Token: string;
  let bot1Id: string;
  let adminCookie: string;

  beforeAll(async () => {
    env = await createTestEnv();
    org = await env.createOrg();

    // Register a bot
    const r1 = await env.registerBot(org.org_secret, 'alpha');
    bot1Token = r1.token;
    bot1Id = r1.bot.bot_id;

    // Login as org admin
    adminCookie = await env.loginAsOrg(org.org_secret);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  // ─── Subscribe / Unsubscribe ──────────────────────────────

  describe('subscribe / unsubscribe', () => {
    it('org_admin receives thread_message after subscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Bot creates a thread
        wsSend(botWs, {
          type: 'thread_create',
          topic: 'subscribe-test',
          ref: 'tc1',
        });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tc1');
        const threadId = ack.result.thread_id;

        // Admin subscribes to the thread
        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        // Small delay for subscribe to be processed
        await new Promise(r => setTimeout(r, 100));

        // Bot sends a message
        wsSend(botWs, {
          type: 'send_thread_message',
          thread_id: threadId,
          content: 'hello from alpha',
          ref: 'sm1',
        });

        // Admin should receive thread_message
        const msg = await waitFor(adminWs, d => d.type === 'thread_message' && d.thread_id === threadId);
        expect(msg.message.content).toBe('hello from alpha');
      } finally {
        adminWs.close();
        botWs.close();
      }
    });

    it('org_admin does NOT receive thread_message without subscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Bot creates a thread
        wsSend(botWs, {
          type: 'thread_create',
          topic: 'no-subscribe-test',
          ref: 'tc2',
        });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tc2');
        const threadId = ack.result.thread_id;

        // Drain any org-wide events (thread_created) before testing
        await collectMessages(adminWs, 300);

        // Bot sends a message — admin does NOT subscribe
        wsSend(botWs, {
          type: 'send_thread_message',
          thread_id: threadId,
          content: 'silent message',
          ref: 'sm2',
        });
        // Wait for bot ack to ensure message was sent
        await waitFor(botWs, d => d.type === 'ack' && d.ref === 'sm2');

        // Wait and collect — admin should NOT receive thread_message
        const messages = await collectMessages(adminWs, 500);
        const threadMsgs = messages.filter(m => m.type === 'thread_message');
        expect(threadMsgs).toHaveLength(0);
      } finally {
        adminWs.close();
        botWs.close();
      }
    });

    it('org_admin stops receiving after unsubscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Bot creates a thread
        wsSend(botWs, {
          type: 'thread_create',
          topic: 'unsub-test',
          ref: 'tc3',
        });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tc3');
        const threadId = ack.result.thread_id;

        // Subscribe then unsubscribe
        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        await new Promise(r => setTimeout(r, 100));
        wsSend(adminWs, { type: 'unsubscribe', thread_id: threadId });
        await new Promise(r => setTimeout(r, 100));

        // Bot sends a message
        wsSend(botWs, {
          type: 'send_thread_message',
          thread_id: threadId,
          content: 'after unsub',
          ref: 'sm3',
        });

        // Admin should NOT receive it
        const messages = await collectMessages(adminWs, 500);
        const threadMsgs = messages.filter(m => m.type === 'thread_message');
        expect(threadMsgs).toHaveLength(0);
      } finally {
        adminWs.close();
        botWs.close();
      }
    });

    it('subscribe is rejected for bot connections', async () => {
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        wsSend(botWs, { type: 'subscribe', thread_id: 'some-thread-id' });
        const err = await waitFor(botWs, d => d.type === 'error');
        expect(err.message).toContain('org admin');
      } finally {
        botWs.close();
      }
    });

    it('org_admin receives thread_participant after subscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      // Register a second bot to join later
      const r2 = await env.registerBot(org.org_secret, 'beta-join');
      const bot2Ws = await connectBotWs(env.baseUrl, r2.token);

      try {
        // Bot creates a thread
        wsSend(botWs, {
          type: 'thread_create',
          topic: 'participant-test',
          ref: 'tc4',
        });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tc4');
        const threadId = ack.result.thread_id;

        // Admin subscribes
        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        await new Promise(r => setTimeout(r, 100));

        // Second bot joins
        wsSend(bot2Ws, {
          type: 'thread_join',
          thread_id: threadId,
          ref: 'tj1',
        });

        // Admin should receive thread_participant
        const evt = await waitFor(adminWs, d => d.type === 'thread_participant' && d.action === 'joined' && d.bot_name === 'beta-join');
        expect(evt.thread_id).toBe(threadId);
      } finally {
        adminWs.close();
        botWs.close();
        bot2Ws.close();
      }
    });

    it('org_admin receives thread_updated after subscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Bot creates a thread
        wsSend(botWs, {
          type: 'thread_create',
          topic: 'status-test',
          ref: 'tc5',
        });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tc5');
        const threadId = ack.result.thread_id;

        // Admin subscribes
        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        await new Promise(r => setTimeout(r, 100));

        // Bot updates thread status via WS (broadcasts thread_updated, not thread_status_changed)
        wsSend(botWs, {
          type: 'thread_update',
          thread_id: threadId,
          status: 'resolved',
          ref: 'tu1',
        });

        // Admin should receive thread_updated with status in changes
        const evt = await waitFor(adminWs, d => d.type === 'thread_updated' && d.thread?.id === threadId);
        expect(evt.changes).toContain('status');
        expect(evt.thread.status).toBe('resolved');
      } finally {
        adminWs.close();
        botWs.close();
      }
    });

    it('org_admin always receives thread_created without subscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Bot creates a thread — admin should see it without any subscribe
        wsSend(botWs, {
          type: 'thread_create',
          topic: 'org-wide-test',
          ref: 'tc6',
        });

        const evt = await waitFor(adminWs, d => d.type === 'thread_created');
        expect(evt.thread.topic).toBe('org-wide-test');
      } finally {
        adminWs.close();
        botWs.close();
      }
    });
  });

  // ─── bot_registered Broadcast ─────────────────────────────

  describe('bot_registered broadcast', () => {
    it('org_admin receives bot_registered when a bot registers via ticket', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);

      try {
        // Register a new bot — this should broadcast bot_registered
        const regPromise = env.registerBot(org.org_secret, 'gamma-new');
        const evt = await waitFor(adminWs, d => d.type === 'bot_registered');
        const reg = await regPromise;

        expect(evt.bot.name).toBe('gamma-new');
        expect(evt.bot.id).toBe(reg.bot.bot_id);
      } finally {
        adminWs.close();
      }
    });

    it('org_admin receives bot_registered when a bot registers via org_secret', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);

      try {
        // Register via org_secret path (direct, no ticket)
        const regPromise = fetch(`${env.baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            org_id: org.id,
            org_secret: org.org_secret,
            name: 'delta-admin',
          }),
        });
        const evt = await waitFor(adminWs, d => d.type === 'bot_registered' && d.bot.name === 'delta-admin');
        const res = await regPromise;
        const data = await res.json() as any;

        expect(evt.bot.id).toBe(data.bot_id);
      } finally {
        adminWs.close();
      }
    });

    it('bot clients also receive bot_registered', async () => {
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Set up listener BEFORE registering the new bot
        const evtPromise = waitFor(botWs, d => d.type === 'bot_registered' && d.bot.name === 'epsilon-new');
        // Small delay to ensure listener is active
        await new Promise(r => setTimeout(r, 50));
        await env.registerBot(org.org_secret, 'epsilon-new');
        const evt = await evtPromise;
        expect(evt.bot.name).toBe('epsilon-new');
      } finally {
        botWs.close();
      }
    });

    it('bot_registered is NOT received by other orgs', async () => {
      const org2 = await env.createOrg('isolated-org');
      const r = await env.registerBot(org2.org_secret, 'iso-bot');
      const isoWs = await connectBotWs(env.baseUrl, r.token);
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);

      try {
        // Register a bot in org2 — admin of org1 should NOT see it
        await env.registerBot(org2.org_secret, 'cross-org-bot');

        // Collect messages — should not include bot_registered for cross-org-bot
        const messages = await collectMessages(adminWs, 500);
        const regEvents = messages.filter(m => m.type === 'bot_registered' && m.bot.name === 'cross-org-bot');
        expect(regEvents).toHaveLength(0);
      } finally {
        isoWs.close();
        adminWs.close();
      }
    });
  });

  // ─── Multiple Subscriptions ───────────────────────────────

  describe('subscription edge cases', () => {
    it('switching subscription between threads', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        // Create two threads
        wsSend(botWs, { type: 'thread_create', topic: 'thread-A', ref: 'tca' });
        const ackA = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tca');
        const threadA = ackA.result.thread_id;

        wsSend(botWs, { type: 'thread_create', topic: 'thread-B', ref: 'tcb' });
        const ackB = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tcb');
        const threadB = ackB.result.thread_id;

        // Subscribe to A, then switch to B
        wsSend(adminWs, { type: 'subscribe', thread_id: threadA });
        await new Promise(r => setTimeout(r, 100));
        wsSend(adminWs, { type: 'unsubscribe', thread_id: threadA });
        wsSend(adminWs, { type: 'subscribe', thread_id: threadB });
        await new Promise(r => setTimeout(r, 100));

        // Drain any pending events from thread_created
        await collectMessages(adminWs, 300);

        // Send to thread A — should NOT arrive (unsubscribed)
        wsSend(botWs, {
          type: 'send_thread_message',
          thread_id: threadA,
          content: 'msg to A',
          ref: 'sma',
        });
        // Wait for bot ack to confirm message sent
        await waitFor(botWs, d => d.type === 'ack' && d.ref === 'sma');

        // Verify admin did NOT receive thread A message
        const noMsg = await collectMessages(adminWs, 300);
        const threadAMsgs = noMsg.filter(m => m.type === 'thread_message' && m.thread_id === threadA);
        expect(threadAMsgs).toHaveLength(0);

        // Send to thread B — SHOULD arrive (subscribed)
        wsSend(botWs, {
          type: 'send_thread_message',
          thread_id: threadB,
          content: 'msg to B',
          ref: 'smb',
        });

        const msg = await waitFor(adminWs, d => d.type === 'thread_message');
        expect(msg.thread_id).toBe(threadB);
        expect(msg.message.content).toBe('msg to B');
      } finally {
        adminWs.close();
        botWs.close();
      }
    });

    it('org_admin receives thread_artifact after subscribing', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        wsSend(botWs, { type: 'thread_create', topic: 'artifact-test', ref: 'tca' });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tca');
        const threadId = ack.result.thread_id;

        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        await new Promise(r => setTimeout(r, 100));

        // Bot adds an artifact
        wsSend(botWs, {
          type: 'artifact_add',
          thread_id: threadId,
          artifact_key: 'report',
          type_field: 'markdown',
          title: 'Report',
          body: '## Test Report',
          ref: 'aa1',
        });

        const evt = await waitFor(adminWs, d => d.type === 'thread_artifact' && d.thread_id === threadId);
        expect(evt.artifact.artifact_key).toBe('report');
        expect(evt.action).toBe('added');
      } finally {
        adminWs.close();
        botWs.close();
      }
    });

    it('subscription count is limited to 100', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);

      try {
        // Subscribe to 100 fake thread IDs
        for (let i = 0; i < 100; i++) {
          wsSend(adminWs, { type: 'subscribe', thread_id: `fake-thread-${i}` });
        }
        await new Promise(r => setTimeout(r, 200));

        // 101st should be rejected
        wsSend(adminWs, { type: 'subscribe', thread_id: 'overflow-thread' });
        const err = await waitFor(adminWs, d => d.type === 'error' && d.message?.includes('limit'));
        expect(err.message).toContain('100');
      } finally {
        adminWs.close();
      }
    });

    it('subscribing to same thread twice is idempotent', async () => {
      const adminWs = await connectAdminWs(env.baseUrl, adminCookie);
      const botWs = await connectBotWs(env.baseUrl, bot1Token);

      try {
        wsSend(botWs, { type: 'thread_create', topic: 'double-sub', ref: 'tcds' });
        const ack = await waitFor(botWs, d => d.type === 'ack' && d.ref === 'tcds');
        const threadId = ack.result.thread_id;

        // Subscribe twice
        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        wsSend(adminWs, { type: 'subscribe', thread_id: threadId });
        await new Promise(r => setTimeout(r, 100));

        wsSend(botWs, {
          type: 'send_thread_message',
          thread_id: threadId,
          content: 'double test',
          ref: 'smds',
        });

        // Should receive exactly one message (not duplicated)
        const msg = await waitFor(adminWs, d => d.type === 'thread_message');
        expect(msg.message.content).toBe('double test');

        // Collect more — should be no duplicate
        const extras = await collectMessages(adminWs, 300);
        const dups = extras.filter(m => m.type === 'thread_message' && m.message?.content === 'double test');
        expect(dups).toHaveLength(0);
      } finally {
        adminWs.close();
        botWs.close();
      }
    });
  });
});
