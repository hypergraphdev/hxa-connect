import crypto from 'node:crypto';
import type Redis from 'ioredis';
import type { DatabaseDriver } from './db/driver.js';
import type { Session, SessionRole, TokenScope } from './types.js';

// ─── SessionStore Interface ──────────────────────────────────

export interface SessionStore {
  get(id: string): Promise<Session | null>;
  set(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByBotId(botId: string): Promise<number>;
  deleteByRole(role: string, orgId?: string): Promise<number>;
  countByRole(role: string, orgId?: string, botId?: string): Promise<number>;
  purgeExpired(): Promise<void>;
  /** List active sessions for an org, ordered by created_at DESC. */
  listByOrg(orgId: string, opts?: { limit?: number; offset?: number }): Promise<Session[]>;
}

// ─── Session Helpers ─────────────────────────────────────────

/** Generate a cryptographically secure session ID (256-bit). */
export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Session TTLs by role (milliseconds). */
export const SESSION_TTL: Record<SessionRole, number> = {
  bot_owner: 24 * 60 * 60 * 1000,   // 24h
  org_admin: 8 * 60 * 60 * 1000,    // 8h
  super_admin: 4 * 60 * 60 * 1000,  // 4h
};

/** Maximum concurrent sessions per role. */
export const SESSION_LIMIT: Record<SessionRole, number> = {
  bot_owner: 5,    // per bot
  org_admin: 5,    // per org
  super_admin: 3,  // global
};

/** Cookie name for session ID. */
export const SESSION_COOKIE = 'hxa_session';

// ─── SqliteSessionStore ──────────────────────────────────────

export class SqliteSessionStore implements SessionStore {
  constructor(private driver: DatabaseDriver) {}

  async get(id: string): Promise<Session | null> {
    const row = await this.driver.get(
      'SELECT * FROM sessions WHERE id = ? AND expires_at > ?',
      [id, Date.now()],
    );
    return row ? this.rowToSession(row) : null;
  }

