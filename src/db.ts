import type { DatabaseDriver } from './db/driver.js';
import crypto from 'node:crypto';
import type {
  Org,
  Bot,
  Channel,
  ChannelMember,
  Message,
  BotProfileInput,
  ListBotsFilters,
  Thread,
  ThreadParticipant,
  ThreadMessage,
  Artifact,
  ArtifactType,
  ThreadStatus,
  CloseReason,
  FileRecord,
  CatchupEvent,
  WebhookHealth,
  OrgSettings,
  AuditAction,
  AuditEntry,
  BotToken,
  TokenScope,
  ThreadPermissionPolicy,
  OrgTicket,
  PlatformInviteCode,
  AuthRole,
} from './types.js';

// ─── Cursor Helpers ──────────────────────────────────────────

/** Encode a (timestamp, id) pair into an opaque cursor string. */
export function encodeCursor(t: number, id: string): string {
  return Buffer.from(JSON.stringify({ t, id })).toString('base64url');
}

/** Decode an opaque cursor. Returns null if invalid. */
export function decodeCursor(cursor: string): { t: number; id: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof obj.t === 'number' && typeof obj.id === 'string') return obj;
    return null;
  } catch {
    return null;
  }
}

// ─── Database Layer ──────────────────────────────────────────

export class HubDB {
  /** Row identifier column: SQLite uses implicit `rowid`, Postgres uses `id` (or `ctid`) */
  private get rowid(): string {
    return this.driver.dialect === 'postgres' ? 'id' : 'rowid';
  }

  constructor(private driver: DatabaseDriver) {}

