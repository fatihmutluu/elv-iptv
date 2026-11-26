import type {
  CategoryRow,
  EpisodeRow,
  FavoriteRow,
  ItemRow,
  NowNextEntry,
  ProgrammeRow,
  SearchResults,
  WatchProgressRow,
} from '@elv/data';
import { describe, expect, it } from 'vitest';
import type { DisplayCategory } from './catalog-helpers';
import {
  type CachedDetailEntry,
  type CachedHomeSnapshot,
  createCatalogUiCache,
  LIVE_CHANNEL_ROWS_CAP,
  MAX_CATALOG_RAIL_CATEGORIES,
  MAX_CATALOG_RAIL_ITEMS,
  MAX_DETAIL_ENTRIES,
  MAX_GRID_FIRST_PAGES,
  MAX_LIVE_CHANNEL_CATEGORIES,
} from './catalog-ui-cache';

function makeCategory(
  sourceId: string,
  kind: 'live' | 'movie' | 'series',
  idx: number,
): DisplayCategory {
  const row: CategoryRow = {
    id: `${sourceId}|${kind}|cat-${idx}`,
    sourceId,
    kind,
    name: `Cat ${idx}`,
    position: idx,
    itemCount: 50,
  };
  return { row, label: row.name };
}

function makeItem(sourceId: string, kind: 'live' | 'movie' | 'series', idx: number): ItemRow {
  return {
    id: idx,
    key: `x:${sourceId}:${kind}:${idx}`,
    sourceId,
    providerId: String(idx),
    kind,
    name: `Item ${idx}`,
    logo: null,
    rating: null,
    year: 2025,
    num: kind === 'live' ? idx : null,
  };
}

function makeHomeSnapshot(sourceId: string): CachedHomeSnapshot {
  const liveCat = makeCategory(sourceId, 'live', 1).row;
  const movie = makeItem(sourceId, 'movie', 1);
  const fav: FavoriteRow = {
    profileId: 'default',
    sourceId,
    itemKey: movie.key,
    kind: 'movie',
    title: movie.name,
    logo: null,
    year: 2025,
    rating: null,
    addedAt: 100,
  };
  return {
    continueWatching: [],
    favorites: [fav],
    favoriteKeys: new Set([movie.key]),
    progressByKey: new Map(),
    liveCategory: liveCat,
    liveItems: [makeItem(sourceId, 'live', 1)],
    movies: [movie],
    series: [makeItem(sourceId, 'series', 1)],
  };
}

function makeDetailEntry(sourceId: string, idx: number): CachedDetailEntry {
  const ep: EpisodeRow = {
    id: idx,
    key: `x:${sourceId}:episode:${idx}`,
    season: 1,
    episode: 1,
    title: `Ep ${idx}`,
    durationSec: 1800,
  };
  return {
    sourceId,
    snap: {
      detailRow: null,
      inMyList: false,
      movieProgress: null,
      seasonsState: { kind: 'ready', seasons: [{ season: 1, episodeCount: 1 }] },
      selectedSeason: 1,
      episodes: [ep],
      episodesLoading: false,
      episodesRefreshing: false,
      episodeProgressByKey: new Map(),
      related: [],
      relatedCategoryId: undefined,
      relatedProgressByKey: new Map(),
    },
    episodesBySeason: new Map([[1, [ep]]]),
    episodeProgressByKey: new Map<string, WatchProgressRow>(),
  };
}

