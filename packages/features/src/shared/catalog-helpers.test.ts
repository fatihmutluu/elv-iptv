import type { CategoryRow, ItemRow, SourceRow, WatchProgressRow } from '@elv/data';
import type { Theme, ViewportInfo } from '@elv/ui-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  batchLoadProgressByKeys,
  buildSharedDisplayCategories,
  computeCatalogLayout,
  detailTargetFromItem,
  formatVodMeta,
  matchesWatchStatus,
} from './index';

const MOCK_THEME = {
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
} as unknown as Theme;

const makeViewport = (overrides: Partial<ViewportInfo> = {}): ViewportInfo => ({
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 720,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  overscan: { x: 0, y: 0 },
  columns: { posterRail: 5.5, wideRail: 3.3, categoryGrid: 5 },
  tvScale: 1,
  ...overrides,
});

const makeProgress = (overrides: Partial<WatchProgressRow> = {}): WatchProgressRow => ({
  profileId: 'default',
  sourceId: 's1',
  itemKey: 'x:s1:movie:1',
  kind: 'movie',
  title: 'Test Movie',
  subtitle: null,
  logo: null,
  seriesKey: null,
  season: null,
  episode: null,
  positionMs: 0,
  durationMs: 6_000_000,
  watched: false,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe('shared catalog helpers', () => {
  it('converts movie and series rows into DetailTarget and ignores live channels', () => {
    const movie: ItemRow = {
      id: 42,
      key: 'x:s1:movie:42',
      kind: 'movie',
      sourceId: 's1',
      providerId: '42',
      name: 'Silent Horizon',
      logo: 'https://img.invalid/poster.jpg',
      rating: 8.6,
      year: 2026,
      num: null,
    };
    expect(detailTargetFromItem(movie, 's1|movie|scifi')).toEqual({
      itemKey: 'x:s1:movie:42',
      sourceId: 's1',
      kind: 'movie',
      title: 'Silent Horizon',
      posterUri: 'https://img.invalid/poster.jpg',
      backdropUri: 'https://img.invalid/poster.jpg',
      year: 2026,
      rating: 8.6,
      catalogId: 42,
      categoryId: 's1|movie|scifi',
    });

    const live: ItemRow = { ...movie, kind: 'live', num: 1 };
    expect(detailTargetFromItem(live)).toBeUndefined();
  });

  it('prefixes source names only when multiple sources exist', () => {
    const src1: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Alpha',
      createdAt: 1,
      needsImport: false,
    };
    const src2: SourceRow = {
      id: 's2',
      kind: 'xtream',
      name: 'Beta',
      createdAt: 2,
      needsImport: false,
    };
    const c1: CategoryRow = {
      id: 's1|movie|1',
      sourceId: 's1',
      kind: 'movie',
      name: 'Drama',
      position: 0,
      itemCount: 10,
    };
    const c2: CategoryRow = {
      id: 's2|movie|1',
      sourceId: 's2',
      kind: 'movie',
      name: 'Drama',
      position: 0,
      itemCount: 5,
    };

    const single = buildSharedDisplayCategories([src1], new Map([['s1', [c1]]]));
    expect(single.map((d) => d.label)).toEqual(['Drama']);

    const multi = buildSharedDisplayCategories(
      [src1, src2],
      new Map([
        ['s1', [c1]],
        ['s2', [c2]],
      ]),
    );
    expect(multi.map((d) => d.label)).toEqual(['Alpha — Drama', 'Beta — Drama']);
  });

  it('formats VOD metadata cleanly without third-party brand labels', () => {
    expect(formatVodMeta(2026, 8.6)).toBe('2026 · ★ 8.6');
    expect(formatVodMeta(2025, null)).toBe('2025');
    expect(formatVodMeta(null, 7.5)).toBe('★ 7.5');
    expect(formatVodMeta(null, null)).toBeUndefined();
  });

  it('classifies watch status filters accurately', () => {
    const unwatched = undefined;
    const tinyPos = makeProgress({ positionMs: 2_000, watched: false });
    const inProgress = makeProgress({ positionMs: 120_000, watched: false });
    const watched = makeProgress({ positionMs: 5_900_000, watched: true });

    expect(matchesWatchStatus(unwatched, 'all')).toBe(true);
    expect(matchesWatchStatus(unwatched, 'unwatched')).toBe(true);
    expect(matchesWatchStatus(tinyPos, 'unwatched')).toBe(true);
    expect(matchesWatchStatus(inProgress, 'unwatched')).toBe(false);
    expect(matchesWatchStatus(watched, 'unwatched')).toBe(false);

    expect(matchesWatchStatus(unwatched, 'inProgress')).toBe(false);
    expect(matchesWatchStatus(tinyPos, 'inProgress')).toBe(false);
    expect(matchesWatchStatus(inProgress, 'inProgress')).toBe(true);
    expect(matchesWatchStatus(watched, 'inProgress')).toBe(false);

    expect(matchesWatchStatus(watched, 'watched')).toBe(true);
    expect(matchesWatchStatus(inProgress, 'watched')).toBe(false);
  });

  it('computes responsive 5-col landscape and 3-col portrait grid metrics', () => {
    const desktop = computeCatalogLayout(makeViewport(), MOCK_THEME);
    expect(desktop.gridColumns).toBe(5);
    expect(desktop.gridCardWidth).toBeGreaterThan(180);
    expect(desktop.gridRowHeight).toBeGreaterThan(desktop.gridCardWidth * 1.5);

    const phone = computeCatalogLayout(
      makeViewport({
        formFactor: 'phone',
        orientation: 'portrait',
        inputModality: 'touch',
        width: 390,
        height: 844,
        columns: { posterRail: 3.5, wideRail: 1.2, categoryGrid: 3 },
      }),
      MOCK_THEME,
    );
    expect(phone.isPortrait).toBe(true);
    expect(phone.gridColumns).toBe(3);
    expect(phone.gridCardWidth).toBeGreaterThanOrEqual(88);
  });

  it('chunks batchLoadProgressByKeys into <= 100-key queries', async () => {
    const keys = Array.from({ length: 145 }, (_, i) => `x:s1:movie:${i}`);
    const listProgressByKeys = vi.fn(async (chunk: readonly string[]) =>
      chunk.slice(0, 1).map((itemKey) => makeProgress({ itemKey, positionMs: 30_000 })),
    );
    const map = await batchLoadProgressByKeys({ listProgressByKeys }, [...keys, keys[0] ?? '']);
    expect(listProgressByKeys).toHaveBeenCalledTimes(2);
    expect(listProgressByKeys.mock.calls[0]?.[0]).toHaveLength(100);
    expect(listProgressByKeys.mock.calls[1]?.[0]).toHaveLength(45);
    expect(map.size).toBe(2);
  });
});
