import {
  type CatalogService,
  type CategoryRow,
  computeResumePositionMs,
  type FavoriteRow,
  type ItemRow,
  MIN_RESUME_POSITION_MS,
  type MyListNewEpisodeRow,
  type NowNextEntry,
  type UserItemKind,
  type WatchProgressRow,
} from '@elv/data';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { DetailTarget, HydratedVodCollection } from '../shared';

/**
 * `PlayTarget` enriched with optional Watch Progress resume position and metadata fields consumed
 * by `PlayerScreen` (`#14`).
 */
export type HomePlayTarget = PlayTarget & {
  readonly startPositionMs?: number;
  readonly logo?: string | null;
  readonly subtitle?: string | null;
  readonly itemKind?: UserItemKind;
};

/** One spotlight entry in the Home Hero carousel (structured for future TMDB enrichment `#215`). */
export interface HomeHeroSlide {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly kind: UserItemKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly backdropUri: string | null;
  readonly posterUri: string | null;
  readonly overview?: string | null;
  readonly genres?: readonly string[];
  readonly year: number | null;
  readonly rating: number | null;
  readonly durationMs: number;
  readonly positionMs: number;
  readonly watched: boolean;
  readonly isContinueWatching: boolean;
  readonly catalogItem?: ItemRow;
}

/** One item rendered inside a horizontal Home rail (`WideCard` or `PosterCard`). */
export interface HomeRailEntry {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly kind: UserItemKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly backdropUri: string | null;
  readonly posterUri: string | null;
  readonly overview?: string | null;
  readonly genres?: readonly string[];
  readonly year: number | null;
  readonly rating: number | null;
  readonly durationMs: number;
  readonly positionMs: number;
  readonly watched: boolean;
  readonly live?: boolean;
  readonly channelNum?: number | null;
  readonly badgeLabel?: string | null;
  readonly seriesKey?: string;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly catalogItem?: ItemRow;
}

/** Semantic identifier of each Home horizontal rail. */
export type HomeRailKind =
  | 'continue'
  | 'elvShowcase'
  | 'newEpisodes'
  | 'live'
  | 'mylist'
  | 'movies'
  | 'series';

/** Maximum number of cards shown in the unified Home Live TV rail. */
export const HOME_LIVE_RAIL_LIMIT = 12;

/** Dynamic Home horizontal rail identifier for a custom VOD collection (`#403`). */
export type HomeCollectionRailId = `collection:${string}`;

/** Hydrated custom VOD collection mapped into a Cinema Quietude Home poster rail (`#403`). */
export interface HomeCollectionRail {
  readonly id: HomeCollectionRailId;
  readonly collectionId: string;
  readonly title: string;
  readonly items: readonly HomeRailEntry[];
}

const MIN_CARD_WIDTH = 88;
const LIVE_PLAYLIST_PAGE_SIZE = 60;
const LIVE_PLAYLIST_MAX_PAGES = 4;

/**
 * Computes crisp horizontal peek card width from active `ViewportInfo.columns` and optional
 * form-factor max-width caps (`UI_UX_PHILOSOPHY.md` §3).
 */
export function computePeekCardWidth(
  viewportWidth: number,
  padX: number,
  cols: number,
  gap: number,
  maxWidth?: number,
): number {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const safePad = Number.isFinite(padX) && padX > 0 ? padX : 0;
  const safeCols = Number.isFinite(cols) && cols > 0 ? cols : 1;
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 0;
  const raw = Math.floor(
    (Math.max(0, safeViewport - safePad * 2) - Math.max(0, safeCols - 1) * safeGap) / safeCols,
  );
  const capped =
    maxWidth && Number.isFinite(maxWidth) && maxWidth > 0 ? Math.min(maxWidth, raw) : raw;
  return Math.max(MIN_CARD_WIDTH, capped);
}

/** Clamps playback progress ratio into `[0, 1]`, returning `0` when duration is invalid. */
export function progressRatio(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (positionMs <= 0) return 0;
  return Math.min(1, Math.max(0, positionMs / durationMs));
}

