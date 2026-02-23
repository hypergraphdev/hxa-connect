import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubDB } from './db.js';
import { HubWS } from './ws.js';
import { WebhookManager } from './webhook.js';
import { createRouter } from './routes.js';
import { DEFAULT_CONFIG, type HubConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config from environment ─────────────────────────────────

function loadCorsOrigins(): string | string[] {
  const envOrigins = process.env.BOTSHUB_CORS_ORIGINS || process.env.BOTSHUB_CORS;
  if (envOrigins) {
    const origins = envOrigins.split(',').map(o => o.trim()).filter(Boolean);
    // cors library treats '*' as a literal string in arrays, not a wildcard.
    // When user sets BOTSHUB_CORS_ORIGINS=*, pass '*' as a string so cors
    // treats it as "allow all origins".
    if (origins.length === 1 && origins[0] === '*') {
      return '*';
    }
    return origins;
  }
  // No explicit config: development allows all, production denies by default
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    return []; // empty = deny all cross-origin requests
  }
  return '*';
}

function loadConfig(): HubConfig {
  return {
    port: parseInt(process.env.BOTSHUB_PORT || '') || DEFAULT_CONFIG.port,
    host: process.env.BOTSHUB_HOST || DEFAULT_CONFIG.host,
    data_dir: process.env.BOTSHUB_DATA_DIR || DEFAULT_CONFIG.data_dir,
    default_persist: process.env.BOTSHUB_PERSIST !== 'false',
    cors_origins: loadCorsOrigins(),
    max_message_length: parseInt(process.env.BOTSHUB_MAX_MSG_LEN || '') || DEFAULT_CONFIG.max_message_length,
    log_level: (process.env.BOTSHUB_LOG_LEVEL as HubConfig['log_level']) || DEFAULT_CONFIG.log_level,
    admin_secret: process.env.BOTSHUB_ADMIN_SECRET || undefined,
    file_upload_mb_per_day: parseInt(process.env.BOTSHUB_FILE_UPLOAD_MB_PER_DAY || '') || DEFAULT_CONFIG.file_upload_mb_per_day,
    max_file_size_mb: parseInt(process.env.BOTSHUB_MAX_FILE_SIZE_MB || '') || DEFAULT_CONFIG.max_file_size_mb,
  };
}

// ─── Main ────────────────────────────────────────────────────

function main() {
  const config = loadConfig();
  const isDev = process.env.NODE_ENV === 'development';

  // S1: BOTSHUB_ADMIN_SECRET is required in non-dev environments
  if (!config.admin_secret && !isDev) {
    console.error('FATAL: BOTSHUB_ADMIN_SECRET is not set.');
    console.error('This is required in non-development environments.');
    console.error('Set NODE_ENV=development to bypass this check.');
    process.exit(1);
  }

  console.log(`
  ╔═══════════════════════════════════════╗
  ║          🐾 BotsHub v0.1.0           ║
  ║   Agent-to-Agent Communication Hub   ║
  ╚═══════════════════════════════════════╝
  `);

  // Initialize database
  const db = new HubDB(config);
  console.log(`  📦 Database: ${path.resolve(config.data_dir)}/botshub.db`);

  // Ensure files directory exists
  const filesDir = path.join(config.data_dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  console.log(`  📁 Files:    ${path.resolve(filesDir)}`);

  // Create Express app
  const app = express();
  app.use(cors({
    origin: Array.isArray(config.cors_origins)
      ? (config.cors_origins.length === 0 ? false : config.cors_origins)
      : config.cors_origins,
  }));
  app.use(express.json({ limit: '1mb' }));

  // Serve web UI (resolve to project root /web, not /src or /dist)
  const webDir = path.resolve(__dirname, '..', 'web');
  app.use(express.static(webDir));

  // API routes
  const server = createServer(app);
  const webhookManager = new WebhookManager(db);
  const hubWs = new HubWS(server, db, webhookManager, config);
  app.use(createRouter(db, hubWs, config));

  // JSON 404 for unmatched API routes (must come before SPA catch-all)
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Fallback: serve index.html for SPA routing (non-API paths only)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });

  // Start server
  server.listen(config.port, config.host, () => {
    console.log(`  🌐 HTTP:  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  🔌 WS:    ws://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/ws`);
    console.log(`  📊 Web UI: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log('');
    console.log('  Ready to connect agents! 🚀');
    console.log('');
  });

  // Lifecycle cleanup: runs every 6 hours
  setInterval(() => {
    try {
      db.runLifecycleCleanup();
    } catch (err) {
      console.error('Lifecycle cleanup error:', err);
    }
  }, 6 * 60 * 60 * 1000);

  // Run once on startup after a delay
  setTimeout(() => {
    try { db.runLifecycleCleanup(); } catch (err) {
      console.error('Startup lifecycle cleanup error:', err);
    }
  }, 30000);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n  Shutting down...');
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
