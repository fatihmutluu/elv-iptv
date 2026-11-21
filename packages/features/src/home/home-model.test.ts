import type { CatalogService, CategoryRow, ItemRow, WatchProgressRow } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import {
  buildHeroSlides,
  buildHomeDetailTarget,
  buildHomeLivePlayTarget,
  buildVodPlayTarget,
  computePeekCardWidth,
  formatLiveChannelName,
  formatRemainingMinutes,
  progressRatio,
} from './home-model';

function makeProgress(overrides: Partial<WatchProgressRow> = {}): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'x:src-1:movie:10',
    kind: 'movie',
    title: 'Neon Horizon',
    subtitle: null,
    logo: 'https://art.example.test/neon.jpg',
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 120_000,
    durationMs: 600_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    key: 'x:src-1:movie:1',
    kind: 'movie',
    sourceId: 'src-1',
    providerId: '1',
    name: 'Glass Meridian',
    logo: 'https://art.example.test/glass.jpg',
    rating: 8.2,
    year: 2025,
    num: null,
    ...overrides,
  };
}

describe('home-model', () => {
  it('computes peek card widths cleanly for landscape, phone portrait, and tablet portrait', () => {
    const desktopPoster = computePeekCardWidth(1280, 24, 5.5, 10);
    const phonePoster = computePeekCardWidth(390, 16, 3.5, 8);
    const phoneWide = computePeekCardWidth(390, 16, 1.2, 8);
    const tabletWide = computePeekCardWidth(768, 20, 2.3, 10);

    expect(desktopPoster).toBe(215);
    expect(phonePoster).toBe(96);
    expect(phoneWide).toBe(297);
    expect(tabletWide).toBe(310);
    expect(phoneWide).toBeGreaterThan(phonePoster);
    expect(computePeekCardWidth(100, 16, 5.5, 8)).toBeGreaterThanOrEqual(88);
  });

  it('clamps progressRatio to [0, 1] and handles invalid durations safely', () => {
    expect(progressRatio(0, 0)).toBe(0);
    expect(progressRatio(50, -10)).toBe(0);
    expect(progressRatio(Number.NaN, 1000)).toBe(0);
    expect(progressRatio(-100, 1000)).toBe(0);
    expect(progressRatio(300, 1000)).toBeCloseTo(0.3, 5);
    expect(progressRatio(1500, 1000)).toBe(1);
  });

  it('formats remaining minutes with a minimum of 1 minute for valid durations', () => {
    expect(formatRemainingMinutes(0, 0)).toBeNull();
    expect(formatRemainingMinutes(100_000, Number.NaN)).toBeNull();
    expect(formatRemainingMinutes(120_000, 600_000)).toBe(8);
    expect(formatRemainingMinutes(590_000, 600_000)).toBe(1);
    expect(formatRemainingMinutes(650_000, 600_000)).toBe(1);
  });

  it('formats numbered live channels with channel number prefix', () => {
    expect(formatLiveChannelName({ num: 7, name: 'Cinema One' })).toBe('7. Cinema One');
    expect(formatLiveChannelName({ num: null, name: 'Cinema One' })).toBe('Cinema One');
  });

  it('builds up to 5 deduplicated hero slides prioritizing Continue Watching, Movies, then Series', () => {
    const cw = [
      makeProgress({ itemKey: 'x:src-1:movie:1', title: 'Movie One', positionMs: 60_000 }),
      makeProgress({
        itemKey: 'x:src-1:episode:90',
        kind: 'episode',
        title: 'Starlight Harbor',
        subtitle: 'S1 E3 · Drydock',
        positionMs: 180_000,
      }),
    ];
    const movies = [
      makeItem({ id: 1, key: 'x:src-1:movie:1', name: 'Movie One' }),
      makeItem({ id: 2, key: 'x:src-1:movie:2', name: 'Movie Two' }),
      makeItem({ id: 3, key: 'x:src-1:movie:3', name: 'Movie Three' }),
    ];
    const series = [
      makeItem({ id: 10, key: 'x:src-1:series:10', kind: 'series', name: 'Series Alpha' }),
      makeItem({ id: 11, key: 'x:src-1:series:11', kind: 'series', name: 'Series Beta' }),
    ];

    const watchedMap = new Map<string, WatchProgressRow>([
      [
        'x:src-1:movie:2',
        makeProgress({ itemKey: 'x:src-1:movie:2', watched: true, positionMs: 600_000 }),
      ],
    ]);

    const slides = buildHeroSlides({
      continueWatching: cw,
      movies,
      series,
      progressByKey: watchedMap,
    });

    expect(slides).toHaveLength(5);
    expect(slides.map((s) => s.itemKey)).toEqual([
      'x:src-1:movie:1',
      'x:src-1:episode:90',
      'x:src-1:movie:2',
      'x:src-1:movie:3',
      'x:src-1:series:10',
    ]);
    expect(slides[0]?.isContinueWatching).toBe(true);
    expect(slides[0]?.year).toBe(2025);
    expect(slides[2]?.watched).toBe(true);
    expect(slides[4]?.catalogItem?.key).toBe('x:src-1:series:10');
  });

  it('applies 5-second smart rewind on buildVodPlayTarget and resets watched items to 0', () => {
    const resumed = buildVodPlayTarget({
      itemKey: 'x:src-1:movie:1',
      sourceId: 'src-1',
      title: 'Neon Horizon',
      kind: 'movie',
      logo: 'https://art.example.test/neon.jpg',
      positionMs: 45_000,
      watched: false,
    });
    expect(resumed.startPositionMs).toBe(40_000);
    expect(resumed.kind).toBe('vod');
    expect(resumed.itemKind).toBe('movie');

    const watchedTarget = buildVodPlayTarget({
      itemKey: 'x:src-1:movie:1',
      sourceId: 'src-1',
      title: 'Neon Horizon',
      kind: 'movie',
      positionMs: 550_000,
      watched: true,
    });
    expect(watchedTarget.startPositionMs).toBe(0);
  });

  it('builds a paged live PlayTarget for On Air Now zapping without loading all rows upfront', async () => {
    const itemsSpy = vi.fn(async (_catId: string, offset: number, limit: number) => {
      const out: ItemRow[] = [];
      for (let i = offset; i < Math.min(100, offset + limit); i++) {
        out.push(
          makeItem({
            id: i + 1,
            key: `x:src-1:live:${i + 1}`,
            kind: 'live',
            name: `Channel ${i + 1}`,
            num: i + 1,
          }),
        );
      }
      return out;
    });
    const catalog = { items: itemsSpy } as unknown as CatalogService;
    const category: CategoryRow = {
      id: 'src-1|live|1',
      sourceId: 'src-1',
      kind: 'live',
      name: 'General',
      position: 0,
      itemCount: 100,
    };
    const ch1 = makeItem({
      id: 1,
      key: 'x:src-1:live:1',
      kind: 'live',
      name: 'Channel 1',
      num: 1,
    });

    const target = buildHomeLivePlayTarget(catalog, category, ch1, 0);
    expect(target.kind).toBe('live');
    expect(target.title).toBe('1. Channel 1');
    expect(target.playlist?.count).toBe(100);

    const ch2 = await target.playlist?.getAt(1);
    const ch3 = await target.playlist?.getAt(2);
    expect(ch2?.title).toBe('2. Channel 2');
    expect(ch3?.title).toBe('3. Channel 3');
    // Both indices live in the same page so only 1 bounded page query was issued.
    expect(itemsSpy).toHaveBeenCalledTimes(1);
  });

  it('builds a DetailTarget for movie/series entries and returns undefined for live/episode', () => {
    const movieTarget = buildHomeDetailTarget({
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      kind: 'movie',
      title: 'Neon Horizon',
      subtitle: null,
      backdropUri: 'https://img.test/b.jpg',
      posterUri: 'https://img.test/p.jpg',
      year: 2025,
      rating: 8.4,
      durationMs: 0,
      positionMs: 0,
      watched: false,
      catalogItem: {
        id: 42,
        key: 'x:s1:movie:1',
        kind: 'movie',
        sourceId: 's1',
        providerId: '1',
        name: 'Neon Horizon',
        logo: null,
        rating: 8.4,
        year: 2025,
        num: null,
      },
    });
    expect(movieTarget).toMatchObject({
      itemKey: 'x:s1:movie:1',
      kind: 'movie',
      catalogId: 42,
    });
    expect(
      buildHomeDetailTarget({
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        kind: 'live',
        title: 'Channel 1',
        subtitle: null,
        backdropUri: null,
        posterUri: null,
        year: null,
        rating: null,
        durationMs: 0,
        positionMs: 0,
        watched: false,
      }),
    ).toBeUndefined();
  });
});
