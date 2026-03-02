import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubDB } from './db.js';
import { SqliteDriver, PostgresDriver } from './db/index.js';
import { HubWS } from './ws.js';
import { WebhookManager } from './webhook.js';
import { createRouter } from './routes.js';
import { createWebUIRouter } from './web-ui.js';
import { DEFAULT_CONFIG, type HubConfig } from './types.js';
import { logger, generateRequestId } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config from environment ─────────────────────────────────

function loadCorsOrigins(): string | string[] {
  const envOrigins = process.env.HXA_CONNECT_CORS_ORIGINS || process.env.HXA_CONNECT_CORS;
  if (envOrigins) {
    const origins = envOrigins.split(',').map(o => o.trim()).filter(Boolean);
    // cors library treats '*' as a literal string in arrays, not a wildcard.
    // When user sets HXA_CONNECT_CORS_ORIGINS=*, pass '*' as a string so cors
    // treats it as "allow all origins".
    if (origins.length === 1 && origins[0] === '*') {
      return '*';
    }
    return origins;
  }
  // No explicit config: default-secure (deny cross-origin), dev mode allows all
  if (process.env.DEV_MODE === 'true') {
    return '*';
  }
  return []; // empty = deny all cross-origin requests
}

function loadConfig(): HubConfig {
  return {
    port: parseInt(process.env.HXA_CONNECT_PORT || '') || DEFAULT_CONFIG.port,
    host: process.env.HXA_CONNECT_HOST || DEFAULT_CONFIG.host,
    data_dir: process.env.HXA_CONNECT_DATA_DIR || DEFAULT_CONFIG.data_dir,
    default_persist: process.env.HXA_CONNECT_PERSIST !== 'false',
    cors_origins: loadCorsOrigins(),
    max_message_length: parseInt(process.env.HXA_CONNECT_MAX_MSG_LEN || '') || DEFAULT_CONFIG.max_message_length,
    log_level: (process.env.HXA_CONNECT_LOG_LEVEL as HubConfig['log_level']) || DEFAULT_CONFIG.log_level,
    admin_secret: process.env.HXA_CONNECT_ADMIN_SECRET || undefined,
    file_upload_mb_per_day: parseInt(process.env.HXA_CONNECT_FILE_UPLOAD_MB_PER_DAY || '') || DEFAULT_CONFIG.file_upload_mb_per_day,
    max_file_size_mb: parseInt(process.env.HXA_CONNECT_MAX_FILE_SIZE_MB || '') || DEFAULT_CONFIG.max_file_size_mb,
  };
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  // Default-secure: dev mode must be explicitly opted in
  const isDev = process.env.DEV_MODE === 'true';

  // S1: HXA_CONNECT_ADMIN_SECRET is required unless explicitly in dev mode
  if (!config.admin_secret && !isDev) {
    console.error('FATAL: HXA_CONNECT_ADMIN_SECRET is not set.');
    console.error('This is required unless DEV_MODE=true is explicitly set.');
    process.exit(1);
  }

  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = pkg.version || 'unknown';
  const versionTag = `v${version}`;
  const title = `HXA Connect ${versionTag}`;
  const subtitle = 'Bot-to-Bot Communication Hub';
  const width = Math.max(title.length, subtitle.length) + 8;
  const pad = (s: string) => {
    const left = Math.floor((width - s.length) / 2);
    const right = width - s.length - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  };
  const border = '═'.repeat(width + 2);
  console.log(`
  ╔${border}╗
  ║ ${pad(title)} ║
  ║ ${pad(subtitle)} ║
  ╚${border}╝
  `);

  // Initialize database — PostgreSQL if DATABASE_URL is set, otherwise SQLite
  const databaseUrl = process.env.HXA_CONNECT_DATABASE_URL || process.env.DATABASE_URL;
  const isPostgres = databaseUrl?.startsWith('postgres');
  const driver = isPostgres
    ? new PostgresDriver(databaseUrl!)
    : new SqliteDriver(path.join(config.data_dir, 'hxa-connect.db'));
  const db = new HubDB(driver);
  await db.init();
  console.log(`  Database: ${isPostgres ? 'PostgreSQL' : path.resolve(config.data_dir) + '/hxa-connect.db'}`);

  // Ensure files directory exists
  const filesDir = path.join(config.data_dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  console.log(`  Files:    ${path.resolve(filesDir)}`);

  // Create Express app
  const app = express();
  app.set('trust proxy', 1); // Trust first proxy (for req.secure behind TLS termination)
  app.use(cors({
    origin: Array.isArray(config.cors_origins)
      ? (config.cors_origins.length === 0 ? false : config.cors_origins)
      : config.cors_origins,
  }));
  app.use(express.json({ limit: '1mb' }));

  // Request ID correlation
  app.use((req, _res, next) => {
    req.requestId = (req.headers['x-request-id'] as string) || generateRequestId();
    next();
  });

  // Serve web UI (resolve to project root /web, not /src or /dist)
  const webDir = path.resolve(__dirname, '..', 'web');
  app.use(express.static(webDir));

  // API routes
  const server = createServer(app);
  const webhookManager = new WebhookManager(db);
  const hubWs = new HubWS(server, db, webhookManager, config);

  // O1: Health endpoint (no auth, before router so it's always accessible)
  app.get('/health', async (_req, res, next) => {
    try {
      const wsStats = hubWs.getHealthStats();
      const dbOk = await db.isHealthy();
      const status = dbOk ? 'ok' : 'degraded';
      res.status(dbOk ? 200 : 503).json({
        status,
        uptime_ms: wsStats.uptime_ms,
        connected_clients: wsStats.connected_clients,
        connected_bots: wsStats.connected_bots,
        db: dbOk ? 'ok' : 'error',
      });
    } catch (err) {
      next(err);
    }
  });

  // Web UI backend — session-authenticated proxy for human operators
  // Must be mounted before the main API router, which has catch-all auth middleware.
  app.use('/ui/api', createWebUIRouter(db, hubWs, config));

  app.use(createRouter(db, hubWs, config));

  // JSON 404 for unmatched API routes (must come before SPA catch-all)
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // Fallback: serve index.html for SPA routing (non-API paths only)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });

  // O4: Global error handler — must be 4-arity to be recognized by Express
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, requestId: req.requestId, method: req.method, path: req.path }, 'Unhandled error');

    // Never return HTML — always JSON
    const status = (err as any).status || (err as any).statusCode || 500;
    const response: { error: string; code: string; stack?: string } = {
      error: isDev ? err.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
    };
    if (isDev && err.stack) {
      response.stack = err.stack;
    }
    res.status(status).json(response);
  });

  // Start server
  server.listen(config.port, config.host, () => {
    console.log(`  HTTP:  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  WS:    ws://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/ws`);
    console.log(`  Web UI: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log('');
    console.log('  Ready to connect bots!');
    console.log('');
  });

  // Lifecycle cleanup: runs every 6 hours
  setInterval(() => {
    db.runLifecycleCleanup().catch(err => {
      logger.error({ err }, 'Lifecycle cleanup error');
    });
  }, 6 * 60 * 60 * 1000);

  // O7: Rate limit events cleanup: runs every 10 minutes (separate from lifecycle)
  setInterval(() => {
    db.cleanupOldRateLimitEvents().catch(err => {
      console.error('Rate limit cleanup error:', err);
    });
  }, 10 * 60 * 1000);

  // Run once on startup after a delay
  setTimeout(() => {
    db.runLifecycleCleanup().catch(err => {
      logger.error({ err }, 'Startup lifecycle cleanup error');
    });
  }, 30000);

  // O2: Graceful shutdown — drain WS, stop HTTP, close DB
  let shuttingDown = false;
  const shutdown = async (closeCode: number = 1001) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const isRestart = closeCode === 1012;
    console.log(`\n  ${isRestart ? 'Restarting' : 'Shutting down'} gracefully...`);

    // 1. Stop accepting new connections
    server.close();

    // 2. Drain WS connections (sends close frames, waits up to 5s)
    try {
      await hubWs.shutdown(closeCode);
      console.log('  WebSocket connections drained');
    } catch (err) {
      console.error('  WebSocket shutdown error:', err);
    }

    // 3. Close database
    await db.close();
    console.log('  Database closed');

    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown(1001));
  process.on('SIGTERM', () => void shutdown(1001));
  // SIGQUIT = graceful stop (e.g. pm2 restart). Send 1012 so clients reconnect immediately.
  if (process.platform !== 'win32') {
    process.on('SIGQUIT', () => void shutdown(1012));
  }
}

main();
