/**
 * SessionStore contract tests — validates both SqliteSessionStore and
 * RedisSessionStore implement the SessionStore interface correctly.
 *
 * Redis tests require REDIS_URL to be set. Without it, Redis tests are skipped.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDriver } from '../src/db/index.js';
import { HubDB } from '../src/db.js';
import {
  SqliteSessionStore,
  RedisSessionStore,
  generateSessionId,
  type SessionStore,
} from '../src/session.js';
import type { Session, SessionRole } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: generateSessionId(),
    role: 'bot_owner' as SessionRole,
    bot_id: 'bot-001',
    org_id: 'org-001',
    owner_name: 'alice',
    scopes: ['full'],
    is_scoped_token: false,
    created_at: Date.now(),
    expires_at: Date.now() + 3600_000, // 1 hour
    ...overrides,
  };
}

// ─── Contract test suite (runs against any SessionStore) ──────

function sessionStoreContract(
  name: string,
  factory: () => Promise<{ store: SessionStore; cleanup: () => Promise<void> }>,
) {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const env = await factory();
      store = env.store;
      cleanup = env.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    // Clear state between tests — purge all sessions
    beforeEach(async () => {
      await store.purgeExpired();
    });

    it('get returns null for non-existent session', async () => {
      const result = await store.get('non-existent-id');
      expect(result).toBeNull();
    });

    it('set + get round-trips a session', async () => {
      const session = makeSession();
      await store.set(session);
      const fetched = await store.get(session.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(session.id);
      expect(fetched!.role).toBe(session.role);
      expect(fetched!.bot_id).toBe(session.bot_id);
      expect(fetched!.org_id).toBe(session.org_id);
      expect(fetched!.owner_name).toBe(session.owner_name);
      expect(fetched!.scopes).toEqual(session.scopes);
      expect(fetched!.is_scoped_token).toBe(session.is_scoped_token);
      expect(fetched!.created_at).toBe(session.created_at);
      expect(fetched!.expires_at).toBe(session.expires_at);
    });

    it('set overwrites existing session with same id (upsert)', async () => {
      const session = makeSession();
      await store.set(session);
      const updated = { ...session, owner_name: 'bob', expires_at: Date.now() + 7200_000 };
      await store.set(updated);
      const fetched = await store.get(session.id);
      expect(fetched!.owner_name).toBe('bob');
    });

    it('get returns null for expired session', async () => {
      const session = makeSession({ expires_at: Date.now() - 1000 });
      // For SQLite, expired sessions exist in DB but are filtered on read.
      // For Redis, TTL may prevent storage entirely.
      await store.set(session);
      const fetched = await store.get(session.id);
      expect(fetched).toBeNull();
    });

    it('delete removes a session', async () => {
      const session = makeSession();
      await store.set(session);
      expect(await store.get(session.id)).not.toBeNull();
      await store.delete(session.id);
      expect(await store.get(session.id)).toBeNull();
    });

    it('delete on non-existent id is a no-op', async () => {
      // Should not throw
      await store.delete('does-not-exist');
    });

    it('deleteByBotId removes all sessions for a bot', async () => {
      const botId = `bot-${generateSessionId().slice(0, 8)}`;
      const s1 = makeSession({ bot_id: botId });
      const s2 = makeSession({ bot_id: botId });
      const s3 = makeSession({ bot_id: 'other-bot' });
      await store.set(s1);
      await store.set(s2);
      await store.set(s3);

      const deleted = await store.deleteByBotId(botId);
      expect(deleted).toBe(2);
      expect(await store.get(s1.id)).toBeNull();
      expect(await store.get(s2.id)).toBeNull();
      expect(await store.get(s3.id)).not.toBeNull();

      // Cleanup
      await store.delete(s3.id);
    });

    it('deleteByRole removes sessions for a role', async () => {
      const orgId = `org-${generateSessionId().slice(0, 8)}`;
      const s1 = makeSession({ role: 'org_admin', org_id: orgId, bot_id: null });
      const s2 = makeSession({ role: 'org_admin', org_id: orgId, bot_id: null });
      const s3 = makeSession({ role: 'bot_owner', org_id: orgId });
      await store.set(s1);
      await store.set(s2);
      await store.set(s3);

      const deleted = await store.deleteByRole('org_admin', orgId);
      expect(deleted).toBe(2);
      expect(await store.get(s1.id)).toBeNull();
      expect(await store.get(s2.id)).toBeNull();
      expect(await store.get(s3.id)).not.toBeNull();

      // Cleanup
      await store.delete(s3.id);
    });

    it('deleteByRole without orgId removes all sessions of that role', async () => {
      const s1 = makeSession({ role: 'super_admin', org_id: null, bot_id: null });
      const s2 = makeSession({ role: 'super_admin', org_id: null, bot_id: null });
      const s3 = makeSession({ role: 'bot_owner' });
      await store.set(s1);
      await store.set(s2);
      await store.set(s3);

      const deleted = await store.deleteByRole('super_admin');
      expect(deleted).toBe(2);
      expect(await store.get(s1.id)).toBeNull();
      expect(await store.get(s2.id)).toBeNull();
      expect(await store.get(s3.id)).not.toBeNull();

      // Cleanup
      await store.delete(s3.id);
    });

    it('countByRole counts active sessions', async () => {
      const orgId = `org-${generateSessionId().slice(0, 8)}`;
      const botId = `bot-${generateSessionId().slice(0, 8)}`;
      const s1 = makeSession({ role: 'bot_owner', org_id: orgId, bot_id: botId });
      const s2 = makeSession({ role: 'bot_owner', org_id: orgId, bot_id: botId });
      const s3 = makeSession({ role: 'bot_owner', org_id: orgId, bot_id: 'other' });
      await store.set(s1);
      await store.set(s2);
      await store.set(s3);

      // Count by role only
      const countRole = await store.countByRole('bot_owner', orgId);
      expect(countRole).toBeGreaterThanOrEqual(3);

      // Count by role + bot
      const countBot = await store.countByRole('bot_owner', orgId, botId);
      expect(countBot).toBe(2);

      // Cleanup
      await store.delete(s1.id);
      await store.delete(s2.id);
      await store.delete(s3.id);
    });

    it('countByRole does not count expired sessions', async () => {
      const orgId = `org-${generateSessionId().slice(0, 8)}`;
      const botId = `bot-${generateSessionId().slice(0, 8)}`;
      const active = makeSession({ role: 'org_admin', org_id: orgId, bot_id: null });
      const expired = makeSession({
        role: 'org_admin',
        org_id: orgId,
        bot_id: null,
        expires_at: Date.now() - 1000,
      });
      await store.set(active);
      await store.set(expired);

      const count = await store.countByRole('org_admin', orgId);
      expect(count).toBe(1);

      // Cleanup
      await store.delete(active.id);
    });

    it('purgeExpired removes expired sessions', async () => {
      const active = makeSession();
      const expired = makeSession({ expires_at: Date.now() - 1000 });
      await store.set(active);
      await store.set(expired);

      await store.purgeExpired();

      expect(await store.get(active.id)).not.toBeNull();
      expect(await store.get(expired.id)).toBeNull();

      // Cleanup
      await store.delete(active.id);
    });

    it('handles sessions with null scopes', async () => {
      const session = makeSession({ scopes: null });
      await store.set(session);
      const fetched = await store.get(session.id);
      expect(fetched!.scopes).toBeNull();

      // Cleanup
      await store.delete(session.id);
    });

    it('handles sessions with is_scoped_token=true', async () => {
      const session = makeSession({ is_scoped_token: true, scopes: ['read', 'thread'] });
      await store.set(session);
      const fetched = await store.get(session.id);
      expect(fetched!.is_scoped_token).toBe(true);
      expect(fetched!.scopes).toEqual(['read', 'thread']);

      // Cleanup
      await store.delete(session.id);
    });

    it('upsert with changed bot_id does not leave stale index entries', async () => {
      const sessionId = generateSessionId();
      const botA = `bot-a-${sessionId.slice(0, 8)}`;
      const botB = `bot-b-${sessionId.slice(0, 8)}`;

      // Create session with bot_id=A
      const session = makeSession({ id: sessionId, bot_id: botA });
      await store.set(session);
      expect(await store.countByRole('bot_owner', session.org_id!, botA)).toBe(1);

      // Upsert same session ID with bot_id=B
      const updated = { ...session, bot_id: botB };
      await store.set(updated);

      // deleteByBotId(A) must NOT delete the session (it now belongs to B)
      const deletedA = await store.deleteByBotId(botA);
      expect(deletedA).toBe(0);
      expect(await store.get(sessionId)).not.toBeNull();

      // deleteByBotId(B) should delete it
      const deletedB = await store.deleteByBotId(botB);
      expect(deletedB).toBe(1);
      expect(await store.get(sessionId)).toBeNull();
    });

    it('upsert with changed role does not leave stale index entries', async () => {
      const sessionId = generateSessionId();
      const orgId = `org-role-${sessionId.slice(0, 8)}`;

      // Create as org_admin
      const session = makeSession({
        id: sessionId,
        role: 'org_admin',
        org_id: orgId,
        bot_id: null,
      });
      await store.set(session);
      expect(await store.countByRole('org_admin', orgId)).toBe(1);

      // Upsert same session ID as bot_owner
      const updated: Session = {
        ...session,
        role: 'bot_owner',
        bot_id: `bot-${sessionId.slice(0, 8)}`,
      };
      await store.set(updated);

      // deleteByRole('org_admin', orgId) must NOT delete the session
      const deletedOld = await store.deleteByRole('org_admin', orgId);
      expect(deletedOld).toBe(0);
      expect(await store.get(sessionId)).not.toBeNull();

      // Cleanup
      await store.delete(sessionId);
    });

    it('handles super_admin with null org_id and bot_id', async () => {
      const session = makeSession({
        role: 'super_admin',
        org_id: null,
        bot_id: null,
        owner_name: null,
      });
      await store.set(session);
      const fetched = await store.get(session.id);
      expect(fetched!.role).toBe('super_admin');
      expect(fetched!.org_id).toBeNull();
      expect(fetched!.bot_id).toBeNull();

      // Cleanup
      await store.delete(session.id);
    });
  });
}

// ─── SQLite implementation ────────────────────────────────────

sessionStoreContract('SqliteSessionStore', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  const dbPath = path.join(dataDir, 'test.db');
  const driver = new SqliteDriver(dbPath);
  const db = new HubDB(driver);
  await db.init();
  const store = new SqliteSessionStore(driver);

  return {
    store,
    cleanup: async () => {
      await db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
});

// ─── Redis implementation (requires REDIS_URL) ───────────────

const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('SessionStore contract: RedisSessionStore', () => {
  let store: RedisSessionStore;
  let redis: InstanceType<typeof import('ioredis').default>;
  const prefix = `hxa-test-${Date.now()}:`;

  beforeAll(async () => {
    const { default: IORedis } = await import('ioredis');
    redis = new IORedis(redisUrl!);
    store = new RedisSessionStore(redis, prefix);
  });

  afterAll(async () => {
    // Clean up all test keys
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
    await (store as RedisSessionStore).close();
  });

  it('get returns null for non-existent session', async () => {
    expect(await store.get('non-existent')).toBeNull();
  });

  it('set + get round-trips a session', async () => {
    const session = makeSession();
    await store.set(session);
    const fetched = await store.get(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(session.id);
    expect(fetched!.role).toBe(session.role);
    expect(fetched!.scopes).toEqual(session.scopes);
    await store.delete(session.id);
  });

  it('expired sessions are not returned', async () => {
    const session = makeSession({ expires_at: Date.now() - 1000 });
    await store.set(session);
    expect(await store.get(session.id)).toBeNull();
  });

  it('deleteByBotId removes matching sessions', async () => {
    const botId = `bot-redis-${Date.now()}`;
    const s1 = makeSession({ bot_id: botId });
    const s2 = makeSession({ bot_id: botId });
    await store.set(s1);
    await store.set(s2);
    const deleted = await store.deleteByBotId(botId);
    expect(deleted).toBe(2);
    expect(await store.get(s1.id)).toBeNull();
    expect(await store.get(s2.id)).toBeNull();
  });

  it('deleteByRole with orgId removes matching sessions', async () => {
    const orgId = `org-redis-${Date.now()}`;
    const s1 = makeSession({ role: 'org_admin', org_id: orgId, bot_id: null });
    const s2 = makeSession({ role: 'org_admin', org_id: orgId, bot_id: null });
    const s3 = makeSession({ role: 'bot_owner', org_id: orgId });
    await store.set(s1);
    await store.set(s2);
    await store.set(s3);
    const deleted = await store.deleteByRole('org_admin', orgId);
    expect(deleted).toBe(2);
    expect(await store.get(s3.id)).not.toBeNull();
    await store.delete(s3.id);
  });

  it('countByRole counts only active sessions', async () => {
    const orgId = `org-count-${Date.now()}`;
    const botId = `bot-count-${Date.now()}`;
    const s1 = makeSession({ role: 'bot_owner', org_id: orgId, bot_id: botId });
    const s2 = makeSession({ role: 'bot_owner', org_id: orgId, bot_id: botId });
    await store.set(s1);
    await store.set(s2);
    const count = await store.countByRole('bot_owner', orgId, botId);
    expect(count).toBe(2);
    await store.delete(s1.id);
    await store.delete(s2.id);
  });

  it('purgeExpired cleans stale index entries', async () => {
    // Insert then manually expire by deleting the key
    const session = makeSession({ role: 'org_admin', org_id: 'purge-org', bot_id: null });
    await store.set(session);
    // Manually remove the session key to simulate expiry
    await redis.del(`${prefix}sess:${session.id}`);
    await store.purgeExpired();
    // Index should be cleaned
    const members = await redis.smembers(`${prefix}idx:role:org_admin`);
    expect(members).not.toContain(session.id);
  });
});
