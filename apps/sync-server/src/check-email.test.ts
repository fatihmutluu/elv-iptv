import { describe, expect, it } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'jwt-test-'.repeat(5);

const VALID_REGISTER_BODY = {
  email: 'Alice@Example.com',
  authVerifier: 'verifier_base64url_string_0123456789abcdef',
  kdfSalt: 'salt_base64url_0123456789',
  kdfIterations: 210_000,
  wrappedVaultKey: 'wrapped_vault_key_ciphertext_0123456789',
  recoveryWrappedVaultKey: 'recovery_wrapped_key_ciphertext_0123456789',
};

function makeApp(overrides: Partial<SyncAppConfig> = {}) {
  let currentMs = Date.parse('2026-11-27T08:00:00.000Z');
  const storage = overrides.storage ?? createMemoryStorage();
  const app = createSyncApp({
    storage,
    jwtSecret: TEST_JWT_SECRET,
    verifierHashIterations: 1_000,
    now: () => currentMs,
    ...overrides,
  });
  return {
    app,
    storage,
    advanceMs(delta: number) {
      currentMs += delta;
    },
  };
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://sync.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /v1/auth/check-email (#513)', () => {
  it('returns exists: false for unregistered email and exists: true after normalized registration', async () => {
    const { app } = makeApp();

    const before = await app.fetch(
      postJson('/v1/auth/check-email', { email: 'alice@example.com' }),
    );
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ exists: false });

    const reg = await app.fetch(postJson('/v1/auth/register', VALID_REGISTER_BODY));
    expect(reg.status).toBe(201);

    const after = await app.fetch(
      postJson('/v1/auth/check-email', { email: '  ALICE@EXAMPLE.COM  ' }),
    );
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ exists: true });

    const other = await app.fetch(postJson('/v1/auth/check-email', { email: 'bob@example.com' }));
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ exists: false });
  });

  it('rejects invalid JSON or invalid emails with 400 and never throws 500 on storage errors', async () => {
    const { app } = makeApp();

    const badJson = await app.fetch(postJson('/v1/auth/check-email', '{not-json'));
    expect(badJson.status).toBe(400);

    const missingEmail = await app.fetch(postJson('/v1/auth/check-email', {}));
    expect(missingEmail.status).toBe(400);
    expect(await missingEmail.json()).toEqual({ error: 'invalid_email' });

    const malformed = await app.fetch(postJson('/v1/auth/check-email', { email: 'not-an-email' }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_email' });

    const failingStorage = createMemoryStorage();
    const brokenStorage = {
      ...failingStorage,
      async findUserByEmail() {
        throw new Error('d1 transient outage');
      },
    };
    const { app: failingApp } = makeApp({ storage: brokenStorage });
    const unavailable = await failingApp.fetch(
      postJson('/v1/auth/check-email', { email: 'alice@example.com' }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'service_unavailable' });
  });

  it('enforces strict per-IP rate limiting (429 + Retry-After) with default 20 req / 60s window', async () => {
    const { app, advanceMs } = makeApp({ trustProxy: 'cloudflare' });
    const ip1 = { 'cf-connecting-ip': '203.0.113.42' };
    const ip2 = { 'cf-connecting-ip': '198.51.100.99' };

    for (let i = 0; i < 20; i += 1) {
      const res = await app.fetch(
        postJson('/v1/auth/check-email', { email: `user${i}@example.com` }, ip1),
      );
      expect(res.status).toBe(200);
    }

    const throttled = await app.fetch(
      postJson('/v1/auth/check-email', { email: 'user20@example.com' }, ip1),
    );
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Different IP is unaffected
    const otherIp = await app.fetch(
      postJson('/v1/auth/check-email', { email: 'user20@example.com' }, ip2),
    );
    expect(otherIp.status).toBe(200);

    // Window expiry restores access
    advanceMs(61_000);
    const recovered = await app.fetch(
      postJson('/v1/auth/check-email', { email: 'user20@example.com' }, ip1),
    );
    expect(recovered.status).toBe(200);
  });
});
