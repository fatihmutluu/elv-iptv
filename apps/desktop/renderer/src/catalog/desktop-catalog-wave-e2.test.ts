import type {
  ElvFranchiseLibraryItem,
  ElvGenreBucket,
  ElvItemEnrichment,
  ElvPersonLibraryItem,
  ElvRecommendedItem,
  ElvSearchCandidate,
  ItemRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './index.ts';

function makeMinimalBridge(overrides?: Partial<CatalogBridge>): CatalogBridge {
  const base: CatalogBridge = {
    open: async () => ok(undefined),
    addSource: async () => {
      throw new Error('unused');
    },
    addSourceFromLink: async () => {
      throw new Error('unused');
    },
    removeSource: async () => ok(undefined),
    startImport: () => ({ reqId: 1, result: Promise.reject(new Error('unused')) }),
    cancelImport: () => undefined,
    importGuide: async () => {
      throw new Error('unused');
    },
    listSources: async () => [],
    categories: async () => [],
    items: async () => [],
    itemDetail: async () => null,
    search: async () => ({ live: [], epg: [], movies: [], series: [], episodes: [] }),
    nowNext: async () => [],
    epgWindow: async () => ({}),
    channelByNumber: async () => null,
    seasons: async () => ok([]),
    episodes: async () => [],
    queryNextEpisode: async () => null,
    resolveStream: async () => ok({ url: 'http://127.0.0.1/1.ts', headers: {} }),
    saveProgress: async () => {
      throw new Error('unused');
    },
    setWatched: async () => ok(undefined),
    getProgress: async () => null,
    listContinueWatching: async () => [],
    listProgressByKeys: async () => [],
    clearProgress: async () => ok(undefined),
    toggleFavorite: async () => ok(true),
    setFavorite: async (_i, active) => ok(active),
    listFavorites: async () => [],
    listFavoriteKeys: async () => [],
    onChanged: () => () => undefined,
    onDisconnected: () => () => undefined,
    close: async () => undefined,
  };
  return { ...base, ...overrides };
}

describe('desktop CatalogService Wave E2 ELV bridge adapter (#512)', () => {
  it('forwards all 8 Wave E2 methods, sanitizes strings, and strips non-serializable signals', async () => {
    const item: ItemRow = {
      id: 1,
      key: 'x:s1:movie:1',
      kind: 'movie',
      sourceId: 's1',
      providerId: '1',
      name: 'The Matrix',
      logo: null,
      rating: 8.7,
      year: 1999,
      num: null,
    };
    const enrichment: ElvItemEnrichment = {
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt0133093',
      confidence: 1,
      manualLock: true,
      title: null,
    };
    const genres: ElvGenreBucket[] = [{ id: 'imdb-genre:Action', name: 'Action', count: 5 }];
    const recs: ElvRecommendedItem[] = [{ item, enrichment, score: 0.9, reason: 'top_picks' }];
    const franchise: ElvFranchiseLibraryItem[] = [
      { item, enrichment, franchiseKey: 'matrix', franchiseName: 'The Matrix', franchiseOrder: 1 },
    ];
    const personItems: ElvPersonLibraryItem[] = [
      { item, enrichment, role: 'cast', character: 'Neo' },
    ];
    const candidates: ElvSearchCandidate[] = [
      { imdbId: 'tt0133093', title: 'The Matrix', year: 1999, mediaType: 'movie', posterUrl: null },
    ];

    const seen: Record<string, unknown[][]> = {};
    const record =
      <T>(name: string, value: T) =>
      async (...args: unknown[]): Promise<T> => {
        const list = seen[name] ?? [];
        list.push(args);
        seen[name] = list;
        return value;
      };

    const bridge = makeMinimalBridge({
      listElvImdbGenres: record('listElvImdbGenres', genres),
      listElvItemsByImdbGenre: record('listElvItemsByImdbGenre', [item]),
      getElvRecommendations: record('getElvRecommendations', recs),
      refreshElvFeeds: record('refreshElvFeeds', true),
      listElvFranchiseItems: record('listElvFranchiseItems', franchise),
      listElvPersonLibraryItems: record('listElvPersonLibraryItems', personItems),
      searchElvMatchCandidates: record('searchElvMatchCandidates', candidates),
      applyElvFixMatch: record('applyElvFixMatch', enrichment),
    });

    const service = createDesktopCatalogFromBridge(bridge);
    const ctl = new AbortController();

    expect(
      await service.listElvImdbGenres?.('movie', {
        excludedSourceIds: ['s2'],
        profileId: 'kids',
        parentalUnlocked: false,
      }),
    ).toEqual(genres);
    expect(seen['listElvImdbGenres']).toEqual([
      ['movie', { excludedSourceIds: ['s2'], profileId: 'kids', parentalUnlocked: false }],
    ]);
    expect(
      await service.listElvItemsByImdbGenre?.('movie', 'Action\n', {
        offset: 0,
        limit: 20,
        sortBy: 'alpha',
      }),
    ).toEqual([item]);
    expect(seen['listElvItemsByImdbGenre']).toEqual([
      ['movie', 'Action', { offset: 0, limit: 20, sortBy: 'alpha' }],
    ]);

    expect(
      await service.getElvRecommendations?.({ profile: 'elv_picks', kind: 'movie', limit: 24 }),
    ).toEqual(recs);

    expect(await service.refreshElvFeeds?.({ force: true, signal: ctl.signal })).toBe(true);
    expect(seen['refreshElvFeeds']).toEqual([[{ force: true }]]);

    expect(
      await service.listElvFranchiseItems?.('tt0133093', { excludedSourceIds: ['s2'] }),
    ).toEqual(franchise);

    expect(
      await service.listElvPersonLibraryItems?.(
        { personId: 'nm0000206', name: 'Keanu\tReeves\n' },
        { limit: 10 },
      ),
    ).toEqual(personItems);
    expect(seen['listElvPersonLibraryItems']).toEqual([
      [{ personId: 'nm0000206', name: 'Keanu Reeves' }, { limit: 10 }],
    ]);

    expect(
      await service.searchElvMatchCandidates?.('The\tMatrix\n', 'movie', { signal: ctl.signal }),
    ).toEqual(candidates);
    expect(seen['searchElvMatchCandidates']).toEqual([['The Matrix', 'movie']]);

    expect(
      await service.applyElvFixMatch?.({
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0133093',
        lang: 'tr',
      }),
    ).toEqual(enrichment);

    // Pre-aborted signals return immediately without calling bridge
    ctl.abort();
    expect(await service.refreshElvFeeds?.({ signal: ctl.signal })).toBe(false);
    expect(
      await service.searchElvMatchCandidates?.('Matrix', 'movie', { signal: ctl.signal }),
    ).toEqual([]);
    expect(seen['refreshElvFeeds']).toHaveLength(1);
    expect(seen['searchElvMatchCandidates']).toHaveLength(1);
  });

  it('falls back safely when legacy bridge omits optional Wave E2 methods', async () => {
    const legacy = createDesktopCatalogFromBridge(makeMinimalBridge());
    expect(await legacy.listElvImdbGenres?.('movie')).toEqual([]);
    expect(await legacy.listElvItemsByImdbGenre?.('movie', 'Action')).toEqual([]);
    expect(await legacy.getElvRecommendations?.({ profile: 'home' })).toEqual([]);
    expect(await legacy.refreshElvFeeds?.()).toBe(false);
    expect(await legacy.listElvFranchiseItems?.('tt0133093')).toEqual([]);
    expect(await legacy.listElvPersonLibraryItems?.({ name: 'Keanu Reeves' })).toEqual([]);
    expect(await legacy.searchElvMatchCandidates?.('Matrix', 'movie')).toEqual([]);
    expect(
      await legacy.applyElvFixMatch?.({
        itemKey: 'x:s1:movie:1',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt0133093',
      }),
    ).toBeNull();
  });
});
