import { webcrypto } from 'node:crypto';
import type { SecretStore } from '@elv/domain';
import { createWebCryptoVaultPort, type VaultCryptoPort } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@elv/lan-pairing', () => ({
  generateLanPairingToken: () => null,
}));

import { createTvMobileSyncPorts, type SyncFetchFn } from './sync-runtime';

function makeTestCrypto(): VaultCryptoPort {
  let state = 17;
  return createWebCryptoVaultPort(webcrypto.subtle as unknown as SubtleCrypto, (arr) => {
    for (let i = 0; i < arr.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      arr[i] = (state >>> 24) & 0xff;
    }
    return arr;
  });
}

function makeMemorySecretStore(): SecretStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

describe('tv-mobile syncAccount checkEmail & OAuth seam (#513)', () => {
  it('wires checkEmail through AuthClient, exposes empty supportedOAuthProviders, and falls back to unknown when unconfigured or offline', async () => {
    let serverUrl = '';
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    let responder: (
      url: string,
      body: Record<string, unknown>,
    ) => Promise<{
      readonly status: number;
      text(): Promise<string>;
    }> = async (_url, body) => ({
      status: 200,
      text: async () => JSON.stringify({ exists: body.email === 'alice@example.com' }),
    });

    const fetchFn: SyncFetchFn = async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined ? { body: init.body } : {}),
      });
      const parsedBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      return responder(url, parsedBody);
    };

    const ports = createTvMobileSyncPorts({
      secretStore: makeMemorySecretStore(),
      crypto: makeTestCrypto(),
      fetchFn,
      getServerUrl: () => serverUrl,
      getDeviceMeta: () => ({ platform: 'android-tv', appVersion: '1.0.0' }),
      flushIntervalMs: 0,
    });

    expect(ports.syncAccount.supportedOAuthProviders).toEqual([]);

    // Unconfigured server URL returns 'unknown' without making network requests
    expect(await ports.syncAccount.checkEmail('alice@example.com')).toBe('unknown');
    expect(calls).toHaveLength(0);

    serverUrl = 'https://sync.example.test';
    expect(await ports.syncAccount.checkEmail('Alice@Example.com')).toBe('exists');
    expect(await ports.syncAccount.checkEmail('bob@example.com')).toBe('not_found');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://sync.example.test/v1/auth/check-email',
      'POST https://sync.example.test/v1/auth/check-email',
    ]);

    // Rate limit or network failure returns 'unknown'
    responder = async () => ({
      status: 429,
      text: async () => JSON.stringify({ error: 'rate_limited' }),
    });
    expect(await ports.syncAccount.checkEmail('alice@example.com')).toBe('unknown');

    responder = async () => {
      throw new Error('network down');
    };
    expect(await ports.syncAccount.checkEmail('alice@example.com')).toBe('unknown');

    ports.dispose();
  });
});
