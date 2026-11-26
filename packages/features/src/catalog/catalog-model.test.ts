import type { FavoriteRow, ItemRow, WatchProgressRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import { createPagedListSource } from '../shared';
import {
  ALPHABET_RAIL_MIN_ITEMS,
  buildCatalogNavRows,
  CATEGORY_LOAD_BATCH,
  chunkRowItems,
  clampGridFocus,
  collectWatchedCatalogItems,
  computeProgressRatio,
  computeRowCount,
  detailTargetFromFavorite,
  detailTargetFromProgress,
  EMPTY_CATALOG_MEMORY,
  filterContinueWatchingForCatalog,
  filterFavoritesForCatalog,
  GRID_MAX_PAGES,
  GRID_PAGE_SIZE,
  INITIAL_VISIBLE_CATEGORIES,
  itemRowFromFavorite,
  itemRowFromWatchProgress,
  MAX_CONCURRENT_RAIL_QUERIES,
  RAIL_ITEM_LIMIT,
  resolveActiveAlphabetLetter,
  stepAlphabetRailLetter,
} from './catalog-model';

function makeItem(index: number, kind: 'movie' | 'series' = 'movie'): ItemRow {
  return {
    id: index + 1,
    key: `${kind}:${index}`,
    kind,
    sourceId: 'src-1',
    providerId: String(index + 1),
    name: `Title ${index}`,
    logo: `https://art.example.test/${index}.jpg`,
    rating: 8.2,
    year: 2025,
    num: null,
  };
}

function makeProgress(
  itemKey: string,
  overrides: Partial<WatchProgressRow> = {},
): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey,
    kind: 'movie',
    title: 'Title',
    subtitle: null,
    logo: null,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 0,
    durationMs: 3_600_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('catalog-model constants and defaults', () => {
  it('exports the bounded Cinema Quietude catalog constants and empty tab memory', () => {
    expect(INITIAL_VISIBLE_CATEGORIES).toBe(8);
    expect(CATEGORY_LOAD_BATCH).toBe(8);
    expect(RAIL_ITEM_LIMIT).toBe(18);
    expect(MAX_CONCURRENT_RAIL_QUERIES).toBe(4);
    expect(GRID_PAGE_SIZE).toBe(180);
    expect(GRID_MAX_PAGES).toBe(8);
    expect(EMPTY_CATALOG_MEMORY).toEqual({
      selectedCategoryId: null,
      visibleCategoryCount: 8,
    });
  });
});

describe('computeRowCount', () => {
  it('computes exact row counts and guards invalid or zero inputs', () => {
    expect(computeRowCount(0, 5)).toBe(0);
    expect(computeRowCount(-3, 5)).toBe(0);
    expect(computeRowCount(10, 0)).toBe(0);
    expect(computeRowCount(10, -2)).toBe(0);
    expect(computeRowCount(1, 5)).toBe(1);
    expect(computeRowCount(5, 5)).toBe(1);
    expect(computeRowCount(6, 5)).toBe(2);
    expect(computeRowCount(5_000, 5)).toBe(1_000);
    expect(computeRowCount(10, 3)).toBe(4);
  });
});

describe('chunkRowItems', () => {
  it('slices exact row items from a plain array including short trailing rows', () => {
    const items = Array.from({ length: 7 }, (_, i) => makeItem(i));
    expect(chunkRowItems(items, 0, 5).map((item) => item?.key)).toEqual([
      'movie:0',
      'movie:1',
      'movie:2',
      'movie:3',
      'movie:4',
    ]);
    expect(chunkRowItems(items, 1, 5).map((item) => item?.key)).toEqual(['movie:5', 'movie:6']);
    expect(chunkRowItems(items, 2, 5)).toEqual([]);
    expect(chunkRowItems(items, -1, 5)).toEqual([]);
    expect(chunkRowItems(items, 0, 0)).toEqual([]);
  });

  it('returns undefined skeleton placeholders for unloaded slots in a PagedListSource', async () => {
    const source = createPagedListSource<ItemRow>({
      count: 12,
      pageSize: 5,
      maxPages: 2,
      loadPage: async (offset, limit) =>
        Array.from({ length: limit }, (_, i) => makeItem(offset + i)),
    });

    expect(chunkRowItems(source, 0, 5)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(chunkRowItems(source, 2, 5)).toEqual([undefined, undefined]);

    await source.loadItem(0);
    expect(chunkRowItems(source, 0, 5).map((item) => item?.key)).toEqual([
      'movie:0',
      'movie:1',
      'movie:2',
      'movie:3',
      'movie:4',
    ]);
    expect(chunkRowItems(source, 1, 5)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    source.dispose();
  });
});

describe('filterContinueWatchingForCatalog & detailTargetFromProgress', () => {
  it('filters continue-watching rows by movie vs series/episode tab and excludes watched/short rows', () => {
    const rows = [
      makeProgress('movie:1', { kind: 'movie', positionMs: 120_000, watched: false }),
      makeProgress('movie:2', { kind: 'movie', positionMs: 5_000, watched: false }),
      makeProgress('movie:3', { kind: 'movie', positionMs: 3_500_000, watched: true }),
      makeProgress('series:1', { kind: 'series', positionMs: 180_000, watched: false }),
      makeProgress('ep:1', {
        kind: 'episode',
        seriesKey: 'series:2',
        title: 'Dark Sky',
        subtitle: 'S1 E2',
        positionMs: 240_000,
        watched: false,
      }),
      makeProgress('live:1', { kind: 'live', positionMs: 300_000, watched: false }),
    ];

    expect(filterContinueWatchingForCatalog(rows, 'movie').map((r) => r.itemKey)).toEqual([
      'movie:1',
    ]);
    expect(filterContinueWatchingForCatalog(rows, 'series').map((r) => r.itemKey)).toEqual([
      'series:1',
      'ep:1',
    ]);
  });

  it('builds DetailTarget from movie or episode progress rows', () => {
    const movieRow = makeProgress('x:s1:movie:1', {
      kind: 'movie',
      title: 'Solaris',
      logo: 'https://img.test/m.jpg',
    });
    expect(detailTargetFromProgress(movieRow, 'movie')).toEqual({
      itemKey: 'x:s1:movie:1',
      sourceId: 'src-1',
      kind: 'movie',
      title: 'Solaris',
      posterUri: 'https://img.test/m.jpg',
      backdropUri: 'https://img.test/m.jpg',
      year: null,
      rating: null,
    });

    const epRow = makeProgress('x:s1:episode:5', {
      kind: 'episode',
      seriesKey: 'x:s1:series:2',
      title: 'Dark Sky',
      logo: 'https://img.test/s.jpg',
    });
    expect(detailTargetFromProgress(epRow, 'series')).toEqual({
      itemKey: 'x:s1:series:2',
      sourceId: 'src-1',
      kind: 'series',
      title: 'Dark Sky',
      posterUri: 'https://img.test/s.jpg',
      backdropUri: 'https://img.test/s.jpg',
      year: null,
      rating: null,
    });
  });
});

describe('computeProgressRatio', () => {
  it('returns clamped ratio only for unwatched in-progress items with valid duration', () => {
    expect(computeProgressRatio(undefined)).toBeUndefined();
    expect(
      computeProgressRatio(makeProgress('m', { positionMs: 0, durationMs: 1000 })),
    ).toBeUndefined();
    expect(
      computeProgressRatio(makeProgress('m', { positionMs: 500, durationMs: 0 })),
    ).toBeUndefined();
    expect(
      computeProgressRatio(makeProgress('m', { positionMs: 900, durationMs: 1000, watched: true })),
    ).toBeUndefined();
    expect(computeProgressRatio(makeProgress('m', { positionMs: 500, durationMs: 1000 }))).toBe(
      0.5,
    );
    expect(computeProgressRatio(makeProgress('m', { positionMs: 1500, durationMs: 1000 }))).toBe(1);
  });
});

describe('clampGridFocus', () => {
  it('clamps row and column to valid item coordinates including partial last rows', () => {
    expect(clampGridFocus(0, 0, 0, 5)).toEqual({ row: 0, col: 0 });
    expect(clampGridFocus(2, 4, 12, 5)).toEqual({ row: 2, col: 1 });
    expect(clampGridFocus(99, 99, 12, 5)).toEqual({ row: 2, col: 1 });
    expect(clampGridFocus(-2, -3, 12, 5)).toEqual({ row: 0, col: 0 });
    expect(clampGridFocus(1, 4, 12, 5)).toEqual({ row: 1, col: 4 });
  });
});

describe('buildCatalogNavRows', () => {
  it('returns empty while loading, empty CTA when no sources, and editorial bar + continue + rail rows in Discovery mode', () => {
    expect(
      buildCatalogNavRows({
        isLoading: true,
        hasSources: true,
        hasCategories: false,
        categoryChipCount: 0,
      }),
    ).toEqual([]);

    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: false,
        hasCategories: false,
        categoryChipCount: 0,
      }),
    ).toEqual([{ id: 'empty', count: 1 }]);

    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: true,
        hasCategories: true,
        categoryChipCount: 4,
        continueCount: 3,
        railEntries: [
          { catIndex: 0, count: 6 },
          { catIndex: 1, count: 0 },
          { catIndex: 2, count: 3 },
        ],
        hasLoadMore: true,
      }),
    ).toEqual([
      { id: 'catChips', count: 4 },
      { id: 'continue', count: 3 },
      { id: 'rail-0', count: 6 },
      { id: 'rail-2', count: 3 },
      { id: 'loadMore', count: 1 },
    ]);
  });

  it('builds Grid mode header rows without continue rail', () => {
    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: true,
        hasCategories: true,
        categoryChipCount: 4,
        continueCount: 3,
        isGridMode: true,
      }),
    ).toEqual([
      { id: 'catChips', count: 4 },
      { id: 'gridBack', count: 1 },
    ]);
  });
});

