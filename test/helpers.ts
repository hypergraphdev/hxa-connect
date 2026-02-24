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
import { HubWS } from '../src/ws.js';
import { WebhookManager } from '../src/webhook.js';
import { createRouter } from '../src/routes.js';
import type { HubConfig } from '../src/types.js';

export interface TestEnv {
  app: express.Express;
  server: Server;
  db: HubDB;
  ws: HubWS;
  config: HubConfig;
  baseUrl: string;
  dataDir: string;
  /** Create an org and return { orgId, apiKey } */
  createOrg(name?: string): { id: string; api_key: string };
  /** Register an agent in an org and return { agent, token } */
  registerAgent(apiKey: string, name: string, opts?: Record<string, unknown>): Promise<{ agent: any; token: string }>;
  /** Cleanup — close server, remove temp dir */
  cleanup(): Promise<void>;
}

let counter = 0;

export async function createTestEnv(configOverrides?: Partial<HubConfig>): Promise<TestEnv> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botshub-test-'));
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

  const db = new HubDB(config);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const server = createServer(app);
  const webhookManager = new WebhookManager(db);
  const hubWs = new HubWS(server, db, webhookManager, config);

  // Health endpoint (mirrors index.ts)
  app.get('/health', (_req, res) => {
    const wsStats = hubWs.getHealthStats();
    const dbOk = db.isHealthy();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      uptime_ms: wsStats.uptime_ms,
      connected_clients: wsStats.connected_clients,
      connected_agents: wsStats.connected_agents,
      db: dbOk ? 'ok' : 'error',
    });
  });

  app.use(createRouter(db, hubWs, config));

  // JSON 404
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  function createOrg(name?: string) {
    const orgName = name || `test-org-${++counter}`;
    const org = db.createOrg(orgName, config.default_persist);
    return { id: org.id, api_key: org.api_key };
  }

  async function registerAgent(apiKey: string, agentName: string, opts?: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ name: agentName, ...opts }),
    });
    if (!res.ok) throw new Error(`Register failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { agent: data, token: data.token };
  }

  async function cleanup() {
    await hubWs.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, server, db, ws: hubWs, config, baseUrl, dataDir, createOrg, registerAgent, cleanup };
}

/** Simple fetch helper that returns { status, headers, body } */
export async function api(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; headers: Headers; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts?.headers,
  };
  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
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
