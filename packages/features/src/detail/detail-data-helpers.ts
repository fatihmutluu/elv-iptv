import {
  type CatalogService,
  type CategoryRow,
  DEFAULT_PROFILE_ID,
  type ItemRow,
  type SeasonRow,
  type VodEnrichmentRecord,
  type WatchProgressRow,
} from '@elv/data';
import {
  batchLoadProgressByKeys,
  type CachedDetailSeasonsState,
  type CachedDetailSnapshot,
  type DetailTarget,
} from '../shared';

const RELATED_LIMIT = 12;

/** Loading / error / ready state for a series's season list. */
export type DetailSeasonsState = CachedDetailSeasonsState;

/** Atomic hydrated state snapshot held inside `useDetailData`. */
export type DetailSnapshot = CachedDetailSnapshot;

/** Creates an empty {@link DetailSnapshot} for a newly opened movie or series target. */
export function emptyDetailSnapshot(kind: 'movie' | 'series', categoryId?: string): DetailSnapshot {
  return {
    detailRow: null,
    inMyList: false,
    movieProgress: null,
    seasonsState: kind === 'series' ? { kind: 'loading' } : { kind: 'ready', seasons: [] },
    selectedSeason: null,
    episodes: [],
    episodesLoading: kind === 'series',
    episodesRefreshing: false,
    episodeProgressByKey: new Map(),
    related: [],
    relatedCategoryId: categoryId,
    relatedProgressByKey: new Map(),
  };
}

/**
 * Picks up to `limit` uncached seasons to prewarm around `activeSeason` (next season first,
 * then previous, then remaining seasons in list order).
 */
export function pickAdjacentSeasonsToPrewarm(
  seasons: readonly SeasonRow[],
  activeSeason: number,
  cachedSeasons: ReadonlySet<number>,
  limit = 4,
): number[] {
  if (seasons.length <= 1 || limit <= 0) return [];
  const available = new Set(seasons.map((s) => s.season));
  const ordered: number[] = [];
  const pushIfValid = (s: number) => {
    if (
      ordered.length < limit &&
      s !== activeSeason &&
      available.has(s) &&
      !cachedSeasons.has(s) &&
      !ordered.includes(s)
    ) {
      ordered.push(s);
    }
  };
  pushIfValid(activeSeason + 1);
  pushIfValid(activeSeason - 1);
  for (const row of seasons) pushIfValid(row.season);
  return ordered;
}

/** Merges newly loaded episode watch-progress rows into an existing progress map. */
export function mergeEpisodeProgress(
  base: ReadonlyMap<string, WatchProgressRow>,
  incoming: ReadonlyMap<string, WatchProgressRow>,
): ReadonlyMap<string, WatchProgressRow> {
  if (incoming.size === 0) return base;
  const next = new Map(base);
  for (const [k, v] of incoming) next.set(k, v);
  return next;
}

/** Fetches up to 12 bounded *More Like This* items excluding the active title plus their progress. */
export async function fetchRelatedDetailItems(catalog: CatalogService, target: DetailTarget) {
  let categoryId = target.categoryId;
  if (categoryId === undefined) {
    const cats = await catalog
      .categories(target.sourceId, target.kind)
      .catch(() => [] as CategoryRow[]);
    categoryId = (cats.find((c) => c.itemCount > 0) ?? cats[0])?.id;
  }
  if (categoryId === undefined) {
    return {
      categoryId: undefined,
      items: [] as ItemRow[],
      progress: new Map<string, WatchProgressRow>(),
    };
  }
  const raw = await catalog.items(categoryId, 0, RELATED_LIMIT + 1).catch(() => [] as ItemRow[]);
  const items = raw.filter((item) => item.key !== target.itemKey).slice(0, RELATED_LIMIT);
  const progress = await batchLoadProgressByKeys(
    catalog,
    items.map((item) => item.key),
  ).catch(() => new Map<string, WatchProgressRow>());
  return { categoryId, items, progress };
}

/** Builds an optimistic movie {@link WatchProgressRow} for `toggleWatched`. */
export function buildOptimisticWatchedRow(
  prevRow: WatchProgressRow | null,
  nextWatched: boolean,
  meta: {
    sourceId: string;
    itemKey: string;
    title: string;
    logo: string | null;
    profileId?: string;
  },
): WatchProgressRow {
  if (prevRow) {
    return {
      ...prevRow,
      watched: nextWatched,
      positionMs: nextWatched ? prevRow.positionMs : 0,
      updatedAt: Date.now(),
    };
  }
  return {
    profileId: meta.profileId ?? DEFAULT_PROFILE_ID,
    sourceId: meta.sourceId,
    itemKey: meta.itemKey,
    kind: 'movie',
    title: meta.title,
    subtitle: null,
    logo: meta.logo,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 0,
    durationMs: 0,
    watched: nextWatched,
    updatedAt: Date.now(),
  };
}

/** Provider-supplied VOD detail metadata inputs prior to optional enrichment fill (`#215`). */
export interface DetailMetadataFields {
  readonly year: number | null;
  readonly rating: number | null;
  readonly genres: readonly string[];
  readonly plot: string | null;
}

/** Non-destructively merged Detail metadata with enrichment provenance flags (`#215`). */
export interface MergedDetailMetadata extends DetailMetadataFields {
  readonly enriched: boolean;
  readonly ratingSource: string | null;
}

/**
 * Non-destructively fills missing Detail metadata (`year`, `rating`, `genres`, `plot`) from a
 * local key-free {@link VodEnrichmentRecord} without overwriting existing provider values (`#215`).
 */
export function mergeVodEnrichment(
  provider: DetailMetadataFields,
  enrichment: VodEnrichmentRecord | null,
): MergedDetailMetadata {
  const hasProviderYear = provider.year !== null && Number.isFinite(provider.year);
  const hasProviderRating = provider.rating !== null && Number.isFinite(provider.rating);
  const hasProviderGenres = provider.genres.length > 0;
  const trimmedProviderPlot = provider.plot?.trim() ?? '';
  const hasProviderPlot = trimmedProviderPlot.length > 0;

  if (enrichment === null) {
    return {
      year: hasProviderYear ? provider.year : null,
      rating: hasProviderRating ? provider.rating : null,
      genres: provider.genres,
      plot: hasProviderPlot ? provider.plot : null,
      enriched: false,
      ratingSource: null,
    };
  }

  const enrichedYear =
    !hasProviderYear && enrichment.releaseYear !== null && Number.isFinite(enrichment.releaseYear)
      ? enrichment.releaseYear
      : null;
  const enrichedRating =
    !hasProviderRating && enrichment.rating !== null && Number.isFinite(enrichment.rating)
      ? enrichment.rating
      : null;
  const enrichedGenres =
    !hasProviderGenres && enrichment.genres.length > 0 ? enrichment.genres : null;
  const trimmedEnrichedPlot = enrichment.synopsis?.trim() ?? '';
  const enrichedPlot =
    !hasProviderPlot && trimmedEnrichedPlot.length > 0 ? trimmedEnrichedPlot : null;

  const enriched =
    enrichedYear !== null ||
    enrichedRating !== null ||
    enrichedGenres !== null ||
    enrichedPlot !== null;

  return {
    year: hasProviderYear ? provider.year : enrichedYear,
    rating: hasProviderRating ? provider.rating : enrichedRating,
    genres: hasProviderGenres ? provider.genres : (enrichedGenres ?? provider.genres),
    plot: hasProviderPlot ? provider.plot : enrichedPlot,
    enriched,
    ratingSource: enrichedRating !== null ? enrichment.ratingSource : null,
  };
}