describe('resolveActiveAlphabetLetter & stepAlphabetRailLetter (#407)', () => {
  const buckets = [
    { letter: '#', offset: 0, count: 5 },
    { letter: 'A', offset: 5, count: 12 },
    { letter: 'B', offset: 17, count: 0 },
    { letter: 'M', offset: 17, count: 25 },
    { letter: 'Z', offset: 42, count: 8 },
  ] as const;

  it('resolves active letter by offset and steps across available buckets', () => {
    expect(ALPHABET_RAIL_MIN_ITEMS).toBe(40);
    expect(resolveActiveAlphabetLetter([], 0)).toBeNull();
    expect(resolveActiveAlphabetLetter(buckets, 0)).toBe('#');
    expect(resolveActiveAlphabetLetter(buckets, 4)).toBe('#');
    expect(resolveActiveAlphabetLetter(buckets, 5)).toBe('A');
    expect(resolveActiveAlphabetLetter(buckets, 16)).toBe('A');
    expect(resolveActiveAlphabetLetter(buckets, 17)).toBe('M');
    expect(resolveActiveAlphabetLetter(buckets, 99)).toBe('Z');

    expect(stepAlphabetRailLetter([], 'A', 'down')).toBeNull();
    expect(stepAlphabetRailLetter(buckets, null, 'down')).toBe('#');
    expect(stepAlphabetRailLetter(buckets, '#', 'up')).toBe('#');
    expect(stepAlphabetRailLetter(buckets, '#', 'down')).toBe('A');
    // Skips B (count === 0) and lands on M
    expect(stepAlphabetRailLetter(buckets, 'A', 'down')).toBe('M');
    expect(stepAlphabetRailLetter(buckets, 'M', 'down')).toBe('Z');
    expect(stepAlphabetRailLetter(buckets, 'Z', 'down')).toBe('Z');
    expect(stepAlphabetRailLetter(buckets, 'Z', 'up')).toBe('M');
  });
});

