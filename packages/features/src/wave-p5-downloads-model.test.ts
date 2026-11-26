import type { ItemRow } from '@elv/data';
import type { DownloadRecord } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it, vi } from 'vitest';
import { buildCatalogPosterContextMenuItems } from './catalog/catalog-context-menu';
import {
  buildDownloadContextMenuItems,
  buildOfflinePlayTarget,
  formatDownloadProgressMeta,
  formatDownloadSubtitle,
  partitionDownloads,
  resolveDownloadStatusKey,
} from './downloads/downloads-model';
import { buildHomeCardContextMenuItems } from './home/home-context-menu';
import type { HomeRailEntry } from './home/home-model';
import { buildSearchVodContextMenuItems } from './search/search-context-menu';

const i18n = createAppI18n('en');

function makeRecord(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'dl-1',
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'movie:src-1:101',
    kind: 'movie',
    title: 'Blade Runner',
    localFileName: 'blade-runner.mp4',
    localUri: 'file:///app/downloads/blade-runner.mp4',
    bytesDownloaded: 1024 * 1024 * 500,
    totalBytes: 1024 * 1024 * 500,
    status: 'completed',
    createdAt: 1_000,
    updatedAt: 2_000,
    completedAt: 2_000,
    ...overrides,
  };
}

describe('downloads-model', () => {
  it('partitions active, completed, and ignores canceled records while summing completed bytes', () => {
    const active = makeRecord({
      id: 'dl-a',
      itemKey: 'movie:src-1:1',
      status: 'downloading',
      localUri: null,
      bytesDownloaded: 200,
      totalBytes: 1000,
    });
    const completed = makeRecord({
      id: 'dl-c',
      itemKey: 'movie:src-1:2',
      status: 'completed',
      bytesDownloaded: 500,
      totalBytes: 500,
    });
    const canceled = makeRecord({
      id: 'dl-x',
      itemKey: 'movie:src-1:3',
      status: 'canceled',
      localUri: null,
    });

    const result = partitionDownloads([active, completed, canceled]);
    expect(result.active).toEqual([active]);
    expect(result.completed).toEqual([completed]);
    expect(result.totalCompletedBytes).toBe(500);
  });

  it('formats subtitles only for episodes', () => {
    expect(formatDownloadSubtitle(makeRecord({ kind: 'movie' }))).toBeNull();
    expect(
      formatDownloadSubtitle(
        makeRecord({ kind: 'episode', seriesTitle: 'Andor', season: 1, episodeNum: 3 }),
      ),
    ).toBe('Andor · S1E3');
    expect(
      formatDownloadSubtitle(
        makeRecord({ kind: 'episode', seriesTitle: null, season: null, episodeNum: 7 }),
      ),
    ).toBe('E7');
  });

  it('prioritizes pausedForPlayback status key', () => {
    expect(
      resolveDownloadStatusKey(makeRecord({ status: 'paused', pausedForPlayback: true })),
    ).toBe('downloads.statusPausedForPlayback');
    expect(resolveDownloadStatusKey(makeRecord({ status: 'paused' }))).toBe(
      'downloads.statusPaused',
    );
    expect(resolveDownloadStatusKey(makeRecord({ status: 'failed' }))).toBe(
      'downloads.statusFailed',
    );
  });

  it('formats progress metadata with percentage when totalBytes is known', () => {
    const meta = formatDownloadProgressMeta(
      makeRecord({ bytesDownloaded: 512 * 1024, totalBytes: 1024 * 1024 }),
    );
    expect(meta).toContain('50%');
    const unknownTotal = formatDownloadProgressMeta(
      makeRecord({ bytesDownloaded: 2048, totalBytes: null }),
    );
    expect(unknownTotal).toBe('2.0 KB');
  });

  it('builds zero-connection offline PlayTarget from completed record', () => {
    const ep = makeRecord({
      kind: 'episode',
      itemKey: 'ep:src-1:99',
      title: 'The Reckoning',
      seriesTitle: 'Andor',
      season: 1,
      episodeNum: 3,
      poster: 'https://img.example/andor.jpg',
    });
    const target = buildOfflinePlayTarget(ep);
    expect(target).toMatchObject({
      itemKey: 'ep:src-1:99',
      sourceId: 'src-1',
      title: 'The Reckoning',
      kind: 'vod',
      itemKind: 'episode',
      isLocalOffline: true,
      localFileUri: 'file:///app/downloads/blade-runner.mp4',
      subtitle: 'Andor · S1E3',
      season: 1,
      episode: 3,
      logo: 'https://img.example/andor.jpg',
    });
  });

  it('builds context menu items with optional Multi-View and destructive delete', () => {
    const rec = makeRecord();
    const onPlayOffline = vi.fn();
    const onOpenMultiView = vi.fn();
    const onDelete = vi.fn();
    const items = buildDownloadContextMenuItems({
      record: rec,
      t: i18n.t,
      onPlayOffline,
      onOpenMultiView,
      onDelete,
    });
    expect(items.map((item) => item.id)).toEqual([
      'play-offline',
      'open-multiview',
      'delete-download',
    ]);
    expect(items[2]?.destructive).toBe(true);
    items[0]?.onSelect();
    items[1]?.onSelect();
    items[2]?.onSelect();
    expect(onPlayOffline).toHaveBeenCalledWith(rec);
    expect(onOpenMultiView).toHaveBeenCalledWith(rec);
    expect(onDelete).toHaveBeenCalledWith(rec);
  });
});

