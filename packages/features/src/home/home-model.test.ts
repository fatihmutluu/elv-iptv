import type {
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  NowNextEntry,
  WatchProgressRow,
} from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it, vi } from 'vitest';
import { buildHomeCardContextMenuItems } from './home-context-menu';
import {
  buildHeroSlides,
  buildHomeCollectionRails,
  buildHomeDetailTarget,
  buildHomeLivePlayTarget,
  buildUnifiedLiveRail,
  buildVodPlayTarget,
  computePeekCardWidth,
  formatLiveChannelName,
  formatRemainingMinutes,
  HOME_LIVE_RAIL_LIMIT,
  progressRatio,
  resolveHomeLivePlayTarget,
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
    expect(computePeekCardWidth(1920, 24, 5.5, 10, 184)).toBe(184);
    expect(computePeekCardWidth(1920, 24, 3.3, 10, 296)).toBe(296);
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

  it('builds non-empty Home collection rails preserving order and watch progress (#403)', () => {
    const prog = makeProgress({
      itemKey: 'x:src-1:movie:1',
      positionMs: 240_000,
      durationMs: 600_000,
      watched: false,
    });
    const progressByKey = new Map<string, WatchProgressRow>([[prog.itemKey, prog]]);
    const rails = buildHomeCollectionRails(
      [
        {
          collection: {
            id: 'c-empty',
            profileId: 'default',
            name: 'Empty',
            sortOrder: 0,
            itemCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          items: [],
        },
        {
          collection: {
            id: 'c-sci',
            profileId: 'default',
            name: 'Sci-Fi Classics',
            sortOrder: 1,
            itemCount: 2,
            createdAt: 2,
            updatedAt: 2,
          },
          items: [
            makeItem({ id: 1, key: 'x:src-1:movie:1', kind: 'movie', name: 'Neon Horizon' }),
            makeItem({ id: 2, key: 'x:src-1:series:2', kind: 'series', name: 'Starlight Harbor' }),
          ],
        },
      ],
      progressByKey,
    );

    expect(rails).toHaveLength(1);
    expect(rails[0]?.id).toBe('collection:c-sci');
    expect(rails[0]?.collectionId).toBe('c-sci');
    expect(rails[0]?.title).toBe('Sci-Fi Classics');
    expect(rails[0]?.items.map((i) => i.itemKey)).toEqual(['x:src-1:movie:1', 'x:src-1:series:2']);
    expect(rails[0]?.items[0]).toMatchObject({
      positionMs: 240_000,
      durationMs: 600_000,
      watched: false,
    });
    expect(rails[0]?.items[1]?.kind).toBe('series');
  });

  it('builds unified 12-card Live TV rail in strict Favorites -> Recent -> On-Now cascade order with deduplication and EPG enrichment', () => {
    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'x:src-1:movie:99',
        kind: 'movie',
        title: 'Ignored Movie Fav',
        logo: null,
        year: 2024,
        rating: 8,
        addedAt: 100,
      },
      {
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'x:src-1:live:fav-2',
        kind: 'live',
        title: 'Fav Two',
        logo: 'https://art.example.test/fav2.png',
        year: null,
        rating: null,
        addedAt: 200,
      },
      {
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'x:src-1:live:fav-1',
        kind: 'live',
        title: 'Fav One',
        logo: 'https://art.example.test/fav1.png',
        year: null,
        rating: null,
        addedAt: 100,
      },
    ];
    const recentChannels: ItemRow[] = [
      makeItem({ id: 10, key: 'x:src-1:live:fav-1', kind: 'live', name: 'Fav One', num: 1 }),
      makeItem({ id: 11, key: 'x:src-1:live:rec-1', kind: 'live', name: 'Recent One', num: 11 }),
      makeItem({ id: 12, key: 'x:src-1:live:rec-2', kind: 'live', name: 'Recent Two', num: 12 }),
    ];
    const liveItems: ItemRow[] = Array.from({ length: 15 }, (_, idx) =>
      makeItem({
        id: 100 + idx,
        key: idx === 0 ? 'x:src-1:live:rec-1' : `x:src-1:live:on-${idx}`,
        kind: 'live',
        name: `On Now ${idx}`,
        num: 20 + idx,
      }),
    );
    const nowNextByKey = new Map<string, NowNextEntry>([
      [
        'x:src-1:live:fav-2',
        {
          channelKey: 'x:src-1:live:fav-2',
          now: {
            channelKey: 'x:src-1:live:fav-2',
            title: 'Evening News',
            description: null,
            start: 1_000,
            stop: 2_000,
          } as unknown as NowNextEntry['now'],
          next: null,
        },
      ],
    ]);

    const result = buildUnifiedLiveRail({
      favorites,
      recentChannels,
      liveItems,
      liveCategoryName: 'General',
      nowNextByKey,
    });

    expect(result).toHaveLength(HOME_LIVE_RAIL_LIMIT);
    expect(result.map((e) => e.itemKey).slice(0, 6)).toEqual([
      'x:src-1:live:fav-2',
      'x:src-1:live:fav-1',
      'x:src-1:live:rec-1',
      'x:src-1:live:rec-2',
      'x:src-1:live:on-1',
      'x:src-1:live:on-2',
    ]);
    expect(result[0]?.subtitle).toBe('Evening News');
    expect(result[1]?.title).toBe('1. Fav One');
    expect(result[2]?.subtitle).toBe('General');
  });

  it('builds context menu items for Continue Watching, Live TV, and Poster Home rails', () => {
    const i18n = createAppI18n('en');
    const onPlay = vi.fn();
    const onOpenDetail = vi.fn();
    const onRemoveFromContinue = vi.fn();
    const onToggleFavorite = vi.fn();
    const onToggleWatched = vi.fn();
    const onOpenMultiView = vi.fn();
    const onOpenPopout = vi.fn();

    const cwEntry = {
      itemKey: 'x:src-1:movie:1',
      sourceId: 'src-1',
      kind: 'movie' as const,
      title: 'Neon Horizon',
      subtitle: null,
      backdropUri: null,
      posterUri: null,
      year: 2025,
      rating: 8.1,
      durationMs: 600_000,
      positionMs: 120_000,
      watched: false,
    };
    const cwItems = buildHomeCardContextMenuItems({
      railId: 'continue',
      entry: cwEntry,
      index: 0,
      isFavorite: false,
      isWatched: false,
      t: i18n.t,
      onPlay,
      onOpenDetail,
      onRemoveFromContinue,
      onToggleWatched,
    });
    expect(cwItems.map((i) => i.id)).toEqual([
      'resume',
      'details',
      'hideFromContinue',
      'markWatched',
    ]);
    expect(cwItems.find((i) => i.id === 'hideFromContinue')?.destructive).toBe(true);

    const liveItems = buildHomeCardContextMenuItems({
      railId: 'live',
      entry: { ...cwEntry, itemKey: 'x:src-1:live:1', kind: 'live', live: true },
      index: 1,
      isFavorite: true,
      isWatched: false,
      t: i18n.t,
      onPlay,
      onOpenMultiView,
      onOpenPopout,
      onToggleFavorite,
    });
    expect(liveItems.map((i) => i.id)).toEqual(['play', 'multiview', 'popout', 'favorite']);
    expect(liveItems.find((i) => i.id === 'favorite')?.label).toBe('Remove from favorites');

    const posterItems = buildHomeCardContextMenuItems({
      railId: 'movies',
      entry: cwEntry,
      index: 2,
      isFavorite: true,
      isWatched: true,
      t: i18n.t,
      onPlay,
      onOpenDetail,
      onToggleFavorite,
      onToggleWatched,
    });
    expect(posterItems.map((i) => i.id)).toEqual(['play', 'details', 'mylist', 'watched']);
    expect(posterItems.find((i) => i.id === 'watched')?.label).toBe('Mark as unwatched');
  });

  it('resolves unified Live TV rail PlayTarget using real liveItems index or standalone fallback with logo', () => {
    const liveCategory = {
      id: 'cat-live',
      sourceId: 'src-1',
      kind: 'live' as const,
      name: 'General',
      position: 0,
      itemCount: 3,
    };
    const ch0 = makeItem({
      id: 1,
      key: 'x:src-1:live:1',
      kind: 'live',
      name: 'Alpha',
      num: 1,
      logo: 'https://art.test/a.png',
    });
    const ch1 = makeItem({
      id: 2,
      key: 'x:src-1:live:2',
      kind: 'live',
      name: 'Beta',
      num: 2,
      logo: 'https://art.test/b.png',
    });
    const otherCatCh = makeItem({
      id: 99,
      key: 'x:src-1:live:99',
      kind: 'live',
      name: 'Sports Fav',
      num: 99,
      logo: 'https://art.test/s.png',
    });
    const catalog = { items: vi.fn(async () => [ch0, ch1]) } as unknown as CatalogService;

    const inCatTarget = resolveHomeLivePlayTarget(catalog, liveCategory, [ch0, ch1], {
      itemKey: ch1.key,
      sourceId: 'src-1',
      kind: 'live',
      title: '2. Beta',
      subtitle: null,
      backdropUri: ch1.logo,
      posterUri: ch1.logo,
      year: null,
      rating: null,
      durationMs: 0,
      positionMs: 0,
      watched: false,
      live: true,
      catalogItem: ch1,
    });
    expect(inCatTarget.playlist?.currentIndex).toBe(1);
    expect(inCatTarget.itemKind).toBe('live');

    const foreignTarget = resolveHomeLivePlayTarget(catalog, liveCategory, [ch0, ch1], {
      itemKey: otherCatCh.key,
      sourceId: 'src-1',
      kind: 'live',
      title: '99. Sports Fav',
      subtitle: null,
      backdropUri: null,
      posterUri: 'https://art.test/fav-override.png',
      year: null,
      rating: null,
      durationMs: 0,
      positionMs: 0,
      watched: false,
      live: true,
      catalogItem: otherCatCh,
    });
    expect(foreignTarget.playlist).toBeUndefined();
    expect(foreignTarget.itemKind).toBe('live');
    expect(foreignTarget.logo).toBe('https://art.test/fav-override.png');
  });
});
