import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const dir = mkdtempSync(join(tmpdir(), 'elv_desktop_check_email_'));
  tempDirs.push(dir);
  return createEncryptedFileSecretStore({
    filePath: join(dir, 'secrets.json'),
    cipher: createAesGcmTestCipher(),
  });
}

describe('DesktopSyncService.checkEmail (#513)', () => {
  it('returns exists and not_found from POST /v1/auth/check-email', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchFn: DesktopSyncFetchFn = async (url, init) => {
      seen.push({
        url,
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.body !== undefined ? { body: init.body } : {}),
      });
      const parsed = JSON.parse(init?.body ?? '{}') as { email?: string };
      const exists = parsed.email === 'existing@example.test';
      return {
        status: 200,
        text: async () => JSON.stringify({ exists }),
      };
    };

    const service = createDesktopSyncService({
      secretStore: makeSecretStore(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn,
      flushIntervalMs: 0,
    });

    expect(await service.checkEmail('Existing@Example.Test')).toBe('exists');
    expect(await service.checkEmail('new-user@example.test')).toBe('not_found');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      url: 'https://sync.example.test/v1/auth/check-email',
      method: 'POST',
      body: JSON.stringify({ email: 'existing@example.test' }),
    });

    service.dispose();
  });

  it('returns unknown without network calls when serverUrl is empty', async () => {
    let called = 0;
    const fetchFn: DesktopSyncFetchFn = async () => {
      called += 1;
      return { status: 200, text: async () => JSON.stringify({ exists: true }) };
    };

    const service = createDesktopSyncService({
      secretStore: makeSecretStore(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: '',
      fetchFn,
      flushIntervalMs: 0,
    });

    expect(await service.checkEmail('viewer@example.test')).toBe('unknown');
    expect(called).toBe(0);

    service.dispose();
  });

  it('returns unknown gracefully on network errors or unexpected server responses', async () => {
    const failingFetch: DesktopSyncFetchFn = async () => {
      throw new Error('network down');
    };
    const service = createDesktopSyncService({
      secretStore: makeSecretStore(),
      platform: 'desktop-win32',
      appVersion: '1.0.0',
      initialServerUrl: 'https://sync.example.test',
      fetchFn: failingFetch,
      flushIntervalMs: 0,
    });

    expect(await service.checkEmail('viewer@example.test')).toBe('unknown');
    service.dispose();
  });
});
