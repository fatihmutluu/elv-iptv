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
import { validateAndUpgradeVaultSnapshot } from './vault-validate';

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
      schemaVersion: VAULT_SCHEMA_VERSION,
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
      schemaVersion: VAULT_SCHEMA_VERSION,
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

  it('merges optional initialPreferences by newest initialPreferencesUpdatedAt and preserves when one side omits it', () => {
    const empty = createEmptyVaultSnapshot(100);
    const withOldPrefs: VaultSnapshot = {
      ...empty,
      updatedAt: 200,
      initialPreferences: { themePreset: 'obsidianCrimson', locale: 'en' },
      initialPreferencesUpdatedAt: 150,
    };
    const withNewPrefs: VaultSnapshot = {
      ...empty,
      updatedAt: 250,
      initialPreferences: { themePreset: 'midnightGold', locale: 'tr' },
      initialPreferencesUpdatedAt: 250,
    };

    // Neither has initialPreferences -> omitted
    expect(mergeVaultSnapshots(empty, empty).initialPreferences).toBeUndefined();

    // Only remote has initialPreferences -> remote kept
    const onlyRemote = mergeVaultSnapshots(empty, withOldPrefs);
    expect(onlyRemote.initialPreferences).toEqual(withOldPrefs.initialPreferences);
    expect(onlyRemote.initialPreferencesUpdatedAt).toBe(150);

    // Only local has initialPreferences -> local kept
    const onlyLocal = mergeVaultSnapshots(withOldPrefs, empty);
    expect(onlyLocal.initialPreferences).toEqual(withOldPrefs.initialPreferences);
    expect(onlyLocal.initialPreferencesUpdatedAt).toBe(150);

    // Both have initialPreferences -> newer timestamp wins (commutative)
    const lr = mergeVaultSnapshots(withOldPrefs, withNewPrefs);
    const rl = mergeVaultSnapshots(withNewPrefs, withOldPrefs);
    expect(lr.initialPreferences).toEqual(withNewPrefs.initialPreferences);
    expect(lr.initialPreferencesUpdatedAt).toBe(250);
    expect(rl).toEqual(lr);
  });

  it('omits ratings when merging empty ratings arrays and merges non-empty ratings commutatively', () => {
    const empty = createEmptyVaultSnapshot(100);
    const withEmptyRatings: VaultSnapshot = { ...empty, ratings: [] };

    const mergedBothEmpty = mergeVaultSnapshots(withEmptyRatings, withEmptyRatings);
    expect(mergedBothEmpty.ratings).toBeUndefined();
    expect('ratings' in mergedBothEmpty).toBe(false);

    const mergedOneEmpty = mergeVaultSnapshots(withEmptyRatings, empty);
    expect(mergedOneEmpty.ratings).toBeUndefined();
    expect('ratings' in mergedOneEmpty).toBe(false);

    const withLike: VaultSnapshot = {
      ...empty,
      ratings: [
        {
          key: 'movie:s1:1',
          sourceId: 's1',
          kind: 'movie',
          value: 'like',
          title: 'Dune',
          updatedAt: 200,
        },
      ],
    };
    const mergedNonEmpty = mergeVaultSnapshots(withLike, withEmptyRatings);
    expect(mergedNonEmpty.ratings).toEqual(withLike.ratings);
  });

  it('supports full VaultSnapshot v2 (stalker sources, settings, per-profile flags/progress/bitfields/dismissals/collections/ratings, and encrypted profiles)', () => {
    expect(VAULT_SCHEMA_VERSION).toBe(2);

    const local: VaultSnapshot = {
      ...createEmptyVaultSnapshot(1_000),
      sources: [
        {
          id: 'src-stalker',
          kind: 'stalker',
          name: 'Portal A',
          url: 'https://portal.example.test/c/',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:11:22:33',
          serialNumber: 'SN-123',
          updatedAt: 500,
          settings: {
            excludedProfileIds: ['kids'],
            epgShiftMs: 3_600_000,
            xmltvTimezone: 'Europe/Istanbul',
            categorySelectionJson: '{"live":["cat-1"]}',
            transportJson: '{"timeoutMs":15000}',
            backupServers: ['https://backup1.example.test'],
          },
        },
      ],
      favorites: [
        { key: 'ch-1', sortOrder: 2, profileId: 'default', updatedAt: 400 },
        { key: 'ch-1', sortOrder: 0, profileId: 'kids', updatedAt: 450 },
      ],
      watchProgress: [
        {
          key: 'movie:1',
          positionMs: 7_200_000,
          durationMs: 7_200_000,
          completed: true,
          watched: true,
          profileId: 'default',
          updatedAt: 600,
        },
        {
          key: 'movie:1',
          positionMs: 600_000,
          durationMs: 7_200_000,
          completed: false,
          watched: false,
          profileId: 'kids',
          updatedAt: 550,
        },
      ],
      watchedEpisodesBitfields: [
        {
          profileId: 'default',
          seriesKey: 'ser-1',
          season: 1,
          bitsB64: encodeEpisodeBitfield([0, 1]),
          updatedAt: 400,
        },
        {
          profileId: 'kids',
          seriesKey: 'ser-1',
          season: 1,
          bitsB64: encodeEpisodeBitfield([0]),
          updatedAt: 420,
        },
        {
          profileId: 'default',
          seriesKey: 'ser-1',
          season: 2,
          bitsB64: encodeEpisodeBitfield([3]),
          updatedAt: 410,
        },
      ],
      continueWatchingDismissals: [
        {
          profileId: 'default',
          seriesKey: 's1:series:10',
          sourceId: 's1',
          dismissedAt: 500,
          deleted: false,
        },
        {
          profileId: 'kids',
          seriesKey: 's1:series:10',
          sourceId: 's1',
          dismissedAt: 300,
          deleted: false,
        },
      ],
      collections: [
        {
          id: 'col-a',
          name: 'Action',
          profileId: 'default',
          sortOrder: 0,
          itemKeys: ['vod-1', 'vod-2'],
          updatedAt: 500,
        },
        {
          id: 'col-b',
          name: 'Sci-Fi',
          profileId: 'default',
          sortOrder: 1,
          itemKeys: [],
          updatedAt: 500,
        },
      ],
      ratings: [
        {
          key: 'movie:1',
          sourceId: 's1',
          kind: 'movie',
          value: 'like',
          title: 'Dune',
          profileId: 'default',
          updatedAt: 500,
        },
        {
          key: 'movie:1',
          sourceId: 's1',
          kind: 'movie',
          value: 'dislike',
          title: 'Dune',
          profileId: 'kids',
          updatedAt: 500,
        },
      ],
      profiles: [
        {
          id: 'default',
          name: 'Main',
          avatarToken: 'crimson',
          isKids: false,
          isDefault: true,
          updatedAt: 500,
          deleted: false,
          pinHash: 'v1:salt123:digest123',
          parentalEnabled: false,
          parentalMaxRating: null,
        },
        {
          id: 'kids',
          name: 'Kids',
          avatarToken: 'amber',
          isKids: true,
          isDefault: false,
          updatedAt: 400,
          deleted: false,
          pinHash: null,
          parentalEnabled: true,
          parentalMaxRating: 'PG',
        },
      ],
    };

    const remote: VaultSnapshot = {
      ...createEmptyVaultSnapshot(1_100),
      sources: [
        {
          id: 'src-stalker',
          kind: 'stalker',
          name: 'Portal A Renamed',
          url: 'https://portal.example.test/c/',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:11:22:33',
          updatedAt: 900,
          settings: {
            excludedProfileIds: [],
            epgShiftMs: 0,
          },
        },
      ],
      favorites: [
        // Legacy undefined profileId collides cleanly with 'default' and wins when newer
        { key: 'ch-1', sortOrder: 1, updatedAt: 700 },
      ],
      watchProgress: [],
      watchedEpisodesBitfields: [
        {
          profileId: 'default',
          seriesKey: 'ser-1',
          season: 1,
          bitsB64: encodeEpisodeBitfield([2, 4]),
          updatedAt: 650,
        },
      ],
      continueWatchingDismissals: [
        {
          profileId: 'default',
          seriesKey: 's1:series:10',
          sourceId: 's1',
          dismissedAt: 800,
          deleted: true,
        },
      ],
      collections: [
        // Folder move: vod-2 removed from col-a and added to col-b at newer timestamp
        {
          id: 'col-a',
          name: 'Action',
          profileId: 'default',
          sortOrder: 0,
          itemKeys: ['vod-1'],
          updatedAt: 900,
        },
        {
          id: 'col-b',
          name: 'Sci-Fi',
          profileId: 'default',
          sortOrder: 1,
          itemKeys: ['vod-2'],
          updatedAt: 900,
        },
      ],
      profiles: [
        {
          id: 'kids',
          name: 'Junior',
          avatarToken: 'emerald',
          isKids: true,
          isDefault: false,
          updatedAt: 850,
          deleted: false,
          pinHash: null,
          parentalEnabled: true,
          parentalMaxRating: 'G',
        },
      ],
    };

    const lr = mergeVaultSnapshots(local, remote);
    const rl = mergeVaultSnapshots(remote, local);
    expect(lr).toEqual(rl);

    // Stalker source LWW merge
    expect(lr.sources).toHaveLength(1);
    expect(lr.sources[0]?.name).toBe('Portal A Renamed');
    expect(lr.sources[0]?.settings?.epgShiftMs).toBe(0);

    // Favorites kept per-profile; default updated to sortOrder 1
    expect(lr.favorites).toHaveLength(2);
    expect(lr.favorites.find((f) => (f.profileId ?? 'default') === 'default')?.sortOrder).toBe(1);
    expect(lr.favorites.find((f) => f.profileId === 'kids')?.sortOrder).toBe(0);

    // Watch progress keeps watched flag independently per profile
    expect(lr.watchProgress).toHaveLength(2);
    expect(lr.watchProgress.find((w) => w.profileId === 'default')?.watched).toBe(true);
    expect(lr.watchProgress.find((w) => w.profileId === 'kids')?.watched).toBe(false);

    // Bitfields OR'd per (profileId, seriesKey, season)
    const defS1 = lr.watchedEpisodesBitfields.find(
      (b) => (b.profileId ?? 'default') === 'default' && b.seriesKey === 'ser-1' && b.season === 1,
    );
    expect(decodeEpisodeBitfield(defS1?.bitsB64 ?? '')).toEqual([0, 1, 2, 4]);
    expect(defS1?.updatedAt).toBe(650);
    const kidsS1 = lr.watchedEpisodesBitfields.find(
      (b) => b.profileId === 'kids' && b.seriesKey === 'ser-1' && b.season === 1,
    );
    expect(decodeEpisodeBitfield(kidsS1?.bitsB64 ?? '')).toEqual([0]);
    const defS2 = lr.watchedEpisodesBitfields.find(
      (b) => (b.profileId ?? 'default') === 'default' && b.seriesKey === 'ser-1' && b.season === 2,
    );
    expect(decodeEpisodeBitfield(defS2?.bitsB64 ?? '')).toEqual([3]);

    // Dismissals LWW by dismissedAt per profile
    expect(lr.continueWatchingDismissals).toHaveLength(2);
    expect(lr.continueWatchingDismissals?.find((d) => d.profileId === 'default')?.deleted).toBe(
      true,
    );
    expect(lr.continueWatchingDismissals?.find((d) => d.profileId === 'kids')?.deleted).toBe(false);

    // Collections deterministic LWW itemKeys replacement (folder move propagated!)
    expect(lr.collections.find((c) => c.id === 'col-a')?.itemKeys).toEqual(['vod-1']);
    expect(lr.collections.find((c) => c.id === 'col-b')?.itemKeys).toEqual(['vod-2']);

    // Ratings isolated per profile
    expect(lr.ratings).toHaveLength(2);

    // Profiles LWW by updatedAt
    expect(lr.profiles).toHaveLength(2);
    expect(lr.profiles?.find((p) => p.id === 'kids')?.name).toBe('Junior');
    expect(lr.profiles?.find((p) => p.id === 'kids')?.parentalMaxRating).toBe('G');
    expect(lr.profiles?.find((p) => p.id === 'default')?.pinHash).toBe('v1:salt123:digest123');
  });

  it('merges liveFavoriteFolders with LWW and tombstone semantics while staying backwards compatible (Wave Q7-B)', () => {
    const legacy = createEmptyVaultSnapshot(100);
    expect(legacy.liveFavoriteFolders).toBeUndefined();

    const local: VaultSnapshot = {
      ...createEmptyVaultSnapshot(500),
      liveFavoriteFolders: [
        {
          id: 'lff_sports',
          name: 'Sports',
          channelKeys: ['x:s1:live:1', 'x:s2:live:10'],
          sortOrder: 0,
          updatedAt: 300,
        },
        {
          id: 'lff_news',
          name: 'News',
          channelKeys: ['x:s1:live:2'],
          sortOrder: 1,
          updatedAt: 400,
        },
      ],
    };
    const remote: VaultSnapshot = {
      ...createEmptyVaultSnapshot(600),
      liveFavoriteFolders: [
        {
          id: 'lff_sports',
          name: 'Live Sports',
          channelKeys: ['x:s2:live:10'],
          sortOrder: 0,
          updatedAt: 550,
        },
        {
          id: 'lff_news',
          name: 'News',
          channelKeys: [],
          sortOrder: 1,
          updatedAt: 580,
          deleted: true,
        },
        {
          id: 'lff_kids',
          name: 'Cartoons',
          channelKeys: ['x:s1:live:9'],
          sortOrder: 0,
          profileId: 'kids',
          updatedAt: 520,
        },
      ],
    };

    const lr = mergeVaultSnapshots(local, remote);
    const rl = mergeVaultSnapshots(remote, local);
    expect(lr).toEqual(rl);
    expect(lr.liveFavoriteFolders).toHaveLength(3);
    expect(lr.liveFavoriteFolders?.find((f) => f.id === 'lff_sports')).toMatchObject({
      name: 'Live Sports',
      channelKeys: ['x:s2:live:10'],
      updatedAt: 550,
    });
    expect(lr.liveFavoriteFolders?.find((f) => f.id === 'lff_news')?.deleted).toBe(true);
    expect(lr.liveFavoriteFolders?.find((f) => f.id === 'lff_kids')?.profileId).toBe('kids');

    // Backwards-compatible merge with legacy snapshot (undefined liveFavoriteFolders)
    expect(mergeVaultSnapshots(legacy, remote).liveFavoriteFolders).toEqual(
      [...(remote.liveFavoriteFolders ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    );

    // Validator accepts valid liveFavoriteFolders and rejects malformed payloads
    expect(validateAndUpgradeVaultSnapshot(lr).liveFavoriteFolders).toEqual(lr.liveFavoriteFolders);
    expect(() =>
      validateAndUpgradeVaultSnapshot({
        ...createEmptyVaultSnapshot(100),
        liveFavoriteFolders: [{ id: '', name: 'Bad', channelKeys: [], sortOrder: 0, updatedAt: 1 }],
      }),
    ).toThrow('Invalid vault snapshot structure');
    expect(() =>
      validateAndUpgradeVaultSnapshot({
        ...createEmptyVaultSnapshot(100),
        liveFavoriteFolders: [
          { id: 'f1', name: 'Bad', channelKeys: [123], sortOrder: 0, updatedAt: 1 },
        ],
      }),
    ).toThrow('Invalid vault snapshot structure');
  });
});
