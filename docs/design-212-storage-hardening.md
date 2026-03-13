# Design: Media Storage Hardening (#212)

## Issue Summary

Issue #212 requests three changes:
- **A) Authenticated internal media retrieval** — media not publicly downloadable
- **B) Hierarchical filesystem isolation** — org/uploader/shard directory layout
- **C) Migration & backward compatibility** — migrate flat `files/` to new layout

## Current State Analysis

### A) Auth Status: ALREADY IMPLEMENTED

`GET /api/files/:id` (routes.ts:3521) already enforces:
- `requireScope('read')` — requires valid Bearer token with `read` or `full` scope
- `requireOrgOrBot()` — must be authenticated bot or org session
- `record.org_id !== orgId` check — cross-org access returns 403
- No anonymous access path exists

**Verdict: No code changes needed for Part A.**

### B) Current Storage Layout: FLAT (Gap Exists)

```
data/
└── files/
    ├── a1b2c3d4-...-.jpg    (org-alpha)
    ├── e5f6g7h8-...-.png    (org-beta)
    └── i9j0k1l2-...-.pdf    (org-alpha)
```

All orgs share one flat directory. DB column `org_id` provides logical isolation, but filesystem has none.

### C) Migration: NEEDED

Existing `files/{uuid}.ext` paths stored in DB `files.path` column must remain valid, or be migrated to new paths.

## Design

### New Storage Layout

```
data/files/<org_id>/<uploader_id>/<shard>/<uuid>.<ext>
```

Where `<shard>` = first 2 characters of the file UUID. This provides:
- **Level 1**: org isolation (`<org_id>/`)
- **Level 2**: shard to avoid hot directories (`<shard>/` = 256 possible subdirs from hex chars)

Per issue requirement, includes `<uploader_id>` level for per-bot partitioning within org.
When a bot is deleted (`ON DELETE SET NULL`), existing file paths in DB remain valid.
Migration uses `_deleted` placeholder for null uploader_id.

### Path Format

Old: `files/{uuid}.{ext}`
New: `files/{org_id}/{uploader_id}/{shard}/{uuid}.{ext}`

Example: `files/org_abc123/bot_xyz789/a1/a1b2c3d4-5678-9abc-def0-123456789abc.jpg`

### Changes Required

#### 1. Upload Path (routes.ts)

**Current** (line 3367):
```js
destination: (_req, _file, cb) => cb(null, filesDir),
```

**New**: Dynamic destination based on org_id from auth context. Since multer's `destination` callback doesn't have access to `req.bot` (it runs before route handler), we need to:
- Use multer's `memoryStorage` or a temp directory
- Move file to final hierarchical path after auth + quota check

OR: Use a two-phase approach:
1. Multer writes to temp dir (unchanged flat `files/` or OS temp)
2. After auth + quota + DB insert, rename to hierarchical path

We'll use the rename approach since it's simpler and avoids loading files into memory.

**Implementation**:
- Multer writes to `data/files/_tmp/` (temp staging area)
- After auth + validation + quota check passes:
  - Sanitize org_id: reject if it contains `/`, `\`, `..`, or null bytes (defense in depth — org_id is a UUID from DB, but validate anyway)
  - Extract shard from filename: `filename.substring(0, 2)`
  - Compute target dir: `files/{org_id}/{shard}/`
  - Create dir with `mkdirSync(recursive: true)`
  - Rename file from temp to target (fallback to copy+delete for cross-filesystem)
- DB stores new relative path: `files/{org_id}/{shard}/{uuid}.{ext}`

Note: `req.bot` IS available when multer runs (requireBot middleware runs first), so dynamic destination is technically possible. We use temp staging anyway because it keeps the org hierarchy clean — only validated+quota-checked files land in org directories.

#### 2. Download Path (routes.ts)

**Current** (line 3536):
```js
const diskPath = path.resolve(config.data_dir, record.path);
```

**No change needed** — it already resolves from `record.path` (which will now be `files/{org_id}/{shard}/{uuid}.ext`). The path traversal guard on line 3538 still works.

#### 3. DB Changes

**No schema changes needed** — `path` column already stores the relative path string. Old records keep `files/{uuid}.ext`, new records get `files/{org_id}/{shard}/{uuid}.ext`.

#### 4. Startup Directory Creation (index.ts)

**Current** (line 121-122):
```js
const filesDir = path.join(config.data_dir, 'files');
fs.mkdirSync(filesDir, { recursive: true });
```

**Add**: Create `_tmp` staging directory:
```js
fs.mkdirSync(path.join(filesDir, '_tmp'), { recursive: true });
```

Org/shard subdirectories are created on-demand during upload.

#### 5. Migration Command

Add a one-time migration utility that:
1. Reads all file records from DB
2. For each record with old-format path (`files/{uuid}.ext`):
   - Compute new path: `files/{org_id}/{shard}/{uuid}.ext`
   - Create target directory
   - Move file on disk (rename, fallback to copy+delete)
   - Update DB `path` column
3. Each file migrated individually (not batched transaction — rename is filesystem, can't rollback)
4. Order: move file first, then update DB. If crash between: old DB path is stale but file exists at new location — migration re-run fixes it. Reverse order (DB first, then move) would leave DB pointing to non-existent path.
5. Idempotent: skip records already in new format; skip if file already at new path
6. Report summary: migrated/skipped/missing counts

This will be a CLI script: `npx tsx scripts/migrate-file-paths.ts`

#### 6. Temp File Cleanup

Add cleanup for orphaned temp files (e.g., upload started but server crashed before rename):
- On startup, delete files in `_tmp/` older than 1 hour
- During lifecycle cleanup (every 6h), sweep `_tmp/`

### Files to Modify

| File | Change |
|------|--------|
| `src/routes.ts` | Upload destination → temp; post-upload rename to hierarchical path |
| `src/index.ts` | Create `_tmp/` dir on startup; add temp cleanup |
| `scripts/migrate-file-paths.ts` | NEW: migration script |
| `test/file-storage.test.ts` | NEW: tests for hierarchical storage + migration |

### What Does NOT Change

- Download endpoint logic (reads `record.path` from DB — transparent)
- File info endpoint
- Auth/scope enforcement (already correct)
- DB schema (path column is a string, format-agnostic)
- API response format (`url: /api/files/${id}` — ID-based, path-independent)
- Quota logic

### Edge Cases

1. **Concurrent uploads for same org**: `mkdirSync(recursive: true)` is safe for concurrent calls
2. **Rename across filesystems**: `fs.renameSync` fails if temp and target are on different mounts. Use `copyFileSync` + `unlinkSync` as fallback.
3. **Old files after migration**: If migration is not run, old `files/{uuid}.ext` paths still work (download resolves from DB path)
4. **Disk full during rename**: Rename is atomic on same filesystem; copy+delete can fail mid-way. The temp file remains and can be retried.

### Test Plan

1. **Upload creates hierarchical path**: Upload file → verify disk path is `files/{org_id}/{shard}/{uuid}.ext`
2. **Download works with new path**: Upload → download → verify content matches
3. **Old-format paths still download**: Manually create old-format record → download works
4. **Cross-org isolation on disk**: Upload from org-A and org-B → verify different directories
5. **Migration script**: Create old-format files → run migration → verify new paths + files accessible
6. **Temp cleanup**: Create stale temp file → trigger cleanup → verify deleted
7. **Shard distribution**: Upload multiple files → verify shard dirs spread across `00`-`ff`