  async init(): Promise<void> {
    // Dialect-specific DDL fragments
    const autoIncrementPK = this.driver.dialect === 'postgres'
      ? 'SERIAL PRIMARY KEY'
      : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    // Timestamp columns store Date.now() (ms) which exceeds PG's 32-bit INTEGER
    const ts = this.driver.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';

    await this.driver.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        org_secret TEXT NOT NULL,
        persist_messages INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at ${ts} NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        metadata TEXT,
        webhook_url TEXT,
        webhook_secret TEXT,
        bio TEXT,
        role TEXT,
        "function" TEXT,
        team TEXT,
        tags TEXT,
        languages TEXT,
        protocols TEXT,
        status_text TEXT,
        timezone TEXT,
        active_hours TEXT,
        version TEXT,
        runtime TEXT,
        auth_role TEXT NOT NULL DEFAULT 'member' CHECK(auth_role IN ('admin','member')),
        online INTEGER DEFAULT 0,
        last_seen_at ${ts},
        created_at ${ts} NOT NULL,
        UNIQUE(org_id, name)
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('direct')),
        name TEXT,
        created_at ${ts} NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        joined_at ${ts} NOT NULL,
        PRIMARY KEY(channel_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        parts TEXT,
        created_at ${ts} NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        tags TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'blocked', 'reviewing', 'resolved', 'closed')),
        initiator_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
        context TEXT,
        close_reason TEXT
          CHECK(close_reason IS NULL OR close_reason IN ('manual', 'timeout', 'error')),
        revision INTEGER NOT NULL DEFAULT 1,
        permission_policy TEXT,
        created_at ${ts} NOT NULL,
        updated_at ${ts} NOT NULL,
        last_activity_at ${ts} NOT NULL,
        resolved_at ${ts}
      );

      CREATE TABLE IF NOT EXISTS thread_participants (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        label TEXT,
        joined_at ${ts} NOT NULL,
        PRIMARY KEY(thread_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        parts TEXT,
        metadata TEXT,
        created_at ${ts} NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        artifact_key TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text'
          CHECK(type IN ('text', 'markdown', 'json', 'code', 'file', 'link')),
        title TEXT,
        content TEXT,
        language TEXT,
        url TEXT,
        mime_type TEXT,
        contributor_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        format_warning INTEGER DEFAULT 0,
        created_at ${ts} NOT NULL,
        updated_at ${ts} NOT NULL,
        UNIQUE(thread_id, artifact_key, version)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_bots_org ON bots(org_id);
      CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(org_id);
      CREATE INDEX IF NOT EXISTS idx_channel_members_bot ON channel_members(bot_id);
      CREATE INDEX IF NOT EXISTS idx_threads_org ON threads(org_id, status);
      CREATE INDEX IF NOT EXISTS idx_threads_initiator ON threads(initiator_id);
      CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_thread_participants_bot ON thread_participants(bot_id);
      CREATE INDEX IF NOT EXISTS idx_thread_messages ON thread_messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_key ON artifacts(thread_id, artifact_key);

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        uploader_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at ${ts} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_org ON files(org_id, created_at);

      CREATE TABLE IF NOT EXISTS catchup_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ref_id TEXT,
        occurred_at ${ts} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catchup_target ON catchup_events(target_bot_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_catchup_occurred ON catchup_events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_catchup_ref ON catchup_events(target_bot_id, type, ref_id);

      CREATE TABLE IF NOT EXISTS webhook_status (
        bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
        last_success ${ts},
        last_failure ${ts},
        consecutive_failures INTEGER DEFAULT 0,
        degraded INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS org_settings (
        org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        messages_per_minute_per_bot INTEGER DEFAULT 120,
        threads_per_hour_per_bot INTEGER DEFAULT 30,
        file_upload_mb_per_day_per_bot INTEGER DEFAULT 100,
        message_ttl_days INTEGER,
        thread_auto_close_days INTEGER,
        artifact_retention_days INTEGER,
        default_thread_permission_policy TEXT,
        updated_at ${ts} NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id ${autoIncrementPK},
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('message', 'thread')),
        created_at ${ts} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit ON rate_limit_events(org_id, bot_id, resource_type, created_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        bot_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail TEXT,
        created_at ${ts} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(org_id, action, created_at);

      CREATE TABLE IF NOT EXISTS bot_tokens (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        scopes TEXT NOT NULL DEFAULT '["full"]',
        label TEXT,
        expires_at ${ts},
        created_at ${ts} NOT NULL,
        last_used_at ${ts}
      );
      CREATE INDEX IF NOT EXISTS idx_bot_tokens_bot ON bot_tokens(bot_id);
      CREATE INDEX IF NOT EXISTS idx_bot_tokens_token ON bot_tokens(token);

      CREATE TABLE IF NOT EXISTS org_tickets (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        secret_hash TEXT NOT NULL,
        reusable INTEGER NOT NULL DEFAULT 0,
        expires_at ${ts} NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at ${ts} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_org_tickets_org ON org_tickets(org_id);
      CREATE INDEX IF NOT EXISTS idx_org_tickets_expires ON org_tickets(expires_at);

      CREATE TABLE IF NOT EXISTS platform_invite_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        label TEXT,
        max_uses INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        expires_at ${ts} NOT NULL,
        created_at ${ts} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invite_codes_hash ON platform_invite_codes(code_hash);
    `);

    // ── Schema version tracking (for future migrations) ─────
    await this.driver.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        name TEXT PRIMARY KEY,
        applied_at ${ts} NOT NULL
      );
    `);

    await this.runMigration('thread_messages_mentions', async () => {
      await this.driver.exec(`
        ALTER TABLE thread_messages ADD COLUMN mentions TEXT DEFAULT NULL;
        ALTER TABLE thread_messages ADD COLUMN mention_all INTEGER DEFAULT 0;
      `);
    });

    // Delete any legacy group channels (group channels are no longer supported).
    // Group channels cannot be safely converted to direct because they may have
    // more than 2 members, which would violate the DM model and could cause
    // duplicate direct channels between the same bot pair.
    //
    // Note: on existing databases, the old CHECK(type IN ('direct','group'))
    // constraint persists because SQLite cannot ALTER CHECK constraints without
    // table recreation. This is acceptable because createChannel() hardcodes
    // type='direct' — no code path can create group channels.
    await this.runMigration('remove_group_channels', async () => {
      // Delete members first (FK), then channels
      await this.driver.run(
        "DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE type = 'group')",
      );
      await this.driver.run(
        "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE type = 'group')",
      );
      await this.driver.run(
        "DELETE FROM channels WHERE type = 'group'",
      );
    });

    // Sessions table (ADR-002: unified session auth)
    await this.runMigration('sessions_table', async () => {
      const sessTs = this.driver.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
      await this.driver.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          org_id TEXT,
          bot_id TEXT,
          owner_name TEXT,
          scopes TEXT,
          is_scoped_token INTEGER NOT NULL DEFAULT 0,
          created_at ${sessTs} NOT NULL,
          expires_at ${sessTs} NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_org_role ON sessions(org_id, role);
        CREATE INDEX IF NOT EXISTS idx_sessions_bot ON sessions(bot_id);
      `);
    });

    // Composite indexes for cursor-based pagination (PR1: history browsing API)
    await this.runMigration('history_api_indexes', async () => {
      // Thread listing cursor: (last_activity_at DESC, id DESC)
      await this.driver.exec(`
        CREATE INDEX IF NOT EXISTS idx_threads_activity_id ON threads(last_activity_at DESC, id DESC);
      `);
      // Thread messages cursor: (created_at DESC, id DESC) — already indexed by (thread_id, created_at),
      // add composite for stable cursor pagination within a thread
      await this.driver.exec(`
        CREATE INDEX IF NOT EXISTS idx_thread_messages_cursor ON thread_messages(thread_id, created_at DESC, id DESC);
      `);
      // DM channel messages cursor: (created_at DESC, id DESC)
      await this.driver.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_cursor ON messages(channel_id, created_at DESC, id DESC);
      `);
    });

    // Store plaintext invite codes for display (they're shared, not secrets)
    await this.runMigration('invite_code_plaintext', async () => {
      await this.driver.exec(`
        ALTER TABLE platform_invite_codes ADD COLUMN code TEXT DEFAULT NULL;
      `);
    });

    // Store plaintext ticket codes for display (tkt_ prefix)
    await this.runMigration('org_ticket_code', async () => {
      await this.driver.exec(`
        ALTER TABLE org_tickets ADD COLUMN code TEXT DEFAULT NULL;
      `);
      await this.driver.exec(`
        CREATE INDEX IF NOT EXISTS idx_org_tickets_code ON org_tickets(code);
      `);
    });

    // Upgrade existing PG INTEGER timestamp columns to BIGINT (PR #123).
    // Date.now() (~1.7e12) exceeds PG's 32-bit INTEGER max (~2.1e9).
    // No-op on SQLite (INTEGER is already 64-bit).
    await this.runMigration('pg_bigint_timestamps', async () => {
      if (this.driver.dialect !== 'postgres') return;
      const alterations = [
        ['orgs', ['created_at']],
        ['bots', ['last_seen_at', 'created_at']],
        ['channels', ['created_at']],
        ['channel_members', ['joined_at']],
        ['messages', ['created_at']],
        ['threads', ['created_at', 'updated_at', 'last_activity_at', 'resolved_at']],
        ['thread_participants', ['joined_at']],
        ['thread_messages', ['created_at']],
        ['artifacts', ['created_at', 'updated_at']],
        ['files', ['created_at']],
        ['catchup_events', ['occurred_at']],
        ['webhook_status', ['last_success', 'last_failure']],
        ['org_settings', ['updated_at']],
        ['rate_limit_events', ['created_at']],
        ['audit_log', ['created_at']],
        ['bot_tokens', ['expires_at', 'created_at', 'last_used_at']],
        ['org_tickets', ['expires_at', 'created_at']],
        ['platform_invite_codes', ['expires_at', 'created_at']],
        ['schema_versions', ['applied_at']],
        ['sessions', ['created_at', 'expires_at']],
      ] as const;
      for (const [table, cols] of alterations) {
        for (const col of cols) {
          await this.driver.exec(
            `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE BIGINT`,
          );
        }
      }
    });

    // Reply-to-message support (Issue #112): add reply_to_id column
    await this.runMigration('thread_messages_reply_to', async () => {
      await this.driver.exec(`
        ALTER TABLE thread_messages ADD COLUMN reply_to_id TEXT DEFAULT NULL REFERENCES thread_messages(id) ON DELETE SET NULL;
      `);
      await this.driver.exec(`
        CREATE INDEX IF NOT EXISTS idx_thread_messages_reply_to ON thread_messages(reply_to_id);
      `);
    });
  }

  /**
   * Run a named migration only if it hasn't been applied yet.
   * Records the migration in schema_versions upon success.
   */
  private async runMigration(name: string, fn: () => Promise<void>): Promise<void> {
    const applied = await this.driver.get(
      'SELECT 1 FROM schema_versions WHERE name = ?',
      [name],
    );
    if (applied) return;

    // Wrap migration + version record in a transaction so partial failures
    // are rolled back and the migration can be retried cleanly.
    await this.driver.transaction(async (txn) => {
      // Swap driver temporarily for the migration fn
      const origDriver = this.driver;
      this.driver = txn;
      try {
        await fn();
      } finally {
        this.driver = origDriver;
      }

      await txn.run(
        'INSERT INTO schema_versions (name, applied_at) VALUES (?, ?)',
        [name, Date.now()],
      );
    });
  }

  private rowToOrg(row: any): Org {
    return {
      ...row,
      persist_messages: !!row.persist_messages,
      status: row.status ?? 'active',
    };
  }

  private rowToBot(row: any): Bot {
    return {
      ...row,
      bio: row.bio ?? null,
      role: row.role ?? null,
      function: row.function ?? null,
      team: row.team ?? null,
      tags: row.tags ?? null,
      languages: row.languages ?? null,
      protocols: row.protocols ?? null,
      status_text: row.status_text ?? null,
      timezone: row.timezone ?? null,
      active_hours: row.active_hours ?? null,
      version: row.version ?? '1.0.0',
      runtime: row.runtime ?? null,
      auth_role: row.auth_role ?? 'member',
      online: !!row.online,
    };
  }

  private rowToThread(row: any): Thread {
    let tags: string[] | null = null;
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { tags = null; }
    }
    return {
      id: row.id,
      org_id: row.org_id,
      topic: row.topic,
      tags,
      status: row.status,
      initiator_id: row.initiator_id ?? null,
      channel_id: row.channel_id ?? null,
      context: row.context ?? null,
      close_reason: row.close_reason ?? null,
      permission_policy: row.permission_policy ?? null,
      revision: row.revision ?? 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_activity_at: row.last_activity_at,
      resolved_at: row.resolved_at ?? null,
    };
  }

  private rowToThreadMessage(row: any): ThreadMessage {
    return {
      ...row,
      sender_id: row.sender_id ?? null,
      content_type: row.content_type ?? 'text',
      parts: row.parts ?? null,
      metadata: row.metadata ?? null,
      mentions: row.mentions ?? null,
      mention_all: row.mention_all ?? 0,
    };
  }

  private rowToThreadParticipant(row: any): ThreadParticipant {
    return {
      ...row,
      label: row.label ?? null,
    };
  }

  private rowToArtifact(row: any): Artifact {
    return {
      ...row,
      title: row.title ?? null,
      content: row.content ?? null,
      language: row.language ?? null,
      url: row.url ?? null,
      mime_type: row.mime_type ?? null,
      format_warning: !!row.format_warning,
    };
  }

  private serializeProfileFields(fields?: BotProfileInput): {
    bio?: string | null;
    role?: string | null;
    function?: string | null;
    team?: string | null;
    tags?: string | null;
    languages?: string | null;
    protocols?: string | null;
    status_text?: string | null;
    timezone?: string | null;
    active_hours?: string | null;
    version?: string;
    runtime?: string | null;
  } {
    if (!fields) return {};
    return {
      bio: fields.bio,
      role: fields.role,
      function: fields.function,
      team: fields.team,
      tags: fields.tags === undefined ? undefined : (fields.tags === null ? null : JSON.stringify(fields.tags)),
      languages: fields.languages === undefined ? undefined : (fields.languages === null ? null : JSON.stringify(fields.languages)),
      protocols: fields.protocols === undefined ? undefined : (fields.protocols === null ? null : JSON.stringify(fields.protocols)),
      status_text: fields.status_text,
      timezone: fields.timezone,
      active_hours: fields.active_hours,
      version: fields.version,
      runtime: fields.runtime,
    };
  }

  private normalizeJsonArtifactContent(type: ArtifactType, content: string | null): {
    type: ArtifactType;
    content: string | null;
    format_warning: boolean;
  } {
    if (type !== 'json' || content === null) {
      return { type, content, format_warning: false };
    }

    try {
      JSON.parse(content);
      return { type: 'json', content, format_warning: false };
    } catch {
      // Continue to tolerant parsing fallback
    }

    const withoutTrailingCommas = content.replace(/,\s*([}\]])/g, '$1');
    const withDoubleQuotes = withoutTrailingCommas.replace(
      /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
      (_match, inner: string) => `"${inner.replace(/"/g, '\\"')}"`,
    );

    try {
      JSON.parse(withDoubleQuotes);
      return { type: 'json', content: withDoubleQuotes, format_warning: false };
    } catch {
      return { type: 'text', content, format_warning: true };
    }
  }

  // ─── Org Operations ──────────────────────────────────────

  async createOrg(name: string, persistMessages = true, driver?: DatabaseDriver): Promise<Org> {
    const d = driver ?? this.driver;
    const plaintextOrgSecret = crypto.randomBytes(24).toString('hex');
    const org: Org = {
      id: crypto.randomUUID(),
      name,
      org_secret: plaintextOrgSecret,
      persist_messages: persistMessages,
      status: 'active',
      created_at: Date.now(),
    };
    const orgSecretHash = HubDB.hashToken(plaintextOrgSecret);
    await d.run(
      'INSERT INTO orgs (id, name, org_secret, persist_messages, created_at) VALUES (?, ?, ?, ?, ?)',
      [org.id, org.name, orgSecretHash, org.persist_messages ? 1 : 0, org.created_at],
    );
    // Return org with plaintext secret so the caller can display it once
    return org;
  }

  async verifyOrgSecret(orgId: string, secret: string): Promise<boolean> {
    const row = await this.driver.get<any>('SELECT org_secret FROM orgs WHERE id = ?', [orgId]);
    if (!row?.org_secret) return false;
    const secretHash = HubDB.hashToken(secret);
    const expected = Buffer.from(row.org_secret, 'utf8');
    const actual = Buffer.from(secretHash, 'utf8');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Set the auth_role for a bot ('admin' or 'member').
   */
  async setBotAuthRole(botId: string, role: 'admin' | 'member'): Promise<void> {
    await this.driver.run('UPDATE bots SET auth_role = ? WHERE id = ?', [role, botId]);
  }

  /**
   * Rotate the org secret to a new hash.
   */
  async rotateOrgSecret(orgId: string, newSecretHash: string): Promise<void> {
    await this.driver.run('UPDATE orgs SET org_secret = ? WHERE id = ?', [newSecretHash, orgId]);
  }

  async getOrgById(id: string): Promise<Org | undefined> {
    const row = await this.driver.get<any>('SELECT * FROM orgs WHERE id = ?', [id]);
    if (!row) return undefined;
    return this.rowToOrg(row);
  }

  async listOrgs(): Promise<Org[]> {
    const rows = await this.driver.all<any>('SELECT * FROM orgs ORDER BY created_at');
    return rows.map(r => this.rowToOrg(r));
  }

  async updateOrgStatus(orgId: string, status: 'active' | 'suspended'): Promise<void> {
    await this.driver.run('UPDATE orgs SET status = ? WHERE id = ?', [status, orgId]);
  }

  async updateOrgName(orgId: string, name: string): Promise<void> {
    await this.driver.run('UPDATE orgs SET name = ? WHERE id = ?', [name, orgId]);
  }

  async destroyOrg(orgId: string): Promise<void> {
    // Set status first (for any in-flight requests to see)
    await this.driver.run("UPDATE orgs SET status = 'destroyed' WHERE id = ?", [orgId]);
    // CASCADE delete handles all related data (bots, channels, threads, etc.)
    await this.driver.run('DELETE FROM orgs WHERE id = ?', [orgId]);
  }

  // ─── Org Ticket Operations ─────────────────────────────

  private rowToOrgTicket(row: any): OrgTicket {
    return {
      ...row,
      code: row.code ?? null,
      reusable: !!row.reusable,
      consumed: !!row.consumed,
      created_by: row.created_by ?? null,
    };
  }

  async createOrgTicket(orgId: string, secretHash: string, options: {
    reusable?: boolean;
    expiresAt: number;
    createdBy?: string;
  }): Promise<OrgTicket> {
    const ticket: OrgTicket = {
      id: crypto.randomUUID(),
      org_id: orgId,
      secret_hash: secretHash,
      code: `tkt_${crypto.randomBytes(8).toString('hex')}`,
      reusable: options.reusable ?? false,
      expires_at: options.expiresAt,
      consumed: false,
      created_by: options.createdBy ?? null,
      created_at: Date.now(),
    };
    await this.driver.run(
      'INSERT INTO org_tickets (id, org_id, secret_hash, code, reusable, expires_at, consumed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ticket.id, ticket.org_id, ticket.secret_hash, ticket.code, ticket.reusable ? 1 : 0, ticket.expires_at, 0, ticket.created_by, ticket.created_at],
    );
    return ticket;
  }

  async redeemOrgTicket(ticketId: string): Promise<OrgTicket | undefined> {
    // Support lookup by code (tkt_xxx) or by UUID id
    const row = await this.driver.get<any>(
      'SELECT * FROM org_tickets WHERE (id = ? OR code = ?) AND consumed = 0 AND (expires_at = 0 OR expires_at > ?)',
      [ticketId, ticketId, Date.now()],
    );
    if (!row) return undefined;
    const result = await this.driver.run(
      'UPDATE org_tickets SET consumed = 1 WHERE id = ? AND consumed = 0',
      [row.id],
    );
    if (result.changes === 0) return undefined; // race condition: another consumer got it
    return this.rowToOrgTicket({ ...row, consumed: 1 });
  }

  async getOrgTicket(ticketId: string): Promise<OrgTicket | undefined> {
    // Support lookup by code (tkt_xxx) or by UUID id
    const row = await this.driver.get<any>('SELECT * FROM org_tickets WHERE id = ? OR code = ?', [ticketId, ticketId]);
    if (!row) return undefined;
    return this.rowToOrgTicket(row);
  }

  async invalidateOrgTickets(orgId: string): Promise<number> {
    const result = await this.driver.run(
      'DELETE FROM org_tickets WHERE org_id = ? AND consumed = 0',
      [orgId],
    );
    return result.changes;
  }

  async cleanupExpiredOrgTickets(): Promise<number> {
    const result = await this.driver.run(
      'DELETE FROM org_tickets WHERE expires_at <= ?',
      [Date.now()],
    );
    return result.changes;
  }

  // ─── Platform Invite Codes ────────────────────────────────

  private rowToInviteCode(row: any): PlatformInviteCode {
    return {
      id: row.id,
      code_hash: row.code_hash,
      code: row.code ?? null,
      label: row.label ?? null,
      max_uses: row.max_uses,
      use_count: row.use_count,
      expires_at: row.expires_at,
      created_at: row.created_at,
    };
  }

  async createInviteCode(codeHash: string, plaintextCode: string, options: {
    label?: string;
    maxUses?: number;
    expiresAt: number;
  }): Promise<PlatformInviteCode> {
    const code: PlatformInviteCode = {
      id: crypto.randomUUID(),
      code_hash: codeHash,
      code: plaintextCode,
      label: options.label ?? null,
      max_uses: options.maxUses ?? 0, // 0 = unlimited
      use_count: 0,
      expires_at: options.expiresAt,
      created_at: Date.now(),
    };
    await this.driver.run(
      'INSERT INTO platform_invite_codes (id, code_hash, code, label, max_uses, use_count, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [code.id, code.code_hash, code.code, code.label, code.max_uses, code.use_count, code.expires_at, code.created_at],
    );
    return code;
  }

  async listInviteCodes(): Promise<PlatformInviteCode[]> {
    const rows = await this.driver.all<any>('SELECT * FROM platform_invite_codes ORDER BY created_at DESC');
    return rows.map(r => this.rowToInviteCode(r));
  }

  /**
   * Try to consume one use of an invite code. Returns the code if successful, undefined if
   * the code is expired, exhausted, or not found.
   */
  async useInviteCode(codeHash: string, driver?: DatabaseDriver): Promise<PlatformInviteCode | undefined> {
    const d = driver ?? this.driver;
    const row = await d.get<any>(
      'SELECT * FROM platform_invite_codes WHERE code_hash = ? AND (expires_at = 0 OR expires_at > ?)',
      [codeHash, Date.now()],
    );
    if (!row) return undefined;
    const code = this.rowToInviteCode(row);
    // Check max_uses (0 = unlimited)
    if (code.max_uses > 0 && code.use_count >= code.max_uses) return undefined;
    const result = await d.run(
      'UPDATE platform_invite_codes SET use_count = use_count + 1 WHERE id = ? AND (max_uses = 0 OR use_count < max_uses)',
      [code.id],
    );
    if (result.changes === 0) return undefined; // race condition
    return { ...code, use_count: code.use_count + 1 };
  }

  /**
   * Atomically consume an invite code and create an org.
   * If org creation fails, the invite code use_count is rolled back.
   * Returns { code, org } on success, or { error } on failure.
   */
  async createOrgWithInviteCode(codeHash: string, orgName: string, persistMessages: boolean): Promise<{ code: PlatformInviteCode; org: Org } | { error: string }> {
    return await this.driver.transaction(async (txn) => {
      const code = await this.useInviteCode(codeHash, txn);
      if (!code) {
        return { error: 'Invalid, expired, or exhausted invite code' };
      }
      const org = await this.createOrg(orgName, persistMessages, txn);
      return { code, org };
    });
  }

  async deleteInviteCode(id: string): Promise<boolean> {
    const result = await this.driver.run('DELETE FROM platform_invite_codes WHERE id = ?', [id]);
    return result.changes > 0;
  }

  // ─── Token Hashing Utilities ─────────────────────────────

  /**
   * Hash a token with SHA-256 for secure storage.
   * The plaintext token is never persisted in the DB.
   */
  static hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  // ─── Bot Operations ────────────────────────────────────

  async registerBot(
    orgId: string,
    name: string,
    metadata?: Record<string, unknown> | null,
    webhookUrl?: string | null,
    webhookSecret?: string | null,
    profile?: BotProfileInput,
    authRole: AuthRole = 'member',
  ): Promise<{ bot: Bot; created: boolean; plaintextToken: string | null }> {
    // Check if bot already exists → return existing token
    const existing = await this.driver.get<any>(
      'SELECT * FROM bots WHERE org_id = ? AND name = ?',
      [orgId, name],
    );

    const now = Date.now();
    const serializedProfile = this.serializeProfileFields(profile);

    if (existing) {
      const updates: string[] = ['last_seen_at = ?'];
      const params: any[] = [now];

      if (metadata !== undefined) {
        updates.push('metadata = ?');
        params.push(metadata === null ? null : JSON.stringify(metadata));
      }
      if (webhookUrl !== undefined) {
        updates.push('webhook_url = ?');
        params.push(webhookUrl);
      }
      if (webhookSecret !== undefined) {
        updates.push('webhook_secret = ?');
        params.push(webhookSecret);
      }

      if (serializedProfile.bio !== undefined) {
        updates.push('bio = ?');
        params.push(serializedProfile.bio);
      }
      if (serializedProfile.role !== undefined) {
        updates.push('role = ?');
        params.push(serializedProfile.role);
      }
      if (serializedProfile.function !== undefined) {
        updates.push('"function" = ?');
        params.push(serializedProfile.function);
      }
      if (serializedProfile.team !== undefined) {
        updates.push('team = ?');
        params.push(serializedProfile.team);
      }
      if (serializedProfile.tags !== undefined) {
        updates.push('tags = ?');
        params.push(serializedProfile.tags);
      }
      if (serializedProfile.languages !== undefined) {
        updates.push('languages = ?');
        params.push(serializedProfile.languages);
      }
      if (serializedProfile.protocols !== undefined) {
        updates.push('protocols = ?');
        params.push(serializedProfile.protocols);
      }
      if (serializedProfile.status_text !== undefined) {
        updates.push('status_text = ?');
        params.push(serializedProfile.status_text);
      }
      if (serializedProfile.timezone !== undefined) {
        updates.push('timezone = ?');
        params.push(serializedProfile.timezone);
      }
      if (serializedProfile.active_hours !== undefined) {
        updates.push('active_hours = ?');
        params.push(serializedProfile.active_hours);
      }
      if (serializedProfile.version !== undefined) {
        updates.push('version = ?');
        params.push(serializedProfile.version);
      }
      if (serializedProfile.runtime !== undefined) {
        updates.push('runtime = ?');
        params.push(serializedProfile.runtime);
      }

      params.push(existing.id);

      await this.driver.run(
        `UPDATE bots SET ${updates.join(', ')} WHERE id = ?`,
        params,
      );

      const updated = await this.getBotById(existing.id);
      if (!updated) {
        throw new Error('Bot update failed');
      }
      return { bot: updated, created: false, plaintextToken: null };
    }

    const plaintextToken = `bot_${crypto.randomBytes(24).toString('hex')}`;
    const bot: Bot = {
      id: crypto.randomUUID(),
      org_id: orgId,
      name,
      token: plaintextToken, // will be hashed before INSERT; caller receives plaintext
      metadata: metadata === undefined ? null : (metadata === null ? null : JSON.stringify(metadata)),
      webhook_url: webhookUrl ?? null,
      webhook_secret: webhookSecret ?? null,
      bio: serializedProfile.bio ?? null,
      role: serializedProfile.role ?? null,
      function: serializedProfile.function ?? null,
      team: serializedProfile.team ?? null,
      tags: serializedProfile.tags ?? null,
      languages: serializedProfile.languages ?? null,
      protocols: serializedProfile.protocols ?? null,
      status_text: serializedProfile.status_text ?? null,
      timezone: serializedProfile.timezone ?? null,
      active_hours: serializedProfile.active_hours ?? null,
      version: serializedProfile.version ?? '1.0.0',
      runtime: serializedProfile.runtime ?? null,
      auth_role: authRole,
      online: false,
      last_seen_at: now,
      created_at: now,
    };

    const tokenHash = HubDB.hashToken(bot.token);

    await this.driver.run(
      `INSERT INTO bots (
        id, org_id, name, token, metadata, webhook_url, webhook_secret,
        bio, role, "function", team, tags, languages, protocols, status_text, timezone, active_hours, version, runtime,
        auth_role, online, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot.id,
        bot.org_id,
        bot.name,
        tokenHash, // Store hash, not plaintext
        bot.metadata,
        bot.webhook_url,
        bot.webhook_secret,
        bot.bio,
        bot.role,
        bot.function,
        bot.team,
        bot.tags,
        bot.languages,
        bot.protocols,
        bot.status_text,
        bot.timezone,
        bot.active_hours,
        bot.version,
        bot.runtime,
        bot.auth_role,
        bot.online ? 1 : 0,
        bot.last_seen_at,
        bot.created_at,
      ],
    );

    return { bot, created: true, plaintextToken };
  }

  async updateProfile(botId: string, fields: BotProfileInput): Promise<Bot | undefined> {
    const serialized = this.serializeProfileFields(fields);
    const updates: string[] = [];
    const params: any[] = [];

    if (serialized.bio !== undefined) {
      updates.push('bio = ?');
      params.push(serialized.bio);
    }
    if (serialized.role !== undefined) {
      updates.push('role = ?');
      params.push(serialized.role);
    }
    if (serialized.function !== undefined) {
      updates.push('"function" = ?');
      params.push(serialized.function);
    }
    if (serialized.team !== undefined) {
      updates.push('team = ?');
      params.push(serialized.team);
    }
    if (serialized.tags !== undefined) {
      updates.push('tags = ?');
      params.push(serialized.tags);
    }
    if (serialized.languages !== undefined) {
      updates.push('languages = ?');
      params.push(serialized.languages);
    }
    if (serialized.protocols !== undefined) {
      updates.push('protocols = ?');
      params.push(serialized.protocols);
    }
    if (serialized.status_text !== undefined) {
      updates.push('status_text = ?');
      params.push(serialized.status_text);
    }
    if (serialized.timezone !== undefined) {
      updates.push('timezone = ?');
      params.push(serialized.timezone);
    }
    if (serialized.active_hours !== undefined) {
      updates.push('active_hours = ?');
      params.push(serialized.active_hours);
    }
    if (serialized.version !== undefined) {
      updates.push('version = ?');
      params.push(serialized.version);
    }
    if (serialized.runtime !== undefined) {
      updates.push('runtime = ?');
      params.push(serialized.runtime);
    }

    if (updates.length === 0) {
      return this.getBotById(botId);
    }

    params.push(botId);

    await this.driver.run(`UPDATE bots SET ${updates.join(', ')} WHERE id = ?`, params);
    return this.getBotById(botId);
  }

  async renameBot(botId: string, newName: string): Promise<{ bot: Bot; conflict: false } | { bot: undefined; conflict: true }> {
    try {
      await this.driver.run('UPDATE bots SET name = ? WHERE id = ?', [newName, botId]);
    } catch (err: any) {
      // SQLite: SQLITE_CONSTRAINT_UNIQUE, PostgreSQL: 23505 (unique_violation)
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === '23505') {
        return { bot: undefined, conflict: true };
      }
      throw err;
    }
    const bot = await this.getBotById(botId);
    return { bot: bot!, conflict: false };
  }

  async getBotByToken(token: string): Promise<Bot | undefined> {
    const tokenHash = HubDB.hashToken(token);
    const row = await this.driver.get<any>('SELECT * FROM bots WHERE token = ?', [tokenHash]);
    if (!row) return undefined;
    return this.rowToBot(row);
  }

  async getBotById(id: string): Promise<Bot | undefined> {
    const row = await this.driver.get<any>('SELECT * FROM bots WHERE id = ?', [id]);
    if (!row) return undefined;
    return this.rowToBot(row);
  }

  async getBotByName(orgId: string, name: string): Promise<Bot | undefined> {
    const row = await this.driver.get<any>(
      'SELECT * FROM bots WHERE org_id = ? AND name = ?',
      [orgId, name],
    );
    if (!row) return undefined;
    return this.rowToBot(row);
  }

  /**
   * Paginated bot list. Cursor is a bot id; results ordered by id ASC.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  async listBotsPaginated(orgId: string, cursor: string | undefined, limit: number, search?: string): Promise<Bot[]> {
    const searchFilter = search ? ' AND name LIKE ?' : '';
    const searchParam = search ? `%${search}%` : undefined;
    if (cursor) {
      const params: any[] = [orgId, cursor];
      if (searchParam) params.push(searchParam);
      params.push(limit + 1);
      const rows = await this.driver.all<any>(
        `SELECT * FROM bots WHERE org_id = ? AND id > ?${searchFilter} ORDER BY id ASC LIMIT ?`,
        params,
      );
      return rows.map(r => this.rowToBot(r));
    }
    const params: any[] = [orgId];
    if (searchParam) params.push(searchParam);
    params.push(limit + 1);
    const rows = await this.driver.all<any>(
      `SELECT * FROM bots WHERE org_id = ?${searchFilter} ORDER BY id ASC LIMIT ?`,
      params,
    );
    return rows.map(r => this.rowToBot(r));
  }

  async listBots(orgId: string, filters?: ListBotsFilters): Promise<Bot[]> {
    const where: string[] = ['org_id = ?'];
    const params: any[] = [orgId];

    if (filters?.role) {
      where.push("LOWER(COALESCE(role, '')) = LOWER(?)");
      params.push(filters.role);
    }

    if (filters?.status) {
      const status = filters.status.toLowerCase();
      if (status === 'online') {
        where.push('online = 1');
      } else if (status === 'offline') {
        where.push('online = 0');
      } else {
        where.push("LOWER(COALESCE(status_text, '')) = LOWER(?)");
        params.push(filters.status);
      }
    }

    if (filters?.q) {
      const q = `%${filters.q}%`;
      where.push(`(
        LOWER(COALESCE(bio, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(role, '')) LIKE LOWER(?)
        OR LOWER(COALESCE("function", '')) LIKE LOWER(?)
      )`);
      params.push(q, q, q);
    }

    const rows = await this.driver.all<any>(
      `SELECT * FROM bots WHERE ${where.join(' AND ')} ORDER BY name`,
      params,
    );
    let bots = rows.map(r => this.rowToBot(r));

    if (filters?.tag) {
      const wantedTag = filters.tag.toLowerCase();
      bots = bots.filter(bot => {
        if (!bot.tags) return false;
        try {
          const tags = JSON.parse(bot.tags) as unknown;
          return Array.isArray(tags) && tags.some(tag => typeof tag === 'string' && tag.toLowerCase() === wantedTag);
        } catch {
          return false;
        }
      });
    }

    return bots;
  }

  async setBotOnline(botId: string, online: boolean): Promise<void> {
    await this.driver.run(
      'UPDATE bots SET online = ?, last_seen_at = ? WHERE id = ?',
      [online ? 1 : 0, Date.now(), botId],
    );
  }

  /** W3: Update last_seen without changing online status (for HTTP requests) */
  async touchBotLastSeen(botId: string): Promise<void> {
    await this.driver.run(
      'UPDATE bots SET last_seen_at = ? WHERE id = ?',
      [Date.now(), botId],
    );
  }

  async deleteBot(botId: string): Promise<void> {
    // Auto-close threads where this bot is the sole remaining participant
    // (ON DELETE CASCADE would orphan them, making them inaccessible via API)
    const soloThreads = await this.driver.all<{ thread_id: string }>(`
      SELECT tp.thread_id FROM thread_participants tp
      WHERE tp.bot_id = ?
        AND (SELECT COUNT(*) FROM thread_participants tp2 WHERE tp2.thread_id = tp.thread_id) = 1
    `, [botId]);
    const now = Date.now();
    for (const { thread_id } of soloThreads) {
      await this.driver.run(`
        UPDATE threads SET status = 'closed', close_reason = 'error', updated_at = ?, last_activity_at = ?, revision = revision + 1
        WHERE id = ? AND status NOT IN ('resolved', 'closed')
      `, [now, now, thread_id]);
    }

    await this.driver.run('DELETE FROM channel_members WHERE bot_id = ?', [botId]);
    await this.driver.run('DELETE FROM bots WHERE id = ?', [botId]);
  }

  // ─── Bot Token Operations (Scoped Tokens) ─────────────

  async createBotToken(botId: string, scopes: TokenScope[], label?: string | null, expiresAt?: number | null): Promise<BotToken> {
    const plaintextToken = `scoped_${crypto.randomBytes(24).toString('hex')}`;
    const token: BotToken = {
      id: crypto.randomUUID(),
      bot_id: botId,
      token: plaintextToken, // returned to caller; stored as hash
      scopes,
      label: label ?? null,
      expires_at: expiresAt ?? null,
      created_at: Date.now(),
      last_used_at: null,
    };

    const tokenHash = HubDB.hashToken(plaintextToken);

    await this.driver.run(`
      INSERT INTO bot_tokens (id, bot_id, token, scopes, label, expires_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      token.id,
      token.bot_id,
      tokenHash, // Store hash, not plaintext
      JSON.stringify(token.scopes),
      token.label,
      token.expires_at,
      token.created_at,
      token.last_used_at,
    ]);

    // Return with plaintext token so caller can return it once
    return token;
  }

  async getBotTokenByToken(token: string): Promise<BotToken | undefined> {
    const tokenHash = HubDB.hashToken(token);
    const row = await this.driver.get<any>('SELECT * FROM bot_tokens WHERE token = ?', [tokenHash]);
    if (!row) return undefined;
    return this.rowToBotToken(row);
  }

  async listBotTokens(botId: string): Promise<BotToken[]> {
    const rows = await this.driver.all<any>(
      'SELECT * FROM bot_tokens WHERE bot_id = ? ORDER BY created_at DESC',
      [botId],
    );
    return rows.map(row => this.rowToBotToken(row));
  }

  async revokeBotToken(tokenId: string, botId: string): Promise<boolean> {
    const result = await this.driver.run(
      'DELETE FROM bot_tokens WHERE id = ? AND bot_id = ?',
      [tokenId, botId],
    );
    return result.changes > 0;
  }

  async touchBotToken(tokenId: string): Promise<void> {
    await this.driver.run(
      'UPDATE bot_tokens SET last_used_at = ? WHERE id = ?',
      [Date.now(), tokenId],
    );
  }

  async cleanupExpiredTokens(batchSize = 1000): Promise<number> {
    const result = await this.driver.run(
      `DELETE FROM bot_tokens WHERE ${this.rowid} IN (SELECT ${this.rowid} FROM bot_tokens WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?)`,
      [Date.now(), batchSize],
    );
    return result.changes;
  }

  private rowToBotToken(row: any): BotToken {
    let scopes: TokenScope[];
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      scopes = ['full'];
    }
    return {
      id: row.id,
      bot_id: row.bot_id,
      token: row.token,
      scopes,
      label: row.label ?? null,
      expires_at: row.expires_at ?? null,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? null,
    };
  }

  // ─── Thread Permission Policy Operations ───────────────────

  async updateThreadPermissionPolicy(threadId: string, policy: string | null, expectedRevision?: number): Promise<Thread | undefined> {
    if (expectedRevision !== undefined) {
      const result = await this.driver.run(`
        UPDATE threads
        SET permission_policy = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `, [policy, Date.now(), threadId, expectedRevision]);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      await this.driver.run(`
        UPDATE threads
        SET permission_policy = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `, [policy, Date.now(), threadId]);
    }
    return this.getThread(threadId);
  }

  /**
   * Check if a bot is allowed to perform an action on a thread based on permission policy.
   * Returns true if allowed, false if denied.
   */
  async checkThreadPermission(thread: Thread, botId: string, action: keyof ThreadPermissionPolicy): Promise<boolean> {
    // Parse thread-level policy
    let policy: ThreadPermissionPolicy | null = null;
    if (thread.permission_policy) {
      try {
        policy = JSON.parse(thread.permission_policy);
      } catch {
        // Invalid policy JSON — fail closed (deny action)
        return false;
      }
    }

    // If thread has a policy but the specific action is null/undefined, that means
    // unrestricted for that action (per documented contract). Only fall back to org
    // default when there is NO thread-level policy at all.
    if (!policy) {
      // No thread policy — check org default
      const orgSettings = await this.getOrgSettings(thread.org_id);
      if (orgSettings.default_thread_permission_policy) {
        try {
          const orgPolicy = typeof orgSettings.default_thread_permission_policy === 'string'
            ? JSON.parse(orgSettings.default_thread_permission_policy as string)
            : orgSettings.default_thread_permission_policy;
          if (orgPolicy[action] !== undefined && orgPolicy[action] !== null) {
            policy = { [action]: orgPolicy[action] };
          }
        } catch {
          // Invalid org policy — fail closed (deny action)
          return false;
        }
      }
    }

    // No policy for this action — allow (backward compat)
    if (!policy || !policy[action] || !Array.isArray(policy[action])) {
      return true;
    }

    const allowedLabels = policy[action] as string[];

    // "*" means any participant
    if (allowedLabels.includes('*')) return true;

    // "initiator" — check if the bot is the thread initiator
    if (allowedLabels.includes('initiator') && thread.initiator_id === botId) return true;

    // Check the bot's participant label
    const participant = await this.driver.get<{ label: string | null }>(
      'SELECT label FROM thread_participants WHERE thread_id = ? AND bot_id = ?',
      [thread.id, botId],
    );

    if (!participant) return false;
    if (!participant.label) return false;

    return allowedLabels.includes(participant.label);
  }

  // ─── Channel Operations ──────────────────────────────────

  async createChannel(orgId: string, memberIds: string[], name?: string): Promise<Channel & { isNew?: boolean }> {
    // Check if a direct channel already exists between these two bots
    if (memberIds.length === 2) {
      const existing = await this.findDirectChannel(memberIds[0], memberIds[1]);
      if (existing) return { ...existing, isNew: false };
    }

    const channel: Channel = {
      id: crypto.randomUUID(),
      org_id: orgId,
      type: 'direct',
      name: name || null,
      created_at: Date.now(),
    };

    await this.driver.transaction(async (txn) => {
      await txn.run(
        'INSERT INTO channels (id, org_id, type, name, created_at) VALUES (?, ?, ?, ?, ?)',
        [channel.id, channel.org_id, channel.type, channel.name, channel.created_at],
      );
      for (const botId of memberIds) {
        await txn.run(
          'INSERT INTO channel_members (channel_id, bot_id, joined_at) VALUES (?, ?, ?)',
          [channel.id, botId, Date.now()],
        );
      }
    });

    return { ...channel, isNew: true };
  }

  private async findDirectChannel(botId1: string, botId2: string): Promise<Channel | undefined> {
    const row = await this.driver.get<any>(`
      SELECT c.* FROM channels c
      JOIN channel_members cm1 ON c.id = cm1.channel_id AND cm1.bot_id = ?
      JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.bot_id = ?
      WHERE c.type = 'direct'
      LIMIT 1
    `, [botId1, botId2]);
    return row || undefined;
  }

  async getChannel(channelId: string): Promise<Channel | undefined> {
    return await this.driver.get<Channel>('SELECT * FROM channels WHERE id = ?', [channelId]);
  }

  async getChannelMembers(channelId: string): Promise<ChannelMember[]> {
    return await this.driver.all<ChannelMember>(
      'SELECT * FROM channel_members WHERE channel_id = ?',
      [channelId],
    );
  }

  async isChannelMember(channelId: string, botId: string): Promise<boolean> {
    const row = await this.driver.get(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND bot_id = ?',
      [channelId, botId],
    );
    return !!row;
  }

  /**
   * Get all channels a bot participates in, with member info and last activity time.
   * Returns channels sorted by most recent activity first.
   */
  async getChannelsForBot(botId: string): Promise<{ id: string; type: string; name: string | null; created_at: number; last_activity_at: number; members: { id: string; name: string; online: boolean }[] }[]> {
    const channels = await this.driver.all<any>(`
      SELECT c.*, COALESCE(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
        c.created_at
      ) AS last_activity_at
      FROM channels c
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE cm.bot_id = ?
      ORDER BY last_activity_at DESC
    `, [botId]);

    const result: { id: string; type: string; name: string | null; created_at: number; last_activity_at: number; members: { id: string; name: string; online: boolean }[] }[] = [];
    for (const ch of channels) {
      const memberRows = await this.getChannelMembers(ch.id);
      const members: { id: string; name: string; online: boolean }[] = [];
      for (const m of memberRows) {
        const bot = await this.getBotById(m.bot_id);
        members.push({ id: m.bot_id, name: bot?.name ?? 'unknown', online: bot?.online ?? false });
      }
      result.push({
        id: ch.id,
        type: ch.type,
        name: ch.name,
        created_at: ch.created_at,
        last_activity_at: ch.last_activity_at,
        members,
      });
    }
    return result;
  }

  // ─── Message Operations ──────────────────────────────────

  async createMessage(channelId: string, senderId: string, content: string, contentType = 'text', parts?: string | null): Promise<Message> {
    const msg: Message = {
      id: crypto.randomUUID(),
      channel_id: channelId,
      sender_id: senderId,
      content,
      content_type: contentType as Message['content_type'],
      parts: parts ?? null,
      created_at: Date.now(),
    };

    await this.driver.run(
      `INSERT INTO messages (id, channel_id, sender_id, content, content_type, parts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [msg.id, msg.channel_id, msg.sender_id, msg.content, msg.content_type, msg.parts, msg.created_at],
    );

    return msg;
  }

  async getMessages(channelId: string, limit = 50, before?: number, since?: number): Promise<Message[]> {
    const conditions = ['channel_id = ?'];
    const params: any[] = [channelId];

    if (before !== undefined) { conditions.push('created_at < ?'); params.push(before); }
    if (since !== undefined)  { conditions.push('created_at > ?'); params.push(since); }

    params.push(limit);
    return await this.driver.all<Message>(
      `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
  }

  /**
   * Paginated channel messages (newest first). `before` is a message id.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  async getMessagesPaginated(channelId: string, before: string | undefined, limit: number): Promise<Message[]> {
    if (before) {
      // Get the created_at of the cursor message so we can seek efficiently
      const cursorRow = await this.driver.get<{ created_at: number }>(
        'SELECT created_at FROM messages WHERE id = ?',
        [before],
      );
      if (!cursorRow) {
        // Unknown cursor — return from newest with stable ordering
        return await this.driver.all<Message>(
          'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          [channelId, limit + 1],
        );
      }
      // Use (created_at, id) for stable ordering when timestamps collide
      return await this.driver.all<Message>(
        `SELECT * FROM messages WHERE channel_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
        [channelId, cursorRow.created_at, cursorRow.created_at, before, limit + 1],
      );
    }
    // No cursor — start from newest with stable ordering
    return await this.driver.all<Message>(
      'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [channelId, limit + 1],
    );
  }

  async getNewMessages(botId: string, since: number): Promise<(Message & { channel_name?: string })[]> {
    return await this.driver.all<Message & { channel_name?: string }>(`
      SELECT m.*, ch.name as channel_name FROM messages m
      JOIN channel_members cm ON m.channel_id = cm.channel_id AND cm.bot_id = ?
      JOIN channels ch ON m.channel_id = ch.id
      WHERE m.created_at > ? AND m.sender_id != ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [botId, since, botId]);
  }

  // ─── Thread Operations ───────────────────────────────────

  async createThread(
    orgId: string,
    initiatorId: string,
    topic: string,
    tags: string[] | null,
    participantIds: string[],
    channelId?: string | null,
    context?: string | null,
    permissionPolicy?: string | null,
  ): Promise<Thread> {
    const uniqueParticipantIds = Array.from(new Set([initiatorId, ...participantIds]));

    const now = Date.now();
    const thread: Thread = {
      id: crypto.randomUUID(),
      org_id: orgId,
      topic,
      tags,
      status: 'active',
      initiator_id: initiatorId,
      channel_id: channelId ?? null,
      context: context ?? null,
      close_reason: null,
      permission_policy: permissionPolicy ?? null,
      revision: 1,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      resolved_at: null,
    };

    await this.driver.transaction(async (txn) => {
      const initiatorRow = await txn.get<{ org_id: string }>('SELECT org_id FROM bots WHERE id = ?', [initiatorId]);
      if (!initiatorRow || initiatorRow.org_id !== orgId) {
        throw new Error('Invalid initiator');
      }

      for (const participantId of uniqueParticipantIds) {
        const participantRow = await txn.get<{ org_id: string }>('SELECT org_id FROM bots WHERE id = ?', [participantId]);
        if (!participantRow || participantRow.org_id !== orgId) {
          throw new Error(`Participant not in org: ${participantId}`);
        }
      }

      if (channelId) {
        const channelRow = await txn.get<{ org_id: string }>('SELECT org_id FROM channels WHERE id = ?', [channelId]);
        if (!channelRow || channelRow.org_id !== orgId) {
          throw new Error('Invalid channel_id for thread org');
        }
      }

      await txn.run(`
        INSERT INTO threads (
          id, org_id, topic, tags, status, initiator_id, channel_id, context, close_reason,
          permission_policy, revision, created_at, updated_at, last_activity_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        thread.id,
        thread.org_id,
        thread.topic,
        thread.tags ? JSON.stringify(thread.tags) : null,
        thread.status,
        thread.initiator_id,
        thread.channel_id,
        thread.context,
        thread.close_reason,
        thread.permission_policy,
        thread.revision,
        thread.created_at,
        thread.updated_at,
        thread.last_activity_at,
        thread.resolved_at,
      ]);

      for (const participantId of uniqueParticipantIds) {
        await txn.run(`
          INSERT INTO thread_participants (thread_id, bot_id, label, joined_at)
          VALUES (?, ?, ?, ?)
        `, [thread.id, participantId, null, now]);
      }
    });

    return thread;
  }

  async getThread(threadId: string): Promise<Thread | undefined> {
    const row = await this.driver.get<any>('SELECT * FROM threads WHERE id = ?', [threadId]);
    if (!row) return undefined;
    return this.rowToThread(row);
  }

  async listThreadsForOrg(orgId: string, status?: ThreadStatus, limit = 200, offset = 0): Promise<(Thread & { participant_count: number })[]> {
    const base = 'SELECT *, (SELECT COUNT(*) FROM thread_participants tp WHERE tp.thread_id = threads.id) AS _pc FROM threads WHERE org_id = ?';
    const query = status
      ? `${base} AND status = ? ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`
      : `${base} ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`;
    const rows = status
      ? await this.driver.all<any>(query, [orgId, status, limit, offset])
      : await this.driver.all<any>(query, [orgId, limit, offset]);
    return rows.map((row: any) => {
      const count = Number(row._pc);
      delete row._pc;
      return { ...this.rowToThread(row), participant_count: count };
    });
  }

  /**
   * Paginated thread list for org. Cursor is "last_activity_at|id" for stable ordering.
   * Ordered by last_activity_at DESC, id DESC (tie-breaker). Returns limit+1 rows for has_more.
   */
  async listThreadsForOrgPaginated(orgId: string, status: ThreadStatus | undefined, cursor: string | undefined, limit: number, search?: string): Promise<(Thread & { participant_count: number })[]> {
    const conditions = ['org_id = ?'];
    const params: any[] = [orgId];

    if (status) { conditions.push('status = ?'); params.push(status); }
    if (cursor) {
      const sep = cursor.indexOf('|');
      if (sep > 0) {
        // Composite cursor: last_activity_at|id
        const cursorTime = cursor.slice(0, sep);
        const cursorId = cursor.slice(sep + 1);
        conditions.push('(last_activity_at < ? OR (last_activity_at = ? AND id < ?))');
        params.push(cursorTime, cursorTime, cursorId);
      } else {
        // Legacy: timestamp-only cursor
        conditions.push('last_activity_at < ?');
        params.push(cursor);
      }
    }
    if (search) { conditions.push('topic LIKE ?'); params.push(`%${search}%`); }

    params.push(limit + 1);
    const rows = await this.driver.all<any>(
      `SELECT *, (SELECT COUNT(*) FROM thread_participants tp WHERE tp.thread_id = threads.id) AS _pc FROM threads WHERE ${conditions.join(' AND ')} ORDER BY last_activity_at DESC, id DESC LIMIT ?`,
      params,
    );
    return rows.map((row: any) => {
      const count = Number(row._pc);
      delete row._pc;
      return { ...this.rowToThread(row), participant_count: count };
    });
  }

  async listThreadsForBot(botId: string, status?: ThreadStatus, limit = 200): Promise<(Thread & { participant_count: number })[]> {
    const base = `
      SELECT t.*, (SELECT COUNT(*) FROM thread_participants tp2 WHERE tp2.thread_id = t.id) AS participant_count
      FROM threads t
      JOIN thread_participants tp ON t.id = tp.thread_id
      WHERE tp.bot_id = ?
    `;

    const query = status
      ? `${base} AND t.status = ? ORDER BY t.last_activity_at DESC LIMIT ?`
      : `${base} ORDER BY t.last_activity_at DESC LIMIT ?`;
    const rows = status
      ? await this.driver.all<any>(query, [botId, status, limit])
      : await this.driver.all<any>(query, [botId, limit]);
    return rows.map((row: any) => {
      const count = Number(row.participant_count);
      delete row.participant_count;
      return { ...this.rowToThread(row), participant_count: count };
    });
  }

  /**
   * Cursor-paginated thread list for a bot.
   * Cursor key: (last_activity_at DESC, id DESC), opaque-encoded.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  async listThreadsForBotPaginated(
    botId: string,
    opts: { status?: ThreadStatus; cursor?: string; limit: number; search?: string },
  ): Promise<(Thread & { participant_count: number })[]> {
    const conditions = ['tp.bot_id = ?'];
    const params: any[] = [botId];

    if (opts.status) { conditions.push('t.status = ?'); params.push(opts.status); }
    if (opts.search) { conditions.push('t.topic LIKE ?'); params.push(`%${opts.search}%`); }

    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      if (c) {
        conditions.push('(t.last_activity_at < ? OR (t.last_activity_at = ? AND t.id < ?))');
        params.push(c.t, c.t, c.id);
      }
    }

    params.push(opts.limit + 1);
    const rows = await this.driver.all<any>(`
      SELECT t.*, (SELECT COUNT(*) FROM thread_participants tp2 WHERE tp2.thread_id = t.id) AS participant_count
      FROM threads t
      JOIN thread_participants tp ON t.id = tp.thread_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.last_activity_at DESC, t.id DESC
      LIMIT ?
    `, params);

    return rows.map((row: any) => {
      const count = Number(row.participant_count);
      delete row.participant_count;
      return { ...this.rowToThread(row), participant_count: count };
    });
  }

  /**
   * Paginated DM channels for a bot with last message preview and counterpart bot info.
   * Sorted by last activity (most recent message or channel creation) DESC.
   * Returns limit+1 rows for has_more detection.
   */
  async getWorkspaceDMs(
    botId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    channel: Channel;
    counterpart_bot: { id: string; name: string; online: boolean; bio: string | null; role: string | null };
    last_message_preview: { content: string; sender_id: string; sender_name: string; created_at: number } | null;
    last_activity_at: number;
  }[]> {
    // Use a subquery so that last_activity_at alias is available in the outer
    // WHERE and ORDER BY — PostgreSQL does not allow alias references in WHERE.
    const innerConditions = ['cm.bot_id = ?', "c.type = 'direct'"];
    const params: any[] = [botId];

    const innerSql = `
      SELECT c.*, COALESCE(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
        c.created_at
      ) AS last_activity_at
      FROM channels c
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE ${innerConditions.join(' AND ')}
    `;

    const outerConditions: string[] = [];
    if (cursor) {
      const c = decodeCursor(cursor);
      if (c) {
        outerConditions.push('(last_activity_at < ? OR (last_activity_at = ? AND id < ?))');
        params.push(c.t, c.t, c.id);
      }
    }

    const outerWhere = outerConditions.length > 0 ? `WHERE ${outerConditions.join(' AND ')}` : '';
    params.push(limit + 1);
    const channels = await this.driver.all<any>(`
      SELECT * FROM (${innerSql}) AS sub
      ${outerWhere}
      ORDER BY last_activity_at DESC, id DESC
      LIMIT ?
    `, params);

    const result: {
      channel: Channel;
      counterpart_bot: { id: string; name: string; online: boolean; bio: string | null; role: string | null };
      last_message_preview: { content: string; sender_id: string; sender_name: string; created_at: number } | null;
      last_activity_at: number;
    }[] = [];

    for (const ch of channels) {
      const lastActivityAt = ch.last_activity_at;
      delete ch.last_activity_at;

      // Find counterpart bot
      const counterpartRow = await this.driver.get<any>(
        'SELECT b.id, b.name, b.online, b.bio, b.role FROM channel_members cm JOIN bots b ON cm.bot_id = b.id WHERE cm.channel_id = ? AND cm.bot_id != ?',
        [ch.id, botId],
      );
      const counterpart = counterpartRow
        ? { id: counterpartRow.id, name: counterpartRow.name, online: !!counterpartRow.online, bio: counterpartRow.bio ?? null, role: counterpartRow.role ?? null }
        : { id: 'unknown', name: 'unknown', online: false, bio: null, role: null };

      // Get last message preview
      const lastMsg = await this.driver.get<any>(
        'SELECT m.content, m.sender_id, m.created_at FROM messages m WHERE m.channel_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 1',
        [ch.id],
      );
      let lastMessagePreview = null;
      if (lastMsg) {
        const senderBot = await this.getBotById(lastMsg.sender_id);
        lastMessagePreview = {
          content: lastMsg.content.length > 200 ? lastMsg.content.slice(0, 200) + '…' : lastMsg.content,
          sender_id: lastMsg.sender_id,
          sender_name: senderBot?.name ?? 'unknown',
          created_at: lastMsg.created_at,
        };
      }

      result.push({
        channel: { id: ch.id, org_id: ch.org_id, type: ch.type, name: ch.name, created_at: ch.created_at },
        counterpart_bot: counterpart,
        last_message_preview: lastMessagePreview,
        last_activity_at: lastActivityAt,
      });
    }

    return result;
  }

  async updateThreadStatus(threadId: string, status: ThreadStatus, closeReason?: CloseReason | null, expectedRevision?: number): Promise<Thread | undefined> {
    const current = await this.getThread(threadId);
    if (!current) return undefined;

    // Explicit allowed-transitions map (5-state machine):
    //   active ↔ blocked/reviewing → resolved
    //   Any non-terminal state can → closed
    //   resolved/closed → active (reopen)
    const ALLOWED_TRANSITIONS: Record<string, string[]> = {
      active:    ['blocked', 'reviewing', 'resolved', 'closed'],
      blocked:   ['active'],
      reviewing: ['active', 'resolved', 'closed'],
      resolved:  ['active'],
      closed:    ['active'],
    };

    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(status)) {
      throw new Error(`Cannot transition from '${current.status}' to '${status}'`);
    }

    if (status === 'closed' && !closeReason) {
      throw new Error('close_reason is required for closed status');
    }

    if (status !== 'closed' && closeReason) {
      throw new Error('close_reason is only allowed with closed status');
    }

    const now = Date.now();
    // Set resolved_at on first resolve; clear on reopen so re-resolve gets a fresh timestamp
    const resolvedAt = status === 'resolved' ? (current.resolved_at ?? now)
      : status === 'active' ? null
      : current.resolved_at;
    const reason = status === 'closed' ? (closeReason ?? null) : null;

    if (expectedRevision !== undefined) {
      const result = await this.driver.run(`
        UPDATE threads
        SET status = ?, close_reason = ?, resolved_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `, [status, reason, resolvedAt, now, threadId, expectedRevision]);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      await this.driver.run(`
        UPDATE threads
        SET status = ?, close_reason = ?, resolved_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `, [status, reason, resolvedAt, now, threadId]);
    }

    return this.getThread(threadId);
  }

  async updateThreadContext(threadId: string, context: string | null, expectedRevision?: number): Promise<Thread | undefined> {
    const current = await this.getThread(threadId);
    if (!current) return undefined;

    if (expectedRevision !== undefined) {
      const result = await this.driver.run(`
        UPDATE threads
        SET context = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `, [context, Date.now(), threadId, expectedRevision]);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      await this.driver.run(`
        UPDATE threads
        SET context = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `, [context, Date.now(), threadId]);
    }

    return this.getThread(threadId);
  }

  async updateThreadTopic(threadId: string, topic: string, expectedRevision?: number): Promise<Thread | undefined> {
    const current = await this.getThread(threadId);
    if (!current) return undefined;

    if (expectedRevision !== undefined) {
      const result = await this.driver.run(`
        UPDATE threads
        SET topic = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `, [topic, Date.now(), threadId, expectedRevision]);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      await this.driver.run(`
        UPDATE threads
        SET topic = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `, [topic, Date.now(), threadId]);
    }

    return this.getThread(threadId);
  }

  async addParticipant(threadId: string, botId: string, label?: string | null): Promise<ThreadParticipant> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }

    const bot = await this.getBotById(botId);
    if (!bot || bot.org_id !== thread.org_id) {
      throw new Error('Participant bot not found in thread org');
    }

    const existing = await this.driver.get<any>(`
      SELECT * FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `, [threadId, botId]);

    if (existing) {
      if (label !== undefined) {
        await this.driver.transaction(async (txn) => {
          await txn.run(`
            UPDATE thread_participants SET label = ? WHERE thread_id = ? AND bot_id = ?
          `, [label ?? null, threadId, botId]);
          await txn.run(`
            UPDATE threads SET revision = revision + 1, updated_at = ? WHERE id = ?
          `, [Date.now(), threadId]);
        });
        const updated = await this.driver.get<any>(`
          SELECT * FROM thread_participants WHERE thread_id = ? AND bot_id = ?
        `, [threadId, botId]);
        return this.rowToThreadParticipant(updated);
      }
      return this.rowToThreadParticipant(existing);
    }

    await this.driver.transaction(async (txn) => {
      await txn.run(`
        INSERT INTO thread_participants (thread_id, bot_id, label, joined_at)
        VALUES (?, ?, ?, ?)
      `, [threadId, botId, label ?? null, Date.now()]);
      await txn.run(`
        UPDATE threads SET revision = revision + 1, updated_at = ? WHERE id = ?
      `, [Date.now(), threadId]);
    });

    const row = await this.driver.get<any>(`
      SELECT * FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `, [threadId, botId]);

    return this.rowToThreadParticipant(row);
  }

  async removeParticipant(threadId: string, botId: string): Promise<void> {
    await this.driver.transaction(async (txn) => {
      const result = await txn.run(`
        DELETE FROM thread_participants WHERE thread_id = ? AND bot_id = ?
      `, [threadId, botId]);
      if (result.changes > 0) {
        await txn.run(`
          UPDATE threads SET revision = revision + 1, updated_at = ? WHERE id = ?
        `, [Date.now(), threadId]);
      }
    });
  }

  async getParticipants(threadId: string): Promise<ThreadParticipant[]> {
    const rows = await this.driver.all<any>(`
      SELECT * FROM thread_participants WHERE thread_id = ? ORDER BY joined_at
    `, [threadId]);
    return rows.map(row => this.rowToThreadParticipant(row));
  }

  async isParticipant(threadId: string, botId: string): Promise<boolean> {
    const row = await this.driver.get(`
      SELECT 1 FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `, [threadId, botId]);
    return !!row;
  }

  async createThreadMessage(
    threadId: string,
    senderId: string,
    content: string,
    contentType = 'text',
    metadata?: string | null,
    parts?: string | null,
    mentions?: string | null,
    mentionAll?: number,
    replyToId?: string | null,
  ): Promise<ThreadMessage> {
    const msg: ThreadMessage = {
      id: crypto.randomUUID(),
      thread_id: threadId,
      sender_id: senderId,
      content,
      content_type: contentType,
      parts: parts ?? null,
      metadata: metadata ?? null,
      mentions: mentions ?? null,
      mention_all: mentionAll ?? 0,
      reply_to_id: replyToId ?? null,
      created_at: Date.now(),
    };

    await this.driver.transaction(async (txn) => {
      await txn.run(`
        INSERT INTO thread_messages (id, thread_id, sender_id, content, content_type, parts, metadata, mentions, mention_all, reply_to_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        msg.id,
        msg.thread_id,
        msg.sender_id,
        msg.content,
        msg.content_type,
        msg.parts,
        msg.metadata,
        msg.mentions,
        msg.mention_all,
        msg.reply_to_id,
        msg.created_at,
      ]);
      await txn.run(`
        UPDATE threads SET last_activity_at = ? WHERE id = ?
      `, [msg.created_at, threadId]);
    });

    return msg;
  }

  async getThreadMessageById(messageId: string): Promise<ThreadMessage | null> {
    const row = await this.driver.get<any>(
      'SELECT * FROM thread_messages WHERE id = ?',
      [messageId],
    );
    return row ? this.rowToThreadMessage(row) : null;
  }

  async getThreadMessages(threadId: string, limit = 50, before?: number, since?: number): Promise<ThreadMessage[]> {
    const conditions = ['thread_id = ?'];
    const params: any[] = [threadId];

    if (before !== undefined) { conditions.push('created_at < ?'); params.push(before); }
    if (since !== undefined)  { conditions.push('created_at > ?'); params.push(since); }

    params.push(limit);
    const rows = await this.driver.all<any>(
      `SELECT * FROM thread_messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );

    return rows.map(row => this.rowToThreadMessage(row));
  }

  /**
   * Paginated thread messages (newest first). `before` is a message id.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  async getThreadMessagesPaginated(threadId: string, before: string | undefined, limit: number): Promise<ThreadMessage[]> {
    if (before) {
      const cursorRow = await this.driver.get<{ created_at: number }>(
        'SELECT created_at FROM thread_messages WHERE id = ?',
        [before],
      );
      if (!cursorRow) {
        // Unknown cursor — fall back to newest; include id tiebreaker for stable ordering
        const rows = await this.driver.all<any>(
          'SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          [threadId, limit + 1],
        );
        return rows.map(row => this.rowToThreadMessage(row));
      }
      const rows = await this.driver.all<any>(
        `SELECT * FROM thread_messages WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
        [threadId, cursorRow.created_at, cursorRow.created_at, before, limit + 1],
      );
      return rows.map(row => this.rowToThreadMessage(row));
    }
    // No cursor — start from newest; include id tiebreaker for stable ordering
    const rows = await this.driver.all<any>(
      'SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [threadId, limit + 1],
    );
    return rows.map(row => this.rowToThreadMessage(row));
  }

  async addArtifact(
    threadId: string,
    contributorId: string,
    key: string,
    type: ArtifactType,
    title?: string | null,
    content?: string | null,
    language?: string | null,
    url?: string | null,
    mimeType?: string | null,
  ): Promise<Artifact> {
    const now = Date.now();
    const normalized = this.normalizeJsonArtifactContent(type, content ?? null);

    return await this.driver.transaction(async (txn) => {
      const nextVersionRow = await txn.get<{ max_version: number | null }>(`
        SELECT MAX(version) as max_version FROM artifacts
        WHERE thread_id = ? AND artifact_key = ?
      `, [threadId, key]);
      const nextVersion = (nextVersionRow?.max_version ?? 0) + 1;

      const artifact: Artifact = {
        id: crypto.randomUUID(),
        thread_id: threadId,
        artifact_key: key,
        type: normalized.type,
        title: title ?? null,
        content: normalized.content,
        language: language ?? null,
        url: url ?? null,
        mime_type: mimeType ?? null,
        contributor_id: contributorId,
        version: nextVersion,
        format_warning: normalized.format_warning,
        created_at: now,
        updated_at: now,
      };

      await txn.run(`
        INSERT INTO artifacts (
          id, thread_id, artifact_key, type, title, content, language, url, mime_type,
          contributor_id, version, format_warning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        artifact.id,
        artifact.thread_id,
        artifact.artifact_key,
        artifact.type,
        artifact.title,
        artifact.content,
        artifact.language,
        artifact.url,
        artifact.mime_type,
        artifact.contributor_id,
        artifact.version,
        artifact.format_warning ? 1 : 0,
        artifact.created_at,
        artifact.updated_at,
      ]);
      await txn.run(`
        UPDATE threads SET last_activity_at = ? WHERE id = ?
      `, [now, threadId]);

      return artifact;
    });
  }

  async updateArtifact(
    threadId: string,
    key: string,
    contributorId: string,
    content: string,
    title?: string | null,
  ): Promise<Artifact | undefined> {
    return await this.driver.transaction(async (txn) => {
      const latestRow = await txn.get<any>(`
        SELECT * FROM artifacts
        WHERE thread_id = ? AND artifact_key = ?
        ORDER BY version DESC
        LIMIT 1
      `, [threadId, key]);
      if (!latestRow) return undefined;
      const latest = this.rowToArtifact(latestRow);

      const nextVersionRow = await txn.get<{ max_version: number | null }>(`
        SELECT MAX(version) as max_version FROM artifacts
        WHERE thread_id = ? AND artifact_key = ?
      `, [threadId, key]);
      const nextVersion = (nextVersionRow?.max_version ?? latest.version) + 1;

      // Use the original declared type for normalization so a downgraded JSON
      // artifact can recover when valid JSON is submitted again.
      // If v1 has format_warning, it was originally declared as 'json' but
      // downgraded to 'text' due to malformed content — treat as 'json'.
      const originalRow = await txn.get<{ type: string; format_warning: number }>(`
        SELECT type, format_warning FROM artifacts
        WHERE thread_id = ? AND artifact_key = ? AND version = 1
      `, [threadId, key]);
      const baseType = (originalRow?.format_warning ? 'json' : originalRow?.type ?? latest.type) as ArtifactType;

      const now = Date.now();
      const normalized = this.normalizeJsonArtifactContent(baseType, content);
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        thread_id: threadId,
        artifact_key: key,
        type: normalized.type,
        title: title === undefined ? latest.title : (title ?? null),
        content: normalized.content,
        language: latest.language,
        url: latest.url,
        mime_type: latest.mime_type,
        contributor_id: contributorId,
        version: nextVersion,
        format_warning: normalized.format_warning,
        created_at: now,
        updated_at: now,
      };

      await txn.run(`
        INSERT INTO artifacts (
          id, thread_id, artifact_key, type, title, content, language, url, mime_type,
          contributor_id, version, format_warning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        artifact.id,
        artifact.thread_id,
        artifact.artifact_key,
        artifact.type,
        artifact.title,
        artifact.content,
        artifact.language,
        artifact.url,
        artifact.mime_type,
        artifact.contributor_id,
        artifact.version,
        artifact.format_warning ? 1 : 0,
        artifact.created_at,
        artifact.updated_at,
      ]);
      await txn.run(`
        UPDATE threads SET last_activity_at = ? WHERE id = ?
      `, [now, threadId]);

      return artifact;
    });
  }

  async getArtifact(threadId: string, key: string, version?: number): Promise<Artifact | undefined> {
    const row = version === undefined
      ? await this.driver.get<any>(`
          SELECT * FROM artifacts
          WHERE thread_id = ? AND artifact_key = ?
          ORDER BY version DESC
          LIMIT 1
        `, [threadId, key])
      : await this.driver.get<any>(`
          SELECT * FROM artifacts
          WHERE thread_id = ? AND artifact_key = ? AND version = ?
          LIMIT 1
        `, [threadId, key, version]);

    if (!row) return undefined;
    return this.rowToArtifact(row);
  }

  async listArtifacts(threadId: string): Promise<Artifact[]> {
    const rows = await this.driver.all<any>(`
      SELECT a.* FROM artifacts a
      JOIN (
        SELECT artifact_key, MAX(version) as max_version
        FROM artifacts
        WHERE thread_id = ?
        GROUP BY artifact_key
      ) latest ON a.artifact_key = latest.artifact_key AND a.version = latest.max_version
      WHERE a.thread_id = ?
      ORDER BY a.created_at ASC
    `, [threadId, threadId]);

    return rows.map(row => this.rowToArtifact(row));
  }

  /**
   * Paginated artifact list (latest version per key). Cursor is an artifact_key.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  async listArtifactsPaginated(threadId: string, cursor: string | undefined, limit: number): Promise<Artifact[]> {
    const cursorClause = cursor ? 'AND a.artifact_key > ?' : '';
    const params: any[] = cursor
      ? [threadId, threadId, cursor, limit + 1]
      : [threadId, threadId, limit + 1];
    const rows = await this.driver.all<any>(`
      SELECT a.* FROM artifacts a
      JOIN (
        SELECT artifact_key, MAX(version) as max_version
        FROM artifacts
        WHERE thread_id = ?
        GROUP BY artifact_key
      ) latest ON a.artifact_key = latest.artifact_key AND a.version = latest.max_version
      WHERE a.thread_id = ? ${cursorClause}
      ORDER BY a.artifact_key ASC
      LIMIT ?
    `, params);

    return rows.map(row => this.rowToArtifact(row));
  }

  async getArtifactVersions(threadId: string, key: string): Promise<Artifact[]> {
    const rows = await this.driver.all<any>(`
      SELECT * FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
      ORDER BY version ASC
    `, [threadId, key]);

    return rows.map(row => this.rowToArtifact(row));
  }

  // ─── File Operations ────────────────────────────────────

  async createFile(orgId: string, uploaderId: string, name: string, mimeType: string | null, size: number, diskPath: string): Promise<FileRecord> {
    const file: FileRecord = {
      id: crypto.randomUUID(),
      org_id: orgId,
      uploader_id: uploaderId,
      name,
      mime_type: mimeType,
      size,
      path: diskPath,
      created_at: Date.now(),
    };

    await this.driver.run(`
      INSERT INTO files (id, org_id, uploader_id, name, mime_type, size, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [file.id, file.org_id, file.uploader_id, file.name, file.mime_type, file.size, file.path, file.created_at]);

    return file;
  }

  async getFile(fileId: string): Promise<FileRecord | undefined> {
    const row = await this.driver.get<FileRecord>('SELECT * FROM files WHERE id = ?', [fileId]);
    return row || undefined;
  }

  async getFileInfo(fileId: string): Promise<FileRecord | undefined> {
    return this.getFile(fileId);
  }

  async getDailyUploadBytes(orgId: string): Promise<number> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const row = await this.driver.get<{ total: number | string }>(
      'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE org_id = ? AND created_at >= ?',
      [orgId, dayStart.getTime()],
    );
    return Number(row!.total);
  }


  /**
   * Atomically check daily upload quota (org-level + per-bot) and create file record.
   * Prevents TOCTOU race where concurrent uploads both pass the quota check.
   */
  async createFileWithQuotaCheck(
    orgId: string,
    uploaderId: string,
    name: string,
    mimeType: string | null,
    size: number,
    diskPath: string,
    dailyLimitBytes: number,
    perBotDailyLimitBytes: number,
  ): Promise<{ ok: true; file: FileRecord } | { ok: false; reason: 'org' | 'bot'; dailyBytes: number; limitBytes: number }> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();

    return await this.driver.transaction(async (txn) => {
      // Check org-level daily quota
      // Note: pg returns SUM/COUNT as string (int8) — always coerce with Number()
      const orgRow = await txn.get<{ total: number | string }>(
        'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE org_id = ? AND created_at >= ?',
        [orgId, dayStartMs],
      );
      const orgTotal = Number(orgRow!.total);
      if (orgTotal + size > dailyLimitBytes) {
        return { ok: false as const, reason: 'org' as const, dailyBytes: orgTotal, limitBytes: dailyLimitBytes };
      }

      // Check per-bot daily quota
      if (perBotDailyLimitBytes > 0) {
        const botRow = await txn.get<{ total: number | string }>(
          'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE org_id = ? AND uploader_id = ? AND created_at >= ?',
          [orgId, uploaderId, dayStartMs],
        );
        const botTotal = Number(botRow!.total);
        if (botTotal + size > perBotDailyLimitBytes) {
          return { ok: false as const, reason: 'bot' as const, dailyBytes: botTotal, limitBytes: perBotDailyLimitBytes };
        }
      }

      const file: FileRecord = {
        id: crypto.randomUUID(),
        org_id: orgId,
        uploader_id: uploaderId,
        name,
        mime_type: mimeType,
        size,
        path: diskPath,
        created_at: Date.now(),
      };

      await txn.run(
        'INSERT INTO files (id, org_id, uploader_id, name, mime_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [file.id, file.org_id, file.uploader_id, file.name, file.mime_type, file.size, file.path, file.created_at],
      );
      return { ok: true as const, file };
    });
  }

  // ─── Catchup Event Operations ─────────────────────────────

  async recordCatchupEvent(orgId: string, targetBotId: string, type: string, payload: Record<string, unknown>, refId?: string): Promise<void> {
    const now = Date.now();

    // For aggregatable events (summaries): UPSERT by (target_bot_id, type, ref_id)
    // to avoid flooding catchup with one row per message
    if (refId) {
      const existing = await this.driver.get<{ id: string; payload: string }>(
        'SELECT id, payload FROM catchup_events WHERE target_bot_id = ? AND type = ? AND ref_id = ?',
        [targetBotId, type, refId],
      );

      if (existing) {
        const prev = JSON.parse(existing.payload);
        const merged = { ...prev, ...payload, count: (prev.count || 0) + (payload.count as number || 1) };
        await this.driver.run(
          'UPDATE catchup_events SET payload = ?, occurred_at = ? WHERE id = ?',
          [JSON.stringify(merged), now, existing.id],
        );
        return;
      }
    }

    const id = crypto.randomUUID();
    await this.driver.run(`
      INSERT INTO catchup_events (id, org_id, target_bot_id, type, ref_id, payload, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, orgId, targetBotId, type, refId ?? null, JSON.stringify(payload), now]);
  }

  async getCatchupEvents(botId: string, since: number, limit = 50, cursor?: string): Promise<{ events: CatchupEvent[]; has_more: boolean }> {
    let rows: any[];

    if (cursor) {
      // Cursor is the last event_id from previous page — get its occurred_at for efficient seek
      const cursorRow = await this.driver.get<{ occurred_at: number }>(
        'SELECT occurred_at FROM catchup_events WHERE id = ?',
        [cursor],
      );

      if (cursorRow) {
        // Seek past the cursor using (occurred_at, id) tuple comparison
        rows = await this.driver.all<any>(`
          SELECT * FROM catchup_events
          WHERE target_bot_id = ? AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
          ORDER BY occurred_at ASC, id ASC
          LIMIT ?
        `, [botId, cursorRow.occurred_at, cursorRow.occurred_at, cursor, limit + 1]);
      } else {
        // Invalid cursor — fall back to since-only query
        rows = await this.driver.all<any>(`
          SELECT * FROM catchup_events
          WHERE target_bot_id = ? AND occurred_at > ?
          ORDER BY occurred_at ASC, id ASC
          LIMIT ?
        `, [botId, since, limit + 1]);
      }
    } else {
      rows = await this.driver.all<any>(`
        SELECT * FROM catchup_events
        WHERE target_bot_id = ? AND occurred_at > ?
        ORDER BY occurred_at ASC, id ASC
        LIMIT ?
      `, [botId, since, limit + 1]);
    }

    const has_more = rows.length > limit;
    if (has_more) rows = rows.slice(0, limit);

    const events: CatchupEvent[] = rows.map(row => {
      const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
      return {
        event_id: row.id as string,
        occurred_at: row.occurred_at as number,
        type: row.type,
        ...payload,
      } as CatchupEvent;
    });

    return { events, has_more };
  }

  async getCatchupCount(botId: string, since: number): Promise<{
    thread_invites: number;
    thread_status_changes: number;
    thread_activities: number;
    channel_messages: number;
    total: number;
  }> {
    // Note: pg returns COUNT(*) as string (int8) — coerce with Number()
    const rows = await this.driver.all<{ type: string; count: number | string }>(`
      SELECT type, COUNT(*) as count FROM catchup_events
      WHERE target_bot_id = ? AND occurred_at > ?
      GROUP BY type
    `, [botId, since]);

    const counts = {
      thread_invites: 0,
      thread_status_changes: 0,
      thread_activities: 0,
      channel_messages: 0,
      total: 0,
    };

    for (const row of rows) {
      const c = Number(row.count);
      switch (row.type) {
        case 'thread_invited':
          counts.thread_invites = c;
          break;
        case 'thread_status_changed':
          counts.thread_status_changes = c;
          break;
        case 'thread_message_summary':
        case 'thread_artifact_added':
        case 'thread_participant_removed':
          counts.thread_activities += c;
          break;
        case 'channel_message_summary':
          counts.channel_messages = c;
          break;
      }
    }

    counts.total = counts.thread_invites + counts.thread_status_changes
      + counts.thread_activities + counts.channel_messages;

    return counts;
  }

  async cleanupOldCatchupEvents(maxAgeDays: number, batchSize = 5000): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const result = await this.driver.run(
      `DELETE FROM catchup_events WHERE ${this.rowid} IN (SELECT ${this.rowid} FROM catchup_events WHERE occurred_at < ? LIMIT ?)`,
      [cutoff, batchSize],
    );
    return result.changes;
  }

  // ─── Webhook Status Operations ──────────────────────────

  async recordWebhookSuccess(botId: string): Promise<void> {
    await this.driver.run(`
      INSERT INTO webhook_status (bot_id, last_success, last_failure, consecutive_failures, degraded)
      VALUES (?, ?, NULL, 0, 0)
      ON CONFLICT(bot_id) DO UPDATE SET
        last_success = ?,
        consecutive_failures = 0,
        degraded = 0
    `, [botId, Date.now(), Date.now()]);
  }

  async recordWebhookFailure(botId: string): Promise<void> {
    const now = Date.now();
    await this.driver.run(`
      INSERT INTO webhook_status (bot_id, last_success, last_failure, consecutive_failures, degraded)
      VALUES (?, NULL, ?, 1, 0)
      ON CONFLICT(bot_id) DO UPDATE SET
        last_failure = ?,
        consecutive_failures = consecutive_failures + 1,
        degraded = CASE WHEN consecutive_failures + 1 >= 10 THEN 1 ELSE degraded END
    `, [botId, now, now]);
  }

  async getWebhookHealth(botId: string): Promise<WebhookHealth | null> {
    const row = await this.driver.get<any>(
      'SELECT * FROM webhook_status WHERE bot_id = ?',
      [botId],
    );
    if (!row) return null;
    return {
      healthy: row.consecutive_failures === 0,
      last_success: row.last_success ?? null,
      last_failure: row.last_failure ?? null,
      consecutive_failures: row.consecutive_failures,
      degraded: !!row.degraded,
    };
  }

  async isWebhookDegraded(botId: string): Promise<boolean> {
    const row = await this.driver.get<any>(
      'SELECT degraded FROM webhook_status WHERE bot_id = ?',
      [botId],
    );
    return !!row?.degraded;
  }

  async resetWebhookDegraded(botId: string): Promise<void> {
    await this.driver.run(`
      UPDATE webhook_status SET degraded = 0, consecutive_failures = 0 WHERE bot_id = ?
    `, [botId]);
  }

  // ─── Org Settings Operations ────────────────────────────

  async getOrgSettings(orgId: string): Promise<OrgSettings> {
    const row = await this.driver.get<any>('SELECT * FROM org_settings WHERE org_id = ?', [orgId]);
    if (row) {
      let defaultPolicy: ThreadPermissionPolicy | null = null;
      if (row.default_thread_permission_policy) {
        try {
          defaultPolicy = JSON.parse(row.default_thread_permission_policy);
        } catch {
          defaultPolicy = null;
        }
      }
      return {
        org_id: row.org_id,
        messages_per_minute_per_bot: row.messages_per_minute_per_bot,
        threads_per_hour_per_bot: row.threads_per_hour_per_bot,
        file_upload_mb_per_day_per_bot: row.file_upload_mb_per_day_per_bot ?? 100,
        message_ttl_days: row.message_ttl_days ?? null,
        thread_auto_close_days: row.thread_auto_close_days ?? null,
        artifact_retention_days: row.artifact_retention_days ?? null,
        default_thread_permission_policy: defaultPolicy,
        updated_at: row.updated_at,
      };
    }
    // Return defaults if no row exists
    return {
      org_id: orgId,
      messages_per_minute_per_bot: 120,
      threads_per_hour_per_bot: 30,
      file_upload_mb_per_day_per_bot: 100,
      message_ttl_days: null,
      thread_auto_close_days: null,
      artifact_retention_days: null,
      default_thread_permission_policy: null,
      updated_at: 0,
    };
  }

  async updateOrgSettings(orgId: string, updates: Partial<OrgSettings>): Promise<OrgSettings> {
    const now = Date.now();
    const current = await this.getOrgSettings(orgId);
    const merged: OrgSettings = {
      org_id: orgId,
      messages_per_minute_per_bot: updates.messages_per_minute_per_bot ?? current.messages_per_minute_per_bot,
      threads_per_hour_per_bot: updates.threads_per_hour_per_bot ?? current.threads_per_hour_per_bot,
      file_upload_mb_per_day_per_bot: updates.file_upload_mb_per_day_per_bot ?? current.file_upload_mb_per_day_per_bot,
      message_ttl_days: updates.message_ttl_days !== undefined ? updates.message_ttl_days : current.message_ttl_days,
      thread_auto_close_days: updates.thread_auto_close_days !== undefined ? updates.thread_auto_close_days : current.thread_auto_close_days,
      artifact_retention_days: updates.artifact_retention_days !== undefined ? updates.artifact_retention_days : current.artifact_retention_days,
      default_thread_permission_policy: updates.default_thread_permission_policy !== undefined
        ? updates.default_thread_permission_policy
        : current.default_thread_permission_policy,
      updated_at: now,
    };

    const policyJson = merged.default_thread_permission_policy
      ? JSON.stringify(merged.default_thread_permission_policy)
      : null;

    await this.driver.run(`
      INSERT INTO org_settings (org_id, messages_per_minute_per_bot, threads_per_hour_per_bot, file_upload_mb_per_day_per_bot, message_ttl_days, thread_auto_close_days, artifact_retention_days, default_thread_permission_policy, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET
        messages_per_minute_per_bot = excluded.messages_per_minute_per_bot,
        threads_per_hour_per_bot = excluded.threads_per_hour_per_bot,
        file_upload_mb_per_day_per_bot = excluded.file_upload_mb_per_day_per_bot,
        message_ttl_days = excluded.message_ttl_days,
        thread_auto_close_days = excluded.thread_auto_close_days,
        artifact_retention_days = excluded.artifact_retention_days,
        default_thread_permission_policy = excluded.default_thread_permission_policy,
        updated_at = excluded.updated_at
    `, [
      merged.org_id,
      merged.messages_per_minute_per_bot,
      merged.threads_per_hour_per_bot,
      merged.file_upload_mb_per_day_per_bot,
      merged.message_ttl_days,
      merged.thread_auto_close_days,
      merged.artifact_retention_days,
      policyJson,
      merged.updated_at,
    ]);

    return merged;
  }

  // ─── Rate Limiting Operations ─────────────────────────────

  /**
   * Atomically check rate limit and record the event in a single transaction.
   * Prevents TOCTOU race where concurrent requests both pass the check.
   */
  async checkAndRecordRateLimit(orgId: string, botId: string, resource: 'message' | 'thread'): Promise<{ allowed: boolean; retryAfter?: number }> {
    const settings = await this.getOrgSettings(orgId);
    const now = Date.now();

    return await this.driver.transaction(async (txn) => {
      if (resource === 'message') {
        const windowStart = now - 60000; // 1 minute
        // Note: pg returns COUNT/MIN as string — coerce with Number()
        const row = await txn.get<{ count: number | string; oldest: number | string | null }>(
          `SELECT COUNT(*) as count, MIN(created_at) as oldest FROM rate_limit_events
           WHERE org_id = ? AND bot_id = ? AND resource_type = 'message' AND created_at > ?`,
          [orgId, botId, windowStart],
        );

        if (Number(row!.count) >= settings.messages_per_minute_per_bot) {
          const oldest = row!.oldest != null ? Number(row!.oldest) : null;
          const retryAfter = oldest ? Math.ceil((oldest + 60000 - now) / 1000) : 60;
          return { allowed: false as const, retryAfter: Math.max(retryAfter, 1) };
        }
      } else {
        const windowStart = now - 3600000; // 1 hour
        const row = await txn.get<{ count: number | string; oldest: number | string | null }>(
          `SELECT COUNT(*) as count, MIN(created_at) as oldest FROM rate_limit_events
           WHERE org_id = ? AND bot_id = ? AND resource_type = 'thread' AND created_at > ?`,
          [orgId, botId, windowStart],
        );

        if (Number(row!.count) >= settings.threads_per_hour_per_bot) {
          const oldest = row!.oldest != null ? Number(row!.oldest) : null;
          const retryAfter = oldest ? Math.ceil((oldest + 3600000 - now) / 1000) : 3600;
          return { allowed: false as const, retryAfter: Math.max(retryAfter, 1) };
        }
      }

      // Within limit — record the event atomically
      await txn.run(
        'INSERT INTO rate_limit_events (org_id, bot_id, resource_type, created_at) VALUES (?, ?, ?, ?)',
        [orgId, botId, resource, now],
      );

      return { allowed: true as const };
    });
  }

  async cleanupOldRateLimitEvents(batchSize = 10000): Promise<number> {
    const cutoff = Date.now() - 3600000; // 1 hour
    const result = await this.driver.run(
      `DELETE FROM rate_limit_events WHERE ${this.rowid} IN (SELECT ${this.rowid} FROM rate_limit_events WHERE created_at < ? LIMIT ?)`,
      [cutoff, batchSize],
    );
    return result.changes;
  }

  // ─── Audit Log Operations ─────────────────────────────────

  async recordAudit(
    orgId: string,
    botId: string | null,
    action: AuditAction,
    targetType: string,
    targetId: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.driver.run(`
      INSERT INTO audit_log (id, org_id, bot_id, action, target_type, target_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, orgId, botId, action, targetType, targetId, detail ? JSON.stringify(detail) : null, now]);
  }

  async getAuditLog(orgId: string, filters?: {
    since?: number;
    action?: string;
    target_type?: string;
    target_id?: string;
    bot_id?: string;
    limit?: number;
  }): Promise<AuditEntry[]> {
    const where: string[] = ['org_id = ?'];
    const params: any[] = [orgId];

    if (filters?.since) {
      where.push('created_at > ?');
      params.push(filters.since);
    }
    if (filters?.action) {
      where.push('action = ?');
      params.push(filters.action);
    }
    if (filters?.target_type) {
      where.push('target_type = ?');
      params.push(filters.target_type);
    }
    if (filters?.target_id) {
      where.push('target_id = ?');
      params.push(filters.target_id);
    }
    if (filters?.bot_id) {
      where.push('bot_id = ?');
      params.push(filters.bot_id);
    }

    const limit = Math.min(Math.max(filters?.limit || 50, 1), 200);
    params.push(limit);

    const rows = await this.driver.all<any>(`
      SELECT * FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `, params);

    return rows.map(row => ({
      id: row.id,
      org_id: row.org_id,
      bot_id: row.bot_id ?? null,
      action: row.action as AuditAction,
      target_type: row.target_type,
      target_id: row.target_id,
      detail: row.detail ? JSON.parse(row.detail) : null,
      created_at: row.created_at,
    }));
  }

  async cleanupOldAuditLog(maxAgeDays: number, batchSize = 5000): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const result = await this.driver.run(
      `DELETE FROM audit_log WHERE ${this.rowid} IN (SELECT ${this.rowid} FROM audit_log WHERE created_at < ? LIMIT ?)`,
      [cutoff, batchSize],
    );
    return result.changes;
  }

  // ─── TTL / Lifecycle Cleanup Operations ────────────────────

  async cleanupExpiredMessages(orgId: string, ttlDays: number, batchSize = 5000): Promise<number> {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let total = 0;

    // Delete channel messages older than TTL (batched)
    const rid = this.rowid;
    const r1 = await this.driver.run(`
      DELETE FROM messages WHERE ${rid} IN (
        SELECT messages.${rid} FROM messages
        JOIN channels ON channels.id = messages.channel_id
        WHERE channels.org_id = ? AND messages.created_at < ?
        LIMIT ?
      )
    `, [orgId, cutoff, batchSize]);
    total += r1.changes;

    // Delete thread messages older than TTL (only in resolved/closed threads, batched)
    const r2 = await this.driver.run(`
      DELETE FROM thread_messages WHERE ${rid} IN (
        SELECT thread_messages.${rid} FROM thread_messages
        JOIN threads ON threads.id = thread_messages.thread_id
        WHERE threads.org_id = ? AND threads.status IN ('resolved', 'closed')
        AND thread_messages.created_at < ?
        LIMIT ?
      )
    `, [orgId, cutoff, batchSize]);
    total += r2.changes;

    return total;
  }

  async autoCloseInactiveThreads(orgId: string, days: number, batchSize = 1000): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const r = await this.driver.run(`
      UPDATE threads SET status = 'closed', close_reason = 'timeout', updated_at = ?, last_activity_at = ?, revision = revision + 1
      WHERE ${this.rowid} IN (
        SELECT ${this.rowid} FROM threads
        WHERE org_id = ? AND last_activity_at < ? AND status NOT IN ('resolved', 'closed')
        LIMIT ?
      )
    `, [now, now, orgId, cutoff, batchSize]);
    return r.changes;
  }

  async cleanupExpiredArtifacts(orgId: string, days: number, batchSize = 5000): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const r = await this.driver.run(`
      DELETE FROM artifacts WHERE ${this.rowid} IN (
        SELECT artifacts.${this.rowid} FROM artifacts
        JOIN threads ON threads.id = artifacts.thread_id
        WHERE threads.org_id = ? AND threads.status IN ('resolved', 'closed')
        AND artifacts.created_at < ?
        LIMIT ?
      )
    `, [orgId, cutoff, batchSize]);
    return r.changes;
  }

  /** Repeat a batched cleanup until it returns fewer than batchSize rows. */
  private async drainBatch(fn: (batchSize: number) => Promise<number>, batchSize: number): Promise<number> {
    let total = 0;
    let deleted: number;
    do {
      deleted = await fn(batchSize);
      total += deleted;
    } while (deleted >= batchSize);
    return total;
  }

  async runLifecycleCleanup(): Promise<void> {
    const orgs = await this.listOrgs();
    for (const org of orgs) {
      const settings = await this.getOrgSettings(org.id);
      const detail: Record<string, number> = {};

      if (settings.message_ttl_days !== null && settings.message_ttl_days > 0) {
        const n = await this.drainBatch((bs) => this.cleanupExpiredMessages(org.id, settings.message_ttl_days!, bs), 5000);
        if (n > 0) detail.messages_deleted = n;
      }

      if (settings.thread_auto_close_days !== null && settings.thread_auto_close_days > 0) {
        const n = await this.drainBatch((bs) => this.autoCloseInactiveThreads(org.id, settings.thread_auto_close_days!, bs), 1000);
        if (n > 0) detail.threads_closed = n;
      }

      if (settings.artifact_retention_days !== null && settings.artifact_retention_days > 0) {
        const n = await this.drainBatch((bs) => this.cleanupExpiredArtifacts(org.id, settings.artifact_retention_days!, bs), 5000);
        if (n > 0) detail.artifacts_deleted = n;
      }

      if (Object.keys(detail).length > 0) {
        await this.recordAudit(org.id, null, 'lifecycle.cleanup', 'org', org.id, detail);
      }
    }

    // Global cleanups (all batched with drain loops)
    await this.drainBatch((bs) => this.cleanupOldCatchupEvents(30, bs), 5000);
    await this.drainBatch((bs) => this.cleanupOldAuditLog(90, bs), 5000);
    await this.drainBatch((bs) => this.cleanupOldRateLimitEvents(bs), 10000);
    await this.drainBatch((bs) => this.cleanupExpiredTokens(bs), 1000);
    await this.cleanupExpiredOrgTickets();
  }

  /** O1: Lightweight DB health check */
  async isHealthy(): Promise<boolean> {
    return await this.driver.isHealthy();
  }

  async getPlatformStats(): Promise<{
    org_count: number;
    bot_count: number;
    online_bot_count: number;
    thread_count: number;
    message_count: number;
    active_thread_count: number;
  }> {
    const now = Date.now();
    const onlineThreshold = now - 5 * 60 * 1000; // 5 min
    const activeThreshold = now - 24 * 60 * 60 * 1000; // 24h

    const [orgs, bots, onlineBots, threads, messages, activeThreads] = await Promise.all([
      this.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM orgs', []),
      this.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM bots', []),
      this.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM bots WHERE last_seen_at > ?', [onlineThreshold]),
      this.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM threads', []),
      this.driver.get<{ c: number }>('SELECT (SELECT COUNT(*) FROM thread_messages) + (SELECT COUNT(*) FROM messages) AS c', []),
      this.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM threads WHERE last_activity_at > ?', [activeThreshold]),
    ]);

    return {
      org_count: Number(orgs?.c ?? 0),
      bot_count: Number(bots?.c ?? 0),
      online_bot_count: Number(onlineBots?.c ?? 0),
      thread_count: Number(threads?.c ?? 0),
      message_count: Number(messages?.c ?? 0),
      active_thread_count: Number(activeThreads?.c ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
