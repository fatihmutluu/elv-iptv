import type {
  CatalogService,
  ElvFranchiseLibraryItem,
  EpisodeRow,
  ItemDetailRow,
  RatingValue,
  SeasonRow,
  SeriesUnplayedSummary,
  VodVersionOption,
  WatchProgressRow,
} from '@elv/data';
import {
  DEFAULT_ELV_MODE_PREFERENCES,
  type ElvModePreferences,
  elvError,
  type Result,
} from '@elv/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DetailTarget,
  isElvFeatureActive,
  useCatalogUiCache,
  useSeriesUnplayedCounts,
} from '../shared';
import type { DetailRichCastMember } from './DetailCastStrip';
import {
  areEpisodesAllWatched,
  computeSeriesWatchedState,
  type DetailSeasonsState,
  type DetailSnapshot,
  type DetailVersionOption,
  deriveDetailPresentation,
  emptyDetailSnapshot,
  fetchRelatedDetailItems,
  mapMergedVodVariantToOption,
} from './detail-data-helpers';
import { useDetailEnrichment } from './useDetailEnrichment';
import { useDetailMutations } from './useDetailMutations';
import { useDetailSeasonLoader } from './useDetailSeasonLoader';

export type { DetailSeasonsState };

/** Options for {@link useDetailData}. */
export interface UseDetailDataOptions {
  readonly target: DetailTarget;
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly vodEnrichmentEnabled?: boolean;
  readonly elvPreferences?: ElvModePreferences;
  readonly locale?: string;
  /** Optional user-selected version `itemKey` for multi-source series season/episode reload (`#511`). */
  readonly selectedVersionKey?: string | null;
}

/** Hydrated Detail screen dataset, series season controls, and optimistic user-state mutations. */
export interface DetailDataState extends Omit<DetailSnapshot, 'detailRow'> {
  readonly title: string;
  readonly rawTitle: string;
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
  readonly imdbId: string | null;
  readonly franchiseItems: readonly ElvFranchiseLibraryItem[];
  readonly plot: string | null;
  readonly genres: readonly string[];
  readonly relatedUnplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly versions: readonly DetailVersionOption[];
  readonly userRating: RatingValue | null;
  readonly resolvedSeriesId: number | undefined;
  readonly isSeriesWatched: boolean;
  readonly isSeasonWatched: (season: number) => boolean;
  readonly getCachedSeasonEpisodes: (season: number) => readonly EpisodeRow[] | undefined;
  readonly selectSeason: (season: number) => void;
  readonly retrySeasons: () => void;
  readonly toggleMyList: () => Promise<void>;
  readonly toggleWatched: () => Promise<void>;
  readonly toggleRating: (next: RatingValue) => Promise<void>;
  readonly toggleEpisodeWatched: (episode: EpisodeRow) => Promise<void>;
  readonly markSeasonWatched: (season: number, watched: boolean) => Promise<boolean>;
  readonly markSeriesWatched: (watched: boolean) => Promise<boolean>;
}

/**
 * Hydrates Detail metadata, watch progress, My List state, series seasons/episodes, and bounded
 * *More Like This* items (`<= 12`) with `CatalogUiCache` frame-0 hydration, zero-blink season
 * switching + adjacent-season prewarm, player-return preservation, and rapid-toggle safety (`#445`, `#230`).
 */
