import type {
  FavoriteRow,
  ItemRow,
  RatingRow,
  RatingValue,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import {
  computeDownloadProgressRatio,
  type DownloadRecord,
  formatDownloadBytes,
  isPlayableDownload,
} from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { PlayTarget } from '../ports/play-target';
import { type DetailTarget, formatVodMeta, type HydratedVodCollection } from '../shared';

/** Canonical sub-tabs inside the unified Cinema Quietude `Library` hub. */
export type LibrarySubTab = 'following' | 'likes' | 'watched' | 'downloads';

/** Ordered list of the 4 borderless editorial Library sub-tabs. */
export const LIBRARY_SUB_TABS: readonly LibrarySubTab[] = [
  'following',
  'likes',
  'watched',
  'downloads',
];

/** Unified card model rendered in Library rails and `See all` grids. */
export interface LibraryCardItem {
  readonly id: string;
  readonly itemKey: string;
  readonly sourceId: string;
  readonly kind: 'live' | 'movie' | 'series';
  readonly title: string;
  readonly imageUri: string | null;
  readonly subtitle?: string;
  readonly year?: number | null;
  readonly rating?: number | null;
  readonly badge?: string;
  readonly allWatched?: boolean;
  readonly ratingValue?: RatingValue | null;
  readonly downloadRecord?: DownloadRecord;
}

/** One grouped downloaded series card aggregating all completed offline episodes for that show. */
export interface DownloadedSeriesGroup {
  readonly groupId: string;
  readonly seriesKey: string | null;
  readonly sourceId: string;
  readonly seriesTitle: string;
  readonly posterUri: string | null;
  readonly episodes: readonly DownloadRecord[];
  readonly downloadedCount: number;
  readonly totalEpisodes: number | null;
  readonly hasNewEpisodes: boolean;
  readonly totalBytes: number;
}

/** Partitioned favorite rails for the `Following` sub-tab. */
export interface PartitionedLibraryFavorites {
  readonly live: readonly LibraryCardItem[];
  readonly series: readonly LibraryCardItem[];
  readonly movies: readonly LibraryCardItem[];
}

/** Partitioned personal ratings for the `Likes` sub-tab (2x2 split: Likes top, Dislikes bottom). */
export interface PartitionedLibraryRatings {
  readonly likedMovies: readonly LibraryCardItem[];
  readonly likedSeries: readonly LibraryCardItem[];
  readonly dislikedMovies: readonly LibraryCardItem[];
  readonly dislikedSeries: readonly LibraryCardItem[];
}

/** Partitioned offline downloads for the `Downloads` sub-tab. */
export interface PartitionedLibraryDownloads {
  readonly active: readonly DownloadRecord[];
  readonly completedMovies: readonly DownloadRecord[];
  readonly completedEpisodes: readonly DownloadRecord[];
  readonly totalCompletedBytes: number;
}

/** Active `See all` drill-down descriptor. */
export interface LibrarySeeAllState {
  readonly railId: string;
  readonly title: string;
  readonly kind: 'live' | 'poster' | 'downloaded-movies' | 'downloaded-series';
}

/** Localized download status message key. */
export type LibraryDownloadStatusKey =
  | 'downloads.statusPausedForPlayback'
  | 'downloads.statusQueued'
  | 'downloads.statusDownloading'
  | 'downloads.statusPaused'
  | 'downloads.statusFailed'
  | 'downloads.statusCompleted';

function recordSizeBytes(record: DownloadRecord): number {
  return record.totalBytes !== null && record.totalBytes > 0
    ? record.totalBytes
    : Math.max(0, record.bytesDownloaded);
}

/** Returns the union of all VOD item keys assigned to any custom collection. */
export function collectItemKeysFromCollections(
  collections: readonly HydratedVodCollection[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of collections) {
    for (const item of entry.items) {
      keys.add(item.key);
    }
  }
  return keys;
}

/**
 * Partitions `favorites` into Live TV (preserving custom `sortOrder`), Series, and Movies.
 * When `collectedItemKeys` is provided, any Movie or Series already filed in a folder collection
 * is excluded from the general `movies` and `series` rails (folder semantics, `#508`).
 */
export function partitionFavoritesForLibrary(
  favorites: readonly FavoriteRow[],
  collectedItemKeys?: ReadonlySet<string>,
): PartitionedLibraryFavorites {
  const liveRows: FavoriteRow[] = [];
  const series: LibraryCardItem[] = [];
  const movies: LibraryCardItem[] = [];

  for (const fav of favorites) {
    if (fav.kind === 'live') {
      liveRows.push(fav);
    } else if (fav.kind === 'series') {
      if (collectedItemKeys?.has(fav.itemKey)) continue;
      const meta = formatVodMeta(fav.year, fav.rating);
      series.push({
        id: fav.itemKey,
        itemKey: fav.itemKey,
        sourceId: fav.sourceId,
        kind: 'series',
        title: fav.title,
        imageUri: fav.logo,
        year: fav.year,
        rating: fav.rating,
        ...(meta ? { subtitle: meta } : {}),
      });
    } else if (fav.kind === 'movie') {
      if (collectedItemKeys?.has(fav.itemKey)) continue;
      const meta = formatVodMeta(fav.year, fav.rating);
      movies.push({
        id: fav.itemKey,
        itemKey: fav.itemKey,
        sourceId: fav.sourceId,
        kind: 'movie',
        title: fav.title,
        imageUri: fav.logo,
        year: fav.year,
        rating: fav.rating,
        ...(meta ? { subtitle: meta } : {}),
      });
    }
  }

  liveRows.sort((a, b) => {
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return b.addedAt - a.addedAt;
  });

  const live: LibraryCardItem[] = liveRows.map((fav) => ({
    id: fav.itemKey,
    itemKey: fav.itemKey,
    sourceId: fav.sourceId,
    kind: 'live',
    title: fav.title,
    imageUri: fav.logo,
  }));

  return { live, series, movies };
}

/** Partitions personal ratings into 4 rails: Liked Movies/Series and Disliked Movies/Series. */
export function partitionRatingsForLibrary(
  ratings: readonly RatingRow[],
): PartitionedLibraryRatings {
  const likedMovies: LibraryCardItem[] = [];
  const likedSeries: LibraryCardItem[] = [];
  const dislikedMovies: LibraryCardItem[] = [];
  const dislikedSeries: LibraryCardItem[] = [];

  for (const row of ratings) {
    const meta = formatVodMeta(row.year, row.rating);
    const card: LibraryCardItem = {
      id: row.itemKey,
      itemKey: row.itemKey,
      sourceId: row.sourceId,
      kind: row.kind,
      title: row.title,
      imageUri: row.logo,
      year: row.year,
      rating: row.rating,
      ratingValue: row.value,
      ...(meta ? { subtitle: meta } : {}),
    };
    if (row.value === 'like') {
      if (row.kind === 'movie') likedMovies.push(card);
      else likedSeries.push(card);
    } else if (row.kind === 'movie') {
      dislikedMovies.push(card);
    } else {
      dislikedSeries.push(card);
    }
  }

  return { likedMovies, likedSeries, dislikedMovies, dislikedSeries };
}

/** Maps `catalog.listWatched` rows into deduplicated Library poster cards. */
export function mapWatchedRowsToLibraryCards(
  rows: readonly WatchProgressRow[],
  kind: 'movie' | 'series',
): readonly LibraryCardItem[] {
  const seen = new Set<string>();
  const out: LibraryCardItem[] = [];
  for (const row of rows) {
    if (seen.has(row.itemKey)) continue;
    seen.add(row.itemKey);
    out.push({
      id: row.itemKey,
      itemKey: row.itemKey,
      sourceId: row.sourceId,
      kind,
      title: row.title,
      imageUri: row.logo,
      allWatched: true,
      ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    });
  }
  return out;
}

/** Maps custom VOD collection items into Library poster cards. */
export function mapCollectionItemsToLibraryCards(
  items: readonly ItemRow[],
): readonly LibraryCardItem[] {
  const out: LibraryCardItem[] = [];
  for (const item of items) {
    if (item.kind !== 'movie' && item.kind !== 'series') continue;
    const meta = formatVodMeta(item.year, item.rating);
    out.push({
      id: item.key,
      itemKey: item.key,
      sourceId: item.sourceId,
      kind: item.kind,
      title: item.name,
      imageUri: item.logo,
      year: item.year,
      rating: item.rating,
      ...(meta ? { subtitle: meta } : {}),
    });
  }
  return out;
}

/** Splits managed downloads into active queue, completed movies, completed episodes, and total bytes. */
export function partitionLibraryDownloads(
  records: readonly DownloadRecord[],
): PartitionedLibraryDownloads {
  const active: DownloadRecord[] = [];
  const completedMovies: DownloadRecord[] = [];
  const completedEpisodes: DownloadRecord[] = [];
  let totalCompletedBytes = 0;

  for (const record of records) {
    if (isPlayableDownload(record)) {
      totalCompletedBytes += recordSizeBytes(record);
      if (record.kind === 'episode') completedEpisodes.push(record);
      else completedMovies.push(record);
    } else if (record.status !== 'canceled') {
      active.push(record);
    }
  }

  return { active, completedMovies, completedEpisodes, totalCompletedBytes };
}

/**
 * Derives the parent `seriesKey` for a downloaded episode record: prefers an explicit persisted
 * `record.seriesKey` first, then falls back to an optional `(sourceId|title) -> seriesKey` map
 * or canonical M3U / Xtream key formats.
 */
export function deriveSeriesKeyFromEpisodeRecord(
  record: Pick<DownloadRecord, 'sourceId' | 'itemKey' | 'seriesKey' | 'seriesTitle'>,
  knownSeriesByTitle?: ReadonlyMap<string, string>,
): string | null {
  const explicitKey = record.seriesKey?.trim();
  if (explicitKey && explicitKey.length > 0) {
    return explicitKey;
  }

  const titleNorm = record.seriesTitle?.trim().toLowerCase();
  if (titleNorm && knownSeriesByTitle) {
    const matched = knownSeriesByTitle.get(`${record.sourceId}|${titleNorm}`);
    if (matched) return matched;
  }

  const key = record.itemKey;
  const pipeIdx = key.lastIndexOf('|');
  if (key.startsWith('m:') && pipeIdx > 0) {
    const seriesSlug = key.slice(pipeIdx + 1).trim();
    const parts = key.slice(0, pipeIdx).split(':');
    const src = parts[1];
    if (src && seriesSlug) return `m:${src}:series:${seriesSlug}`;
  }

  const parts = key.split(':');
  // x:<sourceId>:episode:<seriesId>:<season>:<ep>
  if (parts.length >= 6 && parts[2] === 'episode' && parts[1] && parts[3]) {
    return `${parts[0]}:${parts[1]}:series:${parts[3]}`;
  }

  return null;
}

/** Groups completed downloaded episodes into one card per series sorted by `(season, episodeNum)`. */
export function groupDownloadedSeries(
  episodes: readonly DownloadRecord[],
  opts?: {
    readonly unplayedBySeriesKey?: ReadonlyMap<string, SeriesUnplayedSummary>;
    readonly newEpisodeSeriesKeys?: ReadonlySet<string>;
    readonly knownSeriesByTitle?: ReadonlyMap<string, string>;
  },
): readonly DownloadedSeriesGroup[] {
  const buckets = new Map<
    string,
    {
      seriesKey: string | null;
      sourceId: string;
      seriesTitle: string;
      posterUri: string | null;
      episodes: DownloadRecord[];
      totalBytes: number;
    }
  >();

  for (const ep of episodes) {
    const derivedKey = deriveSeriesKeyFromEpisodeRecord(ep, opts?.knownSeriesByTitle);
    const displayTitle = ep.seriesTitle?.trim() || ep.title;
    const bucketId = derivedKey ?? `title:${ep.sourceId}:${displayTitle.toLowerCase()}`;
    const existing = buckets.get(bucketId);
    if (existing) {
      existing.episodes.push(ep);
      existing.totalBytes += recordSizeBytes(ep);
      if (existing.posterUri === null && ep.poster) {
        existing.posterUri = ep.poster;
      }
      if (existing.seriesKey === null && derivedKey !== null) {
        existing.seriesKey = derivedKey;
      }
    } else {
      buckets.set(bucketId, {
        seriesKey: derivedKey,
        sourceId: ep.sourceId,
        seriesTitle: displayTitle,
        posterUri: ep.poster ?? null,
        episodes: [ep],
        totalBytes: recordSizeBytes(ep),
      });
    }
  }

  const groups: DownloadedSeriesGroup[] = [];
  for (const [groupId, bucket] of buckets) {
    bucket.episodes.sort((a, b) => {
      const sa = a.season ?? Number.MAX_SAFE_INTEGER;
      const sb = b.season ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      const ea = a.episodeNum ?? Number.MAX_SAFE_INTEGER;
      const eb = b.episodeNum ?? Number.MAX_SAFE_INTEGER;
      if (ea !== eb) return ea - eb;
      return a.title.localeCompare(b.title);
    });

    const summary =
      bucket.seriesKey !== null ? opts?.unplayedBySeriesKey?.get(bucket.seriesKey) : undefined;
    const totalEpisodes = summary !== undefined && summary.total > 0 ? summary.total : null;
    const hasNewEpisodes =
      bucket.seriesKey !== null && (opts?.newEpisodeSeriesKeys?.has(bucket.seriesKey) ?? false);

    groups.push({
      groupId,
      seriesKey: bucket.seriesKey,
      sourceId: bucket.sourceId,
      seriesTitle: bucket.seriesTitle,
      posterUri: bucket.posterUri,
      episodes: bucket.episodes,
      downloadedCount: bucket.episodes.length,
      totalEpisodes,
      hasNewEpisodes,
      totalBytes: bucket.totalBytes,
    });
  }

  return groups;
}

/** Formats the live `X / Y episodes downloaded` (or fallback) subtitle for a grouped series card. */
export function formatDownloadedSeriesSubtitle(
  group: Pick<DownloadedSeriesGroup, 'downloadedCount' | 'totalEpisodes'>,
  t: AppI18n['t'],
): string {
  if (group.totalEpisodes !== null && group.totalEpisodes > 0) {
    return t('library.episodesDownloaded', {
      downloaded: group.downloadedCount,
      total: group.totalEpisodes,
    });
  }
  return t('library.episodesDownloadedUnknownTotal', {
    downloaded: group.downloadedCount,
  });
}

/** Formats `S1E2` or `E2` for episode rows. */
export function formatEpisodeCode(
  season: number | null | undefined,
  episodeNum: number | null | undefined,
): string | null {
  if (season != null && episodeNum != null) return `S${season}E${episodeNum}`;
  if (episodeNum != null) return `E${episodeNum}`;
  return null;
}

/** Converts a Movie or Series Library card into a {@link DetailTarget}. */
export function buildLibraryDetailTarget(
  item: Pick<
    LibraryCardItem,
    'itemKey' | 'sourceId' | 'kind' | 'title' | 'imageUri' | 'year' | 'rating'
  >,
): DetailTarget | undefined {
  if (item.kind !== 'movie' && item.kind !== 'series') return undefined;
  return {
    itemKey: item.itemKey,
    sourceId: item.sourceId,
    kind: item.kind,
    title: item.title,
    posterUri: item.imageUri,
    backdropUri: (item as { backdrop?: string | null }).backdrop ?? null,
    year: item.year ?? null,
    rating: item.rating ?? null,
  };
}

/** Builds a {@link PlayTarget} for a Live channel, Movie, or completed offline Movie card. */
export function buildLibraryPlayTarget(item: LibraryCardItem): PlayTarget {
  if (item.downloadRecord) {
    return buildOfflineEpisodePlayTarget(item.downloadRecord);
  }
  if (item.kind === 'live') {
    return {
      itemKey: item.itemKey,
      sourceId: item.sourceId,
      title: item.title,
      kind: 'live',
      itemKind: 'live',
      ...(item.imageUri ? { logo: item.imageUri } : {}),
    };
  }
  return {
    itemKey: item.itemKey,
    sourceId: item.sourceId,
    title: item.title,
    kind: 'vod',
    itemKind: item.kind,
    ...(item.imageUri ? { logo: item.imageUri } : {}),
  };
}

/** Builds a zero-connection offline {@link PlayTarget} for a completed Movie or Episode download. */
export function buildOfflineEpisodePlayTarget(record: DownloadRecord): PlayTarget {
  const parts: string[] = [];
  const series = record.seriesTitle?.trim();
  if (record.kind === 'episode' && series) parts.push(series);
  const code = formatEpisodeCode(record.season, record.episodeNum);
  if (record.kind === 'episode' && code) parts.push(code);
  const subtitle = parts.length > 0 ? parts.join(' · ') : null;

  return {
    itemKey: record.itemKey,
    sourceId: record.sourceId,
    title: record.title,
    kind: 'vod',
    itemKind: record.kind,
    isLocalOffline: true,
    localFileUri: record.localUri,
    ...(record.poster != null ? { logo: record.poster } : {}),
    ...(subtitle !== null ? { subtitle } : {}),
    ...(record.season != null ? { season: record.season } : {}),
    ...(record.episodeNum != null ? { episode: record.episodeNum } : {}),
  };
}

/** Resolves the localized status key for an active or completed download record. */
export function resolveLibraryDownloadStatusKey(record: DownloadRecord): LibraryDownloadStatusKey {
  if (record.pausedForPlayback === true) return 'downloads.statusPausedForPlayback';
  switch (record.status) {
    case 'queued':
      return 'downloads.statusQueued';
    case 'downloading':
      return 'downloads.statusDownloading';
    case 'paused':
      return 'downloads.statusPaused';
    case 'failed':
      return 'downloads.statusFailed';
    case 'completed':
      return 'downloads.statusCompleted';
    default:
      return 'downloads.statusQueued';
  }
}

/** Resolves the card items rendered inside an active Library `See all` drill-down grid. */
export function resolveLibrarySeeAllItems(input: {
  readonly seeAll: LibrarySeeAllState | null;
  readonly favPartition: PartitionedLibraryFavorites;
  readonly ratingPartition: PartitionedLibraryRatings;
  readonly watchedMovieCards: readonly LibraryCardItem[];
  readonly watchedSeriesCards: readonly LibraryCardItem[];
  readonly completedMovieCards: readonly LibraryCardItem[];
  readonly downloadedSeriesGroups: readonly DownloadedSeriesGroup[];
  readonly collectionRails: readonly {
    readonly railId: string;
    readonly items: readonly LibraryCardItem[];
  }[];
  readonly t: AppI18n['t'];
}): readonly LibraryCardItem[] {
  const { seeAll } = input;
  if (!seeAll) return [];
  switch (seeAll.railId) {
    case 'live':
      return input.favPartition.live;
    case 'series':
      return input.favPartition.series;
    case 'movies':
      return input.favPartition.movies;
    case 'liked-movies':
      return input.ratingPartition.likedMovies;
    case 'liked-series':
      return input.ratingPartition.likedSeries;
    case 'disliked-movies':
      return input.ratingPartition.dislikedMovies;
    case 'disliked-series':
      return input.ratingPartition.dislikedSeries;
    case 'watched-movies':
      return input.watchedMovieCards;
    case 'watched-series':
      return input.watchedSeriesCards;
    case 'downloaded-movies':
      return input.completedMovieCards;
    case 'downloaded-series':
      return input.downloadedSeriesGroups.map((group) => ({
        id: group.groupId,
        itemKey: group.seriesKey ?? group.groupId,
        sourceId: group.sourceId,
        kind: 'series' as const,
        title: group.seriesTitle,
        imageUri: group.posterUri,
        subtitle: formatDownloadedSeriesSubtitle(group, input.t),
        ...(group.hasNewEpisodes ? { badge: 'NEW' } : {}),
      }));
    default: {
      const col = input.collectionRails.find((c) => c.railId === seeAll.railId);
      return col ? col.items : [];
    }
  }
}

/** Drop-zone identifier representing the general `Movies` / `Series` area (removes item from collection). */
export const GENERAL_LIBRARY_DROP_TARGET_ID = '__general__';

/** Returns `true` when `targetId` represents the general `Movies` / `Series` drop area. */
export function isGeneralLibraryDropTarget(targetId: string | null): boolean {
  return (
    targetId === GENERAL_LIBRARY_DROP_TARGET_ID ||
    (targetId?.startsWith(`${GENERAL_LIBRARY_DROP_TARGET_ID}:`) ?? false)
  );
}

/** Bounding rectangle for a drop target in client viewport coordinates. */
export interface LibraryDropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pure hit-test returning the drop target ID containing `(clientX, clientY)`, or `null`. */
export function findDropTargetAtPoint(
  rects: ReadonlyMap<string, LibraryDropRect>,
  clientX: number,
  clientY: number,
): string | null {
  for (const [id, rect] of rects) {
    if (
      clientX >= rect.x &&
      clientX <= rect.x + rect.width &&
      clientY >= rect.y &&
      clientY <= rect.y + rect.height
    ) {
      return id;
    }
  }
  return null;
}

/** Formats `bytesDownloaded / totalBytes · pct%` for active download strip rows. */
export function formatLibraryDownloadProgressMeta(record: DownloadRecord): string {
  const downloaded = formatDownloadBytes(record.bytesDownloaded);
  if (record.totalBytes !== null && record.totalBytes > 0) {
    const ratio = computeDownloadProgressRatio(record.bytesDownloaded, record.totalBytes) ?? 0;
    const pct = Math.round(ratio * 100);
    return `${downloaded} / ${formatDownloadBytes(record.totalBytes)} · ${pct}%`;
  }
  return downloaded;
}
