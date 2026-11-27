import { type CatalogService, pinSecretKey, secretKey } from '@elv/data';
import { ok, type SecretStore } from '@elv/domain';
import {
  createEmptyVaultSnapshot,
  decodeEpisodeBitfield,
  encodeEpisodeBitfield,
  type VaultSnapshot,
} from '@elv/sync';
import { describe, expect, it, vi } from 'vitest';
import { createTvMobileCatalogSnapshotBridge } from './catalog-snapshot';
import { reconcileLocalSnapshotWithBaseline } from './snapshot-tombstones';

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

describe('createTvMobileCatalogSnapshotBridge VaultSnapshot v2 (#510)', () => {
  it('exports and applies full VaultSnapshot v2 (profiles+PIN in SecretStore, Stalker + existing source LWW updates, multi-profile favorites+sortOrder, completed progress+bitfields+dismissals, empty/reconciled collections)', async () => {
    const secrets = makeMemorySecrets({
      [pinSecretKey('kids')]: 'pbkdf2$100000$s1$h1',
      [secretKey('st-1', 'stalker')]: JSON.stringify({
        portalUrl: 'https://stalker.example.test/c/',
        mac: '00:1A:79:11:22:33',
        serialNumber: 'SER-1',
      }),
      [secretKey('xt-1', 'xtream')]: JSON.stringify({
        server: 'https://xt.example.test',
        username: 'u1',
        password: 'p1',
        backupServers: ['https://bk1.example.test'],
      }),
    });

    const createProfile = vi.fn(async (input) =>
      ok({ ...input, isDefault: false, createdAt: 1, updatedAt: 1 }),
    );
    const updateProfile = vi.fn(async (id, patch) =>
      ok({ id, ...patch, isDefault: false, createdAt: 1, updatedAt: 2 }),
    );
    const updateParentalSettings = vi.fn(async (patch, profileId) =>
      ok({ profileId: profileId ?? 'default', ...patch }),
    );
    const renameSource = vi.fn(async (id, name) =>
      ok({ id, kind: 'xtream', name, createdAt: 100, needsImport: false }),
    );
    const setSourceExcludedProfiles = vi.fn(async () => ok({} as never));
    const updateSourceSettings = vi.fn(async () => ok(undefined));
    const addSource = vi.fn(async (input) =>
      ok({ id: 'added-st', kind: input.kind, name: input.name, createdAt: 100, needsImport: true }),
    );
    const reorderFavorites = vi.fn(async () => ok(undefined));
    const removeItemFromCollection = vi.fn(async () => ok(undefined));
    const addItemToCollection = vi.fn(async () => ok(undefined));
    const reorderCollectionItems = vi.fn(async () => ok(undefined));
    const applyWatchedEpisodeBitfield = vi.fn(async () => ok(2));
    const setContinueWatchingDismissal = vi.fn(async () => ok(undefined));

    const catalog = {
      listProfiles: vi.fn(async () => [
        {
          id: 'default',
          name: 'Main',
          avatarToken: 'crimson',
          isKids: false,
          isDefault: true,
          createdAt: 0,
          updatedAt: 100,
        },
        {
          id: 'kids',
          name: 'Kids',
          avatarToken: 'emerald',
          isKids: true,
          isDefault: false,
          createdAt: 10,
          updatedAt: 200,
        },
      ]),
      createProfile,
      updateProfile,
      getParentalSettings: vi.fn(async (pid?: string) => ({
        profileId: pid ?? 'default',
        enabled: pid === 'kids',
        blockAdultKeywords: true,
        maxRatingAge: pid === 'kids' ? 12 : null,
        unlockTimeoutMin: 30,
        updatedAt: 200,
      })),
      updateParentalSettings,
      listSources: vi.fn(async () => [
        { id: 'xt-1', kind: 'xtream', name: 'Old Xtream', createdAt: 100, needsImport: false },
        { id: 'st-1', kind: 'stalker', name: 'Stalker', createdAt: 100, needsImport: false },
      ]),
      listSourceRecords: vi.fn(async () => [
        {
          id: 'xt-1',
          kind: 'xtream',
          name: 'Old Xtream',
          createdAt: 100,
          settings: {
            excludedProfileIds: ['kids'],
            epgShiftMs: 1_800_000,
            xmltvTimezone: 'UTC',
            categorySelection: { live: ['News'] },
            transport: { xtreamFormat: 'ts' },
          },
        },
        { id: 'st-1', kind: 'stalker', name: 'Stalker', createdAt: 100, settings: {} },
      ]),
      addSource,
      renameSource,
      setSourceExcludedProfiles,
      updateSourceSettings,
      listFavorites: vi.fn(async (_limit, pid?: string) =>
        pid === 'kids'
          ? [
              {
                profileId: 'kids',
                sourceId: 'xt-1',
                itemKey: 'x:xt-1:live:5',
                kind: 'live',
                title: 'Kids TV',
                logo: null,
                year: null,
                rating: null,
                addedAt: 300,
                sortOrder: 0,
              },
            ]
          : [],
      ),
      listFavoriteKeys: vi.fn(async (pid?: string) =>
        pid === 'kids' ? ['x:xt-1:live:5', 'x:xt-1:live:6'] : [],
      ),
      setFavorite: vi.fn(async () => ok(true)),
      reorderFavorites,
      listAllWatchProgress: vi.fn(async (pid?: string) =>
        pid === 'kids'
          ? [
              {
                profileId: 'kids',
                sourceId: 'xt-1',
                itemKey: 'x:xt-1:ep:1',
                kind: 'episode',
                title: 'Ep 1',
                subtitle: null,
                logo: null,
                seriesKey: 'x:xt-1:series:2',
                season: 2,
                episode: 4,
                positionMs: 1_200_000,
                durationMs: 1_200_000,
                watched: true,
                updatedAt: 500,
              },
            ]
          : [],
      ),
      getProgress: vi.fn(async () => null),
      saveProgress: vi.fn(async () => ok({} as never)),
      applyWatchedEpisodeBitfield,
      listContinueWatchingDismissals: vi.fn(async (pid?: string) =>
        pid === 'default'
          ? [
              {
                profileId: 'default',
                seriesKey: 'x:xt-1:series:8',
                sourceId: 'xt-1',
                dismissedAt: 600,
              },
            ]
          : [],
      ),
      setContinueWatchingDismissal,
      listChannelOverrides: vi.fn(async () => []),
      listCustomGroups: vi.fn(async () => []),
      listCollections: vi.fn(async (pid?: string) =>
        (pid ?? 'default') === 'default'
          ? [
              {
                id: 'c-1',
                profileId: 'default',
                name: 'Empty',
                sortOrder: 0,
                itemCount: 0,
                createdAt: 100,
                updatedAt: 400,
              },
            ]
          : [],
      ),
      listCollectionRawItemKeys: vi.fn(async () => ['x:xt-1:movie:old']),
      removeItemFromCollection,
      addItemToCollection,
      reorderCollectionItems,
      listRatings: vi.fn(async () => []),
      flushPendingWrites: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const bridge = createTvMobileCatalogSnapshotBridge({
      getCatalog: async () => catalog,
      secretStore: secrets.store,
      clock: () => 5000,
    });

    const exported = await bridge.getLocalSnapshot();
    expect(exported.profiles?.find((p) => p.id === 'kids')).toMatchObject({
      pinHash: 'pbkdf2$100000$s1$h1',
      parentalEnabled: true,
      parentalMaxRating: '12',
    });
    expect(exported.sources.find((s) => s.kind === 'stalker')).toMatchObject({
      portalUrl: 'https://stalker.example.test/c/',
      mac: '00:1A:79:11:22:33',
      serialNumber: 'SER-1',
    });
    expect(exported.sources.find((s) => s.id === 'xt-1')?.settings).toMatchObject({
      excludedProfileIds: ['kids'],
      epgShiftMs: 1_800_000,
      backupServers: ['https://bk1.example.test'],
    });
    expect(exported.watchedEpisodesBitfields).toEqual([
      expect.objectContaining({
        profileId: 'kids',
        seriesKey: 'x:xt-1:series:2',
        season: 2,
      }),
    ]);
    expect(decodeEpisodeBitfield(exported.watchedEpisodesBitfields[0]?.bitsB64 ?? '')).toEqual([4]);
    expect(exported.continueWatchingDismissals).toEqual([
      {
        profileId: 'default',
        seriesKey: 'x:xt-1:series:8',
        sourceId: 'xt-1',
        dismissedAt: 600,
        deleted: false,
      },
    ]);

    const reconciled = reconcileLocalSnapshotWithBaseline(
      { ...exported, favorites: [] },
      exported,
      6000,
    );
    expect(reconciled.favorites).toEqual([
      expect.objectContaining({
        key: 'x:xt-1:live:5',
        profileId: 'kids',
        deleted: true,
        updatedAt: 6000,
      }),
    ]);

    const incoming: VaultSnapshot = {
      ...createEmptyVaultSnapshot(9000),
      profiles: [
        {
          id: 'guest',
          name: 'Guest',
          avatarToken: 'teal',
          isKids: false,
          isDefault: false,
          updatedAt: 8000,
          deleted: false,
          pinHash: 'pbkdf2$100000$sg$hg',
          parentalEnabled: true,
          parentalMaxRating: '16',
        },
      ],
      sources: [
        {
          id: 'xt-1',
          kind: 'xtream',
          name: 'Renamed Xtream',
          url: 'https://xt.example.test',
          username: 'u1',
          password: 'p1',
          updatedAt: 8500,
          settings: {
            excludedProfileIds: [],
            epgShiftMs: -3_600_000,
            backupServers: ['https://bk2.example.test'],
          },
        },
        {
          id: 'st-new',
          kind: 'stalker',
          name: 'New Portal',
          url: 'https://portal2.example.test/c/',
          portalUrl: 'https://portal2.example.test/c/',
          mac: '00:1A:79:44:55:66',
          updatedAt: 8500,
        },
      ],
      favorites: [
        { key: 'x:xt-1:live:6', profileId: 'kids', sortOrder: 0, updatedAt: 8000 },
        { key: 'x:xt-1:live:5', profileId: 'kids', sortOrder: 1, updatedAt: 8000 },
      ],
      collections: [
        {
          id: 'c-1',
          name: 'Empty',
          itemKeys: ['x:xt-1:movie:new'],
          sortOrder: 0,
          updatedAt: 8500,
        },
      ],
      watchedEpisodesBitfields: [
        {
          profileId: 'kids',
          seriesKey: 'x:xt-1:series:2',
          season: 2,
          bitsB64: encodeEpisodeBitfield([1, 2]),
          updatedAt: 8500,
        },
      ],
      continueWatchingDismissals: [
        {
          profileId: 'default',
          seriesKey: 'x:xt-1:series:99',
          sourceId: 'xt-1',
          dismissedAt: 8500,
          deleted: false,
        },
      ],
    };

    await bridge.applyMergedSnapshot(incoming);
    expect(createProfile).toHaveBeenCalledWith({
      id: 'guest',
      name: 'Guest',
      avatarToken: 'teal',
      isKids: false,
    });
    expect(secrets.data.get(pinSecretKey('guest'))).toBe('pbkdf2$100000$sg$hg');
    expect(renameSource).toHaveBeenCalledWith('xt-1', 'Renamed Xtream');
    expect(setSourceExcludedProfiles).toHaveBeenCalledWith('xt-1', []);
    expect(updateSourceSettings).toHaveBeenCalledWith(
      'xt-1',
      expect.objectContaining({ epgShiftMs: -3_600_000 }),
    );
    expect(JSON.parse(secrets.data.get(secretKey('xt-1', 'xtream')) ?? '{}').backupServers).toEqual(
      ['https://bk2.example.test'],
    );
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'st-new',
        kind: 'stalker',
        portalUrl: 'https://portal2.example.test/c/',
        mac: '00:1A:79:44:55:66',
      }),
    );
    expect(reorderFavorites).toHaveBeenCalledWith(['x:xt-1:live:6', 'x:xt-1:live:5'], 'kids');
    expect(removeItemFromCollection).toHaveBeenCalledWith('c-1', 'x:xt-1:movie:old', 'default');
    expect(addItemToCollection).toHaveBeenCalledWith('c-1', 'x:xt-1:movie:new', 'movie', 'default');
    expect(applyWatchedEpisodeBitfield).toHaveBeenCalledWith({
      profileId: 'kids',
      seriesKey: 'x:xt-1:series:2',
      season: 2,
      episodeIndices: [1, 2],
      updatedAt: 8500,
    });
    expect(setContinueWatchingDismissal).toHaveBeenCalledWith(
      { profileId: 'default', seriesKey: 'x:xt-1:series:99', sourceId: 'xt-1', dismissedAt: 8500 },
      false,
    );
  });

  it('preserves explicit source/custom-group IDs, applies LWW updates even when local createdAt is newer, and suppresses no-op onApplied (P1-1, P1-9)', async () => {
    const secrets = makeMemorySecrets({
      [secretKey('src_keep_1', 'xtream')]: JSON.stringify({
        server: 'https://xt.example.test',
        username: 'u1',
        password: 'p1',
      }),
    });
    const onApplied = vi.fn();
    const addSource = vi.fn(async (input) =>
      ok({
        id: input.id ?? 'generated',
        kind: input.kind,
        name: input.name,
        createdAt: 99_000,
        needsImport: true,
      }),
    );
    const renameSource = vi.fn(async (id, name) =>
      ok({ id, kind: 'xtream', name, createdAt: 99_000, needsImport: false }),
    );
    const createCustomGroup = vi.fn(async (input) =>
      ok({
        id: input.id ?? 'gen_grp',
        profileId: input.profileId ?? 'default',
        name: input.name,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const setCustomGroupItems = vi.fn(async () => ok(undefined));
    const clearProgress = vi.fn(async () => ok(undefined));
    const setContinueWatchingDismissal = vi.fn(async () => ok(undefined));

    let sourceName = 'Old Name';
    let groupExists = false;
    const catalog = {
      listProfiles: vi.fn(async () => [
        {
          id: 'default',
          name: 'Main',
          avatarToken: 'crimson',
          isKids: false,
          isDefault: true,
          createdAt: 0,
          updatedAt: 100,
        },
      ]),
      getParentalSettings: vi.fn(async () => ({
        profileId: 'default',
        enabled: false,
        blockAdultKeywords: true,
        maxRatingAge: null,
        unlockTimeoutMin: 30,
        updatedAt: 100,
      })),
      listSources: vi.fn(async () => [
        {
          id: 'src_keep_1',
          kind: 'xtream',
          name: sourceName,
          createdAt: 99_000,
          needsImport: false,
        },
      ]),
      listSourceRecords: vi.fn(async () => [
        {
          id: 'src_keep_1',
          kind: 'xtream',
          name: sourceName,
          createdAt: 99_000,
          settings: { excludedProfileIds: [], epgShiftMs: 0 },
        },
      ]),
      addSource,
      renameSource: vi.fn(async (id, name) => {
        sourceName = name;
        return renameSource(id, name);
      }),
      setSourceExcludedProfiles: vi.fn(async () => ok({} as never)),
      updateSourceSettings: vi.fn(async () => ok(undefined)),
      listFavorites: vi.fn(async () => []),
      listFavoriteKeys: vi.fn(async () => []),
      setFavorite: vi.fn(async () => ok(true)),
      listAllWatchProgress: vi.fn(async () => []),
      getProgress: vi.fn(async () => null),
      saveProgress: vi.fn(async () => ok({} as never)),
      clearProgress,
      listContinueWatchingDismissals: vi.fn(async () => [
        {
          profileId: 'default',
          seriesKey: 'x:src_keep_1:series:5',
          sourceId: 'src_keep_1',
          dismissedAt: 4_000,
        },
      ]),
      setContinueWatchingDismissal,
      listChannelOverrides: vi.fn(async () => []),
      listCustomGroups: vi.fn(async () =>
        groupExists
          ? [
              {
                id: 'grp_exact_7',
                profileId: 'default',
                name: 'News',
                sortOrder: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ]
          : [],
      ),
      createCustomGroup: vi.fn(async (input) => {
        groupExists = true;
        return createCustomGroup(input);
      }),
      updateCustomGroup: vi.fn(async () => ok({} as never)),
      setCustomGroupItems,
      items: vi.fn(async () => [{ key: 'x:src_keep_1:live:1' }]),
      listCollections: vi.fn(async () => []),
      listRatings: vi.fn(async () => []),
      flushPendingWrites: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const bridge = createTvMobileCatalogSnapshotBridge({
      getCatalog: async () => catalog,
      secretStore: secrets.store,
      clock: () => 50_000,
      onApplied,
    });

    const snap: VaultSnapshot = {
      ...createEmptyVaultSnapshot(5_000),
      sources: [
        {
          id: 'src_keep_1',
          kind: 'xtream',
          name: 'Remote Renamed',
          url: 'https://xt.example.test',
          username: 'u1',
          password: 'p1',
          updatedAt: 5_000,
        },
        {
          id: 'src_new_m3u',
          kind: 'm3u',
          name: 'M3U Feed',
          url: 'https://m3u.example.test/list.m3u',
          updatedAt: 5_000,
        },
      ],
      customGroups: [
        {
          id: 'grp_exact_7',
          name: 'News',
          channelKeys: ['x:src_keep_1:live:1'],
          sortOrder: 0,
          updatedAt: 5_000,
        },
      ],
      watchProgress: [
        {
          key: 'x:src_keep_1:movie:absent',
          positionMs: 0,
          durationMs: 0,
          completed: false,
          updatedAt: 5_000,
          deleted: true,
        },
      ],
      continueWatchingDismissals: [
        {
          profileId: 'default',
          seriesKey: 'x:src_keep_1:series:5',
          sourceId: 'src_keep_1',
          dismissedAt: 4_000,
          deleted: false,
        },
      ],
    };

    await bridge.applyMergedSnapshot(snap);
    expect(renameSource).toHaveBeenCalledWith('src_keep_1', 'Remote Renamed');
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src_new_m3u', kind: 'm3u', name: 'M3U Feed' }),
    );
    expect(createCustomGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'grp_exact_7', name: 'News' }),
    );
    expect(clearProgress).not.toHaveBeenCalled();
    expect(setContinueWatchingDismissal).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledTimes(1);

    // Second apply with identical state is a strict no-op (no onApplied refresh, no redundant writes)
    onApplied.mockClear();
    setCustomGroupItems.mockClear();
    const snapExistingOnly: VaultSnapshot = {
      ...snap,
      sources: snap.sources.slice(0, 1),
    };
    await bridge.applyMergedSnapshot(snapExistingOnly);
    expect(setCustomGroupItems).not.toHaveBeenCalled();
    expect(clearProgress).not.toHaveBeenCalled();
    expect(setContinueWatchingDismissal).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
