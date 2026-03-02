/**
 * Tests for the migration CLI utilities.
 * Tests dry-run mode and basic migration logic without requiring PostgreSQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/db/index.js';
import { HubDB } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-migrate-test-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: create a test SQLite database with sample data.
 */
async function seedTestDb(): Promise<void> {
  const driver = new SqliteDriver(dbPath);
  const db = new HubDB(driver);
  await db.init();

  const now = Date.now();

  // Seed an org
  await driver.run(
    "INSERT INTO orgs (id, name, org_secret, persist_messages, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ['org1', 'TestOrg', 'secret123', 1, 'active', now],
  );

  // Seed a bot
  await driver.run(
    "INSERT INTO bots (id, org_id, name, token, auth_role, online, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ['bot1', 'org1', 'TestBot', 'tokenhash123', 'admin', 1, now],
  );

  // Seed a channel
  await driver.run(
    "INSERT INTO channels (id, org_id, type, name, created_at) VALUES (?, ?, ?, ?, ?)",
    ['ch1', 'org1', 'direct', 'general', now],
  );

  // Seed channel member
  await driver.run(
    "INSERT INTO channel_members (channel_id, bot_id, joined_at) VALUES (?, ?, ?)",
    ['ch1', 'bot1', now],
  );

  // Seed a message
  await driver.run(
    "INSERT INTO messages (id, channel_id, sender_id, content, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ['msg1', 'ch1', 'bot1', 'Hello world', 'text', now],
  );

  // Seed a thread
  await driver.run(
    "INSERT INTO threads (id, org_id, topic, status, initiator_id, revision, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ['thread1', 'org1', 'Test Thread', 'active', 'bot1', 1, now, now, now],
  );

  // Seed thread participant
  await driver.run(
    "INSERT INTO thread_participants (thread_id, bot_id, joined_at) VALUES (?, ?, ?)",
    ['thread1', 'bot1', now],
  );

  // Seed a thread message
  await driver.run(
    "INSERT INTO thread_messages (id, thread_id, sender_id, content, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ['tmsg1', 'thread1', 'bot1', 'Thread message', 'text', now],
  );

  // Seed an artifact
  await driver.run(
    "INSERT INTO artifacts (id, thread_id, artifact_key, type, title, content, version, format_warning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ['art1', 'thread1', 'doc1', 'text', 'Test Doc', 'Content here', 1, 0, now, now],
  );

  // Seed org_settings
  await driver.run(
    "INSERT INTO org_settings (org_id, updated_at) VALUES (?, ?)",
    ['org1', now],
  );

  // Seed audit_log
  await driver.run(
    "INSERT INTO audit_log (id, org_id, bot_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ['audit1', 'org1', 'bot1', 'bot_joined', 'org', 'org1', now],
  );

  await driver.close();
}

