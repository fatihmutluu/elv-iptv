import type {
  FavoriteRow,
  ItemRow,
  RatingRow,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import type { DownloadRecord } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it, vi } from 'vitest';
import {
  buildActiveDownloadMenuItems,
  buildDownloadedMediaMenuItems,
  buildLibraryLiveMenuItems,
  buildLibraryVodMenuItems,
} from './library-context-menu';
import {
  buildLibraryDetailTarget,
  buildLibraryPlayTarget,
  buildOfflineEpisodePlayTarget,
  collectItemKeysFromCollections,
  deriveSeriesKeyFromEpisodeRecord,
  findDropTargetAtPoint,
  formatDownloadedSeriesSubtitle,
  formatLibraryDownloadProgressMeta,
  GENERAL_LIBRARY_DROP_TARGET_ID,
  groupDownloadedSeries,
  isGeneralLibraryDropTarget,
  LIBRARY_SUB_TABS,
  mapCollectionItemsToLibraryCards,
  mapWatchedRowsToLibraryCards,
  partitionFavoritesForLibrary,
  partitionLibraryDownloads,
  partitionRatingsForLibrary,
  resolveLibraryDownloadStatusKey,
} from './library-model';

function makeDownload(overrides: Partial<DownloadRecord>): DownloadRecord {
  return {
    id: 'dl-1',
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'movie:src-1:1',
    kind: 'movie',
    title: 'Sample Movie',
    seriesTitle: null,
    season: null,
    episodeNum: null,
    poster: 'https://img.example/poster.jpg',
    localFileName: 'sample.mp4',
    localUri: 'file:///downloads/sample.mp4',
    bytesDownloaded: 500_000_000,
    totalBytes: 500_000_000,
    status: 'completed',
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: 2000,
    ...overrides,
  };
}

