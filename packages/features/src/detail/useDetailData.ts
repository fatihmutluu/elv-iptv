import type { CatalogService, EpisodeRow, WatchProgressRow } from '@elv/data';
import { elvError } from '@elv/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DetailTarget, useCatalogUiCache } from '../shared';
import {
  type DetailSeasonsState,
  type DetailSnapshot,
  emptyDetailSnapshot,
  fetchRelatedDetailItems,
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
}

/** Hydrated Detail screen dataset, series season controls, and optimistic user-state mutations. */
export interface DetailDataState extends Omit<DetailSnapshot, 'detailRow'> {
  readonly title: string;
  readonly posterUri: string | null;
  readonly backdropUri: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly plot: string | null;
  readonly selectSeason: (season: number) => void;
  readonly retrySeasons: () => void;
  readonly toggleMyList: () => Promise<void>;
  readonly toggleWatched: () => Promise<void>;
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
}: UseDetailDataOptions): DetailDataState {
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

  const mountedRef = useRef(true);
  const snapRef = useRef(snap);
  const activeItemKeyRef = useRef(target.itemKey);
  const activeSourceIdRef = useRef(target.sourceId);
  activeSourceIdRef.current = target.sourceId;
  const prevItemKeyRef = useRef(target.itemKey);
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
    activeItemKeyRef,
    activeSourceIdRef,
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
    prevItemKeyRef.current = target.itemKey;
    activeItemKeyRef.current = target.itemKey;

    if (itemChanged) {
      myListGenRef.current += 1;
      myListInFlightRef.current = 0;
      watchedGenRef.current += 1;
      watchedInFlightRef.current = 0;
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
    }

    let cancelled = false;
    const isStale = () => cancelled || !mountedRef.current || gen !== hydrationGenRef.current;

    const run = async () => {
      const eagerSeasons =
        target.kind === 'series' && target.catalogId !== undefined
          ? catalog.seasons(target.catalogId).catch(() => null)
          : null;
      const [hydratedDetail, favKeys, fetchedMovieProg, relatedResult] = await Promise.all([
        catalog.itemDetail ? catalog.itemDetail(target.itemKey).catch(() => null) : null,
        catalog.listFavoriteKeys ? catalog.listFavoriteKeys().catch(() => [] as string[]) : [],
        target.kind === 'movie' && catalog.getProgress
          ? catalog.getProgress(target.itemKey).catch(() => null)
          : null,
        fetchRelatedDetailItems(catalog, target),
      ]);
      if (isStale()) return;

      const isFav = new Set(favKeys).has(target.itemKey);
      if (myListInFlightRef.current === 0) committedMyListRef.current = isFav;
      if (target.kind === 'movie' && watchedInFlightRef.current === 0) {
        committedMovieProgressRef.current = fetchedMovieProg;
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

      const resolvedSeriesId = target.catalogId ?? hydratedDetail?.id ?? seriesIdRef.current;
      seriesIdRef.current = resolvedSeriesId;
      if (resolvedSeriesId === undefined) {
        updateSnap((prev) => ({
          ...prev,
          seasonsState: { kind: 'ready', seasons: [] },
          episodes: [],
          episodesLoading: false,
          episodesRefreshing: false,
        }));
        return;
      }

      const seasonsRes =
        eagerSeasons !== null
          ? await eagerSeasons
          : await catalog.seasons(resolvedSeriesId).catch(() => null);
      if (isStale()) return;

      if (seasonsRes === null || !seasonsRes.ok) {
        if (
          !itemChanged &&
          snapRef.current.seasonsState.kind === 'ready' &&
          snapRef.current.seasonsState.seasons.length > 0
        ) {
          return;
        }
        const error =
          seasonsRes === null ? elvError('storage', 'seasons-failed') : seasonsRes.error;
        updateSnap((prev) => ({
          ...prev,
          seasonsState: { kind: 'error', error },
          episodes: [],
          episodesLoading: false,
          episodesRefreshing: false,
        }));
        return;
      }

      const seasons = seasonsRes.value;
      if (seasons.length === 0) {
        updateSnap((prev) => ({
          ...prev,
          seasonsState: { kind: 'ready', seasons: [] },
          selectedSeason: null,
          episodes: [],
          episodeProgressByKey: new Map(),
          episodesLoading: false,
          episodesRefreshing: false,
        }));
        return;
      }

      const curSelected = snapRef.current.selectedSeason;
      const nextSeason =
        curSelected !== null && seasons.some((s) => s.season === curSelected)
          ? curSelected
          : (seasons[0]?.season ?? null);

      updateSnap((prev) => ({
        ...prev,
        seasonsState: { kind: 'ready', seasons },
        selectedSeason: nextSeason,
      }));
      if (nextSeason !== null) {
        const alreadyVisible =
          !itemChanged &&
          snapRef.current.episodes.length > 0 &&
          snapRef.current.selectedSeason === nextSeason;
        await loadSeasonEpisodes(resolvedSeriesId, nextSeason, target.itemKey, {
          backgroundRefresh: alreadyVisible,
          seasons,
        });
      } else {
        updateSnap((prev) => ({ ...prev, episodesLoading: false, episodesRefreshing: false }));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    cancelPrewarm,
    catalog,
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

  const selectSeason = useCallback(
    (season: number) => {
      if (snapRef.current.selectedSeason === season) return;
      const seriesId = seriesIdRef.current;
      if (seriesId !== undefined) {
        const seasons =
          snapRef.current.seasonsState.kind === 'ready'
            ? snapRef.current.seasonsState.seasons
            : undefined;
        void loadSeasonEpisodes(seriesId, season, activeItemKeyRef.current, {
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

  const title = snap.detailRow?.name ?? target.title;
  const posterUri = target.posterUri ?? snap.detailRow?.logo ?? null;
  const backdropUri = target.backdropUri ?? snap.detailRow?.logo ?? target.posterUri ?? null;
  const year = target.year ?? snap.detailRow?.year ?? null;
  const rating = target.rating ?? snap.detailRow?.rating ?? null;
  const plot = snap.detailRow?.plot ?? target.overview ?? null;

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
    }),
    [],
  );
  const { toggleMyList, toggleWatched } = useDetailMutations({
    catalog,
    target,
    title,
    posterUri,
    backdropUri,
    year,
    rating,
    refs: mutationRefs,
    updateSnap,
  });

  return useMemo<DetailDataState>(() => {
    const { detailRow: _ignored, ...rest } = snap;
    return {
      ...rest,
      title,
      posterUri,
      backdropUri,
      year,
      rating,
      plot,
      selectSeason,
      retrySeasons,
      toggleMyList,
      toggleWatched,
    };
  }, [
    backdropUri,
    plot,
    posterUri,
    rating,
    retrySeasons,
    selectSeason,
    snap,
    title,
    toggleMyList,
    toggleWatched,
    year,
  ]);
}
