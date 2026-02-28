import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type {
  Org,
  Bot,
  Channel,
  ChannelMember,
  Message,
  HubConfig,
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
} from './types.js';

// ─── Database Layer ──────────────────────────────────────────

export class HubDB {
  private db: Database.Database;

  constructor(config: HubConfig) {
    fs.mkdirSync(config.data_dir, { recursive: true });
    const dbPath = path.join(config.data_dir, 'hxa-connect.db');

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        org_secret TEXT NOT NULL,
        persist_messages INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
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
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(org_id, name)
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
        name TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        parts TEXT,
        created_at INTEGER NOT NULL
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS thread_participants (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        label TEXT,
        joined_at INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_org ON files(org_id, created_at);

      CREATE TABLE IF NOT EXISTS catchup_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ref_id TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catchup_target ON catchup_events(target_bot_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_catchup_occurred ON catchup_events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_catchup_ref ON catchup_events(target_bot_id, type, ref_id);

      CREATE TABLE IF NOT EXISTS webhook_status (
        bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
        last_success INTEGER,
        last_failure INTEGER,
        consecutive_failures INTEGER DEFAULT 0,
        degraded INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS org_settings (
        org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        messages_per_minute_per_bot INTEGER DEFAULT 60,
        threads_per_hour_per_bot INTEGER DEFAULT 30,
        file_upload_mb_per_day_per_bot INTEGER DEFAULT 100,
        message_ttl_days INTEGER,
        thread_auto_close_days INTEGER,
        artifact_retention_days INTEGER,
        default_thread_permission_policy TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('message', 'thread')),
        created_at INTEGER NOT NULL
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
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(org_id, action, created_at);

      CREATE TABLE IF NOT EXISTS bot_tokens (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        scopes TEXT NOT NULL DEFAULT '["full"]',
        label TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_bot_tokens_bot ON bot_tokens(bot_id);
      CREATE INDEX IF NOT EXISTS idx_bot_tokens_token ON bot_tokens(token);

      CREATE TABLE IF NOT EXISTS org_tickets (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        secret_hash TEXT NOT NULL,
        reusable INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_org_tickets_org ON org_tickets(org_id);
      CREATE INDEX IF NOT EXISTS idx_org_tickets_expires ON org_tickets(expires_at);
    `);

    // ── Schema version tracking (for future migrations) ─────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    // Future migrations go here using this.runMigration('name', () => { ... })
  }

  /**
   * Run a named migration only if it hasn't been applied yet.
   * Records the migration in schema_versions upon success.
   */
  private runMigration(name: string, fn: () => void): void {
    const applied = this.db.prepare(
      'SELECT 1 FROM schema_versions WHERE name = ?'
    ).get(name);
    if (applied) return;

    fn();

    this.db.prepare(
      'INSERT INTO schema_versions (name, applied_at) VALUES (?, ?)'
    ).run(name, Date.now());
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

  createOrg(name: string, persistMessages = true): Org {
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
    this.db.prepare(
      'INSERT INTO orgs (id, name, org_secret, persist_messages, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(org.id, org.name, orgSecretHash, org.persist_messages ? 1 : 0, org.created_at);
    // Return org with plaintext secret so the caller can display it once
    return org;
  }

  verifyOrgSecret(orgId: string, secret: string): boolean {
    const row = this.db.prepare('SELECT org_secret FROM orgs WHERE id = ?').get(orgId) as any;
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
  setBotAuthRole(botId: string, role: 'admin' | 'member'): void {
    this.db.prepare('UPDATE bots SET auth_role = ? WHERE id = ?').run(role, botId);
  }

  /**
   * Rotate the org secret to a new hash.
   */
  rotateOrgSecret(orgId: string, newSecretHash: string): void {
    this.db.prepare('UPDATE orgs SET org_secret = ? WHERE id = ?').run(newSecretHash, orgId);
  }

  getOrgById(id: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToOrg(row);
  }

  listOrgs(): Org[] {
    return (this.db.prepare('SELECT * FROM orgs ORDER BY created_at').all() as any[]).map(r => this.rowToOrg(r));
  }

  updateOrgStatus(orgId: string, status: 'active' | 'suspended'): void {
    this.db.prepare('UPDATE orgs SET status = ? WHERE id = ?').run(status, orgId);
  }

  updateOrgName(orgId: string, name: string): void {
    this.db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(name, orgId);
  }

  destroyOrg(orgId: string): void {
    // Set status first (for any in-flight requests to see)
    this.db.prepare("UPDATE orgs SET status = 'destroyed' WHERE id = ?").run(orgId);
    // CASCADE delete handles all related data (bots, channels, threads, etc.)
    this.db.prepare('DELETE FROM orgs WHERE id = ?').run(orgId);
  }

  // ─── Org Ticket Operations ─────────────────────────────

  private rowToOrgTicket(row: any): OrgTicket {
    return {
      ...row,
      reusable: !!row.reusable,
      consumed: !!row.consumed,
      created_by: row.created_by ?? null,
    };
  }

  createOrgTicket(orgId: string, secretHash: string, options: {
    reusable?: boolean;
    expiresAt: number;
    createdBy?: string;
  }): OrgTicket {
    const ticket: OrgTicket = {
      id: crypto.randomUUID(),
      org_id: orgId,
      secret_hash: secretHash,
      reusable: options.reusable ?? false,
      expires_at: options.expiresAt,
      consumed: false,
      created_by: options.createdBy ?? null,
      created_at: Date.now(),
    };
    this.db.prepare(
      'INSERT INTO org_tickets (id, org_id, secret_hash, reusable, expires_at, consumed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(ticket.id, ticket.org_id, ticket.secret_hash, ticket.reusable ? 1 : 0, ticket.expires_at, 0, ticket.created_by, ticket.created_at);
    return ticket;
  }

  redeemOrgTicket(ticketId: string): OrgTicket | undefined {
    const row = this.db.prepare(
      'SELECT * FROM org_tickets WHERE id = ? AND consumed = 0 AND expires_at > ?'
    ).get(ticketId, Date.now()) as any;
    if (!row) return undefined;
    const result = this.db.prepare(
      'UPDATE org_tickets SET consumed = 1 WHERE id = ? AND consumed = 0'
    ).run(ticketId);
    if (result.changes === 0) return undefined; // race condition: another consumer got it
    return this.rowToOrgTicket({ ...row, consumed: 1 });
  }

  getOrgTicket(ticketId: string): OrgTicket | undefined {
    const row = this.db.prepare('SELECT * FROM org_tickets WHERE id = ?').get(ticketId) as any;
    if (!row) return undefined;
    return this.rowToOrgTicket(row);
  }

  invalidateOrgTickets(orgId: string): number {
    const result = this.db.prepare(
      'DELETE FROM org_tickets WHERE org_id = ? AND consumed = 0'
    ).run(orgId);
    return result.changes;
  }

  cleanupExpiredOrgTickets(): number {
    const result = this.db.prepare(
      'DELETE FROM org_tickets WHERE expires_at <= ?'
    ).run(Date.now());
    return result.changes;
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

  registerBot(
    orgId: string,
    name: string,
    metadata?: Record<string, unknown> | null,
    webhookUrl?: string | null,
    webhookSecret?: string | null,
    profile?: BotProfileInput,
  ): { bot: Bot; created: boolean; plaintextToken: string | null } {
    // Check if bot already exists → return existing token
    const existing = this.db.prepare(
      'SELECT * FROM bots WHERE org_id = ? AND name = ?'
    ).get(orgId, name) as any;

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

      this.db.prepare(
        `UPDATE bots SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);

      const updated = this.getBotById(existing.id);
      if (!updated) {
        throw new Error('Bot update failed');
      }
      return { bot: updated, created: false, plaintextToken: null };
    }

    const plaintextToken = `agent_${crypto.randomBytes(24).toString('hex')}`;
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
      auth_role: 'member',
      online: false,
      last_seen_at: now,
      created_at: now,
    };

    const tokenHash = HubDB.hashToken(bot.token);

    this.db.prepare(
      `INSERT INTO bots (
        id, org_id, name, token, metadata, webhook_url, webhook_secret,
        bio, role, "function", team, tags, languages, protocols, status_text, timezone, active_hours, version, runtime,
        auth_role, online, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
    );

    return { bot, created: true, plaintextToken };
  }

  updateProfile(botId: string, fields: BotProfileInput): Bot | undefined {
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

    this.db.prepare(`UPDATE bots SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getBotById(botId);
  }

  renameBot(botId: string, newName: string): { bot: Bot; conflict: false } | { bot: undefined; conflict: true } {
    try {
      this.db.prepare('UPDATE bots SET name = ? WHERE id = ?').run(newName, botId);
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { bot: undefined, conflict: true };
      }
      throw err;
    }
    const bot = this.getBotById(botId);
    return { bot: bot!, conflict: false };
  }

  getBotByToken(token: string): Bot | undefined {
    const tokenHash = HubDB.hashToken(token);
    const row = this.db.prepare('SELECT * FROM bots WHERE token = ?').get(tokenHash) as any;
    if (!row) return undefined;
    return this.rowToBot(row);
  }

  getBotById(id: string): Bot | undefined {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToBot(row);
  }

  getBotByName(orgId: string, name: string): Bot | undefined {
    const row = this.db.prepare(
      'SELECT * FROM bots WHERE org_id = ? AND name = ?'
    ).get(orgId, name) as any;
    if (!row) return undefined;
    return this.rowToBot(row);
  }

  /**
   * Paginated bot list. Cursor is a bot id; results ordered by id ASC.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  listBotsPaginated(orgId: string, cursor: string | undefined, limit: number, search?: string): Bot[] {
    const searchFilter = search ? ' AND name LIKE ?' : '';
    const searchParam = search ? `%${search}%` : undefined;
    if (cursor) {
      const params: any[] = [orgId, cursor];
      if (searchParam) params.push(searchParam);
      params.push(limit + 1);
      return (this.db.prepare(
        `SELECT * FROM bots WHERE org_id = ? AND id > ?${searchFilter} ORDER BY id ASC LIMIT ?`
      ).all(...params) as any[]).map(r => this.rowToBot(r));
    }
    const params: any[] = [orgId];
    if (searchParam) params.push(searchParam);
    params.push(limit + 1);
    return (this.db.prepare(
      `SELECT * FROM bots WHERE org_id = ?${searchFilter} ORDER BY id ASC LIMIT ?`
    ).all(...params) as any[]).map(r => this.rowToBot(r));
  }

  listBots(orgId: string, filters?: ListBotsFilters): Bot[] {
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

    let bots = (this.db.prepare(
      `SELECT * FROM bots WHERE ${where.join(' AND ')} ORDER BY name`
    ).all(...params) as any[]).map(r => this.rowToBot(r));

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

  setBotOnline(botId: string, online: boolean) {
    this.db.prepare(
      'UPDATE bots SET online = ?, last_seen_at = ? WHERE id = ?'
    ).run(online ? 1 : 0, Date.now(), botId);
  }

  /** W3: Update last_seen without changing online status (for HTTP requests) */
  touchBotLastSeen(botId: string) {
    this.db.prepare(
      'UPDATE bots SET last_seen_at = ? WHERE id = ?'
    ).run(Date.now(), botId);
  }

  deleteBot(botId: string) {
    // Auto-close threads where this bot is the sole remaining participant
    // (ON DELETE CASCADE would orphan them, making them inaccessible via API)
    const soloThreads = this.db.prepare(`
      SELECT tp.thread_id FROM thread_participants tp
      WHERE tp.bot_id = ?
        AND (SELECT COUNT(*) FROM thread_participants tp2 WHERE tp2.thread_id = tp.thread_id) = 1
    `).all(botId) as { thread_id: string }[];
    const now = Date.now();
    for (const { thread_id } of soloThreads) {
      this.db.prepare(`
        UPDATE threads SET status = 'closed', close_reason = 'error', updated_at = ?, last_activity_at = ?, revision = revision + 1
        WHERE id = ? AND status NOT IN ('resolved', 'closed')
      `).run(now, now, thread_id);
    }

    this.db.prepare('DELETE FROM channel_members WHERE bot_id = ?').run(botId);
    this.db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
  }

  // ─── Bot Token Operations (Scoped Tokens) ─────────────

  createBotToken(botId: string, scopes: TokenScope[], label?: string | null, expiresAt?: number | null): BotToken {
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

    this.db.prepare(`
      INSERT INTO bot_tokens (id, bot_id, token, scopes, label, expires_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token.id,
      token.bot_id,
      tokenHash, // Store hash, not plaintext
      JSON.stringify(token.scopes),
      token.label,
      token.expires_at,
      token.created_at,
      token.last_used_at,
    );

    // Return with plaintext token so caller can return it once
    return token;
  }

  getBotTokenByToken(token: string): BotToken | undefined {
    const tokenHash = HubDB.hashToken(token);
    const row = this.db.prepare('SELECT * FROM bot_tokens WHERE token = ?').get(tokenHash) as any;
    if (!row) return undefined;
    return this.rowToBotToken(row);
  }

  listBotTokens(botId: string): BotToken[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_tokens WHERE bot_id = ? ORDER BY created_at DESC'
    ).all(botId) as any[];
    return rows.map(row => this.rowToBotToken(row));
  }

  revokeBotToken(tokenId: string, botId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM bot_tokens WHERE id = ? AND bot_id = ?'
    ).run(tokenId, botId);
    return result.changes > 0;
  }

  touchBotToken(tokenId: string): void {
    this.db.prepare(
      'UPDATE bot_tokens SET last_used_at = ? WHERE id = ?'
    ).run(Date.now(), tokenId);
  }

  cleanupExpiredTokens(batchSize = 1000): number {
    const result = this.db.prepare(
      'DELETE FROM bot_tokens WHERE rowid IN (SELECT rowid FROM bot_tokens WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?)'
    ).run(Date.now(), batchSize);
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

  updateThreadPermissionPolicy(threadId: string, policy: string | null, expectedRevision?: number): Thread | undefined {
    if (expectedRevision !== undefined) {
      const result = this.db.prepare(`
        UPDATE threads
        SET permission_policy = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(policy, Date.now(), threadId, expectedRevision);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      this.db.prepare(`
        UPDATE threads
        SET permission_policy = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(policy, Date.now(), threadId);
    }
    return this.getThread(threadId);
  }

  /**
   * Check if a bot is allowed to perform an action on a thread based on permission policy.
   * Returns true if allowed, false if denied.
   */
  checkThreadPermission(thread: Thread, botId: string, action: keyof ThreadPermissionPolicy): boolean {
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
      const orgSettings = this.getOrgSettings(thread.org_id);
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
    const participant = this.db.prepare(
      'SELECT label FROM thread_participants WHERE thread_id = ? AND bot_id = ?'
    ).get(thread.id, botId) as { label: string | null } | undefined;

    if (!participant) return false;
    if (!participant.label) return false;

    return allowedLabels.includes(participant.label);
  }

  // ─── Channel Operations ──────────────────────────────────

  createChannel(orgId: string, type: 'direct' | 'group', memberIds: string[], name?: string): Channel & { isNew?: boolean } {
    // For direct channels, check if one already exists between these two bots
    if (type === 'direct' && memberIds.length === 2) {
      const existing = this.findDirectChannel(memberIds[0], memberIds[1]);
      if (existing) return { ...existing, isNew: false };
    }

    const channel: Channel = {
      id: crypto.randomUUID(),
      org_id: orgId,
      type,
      name: name || null,
      created_at: Date.now(),
    };

    const insertChannel = this.db.prepare(
      'INSERT INTO channels (id, org_id, type, name, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMember = this.db.prepare(
      'INSERT INTO channel_members (channel_id, bot_id, joined_at) VALUES (?, ?, ?)'
    );

    const tx = this.db.transaction(() => {
      insertChannel.run(channel.id, channel.org_id, channel.type, channel.name, channel.created_at);
      for (const botId of memberIds) {
        insertMember.run(channel.id, botId, Date.now());
      }
    });
    tx();

    return { ...channel, isNew: true };
  }

  private findDirectChannel(botId1: string, botId2: string): Channel | undefined {
    const row = this.db.prepare(`
      SELECT c.* FROM channels c
      JOIN channel_members cm1 ON c.id = cm1.channel_id AND cm1.bot_id = ?
      JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.bot_id = ?
      WHERE c.type = 'direct'
      LIMIT 1
    `).get(botId1, botId2) as any;
    return row || undefined;
  }

  getChannel(channelId: string): Channel | undefined {
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as Channel | undefined;
  }

  getChannelMembers(channelId: string): ChannelMember[] {
    return this.db.prepare(
      'SELECT * FROM channel_members WHERE channel_id = ?'
    ).all(channelId) as ChannelMember[];
  }

  isChannelMember(channelId: string, botId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND bot_id = ?'
    ).get(channelId, botId);
    return !!row;
  }

  /**
   * Get all channels a bot participates in, with member info and last activity time.
   * Returns channels sorted by most recent activity first.
   */
  getChannelsForBot(botId: string): { id: string; type: string; name: string | null; created_at: number; last_activity_at: number; members: { id: string; name: string; online: boolean }[] }[] {
    const channels = this.db.prepare(`
      SELECT c.*, COALESCE(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id),
        c.created_at
      ) AS last_activity_at
      FROM channels c
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE cm.bot_id = ?
      ORDER BY last_activity_at DESC
    `).all(botId) as any[];

    return channels.map(ch => {
      const members = this.getChannelMembers(ch.id).map(m => {
        const bot = this.getBotById(m.bot_id);
        return { id: m.bot_id, name: bot?.name ?? 'unknown', online: bot?.online ?? false };
      });
      return {
        id: ch.id,
        type: ch.type,
        name: ch.name,
        created_at: ch.created_at,
        last_activity_at: ch.last_activity_at,
        members,
      };
    });
  }

  // ─── Message Operations ──────────────────────────────────

  createMessage(channelId: string, senderId: string, content: string, contentType = 'text', parts?: string | null): Message {
    const msg: Message = {
      id: crypto.randomUUID(),
      channel_id: channelId,
      sender_id: senderId,
      content,
      content_type: contentType as Message['content_type'],
      parts: parts ?? null,
      created_at: Date.now(),
    };

    this.db.prepare(
      `INSERT INTO messages (id, channel_id, sender_id, content, content_type, parts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(msg.id, msg.channel_id, msg.sender_id, msg.content, msg.content_type, msg.parts, msg.created_at);

    return msg;
  }

  getMessages(channelId: string, limit = 50, before?: number, since?: number): Message[] {
    const conditions = ['channel_id = ?'];
    const params: any[] = [channelId];

    if (before !== undefined) { conditions.push('created_at < ?'); params.push(before); }
    if (since !== undefined)  { conditions.push('created_at > ?'); params.push(since); }

    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
    ).all(...params) as Message[];
  }

  /**
   * Paginated channel messages (newest first). `before` is a message id.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  getMessagesPaginated(channelId: string, before: string | undefined, limit: number): Message[] {
    if (before) {
      // Get the created_at of the cursor message so we can seek efficiently
      const cursorRow = this.db.prepare(
        'SELECT created_at FROM messages WHERE id = ?'
      ).get(before) as { created_at: number } | undefined;
      if (!cursorRow) {
        // Unknown cursor — return from newest
        return this.db.prepare(
          'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(channelId, limit + 1) as Message[];
      }
      // Use (created_at, id) for stable ordering when timestamps collide
      return this.db.prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(channelId, cursorRow.created_at, cursorRow.created_at, before, limit + 1) as Message[];
    }
    return this.db.prepare(
      'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(channelId, limit + 1) as Message[];
  }

  getNewMessages(botId: string, since: number): (Message & { channel_name?: string })[] {
    return this.db.prepare(`
      SELECT m.*, ch.name as channel_name FROM messages m
      JOIN channel_members cm ON m.channel_id = cm.channel_id AND cm.bot_id = ?
      JOIN channels ch ON m.channel_id = ch.id
      WHERE m.created_at > ? AND m.sender_id != ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `).all(botId, since, botId) as any[];
  }

  // ─── Thread Operations ───────────────────────────────────

  createThread(
    orgId: string,
    initiatorId: string,
    topic: string,
    tags: string[] | null,
    participantIds: string[],
    channelId?: string | null,
    context?: string | null,
    permissionPolicy?: string | null,
  ): Thread {
    const uniqueParticipantIds = Array.from(new Set([initiatorId, ...participantIds]));
    if (uniqueParticipantIds.length > 20) {
      throw new Error('Thread participant limit exceeded (max 20)');
    }

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

    const getBotOrgStmt = this.db.prepare('SELECT org_id FROM bots WHERE id = ?');
    const getChannelOrgStmt = this.db.prepare('SELECT org_id FROM channels WHERE id = ?');
    const insertThreadStmt = this.db.prepare(`
      INSERT INTO threads (
        id, org_id, topic, tags, status, initiator_id, channel_id, context, close_reason,
        permission_policy, revision, created_at, updated_at, last_activity_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertParticipantStmt = this.db.prepare(`
      INSERT INTO thread_participants (thread_id, bot_id, label, joined_at)
      VALUES (?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      const initiatorRow = getBotOrgStmt.get(initiatorId) as { org_id: string } | undefined;
      if (!initiatorRow || initiatorRow.org_id !== orgId) {
        throw new Error('Invalid initiator');
      }

      for (const participantId of uniqueParticipantIds) {
        const participantRow = getBotOrgStmt.get(participantId) as { org_id: string } | undefined;
        if (!participantRow || participantRow.org_id !== orgId) {
          throw new Error(`Participant not in org: ${participantId}`);
        }
      }

      if (channelId) {
        const channelRow = getChannelOrgStmt.get(channelId) as { org_id: string } | undefined;
        if (!channelRow || channelRow.org_id !== orgId) {
          throw new Error('Invalid channel_id for thread org');
        }
      }

      insertThreadStmt.run(
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
      );

      for (const participantId of uniqueParticipantIds) {
        insertParticipantStmt.run(thread.id, participantId, null, now);
      }
    });

    tx();
    return thread;
  }

  getThread(threadId: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as any;
    if (!row) return undefined;
    return this.rowToThread(row);
  }

  listThreadsForOrg(orgId: string, status?: ThreadStatus, limit = 200, offset = 0): Thread[] {
    const base = 'SELECT * FROM threads WHERE org_id = ?';
    const query = status
      ? `${base} AND status = ? ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`
      : `${base} ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`;
    const rows = status
      ? (this.db.prepare(query).all(orgId, status, limit, offset) as any[])
      : (this.db.prepare(query).all(orgId, limit, offset) as any[]);
    return rows.map(row => this.rowToThread(row));
  }

  /**
   * Paginated thread list for org. Cursor is a thread id; ordered by id ASC.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  listThreadsForOrgPaginated(orgId: string, status: ThreadStatus | undefined, cursor: string | undefined, limit: number, search?: string): Thread[] {
    const conditions = ['org_id = ?'];
    const params: any[] = [orgId];

    if (status) { conditions.push('status = ?'); params.push(status); }
    if (cursor) { conditions.push('id > ?'); params.push(cursor); }
    if (search) { conditions.push('topic LIKE ?'); params.push(`%${search}%`); }

    params.push(limit + 1);
    const rows = this.db.prepare(
      `SELECT * FROM threads WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ?`
    ).all(...params) as any[];
    return rows.map(row => this.rowToThread(row));
  }

  listThreadsForBot(botId: string, status?: ThreadStatus, limit = 200): Thread[] {
    const base = `
      SELECT t.* FROM threads t
      JOIN thread_participants tp ON t.id = tp.thread_id
      WHERE tp.bot_id = ?
    `;

    const query = status
      ? `${base} AND t.status = ? ORDER BY t.last_activity_at DESC LIMIT ?`
      : `${base} ORDER BY t.last_activity_at DESC LIMIT ?`;
    const rows = status
      ? (this.db.prepare(query).all(botId, status, limit) as any[])
      : (this.db.prepare(query).all(botId, limit) as any[]);
    return rows.map(row => this.rowToThread(row));
  }

  updateThreadStatus(threadId: string, status: ThreadStatus, closeReason?: CloseReason | null, expectedRevision?: number): Thread | undefined {
    const current = this.getThread(threadId);
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
      const result = this.db.prepare(`
        UPDATE threads
        SET status = ?, close_reason = ?, resolved_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(status, reason, resolvedAt, now, threadId, expectedRevision);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      this.db.prepare(`
        UPDATE threads
        SET status = ?, close_reason = ?, resolved_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(status, reason, resolvedAt, now, threadId);
    }

    return this.getThread(threadId);
  }

  updateThreadContext(threadId: string, context: string | null, expectedRevision?: number): Thread | undefined {
    const current = this.getThread(threadId);
    if (!current) return undefined;

    if (expectedRevision !== undefined) {
      const result = this.db.prepare(`
        UPDATE threads
        SET context = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(context, Date.now(), threadId, expectedRevision);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      this.db.prepare(`
        UPDATE threads
        SET context = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(context, Date.now(), threadId);
    }

    return this.getThread(threadId);
  }

  updateThreadTopic(threadId: string, topic: string, expectedRevision?: number): Thread | undefined {
    const current = this.getThread(threadId);
    if (!current) return undefined;

    if (expectedRevision !== undefined) {
      const result = this.db.prepare(`
        UPDATE threads
        SET topic = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(topic, Date.now(), threadId, expectedRevision);
      if (result.changes === 0) throw new Error('REVISION_CONFLICT');
    } else {
      this.db.prepare(`
        UPDATE threads
        SET topic = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(topic, Date.now(), threadId);
    }

    return this.getThread(threadId);
  }

  addParticipant(threadId: string, botId: string, label?: string | null): ThreadParticipant {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found');
    }

    const bot = this.getBotById(botId);
    if (!bot || bot.org_id !== thread.org_id) {
      throw new Error('Participant bot not found in thread org');
    }

    const existing = this.db.prepare(`
      SELECT * FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `).get(threadId, botId) as any;

    if (existing) {
      if (label !== undefined) {
        this.db.prepare(`
          UPDATE thread_participants SET label = ? WHERE thread_id = ? AND bot_id = ?
        `).run(label ?? null, threadId, botId);
        const updated = this.db.prepare(`
          SELECT * FROM thread_participants WHERE thread_id = ? AND bot_id = ?
        `).get(threadId, botId) as any;
        return this.rowToThreadParticipant(updated);
      }
      return this.rowToThreadParticipant(existing);
    }

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM thread_participants WHERE thread_id = ?
    `).get(threadId) as { count: number };

    if (countRow.count >= 20) {
      throw new Error('Thread participant limit exceeded (max 20)');
    }

    this.db.prepare(`
      INSERT INTO thread_participants (thread_id, bot_id, label, joined_at)
      VALUES (?, ?, ?, ?)
    `).run(threadId, botId, label ?? null, Date.now());

    const row = this.db.prepare(`
      SELECT * FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `).get(threadId, botId) as any;

    return this.rowToThreadParticipant(row);
  }

  removeParticipant(threadId: string, botId: string) {
    this.db.prepare(`
      DELETE FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `).run(threadId, botId);
  }

  getParticipants(threadId: string): ThreadParticipant[] {
    const rows = this.db.prepare(`
      SELECT * FROM thread_participants WHERE thread_id = ? ORDER BY joined_at
    `).all(threadId) as any[];
    return rows.map(row => this.rowToThreadParticipant(row));
  }

  isParticipant(threadId: string, botId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM thread_participants WHERE thread_id = ? AND bot_id = ?
    `).get(threadId, botId);
    return !!row;
  }

  createThreadMessage(
    threadId: string,
    senderId: string,
    content: string,
    contentType = 'text',
    metadata?: string | null,
    parts?: string | null,
  ): ThreadMessage {
    const msg: ThreadMessage = {
      id: crypto.randomUUID(),
      thread_id: threadId,
      sender_id: senderId,
      content,
      content_type: contentType,
      parts: parts ?? null,
      metadata: metadata ?? null,
      created_at: Date.now(),
    };

    const insertMessageStmt = this.db.prepare(`
      INSERT INTO thread_messages (id, thread_id, sender_id, content, content_type, parts, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateActivityStmt = this.db.prepare(`
      UPDATE threads SET last_activity_at = ? WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      insertMessageStmt.run(
        msg.id,
        msg.thread_id,
        msg.sender_id,
        msg.content,
        msg.content_type,
        msg.parts,
        msg.metadata,
        msg.created_at,
      );
      updateActivityStmt.run(msg.created_at, threadId);
    });

    tx();
    return msg;
  }

  getThreadMessages(threadId: string, limit = 50, before?: number, since?: number): ThreadMessage[] {
    const conditions = ['thread_id = ?'];
    const params: any[] = [threadId];

    if (before !== undefined) { conditions.push('created_at < ?'); params.push(before); }
    if (since !== undefined)  { conditions.push('created_at > ?'); params.push(since); }

    params.push(limit);
    const rows = this.db.prepare(
      `SELECT * FROM thread_messages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
    ).all(...params) as any[];

    return rows.map(row => this.rowToThreadMessage(row));
  }

  /**
   * Paginated thread messages (newest first). `before` is a message id.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  getThreadMessagesPaginated(threadId: string, before: string | undefined, limit: number): ThreadMessage[] {
    if (before) {
      const cursorRow = this.db.prepare(
        'SELECT created_at FROM thread_messages WHERE id = ?'
      ).get(before) as { created_at: number } | undefined;
      if (!cursorRow) {
        return (this.db.prepare(
          'SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(threadId, limit + 1) as any[]).map(row => this.rowToThreadMessage(row));
      }
      return (this.db.prepare(
        `SELECT * FROM thread_messages WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(threadId, cursorRow.created_at, cursorRow.created_at, before, limit + 1) as any[]).map(row => this.rowToThreadMessage(row));
    }
    return (this.db.prepare(
      'SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(threadId, limit + 1) as any[]).map(row => this.rowToThreadMessage(row));
  }

  addArtifact(
    threadId: string,
    contributorId: string,
    key: string,
    type: ArtifactType,
    title?: string | null,
    content?: string | null,
    language?: string | null,
    url?: string | null,
    mimeType?: string | null,
  ): Artifact {
    const now = Date.now();
    const normalized = this.normalizeJsonArtifactContent(type, content ?? null);

    const getMaxVersionStmt = this.db.prepare(`
      SELECT MAX(version) as max_version FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
    `);
    const insertArtifactStmt = this.db.prepare(`
      INSERT INTO artifacts (
        id, thread_id, artifact_key, type, title, content, language, url, mime_type,
        contributor_id, version, format_warning, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateActivityStmt = this.db.prepare(`
      UPDATE threads SET last_activity_at = ? WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      const nextVersionRow = getMaxVersionStmt.get(threadId, key) as { max_version: number | null };
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

      insertArtifactStmt.run(
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
      );
      updateActivityStmt.run(now, threadId);

      return artifact;
    });

    return tx();
  }

  updateArtifact(
    threadId: string,
    key: string,
    contributorId: string,
    content: string,
    title?: string | null,
  ): Artifact | undefined {
    const getLatestStmt = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
      ORDER BY version DESC
      LIMIT 1
    `);
    const getMaxVersionStmt = this.db.prepare(`
      SELECT MAX(version) as max_version FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
    `);
    const getOriginalStmt = this.db.prepare(`
      SELECT type, format_warning FROM artifacts
      WHERE thread_id = ? AND artifact_key = ? AND version = 1
    `);
    const insertArtifactStmt = this.db.prepare(`
      INSERT INTO artifacts (
        id, thread_id, artifact_key, type, title, content, language, url, mime_type,
        contributor_id, version, format_warning, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateActivityStmt = this.db.prepare(`
      UPDATE threads SET last_activity_at = ? WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      const latestRow = getLatestStmt.get(threadId, key) as any;
      if (!latestRow) return undefined;
      const latest = this.rowToArtifact(latestRow);

      const nextVersionRow = getMaxVersionStmt.get(threadId, key) as { max_version: number | null };
      const nextVersion = (nextVersionRow?.max_version ?? latest.version) + 1;

      // Use the original declared type for normalization so a downgraded JSON
      // artifact can recover when valid JSON is submitted again.
      // If v1 has format_warning, it was originally declared as 'json' but
      // downgraded to 'text' due to malformed content — treat as 'json'.
      const originalRow = getOriginalStmt.get(threadId, key) as { type: string; format_warning: number } | undefined;
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

      insertArtifactStmt.run(
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
      );
      updateActivityStmt.run(now, threadId);

      return artifact;
    });

    return tx();
  }

  getArtifact(threadId: string, key: string, version?: number): Artifact | undefined {
    const row = version === undefined
      ? this.db.prepare(`
          SELECT * FROM artifacts
          WHERE thread_id = ? AND artifact_key = ?
          ORDER BY version DESC
          LIMIT 1
        `).get(threadId, key)
      : this.db.prepare(`
          SELECT * FROM artifacts
          WHERE thread_id = ? AND artifact_key = ? AND version = ?
          LIMIT 1
        `).get(threadId, key, version);

    if (!row) return undefined;
    return this.rowToArtifact(row);
  }

  listArtifacts(threadId: string): Artifact[] {
    const rows = this.db.prepare(`
      SELECT a.* FROM artifacts a
      JOIN (
        SELECT artifact_key, MAX(version) as max_version
        FROM artifacts
        WHERE thread_id = ?
        GROUP BY artifact_key
      ) latest ON a.artifact_key = latest.artifact_key AND a.version = latest.max_version
      WHERE a.thread_id = ?
      ORDER BY a.created_at ASC
    `).all(threadId, threadId) as any[];

    return rows.map(row => this.rowToArtifact(row));
  }

  /**
   * Paginated artifact list (latest version per key). Cursor is an artifact_key.
   * Returns limit+1 rows so the caller can detect has_more.
   */
  listArtifactsPaginated(threadId: string, cursor: string | undefined, limit: number): Artifact[] {
    const cursorClause = cursor ? 'AND a.artifact_key > ?' : '';
    const params: any[] = cursor
      ? [threadId, threadId, cursor, limit + 1]
      : [threadId, threadId, limit + 1];
    const rows = this.db.prepare(`
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
    `).all(...params) as any[];

    return rows.map(row => this.rowToArtifact(row));
  }

  getArtifactVersions(threadId: string, key: string): Artifact[] {
    const rows = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
      ORDER BY version ASC
    `).all(threadId, key) as any[];

    return rows.map(row => this.rowToArtifact(row));
  }

  // ─── File Operations ────────────────────────────────────

  createFile(orgId: string, uploaderId: string, name: string, mimeType: string | null, size: number, diskPath: string): FileRecord {
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

    this.db.prepare(`
      INSERT INTO files (id, org_id, uploader_id, name, mime_type, size, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(file.id, file.org_id, file.uploader_id, file.name, file.mime_type, file.size, file.path, file.created_at);

    return file;
  }

  getFile(fileId: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRecord | undefined;
    return row || undefined;
  }

  getFileInfo(fileId: string): FileRecord | undefined {
    return this.getFile(fileId);
  }

  getDailyUploadBytes(orgId: string): number {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE org_id = ? AND created_at >= ?'
    ).get(orgId, dayStart.getTime()) as { total: number };
    return row.total;
  }


  /**
   * Atomically check daily upload quota (org-level + per-bot) and create file record.
   * Prevents TOCTOU race where concurrent uploads both pass the quota check.
   */
  createFileWithQuotaCheck(
    orgId: string,
    uploaderId: string,
    name: string,
    mimeType: string | null,
    size: number,
    diskPath: string,
    dailyLimitBytes: number,
    perBotDailyLimitBytes: number,
  ): { ok: true; file: FileRecord } | { ok: false; reason: 'org' | 'bot'; dailyBytes: number; limitBytes: number } {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();

    const getOrgDailyStmt = this.db.prepare(
      'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE org_id = ? AND created_at >= ?'
    );
    const getBotDailyStmt = this.db.prepare(
      'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE org_id = ? AND uploader_id = ? AND created_at >= ?'
    );
    const insertStmt = this.db.prepare(`
      INSERT INTO files (id, org_id, uploader_id, name, mime_type, size, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      // Check org-level daily quota
      const orgRow = getOrgDailyStmt.get(orgId, dayStartMs) as { total: number };
      if (orgRow.total + size > dailyLimitBytes) {
        return { ok: false as const, reason: 'org' as const, dailyBytes: orgRow.total, limitBytes: dailyLimitBytes };
      }

      // Check per-bot daily quota
      if (perBotDailyLimitBytes > 0) {
        const botRow = getBotDailyStmt.get(orgId, uploaderId, dayStartMs) as { total: number };
        if (botRow.total + size > perBotDailyLimitBytes) {
          return { ok: false as const, reason: 'bot' as const, dailyBytes: botRow.total, limitBytes: perBotDailyLimitBytes };
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

      insertStmt.run(file.id, file.org_id, file.uploader_id, file.name, file.mime_type, file.size, file.path, file.created_at);
      return { ok: true as const, file };
    });

    return txn();
  }
  // ─── Catchup Event Operations ─────────────────────────────

  recordCatchupEvent(orgId: string, targetBotId: string, type: string, payload: Record<string, unknown>, refId?: string) {
    const now = Date.now();

    // For aggregatable events (summaries): UPSERT by (target_bot_id, type, ref_id)
    // to avoid flooding catchup with one row per message
    if (refId) {
      const existing = this.db.prepare(
        'SELECT id, payload FROM catchup_events WHERE target_bot_id = ? AND type = ? AND ref_id = ?'
      ).get(targetBotId, type, refId) as { id: string; payload: string } | undefined;

      if (existing) {
        const prev = JSON.parse(existing.payload);
        const merged = { ...prev, ...payload, count: (prev.count || 0) + (payload.count as number || 1) };
        this.db.prepare(
          'UPDATE catchup_events SET payload = ?, occurred_at = ? WHERE id = ?'
        ).run(JSON.stringify(merged), now, existing.id);
        return;
      }
    }

    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO catchup_events (id, org_id, target_bot_id, type, ref_id, payload, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, targetBotId, type, refId ?? null, JSON.stringify(payload), now);
  }

  getCatchupEvents(botId: string, since: number, limit = 50, cursor?: string): { events: CatchupEvent[]; has_more: boolean } {
    let rows: any[];

    if (cursor) {
      // Cursor is the last event_id from previous page — get its occurred_at for efficient seek
      const cursorRow = this.db.prepare(
        'SELECT occurred_at FROM catchup_events WHERE id = ?'
      ).get(cursor) as { occurred_at: number } | undefined;

      if (cursorRow) {
        // Seek past the cursor using (occurred_at, id) tuple comparison
        rows = this.db.prepare(`
          SELECT * FROM catchup_events
          WHERE target_bot_id = ? AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
          ORDER BY occurred_at ASC, id ASC
          LIMIT ?
        `).all(botId, cursorRow.occurred_at, cursorRow.occurred_at, cursor, limit + 1) as any[];
      } else {
        // Invalid cursor — fall back to since-only query
        rows = this.db.prepare(`
          SELECT * FROM catchup_events
          WHERE target_bot_id = ? AND occurred_at > ?
          ORDER BY occurred_at ASC, id ASC
          LIMIT ?
        `).all(botId, since, limit + 1) as any[];
      }
    } else {
      rows = this.db.prepare(`
        SELECT * FROM catchup_events
        WHERE target_bot_id = ? AND occurred_at > ?
        ORDER BY occurred_at ASC, id ASC
        LIMIT ?
      `).all(botId, since, limit + 1) as any[];
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

  getCatchupCount(botId: string, since: number): {
    thread_invites: number;
    thread_status_changes: number;
    thread_activities: number;
    channel_messages: number;
    total: number;
  } {
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) as count FROM catchup_events
      WHERE target_bot_id = ? AND occurred_at > ?
      GROUP BY type
    `).all(botId, since) as { type: string; count: number }[];

    const counts = {
      thread_invites: 0,
      thread_status_changes: 0,
      thread_activities: 0,
      channel_messages: 0,
      total: 0,
    };

    for (const row of rows) {
      switch (row.type) {
        case 'thread_invited':
          counts.thread_invites = row.count;
          break;
        case 'thread_status_changed':
          counts.thread_status_changes = row.count;
          break;
        case 'thread_message_summary':
        case 'thread_artifact_added':
        case 'thread_participant_removed':
          counts.thread_activities += row.count;
          break;
        case 'channel_message_summary':
          counts.channel_messages = row.count;
          break;
      }
    }

    counts.total = counts.thread_invites + counts.thread_status_changes
      + counts.thread_activities + counts.channel_messages;

    return counts;
  }

  cleanupOldCatchupEvents(maxAgeDays: number, batchSize = 5000): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM catchup_events WHERE rowid IN (SELECT rowid FROM catchup_events WHERE occurred_at < ? LIMIT ?)').run(cutoff, batchSize);
    return result.changes;
  }

  // ─── Webhook Status Operations ──────────────────────────

  recordWebhookSuccess(botId: string) {
    this.db.prepare(`
      INSERT INTO webhook_status (bot_id, last_success, last_failure, consecutive_failures, degraded)
      VALUES (?, ?, NULL, 0, 0)
      ON CONFLICT(bot_id) DO UPDATE SET
        last_success = ?,
        consecutive_failures = 0,
        degraded = 0
    `).run(botId, Date.now(), Date.now());
  }

  recordWebhookFailure(botId: string) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO webhook_status (bot_id, last_success, last_failure, consecutive_failures, degraded)
      VALUES (?, NULL, ?, 1, 0)
      ON CONFLICT(bot_id) DO UPDATE SET
        last_failure = ?,
        consecutive_failures = consecutive_failures + 1,
        degraded = CASE WHEN consecutive_failures + 1 >= 10 THEN 1 ELSE degraded END
    `).run(botId, now, now);
  }

  getWebhookHealth(botId: string): WebhookHealth | null {
    const row = this.db.prepare(
      'SELECT * FROM webhook_status WHERE bot_id = ?'
    ).get(botId) as any;
    if (!row) return null;
    return {
      healthy: row.consecutive_failures === 0,
      last_success: row.last_success ?? null,
      last_failure: row.last_failure ?? null,
      consecutive_failures: row.consecutive_failures,
      degraded: !!row.degraded,
    };
  }

  isWebhookDegraded(botId: string): boolean {
    const row = this.db.prepare(
      'SELECT degraded FROM webhook_status WHERE bot_id = ?'
    ).get(botId) as any;
    return !!row?.degraded;
  }

  resetWebhookDegraded(botId: string) {
    this.db.prepare(`
      UPDATE webhook_status SET degraded = 0, consecutive_failures = 0 WHERE bot_id = ?
    `).run(botId);
  }

  // ─── Org Settings Operations ────────────────────────────

  getOrgSettings(orgId: string): OrgSettings {
    const row = this.db.prepare('SELECT * FROM org_settings WHERE org_id = ?').get(orgId) as any;
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
      messages_per_minute_per_bot: 60,
      threads_per_hour_per_bot: 30,
      file_upload_mb_per_day_per_bot: 100,
      message_ttl_days: null,
      thread_auto_close_days: null,
      artifact_retention_days: null,
      default_thread_permission_policy: null,
      updated_at: 0,
    };
  }

  updateOrgSettings(orgId: string, updates: Partial<OrgSettings>): OrgSettings {
    const now = Date.now();
    const current = this.getOrgSettings(orgId);
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

    this.db.prepare(`
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
    `).run(
      merged.org_id,
      merged.messages_per_minute_per_bot,
      merged.threads_per_hour_per_bot,
      merged.file_upload_mb_per_day_per_bot,
      merged.message_ttl_days,
      merged.thread_auto_close_days,
      merged.artifact_retention_days,
      policyJson,
      merged.updated_at,
    );

    return merged;
  }

  // ─── Rate Limiting Operations ─────────────────────────────

  /**
   * Atomically check rate limit and record the event in a single transaction.
   * Prevents TOCTOU race where concurrent requests both pass the check.
   */
  checkAndRecordRateLimit(orgId: string, botId: string, resource: 'message' | 'thread'): { allowed: boolean; retryAfter?: number } {
    const settings = this.getOrgSettings(orgId);
    const now = Date.now();

    const txn = this.db.transaction(() => {
      if (resource === 'message') {
        const windowStart = now - 60000; // 1 minute
        const row = this.db.prepare(
          `SELECT COUNT(*) as count, MIN(created_at) as oldest FROM rate_limit_events
           WHERE org_id = ? AND bot_id = ? AND resource_type = 'message' AND created_at > ?`
        ).get(orgId, botId, windowStart) as { count: number; oldest: number | null };

        if (row.count >= settings.messages_per_minute_per_bot) {
          const retryAfter = row.oldest ? Math.ceil((row.oldest + 60000 - now) / 1000) : 60;
          return { allowed: false as const, retryAfter: Math.max(retryAfter, 1) };
        }
      } else {
        const windowStart = now - 3600000; // 1 hour
        const row = this.db.prepare(
          `SELECT COUNT(*) as count, MIN(created_at) as oldest FROM rate_limit_events
           WHERE org_id = ? AND bot_id = ? AND resource_type = 'thread' AND created_at > ?`
        ).get(orgId, botId, windowStart) as { count: number; oldest: number | null };

        if (row.count >= settings.threads_per_hour_per_bot) {
          const retryAfter = row.oldest ? Math.ceil((row.oldest + 3600000 - now) / 1000) : 3600;
          return { allowed: false as const, retryAfter: Math.max(retryAfter, 1) };
        }
      }

      // Within limit — record the event atomically
      this.db.prepare(
        'INSERT INTO rate_limit_events (org_id, bot_id, resource_type, created_at) VALUES (?, ?, ?, ?)'
      ).run(orgId, botId, resource, now);

      return { allowed: true as const };
    });

    return txn();
  }

  cleanupOldRateLimitEvents(batchSize = 10000): number {
    const cutoff = Date.now() - 3600000; // 1 hour
    const result = this.db.prepare('DELETE FROM rate_limit_events WHERE rowid IN (SELECT rowid FROM rate_limit_events WHERE created_at < ? LIMIT ?)').run(cutoff, batchSize);
    return result.changes;
  }

  // ─── Audit Log Operations ─────────────────────────────────

  recordAudit(
    orgId: string,
    botId: string | null,
    action: AuditAction,
    targetType: string,
    targetId: string,
    detail?: Record<string, unknown>,
  ): void {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO audit_log (id, org_id, bot_id, action, target_type, target_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, botId, action, targetType, targetId, detail ? JSON.stringify(detail) : null, now);
  }

  getAuditLog(orgId: string, filters?: {
    since?: number;
    action?: string;
    target_type?: string;
    target_id?: string;
    bot_id?: string;
    limit?: number;
  }): AuditEntry[] {
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

    const rows = this.db.prepare(`
      SELECT * FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as any[];

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

  cleanupOldAuditLog(maxAgeDays: number, batchSize = 5000): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM audit_log WHERE rowid IN (SELECT rowid FROM audit_log WHERE created_at < ? LIMIT ?)').run(cutoff, batchSize);
    return result.changes;
  }

  // ─── TTL / Lifecycle Cleanup Operations ────────────────────

  cleanupExpiredMessages(orgId: string, ttlDays: number, batchSize = 5000): number {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let total = 0;

    // Delete channel messages older than TTL (batched)
    const r1 = this.db.prepare(`
      DELETE FROM messages WHERE rowid IN (
        SELECT messages.rowid FROM messages
        JOIN channels ON channels.id = messages.channel_id
        WHERE channels.org_id = ? AND messages.created_at < ?
        LIMIT ?
      )
    `).run(orgId, cutoff, batchSize);
    total += r1.changes;

    // Delete thread messages older than TTL (only in resolved/closed threads, batched)
    const r2 = this.db.prepare(`
      DELETE FROM thread_messages WHERE rowid IN (
        SELECT thread_messages.rowid FROM thread_messages
        JOIN threads ON threads.id = thread_messages.thread_id
        WHERE threads.org_id = ? AND threads.status IN ('resolved', 'closed')
        AND thread_messages.created_at < ?
        LIMIT ?
      )
    `).run(orgId, cutoff, batchSize);
    total += r2.changes;

    return total;
  }

  autoCloseInactiveThreads(orgId: string, days: number, batchSize = 1000): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const r = this.db.prepare(`
      UPDATE threads SET status = 'closed', close_reason = 'timeout', updated_at = ?, last_activity_at = ?, revision = revision + 1
      WHERE rowid IN (
        SELECT rowid FROM threads
        WHERE org_id = ? AND last_activity_at < ? AND status NOT IN ('resolved', 'closed')
        LIMIT ?
      )
    `).run(now, now, orgId, cutoff, batchSize);
    return r.changes;
  }