/**
 * Computes remaining whole minutes (`>= 1`) for an in-progress item, or `null` when duration is
 * missing or non-positive.
 */
export function formatRemainingMinutes(positionMs: number, durationMs: number): number | null {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.max(1, Math.ceil(Math.max(0, durationMs - Math.max(0, positionMs)) / 60_000));
}

/** Formats a live channel title with its optional channel number prefix. */
export function formatLiveChannelName(item: Pick<ItemRow, 'num' | 'name'>): string {
  return item.num !== null && item.num !== undefined ? `${item.num}. ${item.name}` : item.name;
}

/** Input for {@link buildHeroSlides}. */
export interface BuildHeroSlidesInput {
  readonly continueWatching: readonly WatchProgressRow[];
  readonly movies: readonly ItemRow[];
  readonly series: readonly ItemRow[];
  readonly progressByKey?: ReadonlyMap<string, WatchProgressRow>;
  readonly maxSlides?: number;
}

const HOME_HERO_FALLBACK_NULL = null;

function readBackdropUrl(row: unknown): string | null {
  const value = (row as { backdrop?: string | null } | undefined)?.backdrop;
  return typeof value === 'string' && value.trim().length > 0 ? value : HOME_HERO_FALLBACK_NULL;
}

/**
 * Builds up to `maxSlides` (default 5) deduplicated Hero spotlight slides, prioritizing active
 * Continue Watching entries first, then Featured Movies, then Featured Series.
 */
export function buildHeroSlides({
  continueWatching,
  movies,
  series,
  progressByKey,
  maxSlides = 5,
}: BuildHeroSlidesInput): HomeHeroSlide[] {
  const slides: HomeHeroSlide[] = [];
  const seen = new Set<string>();
  const catalogByKey = new Map<string, ItemRow>();
  for (const movie of movies) catalogByKey.set(movie.key, movie);
  for (const show of series) catalogByKey.set(show.key, show);

  for (const row of continueWatching) {
    if (slides.length >= maxSlides) break;
    if (row.watched || row.positionMs < MIN_RESUME_POSITION_MS || seen.has(row.itemKey)) continue;
    seen.add(row.itemKey);
    const matched = catalogByKey.get(row.itemKey);
    slides.push({
      itemKey: row.itemKey,
      sourceId: row.sourceId,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle,
      backdropUri: readBackdropUrl(row) ?? readBackdropUrl(matched) ?? null,
      posterUri: matched?.logo ?? row.logo ?? null,
      year: matched?.year ?? null,
      rating: matched?.rating ?? null,
      durationMs: row.durationMs,
      positionMs: row.positionMs,
      watched: row.watched,
      isContinueWatching: true,
      ...(matched !== undefined ? { catalogItem: matched } : {}),
    });
  }

  const pushCatalogItem = (item: ItemRow): void => {
    if (slides.length >= maxSlides || seen.has(item.key)) return;
    seen.add(item.key);
    const prog = progressByKey?.get(item.key);
    slides.push({
      itemKey: item.key,
      sourceId: item.sourceId,
      kind: item.kind,
      title: item.name,
      subtitle: prog?.subtitle ?? null,
      backdropUri: readBackdropUrl(item),
      posterUri: item.logo,
      year: item.year,
      rating: item.rating,
      durationMs: prog?.durationMs ?? 0,
      positionMs: prog?.positionMs ?? 0,
      watched: prog?.watched ?? false,
      isContinueWatching: false,
      catalogItem: item,
    });
  };

  for (const movie of movies) pushCatalogItem(movie);
  for (const show of series) pushCatalogItem(show);

  return slides;
}

/** Input for {@link buildVodPlayTarget}. */
export interface VodPlayTargetInput {
  readonly itemKey: string;
  readonly sourceId: string;
  readonly title: string;
  readonly kind: UserItemKind;
  readonly logo?: string | null;
  readonly subtitle?: string | null;
  readonly seriesKey?: string | null;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly positionMs?: number;
  readonly watched?: boolean;
}