describe('Wave P5 context menu download CTAs', () => {
  it('adds Download / Delete download to Home movie cards and never to Live TV cards', () => {
    const movieEntry: HomeRailEntry = {
      itemKey: 'movie:s1:1',
      sourceId: 's1',
      kind: 'movie',
      title: 'Dune',
      subtitle: null,
      backdropUri: null,
      posterUri: null,
      year: 2021,
      rating: 8.1,
      durationMs: 0,
      positionMs: 0,
      watched: false,
    };
    const liveEntry: HomeRailEntry = { ...movieEntry, itemKey: 'live:s1:1', kind: 'live' };
    const onDownload = vi.fn();
    const onDeleteDownload = vi.fn();

    const movieItems = buildHomeCardContextMenuItems({
      railId: 'movies',
      entry: movieEntry,
      index: 0,
      isFavorite: false,
      isWatched: false,
      isDownloaded: false,
      t: i18n.t,
      onPlay: vi.fn(),
      onDownload,
      onDeleteDownload,
    });
    expect(movieItems.some((i) => i.id === 'download')).toBe(true);
    movieItems.find((i) => i.id === 'download')?.onSelect();
    expect(onDownload).toHaveBeenCalledWith(movieEntry);

    const downloadedItems = buildHomeCardContextMenuItems({
      railId: 'movies',
      entry: movieEntry,
      index: 0,
      isFavorite: false,
      isWatched: false,
      isDownloaded: true,
      t: i18n.t,
      onPlay: vi.fn(),
      onDownload,
      onDeleteDownload,
    });
    const del = downloadedItems.find((i) => i.id === 'deleteDownload');
    expect(del?.destructive).toBe(true);
    del?.onSelect();
    expect(onDeleteDownload).toHaveBeenCalledWith(movieEntry);

    const liveItems = buildHomeCardContextMenuItems({
      railId: 'live',
      entry: liveEntry,
      index: 0,
      isFavorite: false,
      isWatched: false,
      isDownloaded: false,
      t: i18n.t,
      onPlay: vi.fn(),
      onDownload,
      onDeleteDownload,
    });
    expect(liveItems.some((i) => i.id === 'download' || i.id === 'deleteDownload')).toBe(false);
  });

  it('adds Download / Delete download to Catalog & Search movie cards only', () => {
    const movie: ItemRow = {
      id: 7,
      providerId: '7',
      key: 'movie:s1:7',
      sourceId: 's1',
      kind: 'movie',
      name: 'Arrival',
      logo: null,
      num: null,
      year: 2016,
      rating: 7.9,
    };
    const series: ItemRow = { ...movie, key: 'series:s1:8', kind: 'series' };

    const catalogMovie = buildCatalogPosterContextMenuItems({
      item: movie,
      isFavorite: false,
      isWatched: false,
      isDownloaded: false,
      i18n,
      onOpenDetail: vi.fn(),
      onDownload: vi.fn(),
      onDeleteDownload: vi.fn(),
    });
    expect(catalogMovie.some((i) => i.id === 'download')).toBe(true);

    const catalogSeries = buildCatalogPosterContextMenuItems({
      item: series,
      isFavorite: false,
      isWatched: false,
      isDownloaded: false,
      i18n,
      onOpenDetail: vi.fn(),
      onDownload: vi.fn(),
      onDeleteDownload: vi.fn(),
    });
    expect(catalogSeries.some((i) => i.id === 'download')).toBe(false);

    const searchDownloaded = buildSearchVodContextMenuItems({
      item: movie,
      isFavorite: false,
      isWatched: false,
      isDownloaded: true,
      i18n,
      onOpenDetail: vi.fn(),
      onDownload: vi.fn(),
      onDeleteDownload: vi.fn(),
    });
    expect(searchDownloaded.find((i) => i.id === 'deleteDownload')?.destructive).toBe(true);
  });
});
