import type { CatalogService, EpisodeRow, WatchProgressRow } from '@elv/data';
import { elvError } from '@elv/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { batchLoadProgressByKeys, type DetailTarget } from '../shared';
import {
  buildOptimisticWatchedRow,
  type DetailSeasonsState,
  type DetailSnapshot,
  emptyDetailSnapshot,
  fetchRelatedDetailItems,
} from './detail-data-helpers';

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
 * *More Like This* items (`<= 12`) in parallel with generation guards and optimistic mutations.
 */
export function useDetailData({
  target,
  catalog,
  refreshToken,
  userStateVersion = 0,
}: UseDetailDataOptions): DetailDataState {
  const [snap, setSnap] = useState<DetailSnapshot>(() =>
    emptyDetailSnapshot(target.kind, target.categoryId),
  );
  const [seasonsRetryToken, setSeasonsRetryToken] = useState(0);

  const mountedRef = useRef(true);
  const snapRef = useRef(snap);
  const activeItemKeyRef = useRef(target.itemKey);
  const prevItemKeyRef = useRef(target.itemKey);
  const seriesIdRef = useRef<number | undefined>(target.catalogId);
  const myListPendingRef = useRef<string | null>(null);
  const watchedPendingRef = useRef<string | null>(null);
  const hydrationGenRef = useRef(0);
  const episodesGenRef = useRef(0);

  const updateSnap = useCallback((updater: (prev: DetailSnapshot) => DetailSnapshot) => {
    const next = updater(snapRef.current);
    snapRef.current = next;
    setSnap((prev) => {
      const resolved = updater(prev);
      snapRef.current = resolved;
      return resolved;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSeasonEpisodes = useCallback(
    async (seriesId: number, season: number, itemKey: string) => {
      const epGen = ++episodesGenRef.current;
      updateSnap((prev) => ({ ...prev, selectedSeason: season, episodesLoading: true }));
      try {
        const rows = await catalog.episodes(seriesId, season).catch(() => [] as EpisodeRow[]);
        if (!mountedRef.current || epGen !== episodesGenRef.current) return;
        if (activeItemKeyRef.current !== itemKey) return;
        const progressMap = await batchLoadProgressByKeys(
          catalog,
          rows.map((e) => e.key),
        ).catch(() => new Map<string, WatchProgressRow>());
        if (!mountedRef.current || epGen !== episodesGenRef.current) return;
        if (activeItemKeyRef.current !== itemKey) return;
        updateSnap((prev) => ({
          ...prev,
          episodes: rows,
          episodeProgressByKey: progressMap,
          episodesLoading: false,
        }));
      } catch {
        if (
          mountedRef.current &&
          epGen === episodesGenRef.current &&
          activeItemKeyRef.current === itemKey
        ) {
          updateSnap((prev) => ({ ...prev, episodesLoading: false }));
        }
      }
    },
    [catalog, updateSnap],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, and seasonsRetryToken intentionally trigger fresh bounded reads
  useEffect(() => {
    const gen = ++hydrationGenRef.current;
    const itemChanged = prevItemKeyRef.current !== target.itemKey;
    prevItemKeyRef.current = target.itemKey;
    activeItemKeyRef.current = target.itemKey;

    if (itemChanged) {
      myListPendingRef.current = null;
      watchedPendingRef.current = null;
      seriesIdRef.current = target.catalogId;
      updateSnap(() => emptyDetailSnapshot(target.kind, target.categoryId));
    } else if (target.kind === 'series') {
      updateSnap((prev) => ({ ...prev, seasonsState: { kind: 'loading' }, episodesLoading: true }));
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
      updateSnap((prev) => ({
        ...prev,
        detailRow: hydratedDetail,
        inMyList: myListPendingRef.current === target.itemKey ? prev.inMyList : isFav,
        movieProgress:
          target.kind === 'movie' && watchedPendingRef.current !== target.itemKey
            ? fetchedMovieProg
            : prev.movieProgress,
        relatedCategoryId: relatedResult.categoryId,
        related: relatedResult.items,
        relatedProgressByKey: relatedResult.progress,
      }));

      if (target.kind !== 'series') return;

      const resolvedSeriesId = target.catalogId ?? hydratedDetail?.id;
      seriesIdRef.current = resolvedSeriesId;
      if (resolvedSeriesId === undefined) {
        updateSnap((prev) => ({
          ...prev,
          seasonsState: { kind: 'ready', seasons: [] },
          episodes: [],
          episodesLoading: false,
        }));
        return;
      }

      const seasonsRes =
        eagerSeasons !== null
          ? await eagerSeasons
          : await catalog.seasons(resolvedSeriesId).catch(() => null);
      if (isStale()) return;

      if (seasonsRes === null || !seasonsRes.ok) {
        const error =
          seasonsRes === null ? elvError('storage', 'seasons-failed') : seasonsRes.error;
        updateSnap((prev) => ({
          ...prev,
          seasonsState: { kind: 'error', error },
          episodes: [],
          episodesLoading: false,
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
        }));
        return;
      }

      const curSelected = snapRef.current.selectedSeason;
      const nextSeason =
        !itemChanged && curSelected !== null && seasons.some((s) => s.season === curSelected)
          ? curSelected
          : (seasons[0]?.season ?? null);

      updateSnap((prev) => ({
        ...prev,
        seasonsState: { kind: 'ready', seasons },
        selectedSeason: nextSeason,
      }));
      if (nextSeason !== null) {
        await loadSeasonEpisodes(resolvedSeriesId, nextSeason, target.itemKey);
      } else {
        updateSnap((prev) => ({ ...prev, episodesLoading: false }));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
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
        void loadSeasonEpisodes(seriesId, season, activeItemKeyRef.current);
      }
    },
    [loadSeasonEpisodes],
  );

  const retrySeasons = useCallback(() => {
    updateSnap((prev) => ({ ...prev, seasonsState: { kind: 'loading' }, episodesLoading: true }));
    setSeasonsRetryToken((n) => n + 1);
  }, [updateSnap]);

  const title = snap.detailRow?.name ?? target.title;
  const posterUri = target.posterUri ?? snap.detailRow?.logo ?? null;
  const backdropUri = target.backdropUri ?? snap.detailRow?.logo ?? target.posterUri ?? null;
  const year = target.year ?? snap.detailRow?.year ?? null;
  const rating = target.rating ?? snap.detailRow?.rating ?? null;
  const plot = snap.detailRow?.plot ?? target.overview ?? null;

  const toggleMyList = useCallback(async (): Promise<void> => {
    const reqKey = target.itemKey;
    if (myListPendingRef.current === reqKey) return;
    const prevVal = snapRef.current.inMyList;
    myListPendingRef.current = reqKey;
    updateSnap((prev) => ({ ...prev, inMyList: !prevVal }));
    if (!catalog.toggleFavorite) {
      myListPendingRef.current = null;
      return;
    }
    try {
      const res = await catalog.toggleFavorite({
        sourceId: target.sourceId,
        itemKey: reqKey,
        kind: target.kind,
        title,
        logo: posterUri ?? backdropUri,
        year,
        rating,
      });
      if (mountedRef.current && activeItemKeyRef.current === reqKey && !res.ok) {
        updateSnap((prev) => ({ ...prev, inMyList: prevVal }));
      }
    } catch {
      if (mountedRef.current && activeItemKeyRef.current === reqKey) {
        updateSnap((prev) => ({ ...prev, inMyList: prevVal }));
      }
    } finally {
      if (myListPendingRef.current === reqKey) myListPendingRef.current = null;
    }
  }, [
    backdropUri,
    catalog,
    posterUri,
    rating,
    target.itemKey,
    target.kind,
    target.sourceId,
    title,
    updateSnap,
    year,
  ]);

  const toggleWatched = useCallback(async (): Promise<void> => {
    if (target.kind !== 'movie') return;
    const reqKey = target.itemKey;
    if (watchedPendingRef.current === reqKey) return;
    const prevRow = snapRef.current.movieProgress;
    const nextWatched = !(prevRow?.watched ?? false);
    const optimistic = buildOptimisticWatchedRow(prevRow, nextWatched, {
      sourceId: target.sourceId,
      itemKey: reqKey,
      title,
      logo: posterUri ?? backdropUri,
    });
    watchedPendingRef.current = reqKey;
    updateSnap((prev) => ({ ...prev, movieProgress: optimistic }));

    const useSave = prevRow === null && nextWatched && catalog.saveProgress !== undefined;
    if (!useSave && !catalog.setWatched) {
      watchedPendingRef.current = null;
      return;
    }
    try {
      const res = useSave
        ? await catalog.saveProgress?.({
            sourceId: target.sourceId,
            itemKey: reqKey,
            kind: 'movie',
            title,
            logo: posterUri ?? backdropUri,
            positionMs: optimistic.durationMs,
            durationMs: optimistic.durationMs,
            watched: true,
          })
        : await catalog.setWatched?.(reqKey, nextWatched);
      if (mountedRef.current && activeItemKeyRef.current === reqKey && res && !res.ok) {
        updateSnap((prev) => ({ ...prev, movieProgress: prevRow }));
      }
    } catch {
      if (mountedRef.current && activeItemKeyRef.current === reqKey) {
        updateSnap((prev) => ({ ...prev, movieProgress: prevRow }));
      }
    } finally {
      if (watchedPendingRef.current === reqKey) watchedPendingRef.current = null;
    }
  }, [
    backdropUri,
    catalog,
    posterUri,
    target.itemKey,
    target.kind,
    target.sourceId,
    title,
    updateSnap,
  ]);

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