/**
 * Builds a VOD `HomePlayTarget` with smart 5-second rewind applied via
 * `computeResumePositionMs` (`#14`).
 */
export function buildVodPlayTarget(input: VodPlayTargetInput): HomePlayTarget {
  const startPositionMs = computeResumePositionMs({
    positionMs: input.positionMs ?? 0,
    watched: input.watched ?? false,
  });
  return {
    itemKey: input.itemKey,
    sourceId: input.sourceId,
    title: input.title,
    kind: 'vod',
    startPositionMs,
    logo: input.logo ?? null,
    subtitle: input.subtitle ?? null,
    ...(input.seriesKey !== undefined ? { seriesKey: input.seriesKey } : {}),
    ...(input.season !== undefined ? { season: input.season } : {}),
    ...(input.episode !== undefined ? { episode: input.episode } : {}),
    itemKind: input.kind,
  };
}

/**
 * Builds a Live TV `HomePlayTarget` backed by a lightweight bounded-page cache over
 * `catalog.items` so Up/Down channel zapping works directly from Home's *On Air Now* rail without
 * materializing full categories or importing from `../browse`.
 */
export function buildHomeLivePlayTarget(
  catalog: CatalogService,
  category: CategoryRow,
  item: ItemRow,
  currentIndex: number,
): HomePlayTarget {
  const pages = new Map<number, readonly ItemRow[]>();
  const count = Math.max(category.itemCount, currentIndex + 1);

  const loadAt = async (index: number): Promise<PlayableEntry | undefined> => {
    if (index < 0 || index >= count) return undefined;
    const pageIndex = Math.floor(index / LIVE_PLAYLIST_PAGE_SIZE);
    let page = pages.get(pageIndex);
    if (page === undefined) {
      page = await catalog.items(
        category.id,
        pageIndex * LIVE_PLAYLIST_PAGE_SIZE,
        LIVE_PLAYLIST_PAGE_SIZE,
      );
      if (pages.size >= LIVE_PLAYLIST_MAX_PAGES) {
        const oldest = pages.keys().next().value;
        if (oldest !== undefined) pages.delete(oldest);
      }
      pages.set(pageIndex, page);
    }
    const row = page[index - pageIndex * LIVE_PLAYLIST_PAGE_SIZE];
    if (row === undefined) return undefined;
    return {
      itemKey: row.key,
      sourceId: row.sourceId,
      title: formatLiveChannelName(row),
      kind: 'live',
      logo: row.logo,
      itemKind: 'live',
    } as PlayableEntry & { readonly logo?: string | null; readonly itemKind?: UserItemKind };
  };

  return {
    itemKey: item.key,
    sourceId: item.sourceId,
    title: formatLiveChannelName(item),
    kind: 'live',
    logo: item.logo,
    itemKind: 'live',
    playlist: {
      count,
      currentIndex,
      onChangeIndex: () => undefined,
      getAt: loadAt,
    },
  };
}

/**
 * Resolves a {@link HomePlayTarget} for an entry in the unified Home Live TV rail.
 * Attaches the category zapping playlist only when the channel exists in `liveItems` (using its
 * real index in `liveCategory`, not its unified rail position); otherwise returns a standalone
 * live target with `logo` and `itemKind: 'live'`.
 */
export function resolveHomeLivePlayTarget(
  catalog: CatalogService,
  liveCategory: CategoryRow | null,
  liveItems: readonly ItemRow[],
  entry: HomeRailEntry,
): HomePlayTarget {
  if (liveCategory !== null && entry.catalogItem !== undefined) {
    const liveIndex = liveItems.findIndex((item) => item.key === entry.itemKey);
    if (liveIndex >= 0) {
      return buildHomeLivePlayTarget(catalog, liveCategory, entry.catalogItem, liveIndex);
    }
  }
  return {
    itemKey: entry.itemKey,
    sourceId: entry.sourceId,
    title: entry.title,
    kind: 'live',
    itemKind: 'live',
    logo: entry.posterUri ?? entry.backdropUri ?? entry.catalogItem?.logo ?? null,
  };
}

