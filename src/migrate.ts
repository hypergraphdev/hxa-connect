#!/usr/bin/env node
/**
 * SQLite → PostgreSQL migration CLI for HXA-Connect.
 *
 * Usage:
 *   npx tsx src/migrate.ts --sqlite <path> --postgres <url>
 *   node dist/migrate.js --sqlite <path> --postgres <url>
 *
 * Options:
 *   --sqlite   Path to SQLite database file (source)
 *   --postgres PostgreSQL connection URL (target)
 *   --force    Skip confirmation when target DB has existing data
 *   --dry-run  Show what would be migrated without writing
 */
import { SqliteDriver } from './db/index.js';
import { PostgresDriver } from './db/index.js';
import { HubDB } from './db.js';
import pg from 'pg';

// ─── Table Order (respects foreign key dependencies) ─────────

const TABLES = [
  'orgs',
  'bots',
  'channels',
  'channel_members',
  'messages',
  'threads',
  'thread_participants',
  'thread_messages',
  'artifacts',
  'files',
  'catchup_events',
  'webhook_status',
  'org_settings',
  'rate_limit_events',
  'audit_log',
  'bot_tokens',
  'org_tickets',
  'platform_invite_codes',
  'schema_versions',
];

/** Tables with SERIAL primary keys that need sequence resets */
const SERIAL_TABLES = ['rate_limit_events'];

const BATCH_SIZE = 500;

// ─── CLI Arg Parsing ─────────────────────────────────────────

