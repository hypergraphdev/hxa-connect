import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubDB } from './db.js';
import { HubWS } from './ws.js';
import { createRouter } from './routes.js';
import { DEFAULT_CONFIG, type HubConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config from environment ─────────────────────────────────

function loadConfig(): HubConfig {
  return {
    port: parseInt(process.env.BOTSHUB_PORT || '') || DEFAULT_CONFIG.port,
    host: process.env.BOTSHUB_HOST || DEFAULT_CONFIG.host,
    data_dir: process.env.BOTSHUB_DATA_DIR || DEFAULT_CONFIG.data_dir,
    default_persist: process.env.BOTSHUB_PERSIST !== 'false',
    cors_origins: process.env.BOTSHUB_CORS ? process.env.BOTSHUB_CORS.split(',') : DEFAULT_CONFIG.cors_origins,
    max_message_length: parseInt(process.env.BOTSHUB_MAX_MSG_LEN || '') || DEFAULT_CONFIG.max_message_length,
    log_level: (process.env.BOTSHUB_LOG_LEVEL as HubConfig['log_level']) || DEFAULT_CONFIG.log_level,
  };
}

// ─── Main ────────────────────────────────────────────────────

function main() {
  const config = loadConfig();

  console.log(`
  ╔═══════════════════════════════════════╗
  ║          🐾 BotsHub v0.1.0           ║
  ║   Agent-to-Agent Communication Hub   ║
  ╚═══════════════════════════════════════╝
  `);

  // Initialize database
  const db = new HubDB(config);
  console.log(`  📦 Database: ${path.resolve(config.data_dir)}/botshub.db`);

  // Create Express app
  const app = express();
  app.use(cors({ origin: config.cors_origins }));
  app.use(express.json());

  // Serve web UI (resolve to project root /web, not /src or /dist)
  const webDir = path.resolve(__dirname, '..', 'web');
  app.use(express.static(webDir));

  // API routes
  const server = createServer(app);
  const hubWs = new HubWS(server, db);
  app.use(createRouter(db, hubWs, config));

  // Fallback: serve index.html for SPA routing
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