/** Input for {@link buildUnifiedLiveRail}. */
export interface BuildUnifiedLiveRailInput {
  readonly favorites: readonly FavoriteRow[];
  readonly recentChannels?: readonly ItemRow[];
  readonly liveItems: readonly ItemRow[];
  readonly liveCategoryName: string | null;
  readonly nowNextByKey?: ReadonlyMap<string, NowNextEntry>;
  readonly limit?: number;
}

/**
 * Builds the unified Home "Live TV" rail capped at `limit` (default 12), filled strictly in
 * deduplicated priority order:
 * 1. Live favorites preserving exact DB `sort_order`,
 * 2. Recently watched live channels,
 * 3. Current On-Now live channels.
 */
export function buildUnifiedLiveRail(input: BuildUnifiedLiveRailInput): HomeRailEntry[] {
  const limit = input.limit ?? HOME_LIVE_RAIL_LIMIT;
  if (limit <= 0) return [];

  const catalogByKey = new Map<string, ItemRow>();
  for (const item of input.liveItems) catalogByKey.set(item.key, item);
  for (const item of input.recentChannels ?? []) {
    if (!catalogByKey.has(item.key)) catalogByKey.set(item.key, item);
  }

  const seen = new Set<string>();
  const entries: HomeRailEntry[] = [];

  const resolveSubtitle = (key: string, fallback: string | null): string | null =>
    input.nowNextByKey?.get(key)?.now?.title ?? fallback;

  for (const fav of input.favorites) {
    if (entries.length >= limit) return entries;
    if (fav.kind !== 'live' || seen.has(fav.itemKey)) continue;
    seen.add(fav.itemKey);
    const matched = catalogByKey.get(fav.itemKey);
    entries.push({
      itemKey: fav.itemKey,
      sourceId: fav.sourceId,
      kind: 'live',
      title: matched ? formatLiveChannelName(matched) : fav.title,
      subtitle: resolveSubtitle(fav.itemKey, input.liveCategoryName),
      backdropUri: fav.logo ?? matched?.logo ?? null,
      posterUri: fav.logo ?? matched?.logo ?? null,
      year: null,
      rating: null,
      durationMs: 0,
      positionMs: 0,
      watched: false,
      live: true,
      channelNum: matched?.num ?? null,
      ...(matched !== undefined ? { catalogItem: matched } : {}),
    });
  }

  const pushLiveItem = (item: ItemRow, fallbackSubtitle: string | null): void => {
    if (entries.length >= limit || seen.has(item.key)) return;
    seen.add(item.key);
    entries.push({
      itemKey: item.key,
      sourceId: item.sourceId,
      kind: 'live',
      title: formatLiveChannelName(item),
      subtitle: resolveSubtitle(item.key, fallbackSubtitle),
      backdropUri: item.logo,
      posterUri: item.logo,
      year: null,
      rating: null,
      durationMs: 0,
      positionMs: 0,
      watched: false,
      live: true,
      channelNum: item.num,
      catalogItem: item,
    });
  };

  for (const item of input.recentChannels ?? []) pushLiveItem(item, input.liveCategoryName);
  for (const item of input.liveItems) pushLiveItem(item, input.liveCategoryName);

  return entries;
}

const EPISODE_CODE_PREFIX_RE = /^(?:S\d+(?:\s*[·•\-:]?\s*E\d+)?|E\d+)(?:\s|$|[·•—\-:])/i;

/** Formats a newly arrived episode subtitle safely without ever rendering null placeholders. */
export function formatNewEpisodeSubtitle(
  season: number | null,
  episode: number | null,
  episodeTitle: string,
): string | null {
  const trimmedTitle = episodeTitle.trim();
  const hasSeason = typeof season === 'number' && Number.isFinite(season);
  const hasEpisode = typeof episode === 'number' && Number.isFinite(episode);
  const code =
    hasSeason && hasEpisode
      ? `S${season} · E${episode}`
      : hasEpisode
        ? `E${episode}`
        : hasSeason
          ? `S${season}`
          : '';
  if (code !== '' && trimmedTitle !== '') return `${code} — ${trimmedTitle}`;
  if (code !== '') return code;
  return trimmedTitle !== '' ? trimmedTitle : null;
}

