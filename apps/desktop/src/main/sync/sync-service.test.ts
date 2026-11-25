import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyVaultSnapshot, type VaultSnapshot } from '@elv/sync';
import { afterEach, describe, expect, it } from 'vitest';
import { createAesGcmTestCipher, createEncryptedFileSecretStore } from '../catalog/secret-store.ts';
import { createDesktopSyncService, type DesktopSyncFetchFn } from './sync-service.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSecretStore() {
  const dir = mkdtempSync(join(tmpdir(), 'elv_desktop_sync_'));
  tempDirs.push(dir);
  const filePath = join(dir, 'secrets.json');
  const cipher = createAesGcmTestCipher();
  return {
    filePath,
    store: createEncryptedFileSecretStore({ filePath, cipher }),
    reopen: () => createEncryptedFileSecretStore({ filePath, cipher }),
  };
}

function makeMockServer(): {
  fetchFn: DesktopSyncFetchFn;
  calls: Array<{ method: string; url: string }>;
  telemetryBatches: unknown[];
  feedbackItems: unknown[];
  users: Map<string, { id: string; vaultRevision: number; ciphertext: string | null }>;
} {
  const users = new Map<
    string,
    {
      id: string;
      email: string;
      authVerifier: string;
      vaultMeta: Record<string, unknown>;
      vaultRevision: number;
      ciphertext: string | null;
      iv: string | null;
    }
  >();
  const pairings = new Map<
    string,
    {
      pairingId: string;
      code: string;
      pollToken: string;
      expiresAt: number;
      status: 'pending' | 'claimed';
      encryptedPayload?: string;
      iv?: string;
    }
  >();
  const calls: Array<{ method: string; url: string }> = [];
  const telemetryBatches: unknown[] = [];
  const feedbackItems: unknown[] = [];
  let seq = 0;

  const fetchFn: DesktopSyncFetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const parsed = new URL(url);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (method === 'POST' && parsed.pathname === '/v1/auth/register') {
      const email = String(body.email);
      seq += 1;
      const user = {
        id: `u-${seq}`,
        email,
        authVerifier: String(body.authVerifier),
        vaultMeta: {
          kdfSalt: body.kdfSalt,
          kdfIterations: body.kdfIterations,
          wrappedVaultKey: body.wrappedVaultKey,
          recoveryWrappedVaultKey: body.recoveryWrappedVaultKey,
        },
        vaultRevision: 0,
        ciphertext: null,
        iv: null,
      };
      users.set(email, user);
      return {
        status: 201,
        text: async () =>
          JSON.stringify({
            user: { id: user.id, email },
            accessToken: `acc-${user.id}`,
            refreshToken: `ref-${user.id}-1`,
          }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/auth/login') {
      const user = users.get(String(body.email));
      if (!user || user.authVerifier !== String(body.authVerifier)) {
        return { status: 401, text: async () => JSON.stringify({ error: 'invalid_credentials' }) };
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            user: { id: user.id, email: user.email },
            accessToken: `acc-${user.id}`,
            refreshToken: `ref-${user.id}-2`,
            vaultMeta: user.vaultMeta,
          }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/auth/refresh') {
      const rt = String(body.refreshToken);
      const user = [...users.values()].find((u) => rt.startsWith(`ref-${u.id}`));
      if (!user) return { status: 401, text: async () => JSON.stringify({ error: 'invalid' }) };
      seq += 1;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            user: { id: user.id, email: user.email },
            accessToken: `acc-${user.id}`,
            refreshToken: `ref-${user.id}-${seq}`,
          }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/auth/logout') {
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    }

    if (method === 'DELETE' && parsed.pathname === '/v1/auth/account') {
      const userId = (init?.headers?.Authorization ?? '').replace(/^Bearer acc-/, '');
      const user = [...users.values()].find((u) => u.id === userId);
      if (!user || user.authVerifier !== String(body.authVerifier)) {
        return { status: 401, text: async () => JSON.stringify({ error: 'invalid_credentials' }) };
      }
      users.delete(user.email);
      return { status: 200, text: async () => JSON.stringify({ deleted: true }) };
    }

    if (method === 'GET' && parsed.pathname === '/v1/vault') {
      const userId = (init?.headers?.Authorization ?? '').replace(/^Bearer acc-/, '');
      const user = [...users.values()].find((u) => u.id === userId);
      if (!user)
        return { status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            revision: user.vaultRevision,
            ciphertext: user.ciphertext,
            iv: user.iv,
            updatedAt: 1_700_000_000_000,
          }),
      };
    }

    if (method === 'PUT' && parsed.pathname === '/v1/vault') {
      const userId = (init?.headers?.Authorization ?? '').replace(/^Bearer acc-/, '');
      const user = [...users.values()].find((u) => u.id === userId);
      if (!user)
        return { status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
      user.vaultRevision += 1;
      user.ciphertext = String(body.ciphertext);
      user.iv = String(body.iv);
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ revision: user.vaultRevision, updatedAt: 1_700_000_005_000 }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/pair/create') {
      seq += 1;
      const pairingId = `pair-${seq}`;
      const code = `DESKPAIR000${seq}`;
      const pollToken = `pt-${seq}`;
      const expiresAt = 1_700_000_300_000;
      pairings.set(pairingId, { pairingId, code, pollToken, expiresAt, status: 'pending' });
      return {
        status: 201,
        text: async () => JSON.stringify({ pairingId, code, pollToken, expiresAt }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/pair/claim') {
      const session = [...pairings.values()].find((p) => p.code === String(body.code));
      if (!session)
        return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
      session.status = 'claimed';
      session.encryptedPayload = String(body.encryptedPayload);
      session.iv = String(body.iv);
      return { status: 200, text: async () => JSON.stringify({ claimed: true }) };
    }

    if (method === 'GET' && parsed.pathname.startsWith('/v1/pair/poll/')) {
      const id = parsed.pathname.slice('/v1/pair/poll/'.length);
      const session = pairings.get(id);
      if (!session) return { status: 410, text: async () => JSON.stringify({ error: 'expired' }) };
      if (session.status === 'pending') {
        return { status: 200, text: async () => JSON.stringify({ status: 'pending' }) };
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'claimed',
            encryptedPayload: session.encryptedPayload,
            iv: session.iv,
          }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/telemetry') {
      telemetryBatches.push(body);
      return { status: 202, text: async () => JSON.stringify({ accepted: true }) };
    }

    if (method === 'POST' && parsed.pathname === '/v1/feedback') {
      feedbackItems.push(body);
      seq += 1;
      return { status: 201, text: async () => JSON.stringify({ id: `fb-${seq}` }) };
    }

    return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
  };

  return { fetchFn, calls, telemetryBatches, feedbackItems, users };
}