  cleanupExpiredArtifacts(orgId: string, days: number, batchSize = 5000): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const r = this.db.prepare(`
      DELETE FROM artifacts WHERE rowid IN (
        SELECT artifacts.rowid FROM artifacts
        JOIN threads ON threads.id = artifacts.thread_id
        WHERE threads.org_id = ? AND threads.status IN ('resolved', 'closed')
        AND artifacts.created_at < ?
        LIMIT ?
      )
    `).run(orgId, cutoff, batchSize);
    return r.changes;
  }

  /** Repeat a batched cleanup until it returns fewer than batchSize rows. */
  private drainBatch(fn: (batchSize: number) => number, batchSize: number): number {
    let total = 0;
    let deleted: number;
    do {
      deleted = fn(batchSize);
      total += deleted;
    } while (deleted >= batchSize);
    return total;
  }

  runLifecycleCleanup(): void {
    const orgs = this.listOrgs();
    for (const org of orgs) {
      const settings = this.getOrgSettings(org.id);
      const detail: Record<string, number> = {};

      if (settings.message_ttl_days !== null && settings.message_ttl_days > 0) {
        const n = this.drainBatch((bs) => this.cleanupExpiredMessages(org.id, settings.message_ttl_days!, bs), 5000);
        if (n > 0) detail.messages_deleted = n;
      }

      if (settings.thread_auto_close_days !== null && settings.thread_auto_close_days > 0) {
        const n = this.drainBatch((bs) => this.autoCloseInactiveThreads(org.id, settings.thread_auto_close_days!, bs), 1000);
        if (n > 0) detail.threads_closed = n;
      }

      if (settings.artifact_retention_days !== null && settings.artifact_retention_days > 0) {
        const n = this.drainBatch((bs) => this.cleanupExpiredArtifacts(org.id, settings.artifact_retention_days!, bs), 5000);
        if (n > 0) detail.artifacts_deleted = n;
      }

      if (Object.keys(detail).length > 0) {
        this.recordAudit(org.id, null, 'lifecycle.cleanup', 'org', org.id, detail);
      }
    }

    // Global cleanups (all batched with drain loops)
    this.drainBatch((bs) => this.cleanupOldCatchupEvents(30, bs), 5000);
    this.drainBatch((bs) => this.cleanupOldAuditLog(90, bs), 5000);
    this.drainBatch((bs) => this.cleanupOldRateLimitEvents(bs), 10000);
    this.drainBatch((bs) => this.cleanupExpiredTokens(bs), 1000);
    this.cleanupExpiredOrgTickets();
  }

  /** O1: Lightweight DB health check */
  isHealthy(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.db.close();
  }
}
