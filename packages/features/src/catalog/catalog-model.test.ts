import type { ItemRow, WatchProgressRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import { createPagedListSource } from '../shared';
import {
  buildCatalogNavRows,
  CATEGORY_LOAD_BATCH,
  chunkRowItems,
  clampGridFocus,
  computeProgressRatio,
  computeRowCount,
  EMPTY_CATALOG_MEMORY,
  FILTERED_GRID_LIMIT,
  filterCatalogItems,
  GRID_MAX_PAGES,
  GRID_PAGE_SIZE,
  INITIAL_VISIBLE_CATEGORIES,
  MAX_CONCURRENT_RAIL_QUERIES,
  RAIL_ITEM_LIMIT,
  WATCH_STATUS_FILTERS,
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
    expect(FILTERED_GRID_LIMIT).toBe(240);
    expect(WATCH_STATUS_FILTERS).toEqual(['all', 'unwatched', 'inProgress', 'watched']);
    expect(EMPTY_CATALOG_MEMORY).toEqual({
      selectedCategoryId: null,
      watchFilter: 'all',
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

describe('filterCatalogItems', () => {
  it('filters items accurately by all, unwatched, inProgress, and watched status', () => {
    const items = [makeItem(0), makeItem(1), makeItem(2), makeItem(3)];
    const progress = new Map<string, WatchProgressRow>([
      ['movie:1', makeProgress('movie:1', { positionMs: 5_000, watched: false })],
      ['movie:2', makeProgress('movie:2', { positionMs: 120_000, watched: false })],
      ['movie:3', makeProgress('movie:3', { positionMs: 3_500_000, watched: true })],
    ]);

    expect(filterCatalogItems(items, progress, 'all').map((i) => i.key)).toEqual([
      'movie:0',
      'movie:1',
      'movie:2',
      'movie:3',
    ]);
    expect(filterCatalogItems(items, progress, 'unwatched').map((i) => i.key)).toEqual([
      'movie:0',
      'movie:1',
    ]);
    expect(filterCatalogItems(items, progress, 'inProgress').map((i) => i.key)).toEqual([
      'movie:2',
    ]);
    expect(filterCatalogItems(items, progress, 'watched').map((i) => i.key)).toEqual(['movie:3']);
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
  it('returns empty while loading, empty CTA when no sources, and chip/rail rows in Discovery mode', () => {
    expect(
      buildCatalogNavRows({
        isLoading: true,
        hasSources: true,
        hasCategories: false,
        categoryChipCount: 0,
        statusChipCount: 4,
      }),
    ).toEqual([]);

    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: false,
        hasCategories: false,
        categoryChipCount: 0,
        statusChipCount: 4,
      }),
    ).toEqual([{ id: 'empty', count: 1 }]);

    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: true,
        hasCategories: true,
        categoryChipCount: 4,
        statusChipCount: 4,
        railEntries: [
          { catIndex: 0, count: 6 },
          { catIndex: 1, count: 0 },
          { catIndex: 2, count: 3 },
        ],
        hasLoadMore: true,
      }),
    ).toEqual([
      { id: 'catChips', count: 4 },
      { id: 'statusChips', count: 4 },
      { id: 'rail-0', count: 6 },
      { id: 'rail-2', count: 3 },
      { id: 'loadMore', count: 1 },
    ]);
  });

  it('builds Grid mode header rows and filter-empty reset row', () => {
    expect(
      buildCatalogNavRows({
        isLoading: false,
        hasSources: true,
        hasCategories: true,
        categoryChipCount: 4,
        statusChipCount: 4,
        isGridMode: true,
        isFilterEmpty: true,
      }),
    ).toEqual([
      { id: 'catChips', count: 4 },
      { id: 'statusChips', count: 4 },
      { id: 'gridBack', count: 1 },
      { id: 'filterReset', count: 1 },
    ]);
  });
});
