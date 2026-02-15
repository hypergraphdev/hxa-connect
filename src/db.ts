import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Org, Agent, Channel, ChannelMember, Message, HubConfig } from './types.js';

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

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);
      CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(org_id);
      CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);
    `);

    // Migration: add admin_secret to existing orgs that don't have it
    try {
      this.db.exec(`ALTER TABLE orgs ADD COLUMN admin_secret TEXT`);
    } catch {
      // Column already exists
    }
    // Generate admin_secret for orgs that don't have one
    const orgsWithoutSecret = this.db.prepare('SELECT id FROM orgs WHERE admin_secret IS NULL').all() as any[];
    for (const org of orgsWithoutSecret) {
      const secret = crypto.randomBytes(24).toString('hex');
      this.db.prepare('UPDATE orgs SET admin_secret = ? WHERE id = ?').run(secret, org.id);
      console.log(`  🔐 Generated admin_secret for org ${org.id}`);
    }
  }

  // ─── Org Operations ──────────────────────────────────────

  createOrg(name: string, persistMessages = true): Org {
    const org: Org = {
      id: uuid(),
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
    return { ...row, persist_messages: !!row.persist_messages };
  }

  verifyOrgAdminSecret(orgId: string, secret: string): boolean {
    const row = this.db.prepare('SELECT admin_secret FROM orgs WHERE id = ?').get(orgId) as any;
    return row?.admin_secret === secret;
  }

  getOrgById(id: string): Org | undefined {
    const row = this.db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return { ...row, persist_messages: !!row.persist_messages };
  }

  listOrgs(): Org[] {
    return (this.db.prepare('SELECT * FROM orgs ORDER BY created_at').all() as any[]).map(r => ({
      ...r, persist_messages: !!r.persist_messages
    }));
  }

  // ─── Agent Operations ────────────────────────────────────

  registerAgent(orgId: string, name: string, displayName?: string, metadata?: Record<string, unknown>, webhookUrl?: string, webhookSecret?: string): Agent {
    // Check if agent already exists → return existing token
    const existing = this.db.prepare(
      'SELECT * FROM agents WHERE org_id = ? AND name = ?'
    ).get(orgId, name) as any;

    if (existing) {
      // Update last seen, set online, and optionally update webhook
      if (webhookUrl !== undefined || webhookSecret !== undefined) {
        this.db.prepare(
          'UPDATE agents SET online = 1, last_seen_at = ?, webhook_url = COALESCE(?, webhook_url), webhook_secret = COALESCE(?, webhook_secret) WHERE id = ?'
        ).run(Date.now(), webhookUrl ?? null, webhookSecret ?? null, existing.id);
      } else {
        this.db.prepare(
          'UPDATE agents SET online = 1, last_seen_at = ? WHERE id = ?'
        ).run(Date.now(), existing.id);
      }
      return { ...existing, online: true, last_seen_at: Date.now(), webhook_url: webhookUrl ?? existing.webhook_url, webhook_secret: webhookSecret ?? existing.webhook_secret };
    }

    const agent: Agent = {
      id: uuid(),
      org_id: orgId,
      name,
      display_name: displayName || null,
      token: `agent_${crypto.randomBytes(24).toString('hex')}`,
      metadata: metadata ? JSON.stringify(metadata) : null,
      webhook_url: webhookUrl || null,
      webhook_secret: webhookSecret || null,
      online: true,
      last_seen_at: Date.now(),
      created_at: Date.now(),
    };

    this.db.prepare(
      `INSERT INTO agents (id, org_id, name, display_name, token, metadata, webhook_url, webhook_secret, online, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(agent.id, agent.org_id, agent.name, agent.display_name, agent.token,
          agent.metadata, agent.webhook_url, agent.webhook_secret, agent.online ? 1 : 0, agent.last_seen_at, agent.created_at);

    return agent;
  }

  getAgentByToken(token: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE token = ?').get(token) as any;
    if (!row) return undefined;
    return { ...row, online: !!row.online };
  }

  getAgentById(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return { ...row, online: !!row.online };
  }

  getAgentByName(orgId: string, name: string): Agent | undefined {
    const row = this.db.prepare(
      'SELECT * FROM agents WHERE org_id = ? AND name = ?'
    ).get(orgId, name) as any;
    if (!row) return undefined;
    return { ...row, online: !!row.online };
  }

  listAgents(orgId: string): Agent[] {
    return (this.db.prepare(
      'SELECT * FROM agents WHERE org_id = ? ORDER BY name'
    ).all(orgId) as any[]).map(r => ({ ...r, online: !!r.online }));
  }

  setAgentOnline(agentId: string, online: boolean) {
    this.db.prepare(
      'UPDATE agents SET online = ?, last_seen_at = ? WHERE id = ?'
    ).run(online ? 1 : 0, Date.now(), agentId);
  }

  deleteAgent(agentId: string) {
    this.db.prepare('DELETE FROM channel_members WHERE agent_id = ?').run(agentId);
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  }

  // ─── Channel Operations ──────────────────────────────────

  createChannel(orgId: string, type: 'direct' | 'group', memberIds: string[], name?: string): Channel & { isNew?: boolean } {
    // For direct channels, check if one already exists between these two agents
    if (type === 'direct' && memberIds.length === 2) {
      const existing = this.findDirectChannel(memberIds[0], memberIds[1]);
      if (existing) return { ...existing, isNew: false };
    }

    const channel: Channel = {
      id: uuid(),
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

  createMessage(channelId: string, senderId: string, content: string, contentType = 'text'): Message {
    const msg: Message = {
      id: uuid(),
      channel_id: channelId,
      sender_id: senderId,
      content,
      content_type: contentType as Message['content_type'],
      created_at: Date.now(),
    };

    this.db.prepare(
      `INSERT INTO messages (id, channel_id, sender_id, content, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(msg.id, msg.channel_id, msg.sender_id, msg.content, msg.content_type, msg.created_at);

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

  close() {
    this.db.close();
  }
}