describe('quick filter helpers (My List & Watched)', () => {
  it('filters favorites by kind and converts to ItemRow and DetailTarget', () => {
    const favMovie: FavoriteRow = {
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'movie:fav-1',
      kind: 'movie',
      title: 'Blade Runner',
      logo: 'https://img.test/br.jpg',
      year: 1982,
      rating: 8.1,
      addedAt: 1000,
    };
    const favSeries: FavoriteRow = {
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: 'series:fav-2',
      kind: 'series',
      title: 'Andor',
      logo: null,
      year: 2022,
      rating: 8.5,
      addedAt: 2000,
    };

    expect(filterFavoritesForCatalog([favMovie, favSeries], 'movie')).toEqual([favMovie]);
    expect(filterFavoritesForCatalog([favMovie, favSeries], 'series')).toEqual([favSeries]);

    expect(itemRowFromFavorite(favMovie, 'movie')).toMatchObject({
      key: 'movie:fav-1',
      kind: 'movie',
      name: 'Blade Runner',
      year: 1982,
      rating: 8.1,
    });
    expect(detailTargetFromFavorite(favSeries, 'series')).toEqual({
      itemKey: 'series:fav-2',
      sourceId: 'src-1',
      kind: 'series',
      title: 'Andor',
      posterUri: null,
      backdropUri: null,
      year: 2022,
      rating: 8.5,
    });
  });

  it('collects deduplicated watched catalog items honoring watchedOverrides', () => {
    const m0 = makeItem(0, 'movie');
    const m1 = makeItem(1, 'movie');
    const m2 = makeItem(2, 'movie');
    const s0 = makeItem(0, 'series');

    const watched = collectWatchedCatalogItems({
      kind: 'movie',
      railItemsByCategoryId: new Map([['cat-0', [m0, m1]]]),
      extraItems: [m1, m2, s0],
      progressByKey: new Map([
        [m0.key, makeProgress(m0.key, { watched: true })],
        [m1.key, makeProgress(m1.key, { watched: true })],
      ]),
      watchedOverrides: new Map([
        [m1.key, false],
        [m2.key, true],
      ]),
    });

    expect(watched.map((i) => i.key)).toEqual([m0.key, m2.key]);
  });

  it('prefers full-catalog watchedRows, enriches rail metadata, honors watchedOverrides, and omits gridBack when gridHeaderCount is 0', () => {
    const mRail = makeItem(0, 'movie');
    const mOpt = makeItem(1, 'movie');
    const deepWatched = makeProgress('movie:deep-50000', {
      title: 'Deep Archive Film',
      watched: true,
    });
    const railWatched = makeProgress(mRail.key, { title: mRail.name, watched: true });
    const unmarked = makeProgress('movie:unmarked', { title: 'Unmarked Film', watched: true });

    expect(itemRowFromWatchProgress(deepWatched, 'movie')).toMatchObject({
      key: 'movie:deep-50000',
      kind: 'movie',
      name: 'Deep Archive Film',
    });

    const watched = collectWatchedCatalogItems({
      kind: 'movie',
      railItemsByCategoryId: new Map([['cat-0', [mRail, mOpt]]]),
      watchedRows: [deepWatched, railWatched, unmarked],
      progressByKey: new Map(),
      watchedOverrides: new Map([
        [unmarked.itemKey, false],
        [mOpt.key, true],
      ]),
    });

    expect(watched.map((i) => i.key)).toEqual(['movie:deep-50000', mRail.key, mOpt.key]);
    expect(watched[1]?.year).toBe(mRail.year);
    expect(watched[1]?.rating).toBe(mRail.rating);

    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: true,
        hasCategories: true,
        categoryChipCount: 5,
        isGridMode: true,
        gridHeaderCount: 0,
      }),
    ).toEqual([{ id: 'catChips', count: 5 }]);
  });
});
