/**
 * PostgreSQL implementation of DatabaseDriver using node-postgres (pg).
 *
 * Key design decisions:
 * - Connection pooling via pg.Pool (default max 10 connections)
 * - Placeholder translation: ? → $1, $2, ... (string-aware to skip quoted ?)
 * - Transactions use a dedicated PoolClient (all queries in the same txn
 *   go through the same client, preventing interleaving)
 * - Nested transactions via SAVEPOINTs
 * - Client force-released on error to prevent connection leak in broken state
 */
import pg from 'pg';
import type { DatabaseDriver, RunResult } from './driver.js';

// Parse BIGINT (OID 20) as JavaScript number instead of string.
// Timestamp values (~1.7e12) are well within Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (val: string) => Number(val));

// ─── Placeholder Translation ─────────────────────────────────

/**
 * Convert positional `?` placeholders to PostgreSQL `$1, $2, ...` syntax.
 * Skips `?` inside single-quoted SQL string literals (handles '' escapes).
 *
 * Limitations: does not handle dollar-quoted strings ($$...$$), SQL comments
 * (-- or /​* *​/), or PostgreSQL's native ? operators (jsonb existence).
 * These constructs are not used in hxa-connect's query corpus.
 */
export function translatePlaceholders(sql: string): string {
  let index = 0;
  let inString = false;
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (ch === "'" && !inString) {
      inString = true;
      result += ch;
    } else if (ch === "'" && inString) {
      // Handle escaped quotes ('')
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        result += "''";
        i++; // skip next quote
      } else {
        inString = false;
        result += ch;
      }
    } else if (ch === '?' && !inString) {
      index++;
      result += `$${index}`;
    } else {
      result += ch;
    }
  }

  return result;
}

// ─── Transaction Driver ──────────────────────────────────────

/**
 * A DatabaseDriver bound to a specific PoolClient within a transaction.
 * Nested transaction() calls use SAVEPOINTs.
 */
class PgTransactionDriver implements DatabaseDriver {
  readonly dialect = 'postgres' as const;
  private savepointCounter = 0;

  constructor(private client: pg.PoolClient) {}

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.client.query(translatePlaceholders(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.client.query(translatePlaceholders(sql), params);
    return (result.rows[0] as T) ?? undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(translatePlaceholders(sql), params);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    const name = `sp_${++this.savepointCounter}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      try { await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* ignore */ }
      throw err;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // No-op: client is released by the parent PostgresDriver.transaction()
  }
}

// ─── PostgresDriver ──────────────────────────────────────────

export class PostgresDriver implements DatabaseDriver {
  readonly dialect = 'postgres' as const;
  private pool: pg.Pool;

  constructor(connectionString: string, poolConfig?: pg.PoolConfig) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...poolConfig,
    });
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.pool.query(translatePlaceholders(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.pool.query(translatePlaceholders(sql), params);
    return (result.rows[0] as T) ?? undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(translatePlaceholders(sql), params);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    // Simple query protocol — supports multi-statement SQL (DDL blocks)
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const txnDriver = new PgTransactionDriver(client);

    try {
      await client.query('BEGIN');
      const result = await fn(txnDriver);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK failed — client is likely in a broken state.
        // Force-destroy it so the pool doesn't reuse a tainted connection.
        client.release(true);
        throw err;
      }
      throw err;
    } finally {
      // Release client back to pool (normal release if not already force-released)
      try { client.release(); } catch { /* already released */ }
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
