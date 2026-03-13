/**
 * One-time migration: move files from flat layout to hierarchical org/shard layout.
 *
 * Old: files/{uuid}.{ext}
 * New: files/{org_id}/{shard}/{uuid}.{ext}
 *
 * Usage: npx tsx scripts/migrate-file-paths.ts [--dry-run] [--data-dir ./data]
 *
 * Idempotent: skips records already in new format or where disk file is already at target.
 */

import fs from 'fs';
import path from 'path';

// ── Argument parsing ─────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dataDirIdx = args.indexOf('--data-dir');
const dataDir = dataDirIdx !== -1 && args[dataDirIdx + 1] ? args[dataDirIdx + 1] : './data';

// ── DB setup (lightweight — direct SQLite, no full app boot) ─────────
// Use better-sqlite3 for sync queries (simpler for a migration script)
let Database: any;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.error('Error: better-sqlite3 not found. Run: npm install');
  process.exit(1);
}

const dbPath = path.join(dataDir, 'hxa-connect.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}. Use --data-dir to specify the data directory.`);
  process.exit(1);
}

const db = new Database(dbPath);

// ── Detect old-format records ────────────────────────────
// Old format: files/{uuid}.{ext} (no org_id subdirectory)
// Intermediate format (if upgrading from first version): files/{org_id}/{shard}/{uuid}.{ext}
// New format: files/{org_id}/{uploader_id}/{shard}/{uuid}.{ext}
const OLD_PATH_RE = /^files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/;

// Defense-in-depth: reject IDs containing path separators or traversal sequences
function safeId(id: string): boolean {
  return !!id && !id.includes('/') && !id.includes('\\') && !id.includes('..') && !id.includes('\0');
}

interface FileRow {
  id: string;
  org_id: string;
  uploader_id: string | null;
  path: string;
}

const rows: FileRow[] = db.prepare('SELECT id, org_id, uploader_id, path FROM files').all();
console.log(`Found ${rows.length} file records total.`);

let migrated = 0;
let skipped = 0;
let missing = 0;
let errors = 0;

for (const row of rows) {
  // Skip records already in new format
  if (!OLD_PATH_RE.test(row.path)) {
    skipped++;
    continue;
  }

  // Validate IDs for path safety
  if (!safeId(row.org_id)) {
    console.error(`  SKIP: ${row.id} — unsafe org_id: ${row.org_id}`);
    errors++;
    continue;
  }
  const uploaderId = row.uploader_id && safeId(row.uploader_id) ? row.uploader_id : '_deleted';

  const filename = path.basename(row.path);
  const shard = filename.substring(0, 2);
  const newRelativePath = `files/${row.org_id}/${uploaderId}/${shard}/${filename}`;

  const oldDiskPath = path.join(dataDir, row.path);
  const newDiskPath = path.join(dataDir, newRelativePath);

  // Check if file already exists at new location (previous partial migration)
  if (fs.existsSync(newDiskPath)) {
    // File already moved, just update DB
    if (!dryRun) {
      db.prepare('UPDATE files SET path = ? WHERE id = ?').run(newRelativePath, row.id);
      // Clean up old location if it still exists
      try { if (fs.existsSync(oldDiskPath)) fs.unlinkSync(oldDiskPath); } catch { /* ignore */ }
    }
    migrated++;
    continue;
  }

  // Check if source file exists
  if (!fs.existsSync(oldDiskPath)) {
    console.warn(`  MISSING: ${row.id} — ${oldDiskPath} not found on disk`);
    missing++;
    continue;
  }

  if (dryRun) {
    console.log(`  DRY-RUN: ${row.path} → ${newRelativePath}`);
    migrated++;
    continue;
  }

  try {
    // Create target directory
    const targetDir = path.dirname(newDiskPath);
    fs.mkdirSync(targetDir, { recursive: true });

    // Move file
    try {
      fs.renameSync(oldDiskPath, newDiskPath);
    } catch {
      // Cross-filesystem fallback
      fs.copyFileSync(oldDiskPath, newDiskPath);
      fs.unlinkSync(oldDiskPath);
    }

    // Update DB record
    db.prepare('UPDATE files SET path = ? WHERE id = ?').run(newRelativePath, row.id);
    migrated++;
  } catch (err: any) {
    console.error(`  ERROR: ${row.id} — ${err.message}`);
    errors++;
  }
}

db.close();

console.log('');
console.log(`Migration ${dryRun ? '(DRY RUN) ' : ''}complete:`);
console.log(`  Migrated: ${migrated}`);
console.log(`  Skipped (already new format): ${skipped}`);
console.log(`  Missing on disk: ${missing}`);
if (errors > 0) console.log(`  Errors: ${errors}`);
