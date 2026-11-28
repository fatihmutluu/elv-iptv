import {
  type CatalogService,
  type CategoryRow,
  cleanVodTitle,
  DEFAULT_PROFILE_ID,
  type ElvTitleRecord,
  type EpisodeRow,
  type ItemDetailRow,
  type ItemRow,
  type MergedVodVariant,
  type SeasonRow,
  type SeriesUnplayedSummary,
  UNRELIABLE_FAIL_COUNT_THRESHOLD,
  type VodEnrichmentRecord,
  type VodVersionOption,
  type WatchProgressRow,
} from '@elv/data';
import { type ElvModePreferences, formatElvDisplayTitle } from '@elv/domain';
import {
  batchLoadProgressByKeys,
  type CachedDetailSeasonsState,
  type CachedDetailSnapshot,
  type DetailTarget,
  resolveElvLocalizedSynopsis,
  resolveElvLocalizedValue,
} from '../shared';
import type { DetailRichCastMember } from './DetailCastStrip';

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

/** Builds an optimistic episode {@link WatchProgressRow} for per-episode or bulk watched toggles. */
export function buildOptimisticEpisodeWatchedRow(
  prevRow: WatchProgressRow | undefined,
  nextWatched: boolean,
  meta: {
    readonly sourceId: string;
    readonly seriesKey: string;
    readonly episode: EpisodeRow;
    readonly fallbackTitle: string;
    readonly logo: string | null;
    readonly profileId?: string;
  },
): WatchProgressRow {
  const durationMs =
    prevRow !== undefined && prevRow.durationMs > 0
      ? prevRow.durationMs
      : meta.episode.durationSec !== null &&
          Number.isFinite(meta.episode.durationSec) &&
          meta.episode.durationSec > 0
        ? Math.round(meta.episode.durationSec * 1000)
        : 0;
  if (prevRow !== undefined) {
    return {
      ...prevRow,
      watched: nextWatched,
      positionMs: nextWatched ? durationMs : 0,
      durationMs,
      updatedAt: Date.now(),
    };
  }
  const trimmedEpTitle = meta.episode.title?.trim() ?? '';
  return {
    profileId: meta.profileId ?? DEFAULT_PROFILE_ID,
    sourceId: meta.sourceId,
    itemKey: meta.episode.key,
    kind: 'episode',
    title: trimmedEpTitle.length > 0 ? trimmedEpTitle : meta.fallbackTitle,
    subtitle: null,
    logo: meta.logo,
    seriesKey: meta.seriesKey,
    season: meta.episode.season,
    episode: meta.episode.episode,
    positionMs: nextWatched ? durationMs : 0,
    durationMs,
    watched: nextWatched,
    updatedAt: Date.now(),
  };
}

/** Returns `true` when `episodes` is non-empty and every episode is marked watched. */
export function areEpisodesAllWatched(
  episodes: readonly EpisodeRow[] | undefined,
  progressByKey: ReadonlyMap<string, WatchProgressRow>,
): boolean {
  if (episodes === undefined || episodes.length === 0) return false;
  return episodes.every((ep) => progressByKey.get(ep.key)?.watched === true);
}

/**
 * Computes whether a series is fully watched, preferring optimistic `bulkOverride`, then
 * authoritative DB `dbSummary`, and falling back to loaded episodes only when all seasons are
 * hydrated in memory.
 */
