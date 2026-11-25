import type { SecretStore } from '@elv/domain';
import { createEmptyVaultSnapshot, type VaultSnapshot } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';
import { createTvMobileSyncPorts, type SyncFetchFn } from './sync-runtime';

function makeMemorySecretStore(): { store: SecretStore; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      async get(key) {
        return data.get(key);
      },
      async set(key, value) {
        data.set(key, value);
      },
      async delete(key) {
        data.delete(key);
      },
    },
  };
}

function makeDeterministicRandom(seed = 1): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

interface MockServerState {
  users: Map<
    string,
    {
      id: string;
      email: string;
      authVerifier: string;
      vaultMeta: {
        kdfSalt: string;
        kdfIterations: number;
        wrappedVaultKey: string;
        recoveryWrappedVaultKey: string;
      };
      vaultRevision: number;
      ciphertext: string | null;
      iv: string | null;
    }
  >;
  pairings: Map<
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
  >;
  telemetryBatches: unknown[];
  feedbackItems: unknown[];
  calls: Array<{ method: string; url: string; body?: string }>;
}

function makeMockSyncServer(): { fetchFn: SyncFetchFn; state: MockServerState } {
  const state: MockServerState = {
    users: new Map(),
    pairings: new Map(),
    telemetryBatches: [],
    feedbackItems: [],
    calls: [],
  };
  let seq = 0;

  const fetchFn: SyncFetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    state.calls.push({ method, url, ...(init?.body !== undefined ? { body: init.body } : {}) });
    const parsed = new URL(url);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (method === 'POST' && parsed.pathname === '/v1/auth/register') {
      const email = String(body.email);
      if (state.users.has(email)) {
        return { status: 409, text: async () => JSON.stringify({ error: 'email_exists' }) };
      }
      seq += 1;
      const user = {
        id: `usr-${seq}`,
        email,
        authVerifier: String(body.authVerifier),
        vaultMeta: {
          kdfSalt: String(body.kdfSalt),
          kdfIterations: Number(body.kdfIterations),
          wrappedVaultKey: String(body.wrappedVaultKey),
          recoveryWrappedVaultKey: String(body.recoveryWrappedVaultKey),
        },
        vaultRevision: 0,
        ciphertext: null,
        iv: null,
      };
      state.users.set(email, user);
      return {
        status: 201,
        text: async () =>
          JSON.stringify({
            user: { id: user.id, email: user.email },
            accessToken: `acc-${user.id}`,
            refreshToken: `ref-${user.id}-1`,
          }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/auth/login') {
      const email = String(body.email);
      const user = state.users.get(email);
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
      const user = [...state.users.values()].find((u) => rt.startsWith(`ref-${u.id}`));
      if (!user) {
        return {
          status: 401,
          text: async () => JSON.stringify({ error: 'invalid_refresh_token' }),
        };
      }
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
      const auth = init?.headers?.Authorization ?? '';
      const userId = auth.replace(/^Bearer acc-/, '');
      const user = [...state.users.values()].find((u) => u.id === userId);
      if (!user || user.authVerifier !== String(body.authVerifier)) {
        return { status: 401, text: async () => JSON.stringify({ error: 'invalid_credentials' }) };
      }
      state.users.delete(user.email);
      return { status: 200, text: async () => JSON.stringify({ deleted: true }) };
    }

    if (method === 'GET' && parsed.pathname === '/v1/vault') {
      const auth = init?.headers?.Authorization ?? '';
      const userId = auth.replace(/^Bearer acc-/, '');
      const user = [...state.users.values()].find((u) => u.id === userId);
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
      const auth = init?.headers?.Authorization ?? '';
      const userId = auth.replace(/^Bearer acc-/, '');
      const user = [...state.users.values()].find((u) => u.id === userId);
      if (!user)
        return { status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) };
      if (Number(body.expectedRevision) !== user.vaultRevision) {
        return {
          status: 409,
          text: async () => JSON.stringify({ currentRevision: user.vaultRevision }),
        };
      }
      user.vaultRevision += 1;
      user.ciphertext = String(body.ciphertext);
      user.iv = String(body.iv);
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ revision: user.vaultRevision, updatedAt: 1_700_000_001_000 }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/pair/create') {
      seq += 1;
      const pairingId = `pair-${seq}`;
      const code = `PAIRCODE000${seq}`;
      const pollToken = `poll-${seq}`;
      const expiresAt = 1_700_000_300_000;
      state.pairings.set(pairingId, {
        pairingId,
        code,
        pollToken,
        expiresAt,
        status: 'pending',
      });
      return {
        status: 201,
        text: async () => JSON.stringify({ pairingId, code, pollToken, expiresAt }),
      };
    }

    if (method === 'POST' && parsed.pathname === '/v1/pair/claim') {
      const code = String(body.code);
      const session = [...state.pairings.values()].find((p) => p.code === code);
      if (!session)
        return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
      session.status = 'claimed';
      session.encryptedPayload = String(body.encryptedPayload);
      session.iv = String(body.iv);
      return { status: 200, text: async () => JSON.stringify({ claimed: true }) };
    }

    if (method === 'GET' && parsed.pathname.startsWith('/v1/pair/poll/')) {
      const id = parsed.pathname.slice('/v1/pair/poll/'.length);
      const session = state.pairings.get(id);
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
      state.telemetryBatches.push(body);
      return { status: 202, text: async () => JSON.stringify({ accepted: true }) };
    }

    if (method === 'POST' && parsed.pathname === '/v1/feedback') {
      state.feedbackItems.push(body);
      seq += 1;
      return { status: 201, text: async () => JSON.stringify({ id: `fb-${seq}` }) };
    }

    return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
  };

  return { fetchFn, state };
}