describe('library-model', () => {
  it('exposes the 4 canonical Library sub-tabs in editorial order', () => {
    expect(LIBRARY_SUB_TABS).toEqual(['following', 'likes', 'watched', 'downloads']);
  });

  it('partitions favorites into live, series, and movies preserving custom sort order', () => {
    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'live:s1:2',
        kind: 'live',
        title: 'Channel B',
        logo: null,
        year: null,
        rating: null,
        addedAt: 100,
        sortOrder: 0,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'series:s1:10',
        kind: 'series',
        title: 'Arcane',
        logo: 'https://img.example/arcane.jpg',
        year: 2021,
        rating: 9.0,
        addedAt: 200,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'live:s1:1',
        kind: 'live',
        title: 'Channel A',
        logo: null,
        year: null,
        rating: null,
        addedAt: 50,
        sortOrder: 1,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:5',
        kind: 'movie',
        title: 'Dune',
        logo: null,
        year: 2021,
        rating: 8.1,
        addedAt: 300,
      },
    ];

    const res = partitionFavoritesForLibrary(favorites);
    expect(res.live.map((c) => c.itemKey)).toEqual(['live:s1:2', 'live:s1:1']);
    expect(res.series.map((c) => c.itemKey)).toEqual(['series:s1:10']);
    expect(res.movies.map((c) => c.itemKey)).toEqual(['movie:s1:5']);

    // Folder semantics (#508): collected movies & series are excluded from general rails while live stays untouched
    const collectedKeys = collectItemKeysFromCollections([
      {
        collection: {
          id: 'c1',
          profileId: 'default',
          name: 'Sci-Fi',
          sortOrder: 0,
          itemCount: 2,
          createdAt: 1,
          updatedAt: 1,
        },
        items: [
          {
            id: 1,
            key: 'movie:s1:5',
            sourceId: 's1',
            providerId: '5',
            kind: 'movie',
            name: 'Dune',
            logo: null,
            num: null,
            year: 2021,
            rating: 8.1,
          },
          {
            id: 2,
            key: 'series:s1:10',
            sourceId: 's1',
            providerId: '10',
            kind: 'series',
            name: 'Arcane',
            logo: null,
            num: null,
            year: 2021,
            rating: 9.0,
          },
        ],
      },
    ]);
    const folderPartition = partitionFavoritesForLibrary(favorites, collectedKeys);
    expect(folderPartition.live.map((c) => c.itemKey)).toEqual(['live:s1:2', 'live:s1:1']);
    expect(folderPartition.movies).toEqual([]);
    expect(folderPartition.series).toEqual([]);
  });

  it('adds Move to collection and Remove from collection context actions and hit-tests drop rects (#508)', () => {
    const i18n = createAppI18n('en');
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const items = buildLibraryVodMenuItems({
      t: i18n.t,
      kind: 'movie',
      isFavorite: true,
      ratingValue: null,
      isWatched: false,
      collections: [
        { id: 'c1', name: 'Sci-Fi' },
        { id: 'c2', name: 'Weekend' },
      ],
      currentCollectionId: 'c1',
      onOpenDetail: vi.fn(),
      onToggleFavorite: vi.fn(),
      onToggleLike: vi.fn(),
      onToggleDislike: vi.fn(),
      onMoveToCollection: onMove,
      onRemoveFromCollection: onRemove,
    });

    // Excludes current collection c1, includes sibling c2 + Remove from collection
    expect(items.find((i) => i.id === 'move-to-collection-c1')).toBeUndefined();
    const moveC2 = items.find((i) => i.id === 'move-to-collection-c2');
    expect(moveC2?.label).toBe('Move to Weekend');
    moveC2?.onSelect();
    expect(onMove).toHaveBeenCalledWith('c2');

    const removeAction = items.find((i) => i.id === 'remove-from-collection');
    expect(removeAction?.label).toBe('Remove from collection');
    expect(removeAction?.destructive).toBe(true);
    removeAction?.onSelect();
    expect(onRemove).toHaveBeenCalledWith('c1');

    const rects = new Map([
      ['c1', { x: 0, y: 100, width: 400, height: 120 }],
      ['c2', { x: 0, y: 260, width: 400, height: 120 }],
    ]);
    expect(findDropTargetAtPoint(rects, 50, 150)).toBe('c1');
    expect(findDropTargetAtPoint(rects, 50, 300)).toBe('c2');
    expect(findDropTargetAtPoint(rects, 50, 230)).toBeNull();

    expect(isGeneralLibraryDropTarget(GENERAL_LIBRARY_DROP_TARGET_ID)).toBe(true);
    expect(isGeneralLibraryDropTarget(`${GENERAL_LIBRARY_DROP_TARGET_ID}:series`)).toBe(true);
    expect(isGeneralLibraryDropTarget(`${GENERAL_LIBRARY_DROP_TARGET_ID}:movies`)).toBe(true);
    expect(isGeneralLibraryDropTarget(`${GENERAL_LIBRARY_DROP_TARGET_ID}other`)).toBe(false);
    expect(isGeneralLibraryDropTarget('c1')).toBe(false);
    expect(isGeneralLibraryDropTarget(null)).toBe(false);
  });

  it('partitions ratings into liked and disliked rails', () => {
    const ratings: RatingRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:1',
        kind: 'movie',
        value: 'like',
        title: 'Arrival',
        logo: null,
        year: 2016,
        rating: 7.9,
        updatedAt: 200,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'series:s1:2',
        kind: 'series',
        value: 'dislike',
        title: 'Bad Show',
        logo: null,
        year: 2020,
        rating: 4.1,
        updatedAt: 100,
      },
    ];

    const res = partitionRatingsForLibrary(ratings);
    expect(res.liked).toHaveLength(1);
    expect(res.liked[0]?.itemKey).toBe('movie:s1:1');
    expect(res.liked[0]?.ratingValue).toBe('like');
    expect(res.disliked).toHaveLength(1);
    expect(res.disliked[0]?.itemKey).toBe('series:s1:2');
    expect(res.disliked[0]?.ratingValue).toBe('dislike');
  });

  it('maps watched rows and collection items into deduplicated library cards', () => {
    const watched: WatchProgressRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:9',
        kind: 'movie',
        title: 'Blade Runner',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 7200_000,
        durationMs: 7200_000,
        watched: true,
        updatedAt: 500,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'movie:s1:9',
        kind: 'movie',
        title: 'Blade Runner',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 7200_000,
        durationMs: 7200_000,
        watched: true,
        updatedAt: 400,
      },
    ];
    const watchedCards = mapWatchedRowsToLibraryCards(watched, 'movie');
    expect(watchedCards).toHaveLength(1);
    expect(watchedCards[0]?.allWatched).toBe(true);

    const collectionItems: ItemRow[] = [
      {
        id: 1,
        key: 'movie:s1:99',
        sourceId: 's1',
        providerId: '99',
        kind: 'movie',
        name: 'Interstellar',
        logo: null,
        num: null,
        year: 2014,
        rating: 8.7,
      },
    ];
    const colCards = mapCollectionItemsToLibraryCards(collectionItems);
    expect(colCards).toHaveLength(1);
    expect(colCards[0]?.title).toBe('Interstellar');
  });

  it('partitions downloads into active, completed movies, completed episodes, and total bytes', () => {
    const records: DownloadRecord[] = [
      makeDownload({
        id: '1',
        itemKey: 'm1',
        kind: 'movie',
        status: 'downloading',
        localUri: null,
        bytesDownloaded: 100,
        totalBytes: 1000,
      }),
      makeDownload({ id: '2', itemKey: 'm2', kind: 'movie', status: 'completed', totalBytes: 400 }),
      makeDownload({
        id: '3',
        itemKey: 'e1',
        kind: 'episode',
        status: 'completed',
        seriesTitle: 'Severance',
        season: 1,
        episodeNum: 1,
        totalBytes: 300,
      }),
      makeDownload({
        id: '4',
        itemKey: 'm3',
        kind: 'movie',
        status: 'canceled',
        localUri: null,
        totalBytes: 999,
      }),
    ];

    const res = partitionLibraryDownloads(records);
    expect(res.active.map((r) => r.itemKey)).toEqual(['m1']);
    expect(res.completedMovies.map((r) => r.itemKey)).toEqual(['m2']);
    expect(res.completedEpisodes.map((r) => r.itemKey)).toEqual(['e1']);
    expect(res.totalCompletedBytes).toBe(700);
  });

  it('derives seriesKey and groups downloaded episodes sorted by season/episode with live totals', () => {
    const ep2 = makeDownload({
      id: 'e2',
      sourceId: 's1',
      itemKey: 'x:s1:episode:42:1:2',
      kind: 'episode',
      title: 'Half Loop',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 2,
      totalBytes: 200,
    });
    const ep1 = makeDownload({
      id: 'e1',
      sourceId: 's1',
      itemKey: 'x:s1:episode:42:1:1',
      kind: 'episode',
      title: 'Good News About Hell',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 1,
      totalBytes: 150,
    });
    const epM3u = makeDownload({
      id: 'e3',
      sourceId: 's2',
      itemKey: 'm:s2:episode:n:ep1|dark',
      kind: 'episode',
      title: 'Secrets',
      seriesTitle: 'Dark',
      season: 1,
      episodeNum: 1,
      totalBytes: 300,
    });

    expect(deriveSeriesKeyFromEpisodeRecord(ep1)).toBe('x:s1:series:42');
    expect(deriveSeriesKeyFromEpisodeRecord(epM3u)).toBe('m:s2:series:dark');

    const unplayed = new Map<string, SeriesUnplayedSummary>([
      ['x:s1:series:42', { seriesKey: 'x:s1:series:42', total: 11, unplayed: 5, watched: false }],
    ]);
    const groups = groupDownloadedSeries([ep2, ep1, epM3u], {
      unplayedBySeriesKey: unplayed,
      newEpisodeSeriesKeys: new Set(['x:s1:series:42']),
    });

    expect(groups).toHaveLength(2);
    const sev = groups.find((g) => g.seriesTitle === 'Severance');
    expect(sev?.seriesKey).toBe('x:s1:series:42');
    expect(sev?.downloadedCount).toBe(2);
    expect(sev?.totalEpisodes).toBe(11);
    expect(sev?.hasNewEpisodes).toBe(true);
    expect(sev?.episodes.map((e) => e.episodeNum)).toEqual([1, 2]);
    expect(sev?.totalBytes).toBe(350);

    const i18n = createAppI18n('en');
    expect(sev).toBeDefined();
    if (sev) {
      expect(formatDownloadedSeriesSubtitle(sev, i18n.t)).toBe('2 / 11 episodes downloaded');
    }
    const dark = groups.find((g) => g.seriesTitle === 'Dark');
    expect(dark).toBeDefined();
    if (dark) {
      expect(formatDownloadedSeriesSubtitle(dark, i18n.t)).toBe('1 episodes downloaded');
    }
  });

  it('builds detail and play targets including zero-connection offline episode play target', () => {
    const ep = makeDownload({
      itemKey: 'x:s1:episode:42:1:3',
      kind: 'episode',
      title: 'In Perpetuity',
      seriesTitle: 'Severance',
      season: 1,
      episodeNum: 3,
      localUri: 'file:///dl/s1e3.mp4',
    });
    const offlineTarget = buildOfflineEpisodePlayTarget(ep);
    expect(offlineTarget).toMatchObject({
      itemKey: 'x:s1:episode:42:1:3',
      kind: 'vod',
      itemKind: 'episode',
      isLocalOffline: true,
      localFileUri: 'file:///dl/s1e3.mp4',
      subtitle: 'Severance · S1E3',
      season: 1,
      episode: 3,
    });

    const liveTarget = buildLibraryPlayTarget({
      id: 'live:s1:1',
      itemKey: 'live:s1:1',
      sourceId: 's1',
      kind: 'live',
      title: 'BBC News',
      imageUri: null,
    });
    expect(liveTarget.kind).toBe('live');

    expect(
      buildLibraryDetailTarget({
        itemKey: 'live:s1:1',
        sourceId: 's1',
        kind: 'live',
        title: 'BBC News',
        imageUri: null,
      }),
    ).toBeUndefined();

    expect(
      buildLibraryDetailTarget({
        itemKey: 'movie:s1:1',
        sourceId: 's1',
        kind: 'movie',
        title: 'Dune',
        imageUri: 'https://img/dune.jpg',
        year: 2021,
        rating: 8.1,
      }),
    ).toMatchObject({ itemKey: 'movie:s1:1', kind: 'movie', title: 'Dune' });
  });

  it('formats download status keys and progress metadata', () => {
    const paused = makeDownload({
      status: 'paused',
      pausedForPlayback: true,
      bytesDownloaded: 500,
      totalBytes: 1000,
    });
    expect(resolveLibraryDownloadStatusKey(paused)).toBe('downloads.statusPausedForPlayback');
    expect(formatLibraryDownloadProgressMeta(paused)).toContain('50%');
  });

  it('builds context menu items for live, vod, downloaded, and active download cards', () => {
    const i18n = createAppI18n('en');
    const liveItems = buildLibraryLiveMenuItems({
      t: i18n.t,
      onPlay: vi.fn(),
      onOpenMultiView: vi.fn(),
      onOpenPopout: vi.fn(),
      onRemoveFavorite: vi.fn(),
    });
    expect(liveItems.map((i) => i.id)).toEqual([
      'play',
      'open-multiview',
      'open-popout',
      'remove-favorite',
    ]);

    const vodItems = buildLibraryVodMenuItems({
      t: i18n.t,
      kind: 'movie',
      isFavorite: true,
      ratingValue: 'like',
      isWatched: false,
      canDownload: true,
      onPlay: vi.fn(),
      onOpenDetail: vi.fn(),
      onToggleFavorite: vi.fn(),
      onToggleLike: vi.fn(),
      onToggleDislike: vi.fn(),
      onToggleWatched: vi.fn(),
      onDownload: vi.fn(),
    });
    expect(vodItems.map((i) => i.id)).toEqual([
      'play',
      'detail',
      'toggle-favorite',
      'toggle-like',
      'toggle-dislike',
      'toggle-watched',
      'download',
    ]);
    expect(vodItems.find((i) => i.id === 'toggle-like')?.label).toBe('Remove like');

    const dlItems = buildDownloadedMediaMenuItems({
      t: i18n.t,
      onPlayOffline: vi.fn(),
      onOpenMultiView: vi.fn(),
      onOpenDetail: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(dlItems.map((i) => i.id)).toEqual([
      'play-offline',
      'open-multiview',
      'detail',
      'delete-download',
    ]);

    const activeItems = buildActiveDownloadMenuItems({
      t: i18n.t,
      isPausedOrFailed: false,
      onTogglePauseResume: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(activeItems.map((i) => i.id)).toEqual(['pause-download', 'cancel-download']);
  });
});
