import type { SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import { addStalkerSource, removeSecrets, removeSource, secretKey } from './sources';
import {
  deleteStalkerCmdMap,
  loadStalkerCmdMap,
  mergeStalkerCmdMap,
  type StalkerCmdMap,
  saveStalkerCmdMap,
  stalkerCmdKey,
} from './stalker-secret';
import { testDb } from './test-db';

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

describe('sharded Stalker cmd map store', () => {
  it('shards >150 KB maps under a 64 KiB SecretStore ceiling across save, load, merge, and removeSource', async () => {
    const { db } = testDb();
    const secrets = cappedSecrets(65_536);
    expect((await openCatalog(db)).ok).toBe(true);

    const added = await addStalkerSource(
      {
        name: 'Big Stalker Portal',
        portalUrl: 'http://portal.example.test/c/',
        mac: '00:1A:79:00:00:10',
      },
      { db, secrets, clock: () => 1_700_000_000_000, newId: () => 'bigst' },
    );
    expect(added.ok).toBe(true);

    const largeMap: StalkerCmdMap = {};
    for (let i = 0; i < 2_400; i += 1) {
      largeMap[stalkerCmdKey('live', String(i))] =
        `ffrt http://portal.example.test/stream/live/${i}?token=tok_${String(i).padStart(6, '0')}_abcdef`;
    }
    const totalSerializedBytes = utf8Bytes(JSON.stringify(largeMap));
    expect(totalSerializedBytes).toBeGreaterThan(150_000);

    const saved = await saveStalkerCmdMap(secrets, 'bigst', largeMap);
    expect(saved.ok).toBe(true);
    expect(secrets.maxObservedBytes).toBeLessThanOrEqual(60_000);

    const rootRaw = secrets.data.get(secretKey('bigst', 'stalker_cmds'));
    expect(rootRaw).toBeDefined();
    const manifest = JSON.parse(rootRaw ?? '{}') as { __chunks?: number };
    expect(manifest.__chunks).toBeGreaterThanOrEqual(3);

    const loaded = await loadStalkerCmdMap(secrets, 'bigst');
    expect(Object.keys(loaded)).toHaveLength(2_400);
    expect(loaded[stalkerCmdKey('live', '0')]).toBe(largeMap[stalkerCmdKey('live', '0')]);
    expect(loaded[stalkerCmdKey('live', '2399')]).toBe(largeMap[stalkerCmdKey('live', '2399')]);

    // Merge additional series episode commands into the sharded map
    const extra: StalkerCmdMap = {};
    for (let i = 0; i < 400; i += 1) {
      extra[stalkerCmdKey('series', `ep_${i}`)] =
        `ffmpeg http://portal.example.test/stream/series/ep_${i}.mp4?t=xyz_${i}`;
    }
    const merged = await mergeStalkerCmdMap(secrets, 'bigst', extra);
    expect(merged.ok).toBe(true);
    expect(secrets.maxObservedBytes).toBeLessThanOrEqual(60_000);

    const afterMerge = await loadStalkerCmdMap(secrets, 'bigst');
    expect(Object.keys(afterMerge)).toHaveLength(2_800);
    expect(afterMerge[stalkerCmdKey('series', 'ep_399')]).toBe(
      extra[stalkerCmdKey('series', 'ep_399')],
    );

    // removeSource deletes manifest AND all chunk keys cleanly (zero leftover keys)
    const removed = await removeSource('bigst', { db, secrets });
    expect(removed.ok).toBe(true);
    expect(Array.from(secrets.data.keys())).toEqual([]);
  });

  it('reads legacy single-blob JSON transparently and cleans up stale shards when shrinking', async () => {
    const secrets = cappedSecrets(65_536);
    const legacy = {
      'live:1': 'ffmpeg http://portal.example.test/ch/1',
      'movie:2': 'ffmpeg http://portal.example.test/vod/2',
    };
    secrets.data.set(secretKey('leg1', 'stalker_cmds'), JSON.stringify(legacy));

    const loadedLegacy = await loadStalkerCmdMap(secrets, 'leg1');
    expect(loadedLegacy).toEqual(legacy);

    // Expand to multiple shards using a small test chunk ceiling, then shrink back to 1
    const big: StalkerCmdMap = {};
    for (let i = 0; i < 40; i += 1) {
      big[`live:${i}`] = `ffmpeg http://portal.example.test/stream/${i}_${'x'.repeat(40)}`;
    }
    expect((await saveStalkerCmdMap(secrets, 'leg1', big, { chunkBytes: 512 })).ok).toBe(true);
    const shardKeysBefore = Array.from(secrets.data.keys()).filter((k) =>
      k.startsWith('source.leg1.stalker_cmds.'),
    );
    expect(shardKeysBefore.length).toBeGreaterThan(2);

    // Shrink back to a small map -> stale shard keys MUST be removed
    const small: StalkerCmdMap = { 'live:1': 'ffmpeg http://portal.example.test/ch/1' };
    expect((await saveStalkerCmdMap(secrets, 'leg1', small, { chunkBytes: 512 })).ok).toBe(true);
    const shardKeysAfter = Array.from(secrets.data.keys()).filter((k) =>
      k.startsWith('source.leg1.stalker_cmds.'),
    );
    expect(shardKeysAfter).toEqual([]);
    expect(await loadStalkerCmdMap(secrets, 'leg1')).toEqual(small);

    expect((await deleteStalkerCmdMap(secrets, 'leg1')).ok).toBe(true);
    expect(Array.from(secrets.data.keys())).toEqual([]);
  });

  it('removeSecrets removes sharded stalker_cmds and fails safely on partial shard delete error', async () => {
    const base = cappedSecrets(65_536);
    const big: StalkerCmdMap = {};
    for (let i = 0; i < 20; i += 1) {
      big[`live:${i}`] = `ffmpeg http://portal.example.test/ch/${i}_${'y'.repeat(50)}`;
    }
    expect((await saveStalkerCmdMap(base, 'sfail', big, { chunkBytes: 400 })).ok).toBe(true);

    let failOnce = true;
    const flakySecrets: SecretStore = {
      get: (k) => base.get(k),
      set: (k, v) => base.set(k, v),
      async delete(k) {
        if (failOnce && k === 'source.sfail.stalker_cmds.1') {
          failOnce = false;
          throw new Error('keychain locked');
        }
        await base.delete(k);
      },
    };

    const firstAttempt = await removeSecrets('sfail', flakySecrets);
    expect(firstAttempt.ok).toBe(false);
    // Manifest must still exist so retry can finish deleting shard 1
    expect(base.data.has('source.sfail.stalker_cmds')).toBe(true);
    expect(base.data.has('source.sfail.stalker_cmds.1')).toBe(true);

    const retryAttempt = await removeSecrets('sfail', flakySecrets);
    expect(retryAttempt.ok).toBe(true);
    expect(Array.from(base.data.keys())).toEqual([]);
  });

  it('handles corrupt/invalid manifests, oversized single entries, and write failure shard cleanup', async () => {
    const base = cappedSecrets(65_536);

    // Corrupt root JSON, non-object JSON, out-of-range manifest, and corrupt shard are ignored safely
    base.data.set('source.bad1.stalker_cmds', '{not-json');
    expect(await loadStalkerCmdMap(base, 'bad1')).toEqual({});
    base.data.set('source.bad2.stalker_cmds', '[1,2,3]');
    expect(await loadStalkerCmdMap(base, 'bad2')).toEqual({});
    base.data.set('source.bad3.stalker_cmds', JSON.stringify({ __chunks: 9999 }));
    expect(await loadStalkerCmdMap(base, 'bad3')).toEqual({});
    base.data.set('source.bad4.stalker_cmds', JSON.stringify({ __chunks: 2 }));
    base.data.set('source.bad4.stalker_cmds.0', '{corrupt');
    base.data.set('source.bad4.stalker_cmds.1', JSON.stringify({ 'live:1': 'http://ok.test/1' }));
    expect(await loadStalkerCmdMap(base, 'bad4')).toEqual({ 'live:1': 'http://ok.test/1' });

    // Oversized single entry or exceeding maxChunks fails cleanly with storage/secret-store-failed
    const hugeEntry: StalkerCmdMap = { 'live:1': 'x'.repeat(200) };
    const oversizedRes = await saveStalkerCmdMap(base, 'over1', hugeEntry, { chunkBytes: 100 });
    expect(oversizedRes.ok).toBe(false);

    const manyEntries: StalkerCmdMap = {
      'live:1': 'a'.repeat(40),
      'live:2': 'b'.repeat(40),
      'live:3': 'c'.repeat(40),
    };
    const tooManyRes = await saveStalkerCmdMap(base, 'over2', manyEntries, {
      chunkBytes: 80,
      maxChunks: 1,
    });
    expect(tooManyRes.ok).toBe(false);

    // Partial write failure cleans up newly written shards and leaves previous map intact
    expect((await saveStalkerCmdMap(base, 'wfail', { 'live:old': 'http://old.test/1' })).ok).toBe(
      true,
    );
    const failWriteStore: SecretStore = {
      get: (k) => base.get(k),
      delete: (k) => base.delete(k),
      async set(k, v) {
        if (k === 'source.wfail.stalker_cmds.1') throw new Error('disk full');
        await base.set(k, v);
      },
    };
    const failedSave = await saveStalkerCmdMap(
      failWriteStore,
      'wfail',
      {
        'live:1': 'a'.repeat(40),
        'live:2': 'b'.repeat(40),
      },
      { chunkBytes: 80 },
    );
    expect(failedSave.ok).toBe(false);
    // Shard 0 written before shard 1 failed must be cleaned up, and old root remains readable
    expect(base.data.has('source.wfail.stalker_cmds.0')).toBe(false);
    expect(await loadStalkerCmdMap(base, 'wfail')).toEqual({ 'live:old': 'http://old.test/1' });
  });
});