describe('createTvMobileSyncPorts (#26, #458)', () => {
  it('registers, persists session strictly in SecretStore without accessToken, syncs encrypted vault, signs out, and deletes account', async () => {
    const server = makeMockSyncServer();
    const secrets = makeMemorySecretStore();
    let localSnap: VaultSnapshot = {
      ...createEmptyVaultSnapshot(100),
      favorites: [{ key: 'ch-1', updatedAt: 100 }],
    };
    let nowMs = 1_700_000_000_000;

    const ports = createTvMobileSyncPorts({
      secretStore: secrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.2.3', locale: 'en' }),
      randomBytes: makeDeterministicRandom(7),
      clock: { now: () => nowMs },
      kdfIterations: 10,
      flushIntervalMs: 0,
      getLocalSnapshot: () => localSnap,
      applyMergedSnapshot: (snap) => {
        localSnap = snap;
      },
    });

    const states: string[] = [];
    const unsub = ports.syncAccount.subscribe((s) => states.push(s.status));

    const reg = await ports.syncAccount.register(
      'viewer@example.test',
      'StrongPass123!',
      'StrongPass123!',
    );
    expect(reg.ok).toBe(true);
    expect(reg.recoveryCode).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
    expect(ports.syncAccount.getState().status).toBe('signed_in');
    expect(ports.syncAccount.getState().pendingRecoveryCode).toBe(reg.recoveryCode);

    // Persisted in SecretStore without raw accessToken or raw password
    const rawStored = secrets.data.get('elv.sync.session.v1');
    expect(rawStored).toBeDefined();
    expect(rawStored).not.toContain('StrongPass123!');
    expect(rawStored).not.toContain('acc-usr-');

    ports.syncAccount.acknowledgeRecoveryCode();
    expect(ports.syncAccount.getState().pendingRecoveryCode).toBeNull();

    // Sync encrypts & pushes vault
    nowMs += 5_000;
    const syncRes = await ports.syncAccount.syncNow();
    expect(syncRes.ok).toBe(true);
    expect(ports.syncAccount.getState().lastSyncedAtIso).toBe(new Date(nowMs).toISOString());
    const storedUser = server.state.users.get('viewer@example.test');
    expect(storedUser?.vaultRevision).toBe(1);
    expect(storedUser?.ciphertext).toBeTruthy();
    expect(storedUser?.ciphertext).not.toContain('ch-1');

    // Hydrating a second instance from the same SecretStore restores signed_in state and pulls+decrypts
    let hydratedSnap: VaultSnapshot = createEmptyVaultSnapshot(0);
    const ports2 = createTvMobileSyncPorts({
      secretStore: secrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.2.3' }),
      randomBytes: makeDeterministicRandom(11),
      clock: { now: () => nowMs },
      kdfIterations: 10,
      flushIntervalMs: 0,
      getLocalSnapshot: () => hydratedSnap,
      applyMergedSnapshot: (snap) => {
        hydratedSnap = snap;
      },
    });
    await ports2.hydrate();
    expect(ports2.syncAccount.getState().status).toBe('signed_in');
    expect(ports2.syncAccount.getState().email).toBe('viewer@example.test');
    expect((await ports2.syncAccount.syncNow()).ok).toBe(true);
    expect(hydratedSnap.favorites).toEqual([{ key: 'ch-1', updatedAt: 100 }]);
    ports2.dispose();

    // Sign out wipes SecretStore
    await ports.syncAccount.signOut();
    expect(ports.syncAccount.getState().status).toBe('signed_out');
    expect(secrets.data.has('elv.sync.session.v1')).toBe(false);

    // Sign back in and permanently delete account
    expect((await ports.syncAccount.signIn('viewer@example.test', 'StrongPass123!')).ok).toBe(true);
    expect((await ports.syncAccount.deleteAccount('WrongPassword!')).ok).toBe(false);
    expect(ports.syncAccount.getState().status).toBe('signed_in');

    const del = await ports.syncAccount.deleteAccount('StrongPass123!');
    expect(del.ok).toBe(true);
    expect(ports.syncAccount.getState().status).toBe('signed_out');
    expect(secrets.data.has('elv.sync.session.v1')).toBe(false);
    expect(server.state.users.has('viewer@example.test')).toBe(false);

    unsub();
    expect(states).toContain('signing_in');
    expect(states).toContain('syncing');
    ports.dispose();
  });

  it('supports universal E2EE QR pairing between two devices without exposing vault key to server', async () => {
    const server = makeMockSyncServer();
    const secretsA = makeMemorySecretStore();
    const secretsB = makeMemorySecretStore();
    const nowMs = 1_700_000_000_000;

    const phone = createTvMobileSyncPorts({
      secretStore: secretsA.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'ios', appVersion: '1.0.0' }),
      randomBytes: makeDeterministicRandom(21),
      clock: { now: () => nowMs },
      kdfIterations: 10,
      flushIntervalMs: 0,
    });
    const tv = createTvMobileSyncPorts({
      secretStore: secretsB.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'tvos', appVersion: '1.0.0' }),
      randomBytes: makeDeterministicRandom(33),
      clock: { now: () => nowMs },
      kdfIterations: 10,
      flushIntervalMs: 0,
    });

    await phone.syncAccount.register('pair@example.test', 'StrongPass123!', 'StrongPass123!');

    const session = await tv.syncAccount.createQrPairing();
    expect(session.qrUri.startsWith('elviptv://pair?')).toBe(true);
    expect(new TextEncoder().encode(session.qrUri).byteLength).toBeLessThanOrEqual(213);
    expect(await tv.syncAccount.pollQrPairing(session.pairingId)).toBe('pending');

    const claim = await phone.syncAccount.claimQrPairing(session.qrUri);
    expect(claim.ok).toBe(true);

    expect(await tv.syncAccount.pollQrPairing(session.pairingId)).toBe('claimed');
    expect(tv.syncAccount.getState().status).toBe('signed_in');
    expect(tv.syncAccount.getState().email).toBe('pair@example.test');
    expect(secretsB.data.has('elv.sync.session.v1')).toBe(true);

    phone.dispose();
    tv.dispose();
  });

  it('emits ZERO telemetry network calls when opted out, rotates sessionId on opt-in, records media_decode_failure, and flushes on background', async () => {
    const server = makeMockSyncServer();
    const secrets = makeMemorySecretStore();
    let appStateCb: ((state: string) => void) | undefined;
    const onOptInChange = vi.fn();

    const ports = createTvMobileSyncPorts({
      secretStore: secrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '2.0.0' }),
      randomBytes: makeDeterministicRandom(99),
      clock: { now: () => 1_700_000_000_000 },
      flushIntervalMs: 0,
      subscribeAppState: (cb) => {
        appStateCb = cb;
        return () => {
          appStateCb = undefined;
        };
      },
      onTelemetryOptInChange: onOptInChange,
    });

    // Opted out by default -> zero queueing, zero network calls
    expect(ports.telemetry.isOptedIn()).toBe(false);
    ports.telemetry.recordScreenTransition('live', 42);
    ports.telemetry.recordMediaDecodeFailure({
      engine: 'media3',
      container: 'mpegts',
      videoCodec: 'hevc',
      audioCodec: 'ac3',
      errorCode: 'decoder',
      hdrFormat: 'hdr10',
      isLive: true,
    });
    ports.telemetry.recordPlaybackError({ engine: 'media3', errorCode: 'network', isLive: true });
    expect(ports.telemetry.queuedCount()).toBe(0);
    await ports.telemetry.flush();
    appStateCb?.('background');
    expect(server.state.calls).toHaveLength(0);

    const previewBefore = JSON.parse(ports.telemetry.getPayloadPreviewJson()) as {
      sessionId: string;
      events: unknown[];
    };
    expect(previewBefore.events).toEqual([]);

    // Opt in -> rotates sessionId and records strictly redacted events
    ports.telemetry.setOptIn(true);
    expect(onOptInChange).toHaveBeenCalledWith(true);
    expect(ports.telemetry.isOptedIn()).toBe(true);

    ports.telemetry.recordScreenTransition('live', 35);
    ports.telemetry.recordMediaDecodeFailure({
      engine: 'media3',
      container: 'mkv',
      videoCodec: 'h264',
      audioCodec: 'eac3',
      errorCode: 'decoder',
      isLive: false,
    });
    // Malicious URL attempt is strictly dropped by sanitizer
    ports.telemetry.recordPlaybackError({
      engine: 'media3',
      errorCode: 'https://user:pass@evil.test/stream.ts',
      isLive: true,
    });
    expect(ports.telemetry.queuedCount()).toBe(2);

    const previewAfter = JSON.parse(ports.telemetry.getPayloadPreviewJson()) as {
      sessionId: string;
      events: Array<{ kind: string }>;
    };
    expect(previewAfter.sessionId).not.toBe(previewBefore.sessionId);
    expect(previewAfter.events.map((e) => e.kind)).toEqual([
      'screen_transition',
      'media_decode_failure',
    ]);

    await ports.telemetry.flush();
    expect(server.state.telemetryBatches).toHaveLength(1);
    expect(ports.telemetry.queuedCount()).toBe(0);

    // Background transition triggers flush when opted in
    ports.telemetry.recordPlaybackError({ engine: 'media3', errorCode: 'http-509', isLive: true });
    expect(ports.telemetry.queuedCount()).toBe(1);
    appStateCb?.('background');
    await vi.waitFor(() => {
      expect(server.state.telemetryBatches).toHaveLength(2);
      expect(ports.telemetry.queuedCount()).toBe(0);
    });

    // Opting back out immediately clears queue
    ports.telemetry.recordScreenTransition('settings', 12);
    expect(ports.telemetry.queuedCount()).toBe(1);
    ports.telemetry.setOptIn(false);
    expect(ports.telemetry.queuedCount()).toBe(0);

    ports.dispose();
  });

  it('submits feedback with optional redacted diagnostics log tail and respects server_not_configured', async () => {
    const server = makeMockSyncServer();
    const secrets = makeMemorySecretStore();
    let serverUrl = '';

    const ports = createTvMobileSyncPorts({
      secretStore: secrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => serverUrl,
      getDeviceMeta: () => ({
        platform: 'android-tv',
        appVersion: '2.1.0',
        locale: 'tr',
        osVersion: '14',
      }),
      getRecentLogs: async () => [
        'decoder init failed for https://u:p@iptv.example.test/live/1.ts?token=abc',
        'codec=hevc status=error',
      ],
      randomBytes: makeDeterministicRandom(55),
      flushIntervalMs: 0,
    });

    // Empty server URL fails closed without network requests
    expect(
      await ports.feedback.submit({
        category: 'playback_issue',
        message: 'Black screen',
        includeDiagnostics: false,
      }),
    ).toEqual({ ok: false, errorCode: 'server_not_configured' });
    expect(server.state.calls).toHaveLength(0);

    serverUrl = 'https://sync.example.test';

    // Without diagnostics
    const resNoDiag = await ports.feedback.submit({
      category: 'feature_request',
      message: 'Great player!',
      includeDiagnostics: false,
    });
    expect(resNoDiag.ok).toBe(true);
    expect(resNoDiag.id).toBeTruthy();
    expect((server.state.feedbackItems[0] as Record<string, unknown>).diagnostics).toBeUndefined();

    // With diagnostics -> redacted log tail attached
    const resWithDiag = await ports.feedback.submit({
      category: 'playback_issue',
      message: 'HEVC fails on Fire TV',
      includeDiagnostics: true,
    });
    expect(resWithDiag.ok).toBe(true);
    const submitted = server.state.feedbackItems[1] as {
      diagnostics?: Record<string, unknown>;
    };
    expect(submitted.diagnostics).toBeDefined();
    const serialized = JSON.stringify(submitted.diagnostics);
    expect(serialized).toContain('android-tv');
    expect(serialized).not.toContain('u:p');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('iptv.example.test');

    ports.dispose();
  });
});
