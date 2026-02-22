import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type {
  Org,
  Agent,
  Channel,
  ChannelMember,
  Message,
  HubConfig,
  AgentProfileInput,
  ListBotsFilters,
  Thread,
  ThreadParticipant,
  ThreadMessage,
  Artifact,
  ArtifactType,
  ThreadType,
  ThreadStatus,
  CloseReason,
  FileRecord,
  CatchupEvent,
  WebhookHealth,
  OrgSettings,
  AuditAction,
  AuditEntry,
  AgentToken,
  TokenScope,
  ThreadPermissionPolicy,
} from './types.js';

// ─── Database Layer ──────────────────────────────────────────

export class HubDB {
  private db: Database.Database;

  constructor(config: HubConfig) {
    fs.mkdirSync(config.data_dir, { recursive: true });
    const dbPath = path.join(config.data_dir, 'botshub.db');
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
        api_key TEXT UNIQUE NOT NULL,
        admin_secret TEXT,
        persist_messages INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        display_name TEXT,
        token TEXT UNIQUE NOT NULL,
        metadata TEXT,
        webhook_url TEXT,
        webhook_secret TEXT,
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
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'discussion'
          CHECK(type IN ('discussion', 'request', 'collab')),
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'active', 'blocked', 'reviewing', 'resolved', 'closed')),
        initiator_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
        context TEXT,
        close_reason TEXT
          CHECK(close_reason IS NULL OR close_reason IN ('manual', 'timeout', 'error')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS thread_participants (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        label TEXT,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
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
        contributor_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        format_warning INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(thread_id, artifact_key, version)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);
      CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(org_id);
      CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);
      CREATE INDEX IF NOT EXISTS idx_threads_org ON threads(org_id, status);
      CREATE INDEX IF NOT EXISTS idx_threads_initiator ON threads(initiator_id);
      CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_thread_participants_bot ON thread_participants(bot_id);
      CREATE INDEX IF NOT EXISTS idx_thread_messages ON thread_messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        uploader_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
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
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catchup_target ON catchup_events(target_bot_id, occurred_at);

      CREATE TABLE IF NOT EXISTS webhook_status (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        last_success INTEGER,
        last_failure INTEGER,
        consecutive_failures INTEGER DEFAULT 0,
        degraded INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS org_settings (
        org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        messages_per_minute_per_bot INTEGER DEFAULT 60,
        threads_per_hour_per_bot INTEGER DEFAULT 30,
        message_ttl_days INTEGER,
        thread_auto_close_days INTEGER,
        artifact_retention_days INTEGER,
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

      CREATE TABLE IF NOT EXISTS agent_tokens (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        scopes TEXT NOT NULL DEFAULT '["full"]',
        label TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_token ON agent_tokens(token);
    `);

    // Migration: add admin_secret to existing orgs that don't have it
    try {
      this.db.exec(`ALTER TABLE orgs ADD COLUMN admin_secret TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: add profile fields to existing agents
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN bio TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN role TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN function TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN team TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN tags TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN languages TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN protocols TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN status_text TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN timezone TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN active_hours TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN version TEXT DEFAULT '1.0.0'`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agents ADD COLUMN runtime TEXT`);
    } catch {
      // Column already exists
    }

    this.db.prepare(`UPDATE agents SET version = '1.0.0' WHERE version IS NULL OR version = ''`).run();

    // Migration: add parts column to messages and thread_messages
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN parts TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE thread_messages ADD COLUMN parts TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: add revision column for optimistic concurrency
    try {
      this.db.exec(`ALTER TABLE threads ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
    } catch {
      // Column already exists
    }

    // Migration: add permission_policy to threads (Security P2)
    try {
      this.db.exec(`ALTER TABLE threads ADD COLUMN permission_policy TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: add default_thread_permission_policy to org_settings (Security P2)
    try {
      this.db.exec(`ALTER TABLE org_settings ADD COLUMN default_thread_permission_policy TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: fix FK constraints on threads/thread_messages/artifacts
    // SQLite cannot ALTER FK constraints, so we must recreate tables.
    this.migrateThreadForeignKeys();

    // Migration: fix files.uploader_id NOT NULL → nullable for ON DELETE SET NULL
    this.migrateFilesForeignKey();

    // Generate admin_secret for orgs that don't have one
    const orgsWithoutSecret = this.db.prepare('SELECT id FROM orgs WHERE admin_secret IS NULL').all() as any[];
    for (const org of orgsWithoutSecret) {
      const secret = crypto.randomBytes(24).toString('hex');
      this.db.prepare('UPDATE orgs SET admin_secret = ? WHERE id = ?').run(secret, org.id);
      console.log(`  🔐 Generated admin_secret for org ${org.id}`);
    }
  }

  private migrateThreadForeignKeys() {
    // Check if threads table has the old NOT NULL initiator_id without ON DELETE SET NULL.
    // We detect this by checking the table schema via pragma.
    const threadsInfo = this.db.pragma('table_info(threads)') as any[];
    if (threadsInfo.length === 0) return; // table doesn't exist yet (fresh install)

    const initiatorCol = threadsInfo.find((c: any) => c.name === 'initiator_id');
    if (!initiatorCol || initiatorCol.notnull === 0) return; // already nullable = already migrated

    console.log('  🔧 Migrating thread tables for FK constraint fixes...');

    // Disable FK enforcement during migration to prevent CASCADE deletes
    // when dropping parent tables (SQLite recommended practice for table recreation)
    this.db.pragma('foreign_keys = OFF');

    this.db.exec(`BEGIN TRANSACTION;
      -- threads: initiator_id NOT NULL → nullable, ON DELETE SET NULL; channel_id ON DELETE SET NULL
      CREATE TABLE threads_new (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'discussion'
          CHECK(type IN ('discussion', 'request', 'collab')),
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'active', 'blocked', 'reviewing', 'resolved', 'closed')),
        initiator_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
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
      INSERT INTO threads_new (id, org_id, topic, type, status, initiator_id, channel_id, context, close_reason, revision, permission_policy, created_at, updated_at, last_activity_at, resolved_at)
        SELECT id, org_id, topic, type, status, initiator_id, channel_id, context, close_reason, revision, permission_policy, created_at, updated_at, last_activity_at, resolved_at FROM threads;
      DROP TABLE threads;
      ALTER TABLE threads_new RENAME TO threads;

      -- thread_messages: sender_id NOT NULL → nullable, ON DELETE SET NULL
      CREATE TABLE thread_messages_new (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        parts TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO thread_messages_new SELECT * FROM thread_messages;
      DROP TABLE thread_messages;
      ALTER TABLE thread_messages_new RENAME TO thread_messages;

      -- artifacts: contributor_id NOT NULL → nullable, ON DELETE SET NULL
      CREATE TABLE artifacts_new (
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
        contributor_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        format_warning INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(thread_id, artifact_key, version)
      );
      INSERT INTO artifacts_new SELECT * FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_new RENAME TO artifacts;

      -- Recreate indexes (dropped with old tables)
      CREATE INDEX IF NOT EXISTS idx_threads_org ON threads(org_id, status);
      CREATE INDEX IF NOT EXISTS idx_threads_initiator ON threads(initiator_id);
      CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_thread_messages ON thread_messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id, created_at);
    COMMIT;`);

    this.db.pragma('foreign_keys = ON');
    console.log('  ✅ Thread FK migration complete');
  }

  private migrateFilesForeignKey() {
    const filesInfo = this.db.pragma('table_info(files)') as any[];
    if (filesInfo.length === 0) return; // table doesn't exist yet (fresh install)

    const uploaderCol = filesInfo.find((c: any) => c.name === 'uploader_id');
    if (!uploaderCol || uploaderCol.notnull === 0) return; // already nullable = already migrated

    console.log('  🔧 Migrating files table: uploader_id NOT NULL → nullable...');

    this.db.pragma('foreign_keys = OFF');

    this.db.exec(`BEGIN TRANSACTION;
      CREATE TABLE files_new (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        uploader_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO files_new SELECT * FROM files;
      DROP TABLE files;
      ALTER TABLE files_new RENAME TO files;

      CREATE INDEX IF NOT EXISTS idx_files_org ON files(org_id, created_at);
    COMMIT;`);

    this.db.pragma('foreign_keys = ON');
    console.log('  ✅ Files FK migration complete');
  }

  private rowToOrg(row: any): Org {
    return {
      ...row,
      persist_messages: !!row.persist_messages,
    };
  }

  private rowToAgent(row: any): Agent {
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
      online: !!row.online,
    };
  }

  private rowToThread(row: any): Thread {
    return {
      ...row,
      initiator_id: row.initiator_id ?? null,
      channel_id: row.channel_id ?? null,
      context: row.context ?? null,
      close_reason: row.close_reason ?? null,
      permission_policy: row.permission_policy ?? null,
      revision: row.revision ?? 1,
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

  private serializeProfileFields(fields?: AgentProfileInput): {
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
    const org: Org = {
      id: crypto.randomUUID(),
      name,
      api_key: crypto.randomBytes(24).toString('hex'),
      admin_secret: crypto.randomBytes(24).toString('hex'),
      persist_messages: persistMessages,
      created_at: Date.now(),
    };
    this.db.prepare(
      'INSERT INTO orgs (id, name, api_key, admin_secret, persist_messages, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(org.id, org.name, org.api_key, org.admin_secret, org.persist_messages ? 1 : 0, org.created_at);
    return org;
  }

  getOrgByKey(apiKey: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE api_key = ?').get(apiKey) as any;
    if (!row) return undefined;
    return this.rowToOrg(row);
  }

  verifyOrgAdminSecret(orgId: string, secret: string): boolean {
    const row = this.db.prepare('SELECT admin_secret FROM orgs WHERE id = ?').get(orgId) as any;
    if (!row?.admin_secret) return false;
    const expected = Buffer.from(row.admin_secret, 'utf8');
    const actual = Buffer.from(secret, 'utf8');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  getOrgById(id: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToOrg(row);
  }

  listOrgs(): Org[] {
    return (this.db.prepare('SELECT * FROM orgs ORDER BY created_at').all() as any[]).map(r => this.rowToOrg(r));
  }

  // ─── Agent Operations ────────────────────────────────────

  registerAgent(
    orgId: string,
    name: string,
    displayName?: string | null,
    metadata?: Record<string, unknown> | null,
    webhookUrl?: string | null,
    webhookSecret?: string | null,
    profile?: AgentProfileInput,
  ): Agent {
    // Check if agent already exists → return existing token
    const existing = this.db.prepare(
      'SELECT * FROM agents WHERE org_id = ? AND name = ?'
    ).get(orgId, name) as any;

    const now = Date.now();
    const serializedProfile = this.serializeProfileFields(profile);

    if (existing) {
      const updates: string[] = ['online = 1', 'last_seen_at = ?'];
      const params: any[] = [now];

      if (displayName !== undefined) {
        updates.push('display_name = ?');
        params.push(displayName);
      }
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
        `UPDATE agents SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);

      const updated = this.getAgentById(existing.id);
      if (!updated) {
        throw new Error('Agent update failed');
      }
      return updated;
    }

    const agent: Agent = {
      id: crypto.randomUUID(),
      org_id: orgId,
      name,
      display_name: displayName ?? null,
      token: `agent_${crypto.randomBytes(24).toString('hex')}`,
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
      online: true,
      last_seen_at: now,
      created_at: now,
    };

    this.db.prepare(
      `INSERT INTO agents (
        id, org_id, name, display_name, token, metadata, webhook_url, webhook_secret,
        bio, role, "function", team, tags, languages, protocols, status_text, timezone, active_hours, version, runtime,
        online, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agent.id,
      agent.org_id,
      agent.name,
      agent.display_name,
      agent.token,
      agent.metadata,
      agent.webhook_url,
      agent.webhook_secret,
      agent.bio,
      agent.role,
      agent.function,
      agent.team,
      agent.tags,
      agent.languages,
      agent.protocols,
      agent.status_text,
      agent.timezone,
      agent.active_hours,
      agent.version,
      agent.runtime,
      agent.online ? 1 : 0,
      agent.last_seen_at,
      agent.created_at,
    );

    return agent;
  }

  updateProfile(agentId: string, fields: AgentProfileInput): Agent | undefined {
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
      return this.getAgentById(agentId);
    }

    params.push(agentId);

    this.db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getAgentById(agentId);
  }

  getAgentByToken(token: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE token = ?').get(token) as any;
    if (!row) return undefined;
    return this.rowToAgent(row);
  }

  getAgentById(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToAgent(row);
  }

  getAgentByName(orgId: string, name: string): Agent | undefined {
    const row = this.db.prepare(
      'SELECT * FROM agents WHERE org_id = ? AND name = ?'
    ).get(orgId, name) as any;
    if (!row) return undefined;
    return this.rowToAgent(row);
  }

  listAgents(orgId: string): Agent[] {
    return (this.db.prepare(
      'SELECT * FROM agents WHERE org_id = ? ORDER BY name'
    ).all(orgId) as any[]).map(r => this.rowToAgent(r));
  }

  listBots(orgId: string, filters?: ListBotsFilters): Agent[] {
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
      `SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY name`
    ).all(...params) as any[]).map(r => this.rowToAgent(r));

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

  setAgentOnline(agentId: string, online: boolean) {
    this.db.prepare(
      'UPDATE agents SET online = ?, last_seen_at = ? WHERE id = ?'
    ).run(online ? 1 : 0, Date.now(), agentId);
  }

  deleteAgent(agentId: string) {
    // Auto-close threads where this agent is the sole remaining participant
    // (ON DELETE CASCADE would orphan them, making them inaccessible via API)
    const soloThreads = this.db.prepare(`
      SELECT tp.thread_id FROM thread_participants tp
      WHERE tp.bot_id = ?
        AND (SELECT COUNT(*) FROM thread_participants tp2 WHERE tp2.thread_id = tp.thread_id) = 1
    `).all(agentId) as { thread_id: string }[];
    const now = Date.now();
    for (const { thread_id } of soloThreads) {
      this.db.prepare(`
        UPDATE threads SET status = 'closed', close_reason = 'error', updated_at = ?, last_activity_at = ?, revision = revision + 1
        WHERE id = ? AND status NOT IN ('resolved', 'closed')
      `).run(now, now, thread_id);
    }

    this.db.prepare('DELETE FROM channel_members WHERE agent_id = ?').run(agentId);
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  }

  // ─── Agent Token Operations (Scoped Tokens) ─────────────

  createAgentToken(agentId: string, scopes: TokenScope[], label?: string | null, expiresAt?: number | null): AgentToken {
    const token: AgentToken = {
      id: crypto.randomUUID(),
      agent_id: agentId,
      token: `scoped_${crypto.randomBytes(24).toString('hex')}`,
      scopes,
      label: label ?? null,
      expires_at: expiresAt ?? null,
      created_at: Date.now(),
      last_used_at: null,
    };

    this.db.prepare(`
      INSERT INTO agent_tokens (id, agent_id, token, scopes, label, expires_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token.id,
      token.agent_id,
      token.token,
      JSON.stringify(token.scopes),
      token.label,
      token.expires_at,
      token.created_at,
      token.last_used_at,
    );

    return token;
  }

  getAgentTokenByToken(token: string): AgentToken | undefined {
    const row = this.db.prepare('SELECT * FROM agent_tokens WHERE token = ?').get(token) as any;
    if (!row) return undefined;
    return this.rowToAgentToken(row);
  }

  listAgentTokens(agentId: string): AgentToken[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_tokens WHERE agent_id = ? ORDER BY created_at DESC'
    ).all(agentId) as any[];
    return rows.map(row => this.rowToAgentToken(row));
  }

  revokeAgentToken(tokenId: string, agentId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM agent_tokens WHERE id = ? AND agent_id = ?'
    ).run(tokenId, agentId);
    return result.changes > 0;
  }

  touchAgentToken(tokenId: string): void {
    this.db.prepare(
      'UPDATE agent_tokens SET last_used_at = ? WHERE id = ?'
    ).run(Date.now(), tokenId);
  }

  cleanupExpiredTokens(): number {
    const result = this.db.prepare(
      'DELETE FROM agent_tokens WHERE expires_at IS NOT NULL AND expires_at < ?'
    ).run(Date.now());
    return result.changes;
  }

  private rowToAgentToken(row: any): AgentToken {
    let scopes: TokenScope[];
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      scopes = ['full'];
    }
    return {
      id: row.id,
      agent_id: row.agent_id,
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
    // For direct channels, check if one already exists between these two agents
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
      'INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)'
    );

    const tx = this.db.transaction(() => {
      insertChannel.run(channel.id, channel.org_id, channel.type, channel.name, channel.created_at);
      for (const agentId of memberIds) {
        insertMember.run(channel.id, agentId, Date.now());
      }
    });
    tx();

    return { ...channel, isNew: true };
  }

  private findDirectChannel(agentId1: string, agentId2: string): Channel | undefined {
    const row = this.db.prepare(`
      SELECT c.* FROM channels c
      JOIN channel_members cm1 ON c.id = cm1.channel_id AND cm1.agent_id = ?
      JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.agent_id = ?
      WHERE c.type = 'direct'
      LIMIT 1
    `).get(agentId1, agentId2) as any;
    return row || undefined;
  }

  deleteChannel(channelId: string) {
    this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
    this.db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  }

  getChannel(channelId: string): Channel | undefined {
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as Channel | undefined;
  }

  listChannelsForAgent(agentId: string): (Channel & { members: string[] })[] {
    const channels = this.db.prepare(`
      SELECT c.* FROM channels c
      JOIN channel_members cm ON c.id = cm.channel_id
      WHERE cm.agent_id = ?
      ORDER BY c.created_at DESC
    `).all(agentId) as Channel[];

    return channels.map(ch => ({
      ...ch,
      members: this.getChannelMembers(ch.id).map(m => m.agent_id),
    }));
  }

  listChannelsForOrg(orgId: string): (Channel & { members: string[] })[] {
    const channels = this.db.prepare(
      'SELECT * FROM channels WHERE org_id = ? ORDER BY created_at DESC'
    ).all(orgId) as Channel[];

    return channels.map(ch => ({
      ...ch,
      members: this.getChannelMembers(ch.id).map(m => m.agent_id),
    }));
  }

  getChannelMembers(channelId: string): ChannelMember[] {
    return this.db.prepare(
      'SELECT * FROM channel_members WHERE channel_id = ?'
    ).all(channelId) as ChannelMember[];
  }

  addChannelMember(channelId: string, agentId: string) {
    this.db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)'
    ).run(channelId, agentId, Date.now());
  }

  isChannelMember(channelId: string, agentId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?'
    ).get(channelId, agentId);
    return !!row;
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

  getMessages(channelId: string, limit = 50, before?: number): Message[] {
    if (before) {
      return this.db.prepare(
        'SELECT * FROM messages WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
      ).all(channelId, before, limit) as Message[];
    }

    return this.db.prepare(
      'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(channelId, limit) as Message[];
  }

  getNewMessages(agentId: string, since: number): (Message & { channel_name?: string })[] {
    return this.db.prepare(`
      SELECT m.*, ch.name as channel_name FROM messages m
      JOIN channel_members cm ON m.channel_id = cm.channel_id AND cm.agent_id = ?
      JOIN channels ch ON m.channel_id = ch.id
      WHERE m.created_at > ? AND m.sender_id != ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `).all(agentId, since, agentId) as any[];
  }

  // ─── Thread Operations ───────────────────────────────────

  createThread(
    orgId: string,
    initiatorId: string,
    topic: string,
    type: ThreadType,
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
      type,
      status: 'open',
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

    const getAgentOrgStmt = this.db.prepare('SELECT org_id FROM agents WHERE id = ?');
    const getChannelOrgStmt = this.db.prepare('SELECT org_id FROM channels WHERE id = ?');
    const insertThreadStmt = this.db.prepare(`
      INSERT INTO threads (
        id, org_id, topic, type, status, initiator_id, channel_id, context, close_reason,
        permission_policy, revision, created_at, updated_at, last_activity_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertParticipantStmt = this.db.prepare(`
      INSERT INTO thread_participants (thread_id, bot_id, label, joined_at)
      VALUES (?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      const initiatorRow = getAgentOrgStmt.get(initiatorId) as { org_id: string } | undefined;
      if (!initiatorRow || initiatorRow.org_id !== orgId) {
        throw new Error('Invalid initiator');
      }

      for (const participantId of uniqueParticipantIds) {
        const participantRow = getAgentOrgStmt.get(participantId) as { org_id: string } | undefined;
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
        thread.type,
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

  listThreadsForAgent(agentId: string, status?: ThreadStatus, limit = 200): Thread[] {
    const base = `
      SELECT t.* FROM threads t
      JOIN thread_participants tp ON t.id = tp.thread_id
      WHERE tp.bot_id = ?
    `;

    const query = status
      ? `${base} AND t.status = ? ORDER BY t.last_activity_at DESC LIMIT ?`
      : `${base} ORDER BY t.last_activity_at DESC LIMIT ?`;
    const rows = status
      ? (this.db.prepare(query).all(agentId, status, limit) as any[])
      : (this.db.prepare(query).all(agentId, limit) as any[]);
    return rows.map(row => this.rowToThread(row));
  }

  updateThreadStatus(threadId: string, status: ThreadStatus, closeReason?: CloseReason | null, expectedRevision?: number): Thread | undefined {
    const current = this.getThread(threadId);
    if (!current) return undefined;

    if (current.status === 'resolved' || current.status === 'closed') {
      throw new Error('Thread is in terminal state and cannot be changed');
    }

    // Forward-only status transitions: open → active → blocked/reviewing → resolved/closed
    const STATUS_ORDER: Record<string, number> = { open: 0, active: 1, blocked: 2, reviewing: 2, resolved: 3, closed: 3 };
    if ((STATUS_ORDER[status] ?? 0) < (STATUS_ORDER[current.status] ?? 0)) {
      throw new Error(`Cannot transition from '${current.status}' to '${status}' (backward transition)`);
    }

    if (status === 'closed' && !closeReason) {
      throw new Error('close_reason is required for closed status');
    }

    if (status !== 'closed' && closeReason) {
      throw new Error('close_reason is only allowed with closed status');
    }

    const now = Date.now();
    const resolvedAt = status === 'resolved' && current.resolved_at === null ? now : current.resolved_at;
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

    const agent = this.getAgentById(botId);
    if (!agent || agent.org_id !== thread.org_id) {
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

  getThreadMessages(threadId: string, limit = 50, before?: number): ThreadMessage[] {
    const rows = before
      ? (this.db.prepare(`
          SELECT * FROM thread_messages
          WHERE thread_id = ? AND created_at < ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(threadId, before, limit) as any[])
      : (this.db.prepare(`
          SELECT * FROM thread_messages
          WHERE thread_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(threadId, limit) as any[]);

    return rows.map(row => this.rowToThreadMessage(row));
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
    const nextVersionRow = this.db.prepare(`
      SELECT MAX(version) as max_version FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
    `).get(threadId, key) as { max_version: number | null };
    const nextVersion = (nextVersionRow?.max_version ?? 0) + 1;

    const normalized = this.normalizeJsonArtifactContent(type, content ?? null);
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
    });

    tx();
    return artifact;
  }

  updateArtifact(
    threadId: string,
    key: string,
    contributorId: string,
    content: string,
    title?: string | null,
  ): Artifact | undefined {
    const latestRow = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
      ORDER BY version DESC
      LIMIT 1
    `).get(threadId, key) as any;

    if (!latestRow) return undefined;
    const latest = this.rowToArtifact(latestRow);
    const nextVersionRow = this.db.prepare(`
      SELECT MAX(version) as max_version FROM artifacts
      WHERE thread_id = ? AND artifact_key = ?
    `).get(threadId, key) as { max_version: number | null };
    const nextVersion = (nextVersionRow?.max_version ?? latest.version) + 1;

    // Use the original declared type for normalization so a downgraded JSON
    // artifact can recover when valid JSON is submitted again.
    // If v1 has format_warning, it was originally declared as 'json' but
    // downgraded to 'text' due to malformed content — treat as 'json'.
    const originalRow = this.db.prepare(`
      SELECT type, format_warning FROM artifacts
      WHERE thread_id = ? AND artifact_key = ? AND version = 1
    `).get(threadId, key) as { type: string; format_warning: number } | undefined;
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
    });

    tx();
    return artifact;
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
  // ─── Catchup Event Operations ─────────────────────────────

  recordCatchupEvent(orgId: string, targetBotId: string, type: string, payload: Record<string, unknown>) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO catchup_events (id, org_id, target_bot_id, type, payload, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, targetBotId, type, JSON.stringify(payload), now);
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

  cleanupOldCatchupEvents(maxAgeDays: number) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM catchup_events WHERE occurred_at < ?').run(cutoff);
  }

  // ─── Webhook Status Operations ──────────────────────────

  recordWebhookSuccess(agentId: string) {
    this.db.prepare(`
      INSERT INTO webhook_status (agent_id, last_success, last_failure, consecutive_failures, degraded)
      VALUES (?, ?, NULL, 0, 0)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_success = ?,
        consecutive_failures = 0,
        degraded = 0
    `).run(agentId, Date.now(), Date.now());
  }

  recordWebhookFailure(agentId: string) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO webhook_status (agent_id, last_success, last_failure, consecutive_failures, degraded)
      VALUES (?, NULL, ?, 1, 0)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_failure = ?,
        consecutive_failures = consecutive_failures + 1,
        degraded = CASE WHEN consecutive_failures + 1 >= 10 THEN 1 ELSE degraded END
    `).run(agentId, now, now);
  }

  getWebhookHealth(agentId: string): WebhookHealth | null {
    const row = this.db.prepare(
      'SELECT * FROM webhook_status WHERE agent_id = ?'
    ).get(agentId) as any;
    if (!row) return null;
    return {
      healthy: row.consecutive_failures === 0,
      last_success: row.last_success ?? null,
      last_failure: row.last_failure ?? null,
      consecutive_failures: row.consecutive_failures,
      degraded: !!row.degraded,
    };
  }

  isWebhookDegraded(agentId: string): boolean {
    const row = this.db.prepare(
      'SELECT degraded FROM webhook_status WHERE agent_id = ?'
    ).get(agentId) as any;
    return !!row?.degraded;
  }

  resetWebhookDegraded(agentId: string) {
    this.db.prepare(`
      UPDATE webhook_status SET degraded = 0, consecutive_failures = 0 WHERE agent_id = ?
    `).run(agentId);
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
      INSERT INTO org_settings (org_id, messages_per_minute_per_bot, threads_per_hour_per_bot, message_ttl_days, thread_auto_close_days, artifact_retention_days, default_thread_permission_policy, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET
        messages_per_minute_per_bot = excluded.messages_per_minute_per_bot,
        threads_per_hour_per_bot = excluded.threads_per_hour_per_bot,
        message_ttl_days = excluded.message_ttl_days,
        thread_auto_close_days = excluded.thread_auto_close_days,
        artifact_retention_days = excluded.artifact_retention_days,
        default_thread_permission_policy = excluded.default_thread_permission_policy,
        updated_at = excluded.updated_at
    `).run(
      merged.org_id,
      merged.messages_per_minute_per_bot,
      merged.threads_per_hour_per_bot,
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

  cleanupOldRateLimitEvents(): void {
    const cutoff = Date.now() - 3600000; // 1 hour
    this.db.prepare('DELETE FROM rate_limit_events WHERE created_at < ?').run(cutoff);
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

  cleanupOldAuditLog(maxAgeDays: number): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
  }

  // ─── TTL / Lifecycle Cleanup Operations ────────────────────

  cleanupExpiredMessages(orgId: string, ttlDays: number): number {
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let total = 0;

    // Delete channel messages older than TTL
    const r1 = this.db.prepare(`
      DELETE FROM messages WHERE channel_id IN (
        SELECT id FROM channels WHERE org_id = ?
      ) AND created_at < ?
    `).run(orgId, cutoff);
    total += r1.changes;

    // Delete thread messages older than TTL (only in resolved/closed threads to preserve active context)
    const r2 = this.db.prepare(`
      DELETE FROM thread_messages WHERE thread_id IN (
        SELECT id FROM threads WHERE org_id = ? AND status IN ('resolved', 'closed')
      ) AND created_at < ?
    `).run(orgId, cutoff);
    total += r2.changes;

    return total;
  }

  autoCloseInactiveThreads(orgId: string, days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const r = this.db.prepare(`
      UPDATE threads SET status = 'closed', close_reason = 'timeout', updated_at = ?, last_activity_at = ?, revision = revision + 1
      WHERE org_id = ? AND last_activity_at < ? AND status NOT IN ('resolved', 'closed')
    `).run(now, now, orgId, cutoff);
    return r.changes;
  }

  cleanupExpiredArtifacts(orgId: string, days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const r = this.db.prepare(`
      DELETE FROM artifacts WHERE thread_id IN (
        SELECT id FROM threads WHERE org_id = ? AND status IN ('resolved', 'closed')
      ) AND created_at < ?
    `).run(orgId, cutoff);
    return r.changes;
  }

  runLifecycleCleanup(): void {
    const orgs = this.listOrgs();
    for (const org of orgs) {
      const settings = this.getOrgSettings(org.id);
      const detail: Record<string, number> = {};

      if (settings.message_ttl_days !== null && settings.message_ttl_days > 0) {
        const n = this.cleanupExpiredMessages(org.id, settings.message_ttl_days);
        if (n > 0) detail.messages_deleted = n;
      }

      if (settings.thread_auto_close_days !== null && settings.thread_auto_close_days > 0) {
        const n = this.autoCloseInactiveThreads(org.id, settings.thread_auto_close_days);
        if (n > 0) detail.threads_closed = n;
      }

      if (settings.artifact_retention_days !== null && settings.artifact_retention_days > 0) {
        const n = this.cleanupExpiredArtifacts(org.id, settings.artifact_retention_days);
        if (n > 0) detail.artifacts_deleted = n;
      }

      if (Object.keys(detail).length > 0) {
        this.recordAudit(org.id, null, 'lifecycle.cleanup', 'org', org.id, detail);
      }
    }

    // Global cleanups
    this.cleanupOldCatchupEvents(30);
    this.cleanupOldAuditLog(90);
    this.cleanupOldRateLimitEvents();
    this.cleanupExpiredTokens();
  }

  close() {
    this.db.close();
  }
}
