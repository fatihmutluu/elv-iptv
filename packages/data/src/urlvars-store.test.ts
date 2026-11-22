import { describe, expect, it } from 'vitest';
import { secretKey } from './sources';
import type { UrlVars } from './templates';
import { memorySecrets } from './test-db';
import {
  deleteUrlVars,
  MAX_URLVARS_CHUNKS,
  MAX_URLVARS_TOTAL_BYTES,
  partitionUrlVars,
  readUrlVars,
  URLVARS_CHUNK_BYTES,
  writeUrlVars,
} from './urlvars-store';

function makeVars(count: number, padLen = 40): UrlVars {
  const vars: UrlVars = {};
  for (let i = 0; i < count; i += 1) {
    vars[`k${i}`] = `v_${i.toString().padStart(6, '0')}_${'x'.repeat(padLen)}`;
  }
  return vars;
}

describe('urlvars-store (#430)', () => {
  it('exposes bounded chunk and ceiling constants', () => {
    expect(URLVARS_CHUNK_BYTES).toBe(60_000);
    expect(MAX_URLVARS_CHUNKS).toBe(256);
    expect(MAX_URLVARS_TOTAL_BYTES).toBe(URLVARS_CHUNK_BYTES * MAX_URLVARS_CHUNKS);
  });

  it('stores small maps (<= 60_000 bytes) in the single source.<id>.urlvars key', async () => {
    const secrets = memorySecrets();
    const vars: UrlVars = { v0: 'tokA', 'h:user-agent': 'Player/1' };
    const written = await writeUrlVars(secrets, 's1', vars);
    expect(written.ok).toBe(true);
    const dump = secrets.dump();
    expect(Object.keys(dump)).toEqual([secretKey('s1', 'urlvars')]);
    expect(JSON.parse(dump[secretKey('s1', 'urlvars')] ?? '{}')).toEqual(vars);
    expect(await readUrlVars({ secrets }, 's1')).toEqual(vars);
  });

  it('shards maps > 60_000 bytes across source.<id>.urlvars.0..N-1 with manifest and reads them back losslessly', async () => {
    const secrets = memorySecrets();
    const vars = makeVars(2500, 48); // ~165 KiB -> 3 shards
    const chunks = partitionUrlVars(vars);
    expect(chunks).toBeDefined();
    expect(chunks?.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks ?? []) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(URLVARS_CHUNK_BYTES);
    }

    const written = await writeUrlVars(secrets, 's1', vars);
    expect(written.ok).toBe(true);
    const dump = secrets.dump();
    const rootKey = secretKey('s1', 'urlvars');
    const manifest = JSON.parse(dump[rootKey] ?? '{}') as { __chunks?: number };
    expect(manifest).toEqual({ __chunks: chunks?.length });
    for (let i = 0; i < (chunks?.length ?? 0); i += 1) {
      expect(dump[`${rootKey}.${i}`]).toBeDefined();
    }
    expect(await readUrlVars({ secrets }, 's1')).toEqual(vars);
  });

  it('shrinks trailing shard keys when updating to fewer shards or back to a single key', async () => {
    const secrets = memorySecrets();
    const big = makeVars(3500, 48); // ~4 shards
    expect((await writeUrlVars(secrets, 's1', big)).ok).toBe(true);
    const rootKey = secretKey('s1', 'urlvars');
    const initialManifest = JSON.parse(secrets.dump()[rootKey] ?? '{}') as { __chunks: number };
    expect(initialManifest.__chunks).toBeGreaterThanOrEqual(4);

    // Shrink to 2 shards
    const medium = makeVars(1400, 48);
    expect((await writeUrlVars(secrets, 's1', medium)).ok).toBe(true);
    const midManifest = JSON.parse(secrets.dump()[rootKey] ?? '{}') as { __chunks: number };
    expect(midManifest.__chunks).toBe(2);
    expect(Object.keys(secrets.dump()).sort()).toEqual([rootKey, `${rootKey}.0`, `${rootKey}.1`]);
    expect(await readUrlVars({ secrets }, 's1')).toEqual(medium);

    // Shrink back to single key
    const small: UrlVars = { v0: 'only-one' };
    expect((await writeUrlVars(secrets, 's1', small)).ok).toBe(true);
    expect(Object.keys(secrets.dump())).toEqual([rootKey]);
    expect(await readUrlVars({ secrets }, 's1')).toEqual(small);
  });

  it('deletes manifest and all shard keys in deleteUrlVars', async () => {
    const secrets = memorySecrets();
    const big = makeVars(2500, 48);
    expect((await writeUrlVars(secrets, 's1', big)).ok).toBe(true);
    expect(Object.keys(secrets.dump()).length).toBeGreaterThan(2);

    const del = await deleteUrlVars(secrets, 's1');
    expect(del.ok).toBe(true);
    expect(secrets.dump()).toEqual({});
  });

  it('fails closed with source-format/urlvars-too-large when exceeding MAX_URLVARS_CHUNKS or single chunk byte limit', async () => {
    const secrets = memorySecrets();
    const singleHuge: UrlVars = { v0: 'x'.repeat(URLVARS_CHUNK_BYTES) };
    expect(partitionUrlVars(singleHuge)).toBeUndefined();
    expect(await writeUrlVars(secrets, 's1', singleHuge)).toMatchObject({
      ok: false,
      error: { category: 'source-format', code: 'urlvars-too-large' },
    });

    const tooManyChunks = makeVars(50, 48);
    expect(partitionUrlVars(tooManyChunks, { chunkBytes: 200, maxChunks: 3 })).toBeUndefined();
    expect(
      await writeUrlVars(secrets, 's1', tooManyChunks, { chunkBytes: 200, maxChunks: 3 }),
    ).toMatchObject({
      ok: false,
      error: { category: 'source-format', code: 'urlvars-too-large' },
    });
    expect(secrets.dump()).toEqual({});
  });

  it('handles corrupt manifests and missing/corrupt shard payloads safely in readUrlVars', async () => {
    const secrets = memorySecrets();
    const rootKey = secretKey('s1', 'urlvars');

    await secrets.set(rootKey, JSON.stringify({ __chunks: 0 }));
    expect(await readUrlVars({ secrets }, 's1')).toEqual({});

    await secrets.set(rootKey, JSON.stringify({ __chunks: MAX_URLVARS_CHUNKS + 1 }));
    expect(await readUrlVars({ secrets }, 's1')).toEqual({});

    await secrets.set(rootKey, JSON.stringify({ __chunks: 2 }));
    await secrets.set(`${rootKey}.0`, JSON.stringify({ a: '1' }));
    await secrets.set(`${rootKey}.1`, '{broken');
    expect(await readUrlVars({ secrets }, 's1')).toEqual({ a: '1' });
  });

  it('keeps manifest intact on partial shard delete failure so retrying deleteUrlVars removes remaining shards (#430)', async () => {
    const secrets = memorySecrets();
    const big = makeVars(2500, 48); // >= 3 shards
    expect((await writeUrlVars(secrets, 's1', big)).ok).toBe(true);
    const rootKey = secretKey('s1', 'urlvars');

    let failShard1 = true;
    const flaky = {
      ...secrets,
      delete: async (key: string) => {
        if (failShard1 && key === `${rootKey}.1`) throw new Error('keychain locked');
        return secrets.delete(key);
      },
    };
    const first = await deleteUrlVars(flaky, 's1');
    expect(first).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'secret-delete-failed' },
    });
    // Manifest must STILL exist so retry can discover and clean up shard 1
    expect(secrets.dump()[rootKey]).toBeDefined();
    expect(secrets.dump()[`${rootKey}.1`]).toBeDefined();

    failShard1 = false;
    const retry = await deleteUrlVars(flaky, 's1');
    expect(retry.ok).toBe(true);
    expect(secrets.dump()).toEqual({});
  });

  it('cleans up newly created shards beyond prevChunks when writeUrlVars fails mid-write (#430)', async () => {
    const secrets = memorySecrets();
    const rootKey = secretKey('s1', 'urlvars');
    // Seed initial single-key state (prevChunks = 0)
    expect((await writeUrlVars(secrets, 's1', { v0: 'keep' })).ok).toBe(true);

    const big = makeVars(2500, 48); // >= 3 shards
    const failingGrowingFromSingle = {
      ...secrets,
      set: async (key: string, value: string) => {
        if (key === `${rootKey}.2`) throw new Error('disk full');
        return secrets.set(key, value);
      },
    };
    const r1 = await writeUrlVars(failingGrowingFromSingle, 's1', big);
    expect(r1).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'secret-write-failed' },
    });
    // No orphaned .0 or .1 shards left behind; original single-key root intact
    expect(Object.keys(secrets.dump())).toEqual([rootKey]);
    expect(await readUrlVars({ secrets }, 's1')).toEqual({ v0: 'keep' });

    // Seed 2 shards (prevChunks = 2), then fail while growing to 4 shards at index 3
    const twoShards = makeVars(1400, 48);
    expect((await writeUrlVars(secrets, 's1', twoShards)).ok).toBe(true);
    const fourShards = makeVars(3500, 48);
    const failingGrowingFromTwo = {
      ...secrets,
      set: async (key: string, value: string) => {
        if (key === `${rootKey}.3`) throw new Error('disk full');
        return secrets.set(key, value);
      },
    };
    const r2 = await writeUrlVars(failingGrowingFromTwo, 's1', fourShards);
    expect(r2).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'secret-write-failed' },
    });
    // Newly created shard .2 (>= prevChunks=2) was cleaned up; manifest still tracks 2 shards
    expect(secrets.dump()[`${rootKey}.2`]).toBeUndefined();
    expect(secrets.dump()[`${rootKey}.3`]).toBeUndefined();
    expect(JSON.parse(secrets.dump()[rootKey] ?? '{}')).toEqual({ __chunks: 2 });
  });
});
