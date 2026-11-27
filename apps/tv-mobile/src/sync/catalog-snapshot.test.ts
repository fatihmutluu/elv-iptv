import { type CatalogService, secretKey } from '@elv/data';
import { ok, type SecretStore } from '@elv/domain';
import { createEmptyVaultSnapshot, type VaultSnapshot } from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';
import { createTvMobileCatalogSnapshotBridge } from './catalog-snapshot';

function makeMemorySecrets(initial: Record<string, string> = {}): {
  store: SecretStore;
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
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

describe('createTvMobileCatalogSnapshotBridge (HIGH #9)', () => {
  it('exports real sources (credentials via SecretStore only), favorites, hidden channels, custom groups, collections, and progress', async () => {
    const secrets = makeMemorySecrets({
      [secretKey('src-x', 'xtream')]: JSON.stringify({
        server: 'https://xtream.example.test',
        username: 'demo_user',
        password: 'demo_password',
      }),
      [secretKey('src-x', 'urlvars')]: JSON.stringify({
        'g:url': 'https://epg.example.test/guide.xml',
      }),
      [secretKey('src-m', 'playlist')]: 'https://m3u.example.test/list.m3u',
    });

    const catalog = {
      listSources: vi.fn(async () => [
        { id: 'src-x', kind: 'xtream', name: 'Main Xtream', createdAt: 1000, needsImport: false },
        { id: 'src-m', kind: 'm3u', name: 'News M3U', createdAt: 2000, needsImport: false },
        {
          id: 'src-local',
          kind: 'm3u',
          name: 'Local File',
          createdAt: 3000,
          needsImport: false,
          isLocalPlaylist: true,
        },
      ]),
      listFavorites: vi.fn(async () => [
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:live:101',
          kind: 'live',
          title: 'Channel 101',
          logo: null,
          year: null,
          rating: null,
          addedAt: 4000,
        },
      ]),
      listContinueWatching: vi.fn(async () => [
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:movie:501',
          kind: 'movie',
          title: 'Space Movie',
          subtitle: null,
          logo: null,
          seriesKey: null,
          season: null,
          episode: null,
          positionMs: 120_000,
          durationMs: 3_600_000,
          watched: false,
          updatedAt: 5000,
        },
      ]),
      listChannelOverrides: vi.fn(async () => [
        {
          profileId: 'default',
          itemKey: 'x:src-x:live:999',
          sourceId: 'src-x',
          customName: null,
          isHidden: true,
          sortOrder: null,
          updatedAt: 6000,
        },
      ]),
      listCustomGroups: vi.fn(async () => [
        {
          id: 'grp-1',
          profileId: 'default',
          name: 'Sports',
          sortOrder: 0,
          isHidden: false,
          itemCount: 1,
          updatedAt: 7000,
        },
      ]),
      items: vi.fn(async () => [{ key: 'x:src-x:live:101' }]),
      listCollections: vi.fn(async () => [
        {
          id: 'col-1',
          profileId: 'default',
          name: 'Weekend',
          sortOrder: 0,
          itemCount: 1,
          createdAt: 7500,
          updatedAt: 8000,
        },
      ]),
      listCollectionItems: vi.fn(async () => [{ key: 'x:src-x:movie:501' }]),
    } as unknown as CatalogService;

    const bridge = createTvMobileCatalogSnapshotBridge({
      getCatalog: async () => catalog,
      secretStore: secrets.store,
      clock: () => 9999,
    });

    const snap = await bridge.getLocalSnapshot();
    expect(snap.updatedAt).toBe(9999);
    expect(snap.sources).toEqual([
      {
        id: 'src-x',
        kind: 'xtream',
        name: 'Main Xtream',
        url: 'https://xtream.example.test',
        username: 'demo_user',
        password: 'demo_password',
        epgUrl: 'https://epg.example.test/guide.xml',
        updatedAt: 1000,
      },
      {
        id: 'src-m',
        kind: 'm3u',
        name: 'News M3U',
        url: 'https://m3u.example.test/list.m3u',
        updatedAt: 2000,
      },
    ]);
    expect(snap.favorites).toEqual([{ key: 'x:src-x:live:101', updatedAt: 4000 }]);
    expect(snap.hiddenChannels).toEqual([{ key: 'x:src-x:live:999', updatedAt: 6000 }]);
    expect(snap.customGroups).toEqual([
      {
        id: 'grp-1',
        name: 'Sports',
        channelKeys: ['x:src-x:live:101'],
        sortOrder: 0,
        updatedAt: 7000,
      },
    ]);
    expect(snap.collections).toEqual([
      {
        id: 'col-1',
        name: 'Weekend',
        itemKeys: ['x:src-x:movie:501'],
        sortOrder: 0,
        updatedAt: 8000,
      },
    ]);
    expect(snap.watchProgress).toEqual([
      {
        key: 'x:src-x:movie:501',
        positionMs: 120_000,
        durationMs: 3_600_000,
        completed: false,
        updatedAt: 5000,
      },
    ]);
  });

  it('applies merged remote snapshot safely via CatalogService (deduplicating sources, respecting tombstones & LWW progress)', async () => {
    const secrets = makeMemorySecrets({
      [secretKey('local-existing', 'playlist')]: 'https://existing.example.test/list.m3u',
    });
    const onApplied = vi.fn();
    const addSource = vi.fn(async () =>
      ok({
        id: 'new-1',
        kind: 'xtream' as const,
        name: 'Synced Xtream',
        createdAt: 100,
        needsImport: true,
        lastCatalogSyncAt: null,
        lastGuideSyncAt: null,
      }),
    );
    const removeSource = vi.fn(async () => ok(undefined));
    const setFavorite = vi.fn(async () => ok(true));
    const setChannelOverride = vi.fn(async () => ok({} as never));
    const saveProgress = vi.fn(async () => ok({} as never));
    const clearProgress = vi.fn(async () => ok(undefined));
    const flushPendingWrites = vi.fn(async () => undefined);

    const catalog = {
      listSources: vi.fn(async () => [
        { id: 'local-existing', kind: 'm3u', name: 'Existing', createdAt: 10, needsImport: false },
        { id: 'removed-src', kind: 'm3u', name: 'Old', createdAt: 10, needsImport: false },
      ]),
      addSource,
      removeSource,
      listFavoriteKeys: vi.fn(async () => ['x:s1:live:drop']),
      setFavorite,
      itemDetail: vi.fn(async () => null),
      listChannelOverrides: vi.fn(async () => []),
      setChannelOverride,
      listCustomGroups: vi.fn(async () => []),
      createCustomGroup: vi.fn(async () =>
        ok({
          id: 'g-new',
          profileId: 'default',
          name: 'Kids',
          sortOrder: 1,
          isHidden: false,
          itemCount: 0,
          updatedAt: 100,
        }),
      ),
      setCustomGroupItems: vi.fn(async () => ok(undefined)),
      listCollections: vi.fn(async () => []),
      createCollection: vi.fn(async () =>
        ok({
          id: 'c-new',
          profileId: 'default',
          name: 'Sci-Fi',
          sortOrder: 0,
          itemCount: 0,
          createdAt: 100,
          updatedAt: 100,
        }),
      ),
      addItemToCollection: vi.fn(async () => ok(undefined)),
      getProgress: vi.fn(async (key: string) =>
        key === 'x:s1:movie:stale' || key === 'x:s1:movie:cleared'
          ? {
              profileId: 'default',
              sourceId: 's1',
              itemKey: key,
              kind: 'movie',
              title: key === 'x:s1:movie:stale' ? 'Stale' : 'Cleared',
              subtitle: null,
              logo: null,
              seriesKey: null,
              season: null,
              episode: null,
              positionMs: 900_000,
              durationMs: 1_000_000,
              watched: false,
              updatedAt: key === 'x:s1:movie:stale' ? 9_000 : 4_000,
            }
          : null,
      ),
      saveProgress,
      clearProgress,
      flushPendingWrites,
    } as unknown as CatalogService;

    const merged: VaultSnapshot = {
      ...createEmptyVaultSnapshot(10_000),
      sources: [
        // Duplicate URL -> skipped
        {
          id: 'remote-dup',
          kind: 'm3u',
          name: 'Existing Remote',
          url: 'https://existing.example.test/list.m3u/',
          updatedAt: 500,
        },
        // New Xtream source -> added via addSource (secrets -> SecretStore only)
        {
          id: 'remote-x',
          kind: 'xtream',
          name: 'Synced Xtream',
          url: 'https://new.example.test',
          username: 'u1',
          password: 'p1',
          epgUrl: 'https://new.example.test/xmltv.php',
          updatedAt: 600,
        },
        // Tombstone for local source -> removed
        {
          id: 'removed-src',
          kind: 'm3u',
          name: 'Old',
          url: 'https://old.example.test/a.m3u',
          updatedAt: 700,
          deleted: true,
        },
      ],
      favorites: [
        { key: 'x:s1:live:keep', updatedAt: 800 },
        { key: 'x:s1:live:drop', updatedAt: 900, deleted: true },
      ],
      hiddenChannels: [{ key: 'x:s1:live:hide1', updatedAt: 850 }],
      watchProgress: [
        {
          key: 'x:s1:movie:fresh',
          positionMs: 45_000,
          durationMs: 3_600_000,
          completed: false,
          updatedAt: 5000,
        },
        // Older than local updatedAt=9000 -> skipped!
        {
          key: 'x:s1:movie:stale',
          positionMs: 10_000,
          durationMs: 1_000_000,
          completed: false,
          updatedAt: 2000,
        },
        {
          key: 'x:s1:movie:cleared',
          positionMs: 0,
          durationMs: 0,
          completed: false,
          updatedAt: 6000,
          deleted: true,
        },
      ],
    };

    const bridge = createTvMobileCatalogSnapshotBridge({
      getCatalog: async () => catalog,
      secretStore: secrets.store,
      onApplied,
    });

    await bridge.applyMergedSnapshot(merged);

    expect(addSource).toHaveBeenCalledTimes(1);
    expect(addSource).toHaveBeenCalledWith({
      id: 'remote-x',
      kind: 'xtream',
      name: 'Synced Xtream',
      server: 'https://new.example.test',
      username: 'u1',
      password: 'p1',
      guideUrl: 'https://new.example.test/xmltv.php',
    });
    expect(removeSource).toHaveBeenCalledWith('removed-src');
    expect(setFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 's1', itemKey: 'x:s1:live:keep', kind: 'live' }),
      true,
    );
    expect(setFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'x:s1:live:drop' }),
      false,
    );
    expect(setChannelOverride).toHaveBeenCalledWith({
      itemKey: 'x:s1:live:hide1',
      sourceId: 's1',
      isHidden: true,
    });
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 's1',
        itemKey: 'x:s1:movie:fresh',
        kind: 'movie',
        positionMs: 45_000,
        durationMs: 3_600_000,
        watched: false,
      }),
    );
    expect(clearProgress).toHaveBeenCalledWith('x:s1:movie:cleared');
    expect(flushPendingWrites).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('excludes synthetic Next-Up rows (positionMs <= 0 && !watched) from exported watchProgress (#502)', async () => {
    const secrets = makeMemorySecrets();
    const catalog = {
      listSources: vi.fn(async () => []),
      listFavorites: vi.fn(async () => []),
      listContinueWatching: vi.fn(async () => [
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:ep:102',
          kind: 'episode',
          title: 'Show',
          subtitle: 'S1 · E2 — Next',
          logo: null,
          seriesKey: 'x:src-x:series:1',
          season: 1,
          episode: 2,
          positionMs: 0,
          durationMs: 2_820_000,
          watched: false,
          updatedAt: 5000,
        },
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:movie:501',
          kind: 'movie',
          title: 'Space Movie',
          subtitle: null,
          logo: null,
          seriesKey: null,
          season: null,
          episode: null,
          positionMs: 120_000,
          durationMs: 3_600_000,
          watched: false,
          updatedAt: 4000,
        },
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:ep:101',
          kind: 'episode',
          title: 'Show',
          subtitle: 'Pilot',
          logo: null,
          seriesKey: 'x:src-x:series:1',
          season: 1,
          episode: 1,
          positionMs: 0,
          durationMs: 2_700_000,
          watched: true,
          updatedAt: 3000,
        },
      ]),
      listChannelOverrides: vi.fn(async () => []),
      listCustomGroups: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
    } as unknown as CatalogService;

    const bridge = createTvMobileCatalogSnapshotBridge({
      getCatalog: async () => catalog,
      secretStore: secrets.store,
      clock: () => 9999,
    });

    const snap = await bridge.getLocalSnapshot();
    expect(snap.watchProgress).toEqual([
      {
        key: 'x:src-x:movie:501',
        positionMs: 120_000,
        durationMs: 3_600_000,
        completed: false,
        updatedAt: 4000,
      },
      {
        key: 'x:src-x:ep:101',
        positionMs: 0,
        durationMs: 2_700_000,
        completed: true,
        updatedAt: 3000,
      },
    ]);
  });

  it('exports ratings and applies LWW updates and tombstone deletions cleanly', async () => {
    const secrets = makeMemorySecrets();
    const setRating = vi.fn(async (_input, value) => ok(value));
    const catalog = {
      listSources: vi.fn(async () => []),
      listFavorites: vi.fn(async () => []),
      listContinueWatching: vi.fn(async () => []),
      listChannelOverrides: vi.fn(async () => []),
      listCustomGroups: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      listRatings: vi.fn(async () => [
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:movie:1',
          kind: 'movie' as const,
          value: 'like' as const,
          title: 'Dune',
          logo: 'https://cdn.example/dune.jpg',
          year: 2021,
          rating: 8.3,
          updatedAt: 500,
        },
        {
          profileId: 'default',
          sourceId: 'src-x',
          itemKey: 'x:src-x:series:2',
          kind: 'series' as const,
          value: 'dislike' as const,
          title: 'Dark',
          logo: null,
          year: 2017,
          rating: 8.7,
          updatedAt: 600,
        },
      ]),
      setRating,
      flushPendingWrites: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const onApplied = vi.fn();
    const bridge = createTvMobileCatalogSnapshotBridge({
      getCatalog: async () => catalog,
      secretStore: secrets.store,
      clock: () => 9999,
      onApplied,
    });

    const exported = await bridge.getLocalSnapshot();
    expect(exported.ratings).toEqual([
      {
        key: 'x:src-x:movie:1',
        sourceId: 'src-x',
        kind: 'movie',
        value: 'like',
        title: 'Dune',
        logo: 'https://cdn.example/dune.jpg',
        year: 2021,
        rating: 8.3,
        updatedAt: 500,
      },
      {
        key: 'x:src-x:series:2',
        sourceId: 'src-x',
        kind: 'series',
        value: 'dislike',
        title: 'Dark',
        year: 2017,
        rating: 8.7,
        updatedAt: 600,
      },
    ]);

    const merged: VaultSnapshot = {
      ...createEmptyVaultSnapshot(7000),
      ratings: [
        // Stale update ignored (400 <= 500)
        {
          key: 'x:src-x:movie:1',
          sourceId: 'src-x',
          kind: 'movie',
          value: 'dislike',
          title: 'Dune',
          updatedAt: 400,
        },
        // Newer tombstone deletes existing series rating (700 >= 600)
        {
          key: 'x:src-x:series:2',
          sourceId: 'src-x',
          kind: 'series',
          value: 'dislike',
          title: 'Dark',
          updatedAt: 700,
          deleted: true,
        },
        // New rating inserted
        {
          key: 'x:src-x:movie:3',
          sourceId: 'src-x',
          kind: 'movie',
          value: 'like',
          title: 'Arrival',
          year: 2016,
          rating: 7.9,
          updatedAt: 800,
        },
      ],
    };
    await bridge.applyMergedSnapshot(merged);

    expect(setRating).toHaveBeenCalledTimes(2);
    expect(setRating).toHaveBeenNthCalledWith(
      1,
      { sourceId: 'src-x', itemKey: 'x:src-x:series:2', kind: 'series', title: 'Dark' },
      null,
    );
    expect(setRating).toHaveBeenNthCalledWith(
      2,
      {
        sourceId: 'src-x',
        itemKey: 'x:src-x:movie:3',
        kind: 'movie',
        title: 'Arrival',
        logo: null,
        year: 2016,
        rating: 7.9,
      },
      'like',
    );
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
