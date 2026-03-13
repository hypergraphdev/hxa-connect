/**
 * Tests for hierarchical file storage (#212).
 * Verifies: org-isolated directory layout, shard distribution,
 * download compatibility with both old and new path formats,
 * and temp staging cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnv, type TestEnv } from './helpers.js';

// Helper: upload a file and return the JSON response
async function uploadFile(
  baseUrl: string,
  token: string,
  content: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ status: number; body: any }> {
  const formData = new FormData();
  const blob = new Blob([content], { type: mimeType });
  formData.append('file', blob, filename);

  const res = await fetch(`${baseUrl}/api/files/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });

  let body: any;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// Helper: download a file
async function downloadFile(
  baseUrl: string,
  token: string,
  fileId: string,
): Promise<{ status: number; data: Buffer | null; contentType: string | null }> {
  const res = await fetch(`${baseUrl}/api/files/${fileId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  return { status: res.status, data, contentType: res.headers.get('content-type') };
}

describe('Hierarchical file storage (#212)', () => {
  let env: TestEnv;
  let orgA: { id: string; org_secret: string };
  let orgB: { id: string; org_secret: string };
  let botA: { bot: any; token: string };
  let botB: { bot: any; token: string };

  // 1x1 red PNG pixel
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeAll(async () => {
    env = await createTestEnv();
    orgA = await env.createOrg('org-alpha');
    orgB = await env.createOrg('org-beta');
    botA = await env.registerBot(orgA.org_secret, 'bot-a');
    botB = await env.registerBot(orgB.org_secret, 'bot-b');
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('upload creates hierarchical path: files/<org_id>/<uploader_id>/<shard>/<uuid>.ext', async () => {
    const { status, body } = await uploadFile(env.baseUrl, botA.token, PNG_1x1, 'test.png', 'image/png');
    expect(status).toBe(200);
    expect(body.id).toBeTruthy();
    expect(body.url).toBe(`/api/files/${body.id}`);

    // Verify disk path is hierarchical with uploader_id
    const record = await env.db.getFile(body.id);
    expect(record).toBeTruthy();
    expect(record!.path).toMatch(new RegExp(`^files/${orgA.id}/.+/[0-9a-f]{2}/`));

    // Verify path segments: files/<org_id>/<uploader_id>/<shard>/<filename>
    const parts = record!.path.split('/');
    expect(parts).toHaveLength(5);
    const [, orgDir, uploaderDir, shard, filename] = parts;
    expect(orgDir).toBe(orgA.id);
    expect(uploaderDir).toBe(botA.bot.id);
    expect(shard).toBe(filename.substring(0, 2));

    // Verify file exists on disk
    const diskPath = path.join(env.dataDir, record!.path);
    expect(fs.existsSync(diskPath)).toBe(true);
  });

  it('download works with new hierarchical path', async () => {
    const upload = await uploadFile(env.baseUrl, botA.token, PNG_1x1, 'dl-test.png', 'image/png');
    expect(upload.status).toBe(200);

    const dl = await downloadFile(env.baseUrl, botA.token, upload.body.id);
    expect(dl.status).toBe(200);
    expect(dl.data).toBeTruthy();
    expect(dl.data!.equals(PNG_1x1)).toBe(true);
    expect(dl.contentType).toBe('image/png');
  });

  it('cross-org isolation: different orgs use different directories', async () => {
    const uploadA = await uploadFile(env.baseUrl, botA.token, PNG_1x1, 'org-a.png', 'image/png');
    const uploadB = await uploadFile(env.baseUrl, botB.token, PNG_1x1, 'org-b.png', 'image/png');
    expect(uploadA.status).toBe(200);
    expect(uploadB.status).toBe(200);

    const recordA = await env.db.getFile(uploadA.body.id);
    const recordB = await env.db.getFile(uploadB.body.id);
    expect(recordA).toBeTruthy();
    expect(recordB).toBeTruthy();

    // Paths should contain different org_ids
    expect(recordA!.path).toContain(`/${orgA.id}/`);
    expect(recordB!.path).toContain(`/${orgB.id}/`);

    // Cross-org download must fail
    const crossDl = await downloadFile(env.baseUrl, botA.token, uploadB.body.id);
    expect(crossDl.status).toBe(403);
  });

  it('cross-org download returns 403', async () => {
    const upload = await uploadFile(env.baseUrl, botB.token, PNG_1x1, 'secret.png', 'image/png');
    expect(upload.status).toBe(200);

    const dl = await downloadFile(env.baseUrl, botA.token, upload.body.id);
    expect(dl.status).toBe(403);
  });

  it('anonymous download returns 401', async () => {
    const upload = await uploadFile(env.baseUrl, botA.token, PNG_1x1, 'anon-test.png', 'image/png');
    expect(upload.status).toBe(200);

    const res = await fetch(`${env.baseUrl}/api/files/${upload.body.id}`);
    expect(res.status).toBe(401);
  });

  it('old-format path records still downloadable (backward compat)', async () => {
    // Simulate an old-format file record by creating the file directly in flat layout
    const filename = `${crypto.randomUUID()}.png`;
    const oldRelativePath = `files/${filename}`;
    const oldDiskPath = path.join(env.dataDir, oldRelativePath);

    // Write file to old flat location
    fs.writeFileSync(oldDiskPath, PNG_1x1);

    // Insert DB record with old path format (createFile generates its own id)
    const record = await env.db.createFile(orgA.id, botA.bot.id, 'legacy.png', 'image/png', PNG_1x1.length, oldRelativePath);

    // Download using the DB-generated id should work
    const dl = await downloadFile(env.baseUrl, botA.token, record.id);
    expect(dl.status).toBe(200);
    expect(dl.data).toBeTruthy();
    expect(dl.data!.equals(PNG_1x1)).toBe(true);
  });

  it('temp staging directory exists and is clean after upload', async () => {
    const tmpDir = path.join(env.dataDir, 'files', '_tmp');
    expect(fs.existsSync(tmpDir)).toBe(true);

    // After successful upload, no files should remain in _tmp
    await uploadFile(env.baseUrl, botA.token, PNG_1x1, 'tmp-test.png', 'image/png');
    const tmpFiles = fs.readdirSync(tmpDir);
    expect(tmpFiles).toHaveLength(0);
  });

  it('move failure: no DB record left, quota unchanged', async () => {
    // Use a fresh org with no pre-existing subdirectories so chmod on files/ blocks mkdir
    const orgC = await env.createOrg('org-failtest');
    const botC = await env.registerBot(orgC.org_secret, 'bot-c');

    // Record quota before attempt
    const quotaBefore = await (env.db as any).getDailyUploadBytes(orgC.id);

    // Make the files directory read-only to force move failure.
    // orgC has no subdirectory yet, so mkdirSync(files/<orgC.id>/...) will fail.
    const filesDir = path.join(env.dataDir, 'files');
    fs.chmodSync(filesDir, 0o555);
    let result: { status: number; body: any };
    try {
      result = await uploadFile(env.baseUrl, botC.token, PNG_1x1, 'fail-test.png', 'image/png');
    } finally {
      fs.chmodSync(filesDir, 0o755); // always restore
    }

    expect(result!.status).toBe(500);
    expect(result!.body.code).toBe('STORAGE_ERROR');

    // Compensating cleanup: no DB record should remain
    const quotaAfter = await (env.db as any).getDailyUploadBytes(orgC.id);
    expect(quotaAfter).toBe(quotaBefore);

    // _tmp should also be clean (temp file deleted)
    const tmpFiles = fs.readdirSync(path.join(env.dataDir, 'files', '_tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('file info endpoint works with new path format', async () => {
    const upload = await uploadFile(env.baseUrl, botA.token, PNG_1x1, 'info-test.png', 'image/png');
    expect(upload.status).toBe(200);

    const res = await fetch(`${env.baseUrl}/api/files/${upload.body.id}/info`, {
      headers: { 'Authorization': `Bearer ${botA.token}` },
    });
    expect(res.status).toBe(200);
    const info = await res.json() as any;
    expect(info.id).toBe(upload.body.id);
    expect(info.name).toBe('info-test.png');
    expect(info.mime_type).toBe('image/png');
    expect(info.url).toBe(`/api/files/${upload.body.id}`);
  });
});