export function computeSeriesWatchedState(input: {
  readonly bulkOverride: boolean | null;
  readonly dbSummary: SeriesUnplayedSummary | null;
  readonly totalSeasonsCount: number;
  readonly episodesBySeason: ReadonlyMap<number, readonly EpisodeRow[]>;
  readonly currentEpisodes: readonly EpisodeRow[];
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
}): boolean {
  const {
    bulkOverride,
    dbSummary,
    totalSeasonsCount,
    episodesBySeason,
    currentEpisodes,
    progressByKey,
  } = input;
  if (bulkOverride !== null) return bulkOverride;
  if (dbSummary !== null) return dbSummary.watched === true;
  if (totalSeasonsCount > 0 && episodesBySeason.size < totalSeasonsCount) {
    return false;
  }
  let seen = 0;
  for (const eps of episodesBySeason.values()) {
    for (const ep of eps) {
      seen += 1;
      if (progressByKey.get(ep.key)?.watched !== true) return false;
    }
  }
  for (const ep of currentEpisodes) {
    seen += 1;
    if (progressByKey.get(ep.key)?.watched !== true) return false;
  }
  return seen > 0;
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

/** Extended selectable Detail version option carrying ELV Mode source attribution and verified quality (`#511`). */
export interface DetailVersionOption extends VodVersionOption {
  readonly sourceId?: string;
  readonly sourceName?: string;
  readonly verifiedResolution?: string | null;
  readonly isFake4k?: boolean;
  readonly failCount?: number;
  readonly isUnreliable?: boolean;
}

/** Maps a multi-source {@link MergedVodVariant} into a {@link DetailVersionOption} for Detail version picker. */
export function mapMergedVodVariantToOption(variant: MergedVodVariant): DetailVersionOption {
  return {
    key: variant.itemKey,
    sourceId: variant.sourceId,
    sourceName: variant.sourceName,
    title: variant.rawTitle,
    versionLabel: variant.versionLabel,
    year: null,
    qualityRank: variant.qualityRank,
    verifiedResolution: variant.verifiedResolution,
    isFake4k: variant.isFake4k,
    failCount: variant.failCount,
    isUnreliable: variant.failCount >= UNRELIABLE_FAIL_COUNT_THRESHOLD,
  };
}

function nonEmptyUrl(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
}

/** Resolved display metadata derived from provider row, optional VOD enrichment, and ELV Mode. */
export interface DerivedDetailPresentation {
  readonly rawTitle: string;
  readonly title: string;
  readonly posterUri: string | null;
  readonly backdropUri: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly votes: number | null;
  readonly runtimeMin: number | null;
  readonly director: string | null;
  readonly cast: readonly DetailRichCastMember[];
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
  readonly plot: string | null;
  readonly genres: readonly string[];
}

/** Pure derivation of display title, artwork, ratings, cast, and trailer URLs for `useDetailData`. */
export function deriveDetailPresentation(input: {
  readonly target: DetailTarget;
  readonly detailRow: ItemDetailRow | null;
  readonly enrichment: VodEnrichmentRecord | null;
  readonly vodEnrichmentEnabled: boolean;
  readonly elvEnrichActive: boolean;
  readonly elvPosterLookupPending: boolean;
  readonly activeElvTitle: ElvTitleRecord | null;
  readonly elvTitleFormat: ElvModePreferences['elvTitleFormat'];
  readonly locale: string;
}): DerivedDetailPresentation {
  const {
    target,
    detailRow,
    enrichment,
    vodEnrichmentEnabled,
    elvEnrichActive,
    elvPosterLookupPending,
    activeElvTitle,
    elvTitleFormat,
    locale,
  } = input;
  const rawTitle = detailRow?.name ?? target.title;
  const rawPosterUri = nonEmptyUrl(target.posterUri) ?? nonEmptyUrl(detailRow?.logo);
  const providerYear = target.year ?? detailRow?.year ?? null;
  const providerRating = target.rating ?? detailRow?.rating ?? null;
  const providerPlot = detailRow?.plot ?? target.overview ?? null;
  const mergedMeta = mergeVodEnrichment(
    {
      year: providerYear,
      rating: providerRating,
      genres: target.genres ?? [],
      plot: providerPlot,
    },
    vodEnrichmentEnabled ? enrichment : null,
  );
  const localCleaned =
    elvEnrichActive && activeElvTitle === null ? cleanVodTitle(rawTitle, providerYear) : null;
  const title =
    activeElvTitle !== null
      ? formatElvDisplayTitle({
          originalTitle: activeElvTitle.originalTitle,
          englishTitle: activeElvTitle.englishTitle,
          localizedTitle: resolveElvLocalizedValue(activeElvTitle.localizedTitles, locale),
          fallbackTitle: rawTitle,
          format: elvTitleFormat,
        })
      : localCleaned !== null && localCleaned.cleanTitle.length > 0
        ? localCleaned.cleanTitle
        : rawTitle;
  const elvPoster = nonEmptyUrl(activeElvTitle?.posterUrl);
  const elvBackdrop = nonEmptyUrl(activeElvTitle?.backdropUrl);
  const posterUri = elvPoster ?? (elvPosterLookupPending ? null : rawPosterUri);
  const backdropUri =
    elvBackdrop ??
    nonEmptyUrl(target.backdropUri) ??
    nonEmptyUrl((detailRow as { backdrop?: string | null } | null)?.backdrop);
  const year =
    activeElvTitle?.year != null && Number.isFinite(activeElvTitle.year)
      ? activeElvTitle.year
      : (mergedMeta.year ?? localCleaned?.releaseYear ?? null);
  const rating =
    activeElvTitle?.rating != null && Number.isFinite(activeElvTitle.rating)
      ? activeElvTitle.rating
      : mergedMeta.rating;
  const elvSynopsis =
    activeElvTitle !== null ? resolveElvLocalizedSynopsis(activeElvTitle.synopses, locale) : null;
  const plot = elvSynopsis ?? mergedMeta.plot;
  const genres =
    activeElvTitle !== null && activeElvTitle.genres.length > 0
      ? activeElvTitle.genres
      : mergedMeta.genres;
  const votes =
    activeElvTitle?.votes != null && Number.isFinite(activeElvTitle.votes)
      ? activeElvTitle.votes
      : null;
  const runtimeMin =
    activeElvTitle?.runtimeMin != null && Number.isFinite(activeElvTitle.runtimeMin)
      ? activeElvTitle.runtimeMin
      : null;
  const director = activeElvTitle?.director?.trim() || target.director?.trim() || null;
  const cast: readonly DetailRichCastMember[] =
    activeElvTitle !== null && activeElvTitle.cast.length > 0
      ? activeElvTitle.cast.map((m) => ({
          ...(m.personId ? { personId: m.personId } : {}),
          name: m.name,
          ...(m.character ? { role: m.character } : {}),
          ...(m.portraitUrl ? { avatarUri: m.portraitUrl } : {}),
        }))
      : (target.cast ?? []);
  return {
    rawTitle,
    title,
    posterUri,
    backdropUri,
    year,
    rating,
    votes,
    runtimeMin,
    director,
    cast,
    trailerStreamUrl: activeElvTitle?.trailerStreamUrl ?? null,
    trailerYoutubeId: activeElvTitle?.trailerYoutubeId ?? null,
    plot,
    genres,
  };
}