  async set(session: Session): Promise<void> {
    await this.driver.run(
      `INSERT INTO sessions (id, role, org_id, bot_id, owner_name, scopes, is_scoped_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         org_id = excluded.org_id,
         bot_id = excluded.bot_id,
         owner_name = excluded.owner_name,
         scopes = excluded.scopes,
         is_scoped_token = excluded.is_scoped_token,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
      [
        session.id,
        session.role,
        session.org_id,
        session.bot_id,
        session.owner_name,
        session.scopes ? JSON.stringify(session.scopes) : null,
        session.is_scoped_token ? 1 : 0,
        session.created_at,
        session.expires_at,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.driver.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  async deleteByBotId(botId: string): Promise<number> {
    const result = await this.driver.run(
      'DELETE FROM sessions WHERE bot_id = ?',
      [botId],
    );
    return result.changes ?? 0;
  }

  async deleteByRole(role: string, orgId?: string): Promise<number> {
    if (orgId) {
      const result = await this.driver.run(
        'DELETE FROM sessions WHERE role = ? AND org_id = ?',
        [role, orgId],
      );
      return result.changes ?? 0;
    }
    const result = await this.driver.run(
      'DELETE FROM sessions WHERE role = ?',
      [role],
    );
    return result.changes ?? 0;
  }

  async countByRole(role: string, orgId?: string, botId?: string): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM sessions WHERE role = ? AND expires_at > ?';
    const params: unknown[] = [role, Date.now()];

    if (orgId) {
      sql += ' AND org_id = ?';
      params.push(orgId);
    }
    if (botId) {
      sql += ' AND bot_id = ?';
      params.push(botId);
    }

    const row = await this.driver.get(sql, params);
    return (row as any)?.count ?? 0;
  }

  async purgeExpired(): Promise<void> {
    await this.driver.run(
      'DELETE FROM sessions WHERE expires_at < ?',
      [Date.now()],
    );
  }

  async listByOrg(orgId: string, opts?: { limit?: number; offset?: number }): Promise<Session[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    const offset = opts?.offset ?? 0;
    const rows = await this.driver.all(
      'SELECT * FROM sessions WHERE org_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [orgId, Date.now(), limit, offset],
    );
    return rows.map((r: any) => this.rowToSession(r));
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      role: row.role as SessionRole,
      bot_id: row.bot_id ?? null,
      org_id: row.org_id ?? null,
      owner_name: row.owner_name ?? null,
      scopes: row.scopes ? JSON.parse(row.scopes) as TokenScope[] : null,
      is_scoped_token: !!row.is_scoped_token,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }
}

// ─── RedisSessionStore ───────────────────────────────────────
//
// Key layout:
//   sess:{id}              → JSON string of Session
//   idx:role:{role}        → SET of session IDs
//   idx:org:{orgId}        → SET of session IDs
//   idx:bot:{botId}        → SET of session IDs
//
// Each session key has a PEXPIREAT matching session.expires_at so Redis
// auto-evicts expired sessions. Index sets are cleaned lazily during
// read operations and explicitly during purgeExpired().

export class RedisSessionStore implements SessionStore {
  private redis: Redis;
  private prefix: string;

  constructor(redis: Redis, prefix = 'hxa:') {
    this.redis = redis;
    this.prefix = prefix;
  }

  private key(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  async get(id: string): Promise<Session | null> {
    const raw = await this.redis.get(this.key(`sess:${id}`));
    if (!raw) return null;
    const session: Session = JSON.parse(raw);
    // Double-check expiry (Redis TTL is millisecond-precise but race is possible)
    if (session.expires_at <= Date.now()) {
      await this.delete(id);
      return null;
    }
    return session;
  }

  async set(session: Session, _attempt = 0): Promise<void> {
    const ttlMs = session.expires_at - Date.now();
    if (ttlMs <= 0) return; // Already expired, don't store

    const sessKey = this.key(`sess:${session.id}`);

    // Use WATCH + MULTI/EXEC for atomic read-modify-write. If another
    // client changes the session key between our GET and EXEC, the
    // transaction is aborted and we retry (max 1 retry).
    await this.redis.watch(sessKey);

    const existing = await this.redis.get(sessKey);
    const multi = this.redis.multi();

    // If the session already exists, remove stale index entries
    if (existing) {
      const old: Session = JSON.parse(existing);
      if (old.role !== session.role) {
        multi.srem(this.key(`idx:role:${old.role}`), session.id);
      }
      if (old.org_id && old.org_id !== session.org_id) {
        multi.srem(this.key(`idx:org:${old.org_id}`), session.id);
      }
      if (old.bot_id && old.bot_id !== session.bot_id) {
        multi.srem(this.key(`idx:bot:${old.bot_id}`), session.id);
      }
    }

    // Write session data + indexes
    multi.set(sessKey, JSON.stringify(session));
    multi.pexpireat(sessKey, session.expires_at);
    multi.sadd(this.key(`idx:role:${session.role}`), session.id);
    if (session.org_id) {
      multi.sadd(this.key(`idx:org:${session.org_id}`), session.id);
    }
    if (session.bot_id) {
      multi.sadd(this.key(`idx:bot:${session.bot_id}`), session.id);
    }

    const result = await multi.exec();
    if (result === null) {
      if (_attempt < 1) {
        // WATCH detected concurrent modification — retry once
        return this.set(session, _attempt + 1);
      }
      throw new Error('RedisSessionStore.set() failed: concurrent modification after retry');
    }
  }

  async delete(id: string): Promise<void> {
    // Fetch session first so we can clean indexes
    const raw = await this.redis.get(this.key(`sess:${id}`));
    const pipeline = this.redis.pipeline();
    pipeline.del(this.key(`sess:${id}`));

    if (raw) {
      const session: Session = JSON.parse(raw);
      pipeline.srem(this.key(`idx:role:${session.role}`), id);
      if (session.org_id) {
        pipeline.srem(this.key(`idx:org:${session.org_id}`), id);
      }
      if (session.bot_id) {
        pipeline.srem(this.key(`idx:bot:${session.bot_id}`), id);
      }
    }

    await pipeline.exec();
  }

  async deleteByBotId(botId: string): Promise<number> {
    const ids = await this.redis.smembers(this.key(`idx:bot:${botId}`));
    if (ids.length === 0) return 0;

    let deleted = 0;
    for (const id of ids) {
      const raw = await this.redis.get(this.key(`sess:${id}`));
      if (raw) {
        const session: Session = JSON.parse(raw);
        const pipeline = this.redis.pipeline();
        pipeline.del(this.key(`sess:${id}`));
        pipeline.srem(this.key(`idx:role:${session.role}`), id);
        if (session.org_id) pipeline.srem(this.key(`idx:org:${session.org_id}`), id);
        pipeline.srem(this.key(`idx:bot:${botId}`), id);
        await pipeline.exec();
        deleted++;
      } else {
        // Stale entry — clean from all known indexes for this session
        await this.cleanStaleFromAllIndexes(id);
      }
    }
    return deleted;
  }

  async deleteByRole(role: string, orgId?: string): Promise<number> {
    // If orgId is specified, intersect role + org indexes
    const roleIds = await this.redis.smembers(this.key(`idx:role:${role}`));
    let targetIds: string[];

    if (orgId) {
      const orgIds = new Set(await this.redis.smembers(this.key(`idx:org:${orgId}`)));
      targetIds = roleIds.filter(id => orgIds.has(id));
    } else {
      targetIds = roleIds;
    }

    if (targetIds.length === 0) return 0;

    let deleted = 0;
    for (const id of targetIds) {
      const raw = await this.redis.get(this.key(`sess:${id}`));
      if (raw) {
        const session: Session = JSON.parse(raw);
        const pipeline = this.redis.pipeline();
        pipeline.del(this.key(`sess:${id}`));
        pipeline.srem(this.key(`idx:role:${session.role}`), id);
        if (session.org_id) pipeline.srem(this.key(`idx:org:${session.org_id}`), id);
        if (session.bot_id) pipeline.srem(this.key(`idx:bot:${session.bot_id}`), id);
        await pipeline.exec();
        deleted++;
      } else {
        // Stale entry — clean from all known indexes
        await this.cleanStaleFromAllIndexes(id);
      }
    }
    return deleted;
  }

  async countByRole(role: string, orgId?: string, botId?: string): Promise<number> {
    const roleIds = await this.redis.smembers(this.key(`idx:role:${role}`));
    if (roleIds.length === 0) return 0;

    // Apply intersection filters if specified
    let candidates = new Set(roleIds);

    if (orgId) {
      const orgIds = new Set(await this.redis.smembers(this.key(`idx:org:${orgId}`)));
      candidates = new Set([...candidates].filter(id => orgIds.has(id)));
    }
    if (botId) {
      const botIds = new Set(await this.redis.smembers(this.key(`idx:bot:${botId}`)));
      candidates = new Set([...candidates].filter(id => botIds.has(id)));
    }

    if (candidates.size === 0) return 0;

    // Check which sessions still exist (not expired by Redis TTL)
    const now = Date.now();
    let count = 0;
    const stale: string[] = [];

    // Use pipeline for bulk EXISTS check
    const pipeline = this.redis.pipeline();
    const candidateArr = [...candidates];
    for (const id of candidateArr) {
      pipeline.get(this.key(`sess:${id}`));
    }
    const results = await pipeline.exec();

    for (let i = 0; i < candidateArr.length; i++) {
      const [err, raw] = results![i];
      if (err || !raw) {
        stale.push(candidateArr[i]);
        continue;
      }
      const session: Session = JSON.parse(raw as string);
      if (session.expires_at > now) {
        count++;
      } else {
        stale.push(candidateArr[i]);
      }
    }

    // Lazy cleanup of stale entries — clean from all indexes
    if (stale.length > 0) {
      for (const id of stale) {
        this.cleanStaleFromAllIndexes(id).catch(() => {}); // fire-and-forget
      }
    }

    return count;
  }

  /**
   * Remove a session ID from all index sets. Used when a session key has
   * expired or been deleted but stale index entries remain.
   */
  private async cleanStaleFromAllIndexes(id: string): Promise<void> {
    const indexPatterns = ['idx:role:*', 'idx:org:*', 'idx:bot:*'];
    for (const pattern of indexPatterns) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', this.key(pattern), 'COUNT', 100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          const pipeline = this.redis.pipeline();
          for (const indexKey of keys) {
            pipeline.srem(indexKey, id);
          }
          await pipeline.exec();
        }
      } while (cursor !== '0');
    }
  }

  async listByOrg(orgId: string, opts?: { limit?: number; offset?: number }): Promise<Session[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
    const offset = opts?.offset ?? 0;
    const ids = await this.redis.smembers(this.key(`idx:org:${orgId}`));
    if (ids.length === 0) return [];

    const now = Date.now();
    const sessions: Session[] = [];
    const stale: string[] = [];

    // Fetch all sessions in pipeline
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.get(this.key(`sess:${id}`));
    }
    const results = await pipeline.exec();

    for (let i = 0; i < ids.length; i++) {
      const [err, raw] = results![i];
      if (err || !raw) {
        stale.push(ids[i]);
        continue;
      }
      const session: Session = JSON.parse(raw as string);
      if (session.expires_at > now) {
        sessions.push(session);
      } else {
        stale.push(ids[i]);
      }
    }

    // Lazy cleanup of stale entries
    if (stale.length > 0) {
      for (const id of stale) {
        this.cleanStaleFromAllIndexes(id).catch(() => {});
      }
    }

    // Sort by created_at DESC and apply offset/limit
    sessions.sort((a, b) => b.created_at - a.created_at);
    return sessions.slice(offset, offset + limit);
  }

  async purgeExpired(): Promise<void> {
    // Redis TTL handles key expiry automatically. This method cleans up
    // stale entries in index sets that reference expired session keys.
    const indexPatterns = ['idx:role:*', 'idx:org:*', 'idx:bot:*'];

    for (const pattern of indexPatterns) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', this.key(pattern), 'COUNT', 100,
        );
        cursor = nextCursor;

        for (const indexKey of keys) {
          const members = await this.redis.smembers(indexKey);
          const stale: string[] = [];
          if (members.length > 0) {
            const pipeline = this.redis.pipeline();
            for (const id of members) {
              pipeline.exists(this.key(`sess:${id}`));
            }
            const results = await pipeline.exec();
            for (let i = 0; i < members.length; i++) {
              const [err, exists] = results![i];
              if (err || !exists) stale.push(members[i]);
            }
          }
          if (stale.length > 0) {
            await this.redis.srem(indexKey, ...stale);
          }
          // Remove empty index sets
          const remaining = await this.redis.scard(indexKey);
          if (remaining === 0) await this.redis.del(indexKey);
        }
      } while (cursor !== '0');
    }
  }

  /** Disconnect from Redis. Call during graceful shutdown. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
