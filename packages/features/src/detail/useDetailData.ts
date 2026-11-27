import type {
  CatalogService,
  ElvFranchiseLibraryItem,
  ElvItemEnrichment,
  ElvTitleRecord,
  EpisodeRow,
  ItemDetailRow,
  RatingValue,
  SeasonRow,
  SeriesUnplayedSummary,
  VodEnrichmentRecord,
  VodVersionOption,
  WatchProgressRow,
} from '@elv/data';
import {
  DEFAULT_ELV_MODE_PREFERENCES,
  type ElvModePreferences,
  elvError,
  formatElvDisplayTitle,
  type Result,
} from '@elv/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DetailTarget,
  isElvFeatureActive,
  resolveElvLocalizedSynopsis,
  resolveElvLocalizedValue,
  useCatalogUiCache,
  useElvEnrichmentForKeys,
  useSeriesUnplayedCounts,
} from '../shared';
import type { DetailRichCastMember } from './DetailCastStrip';
import {
  type DetailSeasonsState,
  type DetailSnapshot,
  type DetailVersionOption,
  emptyDetailSnapshot,
  fetchRelatedDetailItems,
  mapMergedVodVariantToOption,
  mergeVodEnrichment,
} from './detail-data-helpers';
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
  readonly manualLock: boolean;
  readonly franchiseItems: readonly ElvFranchiseLibraryItem[];
  readonly plot: string | null;
  readonly genres: readonly string[];
  readonly isEnriched: boolean;
  readonly relatedUnplayedBySeriesKey: ReadonlyMap<string, SeriesUnplayedSummary>;
  readonly versions: readonly DetailVersionOption[];
  readonly userRating: RatingValue | null;
  readonly selectSeason: (season: number) => void;
  readonly retrySeasons: () => void;
  readonly toggleMyList: () => Promise<void>;
  readonly toggleWatched: () => Promise<void>;
  readonly toggleRating: (next: RatingValue) => Promise<void>;
  readonly applyFixMatchResult: (updated: ElvItemEnrichment) => void;
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
  const [enrichment, setEnrichment] = useState<VodEnrichmentRecord | null>(null);
  const [elvTitleDetail, setElvTitleDetail] = useState<ElvTitleRecord | null>(null);
  const [fixMatchOverride, setFixMatchOverride] = useState<ElvItemEnrichment | null>(null);
  const [fixMatchToken, setFixMatchToken] = useState(0);
  const [franchiseItems, setFranchiseItems] = useState<readonly ElvFranchiseLibraryItem[]>([]);
  const [userRating, setUserRatingState] = useState<RatingValue | null>(null);

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
      setEnrichment(null);
      setElvTitleDetail(null);
      setFixMatchOverride(null);
      setFranchiseItems([]);
      userRatingRef.current = null;
      setUserRatingState(null);
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

    const run = async () => {
      if (seriesVersionChanged) {
        const seriesDetail =
          effectiveSeriesKey === target.itemKey && target.catalogId !== undefined
            ? null
            : catalog.itemDetail
              ? await catalog.itemDetail(effectiveSeriesKey).catch(() => null)
              : null;
        if (isStale()) return;
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
      ]);
      if (isStale()) return;

      setVersions(fetchedVersions.length > 1 ? fetchedVersions : []);

      const isFav = new Set(favKeys).has(target.itemKey);
      if (myListInFlightRef.current === 0) committedMyListRef.current = isFav;
      if (target.kind === 'movie' && watchedInFlightRef.current === 0) {
        committedMovieProgressRef.current = fetchedMovieProg;
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
    fixMatchToken,
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

  const elvTargetKeys = useMemo(() => [target.itemKey], [target.itemKey]);
  const elvEnrichment = useElvEnrichmentForKeys(catalog, elvTargetKeys, {
    enabled: elvEnrichActive,
    lang: locale,
    catalogRevision: refreshToken + fixMatchToken,
  });
  const elvItemEnrichment =
    fixMatchOverride?.itemKey === target.itemKey
      ? fixMatchOverride
      : elvEnrichment.enrichmentByKey.get(target.itemKey);
  const elvPosterLookupPending =
    elvEnrichActive &&
    fixMatchOverride?.itemKey !== target.itemKey &&
    elvEnrichment.isKeyLookupPending(target.itemKey);
  const matchedImdbId = elvItemEnrichment?.imdbId ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: fixMatchToken triggers fresh detail fetch after Fix Match
  useEffect(() => {
    if (!elvEnrichActive || matchedImdbId === null || catalog.getElvTitleDetail === undefined) {
      setElvTitleDetail(null);
      return undefined;
    }
    let cancelled = false;
    const ac = new AbortController();
    void catalog
      .getElvTitleDetail(matchedImdbId, { lang: locale, signal: ac.signal })
      .then((rec) => {
        if (!cancelled && mountedRef.current && rec !== null) setElvTitleDetail(rec);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [catalog, elvEnrichActive, fixMatchToken, locale, matchedImdbId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fixMatchToken triggers fresh franchise fetch after Fix Match
  useEffect(() => {
    if (
      !elvPrefs.elvModeEnabled ||
      matchedImdbId === null ||
      catalog.listElvFranchiseItems === undefined
    ) {
      setFranchiseItems([]);
      return undefined;
    }
    let cancelled = false;
    void catalog
      .listElvFranchiseItems(matchedImdbId)
      .then((rows) => {
        if (!cancelled && mountedRef.current) setFranchiseItems(rows);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setFranchiseItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, elvPrefs.elvModeEnabled, fixMatchToken, matchedImdbId]);

  const applyFixMatchResult = useCallback((updated: ElvItemEnrichment) => {
    setFixMatchOverride(updated);
    if (updated.title !== null) setElvTitleDetail(updated.title);
    setFixMatchToken((n) => n + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken triggers opt-in enrichment refresh on source sync
  useEffect(() => {
    if (vodEnrichmentEnabled !== true) {
      setEnrichment(null);
      return undefined;
    }
    if (target.kind !== 'movie' && target.kind !== 'series') return undefined;
    if (typeof catalog.enrichVodItem !== 'function') return undefined;
    let cancelled = false;
    void catalog
      .enrichVodItem(target.itemKey, { enabled: true })
      .then((record) => {
        if (!cancelled && mountedRef.current) setEnrichment(record);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, refreshToken, target.itemKey, target.kind, vodEnrichmentEnabled]);

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

  const rawTitle = snap.detailRow?.name ?? target.title;
  const rawPosterUri = target.posterUri ?? snap.detailRow?.logo ?? null;
  const rawBackdropUri = target.backdropUri ?? snap.detailRow?.logo ?? target.posterUri ?? null;
  const providerYear = target.year ?? snap.detailRow?.year ?? null;
  const providerRating = target.rating ?? snap.detailRow?.rating ?? null;
  const providerPlot = snap.detailRow?.plot ?? target.overview ?? null;
  const providerGenres = target.genres;

  const mergedMeta = useMemo(
    () =>
      mergeVodEnrichment(
        {
          year: providerYear,
          rating: providerRating,
          genres: providerGenres ?? [],
          plot: providerPlot,
        },
        vodEnrichmentEnabled === true ? enrichment : null,
      ),
    [enrichment, providerGenres, providerPlot, providerRating, providerYear, vodEnrichmentEnabled],
  );
  const activeElvTitle = elvEnrichActive
    ? (elvTitleDetail ?? elvItemEnrichment?.title ?? null)
    : null;
  const title =
    activeElvTitle !== null
      ? formatElvDisplayTitle({
          originalTitle: activeElvTitle.originalTitle,
          englishTitle: activeElvTitle.englishTitle,
          localizedTitle: resolveElvLocalizedValue(activeElvTitle.localizedTitles, locale),
          fallbackTitle: rawTitle,
          format: elvPrefs.elvTitleFormat,
        })
      : rawTitle;
  const nonEmptyUrl = (v: string | null | undefined): string | null => {
    const t = v?.trim();
    return t && t.length > 0 ? t : null;
  };
  const elvPoster = nonEmptyUrl(activeElvTitle?.posterUrl);
  const elvBackdrop = nonEmptyUrl(activeElvTitle?.backdropUrl);
  const posterUri = elvPoster ?? (elvPosterLookupPending ? null : rawPosterUri);
  const backdropUri = elvBackdrop ?? elvPoster ?? (elvPosterLookupPending ? null : rawBackdropUri);
  const year =
    activeElvTitle?.year != null && Number.isFinite(activeElvTitle.year)
      ? activeElvTitle.year
      : mergedMeta.year;
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
  const isEnriched = activeElvTitle !== null || mergedMeta.enriched;
  const votes =
    activeElvTitle?.votes != null && Number.isFinite(activeElvTitle.votes)
      ? activeElvTitle.votes
      : null;
  const runtimeMin =
    activeElvTitle?.runtimeMin != null && Number.isFinite(activeElvTitle.runtimeMin)
      ? activeElvTitle.runtimeMin
      : null;
  const director = activeElvTitle?.director?.trim() || target.director?.trim() || null;
  const cast = useMemo<readonly DetailRichCastMember[]>(() => {
    if (activeElvTitle !== null && activeElvTitle.cast.length > 0) {
      return activeElvTitle.cast.map((m) => ({
        ...(m.personId ? { personId: m.personId } : {}),
        name: m.name,
        ...(m.character ? { role: m.character } : {}),
        ...(m.portraitUrl ? { avatarUri: m.portraitUrl } : {}),
      }));
    }
    return target.cast ?? [];
  }, [activeElvTitle, target.cast]);
  const trailerStreamUrl = activeElvTitle?.trailerStreamUrl ?? null;
  const trailerYoutubeId = activeElvTitle?.trailerYoutubeId ?? null;
  const manualLock = elvItemEnrichment?.manualLock === true;

  const mutationRefs = useMemo(
    () => ({
      mountedRef,
      snapRef,
      activeItemKeyRef,
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
    }),
    [],
  );
  const { toggleMyList, toggleWatched, toggleRating } = useDetailMutations({
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
  });

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
      manualLock,
      franchiseItems,
      plot,
      genres,
      isEnriched,
      relatedUnplayedBySeriesKey,
      versions,
      userRating,
      selectSeason,
      retrySeasons,
      toggleMyList,
      toggleWatched,
      toggleRating,
      applyFixMatchResult,
    };
  }, [
    applyFixMatchResult,
    backdropUri,
    cast,
    director,
    franchiseItems,
    genres,
    isEnriched,
    manualLock,
    matchedImdbId,
    plot,
    posterUri,
    rating,
    rawTitle,
    relatedUnplayedBySeriesKey,
    retrySeasons,
    runtimeMin,
    selectSeason,
    snap,
    title,
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
