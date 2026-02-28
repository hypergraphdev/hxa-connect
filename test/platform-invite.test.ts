import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnv, api, type TestEnv } from './helpers.js';

// ═══════════════════════════════════════════════════════════════
// Self-Service Org Creation via Platform Invite Codes
// Task 3: POST /api/platform/invite-codes, GET, DELETE,
//         POST /api/platform/orgs
// ═══════════════════════════════════════════════════════════════

const ADMIN_SECRET = 'test-admin-secret';

describe('Platform Invite Codes — Admin CRUD', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: ADMIN_SECRET });
  });

  afterAll(() => env.cleanup());

  it('POST /api/platform/invite-codes creates a code (default: unlimited uses, 90d expiry)', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { label: 'general' },
    });
    expect(status).toBe(201);
    expect(body.id).toBeTypeOf('string');
    expect(body.code).toBeTypeOf('string');
    expect(body.code.length).toBe(48); // 24 random bytes hex
    expect(body.label).toBe('general');
    expect(body.max_uses).toBe(0);
    expect(body.use_count).toBe(0);
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  it('POST /api/platform/invite-codes with max_uses creates a limited code', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { label: 'limited', max_uses: 5, expires_in: 3600 },
    });
    expect(status).toBe(201);
    expect(body.max_uses).toBe(5);
    expect(body.use_count).toBe(0);
    // Expires in ~1 hour
    expect(body.expires_at).toBeGreaterThan(Date.now());
    expect(body.expires_at).toBeLessThan(Date.now() + 3700_000);
  });

  it('POST /api/platform/invite-codes rejects invalid max_uses', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { max_uses: -1 },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/platform/invite-codes requires admin auth', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      body: { label: 'no-auth' },
    });
    expect(status).toBe(401);
  });

  it('POST /api/platform/invite-codes rejects wrong admin secret', async () => {
    const { status } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: 'wrong-secret',
      body: { label: 'bad-auth' },
    });
    expect(status).toBe(401);
  });

  it('GET /api/platform/invite-codes lists all codes', async () => {
    const { status, body } = await api(env.baseUrl, 'GET', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2); // created in previous tests
    // Should include computed fields
    for (const code of body) {
      expect(code).toHaveProperty('expired');
      expect(code).toHaveProperty('exhausted');
      expect(code.expired).toBe(false);
      expect(code.exhausted).toBe(false);
      // Plaintext code should NOT be returned in listing
      expect(code).not.toHaveProperty('code');
      expect(code).not.toHaveProperty('code_hash');
    }
  });

  it('DELETE /api/platform/invite-codes/:id revokes a code', async () => {
    // Create a code to delete
    const { body: created } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { label: 'to-delete' },
    });

    const { status } = await api(env.baseUrl, 'DELETE', `/api/platform/invite-codes/${created.id}`, {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(204);

    // Verify it's gone from the list
    const { body: list } = await api(env.baseUrl, 'GET', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
    });
    const found = list.find((c: any) => c.id === created.id);
    expect(found).toBeUndefined();
  });

  it('DELETE /api/platform/invite-codes/:id returns 404 for unknown id', async () => {
    const { status, body } = await api(env.baseUrl, 'DELETE', '/api/platform/invite-codes/nonexistent', {
      token: ADMIN_SECRET,
    });
    expect(status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});

describe('Platform Orgs — Self-Service Creation', () => {
  let env: TestEnv;
  let inviteCode: string;
  let limitedCode: string;
  let limitedCodeId: string;

  beforeAll(async () => {
    env = await createTestEnv({ admin_secret: ADMIN_SECRET });

    // Create an unlimited invite code
    const { body: unlimited } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { label: 'unlimited' },
    });
    inviteCode = unlimited.code;

    // Create a limited invite code (max 2 uses)
    const { body: limited } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { label: 'limited-2', max_uses: 2 },
    });
    limitedCode = limited.code;
    limitedCodeId = limited.id;
  });

  afterAll(() => env.cleanup());

  it('POST /api/platform/orgs creates an org with valid invite code', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: inviteCode, name: 'my-new-org' },
    });
    expect(status).toBe(201);
    expect(body.org_id).toBeTypeOf('string');
    expect(body.name).toBe('my-new-org');
    expect(body.org_secret).toBeTypeOf('string');
    expect(body.org_secret.length).toBe(48); // 24 random bytes hex
  });

  it('created org is functional — can login and register a bot', async () => {
    // Create org via invite
    const { body: orgBody } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: inviteCode, name: 'functional-test-org' },
    });

    // Login with the returned org_secret
    const { status: loginStatus, body: loginBody } = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { org_id: orgBody.org_id, org_secret: orgBody.org_secret },
    });
    expect(loginStatus).toBe(200);
    expect(loginBody.ticket).toBeTypeOf('string');

    // Register a bot
    const { status: regStatus, body: regBody } = await api(env.baseUrl, 'POST', '/api/auth/register', {
      body: { org_id: orgBody.org_id, ticket: loginBody.ticket, name: 'test-bot' },
    });
    expect(regStatus).toBe(200);
    expect(regBody.bot_id).toBeTypeOf('string');
    expect(regBody.token).toBeTypeOf('string');
    expect(regBody.name).toBe('test-bot');
  });

  it('unlimited code can be used multiple times', async () => {
    for (let i = 0; i < 3; i++) {
      const { status } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
        body: { invite_code: inviteCode, name: `org-${i}` },
      });
      expect(status).toBe(201);
    }
  });

  it('limited code respects max_uses', async () => {
    // Use 1
    const { status: s1 } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: limitedCode, name: 'limited-org-1' },
    });
    expect(s1).toBe(201);

    // Use 2
    const { status: s2 } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: limitedCode, name: 'limited-org-2' },
    });
    expect(s2).toBe(201);

    // Use 3 — should fail (max_uses = 2)
    const { status: s3, body: b3 } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: limitedCode, name: 'limited-org-3' },
    });
    expect(s3).toBe(401);
    expect(b3.code).toBe('INVALID_INVITE_CODE');
  });

  it('exhausted code shows in listing as exhausted', async () => {
    const { body: list } = await api(env.baseUrl, 'GET', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
    });
    const found = list.find((c: any) => c.id === limitedCodeId);
    expect(found).toBeDefined();
    expect(found.exhausted).toBe(true);
    expect(found.use_count).toBe(2);
  });

  it('rejects invalid invite code', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: 'invalid-code', name: 'rejected-org' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_INVITE_CODE');
  });

  it('rejects missing invite_code', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { name: 'no-code-org' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing name', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: inviteCode },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects overly long name', async () => {
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: inviteCode, name: 'x'.repeat(129) },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('revoked invite code no longer works', async () => {
    // Create and then revoke a code
    const { body: created } = await api(env.baseUrl, 'POST', '/api/platform/invite-codes', {
      token: ADMIN_SECRET,
      body: { label: 'revoke-test' },
    });
    await api(env.baseUrl, 'DELETE', `/api/platform/invite-codes/${created.id}`, {
      token: ADMIN_SECRET,
    });

    // Try to use the revoked code
    const { status, body } = await api(env.baseUrl, 'POST', '/api/platform/orgs', {
      body: { invite_code: created.code, name: 'revoked-org' },
    });
    expect(status).toBe(401);
    expect(body.code).toBe('INVALID_INVITE_CODE');
  });
});
