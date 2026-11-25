import { describe, expect, it } from 'vitest';
import { createSyncAuthClient, validateSignupInput } from './auth-client';
import type { SyncHttpPort, SyncHttpRequest, SyncHttpResponse } from './ports';
import { createPureJsVaultCryptoPort } from './pure-crypto';
import { createEmptyVaultSnapshot, type VaultSnapshot } from './vault-merge';

const TEST_ITERATIONS = 1_000;

function seededRandom(seed = 11): (len: number) => Uint8Array {
  let state = seed >>> 0;
  return (len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

describe('auth-client zero-knowledge flow', () => {
  it('validates signup email, password strength, and confirmation', () => {
    expect(validateSignupInput('bad-email', 'longpassword123', 'longpassword123')).toEqual({
      ok: false,
      error: 'invalid_email',
    });
    expect(validateSignupInput('user@example.com', 'short', 'short')).toEqual({
      ok: false,
      error: 'weak_password',
    });
    expect(validateSignupInput('user@example.com', 'longpassword123', 'otherpassword12')).toEqual({
      ok: false,
      error: 'password_mismatch',
    });
    expect(validateSignupInput(' User@Example.COM ', 'longpassword123', 'longpassword123')).toEqual(
      {
        ok: true,
        value: { email: 'user@example.com', password: 'longpassword123' },
      },
    );
  });

  it('registers, logs in, pushes/pulls encrypted vaults, handles conflicts, refreshes, logs out, and deletes account', async () => {
    const crypto = createPureJsVaultCryptoPort(seededRandom(55));
    const requests: SyncHttpRequest[] = [];
    let storedMeta: Record<string, unknown> | null = null;
    let storedVerifier = '';
    let storedVault: {
      revision: number;
      ciphertext: string;
      iv: string;
      updatedAt: number;
    } | null = null;

    const http: SyncHttpPort = {
      async request(req): Promise<SyncHttpResponse> {
        requests.push(req);
        const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
        if (req.method === 'POST' && req.url.endsWith('/v1/auth/register')) {
          storedVerifier = String(body.authVerifier);
          storedMeta = {
            kdfSalt: body.kdfSalt,
            kdfIterations: body.kdfIterations,
            wrappedVaultKey: body.wrappedVaultKey,
            recoveryWrappedVaultKey: body.recoveryWrappedVaultKey,
          };
          return {
            status: 201,
            bodyText: JSON.stringify({
              user: { id: 'usr_1', email: body.email },
              accessToken: 'acc_1',
              refreshToken: 'ref_1',
            }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/auth/login')) {
          if (body.authVerifier !== storedVerifier) {
            return { status: 401, bodyText: JSON.stringify({ error: 'invalid_credentials' }) };
          }
          return {
            status: 200,
            bodyText: JSON.stringify({
              user: { id: 'usr_1', email: body.email },
              accessToken: 'acc_2',
              refreshToken: 'ref_2',
              vaultMeta: storedMeta,
            }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/auth/refresh')) {
          return {
            status: 200,
            bodyText: JSON.stringify({ accessToken: 'acc_3', refreshToken: 'ref_3' }),
          };
        }
        if (req.method === 'POST' && req.url.endsWith('/v1/auth/logout')) {
          return { status: 200, bodyText: JSON.stringify({ ok: true }) };
        }
        if (req.method === 'DELETE' && req.url.endsWith('/v1/auth/account')) {
          if (body.authVerifier !== storedVerifier) {
            return { status: 401, bodyText: JSON.stringify({ error: 'invalid_credentials' }) };
          }
          storedVault = null;
          return { status: 200, bodyText: JSON.stringify({ deleted: true }) };
        }
        if (req.method === 'GET' && req.url.endsWith('/v1/vault')) {
          if (storedVault === null) {
            return {
              status: 200,
              bodyText: JSON.stringify({
                revision: 0,
                ciphertext: null,
                iv: null,
                updatedAt: null,
              }),
            };
          }
          return { status: 200, bodyText: JSON.stringify(storedVault) };
        }
        if (req.method === 'PUT' && req.url.endsWith('/v1/vault')) {
          const currentRev = storedVault?.revision ?? 0;
          if (body.expectedRevision !== currentRev) {
            return {
              status: 409,
              bodyText: JSON.stringify({ error: 'revision_conflict', currentRevision: currentRev }),
            };
          }
          storedVault = {
            revision: currentRev + 1,
            ciphertext: String(body.ciphertext),
            iv: String(body.iv),
            updatedAt: 1_700_000_001_000,
          };
          return {
            status: 200,
            bodyText: JSON.stringify({
              revision: storedVault.revision,
              updatedAt: storedVault.updatedAt,
            }),
          };
        }
        return { status: 404, bodyText: '{}' };
      },
    };

    const client = createSyncAuthClient({
      baseUrl: 'https://sync.example.test/',
      http,
      crypto,
      kdfIterations: TEST_ITERATIONS,
    });

    // Register — raw password must NEVER appear in outbound HTTP body
    const reg = await client.register(
      'alice@example.test',
      'StrongPassword!42',
      'StrongPassword!42',
    );
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    expect(requests[0]?.body).not.toContain('StrongPassword!42');
    expect(reg.value.recoveryCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);

    // Empty vault pull
    const emptyPull = await client.pullVault(reg.value.session);
    expect(emptyPull).toEqual({
      ok: true,
      value: { revision: 0, snapshot: null, updatedAt: null },
    });

    // Push encrypted vault
    const snap: VaultSnapshot = {
      ...createEmptyVaultSnapshot(1_700_000_000_000),
      favorites: [{ key: 'live:news', updatedAt: 1_700_000_000_000 }],
    };
    const push1 = await client.pushVault(reg.value.session, 0, snap);
    expect(push1).toEqual({
      ok: true,
      value: { status: 'ok', revision: 1, updatedAt: 1_700_000_001_000 },
    });

    // Stale push gets 409 conflict
    const conflict = await client.pushVault(reg.value.session, 0, snap);
    expect(conflict).toEqual({
      ok: true,
      value: { status: 'conflict', currentRevision: 1 },
    });

    // Login on a fresh device unlocks vault key and decrypts vault identically
    const login = await client.login('alice@example.test', 'StrongPassword!42');
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.value.vaultKey).toEqual(reg.value.session.vaultKey);

    const pulled = await client.pullVault(login.value);
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.revision).toBe(1);
    expect(pulled.value.snapshot).toEqual(snap);

    // Bad password login fails with auth error
    const badLogin = await client.login('alice@example.test', 'WrongPassword!42');
    expect(badLogin.ok).toBe(false);

    // Refresh, logout, and permanent account deletion
    const refreshed = await client.refresh(login.value.refreshToken);
    expect(refreshed).toEqual({
      ok: true,
      value: { accessToken: 'acc_3', refreshToken: 'ref_3' },
    });

    const loggedOut = await client.logout('ref_3', 'acc_3');
    expect(loggedOut.ok).toBe(true);

    const deleted = await client.deleteAccount('acc_3', 'alice@example.test', 'StrongPassword!42');
    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
  });

  it('handles network failures and malformed responses cleanly', async () => {
    const crypto = createPureJsVaultCryptoPort(seededRandom(3));
    const failingHttp: SyncHttpPort = {
      async request() {
        throw new Error('offline');
      },
    };
    const client = createSyncAuthClient({
      baseUrl: 'https://sync.example.test',
      http: failingHttp,
      crypto,
      kdfIterations: TEST_ITERATIONS,
    });

    expect((await client.login('bad', 'password123')).ok).toBe(false);
    expect((await client.login('a@b.co', '')).ok).toBe(false);
    expect((await client.login('a@b.co', 'password123')).ok).toBe(false);
    expect((await client.refresh('tok')).ok).toBe(false);
    expect((await client.logout('tok')).ok).toBe(false);
    expect((await client.deleteAccount('acc', '', '')).ok).toBe(false);
  });
});
