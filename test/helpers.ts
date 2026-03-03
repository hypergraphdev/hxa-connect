/**
 * Integration test helpers — spins up a real Express+WS server per test suite
 * using a temporary data directory.
 */
import express from 'express';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubDB } from '../src/db.js';
import { SqliteDriver } from '../src/db/index.js';
import { HubWS } from '../src/ws.js';
import { WebhookManager } from '../src/webhook.js';
import { createRouter } from '../src/routes.js';

import { SqliteSessionStore } from '../src/session.js';
import { sessionMiddleware, csrfMiddleware } from '../src/session-middleware.js';
import type { HubConfig } from '../src/types.js';

export interface TestEnv {
  app: express.Express;
  server: Server;
  db: HubDB;
  ws: HubWS;
  config: HubConfig;
  baseUrl: string;
  dataDir: string;
  /** Create an org and return { id, org_secret } */
  createOrg(name?: string): Promise<{ id: string; org_secret: string }>;
  /** Register a bot in an org using org_secret directly. */
  registerBot(orgSecret: string, name: string, opts?: Record<string, unknown>): Promise<{ bot: any; token: string }>;
  /** Login as org_admin and get a session cookie value for use with the api() helper. */
  loginAsOrg(orgSecret: string): Promise<string>;
  /** Promote a bot to admin using org_secret (login as org, then PATCH role). */
  promoteBot(orgSecret: string, botId: string): Promise<void>;
  /** Cleanup — close server, remove temp dir */
  cleanup(): Promise<void>;
}

let counter = 0;

export async function createTestEnv(configOverrides?: Partial<HubConfig>): Promise<TestEnv> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-connect-test-'));
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const config: HubConfig = {
    port: 0, // random port
    host: '127.0.0.1',
    data_dir: dataDir,
    default_persist: true,
    cors_origins: '*',
    max_message_length: 65536,
    log_level: 'silent',
    admin_secret: undefined,
    file_upload_mb_per_day: 500,
    max_file_size_mb: 50,
    ...configOverrides,
  };

  const dbPath = path.join(dataDir, 'hxa-connect.db');
  const driver = new SqliteDriver(dbPath);
  const db = new HubDB(driver);
  await db.init();

  const sessionStore = new SqliteSessionStore(driver);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware(sessionStore));
  app.use(csrfMiddleware());

  const server = createServer(app);
  const webhookManager = new WebhookManager(db);
  const hubWs = new HubWS(server, db, webhookManager, config);
  hubWs.setSessionStore(sessionStore);

  // Health endpoint (mirrors index.ts)
  app.get('/health', async (_req, res) => {
    const wsStats = hubWs.getHealthStats();
    const dbOk = await db.isHealthy();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      uptime_ms: wsStats.uptime_ms,
      connected_clients: wsStats.connected_clients,
      connected_bots: wsStats.connected_bots,
      db: dbOk ? 'ok' : 'error',
    });
  });

  app.use(createRouter(db, hubWs, config, sessionStore));

  // JSON 404
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Map plaintext org_secret -> org_id for registerBot helper
  const secretToOrgId = new Map<string, string>();

  async function createOrg(name?: string) {
    const orgName = name || `test-org-${++counter}`;
    const org = await db.createOrg(orgName, config.default_persist);
    secretToOrgId.set(org.org_secret, org.id);
    return { id: org.id, org_secret: org.org_secret };
  }

  async function registerBot(orgSecret: string, botName: string, opts?: Record<string, unknown>) {
    const orgId = secretToOrgId.get(orgSecret);
    if (!orgId) throw new Error('Unknown org_secret — was this org created via createOrg()?');

    // Create a one-time ticket via DB for member registration
    const ticket = await db.createOrgTicket(orgId, 'test-hash', {
      expiresAt: Date.now() + 3600_000,
    });

    // Register via ticket → auth_role='member'
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, ticket: ticket.id, name: botName, ...opts }),
    });
    if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { bot: data, token: data.token };
  }

  async function loginAsOrg(orgSecret: string): Promise<string> {
    const orgId = secretToOrgId.get(orgSecret);
    if (!orgId) throw new Error('Unknown org_secret — was this org created via createOrg()?');

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'org_admin', org_id: orgId, org_secret: orgSecret }),
    });
    if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);

    // Extract session cookie from Set-Cookie header
    const setCookie = loginRes.headers.get('set-cookie') || '';
    const match = setCookie.match(/hxa_session=([^;]+)/);
    if (!match) throw new Error('No session cookie in login response');
    return match[1];
  }

  async function promoteBot(orgSecret: string, botId: string) {
    const sessionCookie = await loginAsOrg(orgSecret);
    const res = await fetch(`${baseUrl}/api/org/bots/${botId}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Cookie': `hxa_session=${sessionCookie}`, 'Origin': baseUrl },
      body: JSON.stringify({ auth_role: 'admin' }),
    });
    if (!res.ok) throw new Error(`Promote failed: ${res.status} ${await res.text()}`);
  }

  async function cleanup() {
    await hubWs.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, server, db, ws: hubWs, config, baseUrl, dataDir, createOrg, registerBot, loginAsOrg, promoteBot, cleanup };
}

/** Simple fetch helper that returns { status, headers, body } */
export async function api(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; headers: Headers; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts?.headers,
  };
  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }
  if (opts?.cookie) {
    headers['Cookie'] = `hxa_session=${opts.cookie}`;
    // Auto-include Origin for CSRF compliance on mutating requests
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['Origin']) {
      headers['Origin'] = baseUrl;
    }
  }

  const init: RequestInit = { method, headers };
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${baseUrl}${path}`, init);
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, headers: res.headers, body };
}
