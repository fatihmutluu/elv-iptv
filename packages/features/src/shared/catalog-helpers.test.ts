import type { CategoryRow, ItemRow, SourceRow, WatchProgressRow } from '@elv/data';
import type { Theme, ViewportInfo } from '@elv/ui-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  batchLoadProgressByKeys,
  buildSharedDisplayCategories,
  computeCatalogLayout,
  detailTargetFromItem,
  formatAmbientClockTime,
  formatVodMeta,
  msUntilNextMinuteBoundary,
  shouldShowAmbientClock,
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
      backdropUri: null,
      year: 2026,
      rating: 8.6,
      catalogId: 42,
      categoryId: 's1|movie|scifi',
    });

    const movieWithBackdrop = {
      ...movie,
      backdrop: 'https://img.invalid/backdrop-16x9.jpg',
    } as ItemRow;
    expect(detailTargetFromItem(movieWithBackdrop)).toMatchObject({
      posterUri: 'https://img.invalid/poster.jpg',
      backdropUri: 'https://img.invalid/backdrop-16x9.jpg',
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

  it('clamps poster and wide card widths by form factor and expands grid columns on wide monitors', () => {
    const desktop = computeCatalogLayout(makeViewport(), MOCK_THEME);
    expect(desktop.posterRailWidth).toBeLessThanOrEqual(184);
    expect(desktop.wideRailWidth).toBeLessThanOrEqual(296);
    expect(desktop.gridCardWidth).toBeLessThanOrEqual(184);
    expect(desktop.gridCardWidth).toBeGreaterThanOrEqual(88);
    expect(desktop.gridColumns).toBe(7);
    expect(desktop.gridRowHeight).toBeGreaterThan(desktop.gridCardWidth * 1.5);

    const ultrawide = computeCatalogLayout(makeViewport({ width: 2560, height: 1440 }), MOCK_THEME);
    expect(ultrawide.posterRailWidth).toBeLessThanOrEqual(184);
    expect(ultrawide.wideRailWidth).toBeLessThanOrEqual(296);
    expect(ultrawide.gridCardWidth).toBeLessThanOrEqual(184);
    expect(ultrawide.gridColumns).toBe(13);
    const ultrawideRowUsed =
      ultrawide.gridColumns * ultrawide.gridCardWidth +
      (ultrawide.gridColumns - 1) * ultrawide.gridGap;
    expect(2560 - ultrawide.padX * 2 - ultrawideRowUsed).toBeLessThan(ultrawide.gridColumns);

    const tv = computeCatalogLayout(
      makeViewport({
        formFactor: 'tv',
        inputModality: 'tv',
        width: 1920,
        height: 1080,
        overscan: { x: 48, y: 27 },
      }),
      MOCK_THEME,
    );
    expect(tv.posterRailWidth).toBeLessThanOrEqual(184);
    expect(tv.wideRailWidth).toBeLessThanOrEqual(290);
    expect(tv.gridCardWidth).toBeLessThanOrEqual(184);

    const tabletPortrait = computeCatalogLayout(
      makeViewport({
        formFactor: 'tablet',
        orientation: 'portrait',
        inputModality: 'touch',
        width: 820,
        height: 1180,
        columns: { posterRail: 4.5, wideRail: 2.3, categoryGrid: 4 },
      }),
      MOCK_THEME,
    );
    expect(tabletPortrait.isPortrait).toBe(true);
    expect(tabletPortrait.posterRailWidth).toBeLessThanOrEqual(164);
    expect(tabletPortrait.wideRailWidth).toBeLessThanOrEqual(285);
    expect(tabletPortrait.gridCardWidth).toBeLessThanOrEqual(164);

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
    expect(phone.posterRailWidth).toBeLessThanOrEqual(124);
    expect(phone.wideRailWidth).toBeLessThanOrEqual(270);
    expect(phone.gridCardWidth).toBeLessThanOrEqual(124);
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

  it('scales gridRowHeight deterministically at fontScale = 1.2 without shrinking below 1.0 or NaN (#62)', () => {
    const tvViewport = makeViewport({
      formFactor: 'tv',
      inputModality: 'tv',
      width: 1920,
      height: 1080,
      overscan: { x: 48, y: 27 },
    });
    const baseTv = computeCatalogLayout(tvViewport, { ...MOCK_THEME, fontScale: 1 } as Theme);
    const smallTv = computeCatalogLayout(tvViewport, { ...MOCK_THEME, fontScale: 0.9 } as Theme);
    const largeTv = computeCatalogLayout(tvViewport, { ...MOCK_THEME, fontScale: 1.2 } as Theme);
    const explicitLarge = computeCatalogLayout(tvViewport, MOCK_THEME, 1.2);
    const nanSafe = computeCatalogLayout(tvViewport, MOCK_THEME, Number.NaN);

    expect(smallTv.gridRowHeight).toBe(baseTv.gridRowHeight);
    expect(largeTv.gridRowHeight).toBe(baseTv.gridRowHeight + Math.round(68 * 1.2) - 68);
    expect(explicitLarge.gridRowHeight).toBe(largeTv.gridRowHeight);
    expect(Number.isFinite(nanSafe.gridRowHeight)).toBe(true);
    expect(nanSafe.gridRowHeight).toBe(baseTv.gridRowHeight);

    const desktopBase = computeCatalogLayout(makeViewport(), MOCK_THEME, 1);
    const desktopLarge = computeCatalogLayout(makeViewport(), MOCK_THEME, 1.2);
    expect(desktopLarge.gridRowHeight).toBe(desktopBase.gridRowHeight + Math.round(54 * 1.2) - 54);
  });

  it('evaluates AmbientTvClock visibility matrix, minute boundary math, and locale formatting (#416)', () => {
    expect(shouldShowAmbientClock('always', 'menus')).toBe(true);
    expect(shouldShowAmbientClock('always', 'player')).toBe(true);
    expect(shouldShowAmbientClock('menus', 'menus')).toBe(true);
    expect(shouldShowAmbientClock('menus', 'player')).toBe(false);
    expect(shouldShowAmbientClock('player', 'menus')).toBe(false);
    expect(shouldShowAmbientClock('player', 'player')).toBe(true);
    expect(shouldShowAmbientClock('never', 'menus')).toBe(false);
    expect(shouldShowAmbientClock('never', 'player')).toBe(false);

    expect(msUntilNextMinuteBoundary(60_000 * 100 + 15_000)).toBe(45_050);
    expect(msUntilNextMinuteBoundary(60_000 * 100)).toBe(60_050);
    expect(msUntilNextMinuteBoundary(Number.NaN)).toBe(60_050);

    const sampleMs = new Date(2026, 10, 23, 21, 5, 0).getTime();
    expect(formatAmbientClockTime(sampleMs, 'en').length).toBeGreaterThan(0);
    expect(formatAmbientClockTime(sampleMs, 'tr').length).toBeGreaterThan(0);
    expect(formatAmbientClockTime(Number.NaN, 'en')).toBe('--:--');
  });
});
