/**
 * SQLite implementation of DatabaseDriver using better-sqlite3.
 *
 * All operations are synchronous under the hood (better-sqlite3 is sync),
 * wrapped in Promise.resolve() for the async interface.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseDriver, RunResult } from './driver.js';

export class SqliteDriver implements DatabaseDriver {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    // IMPORTANT: SqliteDriver.transaction assumes synchronous execution.
    // better-sqlite3 is fully synchronous — all driver methods (run, get, all)
    // return resolved promises immediately within the same tick. The async fn
    // therefore completes synchronously between BEGIN and COMMIT with no
    // interleaving from other transactions.
    //
    // This is NOT safe for truly async drivers (e.g. PostgresDriver) where
    // I/O awaits could interleave. PostgresDriver (Phase 2) will use a
    // dedicated pool client with proper BEGIN/COMMIT scoping.
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