export function useDetailData({
  target,
  catalog,
  refreshToken,
  userStateVersion = 0,
  vodEnrichmentEnabled = false,
  elvPreferences,
  locale = 'en',
  selectedVersionKey = null,
}: UseDetailDataOptions): DetailDataState {
  const elvPrefs = elvPreferences ?? DEFAULT_ELV_MODE_PREFERENCES;
  const elvMergeActive = isElvFeatureActive(elvPrefs, 'elvMergeVersions');
  const elvEnrichActive = isElvFeatureActive(elvPrefs, 'elvEnrichMetadata');
  const effectiveSeriesKey =
    target.kind === 'series' && selectedVersionKey !== null && selectedVersionKey !== ''
      ? selectedVersionKey
      : target.itemKey;
  const uiCache = useCatalogUiCache();
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;
  const initialCached = uiCache?.getDetail(target.itemKey) ?? null;

  const [snap, setSnap] = useState<DetailSnapshot>(() =>
    initialCached
      ? { ...initialCached.snap, episodesLoading: false, episodesRefreshing: false }
      : emptyDetailSnapshot(target.kind, target.categoryId),
  );
  const [seasonsRetryToken, setSeasonsRetryToken] = useState(0);
  const [versions, setVersions] = useState<readonly DetailVersionOption[]>([]);
  const [userRating, setUserRatingState] = useState<RatingValue | null>(null);
  const [seriesBulkWatched, setSeriesBulkWatched] = useState<boolean | null>(null);
  const seriesBulkWatchedRef = useRef<boolean | null>(null);
  const [seriesUnplayedSummary, setSeriesUnplayedSummary] = useState<SeriesUnplayedSummary | null>(
    null,
  );
  const seriesUnplayedSummaryRef = useRef<SeriesUnplayedSummary | null>(null);
  const [seasonBulkOverrides, setSeasonBulkOverrides] = useState<ReadonlyMap<number, boolean>>(
    () => new Map(),
  );
  const seasonBulkOverridesRef = useRef<ReadonlyMap<number, boolean>>(seasonBulkOverrides);
  const bulkWatchedInFlightRef = useRef(0);

  const mountedRef = useRef(true);
  const snapRef = useRef(snap);
  const activeItemKeyRef = useRef(target.itemKey);
  const activeSourceIdRef = useRef(target.sourceId);
  activeSourceIdRef.current = target.sourceId;
  const activeSeriesKeyRef = useRef(effectiveSeriesKey);
  const selectedSeriesVersion =
    target.kind === 'series' && effectiveSeriesKey !== target.itemKey
      ? versions.find((v) => v.key === effectiveSeriesKey)
      : undefined;
  const activeSeriesSourceIdRef = useRef(selectedSeriesVersion?.sourceId ?? target.sourceId);
  activeSeriesSourceIdRef.current = selectedSeriesVersion?.sourceId ?? target.sourceId;
  const prevItemKeyRef = useRef(target.itemKey);
  const prevSeriesKeyRef = useRef(effectiveSeriesKey);
  const seriesIdRef = useRef<number | undefined>(
    target.catalogId ?? initialCached?.snap.detailRow?.id,
  );
  const episodesBySeasonRef = useRef<Map<number, readonly EpisodeRow[]>>(
    new Map(initialCached?.episodesBySeason ?? []),
  );
  const myListGenRef = useRef(0);
  const myListInFlightRef = useRef(0);
  const committedMyListRef = useRef<boolean | undefined>(initialCached?.snap.inMyList);
  const watchedGenRef = useRef(0);
  const watchedInFlightRef = useRef(0);
  const committedMovieProgressRef = useRef<WatchProgressRow | null | undefined>(
    initialCached?.snap.movieProgress,
  );
  const userRatingRef = useRef<RatingValue | null>(null);
  const ratingGenRef = useRef(0);
  const ratingInFlightRef = useRef(0);
  const committedRatingRef = useRef<RatingValue | null | undefined>(undefined);
  const hydrationGenRef = useRef(0);

  const persistToCache = useCallback(
    (itemKey: string, sourceId: string, nextSnap: DetailSnapshot) => {
      uiCacheRef.current?.setDetail(itemKey, {
        sourceId,
        snap: nextSnap,
        episodesBySeason: new Map(episodesBySeasonRef.current),
        episodeProgressByKey: nextSnap.episodeProgressByKey,
      });
    },
    [],
  );

  const updateSnap = useCallback(
    (updater: (prev: DetailSnapshot) => DetailSnapshot, persist = true) => {
      const next = updater(snapRef.current);
      snapRef.current = next;
      if (persist) persistToCache(activeItemKeyRef.current, activeSourceIdRef.current, next);
      setSnap((prev) => {
        const resolved = updater(prev);
        snapRef.current = resolved;
        if (persist) persistToCache(activeItemKeyRef.current, activeSourceIdRef.current, resolved);
        return resolved;
      });
    },
    [persistToCache],
  );

  const { loadSeasonEpisodes, cancelPrewarm } = useDetailSeasonLoader({
    catalog,
    mountedRef,
    snapRef,
    activeItemKeyRef: activeSeriesKeyRef,
    activeSourceIdRef: activeSeriesSourceIdRef,
    episodesBySeasonRef,
    persistToCache,
    updateSnap,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPrewarm();
    };
  }, [cancelPrewarm]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, and seasonsRetryToken trigger fresh bounded reads
  useEffect(() => {
    const gen = ++hydrationGenRef.current;
    const itemChanged = prevItemKeyRef.current !== target.itemKey;
    const seriesVersionChanged =
      !itemChanged && target.kind === 'series' && prevSeriesKeyRef.current !== effectiveSeriesKey;
    prevItemKeyRef.current = target.itemKey;
    prevSeriesKeyRef.current = effectiveSeriesKey;
    activeItemKeyRef.current = target.itemKey;
    activeSeriesKeyRef.current = effectiveSeriesKey;

    if (itemChanged) {
      setVersions([]);
      userRatingRef.current = null;
      setUserRatingState(null);
      seriesBulkWatchedRef.current = null;
      setSeriesBulkWatched(null);
      seriesUnplayedSummaryRef.current = null;
      setSeriesUnplayedSummary(null);
      const emptyOverrides = new Map<number, boolean>();
      seasonBulkOverridesRef.current = emptyOverrides;
      setSeasonBulkOverrides(emptyOverrides);
      bulkWatchedInFlightRef.current = 0;
      myListGenRef.current += 1;
      myListInFlightRef.current = 0;
      watchedGenRef.current += 1;
      watchedInFlightRef.current = 0;
      ratingGenRef.current += 1;
      ratingInFlightRef.current = 0;
      committedRatingRef.current = undefined;
      cancelPrewarm();
      const cached = uiCacheRef.current?.getDetail(target.itemKey) ?? null;
      if (cached) {
        committedMyListRef.current = cached.snap.inMyList;
        committedMovieProgressRef.current = cached.snap.movieProgress;
        seriesIdRef.current = target.catalogId ?? cached.snap.detailRow?.id;
        episodesBySeasonRef.current = new Map(cached.episodesBySeason);
        updateSnap(
          () => ({ ...cached.snap, episodesLoading: false, episodesRefreshing: false }),
          false,
        );
      } else {
        committedMyListRef.current = undefined;
        committedMovieProgressRef.current = undefined;
        seriesIdRef.current = target.catalogId;
        episodesBySeasonRef.current = new Map();
        updateSnap(() => emptyDetailSnapshot(target.kind, target.categoryId), false);
      }
    } else if (seriesVersionChanged) {
      cancelPrewarm();
      seriesBulkWatchedRef.current = null;
      setSeriesBulkWatched(null);
      seriesUnplayedSummaryRef.current = null;
      setSeriesUnplayedSummary(null);
      const emptyOverrides = new Map<number, boolean>();
      seasonBulkOverridesRef.current = emptyOverrides;
      setSeasonBulkOverrides(emptyOverrides);
      bulkWatchedInFlightRef.current = 0;
      seriesIdRef.current = effectiveSeriesKey === target.itemKey ? target.catalogId : undefined;
      episodesBySeasonRef.current = new Map();
      updateSnap(
        (prev) => ({
          ...prev,
          seasonsState: { kind: 'loading' },
          selectedSeason: null,
          episodes: [],
          episodeProgressByKey: new Map(),
          episodesLoading: true,
          episodesRefreshing: false,
        }),
        false,
      );
    }

    let cancelled = false;
    const isStale = () => cancelled || !mountedRef.current || gen !== hydrationGenRef.current;

    const loadSeriesSeasonsAndEpisodes = async (
      seriesDetail: ItemDetailRow | null,
      eagerSeasons: Promise<Result<SeasonRow[]> | null> | null,
      resetSelection: boolean,
    ) => {
      const resolvedSeriesId =
        effectiveSeriesKey === target.itemKey
          ? (target.catalogId ?? seriesDetail?.id ?? seriesIdRef.current)
          : (seriesDetail?.id ?? seriesIdRef.current);
      seriesIdRef.current = resolvedSeriesId;
      if (resolvedSeriesId === undefined) {
        updateSnap(
          (prev) => ({
            ...prev,
            seasonsState: { kind: 'ready', seasons: [] },
            episodes: [],
            episodesLoading: false,
            episodesRefreshing: false,
          }),
          effectiveSeriesKey === target.itemKey,
        );
        return;
      }

      const seasonsRes =
        eagerSeasons !== null
          ? await eagerSeasons
          : await catalog.seasons(resolvedSeriesId).catch(() => null);
      if (isStale()) return;

      if (seasonsRes === null || !seasonsRes.ok) {
        if (
          !resetSelection &&
          snapRef.current.seasonsState.kind === 'ready' &&
          snapRef.current.seasonsState.seasons.length > 0
        ) {
          return;
        }
        const error =
          seasonsRes === null ? elvError('storage', 'seasons-failed') : seasonsRes.error;
        updateSnap(
          (prev) => ({
            ...prev,
            seasonsState: { kind: 'error', error },
            episodes: [],
            episodesLoading: false,
            episodesRefreshing: false,
          }),
          effectiveSeriesKey === target.itemKey,
        );
        return;
      }

      const seasons = seasonsRes.value;
      if (seasons.length === 0) {
        updateSnap(
          (prev) => ({
            ...prev,
            seasonsState: { kind: 'ready', seasons: [] },
            selectedSeason: null,
            episodes: [],
            episodeProgressByKey: new Map(),
            episodesLoading: false,
            episodesRefreshing: false,
          }),
          effectiveSeriesKey === target.itemKey,
        );
        return;
      }

      const curSelected = resetSelection ? null : snapRef.current.selectedSeason;
      const nextSeason =
        curSelected !== null && seasons.some((s) => s.season === curSelected)
          ? curSelected
          : (seasons[0]?.season ?? null);

      updateSnap(
        (prev) => ({
          ...prev,
          seasonsState: { kind: 'ready', seasons },
          selectedSeason: nextSeason,
        }),
        effectiveSeriesKey === target.itemKey,
      );
      if (nextSeason !== null) {
        const alreadyVisible =
          !resetSelection &&
          snapRef.current.episodes.length > 0 &&
          snapRef.current.selectedSeason === nextSeason;
        await loadSeasonEpisodes(resolvedSeriesId, nextSeason, effectiveSeriesKey, {
          backgroundRefresh: alreadyVisible,
          seasons,
        });
      } else {
        updateSnap(
          (prev) => ({ ...prev, episodesLoading: false, episodesRefreshing: false }),
          effectiveSeriesKey === target.itemKey,
        );
      }
    };

    const fetchSeriesSummary = (): Promise<SeriesUnplayedSummary | null> =>
      target.kind === 'series' && typeof catalog.listSeriesUnplayedCounts === 'function'
        ? catalog
            .listSeriesUnplayedCounts([effectiveSeriesKey])
            .then((rows) => rows.find((r) => r.seriesKey === effectiveSeriesKey) ?? null)
            .catch(() => null)
        : Promise.resolve(null);

    const run = async () => {
      if (seriesVersionChanged) {
        const [seriesDetail, versionSummary] = await Promise.all([
          effectiveSeriesKey === target.itemKey && target.catalogId !== undefined
            ? Promise.resolve(null)
            : catalog.itemDetail
              ? catalog.itemDetail(effectiveSeriesKey).catch(() => null)
              : Promise.resolve(null),
          fetchSeriesSummary(),
        ]);
        if (isStale()) return;
        if (bulkWatchedInFlightRef.current === 0) {
          seriesUnplayedSummaryRef.current = versionSummary;
          setSeriesUnplayedSummary(versionSummary);
          if (versionSummary !== null) {
            seriesBulkWatchedRef.current = null;
            setSeriesBulkWatched(null);
          }
        }
        await loadSeriesSeasonsAndEpisodes(seriesDetail, null, true);
        return;
      }

      const useTargetSeriesDirectly = effectiveSeriesKey === target.itemKey;
      const eagerSeasons =
        target.kind === 'series' && useTargetSeriesDirectly && target.catalogId !== undefined
          ? catalog.seasons(target.catalogId).catch(() => null)
          : null;
      const [
        hydratedDetail,
        favKeys,
        fetchedMovieProg,
        fetchedVersions,
        relatedResult,
        fetchedRating,
        altSeriesDetail,
        fetchedSeriesUnplayed,
      ] = await Promise.all([
        catalog.itemDetail ? catalog.itemDetail(target.itemKey).catch(() => null) : null,
        catalog.listFavoriteKeys ? catalog.listFavoriteKeys().catch(() => [] as string[]) : [],
        target.kind === 'movie' && catalog.getProgress
          ? catalog.getProgress(target.itemKey).catch(() => null)
          : null,
        elvMergeActive && catalog.listMergedVodVersions
          ? catalog
              .listMergedVodVersions(target.itemKey)
              .then((rows) => rows.map(mapMergedVodVariantToOption))
              .catch(() => [] as readonly DetailVersionOption[])
          : target.kind === 'movie' && catalog.itemVersions
            ? catalog.itemVersions(target.itemKey).catch(() => [] as readonly VodVersionOption[])
            : ([] as readonly DetailVersionOption[]),
        fetchRelatedDetailItems(catalog, target),
        catalog.getRating ? catalog.getRating(target.itemKey).catch(() => null) : null,
        target.kind === 'series' && !useTargetSeriesDirectly && catalog.itemDetail
          ? catalog.itemDetail(effectiveSeriesKey).catch(() => null)
          : null,
        fetchSeriesSummary(),
      ]);
      if (isStale()) return;

      setVersions(fetchedVersions.length > 1 ? fetchedVersions : []);

      const isFav = new Set(favKeys).has(target.itemKey);
      if (myListInFlightRef.current === 0) committedMyListRef.current = isFav;
      if (target.kind === 'movie' && watchedInFlightRef.current === 0) {
        committedMovieProgressRef.current = fetchedMovieProg;
      }
      if (target.kind === 'series' && bulkWatchedInFlightRef.current === 0) {
        seriesUnplayedSummaryRef.current = fetchedSeriesUnplayed;
        setSeriesUnplayedSummary(fetchedSeriesUnplayed);
        if (fetchedSeriesUnplayed !== null) {
          seriesBulkWatchedRef.current = null;
          setSeriesBulkWatched(null);
        }
      }
      if (ratingInFlightRef.current === 0) {
        committedRatingRef.current = fetchedRating;
        userRatingRef.current = fetchedRating;
        setUserRatingState(fetchedRating);
      }
      updateSnap((prev) => ({
        ...prev,
        detailRow: hydratedDetail ?? prev.detailRow,
        inMyList: myListInFlightRef.current > 0 ? prev.inMyList : isFav,
        movieProgress:
          target.kind === 'movie' && watchedInFlightRef.current === 0
            ? fetchedMovieProg
            : prev.movieProgress,
        relatedCategoryId: relatedResult.categoryId,
        related: relatedResult.items,
        relatedProgressByKey: relatedResult.progress,
      }));
      if (target.kind !== 'series') return;

      await loadSeriesSeasonsAndEpisodes(
        useTargetSeriesDirectly ? hydratedDetail : altSeriesDetail,
        eagerSeasons,
        itemChanged,
      );
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    cancelPrewarm,
    catalog,
    effectiveSeriesKey,
    elvMergeActive,
    loadSeasonEpisodes,
    refreshToken,
    seasonsRetryToken,
    target.catalogId,
    target.categoryId,
    target.itemKey,
    target.kind,
    target.sourceId,
    updateSnap,
    userStateVersion,
  ]);

  const { enrichment, activeElvTitle, elvPosterLookupPending, matchedImdbId, franchiseItems } =
    useDetailEnrichment({
      catalog,
      target,
      elvPrefs,
      elvEnrichActive,
      vodEnrichmentEnabled: vodEnrichmentEnabled === true,
      locale,
      refreshToken,
      mountedRef,
    });

  const selectSeason = useCallback(
    (season: number) => {
      if (snapRef.current.selectedSeason === season) return;
      const seriesId = seriesIdRef.current;
      if (seriesId !== undefined) {
        const seasons =
          snapRef.current.seasonsState.kind === 'ready'
            ? snapRef.current.seasonsState.seasons
            : undefined;
        void loadSeasonEpisodes(seriesId, season, activeSeriesKeyRef.current, {
          ...(seasons !== undefined ? { seasons } : {}),
        });
      }
    },
    [loadSeasonEpisodes],
  );

  const retrySeasons = useCallback(() => {
    updateSnap(
      (prev) => ({
        ...prev,
        seasonsState: { kind: 'loading' },
        episodesLoading: true,
        episodesRefreshing: false,
      }),
      false,
    );
    setSeasonsRetryToken((n) => n + 1);
  }, [updateSnap]);

  const {
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
    trailerStreamUrl,
    trailerYoutubeId,
    plot,
    genres,
  } = useMemo(
    () =>
      deriveDetailPresentation({
        target,
        detailRow: snap.detailRow,
        enrichment,
        vodEnrichmentEnabled: vodEnrichmentEnabled === true,
        elvEnrichActive,
        elvPosterLookupPending,
        activeElvTitle,
        elvTitleFormat: elvPrefs.elvTitleFormat,
        locale,
      }),
    [
      activeElvTitle,
      elvEnrichActive,
      elvPosterLookupPending,
      elvPrefs.elvTitleFormat,
      enrichment,
      locale,
      snap.detailRow,
      target,
      vodEnrichmentEnabled,
    ],
  );

  const mutationRefs = useMemo(
    () => ({
      mountedRef,
      snapRef,
      activeItemKeyRef,
      activeSeriesKeyRef,
      activeSeriesSourceIdRef,
      seriesIdRef,
      episodesBySeasonRef,
      myListGenRef,
      myListInFlightRef,
      committedMyListRef,
      watchedGenRef,
      watchedInFlightRef,
      committedMovieProgressRef,
      userRatingRef,
      ratingGenRef,
      ratingInFlightRef,
      committedRatingRef,
      seriesBulkWatchedRef,
      seriesUnplayedSummaryRef,
      seasonBulkOverridesRef,
      bulkWatchedInFlightRef,
    }),
    [],
  );
  const {
    toggleMyList,
    toggleWatched,
    toggleRating,
    toggleEpisodeWatched,
    markSeasonWatched,
    markSeriesWatched,
  } = useDetailMutations({
    catalog,
    target,
    title,
    posterUri,
    backdropUri,
    year,
    rating,
    refs: mutationRefs,
    updateSnap,
    setUserRating: setUserRatingState,
    setSeriesBulkWatched,
    setSeasonBulkOverrides,
  });

  const getCachedSeasonEpisodes = useCallback(
    (season: number): readonly EpisodeRow[] | undefined => episodesBySeasonRef.current.get(season),
    [],
  );

  const isSeasonWatched = useCallback(
    (season: number): boolean => {
      const eps =
        episodesBySeasonRef.current.get(season) ??
        (snap.selectedSeason === season ? snap.episodes : undefined);
      if (eps && eps.length > 0) return areEpisodesAllWatched(eps, snap.episodeProgressByKey);
      const seasonOverride = seasonBulkOverrides.get(season);
      if (seasonOverride !== undefined) return seasonOverride;
      if (seriesBulkWatched !== null) return seriesBulkWatched;
      return seriesUnplayedSummary?.watched === true;
    },
    [
      seasonBulkOverrides,
      seriesBulkWatched,
      seriesUnplayedSummary,
      snap.episodeProgressByKey,
      snap.episodes,
      snap.selectedSeason,
    ],
  );

  const totalSeasonsCount =
    snap.seasonsState.kind === 'ready' ? snap.seasonsState.seasons.length : 0;
  const isSeriesWatched = useMemo(
    () =>
      computeSeriesWatchedState({
        bulkOverride: seriesBulkWatched,
        dbSummary: seriesUnplayedSummary,
        totalSeasonsCount,
        episodesBySeason: episodesBySeasonRef.current,
        currentEpisodes: snap.episodes,
        progressByKey: snap.episodeProgressByKey,
      }),
    [
      seriesBulkWatched,
      seriesUnplayedSummary,
      snap.episodeProgressByKey,
      snap.episodes,
      totalSeasonsCount,
    ],
  );

  const resolvedSeriesId =
    effectiveSeriesKey === target.itemKey
      ? (target.catalogId ?? snap.detailRow?.id ?? seriesIdRef.current)
      : seriesIdRef.current;

  const relatedSeriesKeys = useMemo(
    () => snap.related.filter((item) => item.kind === 'series').map((item) => item.key),
    [snap.related],
  );
  const relatedUnplayedBySeriesKey = useSeriesUnplayedCounts(
    catalog,
    relatedSeriesKeys,
    refreshToken + userStateVersion,
  );

  return useMemo<DetailDataState>(() => {
    const { detailRow: _ignored, ...rest } = snap;
    return {
      ...rest,
      title,
      rawTitle,
      posterUri,
      backdropUri,
      year,
      rating,
      votes,
      runtimeMin,
      director,
      cast,
      trailerStreamUrl,
      trailerYoutubeId,
      imdbId: matchedImdbId,
      franchiseItems,
      plot,
      genres,
      relatedUnplayedBySeriesKey,
      versions,
      userRating,
      resolvedSeriesId,
      isSeriesWatched,
      isSeasonWatched,
      getCachedSeasonEpisodes,
      selectSeason,
      retrySeasons,
      toggleMyList,
      toggleWatched,
      toggleRating,
      toggleEpisodeWatched,
      markSeasonWatched,
      markSeriesWatched,
    };
  }, [
    backdropUri,
    cast,
    director,
    franchiseItems,
    genres,
    getCachedSeasonEpisodes,
    isSeasonWatched,
    isSeriesWatched,
    markSeasonWatched,
    markSeriesWatched,
    matchedImdbId,
    plot,
    posterUri,
    rating,
    rawTitle,
    relatedUnplayedBySeriesKey,
    resolvedSeriesId,
    retrySeasons,
    runtimeMin,
    selectSeason,
    snap,
    title,
    toggleEpisodeWatched,
    toggleMyList,
    toggleRating,
    toggleWatched,
    trailerStreamUrl,
    trailerYoutubeId,
    userRating,
    versions,
    votes,
    year,
  ]);
}
