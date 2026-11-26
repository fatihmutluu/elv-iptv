import { webcrypto } from 'node:crypto';
import type { PreferencesPatch, SecretStore } from '@elv/domain';
import { createWebCryptoVaultPort, type VaultCryptoPort } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@elv/lan-pairing', () => ({
  generateLanPairingToken: () => null,
}));

import { initialPrefsAppliedKey } from './sync-helpers';
import { createTvMobileSyncPorts, type SyncFetchFn } from './sync-runtime';

const TEST_KDF_ITERATIONS = 100_000;

function makeDeterministicRandom(seed = 1): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

function makeTestCrypto(seed = 1): VaultCryptoPort {
  const random = makeDeterministicRandom(seed);
  return createWebCryptoVaultPort(webcrypto.subtle as unknown as SubtleCrypto, (arr) => {
    arr.set(random(arr.length));
    return arr;
  });
}

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

function makeMockSyncServer(): { fetchFn: SyncFetchFn } {
  const users = new Map<
    string,
    {
      id: string;
      email: string;
      authVerifier: string;
      kdfSalt: string;
      kdfIterations: number;
      wrappedVaultKey: string;
      recoveryWrappedVaultKey: string;
      revision: number;
      ciphertext: string | null;
      iv: string | null;
    }
  >();
  const tokens = new Map<string, string>();
  const pairings = new Map<
    string,
    {
      code: string;
      pollToken: string;
      claimed: boolean;
      ciphertext?: string;
      iv?: string;
    }
  >();
  let seq = 0;

  const jsonRes = (status: number, body: unknown) =>
    Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });

  const getBearer = (headers?: Readonly<Record<string, string>>): string => {
    if (!headers) return '';
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'authorization') return v.replace(/^Bearer\s+/i, '');
    }
    return '';
  };

  const fetchFn: SyncFetchFn = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (method === 'POST' && path === '/v1/auth/register') {
      const email = String(body.email);
      const id = `usr_${++seq}`;
      users.set(email, {
        id,
        email,
        authVerifier: String(body.authVerifier),
        kdfSalt: String(body.kdfSalt),
        kdfIterations: Number(body.kdfIterations),
        wrappedVaultKey: String(body.wrappedVaultKey),
        recoveryWrappedVaultKey: String(body.recoveryWrappedVaultKey),
        revision: 0,
        ciphertext: null,
        iv: null,
      });
      const accessToken = `at_${++seq}`;
      const refreshToken = `rt_${++seq}`;
      tokens.set(accessToken, email);
      tokens.set(refreshToken, email);
      return jsonRes(201, { user: { id, email }, accessToken, refreshToken });
    }

    if (method === 'POST' && path === '/v1/auth/refresh') {
      const email = tokens.get(String(body.refreshToken));
      const user = email ? users.get(email) : undefined;
      if (!user) return jsonRes(401, { error: 'invalid_token' });
      const accessToken = `at_${++seq}`;
      const refreshToken = `rt_${++seq}`;
      tokens.set(accessToken, user.email);
      tokens.set(refreshToken, user.email);
      return jsonRes(200, {
        user: { id: user.id, email: user.email },
        accessToken,
        refreshToken,
      });
    }

    if (method === 'POST' && path === '/v1/auth/pair-token') {
      const bearer = getBearer(init?.headers);
      const email = tokens.get(bearer);
      if (!email) return jsonRes(401, { error: 'unauthorized' });
      const refreshToken = `prt_${++seq}`;
      tokens.set(refreshToken, email);
      return jsonRes(200, { refreshToken });
    }

    if (method === 'POST' && path === '/v1/pair/create') {
      const pairingId = `pair_${++seq}`;
      const code = `CODE${String(seq).padStart(8, '0')}`;
      const pollToken = `pt_${++seq}`;
      const expiresAt = 1_700_000_300_000;
      pairings.set(pairingId, { code, pollToken, claimed: false });
      return jsonRes(201, { pairingId, code, pollToken, expiresAt });
    }

    if (method === 'POST' && path === '/v1/pair/claim') {
      const bearer = getBearer(init?.headers);
      if (!tokens.has(bearer)) return jsonRes(401, { error: 'unauthorized' });
      const target = [...pairings.values()].find((p) => p.code === String(body.code));
      if (!target) return jsonRes(404, { error: 'not_found' });
      target.claimed = true;
      target.ciphertext = String(body.encryptedPayload);
      target.iv = String(body.iv);
      return jsonRes(200, { claimed: true });
    }

    if (method === 'GET' && path.startsWith('/v1/pair/poll/')) {
      const pairingId = path.slice('/v1/pair/poll/'.length);
      const entry = pairings.get(pairingId);
      if (!entry) return jsonRes(404, { error: 'not_found' });
      if (!entry.claimed) return jsonRes(200, { status: 'pending' });
      return jsonRes(200, {
        status: 'claimed',
        encryptedPayload: entry.ciphertext,
        iv: entry.iv,
      });
    }

    const bearer = getBearer(init?.headers);
    const email = tokens.get(bearer);
    const user = email ? users.get(email) : undefined;
    if (!user) return jsonRes(401, { error: 'unauthorized' });

    if (method === 'GET' && path === '/v1/vault') {
      return jsonRes(200, {
        revision: user.revision,
        ciphertext: user.ciphertext,
        iv: user.iv,
      });
    }

    if (method === 'PUT' && path === '/v1/vault') {
      const expected = Number(body.expectedRevision);
      if (expected !== user.revision) {
        return jsonRes(409, { error: 'conflict', revision: user.revision });
      }
      user.revision += 1;
      user.ciphertext = String(body.ciphertext);
      user.iv = String(body.iv);
      return jsonRes(200, { revision: user.revision });
    }

    return jsonRes(404, { error: 'not_found' });
  };

  return { fetchFn };
}

