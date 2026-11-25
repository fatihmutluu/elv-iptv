import { describe, expect, it } from 'vitest';
import {
  createEmptyVaultSnapshot,
  decodeEpisodeBitfield,
  encodeEpisodeBitfield,
  MAX_EPISODE_BITFIELD_INDEX,
  mergeEpisodeBitfields,
  mergeVaultSnapshots,
  VAULT_SCHEMA_VERSION,
  type VaultSnapshot,
} from './vault-merge';

describe('vault-merge and episode bitfields', () => {
  it('encodes, decodes, and unions watched-episode bitfields compactly', () => {
    expect(encodeEpisodeBitfield([])).toBe('');
    expect(decodeEpisodeBitfield('')).toEqual([]);

    const a = encodeEpisodeBitfield([0, 2, 7, 8, 15, -1, 1.5, MAX_EPISODE_BITFIELD_INDEX + 1]);
    expect(decodeEpisodeBitfield(a)).toEqual([0, 2, 7, 8, 15]);

    const b = encodeEpisodeBitfield([1, 7, 24]);
    const merged = mergeEpisodeBitfields(a, b);
    expect(decodeEpisodeBitfield(merged)).toEqual([0, 1, 2, 7, 8, 15, 24]);
    expect(mergeEpisodeBitfields(b, a)).toBe(merged);
    expect(mergeEpisodeBitfields('', a)).toBe(a);
    expect(mergeEpisodeBitfields(a, '')).toBe(a);
    expect(mergeEpisodeBitfields('', '')).toBe('');
  });

  it('merges VaultSnapshots deterministically, commutatively, and respects tombstones', () => {
    const empty = createEmptyVaultSnapshot(100);
    expect(empty.schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(mergeVaultSnapshots(empty, empty)).toEqual(empty);

    const local: VaultSnapshot = {
      schemaVersion: 1,
      updatedAt: 500,
      sources: [
        {
          id: 'src-1',
          kind: 'xtream',
          name: 'Living Room Provider',
          url: 'https://provider.example.test',
          username: 'alice',
          password: 'secret',
          updatedAt: 400,
        },
        {
          id: 'src-2',
          kind: 'm3u',
          name: 'Old Playlist',
          url: 'https://old.example.test/list.m3u',
          updatedAt: 200,
          deleted: true,
        },
      ],
      favorites: [
        { key: 'ch-1', updatedAt: 300 },
        { key: 'ch-2', updatedAt: 350, deleted: true },
      ],
      hiddenChannels: [{ key: 'ch-9', updatedAt: 100 }],
      pinnedChannels: [{ key: 'ch-1', updatedAt: 300 }],
      customGroups: [
        { id: 'grp-1', name: 'Sports', channelKeys: ['ch-1'], sortOrder: 1, updatedAt: 300 },
      ],
      collections: [{ id: 'col-1', name: 'Weekend', itemKeys: ['vod-1'], updatedAt: 250 }],
      watchProgress: [
        {
          key: 'vod-1',
          positionMs: 120_000,
          durationMs: 3_600_000,
          completed: false,
          updatedAt: 450,
        },
      ],
      watchedEpisodesBitfields: [
        { seriesKey: 'ser-1', bitsB64: encodeEpisodeBitfield([0, 1, 2]), updatedAt: 400 },
        { seriesKey: 'ser-2', bitsB64: encodeEpisodeBitfield([0]), updatedAt: 100 },
      ],
    };

    const remote: VaultSnapshot = {
      schemaVersion: 1,
      updatedAt: 600,
      sources: [
        {
          id: 'src-1',
          kind: 'xtream',
          name: 'Updated Provider Name',
          url: 'https://provider.example.test',
          username: 'alice',
          password: 'secret',
          updatedAt: 550,
        },
        {
          id: 'src-2',
          kind: 'm3u',
          name: 'Old Playlist',
          url: 'https://old.example.test/list.m3u',
          updatedAt: 200,
        },
      ],
      favorites: [
        { key: 'ch-1', updatedAt: 300 },
        { key: 'ch-2', updatedAt: 300 },
        { key: 'ch-3', updatedAt: 500 },
      ],
      hiddenChannels: [],
      pinnedChannels: [{ key: 'ch-1', updatedAt: 400, deleted: true }],
      customGroups: [
        {
          id: 'grp-1',
          name: 'Sports HD',
          channelKeys: ['ch-1', 'ch-3'],
          sortOrder: 0,
          updatedAt: 450,
        },
      ],
      collections: [{ id: 'col-1', name: 'Weekend', itemKeys: ['vod-1'], updatedAt: 250 }],
      watchProgress: [
        {
          key: 'vod-1',
          positionMs: 900_000,
          durationMs: 3_600_000,
          completed: false,
          updatedAt: 550,
        },
      ],
      watchedEpisodesBitfields: [
        { seriesKey: 'ser-1', bitsB64: encodeEpisodeBitfield([2, 3, 4]), updatedAt: 500 },
        { seriesKey: 'ser-2', bitsB64: '', updatedAt: 200, deleted: true },
      ],
    };

    const mergedLR = mergeVaultSnapshots(local, remote);
    const mergedRL = mergeVaultSnapshots(remote, local);

    // Commutativity & idempotency
    expect(mergedLR).toEqual(mergedRL);
    expect(mergeVaultSnapshots(mergedLR, mergedLR)).toEqual(mergedLR);

    expect(mergedLR.updatedAt).toBe(600);
    // Newer update wins on src-1
    expect(mergedLR.sources.find((s) => s.id === 'src-1')?.name).toBe('Updated Provider Name');
    // Same-timestamp tombstone wins deterministically on src-2
    expect(mergedLR.sources.find((s) => s.id === 'src-2')?.deleted).toBe(true);
    // Newer tombstone wins on ch-2 favorite & ch-1 pin
    expect(mergedLR.favorites.find((f) => f.key === 'ch-2')?.deleted).toBe(true);
    expect(mergedLR.favorites.find((f) => f.key === 'ch-3')?.deleted).toBeUndefined();
    expect(mergedLR.pinnedChannels.find((p) => p.key === 'ch-1')?.deleted).toBe(true);
    // Newer progress wins
    expect(mergedLR.watchProgress[0]?.positionMs).toBe(900_000);
    // Active bitfields union across devices, while newer tombstone clears ser-2
    const ser1 = mergedLR.watchedEpisodesBitfields.find((b) => b.seriesKey === 'ser-1');
    expect(decodeEpisodeBitfield(ser1?.bitsB64 ?? '')).toEqual([0, 1, 2, 3, 4]);
    const ser2 = mergedLR.watchedEpisodesBitfields.find((b) => b.seriesKey === 'ser-2');
    expect(ser2?.deleted).toBe(true);
  });
});
