/**
 * Database driver abstraction layer.
 *
 * Provides a dialect-agnostic interface for HubDB to use.
 * Implementations: SqliteDriver (default), PostgresDriver (future).
 */

// ─── Types ──────────────────────────────────────────────────

export interface RunResult {
  /** Number of rows affected by INSERT/UPDATE/DELETE */
  changes: number;
  /** Last inserted rowid (SQLite) or undefined */
  lastInsertRowid?: number | bigint;
}

export type Dialect = 'sqlite' | 'postgres';

// ─── Driver Interface ───────────────────────────────────────

export interface DatabaseDriver {
  /** The SQL dialect this driver uses */
  readonly dialect: Dialect;

  /**
   * Execute a statement that modifies data (INSERT, UPDATE, DELETE).
   * Params use positional `?` placeholders (driver translates to `$1` etc. if needed).
   */
  run(sql: string, params?: unknown[]): Promise<RunResult>;

  /**
   * Fetch a single row. Returns undefined if no rows match.
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /**
   * Fetch all matching rows.
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute raw SQL (DDL, multiple statements). No parameter binding.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run a function inside a database transaction.
   * The function receives the same driver instance for queries within the transaction.
   * If the function throws, the transaction is rolled back.
   */
  transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T>;

  /**
   * Lightweight health check (e.g. SELECT 1).
   */
  isHealthy(): Promise<boolean>;

  /**
   * Close the database connection.
   */
  close(): Promise<void>;
}