function parseArgs(): { sqlite: string; postgres: string; force: boolean; dryRun: boolean } {
  const args = process.argv.slice(2);
  let sqlite = '';
  let postgres = '';
  let force = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sqlite':
        sqlite = args[++i] || '';
        break;
      case '--postgres':
        postgres = args[++i] || '';
        break;
      case '--force':
        force = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
HXA-Connect: SQLite → PostgreSQL Migration

Usage:
  npx tsx src/migrate.ts --sqlite <path> --postgres <url>

Options:
  --sqlite   Path to SQLite database file (source)
  --postgres PostgreSQL connection URL (target)
  --force    Skip confirmation when target DB has existing data
  --dry-run  Show what would be migrated without writing
  --help     Show this help
`);
        process.exit(0);
    }
  }

  if (!sqlite) {
    console.error('Error: --sqlite <path> is required');
    process.exit(1);
  }
  if (!postgres) {
    console.error('Error: --postgres <url> is required');
    process.exit(1);
  }

  return { sqlite, postgres, force, dryRun };
}

// ─── Helpers ─────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

/**
 * Build a multi-row INSERT with $N placeholders.
 * Returns { sql, params } for a batch of rows.
 */
function buildBatchInsert(
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const valueSets: string[] = [];
  let idx = 0;

  for (const row of rows) {
    const placeholders: string[] = [];
    for (const col of columns) {
      idx++;
      placeholders.push(`$${idx}`);
      params.push(row[col] ?? null);
    }
    valueSets.push(`(${placeholders.join(', ')})`);
  }

  // Quote column names to handle reserved words (e.g. "function").
  // Escape embedded double-quotes to prevent SQL injection from crafted schemas.
  const quoteIdent = (s: string) => '"' + s.replace(/"/g, '""') + '"';
  const quotedCols = columns.map(quoteIdent).join(', ');
  const sql = `INSERT INTO ${quoteIdent(table)} (${quotedCols}) VALUES ${valueSets.join(', ')}`;
  return { sql, params };
}

/**
 * Get column names for a table from SQLite (using PRAGMA).
 */
async function getColumns(sqliteDriver: SqliteDriver, table: string): Promise<string[]> {
  const rows = await sqliteDriver.all<{ name: string }>(`PRAGMA table_info("${table}")`);
  return rows.map(r => r.name);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const { sqlite, postgres, force, dryRun } = parseArgs();

  console.log('\n  HXA-Connect: SQLite → PostgreSQL Migration\n');
  log(`Source:  ${sqlite}`);
  log(`Target:  ${postgres.replace(/\/\/.*@/, '//***@')}`);
  if (dryRun) log('Mode:    DRY RUN (no writes)');
  console.log();

  // Open source SQLite
  const sqliteDriver = new SqliteDriver(sqlite);
  const srcHealthy = await sqliteDriver.isHealthy();
  if (!srcHealthy) {
    console.error('Error: Cannot open SQLite database');
    process.exit(1);
  }

  // Count rows per table (source)
  const tableCounts: Record<string, number> = {};
  let totalRows = 0;
  for (const table of TABLES) {
    try {
      const row = await sqliteDriver.get<{ count: number }>(`SELECT COUNT(*) as count FROM "${table}"`);
      tableCounts[table] = row?.count ?? 0;
      totalRows += tableCounts[table];
    } catch {
      // Table might not exist in older schemas
      tableCounts[table] = -1;
    }
  }

  log(`Source summary: ${totalRows} total rows across ${TABLES.filter(t => tableCounts[t] > 0).length} tables\n`);

  // Dry-run: show table counts and exit (no PostgreSQL connection needed)
  if (dryRun) {
    for (const table of TABLES) {
      const count = tableCounts[table];
      if (count === -1) continue;
      const status = count > 0 ? `${count} rows` : 'empty';
      console.log(`  ${table.padEnd(26)} ${status}`);
    }
    console.log(`\n  Total: ${totalRows} rows`);
    await sqliteDriver.close();
    return;
  }

  // Open target PostgreSQL
  const pool = new pg.Pool({
    connectionString: postgres,
    max: 5,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await pool.query('SELECT 1');
  } catch (err: any) {
    console.error(`Error: Cannot connect to PostgreSQL: ${err.message}`);
    await sqliteDriver.close();
    process.exit(1);
  }

  // Initialize schema on Postgres via HubDB.init()
  log('Creating schema on PostgreSQL...');
  const pgDriver = new PostgresDriver(postgres);
  const db = new HubDB(pgDriver);
  await db.init();
  await pgDriver.close();
  log('Schema created');

  // Check if target already has data (check all data tables, excluding
  // schema_versions which is populated by init() itself)
  if (!force) {
    const DATA_TABLES = TABLES.filter(t => t !== 'schema_versions');
    for (const table of DATA_TABLES) {
      try {
        const result = await pool.query(`SELECT COUNT(*) as count FROM "${table}"`);
        const count = Number(result.rows[0].count);
        if (count > 0) {
          console.error(`\nError: Target table "${table}" already has ${count} row(s). Use --force to overwrite.`);
          await cleanup(sqliteDriver, pool);
          process.exit(1);
        }
      } catch {
        // Table doesn't exist yet — that's fine, init() will create it
      }
    }
  }

  // Migrate each table
  let migratedRows = 0;
  const startTime = Date.now();

  for (const table of TABLES) {
    if (tableCounts[table] === -1) continue; // table doesn't exist in source

    const count = tableCounts[table];

    // In --force mode, clear target even for empty source tables
    // to ensure target matches source exactly
    if (count === 0 && !force) {
      log(`  ${table.padEnd(26)} skip (empty)`);
      continue;
    }
    if (count === 0 && force) {
      // Wrap in transaction so failure recovery is consistent
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM "${table}"`);
        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`\nError clearing ${table}: ${err.message}`);
        await cleanup(sqliteDriver, pool);
        process.exit(1);
      } finally {
        client.release();
      }
      // Reset SERIAL sequence to baseline for empty tables
      if (SERIAL_TABLES.includes(table)) {
        await pool.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), 1, false)`);
      }
      log(`  ${table.padEnd(26)} cleared (source empty)`);
      continue;
    }

    const columns = await getColumns(sqliteDriver, table);

    // Read all rows from SQLite
    const rows = await sqliteDriver.all<Record<string, unknown>>(`SELECT * FROM "${table}"`);

    // Batch-insert into PostgreSQL
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If target has data for this table (--force mode), truncate inside txn
      // so rollback restores original data on failure
      if (force) {
        await client.query(`DELETE FROM "${table}"`);
      }

      // For SERIAL tables, we need to allow explicit id inserts
      const isSerial = SERIAL_TABLES.includes(table);

      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const batch = rows.slice(offset, offset + BATCH_SIZE);
        const { sql, params } = buildBatchInsert(table, columns, batch);
        await client.query(sql, params);
      }

      await client.query('COMMIT');

      // Reset SERIAL sequences
      if (isSerial) {
        await pool.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0))`);
      }

      migratedRows += count;
      log(`  ${table.padEnd(26)} ${count} rows ✓`);
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`\nError migrating ${table}: ${err.message}`);
      await cleanup(sqliteDriver, pool);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  log(`Migration complete: ${migratedRows} rows in ${elapsed}s`);
  log('Verifying target health...');

  // Quick verification
  const verifyDriver = new PostgresDriver(postgres);
  const healthy = await verifyDriver.isHealthy();
  await verifyDriver.close();

  if (healthy) {
    log('Target database healthy ✓');
  } else {
    console.error('Warning: Target database health check failed');
  }

  await cleanup(sqliteDriver, pool);
}

async function cleanup(sqliteDriver: SqliteDriver, pool: pg.Pool) {
  await sqliteDriver.close();
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