describe('createDesktopSyncService (#26, #458)', () => {
  it('uses Node WebCrypto and encrypted SecretStore for register, vault sync, re-hydration, QR pairing, and deleteAccount', async () => {
    const server = makeMockServer();
    const secrets = makeSecretStore();
    let localSnap: VaultSnapshot = {
      ...createEmptyVaultSnapshot(100),
      favorites: [{ key: 'ch-desktop-1', updatedAt: 100 }],
    };

    const service = createDesktopSyncService({
      secretStore: secrets.store,
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      mpvVersion: '0.42.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn: server.fetchFn,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: 10,
      flushIntervalMs: 0,
      getLocalSnapshot: () => localSnap,
      applyMergedSnapshot: (snap) => {
        localSnap = snap;
      },
    });

    const reg = await service.register('desk@example.test', 'StrongPass123!', 'StrongPass123!');
    expect(reg.ok).toBe(true);
    expect(reg.recoveryCode).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
    expect(service.getState().pendingRecoveryCode).toBe(reg.recoveryCode);
    service.acknowledgeRecoveryCode();
    expect(service.getState().pendingRecoveryCode).toBeNull();

    expect((await service.syncNow()).ok).toBe(true);
    expect(server.users.get('desk@example.test')?.vaultRevision).toBe(1);

    // Re-hydrating into a fresh service restores signed_in state and decrypts vault
    let restoredSnap = createEmptyVaultSnapshot(0);
    const service2 = createDesktopSyncService({
      secretStore: secrets.reopen(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn: server.fetchFn,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: 10,
      flushIntervalMs: 0,
      getLocalSnapshot: () => restoredSnap,
      applyMergedSnapshot: (snap) => {
        restoredSnap = snap;
      },
    });
    await service2.hydrate();
    expect(service2.getState().status).toBe('signed_in');
    expect((await service2.syncNow()).ok).toBe(true);
    expect(restoredSnap.favorites).toEqual([{ key: 'ch-desktop-1', updatedAt: 100 }]);

    // QR pairing between service (signed in) and a fresh desktop instance
    const freshSecrets = makeSecretStore();
    const target = createDesktopSyncService({
      secretStore: freshSecrets.store,
      platform: 'desktop-darwin',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn: server.fetchFn,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: 10,
      flushIntervalMs: 0,
    });
    const qr = await target.createQrPairing();
    expect(await target.pollQrPairing(qr.pairingId)).toBe('pending');
    expect((await service.claimQrPairing(qr.qrUri)).ok).toBe(true);
    expect(await target.pollQrPairing(qr.pairingId)).toBe('claimed');
    expect(target.getState().email).toBe('desk@example.test');
    target.dispose();

    // Delete account erases server & local encrypted secrets
    expect((await service.deleteAccount('StrongPass123!')).ok).toBe(true);
    expect(service.getState().status).toBe('signed_out');
    expect(server.users.has('desk@example.test')).toBe(false);

    service.dispose();
    service2.dispose();
  });

  it('keeps telemetry strictly zero-traffic when opted out and attaches redacted log tail + mpvVersion to feedback', async () => {
    const server = makeMockServer();
    const secrets = makeSecretStore();

    const service = createDesktopSyncService({
      secretStore: secrets.store,
      platform: 'desktop-win32',
      appVersion: '1.5.0',
      mpvVersion: '0.42.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn: server.fetchFn,
      clock: { now: () => 1_700_000_000_000 },
      flushIntervalMs: 0,
      readLogTail: async () => [
        'mpv error loading https://u:p@iptv.example.test/live/1.ts?token=xyz',
        'hwdec=auto-safe',
      ],
    });

    // Opted out by default
    expect(service.getTelemetryStatus().optedIn).toBe(false);
    service.recordTelemetry({ kind: 'screen_transition', screen: 'live', durationMs: 18 });
    service.recordTelemetry({
      kind: 'media_decode_failure',
      engine: 'mpv',
      videoCodec: 'hevc',
      errorCode: 'decoder',
      isLive: true,
    });
    await service.flushTelemetry();
    expect(server.calls).toHaveLength(0);
    expect(service.getTelemetryStatus().queuedCount).toBe(0);

    // Opt in -> record + flush
    const statusOn = service.setTelemetryOptIn(true);
    expect(statusOn.optedIn).toBe(true);
    service.recordTelemetry({
      kind: 'media_decode_failure',
      engine: 'mpv',
      container: 'mpegts',
      videoCodec: 'hevc',
      audioCodec: 'ac3',
      errorCode: 'decoder',
      isLive: true,
    });
    expect(service.getTelemetryStatus().queuedCount).toBe(1);
    await service.flushTelemetry();
    expect(server.telemetryBatches).toHaveLength(1);
    expect(service.getTelemetryStatus().queuedCount).toBe(0);

    // Feedback with diagnostics attaches mpvVersion + redacted logTail without provider URLs/creds
    const fb = await service.submitFeedback({
      category: 'playback_issue',
      message: 'Audio out of sync',
      includeDiagnostics: true,
    });
    expect(fb.ok).toBe(true);
    expect(fb.id).toBeTruthy();
    const submitted = server.feedbackItems[0] as { diagnostics?: Record<string, unknown> };
    expect(submitted.diagnostics?.mpvVersion).toBe('0.42.0');
    const diagJson = JSON.stringify(submitted.diagnostics);
    expect(diagJson).not.toContain('u:p');
    expect(diagJson).not.toContain('token=xyz');
    expect(diagJson).not.toContain('iptv.example.test');

    service.dispose();
  });
});