describe('createCatalogUiCache', () => {
  it('stores and invalidates home, catalog, live, detail, and search slices on revision or locale changes', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    expect(cache.getRevision()).toBe(0);
    expect(cache.getLocale()).toBe('en');
    expect(cache.getHome()).toBeNull();
    expect(cache.getCatalog('movie')).toBeNull();
    expect(cache.getLive()).toBeNull();

    cache.setHome(makeHomeSnapshot('src-1'));
    cache.setHomeHeroIndex(2);
    expect(cache.getHome()?.heroIndex).toBe(2);
    expect(cache.getHome()?.snapshot.movies).toHaveLength(1);

    // Same revision & locale is a no-op
    cache.setRevision(0, 'en');
    expect(cache.getHome()?.heroIndex).toBe(2);

    // Revision bump clears all catalog slices
    cache.setRevision(1, 'en');
    expect(cache.getRevision()).toBe(1);
    expect(cache.getHome()).toBeNull();

    // Locale change clears all catalog slices too
    cache.setHome(makeHomeSnapshot('src-1'));
    cache.setRevision(1, 'tr');
    expect(cache.getLocale()).toBe('tr');
    expect(cache.getHome()).toBeNull();

    // setHomeHeroIndex before home snapshot exists is safe no-op
    cache.setHomeHeroIndex(3);
    expect(cache.getHome()).toBeNull();
  });

  it('clearHome invalidates only the Home snapshot while preserving Live and Catalog caches', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    cache.setHome({
      continueWatching: [],
      favorites: [],
      favoriteKeys: new Set(),
      progressByKey: new Map(),
      liveCategory: null,
      liveItems: [],
      movies: [],
      series: [],
    });
    cache.setLiveCategories([makeCategory('src-1', 'live', 0)]);
    expect(cache.getHome()).not.toBeNull();
    expect(cache.getLive()).not.toBeNull();

    cache.clearHome?.();
    expect(cache.getHome()).toBeNull();
    expect(cache.getLive()).not.toBeNull();
  });

  it('caps catalog rail categories (16) and items per rail (18) and enforces LRU max 12 grid first pages', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    const categories = Array.from({ length: 20 }, (_, i) => makeCategory('src-1', 'movie', i));
    const rails = new Map<string, readonly ItemRow[]>();
    for (let i = 0; i < 20; i++) {
      const cat = categories[i];
      if (!cat) continue;
      rails.set(
        cat.row.id,
        Array.from({ length: 25 }, (_, j) => makeItem('src-1', 'movie', i * 100 + j)),
      );
    }

    cache.setCatalog('movie', {
      categories,
      continueItems: [],
      railItemsByCategoryId: rails,
      progressByKey: new Map(),
    });

    const cachedMovie = cache.getCatalog('movie');
    expect(cachedMovie?.categories).toHaveLength(20);
    expect(cachedMovie?.railItemsByCategoryId.size).toBe(MAX_CATALOG_RAIL_CATEGORIES);
    for (const rows of cachedMovie?.railItemsByCategoryId.values() ?? []) {
      expect(rows.length).toBeLessThanOrEqual(MAX_CATALOG_RAIL_ITEMS);
    }

    // Grid first page LRU (max 12)
    for (let i = 0; i < MAX_GRID_FIRST_PAGES; i++) {
      cache.setGridFirstPage('movie', `src-1|movie|cat-${i}`, [makeItem('src-1', 'movie', i)]);
    }
    // Touch cat-0 to promote it so cat-1 becomes LRU
    expect(cache.getGridFirstPage('movie', 'src-1|movie|cat-0')).toHaveLength(1);
    cache.setGridFirstPage('movie', 'src-1|movie|cat-99', [makeItem('src-1', 'movie', 99)]);
    expect(cache.getGridFirstPage('movie', 'src-1|movie|cat-0')).toHaveLength(1);
    expect(cache.getGridFirstPage('movie', 'src-1|movie|cat-1')).toBeUndefined();
    expect(cache.getGridFirstPage('movie', 'src-1|movie|cat-99')).toHaveLength(1);
  });

  it('bounds live channel first slices (LRU 8 × 120), favorites, nowNext TTL, and epgWindow', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    const liveCats = [makeCategory('src-1', 'live', 0)];
    const favCh = makeItem('src-1', 'live', 1);

    cache.setLiveCategories(liveCats);
    expect(cache.getLive()?.hasLoadedCategories).toBe(true);
    expect(cache.getLive()?.hasLoadedFavorites).toBe(false);

    cache.setLiveFavorites(new Set([favCh.key]), [favCh]);
    expect(cache.getLive()?.hasLoadedFavorites).toBe(true);
    expect(cache.getLive()?.favoriteKeys.has(favCh.key)).toBe(true);

    // Channel rows capped at 120 and categories capped at 8 LRU
    const bigSlice = Array.from({ length: 150 }, (_, i) => makeItem('src-1', 'live', i));
    cache.setLiveFirstChannels('src-1|live|cat-0', bigSlice);
    expect(cache.getLiveFirstChannels('src-1|live|cat-0')).toHaveLength(LIVE_CHANNEL_ROWS_CAP);

    for (let i = 1; i < MAX_LIVE_CHANNEL_CATEGORIES; i++) {
      cache.setLiveFirstChannels(`src-1|live|cat-${i}`, [makeItem('src-1', 'live', i)]);
    }
    // Touch cat-0 so cat-1 evicts next
    expect(cache.getLiveFirstChannels('src-1|live|cat-0')).toHaveLength(LIVE_CHANNEL_ROWS_CAP);
    cache.setLiveFirstChannels('src-1|live|cat-99', [makeItem('src-1', 'live', 99)]);
    expect(cache.getLiveFirstChannels('src-1|live|cat-0')).toBeDefined();
    expect(cache.getLiveFirstChannels('src-1|live|cat-1')).toBeUndefined();

    // NowNext TTL cache
    const entry: NowNextEntry = { channelKey: favCh.key, now: null, next: null };
    cache.nowNext.set(favCh.key, entry, 1_000);
    expect(cache.nowNext.get(favCh.key, 5_000)).toEqual(entry);
    expect(cache.getNowNextSnapshot(5_000).get(favCh.key)).toEqual(entry);
    expect(cache.nowNext.get(favCh.key, 100_000)).toBeUndefined();

    // EPG window cache
    const prog: ProgrammeRow = {
      sourceId: 'src-1',
      guideId: 'g-1',
      channelKey: favCh.key,
      start: 1_000,
      stop: 2_000,
      title: 'News',
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
      genre: null,
      flags: 0,
    };
    cache.epgWindow.set(`${favCh.key}|1000`, { rows: [prog], storedAt: 1_000 }, 0);
    expect(cache.epgWindow.get(`${favCh.key}|1000`, 0)?.rows).toEqual([prog]);
  });

  it('enforces LRU max 32 entries for detailByItemKey and matches search by query, scope, and revision', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    for (let i = 0; i < MAX_DETAIL_ENTRIES; i++) {
      cache.setDetail(`x:src-1:series:${i}`, makeDetailEntry('src-1', i));
    }
    // Promote item 0 so item 1 evicts next
    expect(cache.getDetail('x:src-1:series:0')).not.toBeNull();
    cache.setDetail('x:src-1:series:999', makeDetailEntry('src-1', 999));
    expect(cache.getDetail('x:src-1:series:0')).not.toBeNull();
    expect(cache.getDetail('x:src-1:series:1')).toBeNull();
    expect(cache.getDetail('x:src-1:series:999')).not.toBeNull();

    const results: SearchResults = {
      live: [],
      epg: [],
      movies: [makeItem('src-1', 'movie', 1)],
      series: [],
      episodes: [],
    };
    cache.setSearch({
      query: 'Matrix',
      scope: 'movie',
      catalogRevision: cache.getRevision(),
      results,
      progressByKey: new Map(),
    });
    expect(cache.getSearch('Matrix', 'movie')?.results.movies).toHaveLength(1);
    expect(cache.getSearch('Matrix', 'all')).toBeNull();
    expect(cache.getSearch('Other', 'movie')).toBeNull();

    cache.clearSearch();
    expect(cache.getSearch('Matrix', 'movie')).toBeNull();
  });

  it('invalidates entries belonging to a removed source while preserving other sources, and clears everything on clear()', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    cache.setHome(makeHomeSnapshot('src-1'));
    cache.setCatalog('movie', {
      categories: [makeCategory('src-1', 'movie', 0), makeCategory('src-2', 'movie', 1)],
      continueItems: [],
      railItemsByCategoryId: new Map([
        ['src-1|movie|cat-0', [makeItem('src-1', 'movie', 1)]],
        ['src-2|movie|cat-1', [makeItem('src-2', 'movie', 2)]],
      ]),
      progressByKey: new Map(),
    });
    cache.setGridFirstPage('movie', 'src-1|movie|cat-0', [makeItem('src-1', 'movie', 1)]);
    cache.setGridFirstPage('movie', 'src-2|movie|cat-1', [makeItem('src-2', 'movie', 2)]);

    const ch1 = makeItem('src-1', 'live', 1);
    const ch2 = makeItem('src-2', 'live', 2);
    cache.setLiveCategories([makeCategory('src-1', 'live', 0), makeCategory('src-2', 'live', 1)]);
    cache.setLiveFavorites(new Set([ch1.key, ch2.key]), [ch1, ch2]);
    cache.setLiveFirstChannels('src-1|live|cat-0', [ch1]);
    cache.setLiveFirstChannels('src-2|live|cat-1', [ch2]);
    cache.nowNext.set(ch1.key, { channelKey: ch1.key, now: null, next: null }, 100);
    cache.nowNext.set(ch2.key, { channelKey: ch2.key, now: null, next: null }, 100);
    cache.epgWindow.set(`${ch1.key}|1000`, { rows: [], storedAt: 100 }, 0);
    cache.epgWindow.set(`${ch2.key}|1000`, { rows: [], storedAt: 100 }, 0);

    cache.setDetail('x:src-1:series:1', makeDetailEntry('src-1', 1));
    cache.setDetail('x:src-2:series:2', makeDetailEntry('src-2', 2));
    cache.setSearch({
      query: 'Item',
      scope: 'all',
      catalogRevision: 0,
      results: { live: [ch1, ch2], epg: [], movies: [], series: [], episodes: [] },
      progressByKey: new Map(),
    });

    cache.invalidateSource('src-1');

    expect(cache.getHome()).toBeNull();
    expect(cache.getCatalog('movie')?.categories.map((c) => c.row.sourceId)).toEqual(['src-2']);
    expect(cache.getCatalog('movie')?.railItemsByCategoryId.has('src-1|movie|cat-0')).toBe(false);
    expect(cache.getCatalog('movie')?.railItemsByCategoryId.has('src-2|movie|cat-1')).toBe(true);
    expect(cache.getGridFirstPage('movie', 'src-1|movie|cat-0')).toBeUndefined();
    expect(cache.getGridFirstPage('movie', 'src-2|movie|cat-1')).toHaveLength(1);

    expect(cache.getLive()?.categories.map((c) => c.row.sourceId)).toEqual(['src-2']);
    expect(cache.getLive()?.favoriteChannels.map((c) => c.sourceId)).toEqual(['src-2']);
    expect(cache.getLive()?.favoriteKeys.has(ch1.key)).toBe(false);
    expect(cache.getLive()?.favoriteKeys.has(ch2.key)).toBe(true);
    expect(cache.getLiveFirstChannels('src-1|live|cat-0')).toBeUndefined();
    expect(cache.getLiveFirstChannels('src-2|live|cat-1')).toHaveLength(1);
    expect(cache.nowNext.get(ch1.key, 100)).toBeUndefined();
    expect(cache.nowNext.get(ch2.key, 100)).toBeDefined();
    expect(cache.epgWindow.get(`${ch1.key}|1000`, 0)).toBeUndefined();
    expect(cache.epgWindow.get(`${ch2.key}|1000`, 0)).toBeDefined();

    expect(cache.getDetail('x:src-1:series:1')).toBeNull();
    expect(cache.getDetail('x:src-2:series:2')).not.toBeNull();
    expect(cache.getSearch('Item', 'all')).toBeNull();

    cache.clear();
    expect(cache.getCatalog('movie')).toBeNull();
    expect(cache.getLive()).toBeNull();
    expect(cache.getDetail('x:src-2:series:2')).toBeNull();
  });

  it('tracks hit/miss counts and hitRatePct via getMetrics() (#160)', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    expect(cache.getMetrics?.()).toEqual({ hits: 0, misses: 0, hitRatePct: null });

    expect(cache.getHome()).toBeNull();
    cache.setHome(makeHomeSnapshot('src-1'));
    expect(cache.getHome()).not.toBeNull();
    expect(cache.getHome()).not.toBeNull();

    const metrics = cache.getMetrics?.();
    expect(metrics).toEqual({ hits: 2, misses: 1, hitRatePct: 67 });
  });

  it('isolates movie catalog and grid caches by groupVersions flag (#404)', () => {
    const cache = createCatalogUiCache({ locale: 'en' });
    const cat = makeCategory('src-1', 'movie', 1);
    const ungrouped = [makeItem('src-1', 'movie', 1), makeItem('src-1', 'movie', 2)];
    const grouped = [makeItem('src-1', 'movie', 1)];

    cache.setCatalog('movie', {
      categories: [cat],
      continueItems: [],
      railItemsByCategoryId: new Map([[cat.row.id, ungrouped]]),
      progressByKey: new Map(),
      groupVersions: false,
    });
    cache.setGridFirstPage('movie', cat.row.id, ungrouped, { groupVersions: false });

    expect(cache.getCatalog('movie', { groupVersions: false })).not.toBeNull();
    expect(cache.getCatalog('movie', { groupVersions: true })).toBeNull();
    expect(cache.getGridFirstPage('movie', cat.row.id, { groupVersions: false })).toEqual(
      ungrouped,
    );
    expect(cache.getGridFirstPage('movie', cat.row.id, { groupVersions: true })).toBeUndefined();

    cache.setCatalog('movie', {
      categories: [cat],
      continueItems: [],
      railItemsByCategoryId: new Map([[cat.row.id, grouped]]),
      progressByKey: new Map(),
      groupVersions: true,
    });
    cache.setGridFirstPage('movie', cat.row.id, grouped, { groupVersions: true });

    expect(
      cache.getCatalog('movie', { groupVersions: true })?.railItemsByCategoryId.get(cat.row.id),
    ).toEqual(grouped);
    expect(cache.getCatalog('movie', { groupVersions: false })).toBeNull();
    expect(cache.getGridFirstPage('movie', cat.row.id, { groupVersions: true })).toEqual(grouped);
    expect(cache.getGridFirstPage('movie', cat.row.id, { groupVersions: false })).toEqual(
      ungrouped,
    );

    cache.invalidateSource('src-1');
    expect(cache.getGridFirstPage('movie', cat.row.id, { groupVersions: true })).toBeUndefined();
    expect(cache.getGridFirstPage('movie', cat.row.id, { groupVersions: false })).toBeUndefined();
  });
});
