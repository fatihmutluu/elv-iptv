import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyVaultSnapshot, type VaultSnapshot } from '@elv/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCatalogQuitHandler } from '../catalog/ipc.ts';
import { createAesGcmTestCipher, createEncryptedFileSecretStore } from '../catalog/secret-store.ts';
import { buildDesktopDeviceProfile, extractSafeErrorSignature } from './device-profile.ts';
import { createDesktopSyncService, type DesktopSyncFetchFn } from './sync-service.ts';
import { VAULT_BASELINE_SECRET_KEY } from './sync-service-helpers.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSecretStore() {
  const dir = mkdtempSync(join(tmpdir(), 'elv_p9_sync_'));
  tempDirs.push(dir);
  return createEncryptedFileSecretStore({
    filePath: join(dir, 'secrets.json'),
    cipher: createAesGcmTestCipher(),
  });
}

describe('Wave P9 Desktop auto-sync, 13-kind telemetry, deviceProfile, and quit ordering (#509, #510)', () => {
  it('records all 13 telemetry event kinds with sanitized DeviceTechnicalProfile and strips sensitive paths/URLs from error signatures', async () => {
    const uploadedBatches: Array<Record<string, unknown>> = [];
    const fetchFn: DesktopSyncFetchFn = async (url, init) => {
      if (new URL(url).pathname === '/v1/telemetry' && init?.body) {
        uploadedBatches.push(JSON.parse(init.body) as Record<string, unknown>);
        return { status: 200, text: async () => '{"ok":true}' };
      }
      return { status: 404, text: async () => '{}' };
    };

    const deviceProfile = buildDesktopDeviceProfile({
      platform: 'win32',
      arch: 'x64',
      totalMemBytes: 16 * 1024 ** 3,
      osRelease: '10.0.26100',
      gpu: 'NVIDIA GeForce RTX 4070',
      resolution: '2560x1440',
      locale: 'en-US',
    });
    expect(deviceProfile).toEqual({
      osVersion: 'win32 10.0.26100',
      formFactor: 'desktop',
      arch: 'x64',
      ramBucket: '16gb',
      gpu: 'NVIDIA GeForce RTX 4070',
      resolution: '2560x1440',
      locale: 'en-US',
    });

    const sig = extractSafeErrorSignature(
      Object.assign(new TypeError('Failed reading https://user:pass@iptv.example.com/a.m3u'), {
        stack: 'TypeError: boom\n    at load (C:\\Users\\Alice\\App\\catalog.ts:42:10)',
      }),
    );
    expect(sig.errorName).toBe('TypeError');
    expect(sig.stackSig).not.toContain('Users');
    expect(sig.stackSig).not.toContain('iptv.example.com');
    expect(sig.stackSig).not.toContain('pass');

    // P1-6: provider URL host:port in stack MUST NEVER leak into stackSig
    const providerLeakSig = extractSafeErrorSignature(
      Object.assign(new Error('Network error'), {
        stack:
          'Error: Network error\n    at fetch (https://myprovider.de:8080/live/user/pass/123.ts:1:1)\n    at myprovider.de:8080/live/playlist.m3u',
      }),
    );
    expect(providerLeakSig.stackSig).not.toContain('myprovider');
    expect(providerLeakSig.stackSig).not.toContain('8080');
    expect(providerLeakSig.stackSig).not.toContain('123.ts');

    // Legitimate code-bundle frames still extract cleanly after redaction
    const cleanBundleSig = extractSafeErrorSignature(
      Object.assign(new RangeError('out of range'), {
        stack: 'RangeError: out of range\n    at render (PlayerScreen.tsx:142:9)',
      }),
    );
    expect(cleanBundleSig).toEqual({ errorName: 'RangeError', stackSig: 'PlayerScreen.tsx:142' });

    const svc = createDesktopSyncService({
      secretStore: makeSecretStore(),
      platform: 'desktop-win32',
      appVersion: '1.2.3',
      initialServerUrl: 'https://sync.example.test',
      fetchFn,
      deviceProfile,
      clock: { now: () => 1_700_000_000_000 },
      flushIntervalMs: 0,
    });
    svc.setTelemetryOptIn(true);

    svc.recordTelemetry({ kind: 'startup', durationMs: 420, coldStart: true });
    svc.recordTelemetry({ kind: 'screen_transition', screen: 'live', durationMs: 32 });
    svc.recordTelemetry({ kind: 'frame_jank', screen: 'guide', droppedFrames: 4, maxFrameMs: 65 });
    svc.recordTelemetry({ kind: 'js_stall', screen: 'guide', durationMs: 180 });
    svc.recordTelemetry({ kind: 'memory_pressure', level: 'moderate', usedMb: 512 });
    svc.recordTelemetry({
      kind: 'playback_start',
      engine: 'mpv',
      ttffMs: 310,
      isLive: true,
      container: 'mpegts',
      videoCodec: 'h264',
    });
    svc.recordTelemetry({
      kind: 'playback_rebuffer',
      engine: 'mpv',
      durationMs: 900,
      isLive: true,
    });
    svc.recordTelemetry({
      kind: 'playback_error',
      engine: 'mpv',
      errorCode: 'http-503',
      isLive: true,
    });
    svc.recordTelemetry({
      kind: 'media_decode_failure',
      engine: 'mpv',
      container: 'mkv',
      videoCodec: 'hevc',
      audioCodec: 'ac3',
      errorCode: 'decoder',
      hdrFormat: 'hdr10',
      isLive: false,
    });
    svc.recordTelemetry({ kind: 'sqlite_slow_op', op: 'SELECT', durationMs: 320 });
    svc.recordTelemetry({
      kind: 'app_crash',
      errorName: 'RangeError',
      stackSig: 'App.tsx:88',
      fatal: true,
      uptimeMs: 12_000,
    });
    svc.recordTelemetry({
      kind: 'unhandled_error',
      errorName: sig.errorName,
      stackSig: sig.stackSig,
      source: 'main',
    });
    svc.recordTelemetry({
      kind: 'catalog_import',
      sourceKind: 'xtream',
      stage: 'catalog',
      durationMs: 1500,
      itemCount: 2500,
      success: true,
    });

    expect(svc.getTelemetryStatus().queuedCount).toBe(13);
    await svc.flushTelemetry();
    expect(uploadedBatches).toHaveLength(1);
    const events = uploadedBatches[0]?.events as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toHaveLength(13);
    expect(uploadedBatches[0]?.deviceProfile).toEqual(deviceProfile);
    svc.dispose();
  });

  it('flushes auto-sync BEFORE catalog SQLite coordinator shuts down on before-quit', async () => {
    const order: string[] = [];
    let beforeQuitListener: ((event: { preventDefault(): void }) => void) | undefined;
    registerCatalogQuitHandler({
      app: {
        on(_event, listener) {
          beforeQuitListener = listener;
        },
      },
      beforeShutdown: async () => {
        order.push('sync-flush-start');
        await new Promise((r) => setTimeout(r, 15));
        order.push('sync-flush-end');
      },
      getCoordinator: () =>
        ({
          isRunning: true,
          async shutdown() {
            order.push('sqlite-shutdown');
          },
        }) as never,
      quit: () => {
        order.push('app-quit');
      },
    });

    const preventDefault = vi.fn();
    beforeQuitListener?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(order).toContain('app-quit'));
    expect(order).toEqual(['sync-flush-start', 'sync-flush-end', 'sqlite-shutdown', 'app-quit']);
  });

  it('persists encrypted vault baseline so offline deletions survive restart, handles corrupt baseline safely, and clears baseline/pairing on signOut (P1-3, P1-4, P1-8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv_p9_baseline_'));
    tempDirs.push(dir);
    const filePath = join(dir, 'secrets.json');
    const cipher = createAesGcmTestCipher();
    const openStore = () => createEncryptedFileSecretStore({ filePath, cipher });

    let nowMs = 1_700_000_000_000;
    let offline = false;
    let vaultRevision = 0;
    let vaultCiphertext: string | null = null;
    let vaultIv: string | null = null;
    let seq = 0;
    const fetchFn: DesktopSyncFetchFn = async (url, init) => {
      if (offline) throw new Error('network_offline');
      const method = init?.method ?? 'GET';
      const parsed = new URL(url);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method === 'POST' && parsed.pathname === '/v1/auth/register') {
        seq += 1;
        return {
          status: 201,
          text: async () =>
            JSON.stringify({
              user: { id: 'u-base', email: String(body.email) },
              accessToken: 'acc-u-base',
              refreshToken: `ref-${seq}`,
            }),
        };
      }
      if (method === 'POST' && parsed.pathname === '/v1/auth/refresh') {
        seq += 1;
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              user: { id: 'u-base', email: 'base@example.test' },
              accessToken: 'acc-u-base',
              refreshToken: `ref-${seq}`,
            }),
        };
      }
      if (method === 'POST' && parsed.pathname === '/v1/auth/logout') {
        return { status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      if (method === 'GET' && parsed.pathname === '/v1/vault') {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              revision: vaultRevision,
              ciphertext: vaultCiphertext,
              iv: vaultIv,
              updatedAt: nowMs,
            }),
        };
      }
      if (method === 'PUT' && parsed.pathname === '/v1/vault') {
        vaultRevision += 1;
        vaultCiphertext = String(body.ciphertext);
        vaultIv = String(body.iv);
        return {
          status: 200,
          text: async () => JSON.stringify({ revision: vaultRevision, updatedAt: nowMs }),
        };
      }
      if (method === 'POST' && parsed.pathname === '/v1/pair/create') {
        return {
          status: 201,
          text: async () =>
            JSON.stringify({
              pairingId: 'pair-signout-1',
              code: '12345678',
              pollToken: 'pt-signout-1',
              expiresAt: nowMs + 300_000,
            }),
        };
      }
      return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
    };

    let localSnap: VaultSnapshot = {
      ...createEmptyVaultSnapshot(nowMs),
      sources: [
        {
          id: 'src_del_1',
          kind: 'm3u',
          name: 'Temp Playlist',
          url: 'https://list.example.test/a.m3u',
          updatedAt: nowMs,
        },
      ],
      favorites: [{ key: 'x:src_del_1:live:1', updatedAt: nowMs }],
    };

    const store1 = openStore();
    const svc1 = createDesktopSyncService({
      secretStore: store1,
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn,
      clock: { now: () => nowMs },
      kdfIterations: 100_000,
      flushIntervalMs: 0,
      getLocalSnapshot: () => localSnap,
      applyMergedSnapshot: (snap) => {
        localSnap = snap;
      },
    });
    expect((await svc1.register('base@example.test', 'StrongPass123!', 'StrongPass123!')).ok).toBe(
      true,
    );
    expect((await svc1.syncNow()).ok).toBe(true);
    const encryptedBaseline = await store1.get(VAULT_BASELINE_SECRET_KEY);
    expect(encryptedBaseline).toBeTruthy();
    expect(encryptedBaseline).not.toContain('src_del_1');
    expect(encryptedBaseline).not.toContain('x:src_del_1:live:1');
    svc1.dispose();

    // Go offline, delete favorite & source locally, restart app (fresh service + hydrate)
    offline = true;
    nowMs += 10_000;
    localSnap = createEmptyVaultSnapshot(nowMs);

    const store2 = openStore();
    const svc2 = createDesktopSyncService({
      secretStore: store2,
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn,
      clock: { now: () => nowMs },
      kdfIterations: 100_000,
      flushIntervalMs: 0,
      getLocalSnapshot: () => localSnap,
      applyMergedSnapshot: (snap) => {
        localSnap = snap;
      },
    });
    await svc2.hydrate();

    // Reconnect and sync -> tombstones synthesized from persisted baseline prevent resurrection!
    offline = false;
    nowMs += 5_000;
    expect((await svc2.syncNow()).ok).toBe(true);
    expect(localSnap.favorites.find((f) => f.key === 'x:src_del_1:live:1')?.deleted).toBe(true);
    expect(localSnap.sources.find((s) => s.id === 'src_del_1')?.deleted).toBe(true);

    // P1-3 markSyncDirty() marks pending without throwing and flushes on flushBeforeBackground
    const revBeforeDirty = vaultRevision;
    svc2.markSyncDirty();
    await svc2.flushBeforeBackground(2_000);
    expect(vaultRevision).toBeGreaterThan(revBeforeDirty);

    // P1-8 signOut clears persisted baseline, disposes pairing, and resets autoSyncState
    const pairSnap = await svc2.startBidirectionalPairing();
    await svc2.signOut();
    expect(await store2.get(VAULT_BASELINE_SECRET_KEY)).toBeUndefined();
    expect(svc2.getState().autoSyncState).toBe('idle');
    expect((await svc2.pollBidirectionalPairing(pairSnap.pairingId)).status).toBe('expired');
    svc2.dispose();

    // Corrupt baseline falls back safely without throwing on hydrate
    const store3 = openStore();
    const svc3 = createDesktopSyncService({
      secretStore: store3,
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn,
      clock: { now: () => nowMs },
      kdfIterations: 100_000,
      flushIntervalMs: 0,
    });
    expect(
      (await svc3.register('corrupt@example.test', 'StrongPass123!', 'StrongPass123!')).ok,
    ).toBe(true);
    await store3.set(VAULT_BASELINE_SECRET_KEY, '{not-valid-json');
    svc3.dispose();

    const svc4 = createDesktopSyncService({
      secretStore: openStore(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn,
      clock: { now: () => nowMs },
      kdfIterations: 100_000,
      flushIntervalMs: 0,
    });
    await expect(svc4.hydrate()).resolves.toBeUndefined();
    expect(svc4.getState().status).toBe('signed_in');
    svc4.dispose();
  });
});