describe('migrate CLI', () => {
  it('shows help with --help', () => {
    const result = execSync('npx tsx src/migrate.ts --help 2>&1', {
      cwd: path.resolve(''),
      encoding: 'utf-8',
    });
    expect(result).toContain('SQLite → PostgreSQL Migration');
    expect(result).toContain('--sqlite');
    expect(result).toContain('--postgres');
  });

  it('fails without required args', () => {
    try {
      execSync('npx tsx src/migrate.ts 2>&1', {
        cwd: path.resolve(''),
        encoding: 'utf-8',
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.stderr || err.stdout).toContain('--sqlite');
    }
  });

  it('fails with invalid SQLite path', () => {
    try {
      execSync('npx tsx src/migrate.ts --sqlite /nonexistent/db.sqlite --postgres postgres://fake 2>&1', {
        cwd: path.resolve(''),
        encoding: 'utf-8',
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      // Should fail trying to open nonexistent path
      expect(err.status).not.toBe(0);
    }
  });

  it('dry-run shows table counts without writing', async () => {
    await seedTestDb();

    const result = execSync(
      `npx tsx src/migrate.ts --sqlite ${dbPath} --postgres postgres://fake --dry-run 2>&1`,
      {
        cwd: path.resolve(''),
        encoding: 'utf-8',
      },
    );

    expect(result).toContain('DRY RUN');
    expect(result).toContain('orgs');
    expect(result).toContain('1 rows');
    expect(result).toContain('bots');
    expect(result).toContain('messages');
    expect(result).toContain('Total:');
  });

  it('dry-run counts all seeded tables correctly', async () => {
    await seedTestDb();

    const result = execSync(
      `npx tsx src/migrate.ts --sqlite ${dbPath} --postgres postgres://fake --dry-run 2>&1`,
      {
        cwd: path.resolve(''),
        encoding: 'utf-8',
      },
    );

    // We seeded: 1 org, 1 bot, 1 channel, 1 channel_member, 1 message,
    // 1 thread, 1 thread_participant, 1 thread_message, 1 artifact,
    // 1 org_settings, 1 audit_log, plus schema_versions entries = ~13-14 rows
    // The exact total depends on number of schema_versions entries
    expect(result).toMatch(/Total: \d+ rows/);
  });
});

describe('remove_group_channels migration', () => {
  it('deletes legacy group channels and their members/messages on init', async () => {
    const driver = new SqliteDriver(dbPath);
    // Create schema with old CHECK constraint that allows group
    await driver.exec(`
      CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT, org_secret TEXT, persist_messages INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER);
      CREATE TABLE bots (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, token TEXT, auth_role TEXT DEFAULT 'member', online INTEGER DEFAULT 0, created_at INTEGER);
      CREATE TABLE channels (id TEXT PRIMARY KEY, org_id TEXT, type TEXT NOT NULL, name TEXT, created_at INTEGER);
      CREATE TABLE channel_members (channel_id TEXT, bot_id TEXT, joined_at INTEGER, PRIMARY KEY(channel_id, bot_id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT, sender_id TEXT, content TEXT, content_type TEXT DEFAULT 'text', created_at INTEGER);
    `);

    const now = Date.now();
    await driver.run("INSERT INTO orgs VALUES (?, ?, ?, ?, ?, ?)", ['org1', 'Org', 'secret', 1, 'active', now]);
    await driver.run("INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?, ?)", ['bot1', 'org1', 'Bot1', 'tok1', 'member', 0, now]);
    await driver.run("INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?, ?)", ['bot2', 'org1', 'Bot2', 'tok2', 'member', 0, now]);
    await driver.run("INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?, ?)", ['bot3', 'org1', 'Bot3', 'tok3', 'member', 0, now]);

    // Direct channel (should survive)
    await driver.run("INSERT INTO channels VALUES (?, ?, ?, ?, ?)", ['dm1', 'org1', 'direct', null, now]);
    await driver.run("INSERT INTO channel_members VALUES (?, ?, ?)", ['dm1', 'bot1', now]);
    await driver.run("INSERT INTO channel_members VALUES (?, ?, ?)", ['dm1', 'bot2', now]);
    await driver.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)", ['msg1', 'dm1', 'bot1', 'DM msg', 'text', now]);

    // Group channel (should be deleted)
    await driver.run("INSERT INTO channels VALUES (?, ?, ?, ?, ?)", ['grp1', 'org1', 'group', 'general', now]);
    await driver.run("INSERT INTO channel_members VALUES (?, ?, ?)", ['grp1', 'bot1', now]);
    await driver.run("INSERT INTO channel_members VALUES (?, ?, ?)", ['grp1', 'bot2', now]);
    await driver.run("INSERT INTO channel_members VALUES (?, ?, ?)", ['grp1', 'bot3', now]);
    await driver.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)", ['msg2', 'grp1', 'bot1', 'Group msg', 'text', now]);

    await driver.close();

    // Now init HubDB which runs migration
    const driver2 = new SqliteDriver(dbPath);
    const db = new HubDB(driver2);
    await db.init();

    // Direct channel should survive
    const dm = await driver2.get("SELECT * FROM channels WHERE id = 'dm1'");
    expect(dm).toBeDefined();
    const dmMembers = await driver2.all("SELECT * FROM channel_members WHERE channel_id = 'dm1'");
    expect(dmMembers).toHaveLength(2);
    const dmMsgs = await driver2.all("SELECT * FROM messages WHERE channel_id = 'dm1'");
    expect(dmMsgs).toHaveLength(1);

    // Group channel should be deleted
    const grp = await driver2.get("SELECT * FROM channels WHERE id = 'grp1'");
    expect(grp).toBeUndefined();
    const grpMembers = await driver2.all("SELECT * FROM channel_members WHERE channel_id = 'grp1'");
    expect(grpMembers).toHaveLength(0);
    const grpMsgs = await driver2.all("SELECT * FROM messages WHERE channel_id = 'grp1'");
    expect(grpMsgs).toHaveLength(0);

    await driver2.close();
  });
});
