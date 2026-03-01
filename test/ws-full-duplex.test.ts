import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// WS Full-Duplex Operations — comprehensive tests
// Tests: send, send_dm, send_thread_message, thread_create,
//        thread_update, thread_invite, thread_join, thread_leave,
//        thread_remove_participant, artifact_add, artifact_update
// Coverage: happy path, scope, cross-org, rate-limit, terminal,
//           revision-conflict, ref
// ═══════════════════════════════════════════════════════════════

/** Connect a WebSocket client using a bot token */
async function connectWs(baseUrl: string, token: string): Promise<WebSocket> {
  // Get a WS ticket
  const { body } = await api(baseUrl, 'POST', '/api/ws-ticket', { token });
  const ticket = body.ticket;
  const wsUrl = baseUrl.replace('http://', 'ws://') + `/ws?ticket=${ticket}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

/** Send a message and wait for a specific response type */
function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

/** Wait for the next message matching a predicate */
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

/** Wait for an ack with a specific ref */
function waitForAck(ws: WebSocket, ref: string, timeoutMs = 3000): Promise<any> {
  return waitFor(ws, d => d.type === 'ack' && d.ref === ref, timeoutMs);
}

/** Wait for an error with a specific ref */
function waitForError(ws: WebSocket, ref: string, timeoutMs = 3000): Promise<any> {
  return waitFor(ws, d => d.type === 'error' && d.ref === ref, timeoutMs);
}

describe('WS Full-Duplex Operations', () => {
  let env: TestEnv;
  let org: { id: string; org_secret: string };
  let org2: { id: string; org_secret: string };
  let bot1Token: string;
  let bot2Token: string;
  let bot3Token: string;
  let crossOrgBotToken: string;
  let bot1Id: string;
  let bot2Id: string;
  let bot3Id: string;
  let ws1: WebSocket;
  let ws2: WebSocket;

  beforeAll(async () => {
    env = await createTestEnv();
    org = env.createOrg();
    org2 = env.createOrg('other-org');

    const r1 = await env.registerBot(org.org_secret, 'alice');
    const r2 = await env.registerBot(org.org_secret, 'bob');
    const r3 = await env.registerBot(org.org_secret, 'charlie');
    const r4 = await env.registerBot(org2.org_secret, 'cross-org-bot');

    bot1Token = r1.token;
    bot2Token = r2.token;
    bot3Token = r3.token;
    crossOrgBotToken = r4.token;
    bot1Id = r1.bot.id;
    bot2Id = r2.bot.id;
    bot3Id = r3.bot.id;

    ws1 = await connectWs(env.baseUrl, bot1Token);
    ws2 = await connectWs(env.baseUrl, bot2Token);
  });

  afterAll(async () => {
    ws1?.close();
    ws2?.close();
    await env.cleanup();
  });

  // ─── send (channel message) ────────────────────────────────

  describe('send', () => {
    let channelId: string;

    beforeAll(async () => {
      // Create a DM channel (auto-created via send API)
      const { body } = await api(env.baseUrl, 'POST', '/api/send', {
        token: bot1Token,
        body: { to: bot2Id, content: 'init' },
      });
      channelId = body.channel_id;
    });

    it('happy: sends channel message and receives ack', async () => {
      const ref = 'send-1';
      wsSend(ws1, { type: 'send', channel_id: channelId, content: 'hello', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('send');
      expect(ack.result.message_id).toBeTypeOf('string');
      expect(ack.result.channel_id).toBe(channelId);
      expect(ack.result.timestamp).toBeTypeOf('number');
    });

    it('fail: not a member of channel', async () => {
      const ref = 'send-2';
      const ws3 = await connectWs(env.baseUrl, bot3Token);
      wsSend(ws3, { type: 'send', channel_id: channelId, content: 'hi', ref });
      const err = await waitForError(ws3, ref);
      expect(err.message).toContain('Not a member');
      ws3.close();
    });

    it('fail: missing content', async () => {
      const ref = 'send-3';
      wsSend(ws1, { type: 'send', channel_id: channelId, ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('content or parts is required');
    });
  });

  // ─── send_dm ───────────────────────────────────────────────

  describe('send_dm', () => {
    it('happy: sends DM and receives ack with channel_id', async () => {
      const ref = 'dm-1';
      wsSend(ws1, { type: 'send_dm', to: 'bob', content: 'hey bob', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('send_dm');
      expect(ack.result.channel_id).toBeTypeOf('string');
      expect(ack.result.message_id).toBeTypeOf('string');
    });

    it('fail: bot not found', async () => {
      const ref = 'dm-2';
      wsSend(ws1, { type: 'send_dm', to: 'nonexistent', content: 'hi', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('fail: cannot send to yourself', async () => {
      const ref = 'dm-3';
      wsSend(ws1, { type: 'send_dm', to: 'alice', content: 'hi me', ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('Cannot send to yourself');
    });
  });

  // ─── send_thread_message ───────────────────────────────────

  describe('send_thread_message', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'msg-test', participants: [bot2Id] },
      });
      threadId = body.id;
    });

    it('happy: sends thread message and gets ack', async () => {
      const ref = 'tmsg-1';
      wsSend(ws1, { type: 'send_thread_message', thread_id: threadId, content: 'hello thread', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('send_thread_message');
      expect(ack.result.message_id).toBeTypeOf('string');
      expect(ack.result.thread_id).toBe(threadId);
    });

    it('fail: not a participant', async () => {
      const ref = 'tmsg-2';
      const ws3 = await connectWs(env.baseUrl, bot3Token);
      wsSend(ws3, { type: 'send_thread_message', thread_id: threadId, content: 'hi', ref });
      const err = await waitForError(ws3, ref);
      expect(err.code).toBe('JOIN_REQUIRED');
      ws3.close();
    });

    it('fail: thread not found', async () => {
      const ref = 'tmsg-3';
      wsSend(ws1, { type: 'send_thread_message', thread_id: 'nonexistent-id', content: 'hi', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // ─── thread_create ─────────────────────────────────────────

  describe('thread_create', () => {
    it('happy: creates thread and gets ack with thread_id + revision', async () => {
      const ref = 'tc-1';
      wsSend(ws1, { type: 'thread_create', topic: 'ws-created-thread', participants: ['bob'], ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('thread_create');
      expect(ack.result.thread_id).toBeTypeOf('string');
      expect(ack.result.topic).toBe('ws-created-thread');
      expect(ack.result.revision).toBe(1);
      expect(ack.result.timestamp).toBeTypeOf('number');
    });

    it('fail: missing topic', async () => {
      const ref = 'tc-2';
      wsSend(ws1, { type: 'thread_create', ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('topic is required');
    });

    it('fail: participant not found', async () => {
      const ref = 'tc-3';
      wsSend(ws1, { type: 'thread_create', topic: 'test', participants: ['nonexistent'], ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('Bot not found');
    });
  });

  // ─── thread_update ─────────────────────────────────────────

  describe('thread_update', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'update-test', participants: [bot2Id] },
      });
      threadId = body.id;
    });

    it('happy: updates topic and gets ack with revision', async () => {
      const ref = 'tu-1';
      wsSend(ws1, { type: 'thread_update', thread_id: threadId, topic: 'updated-topic', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('thread_update');
      expect(ack.result.changes).toContain('topic');
      expect(ack.result.revision).toBeGreaterThan(1);
    });

    it('happy: expected_revision succeeds when matching', async () => {
      // Fetch current revision
      const { body: thread } = await api(env.baseUrl, 'GET', `/api/threads/${threadId}`, { token: bot1Token });
      const ref = 'tu-rev-1';
      wsSend(ws1, { type: 'thread_update', thread_id: threadId, topic: 'rev-topic', expected_revision: thread.revision, ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.revision).toBe(thread.revision + 1);
    });

    it('fail: REVISION_CONFLICT when expected_revision mismatches', async () => {
      const ref = 'tu-rev-2';
      wsSend(ws1, { type: 'thread_update', thread_id: threadId, topic: 'stale', expected_revision: 1, ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('REVISION_CONFLICT');
    });

    it('fail: terminal thread rejects non-status updates', async () => {
      // Close the thread
      await api(env.baseUrl, 'PATCH', `/api/threads/${threadId}`, {
        token: bot1Token,
        body: { status: 'closed', close_reason: 'manual' },
      });
      const ref = 'tu-term-1';
      wsSend(ws1, { type: 'thread_update', thread_id: threadId, topic: 'new topic', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('THREAD_CLOSED');
    });
  });

  // ─── thread_invite ─────────────────────────────────────────

  describe('thread_invite', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'invite-test' },
      });
      threadId = body.id;
    });

    it('happy: invites a bot and gets ack', async () => {
      const ref = 'ti-1';
      wsSend(ws1, { type: 'thread_invite', thread_id: threadId, bot_id: 'bob', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('thread_invite');
      expect(ack.result.bot_id).toBe(bot2Id);
      expect(ack.result.already_joined).toBe(false);
    });

    it('happy: re-invite is idempotent', async () => {
      const ref = 'ti-2';
      wsSend(ws1, { type: 'thread_invite', thread_id: threadId, bot_id: 'bob', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.already_joined).toBe(true);
    });

    it('fail: bot not found', async () => {
      const ref = 'ti-3';
      wsSend(ws1, { type: 'thread_invite', thread_id: threadId, bot_id: 'nonexistent', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // ─── thread_join ───────────────────────────────────────────

  describe('thread_join', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'join-test' },
      });
      threadId = body.id;
    });

    it('happy: joins thread and gets ack', async () => {
      const ref = 'tj-1';
      wsSend(ws2, { type: 'thread_join', thread_id: threadId, ref });
      const ack = await waitForAck(ws2, ref);
      expect(ack.result.operation).toBe('thread_join');
      expect(ack.result.status).toBe('joined');
      expect(ack.result.joined_at).toBeTypeOf('number');
    });

    it('happy: re-join is idempotent', async () => {
      const ref = 'tj-2';
      wsSend(ws2, { type: 'thread_join', thread_id: threadId, ref });
      const ack = await waitForAck(ws2, ref);
      expect(ack.result.status).toBe('already_joined');
    });

    it('fail: thread not found', async () => {
      const ref = 'tj-3';
      wsSend(ws1, { type: 'thread_join', thread_id: 'nonexistent', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // ─── thread_leave ──────────────────────────────────────────

  describe('thread_leave', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'leave-test', participants: [bot2Id, bot3Id] },
      });
      threadId = body.id;
    });

    it('happy: leaves thread and gets ack', async () => {
      const ref = 'tl-1';
      wsSend(ws2, { type: 'thread_leave', thread_id: threadId, ref });
      const ack = await waitForAck(ws2, ref);
      expect(ack.result.operation).toBe('thread_leave');
      expect(ack.result.thread_id).toBe(threadId);
    });

    it('fail: not a participant after leaving', async () => {
      const ref = 'tl-2';
      wsSend(ws2, { type: 'thread_leave', thread_id: threadId, ref });
      const err = await waitForError(ws2, ref);
      expect(err.code).toBe('JOIN_REQUIRED');
    });

    it('fail: cannot leave as last participant', async () => {
      // Remove charlie via API so only alice is left
      await api(env.baseUrl, 'DELETE', `/api/threads/${threadId}/participants/charlie`, { token: bot1Token });
      const ref = 'tl-3';
      wsSend(ws1, { type: 'thread_leave', thread_id: threadId, ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('last participant');
    });
  });

  // ─── thread_remove_participant ─────────────────────────────

  describe('thread_remove_participant', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'remove-test', participants: [bot2Id, bot3Id] },
      });
      threadId = body.id;
    });

    it('happy: removes another participant', async () => {
      const ref = 'trp-1';
      wsSend(ws1, { type: 'thread_remove_participant', thread_id: threadId, bot_id: 'charlie', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('thread_remove_participant');
      expect(ack.result.bot_id).toBe(bot3Id);
    });

    it('fail: target not a participant', async () => {
      const ref = 'trp-2';
      wsSend(ws1, { type: 'thread_remove_participant', thread_id: threadId, bot_id: 'charlie', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('fail: cannot remove last participant', async () => {
      // Remove bob so only alice left
      const ref1 = 'trp-3a';
      wsSend(ws1, { type: 'thread_remove_participant', thread_id: threadId, bot_id: 'bob', ref: ref1 });
      await waitForAck(ws1, ref1);

      // Try to remove alice (self) — last participant
      const ref2 = 'trp-3b';
      wsSend(ws1, { type: 'thread_remove_participant', thread_id: threadId, bot_id: 'alice', ref: ref2 });
      const err = await waitForError(ws1, ref2);
      expect(err.message).toContain('last participant');
    });
  });

  // ─── artifact_add ──────────────────────────────────────────

  describe('artifact_add', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'artifact-test', participants: [bot2Id] },
      });
      threadId = body.id;
    });

    it('happy: adds artifact and gets ack with version', async () => {
      const ref = 'aa-1';
      wsSend(ws1, {
        type: 'artifact_add',
        thread_id: threadId,
        artifact_key: 'summary',
        artifact_type: 'markdown',
        content: '# Summary\nTest content',
        ref,
      });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('artifact_add');
      expect(ack.result.artifact_key).toBe('summary');
      expect(ack.result.version).toBe(1);
    });

    it('fail: duplicate key', async () => {
      const ref = 'aa-2';
      wsSend(ws1, { type: 'artifact_add', thread_id: threadId, artifact_key: 'summary', content: 'dup', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('CONFLICT');
    });

    it('fail: invalid artifact_key', async () => {
      const ref = 'aa-3';
      wsSend(ws1, { type: 'artifact_add', thread_id: threadId, artifact_key: 'invalid key!', content: 'x', ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('artifact_key');
    });
  });

  // ─── artifact_update ───────────────────────────────────────

  describe('artifact_update', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'artifact-update-test', participants: [bot2Id] },
      });
      threadId = body.id;

      // Create an artifact first
      await api(env.baseUrl, 'POST', `/api/threads/${threadId}/artifacts`, {
        token: bot1Token,
        body: { artifact_key: 'doc', type: 'text', content: 'v1' },
      });
    });

    it('happy: updates artifact and gets ack with new version', async () => {
      const ref = 'au-1';
      wsSend(ws1, { type: 'artifact_update', thread_id: threadId, artifact_key: 'doc', content: 'v2 content', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.result.operation).toBe('artifact_update');
      expect(ack.result.version).toBe(2);
    });

    it('fail: artifact not found', async () => {
      const ref = 'au-2';
      wsSend(ws1, { type: 'artifact_update', thread_id: threadId, artifact_key: 'nonexistent', content: 'x', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('fail: content is required', async () => {
      const ref = 'au-3';
      wsSend(ws1, { type: 'artifact_update', thread_id: threadId, artifact_key: 'doc', ref });
      const err = await waitForError(ws1, ref);
      expect(err.message).toContain('content is required');
    });
  });

  // ─── Cross-org isolation ───────────────────────────────────

  describe('cross-org isolation', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'cross-org-test' },
      });
      threadId = body.id;
    });

    it('cross-org bot cannot access thread', async () => {
      const ws = await connectWs(env.baseUrl, crossOrgBotToken);
      const ref = 'xorg-1';
      wsSend(ws, { type: 'thread_join', thread_id: threadId, ref });
      const err = await waitForError(ws, ref);
      expect(err.code).toBe('FORBIDDEN');
      ws.close();
    });

    it('cross-org bot cannot send thread message', async () => {
      const ws = await connectWs(env.baseUrl, crossOrgBotToken);
      const ref = 'xorg-2';
      wsSend(ws, { type: 'send_thread_message', thread_id: threadId, content: 'hi', ref });
      const err = await waitForError(ws, ref);
      expect(err.code).toBe('FORBIDDEN');
      ws.close();
    });
  });

  // ─── Scoped token restriction ──────────────────────────────

  describe('scoped token restriction', () => {
    it('read-only scoped token cannot send messages', async () => {
      // Create scoped token with read-only scope via /api/me/tokens
      const { body: tokenBody } = await api(env.baseUrl, 'POST', '/api/me/tokens', {
        token: bot1Token,
        body: { scopes: ['read'], label: 'read-only' },
      });

      const ws = await connectWs(env.baseUrl, tokenBody.token);
      const ref = 'scope-1';
      wsSend(ws, { type: 'send_dm', to: 'bob', content: 'hi', ref });
      const err = await waitForError(ws, ref);
      expect(err.code).toBe('INSUFFICIENT_SCOPE');
      ws.close();
    });
  });

  // ─── Terminal thread operations ────────────────────────────

  describe('terminal thread operations', () => {
    let threadId: string;

    beforeAll(async () => {
      const { body } = await api(env.baseUrl, 'POST', '/api/threads', {
        token: bot1Token,
        body: { topic: 'terminal-test', participants: [bot2Id] },
      });
      threadId = body.id;
      // Resolve the thread
      await api(env.baseUrl, 'PATCH', `/api/threads/${threadId}`, {
        token: bot1Token,
        body: { status: 'resolved' },
      });
    });

    it('cannot send message to resolved thread', async () => {
      const ref = 'term-1';
      wsSend(ws1, { type: 'send_thread_message', thread_id: threadId, content: 'hi', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('THREAD_CLOSED');
    });

    it('cannot add artifact to resolved thread', async () => {
      const ref = 'term-2';
      wsSend(ws1, { type: 'artifact_add', thread_id: threadId, artifact_key: 'x', content: 'y', ref });
      const err = await waitForError(ws1, ref);
      expect(err.code).toBe('THREAD_CLOSED');
    });

    it('cannot join resolved thread', async () => {
      const ws3 = await connectWs(env.baseUrl, bot3Token);
      const ref = 'term-3';
      wsSend(ws3, { type: 'thread_join', thread_id: threadId, ref });
      const err = await waitForError(ws3, ref);
      expect(err.code).toBe('THREAD_CLOSED');
      ws3.close();
    });
  });

  // ─── Ref correlation ───────────────────────────────────────

  describe('ref correlation', () => {
    it('ack includes the ref from the request', async () => {
      const ref = 'ref-test-42';
      wsSend(ws1, { type: 'thread_create', topic: 'ref-test', ref });
      const ack = await waitForAck(ws1, ref);
      expect(ack.ref).toBe(ref);
    });

    it('error includes the ref from the request', async () => {
      const ref = 'ref-err-42';
      wsSend(ws1, { type: 'send_thread_message', thread_id: 'nonexistent', content: 'hi', ref });
      const err = await waitForError(ws1, ref);
      expect(err.ref).toBe(ref);
    });
  });

  // ─── ping/pong ─────────────────────────────────────────────

  describe('ping/pong', () => {
    it('responds with pong', async () => {
      wsSend(ws1, { type: 'ping' });
      const pong = await waitFor(ws1, d => d.type === 'pong');
      expect(pong.type).toBe('pong');
    });
  });
});
