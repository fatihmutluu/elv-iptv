import type { DrmConfig, SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { type DrmSpecMap, deleteDrmSpecs, loadDrmSpecs, saveDrmSpecs } from './drm-secret-store';
import { removeSecrets, secretKey } from './sources';

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

function cappedSecrets(maxBytes = 65_536): SecretStore & {
  data: Map<string, string>;
  maxObservedBytes: number;
} {
  const data = new Map<string, string>();
  const store = {
    data,
    maxObservedBytes: 0,
    async get(key: string) {
      return data.get(key);
    },
    async set(key: string, value: string) {
      const size = utf8Bytes(value);
      if (size > maxBytes) {
        throw new Error(`secret value for ${key} exceeded ${maxBytes} bytes (${size})`);
      }
      if (size > store.maxObservedBytes) store.maxObservedBytes = size;
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
  return store;
}

describe('sharded DRM secret store (#272)', () => {
  it('shards >150 KB DRM maps under a 60 KB SecretStore ceiling and cleans up all shards on delete', async () => {
    const secrets = cappedSecrets(65_536);
    const largeMap: DrmSpecMap = {};
    for (let i = 0; i < 1_000; i += 1) {
      const hex = i.toString(16).padStart(32, '0');
      largeMap[`m:bigdrm:live:${i}`] =
        i % 2 === 0
          ? {
              scheme: 'clearkey',
              clearKeys: [{ kid: hex, key: hex.split('').reverse().join('') }],
            }
          : {
              scheme: 'widevine',
              licenseUrl: `https://drm.example.test/wv/license/${i}?token=tok_${hex}`,
              licenseHeaders: { Authorization: `Bearer secret_${i}` },
            };
    }
    expect(utf8Bytes(JSON.stringify(largeMap))).toBeGreaterThan(150_000);

    const saved = await saveDrmSpecs(secrets, 'bigdrm', largeMap);
    expect(saved.ok).toBe(true);
    expect(secrets.maxObservedBytes).toBeLessThanOrEqual(60_000);

    const rootRaw = secrets.data.get(secretKey('bigdrm', 'drm_specs'));
    expect(rootRaw).toBeDefined();
    const manifest = JSON.parse(rootRaw ?? '{}') as { __chunks?: number };
    expect(manifest.__chunks).toBeGreaterThanOrEqual(3);

    const loaded = await loadDrmSpecs(secrets, 'bigdrm');
    expect(Object.keys(loaded)).toHaveLength(1_000);
    expect(loaded['m:bigdrm:live:0']).toEqual(largeMap['m:bigdrm:live:0']);
    expect(loaded['m:bigdrm:live:999']).toEqual(largeMap['m:bigdrm:live:999']);

    // Shrinking back to 1 item cleans up all stale shards
    const small: DrmSpecMap = {
      'm:bigdrm:live:0': largeMap['m:bigdrm:live:0'] as DrmConfig,
    };
    expect((await saveDrmSpecs(secrets, 'bigdrm', small)).ok).toBe(true);
    const leftoverShards = Array.from(secrets.data.keys()).filter((k) =>
      k.startsWith('source.bigdrm.drm_specs.'),
    );
    expect(leftoverShards).toEqual([]);
    expect(await loadDrmSpecs(secrets, 'bigdrm')).toEqual(small);

    expect((await deleteDrmSpecs(secrets, 'bigdrm')).ok).toBe(true);
    expect(Array.from(secrets.data.keys())).toEqual([]);
  });

  it('deletes shards before manifest inside removeSecrets so retries succeed after partial failure', async () => {
    const base = cappedSecrets(65_536);
    const map: DrmSpecMap = {};
    for (let i = 0; i < 15; i += 1) {
      map[`m:sfail:live:${i}`] = {
        scheme: 'widevine',
        licenseUrl: `https://lic.example.test/wv/${i}/${'x'.repeat(40)}`,
      };
    }
    expect((await saveDrmSpecs(base, 'sfail', map, { chunkBytes: 400 })).ok).toBe(true);

    let failOnce = true;
    const flaky: SecretStore = {
      get: (k) => base.get(k),
      set: (k, v) => base.set(k, v),
      async delete(k) {
        if (failOnce && k === 'source.sfail.drm_specs.1') {
          failOnce = false;
          throw new Error('keychain locked');
        }
        await base.delete(k);
      },
    };

    const first = await removeSecrets('sfail', flaky);
    expect(first.ok).toBe(false);
    // Manifest must remain so retry can clean up shard 1
    expect(base.data.has('source.sfail.drm_specs')).toBe(true);
    expect(base.data.has('source.sfail.drm_specs.1')).toBe(true);

    const retry = await removeSecrets('sfail', flaky);
    expect(retry.ok).toBe(true);
    expect(Array.from(base.data.keys())).toEqual([]);
  });

  it('handles corrupt/malformed blobs, prototype keys, oversized entries, and write rollback cleanly', async () => {
    const base = cappedSecrets(65_536);

    base.data.set('source.bad1.drm_specs', '{broken-json');
    expect(await loadDrmSpecs(base, 'bad1')).toEqual({});
    base.data.set('source.bad2.drm_specs', '[1,2]');
    expect(await loadDrmSpecs(base, 'bad2')).toEqual({});
    base.data.set('source.bad3.drm_specs', JSON.stringify({ __chunks: 9999 }));
    expect(await loadDrmSpecs(base, 'bad3')).toEqual({});

    // Corrupt shard + invalid DRM entry + __proto__ key are safely skipped
    base.data.set('source.bad4.drm_specs', JSON.stringify({ __chunks: 2 }));
    base.data.set('source.bad4.drm_specs.0', '{corrupt');
    base.data.set(
      'source.bad4.drm_specs.1',
      '{"__proto__":{"scheme":"widevine","licenseUrl":"https://evil.test"},"bad":{"scheme":"unknown"},"ok":{"scheme":"playready","licenseUrl":"https://pr.test/lic","multiSession":true}}',
    );
    expect(await loadDrmSpecs(base, 'bad4')).toEqual({
      ok: { scheme: 'playready', licenseUrl: 'https://pr.test/lic', multiSession: true },
    });

    // Oversized single entry or exceeding maxChunks fails cleanly
    expect(
      (
        await saveDrmSpecs(
          base,
          'over1',
          { k1: { scheme: 'widevine', licenseUrl: `https://lic.test/${'a'.repeat(200)}` } },
          { chunkBytes: 100 },
        )
      ).ok,
    ).toBe(false);

    expect(
      (
        await saveDrmSpecs(
          base,
          'over2',
          {
            k1: { scheme: 'widevine', licenseUrl: `https://lic.test/${'a'.repeat(40)}` },
            k2: { scheme: 'widevine', licenseUrl: `https://lic.test/${'b'.repeat(40)}` },
          },
          { chunkBytes: 90, maxChunks: 1 },
        )
      ).ok,
    ).toBe(false);

    // Partial write failure cleans up newly written shards and leaves previous root intact
    const initial: DrmSpecMap = {
      old: { scheme: 'widevine', licenseUrl: 'https://old.example.test/wv' },
    };
    expect((await saveDrmSpecs(base, 'wfail', initial)).ok).toBe(true);
    const failWrite: SecretStore = {
      get: (k) => base.get(k),
      delete: (k) => base.delete(k),
      async set(k, v) {
        if (k === 'source.wfail.drm_specs.1') throw new Error('disk full');
        await base.set(k, v);
      },
    };
    const res = await saveDrmSpecs(
      failWrite,
      'wfail',
      {
        k1: { scheme: 'widevine', licenseUrl: `https://lic.test/${'a'.repeat(40)}` },
        k2: { scheme: 'widevine', licenseUrl: `https://lic.test/${'b'.repeat(40)}` },
      },
      { chunkBytes: 90 },
    );
    expect(res.ok).toBe(false);
    expect(base.data.has('source.wfail.drm_specs.0')).toBe(false);
    expect(await loadDrmSpecs(base, 'wfail')).toEqual(initial);
  });
});