/**
 * Formats an episode subtitle with `S# · E# — Title` when season/episode metadata is present,
 * avoiding double-prefixing if `rawSubtitle` already starts with an `S#`/`E#` prefix.
 */
export function formatContinueEpisodeSubtitle(
  season: number | null | undefined,
  episode: number | null | undefined,
  rawSubtitle: string | null,
): string | null {
  const trimmed = rawSubtitle?.trim() ?? '';
  if (trimmed !== '' && EPISODE_CODE_PREFIX_RE.test(trimmed)) return trimmed;
  return formatNewEpisodeSubtitle(season ?? null, episode ?? null, trimmed);
}

/** Input for {@link buildHomeRailSets}. */
export interface BuildHomeRailSetsInput {
  readonly continueWatching: readonly WatchProgressRow[];
  readonly elvShowcase?: readonly HomeRailEntry[];
  readonly newEpisodes?: readonly MyListNewEpisodeRow[];
  readonly newEpisodeBadgeLabel?: string;
  readonly recentChannels?: readonly ItemRow[];
  readonly liveItems: readonly ItemRow[];
  readonly liveCategoryName: string | null;
  readonly nowNextByKey?: ReadonlyMap<string, NowNextEntry>;
  readonly favorites: readonly FavoriteRow[];
  readonly movies: readonly ItemRow[];
  readonly series: readonly ItemRow[];
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/** All 6 Home rail entry arrays indexed by {@link HomeRailKind}. */
export type HomeRailSets = Readonly<Record<HomeRailKind, readonly HomeRailEntry[]>>;

const HOME_MYLIST_LIMIT = 24;

/** Maps bounded Home SQLite rows into pure {@link HomeRailEntry} arrays for all 6 rails. */
export function buildHomeRailSets(input: BuildHomeRailSetsInput): HomeRailSets {
  const seriesByKey = new Map<string, ItemRow>();
  for (const s of input.series) seriesByKey.set(s.key, s);

  const mapCatalog = (items: readonly ItemRow[], kind: 'movie' | 'series'): HomeRailEntry[] =>
    items.map((item) => {
      const prog = input.progressByKey.get(item.key);
      return {
        itemKey: item.key,
        sourceId: item.sourceId,
        kind,
        title: item.name,
        subtitle: prog?.subtitle ?? null,
        backdropUri: readBackdropUrl(item),
        posterUri: item.logo,
        year: item.year,
        rating: item.rating,
        durationMs: prog?.durationMs ?? 0,
        positionMs: prog?.positionMs ?? 0,
        watched: prog?.watched ?? false,
        catalogItem: item,
      };
    });

  return {
    continue: input.continueWatching.map((row) => ({
      itemKey: row.itemKey,
      sourceId: row.sourceId,
      kind: row.kind,
      title: row.title,
      subtitle:
        row.kind === 'episode'
          ? formatContinueEpisodeSubtitle(row.season, row.episode, row.subtitle)
          : row.subtitle,
      backdropUri: readBackdropUrl(row),
      posterUri: row.logo,
      year: null,
      rating: null,
      durationMs: row.durationMs,
      positionMs: row.positionMs,
      watched: row.watched,
      ...(row.seriesKey ? { seriesKey: row.seriesKey } : {}),
      ...(row.season !== null ? { season: row.season } : {}),
      ...(row.episode !== null ? { episode: row.episode } : {}),
    })),
    elvShowcase: input.elvShowcase ?? [],
    newEpisodes: (input.newEpisodes ?? []).map((row) => ({
      itemKey: row.episodeKey,
      sourceId: row.sourceId,
      kind: 'episode' as const,
      title: row.seriesTitle,
      subtitle: formatNewEpisodeSubtitle(row.season, row.episode, row.episodeTitle),
      backdropUri: (row as { seriesBackdrop?: string | null }).seriesBackdrop ?? null,
      posterUri: row.seriesLogo,
      year: null,
      rating: null,
      durationMs: 0,
      positionMs: 0,
      watched: false,
      ...(input.newEpisodeBadgeLabel ? { badgeLabel: input.newEpisodeBadgeLabel } : {}),
      seriesKey: row.seriesKey,
      season: row.season,
      episode: row.episode,
    })),
    live: buildUnifiedLiveRail({
      favorites: input.favorites,
      ...(input.recentChannels !== undefined ? { recentChannels: input.recentChannels } : {}),
      liveItems: input.liveItems,
      liveCategoryName: input.liveCategoryName,
      ...(input.nowNextByKey !== undefined ? { nowNextByKey: input.nowNextByKey } : {}),
    }),
    mylist: input.favorites
      .filter((fav) => fav.kind === 'movie' || fav.kind === 'series')
      .slice(0, HOME_MYLIST_LIMIT)
      .map((fav) => {
        const prog = input.progressByKey.get(fav.itemKey);
        const matchedSeries = fav.kind === 'series' ? seriesByKey.get(fav.itemKey) : undefined;
        return {
          itemKey: fav.itemKey,
          sourceId: fav.sourceId,
          kind: fav.kind,
          title: fav.title,
          subtitle: prog?.subtitle ?? null,
          backdropUri: readBackdropUrl(fav) ?? readBackdropUrl(matchedSeries) ?? null,
          posterUri: fav.logo,
          year: fav.year,
          rating: fav.rating,
          durationMs: prog?.durationMs ?? 0,
          positionMs: prog?.positionMs ?? 0,
          watched: prog?.watched ?? false,
          ...(matchedSeries !== undefined ? { catalogItem: matchedSeries } : {}),
        };
      }),
    movies: mapCatalog(input.movies, 'movie'),
    series: mapCatalog(input.series, 'series'),
  };
}

/** Converts a movie, series, or series-linked episode Home entry into a {@link DetailTarget}. */
export function buildHomeDetailTarget(
  item: HomeHeroSlide | HomeRailEntry,
): DetailTarget | undefined {
  if (item.kind === 'episode' && 'seriesKey' in item && item.seriesKey) {
    return {
      itemKey: item.seriesKey,
      sourceId: item.sourceId,
      kind: 'series',
      title: item.title,
      posterUri: item.posterUri,
      backdropUri: item.backdropUri,
      year: item.year,
      rating: item.rating,
    };
  }
  if (item.kind !== 'movie' && item.kind !== 'series') return undefined;
  const { itemKey, sourceId, kind, title, posterUri, backdropUri, year, rating, catalogItem } =
    item;
  return {
    itemKey,
    sourceId,
    kind,
    title,
    posterUri,
    backdropUri,
    year,
    rating,
    ...(catalogItem ? { catalogId: catalogItem.id } : {}),
  };
}

/** Maps non-empty hydrated VOD collections into Cinema Quietude Home poster rails (`#403`). */
export function buildHomeCollectionRails(
  collections: readonly HydratedVodCollection[],
  progressByKey: ReadonlyMap<string, WatchProgressRow>,
): HomeCollectionRail[] {
  const rails: HomeCollectionRail[] = [];
  for (const entry of collections) {
    const mapped: HomeRailEntry[] = [];
    for (const item of entry.items) {
      if (item.kind !== 'movie' && item.kind !== 'series') continue;
      const prog = progressByKey.get(item.key);
      mapped.push({
        itemKey: item.key,
        sourceId: item.sourceId,
        kind: item.kind,
        title: item.name,
        subtitle: prog?.subtitle ?? null,
        backdropUri: readBackdropUrl(item),
        posterUri: item.logo,
        year: item.year,
        rating: item.rating,
        durationMs: prog?.durationMs ?? 0,
        positionMs: prog?.positionMs ?? 0,
        watched: prog?.watched ?? false,
        catalogItem: item,
      });
    }
    if (mapped.length > 0) {
      rails.push({
        id: `collection:${entry.collection.id}`,
        collectionId: entry.collection.id,
        title: entry.collection.name,
        items: mapped,
      });
    }
  }
  return rails;
}
