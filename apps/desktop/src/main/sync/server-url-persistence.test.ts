import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAesGcmTestCipher, createEncryptedFileSecretStore } from '../catalog/secret-store.ts';
import { bindSyncServerUrlToCatalogCoordinator } from './main-lifecycle.ts';
import { createDesktopSyncService, type DesktopSyncFetchFn } from './sync-service.ts';

const TEST_KDF_ITERATIONS = 100_000;
const PERSISTED_KEY = 'elv.sync.server_url.v1';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSecretStore() {
  const dir = mkdtempSync(join(tmpdir(), 'elv_desktop_sync_url_'));
  tempDirs.push(dir);
  const filePath = join(dir, 'secrets.json');
  const cipher = createAesGcmTestCipher();
  return {
    store: createEncryptedFileSecretStore({ filePath, cipher }),
    reopen: () => createEncryptedFileSecretStore({ filePath, cipher }),
  };
}

const unusedFetch: DesktopSyncFetchFn = async () => ({
  status: 404,
  text: async () => '{}',
});

describe('createDesktopSyncService serverUrl persistence & coordinator binding (#511)', () => {
  it('persists custom serverUrl in SecretStore, clears override on reset, and notifies listeners on hydrate and setServerUrl', async () => {
    const secrets = makeSecretStore();
    const seenUrls: string[] = [];

    const first = createDesktopSyncService({
      secretStore: secrets.store,
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://default-sync.example.test',
      fetchFn: unusedFetch,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
      onServerUrlChange: (url) => seenUrls.push(`opt:${url}`),
    });
    const unsub = first.subscribeServerUrl?.((url) => seenUrls.push(`sub:${url}`));

    first.setServerUrl('https://custom-elv.example.test/');
    expect(seenUrls).toEqual([
      'opt:https://custom-elv.example.test',
      'sub:https://custom-elv.example.test',
    ]);
    await vi.waitFor(
      async () => {
        expect(await secrets.reopen().get(PERSISTED_KEY)).toBe('https://custom-elv.example.test');
      },
      { timeout: 2_000, interval: 10 },
    );
    unsub?.();
    first.dispose();

    // Cold restart with empty initialServerUrl hydrates persisted custom URL cleanly
    const hydratedUrls: string[] = [];
    const second = createDesktopSyncService({
      secretStore: secrets.reopen(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: '',
      fetchFn: unusedFetch,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
      onServerUrlChange: (url) => hydratedUrls.push(url),
    });
    await second.hydrate();
    expect(hydratedUrls).toEqual(['https://custom-elv.example.test']);

    // Clearing serverUrl deletes persisted override and emits empty default
    second.setServerUrl('');
    expect(hydratedUrls).toEqual(['https://custom-elv.example.test', '']);
    await vi.waitFor(
      async () => {
        expect(await secrets.reopen().get(PERSISTED_KEY)).toBeUndefined();
      },
      { timeout: 2_000, interval: 10 },
    );
    second.dispose();

    const thirdUrls: string[] = [];
    const third = createDesktopSyncService({
      secretStore: secrets.reopen(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: '',
      fetchFn: unusedFetch,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
      onServerUrlChange: (url) => thirdUrls.push(url),
    });
    await third.hydrate();
    expect(thirdUrls).toEqual([]);
    third.dispose();

    // bindSyncServerUrlToCatalogCoordinator forwards hydrated + runtime server URLs to CatalogCoordinator
    const coordinatorCalls: string[] = [];
    const wiredSecrets = makeSecretStore();
    const prep = createDesktopSyncService({
      secretStore: wiredSecrets.store,
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: '',
      fetchFn: unusedFetch,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });
    prep.setServerUrl('https://persisted-elv.example.test');
    await vi.waitFor(
      async () => {
        expect(await wiredSecrets.reopen().get(PERSISTED_KEY)).toBe(
          'https://persisted-elv.example.test',
        );
      },
      { timeout: 2_000, interval: 10 },
    );
    prep.dispose();

    const wiredSvc = createDesktopSyncService({
      secretStore: wiredSecrets.reopen(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: '',
      fetchFn: unusedFetch,
      clock: { now: () => 1_700_000_000_000 },
      kdfIterations: TEST_KDF_ITERATIONS,
      flushIntervalMs: 0,
    });
    const unbind = bindSyncServerUrlToCatalogCoordinator(
      wiredSvc,
      () => ({
        setElvServerUrl(url) {
          coordinatorCalls.push(url);
        },
      }),
      true,
    );
    await vi.waitFor(
      () => {
        expect(coordinatorCalls).toEqual(['https://persisted-elv.example.test']);
      },
      { timeout: 2_000, interval: 10 },
    );
    wiredSvc.setServerUrl('https://live-update-elv.example.test');
    expect(coordinatorCalls).toEqual([
      'https://persisted-elv.example.test',
      'https://live-update-elv.example.test',
    ]);
    unbind();
    wiredSvc.dispose();
  });
});