describe('createTvMobileSyncPorts initial-only preferences sync (Product Decision #40)', () => {
  it('applies initialPreferences once after QR pairing claim and never overwrites local prefs afterwards', async () => {
    const server = makeMockSyncServer();
    const phoneSecrets = makeMemorySecretStore();
    const tvSecrets = makeMemorySecretStore();
    const appliedOnPhone: PreferencesPatch[] = [];
    const appliedOnTv: PreferencesPatch[] = [];
    let nowMs = 1_700_000_000_000;
    let phonePrefs: Record<string, unknown> = {
      themePreset: 'midnightGold',
      locale: 'tr',
      fontScale: 1.15,
      homeLayout: [
        { id: 'live', visible: true },
        { id: 'continue', visible: true },
      ],
      // Device-local keys must be stripped
      overscanX: 0.08,
      androidDecoderMode: 'software',
      syncServerUrl: 'https://evil.example.test',
    };

    const phone = createTvMobileSyncPorts({
      secretStore: phoneSecrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android', appVersion: '1.0.0' }),
      getSyncablePreferences: () => phonePrefs,
      applyInitialPreferences: (patch) => {
        appliedOnPhone.push(patch);
      },
      crypto: makeTestCrypto(11),
      clock: { now: () => nowMs },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });

    const tv = createTvMobileSyncPorts({
      secretStore: tvSecrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.0.0' }),
      getSyncablePreferences: () => ({ themePreset: 'obsidianCrimson', locale: 'en' }),
      applyInitialPreferences: (patch) => {
        appliedOnTv.push(patch);
      },
      crypto: makeTestCrypto(22),
      clock: { now: () => nowMs },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });

    // Phone registers (marks itself applied) and uploads its seed
    expect(
      (await phone.syncAccount.register('tvpair@example.test', 'StrongPass123!', 'StrongPass123!'))
        .ok,
    ).toBe(true);
    expect(await phone.syncAccount.syncNow()).toEqual({ ok: true });
    expect(appliedOnPhone).toHaveLength(0);

    // TV pairs via QR code and performs first sync -> receives sanitized initial preferences ONCE
    const qr = await tv.syncAccount.createQrPairing();
    expect(await phone.syncAccount.claimQrPairing(qr.qrUri)).toEqual({ ok: true });
    expect(await tv.syncAccount.pollQrPairing(qr.pairingId)).toBe('claimed');

    nowMs += 5_000;
    expect(await tv.syncAccount.syncNow()).toEqual({ ok: true });
    expect(appliedOnTv).toHaveLength(1);
    expect(appliedOnTv[0]).toEqual({
      themePreset: 'midnightGold',
      locale: 'tr',
      fontScale: 1.15,
      homeLayout: [
        { id: 'live', visible: true },
        { id: 'continue', visible: true },
        { id: 'mylist', visible: true },
        { id: 'movies', visible: true },
        { id: 'series', visible: true },
        { id: 'collections', visible: true },
      ],
    });

    // Phone changes theme later and syncs
    nowMs += 5_000;
    phonePrefs = { themePreset: 'auroraBlue', locale: 'de' };
    expect(await phone.syncAccount.syncNow()).toEqual({ ok: true });

    // TV syncs again -> MUST NOT overwrite local preferences
    nowMs += 5_000;
    expect(await tv.syncAccount.syncNow()).toEqual({ ok: true });
    expect(appliedOnTv).toHaveLength(1);

    // TV restarts (same secretStore) and syncs again -> persisted flag still prevents overwrite
    const tvRestarted = createTvMobileSyncPorts({
      secretStore: tvSecrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.0.0' }),
      getSyncablePreferences: () => ({ themePreset: 'midnightGold', locale: 'tr' }),
      applyInitialPreferences: (patch) => {
        appliedOnTv.push(patch);
      },
      crypto: makeTestCrypto(33),
      clock: { now: () => nowMs + 5_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });
    await tvRestarted.hydrate();
    expect(await tvRestarted.syncAccount.syncNow()).toEqual({ ok: true });
    expect(appliedOnTv).toHaveLength(1);

    tvRestarted.dispose();
    tv.dispose();
    phone.dispose();
  });

  it('marks pre-Wave-P4 hydrated sessions as initialPrefs-applied so upgrades never overwrite local preferences (P1-1)', async () => {
    const server = makeMockSyncServer();
    const phoneSecrets = makeMemorySecretStore();
    const tvSecrets = makeMemorySecretStore();
    const appliedOnUpgradedTv: PreferencesPatch[] = [];
    const nowMs = 1_700_000_000_000;

    const phone = createTvMobileSyncPorts({
      secretStore: phoneSecrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android', appVersion: '1.0.0' }),
      getSyncablePreferences: () => ({ themePreset: 'midnightGold', locale: 'tr', fontScale: 1.2 }),
      crypto: makeTestCrypto(41),
      clock: { now: () => nowMs },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });
    expect(
      (
        await phone.syncAccount.register(
          'tvupgrade@example.test',
          'StrongPass123!',
          'StrongPass123!',
        )
      ).ok,
    ).toBe(true);
    expect(await phone.syncAccount.syncNow()).toEqual({ ok: true });

    // Pre-Wave-P4 TV already paired & synced before Wave P4 existed
    const preUpgradeTv = createTvMobileSyncPorts({
      secretStore: tvSecrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.0.0' }),
      crypto: makeTestCrypto(42),
      clock: { now: () => nowMs + 1_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });
    const qr = await preUpgradeTv.syncAccount.createQrPairing();
    expect(await phone.syncAccount.claimQrPairing(qr.qrUri)).toEqual({ ok: true });
    expect(await preUpgradeTv.syncAccount.pollQrPairing(qr.pairingId)).toBe('claimed');
    expect(await preUpgradeTv.syncAccount.syncNow()).toEqual({ ok: true });
    preUpgradeTv.dispose();

    // Remove the Wave P4 marker flag to emulate a pre-Wave-P4 persisted session
    const sessionRaw = tvSecrets.data.get('elv.sync.session.v1');
    expect(sessionRaw).toBeDefined();
    const { userId } = JSON.parse(sessionRaw as string) as { userId: string };
    tvSecrets.data.delete(initialPrefsAppliedKey(userId));

    // Upgraded TV hydrates and syncs -> MUST NOT apply remote initialPreferences
    const upgradedTv = createTvMobileSyncPorts({
      secretStore: tvSecrets.store,
      fetchFn: server.fetchFn,
      getServerUrl: () => 'https://sync.example.test',
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.1.0' }),
      getSyncablePreferences: () => ({ themePreset: 'obsidianCrimson', locale: 'en' }),
      applyInitialPreferences: (patch) => {
        appliedOnUpgradedTv.push(patch);
      },
      crypto: makeTestCrypto(43),
      clock: { now: () => nowMs + 5_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });
    await upgradedTv.hydrate();
    expect(await upgradedTv.syncAccount.syncNow()).toEqual({ ok: true });
    expect(appliedOnUpgradedTv).toHaveLength(0);

    upgradedTv.dispose();
    phone.dispose();
  });
});
