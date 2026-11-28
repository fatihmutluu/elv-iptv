import type {
  CatalogService,
  EpisodeRow,
  RatingValue,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import { type MutableRefObject, useCallback, useRef } from 'react';
import { type DetailTarget, useProfile } from '../shared';
import {
  buildOptimisticEpisodeWatchedRow,
  buildOptimisticWatchedRow,
  type DetailSnapshot,
} from './detail-data-helpers';

/** Shared mutable refs coordinating optimistic Detail mutations with background hydration. */
export interface DetailMutationRefs {
  readonly mountedRef: MutableRefObject<boolean>;
  readonly snapRef: MutableRefObject<DetailSnapshot>;
  readonly activeItemKeyRef: MutableRefObject<string>;
  readonly activeSeriesKeyRef: MutableRefObject<string>;
  readonly activeSeriesSourceIdRef: MutableRefObject<string>;
  readonly seriesIdRef: MutableRefObject<number | undefined>;
  readonly episodesBySeasonRef: MutableRefObject<Map<number, readonly EpisodeRow[]>>;
  readonly myListGenRef: MutableRefObject<number>;
  readonly myListInFlightRef: MutableRefObject<number>;
  readonly committedMyListRef: MutableRefObject<boolean | undefined>;
  readonly watchedGenRef: MutableRefObject<number>;
  readonly watchedInFlightRef: MutableRefObject<number>;
  readonly committedMovieProgressRef: MutableRefObject<WatchProgressRow | null | undefined>;
  readonly userRatingRef: MutableRefObject<RatingValue | null>;
  readonly ratingGenRef: MutableRefObject<number>;
  readonly ratingInFlightRef: MutableRefObject<number>;
  readonly committedRatingRef: MutableRefObject<RatingValue | null | undefined>;
  readonly seriesBulkWatchedRef: MutableRefObject<boolean | null>;
  readonly seriesUnplayedSummaryRef: MutableRefObject<SeriesUnplayedSummary | null>;
  readonly seasonBulkOverridesRef: MutableRefObject<ReadonlyMap<number, boolean>>;
  readonly bulkWatchedInFlightRef: MutableRefObject<number>;
}

/**
 * Optimistic generation-tracked `toggleMyList`, `toggleWatched`, `toggleRating`,
 * `toggleEpisodeWatched`, `markSeasonWatched`, and `markSeriesWatched` actions for
 * {@link useDetailData}. Tracks committed baselines so rapid toggles whose writes fail roll back
 * to persisted truth instead of an unpersisted intermediate state (`#230`).
 */
export function useDetailMutations(opts: {
  readonly catalog: CatalogService;
  readonly target: DetailTarget;
  readonly title: string;
  readonly posterUri: string | null;
  readonly backdropUri: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly refs: DetailMutationRefs;
  readonly updateSnap: (
    updater: (prev: DetailSnapshot) => DetailSnapshot,
    persist?: boolean,
  ) => void;
  readonly setUserRating: (next: RatingValue | null) => void;
  readonly setSeriesBulkWatched: (next: boolean | null) => void;
  readonly setSeasonBulkOverrides: (next: ReadonlyMap<number, boolean>) => void;
}): {
  readonly toggleMyList: () => Promise<void>;
  readonly toggleWatched: () => Promise<void>;
  readonly toggleRating: (next: RatingValue) => Promise<void>;
  readonly toggleEpisodeWatched: (episode: EpisodeRow) => Promise<void>;
  readonly markSeasonWatched: (season: number, watched: boolean) => Promise<boolean>;
  readonly markSeriesWatched: (watched: boolean) => Promise<boolean>;
} {
  const {
    catalog,
    target,
    title,
    posterUri,
    backdropUri,
    year,
    rating,
    refs,
    updateSnap,
    setUserRating,
    setSeriesBulkWatched,
    setSeasonBulkOverrides,
  } = opts;
  const { activeProfileId } = useProfile();

  const episodeGenByKeyRef = useRef<Map<string, number>>(new Map());
  const episodeInFlightByKeyRef = useRef<Map<string, number>>(new Map());
  const committedEpisodeByKeyRef = useRef<Map<string, WatchProgressRow | undefined>>(new Map());
  const bulkWatchedGenRef = useRef(0);

  const toggleMyList = useCallback(async (): Promise<void> => {
    const reqKey = target.itemKey;
    const gen = ++refs.myListGenRef.current;
    if (refs.myListInFlightRef.current === 0 || refs.committedMyListRef.current === undefined) {
      refs.committedMyListRef.current = refs.snapRef.current.inMyList;
    }
    refs.myListInFlightRef.current += 1;
    const nextVal = !refs.snapRef.current.inMyList;
    updateSnap((prev) => ({ ...prev, inMyList: nextVal }));
    const favInput = {
      sourceId: target.sourceId,
      itemKey: reqKey,
      kind: target.kind,
      title,
      logo: posterUri ?? backdropUri,
      year,
      rating,
    };
    if (!catalog.setFavorite && !catalog.toggleFavorite) {
      refs.committedMyListRef.current = nextVal;
      refs.myListInFlightRef.current = Math.max(0, refs.myListInFlightRef.current - 1);
      return;
    }
    try {
      const res = catalog.setFavorite
        ? await catalog.setFavorite(favInput, nextVal)
        : await catalog.toggleFavorite?.(favInput);
      if (!refs.mountedRef.current || refs.activeItemKeyRef.current !== reqKey || !res) return;
      if (res.ok) {
        refs.committedMyListRef.current = res.value;
      } else if (refs.myListGenRef.current === gen) {
        const baseline = refs.committedMyListRef.current ?? false;
        updateSnap((prev) => ({ ...prev, inMyList: baseline }));
      }
    } catch {
      if (
        refs.mountedRef.current &&
        refs.activeItemKeyRef.current === reqKey &&
        refs.myListGenRef.current === gen
      ) {
        const baseline = refs.committedMyListRef.current ?? false;
        updateSnap((prev) => ({ ...prev, inMyList: baseline }));
      }
    } finally {
      refs.myListInFlightRef.current = Math.max(0, refs.myListInFlightRef.current - 1);
    }
  }, [
    backdropUri,
    catalog,
    posterUri,
    rating,
    refs,
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
    const gen = ++refs.watchedGenRef.current;
    const prevRow = refs.snapRef.current.movieProgress;
    if (
      refs.watchedInFlightRef.current === 0 ||
      refs.committedMovieProgressRef.current === undefined
    ) {
      refs.committedMovieProgressRef.current = prevRow;
    }
    refs.watchedInFlightRef.current += 1;
    const nextWatched = !(prevRow?.watched ?? false);
    const optimistic = buildOptimisticWatchedRow(prevRow, nextWatched, {
      sourceId: target.sourceId,
      itemKey: reqKey,
      title,
      logo: posterUri ?? backdropUri,
      profileId: activeProfileId,
    });
    updateSnap((prev) => ({ ...prev, movieProgress: optimistic }));

    const useSave = prevRow === null && nextWatched && catalog.saveProgress !== undefined;
    if (!useSave && !catalog.setWatched) {
      refs.committedMovieProgressRef.current = optimistic;
      refs.watchedInFlightRef.current = Math.max(0, refs.watchedInFlightRef.current - 1);
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
      if (!refs.mountedRef.current || refs.activeItemKeyRef.current !== reqKey || !res) return;
      if (res.ok) {
        refs.committedMovieProgressRef.current = optimistic;
      } else if (refs.watchedGenRef.current === gen) {
        const baseline = refs.committedMovieProgressRef.current ?? null;
        updateSnap((prev) => ({ ...prev, movieProgress: baseline }));
      }
    } catch {
      if (
        refs.mountedRef.current &&
        refs.activeItemKeyRef.current === reqKey &&
        refs.watchedGenRef.current === gen
      ) {
        const baseline = refs.committedMovieProgressRef.current ?? null;
        updateSnap((prev) => ({ ...prev, movieProgress: baseline }));
      }
    } finally {
      refs.watchedInFlightRef.current = Math.max(0, refs.watchedInFlightRef.current - 1);
    }
  }, [
    activeProfileId,
    backdropUri,
    catalog,
    posterUri,
    refs,
    target.itemKey,
    target.kind,
    target.sourceId,
    title,
    updateSnap,
  ]);

  const toggleRating = useCallback(
    async (next: RatingValue): Promise<void> => {
      const reqKey = target.itemKey;
      const gen = ++refs.ratingGenRef.current;
      const current = refs.userRatingRef.current;
      if (refs.ratingInFlightRef.current === 0 || refs.committedRatingRef.current === undefined) {
        refs.committedRatingRef.current = current;
      }
      refs.ratingInFlightRef.current += 1;
      const nextVal: RatingValue | null = current === next ? null : next;
      refs.userRatingRef.current = nextVal;
      setUserRating(nextVal);
      if (!catalog.setRating) {
        refs.committedRatingRef.current = nextVal;
        refs.ratingInFlightRef.current = Math.max(0, refs.ratingInFlightRef.current - 1);
        return;
      }
      try {
        const res = await catalog.setRating(
          {
            sourceId: target.sourceId,
            itemKey: reqKey,
            kind: target.kind,
            title,
            logo: posterUri ?? backdropUri,
            year,
            rating,
          },
          nextVal,
        );
        if (!refs.mountedRef.current || refs.activeItemKeyRef.current !== reqKey) return;
        if (res.ok) {
          refs.committedRatingRef.current = res.value;
        } else if (refs.ratingGenRef.current === gen) {
          const baseline = refs.committedRatingRef.current ?? null;
          refs.userRatingRef.current = baseline;
          setUserRating(baseline);
        }
      } catch {
        if (
          refs.mountedRef.current &&
          refs.activeItemKeyRef.current === reqKey &&
          refs.ratingGenRef.current === gen
        ) {
          const baseline = refs.committedRatingRef.current ?? null;
          refs.userRatingRef.current = baseline;
          setUserRating(baseline);
        }
      } finally {
        refs.ratingInFlightRef.current = Math.max(0, refs.ratingInFlightRef.current - 1);
      }
    },
    [
      backdropUri,
      catalog,
      posterUri,
      rating,
      refs,
      setUserRating,
      target.itemKey,
      target.kind,
      target.sourceId,
      title,
      year,
    ],
  );

  const toggleEpisodeWatched = useCallback(
    async (episode: EpisodeRow): Promise<void> => {
      const reqSeriesKey = refs.activeSeriesKeyRef.current;
      const reqSourceId = refs.activeSeriesSourceIdRef.current;
      const epKey = episode.key;
      const gen = (episodeGenByKeyRef.current.get(epKey) ?? 0) + 1;
      episodeGenByKeyRef.current.set(epKey, gen);
      const prevRow = refs.snapRef.current.episodeProgressByKey.get(epKey);
      const prevInFlight = episodeInFlightByKeyRef.current.get(epKey) ?? 0;
      if (prevInFlight === 0 || !committedEpisodeByKeyRef.current.has(epKey)) {
        committedEpisodeByKeyRef.current.set(epKey, prevRow);
      }
      episodeInFlightByKeyRef.current.set(epKey, prevInFlight + 1);

      const nextWatched = !(prevRow?.watched === true);
      const optimistic = buildOptimisticEpisodeWatchedRow(prevRow, nextWatched, {
        sourceId: reqSourceId,
        seriesKey: reqSeriesKey,
        episode,
        fallbackTitle: title,
        logo: posterUri ?? backdropUri,
        profileId: activeProfileId,
      });

      const prevBulkWatched = refs.seriesBulkWatchedRef.current;
      const prevSeasonOverrides = refs.seasonBulkOverridesRef.current;
      if (!nextWatched) {
        if (
          refs.seriesBulkWatchedRef.current === true ||
          refs.seriesUnplayedSummaryRef.current?.watched === true
        ) {
          refs.seriesBulkWatchedRef.current = false;
          setSeriesBulkWatched(false);
        }
        if (
          episode.season !== null &&
          refs.seasonBulkOverridesRef.current.get(episode.season) === true
        ) {
          const nextOverrides = new Map(refs.seasonBulkOverridesRef.current);
          nextOverrides.set(episode.season, false);
          refs.seasonBulkOverridesRef.current = nextOverrides;
          setSeasonBulkOverrides(nextOverrides);
        }
      }
      updateSnap((prev) => {
        const nextMap = new Map(prev.episodeProgressByKey);
        nextMap.set(epKey, optimistic);
        return { ...prev, episodeProgressByKey: nextMap };
      });

      const hasSetWatched = typeof catalog.setWatched === 'function';
      const useSaveFallback = !hasSetWatched && nextWatched && catalog.saveProgress !== undefined;
      if (!hasSetWatched && !useSaveFallback) {
        committedEpisodeByKeyRef.current.set(epKey, optimistic);
        episodeInFlightByKeyRef.current.set(
          epKey,
          Math.max(0, (episodeInFlightByKeyRef.current.get(epKey) ?? 1) - 1),
        );
        return;
      }

      const rollback = () => {
        if (
          !refs.mountedRef.current ||
          refs.activeSeriesKeyRef.current !== reqSeriesKey ||
          episodeGenByKeyRef.current.get(epKey) !== gen
        ) {
          return;
        }
        refs.seriesBulkWatchedRef.current = prevBulkWatched;
        setSeriesBulkWatched(prevBulkWatched);
        refs.seasonBulkOverridesRef.current = prevSeasonOverrides;
        setSeasonBulkOverrides(prevSeasonOverrides);
        const baseline = committedEpisodeByKeyRef.current.get(epKey);
        updateSnap((prev) => {
          const nextMap = new Map(prev.episodeProgressByKey);
          if (baseline === undefined) nextMap.delete(epKey);
          else nextMap.set(epKey, baseline);
          return { ...prev, episodeProgressByKey: nextMap };
        });
      };

      try {
        const res = hasSetWatched
          ? await catalog.setWatched?.(epKey, nextWatched)
          : await catalog.saveProgress?.({
              sourceId: reqSourceId,
              itemKey: epKey,
              kind: 'episode',
              title: optimistic.title,
              logo: posterUri ?? backdropUri,
              seriesKey: reqSeriesKey,
              season: episode.season,
              episode: episode.episode,
              positionMs: optimistic.durationMs,
              durationMs: optimistic.durationMs,
              watched: true,
            });
        if (!refs.mountedRef.current || refs.activeSeriesKeyRef.current !== reqSeriesKey || !res) {
          return;
        }
        if (res.ok) {
          committedEpisodeByKeyRef.current.set(epKey, optimistic);
        } else {
          rollback();
        }
      } catch {
        rollback();
      } finally {
        episodeInFlightByKeyRef.current.set(
          epKey,
          Math.max(0, (episodeInFlightByKeyRef.current.get(epKey) ?? 1) - 1),
        );
      }
    },
    [
      activeProfileId,
      backdropUri,
      catalog,
      posterUri,
      refs,
      setSeasonBulkOverrides,
      setSeriesBulkWatched,
      title,
      updateSnap,
    ],
  );

  const persistEpisodesFallback = useCallback(
    async (
      episodes: readonly EpisodeRow[],
      watched: boolean,
      reqSeriesKey: string,
      reqSourceId: string,
    ): Promise<boolean> => {
      const hasSetWatched = typeof catalog.setWatched === 'function';
      for (const ep of episodes) {
        const prevRow = refs.snapRef.current.episodeProgressByKey.get(ep.key);
        const optimistic = buildOptimisticEpisodeWatchedRow(prevRow, watched, {
          sourceId: reqSourceId,
          seriesKey: reqSeriesKey,
          episode: ep,
          fallbackTitle: title,
          logo: posterUri ?? backdropUri,
          profileId: activeProfileId,
        });
        const res = hasSetWatched
          ? await catalog.setWatched?.(ep.key, watched)
          : watched && catalog.saveProgress !== undefined
            ? await catalog.saveProgress({
                sourceId: reqSourceId,
                itemKey: ep.key,
                kind: 'episode',
                title: optimistic.title,
                logo: posterUri ?? backdropUri,
                seriesKey: reqSeriesKey,
                season: ep.season,
                episode: ep.episode,
                positionMs: optimistic.durationMs,
                durationMs: optimistic.durationMs,
                watched: true,
              })
            : undefined;
        if (res && !res.ok) return false;
      }
      return true;
    },
    [activeProfileId, backdropUri, catalog, posterUri, refs, title],
  );

  const markSeasonWatched = useCallback(
    async (season: number, watched: boolean): Promise<boolean> => {
      if (target.kind !== 'series') return false;
      const reqSeriesKey = refs.activeSeriesKeyRef.current;
      const reqSourceId = refs.activeSeriesSourceIdRef.current;
      const gen = ++bulkWatchedGenRef.current;
      const prevBulk = refs.seriesBulkWatchedRef.current;
      const hadPrevSeasonOverride = refs.seasonBulkOverridesRef.current.has(season);
      const prevSeasonOverride = refs.seasonBulkOverridesRef.current.get(season);

      const knownSeasonEps =
        refs.episodesBySeasonRef.current.get(season) ??
        (refs.snapRef.current.selectedSeason === season ? refs.snapRef.current.episodes : []);

      const prevEntries = new Map<string, WatchProgressRow | undefined>();
      for (const ep of knownSeasonEps) {
        prevEntries.set(ep.key, refs.snapRef.current.episodeProgressByKey.get(ep.key));
      }

      const nextSeasonOverrides = new Map(refs.seasonBulkOverridesRef.current);
      nextSeasonOverrides.set(season, watched);
      refs.seasonBulkOverridesRef.current = nextSeasonOverrides;
      setSeasonBulkOverrides(nextSeasonOverrides);

      if (
        !watched &&
        (refs.seriesBulkWatchedRef.current === true ||
          refs.seriesUnplayedSummaryRef.current?.watched === true)
      ) {
        refs.seriesBulkWatchedRef.current = false;
        setSeriesBulkWatched(false);
      }

      if (knownSeasonEps.length > 0) {
        updateSnap((prev) => {
          const nextMap = new Map(prev.episodeProgressByKey);
          for (const ep of knownSeasonEps) {
            nextMap.set(
              ep.key,
              buildOptimisticEpisodeWatchedRow(nextMap.get(ep.key), watched, {
                sourceId: reqSourceId,
                seriesKey: reqSeriesKey,
                episode: ep,
                fallbackTitle: title,
                logo: posterUri ?? backdropUri,
                profileId: activeProfileId,
              }),
            );
          }
          return { ...prev, episodeProgressByKey: nextMap };
        });
      }

      const rollback = () => {
        if (
          !refs.mountedRef.current ||
          refs.activeSeriesKeyRef.current !== reqSeriesKey ||
          bulkWatchedGenRef.current !== gen
        ) {
          return;
        }
        refs.seriesBulkWatchedRef.current = prevBulk;
        setSeriesBulkWatched(prevBulk);
        const restoredOverrides = new Map(refs.seasonBulkOverridesRef.current);
        if (hadPrevSeasonOverride && prevSeasonOverride !== undefined) {
          restoredOverrides.set(season, prevSeasonOverride);
        } else {
          restoredOverrides.delete(season);
        }
        refs.seasonBulkOverridesRef.current = restoredOverrides;
        setSeasonBulkOverrides(restoredOverrides);
        if (prevEntries.size > 0) {
          updateSnap((prev) => {
            const nextMap = new Map(prev.episodeProgressByKey);
            for (const [k, prevVal] of prevEntries) {
              if (prevVal === undefined) nextMap.delete(k);
              else nextMap.set(k, prevVal);
            }
            return { ...prev, episodeProgressByKey: nextMap };
          });
        }
      };

      refs.bulkWatchedInFlightRef.current += 1;
      try {
        if (typeof catalog.setSeasonWatched === 'function') {
          const res = await catalog.setSeasonWatched(reqSeriesKey, season, watched);
          if (!refs.mountedRef.current || refs.activeSeriesKeyRef.current !== reqSeriesKey) {
            return res.ok;
          }
          if (!res.ok) {
            rollback();
            return false;
          }
          return true;
        }
        let targetEps = knownSeasonEps;
        if (targetEps.length === 0 && refs.seriesIdRef.current !== undefined) {
          targetEps = await catalog.episodes(refs.seriesIdRef.current, season).catch(() => []);
        }
        const okAll = await persistEpisodesFallback(targetEps, watched, reqSeriesKey, reqSourceId);
        if (!okAll) {
          rollback();
          return false;
        }
        return true;
      } catch {
        rollback();
        return false;
      } finally {
        refs.bulkWatchedInFlightRef.current = Math.max(0, refs.bulkWatchedInFlightRef.current - 1);
      }
    },
    [
      activeProfileId,
      backdropUri,
      catalog,
      persistEpisodesFallback,
      posterUri,
      refs,
      setSeasonBulkOverrides,
      setSeriesBulkWatched,
      target.kind,
      title,
      updateSnap,
    ],
  );

  const markSeriesWatched = useCallback(
    async (watched: boolean): Promise<boolean> => {
      if (target.kind !== 'series') return false;
      const reqSeriesKey = refs.activeSeriesKeyRef.current;
      const reqSourceId = refs.activeSeriesSourceIdRef.current;
      const gen = ++bulkWatchedGenRef.current;
      const prevBulk = refs.seriesBulkWatchedRef.current;
      const prevSeasonOverrides = refs.seasonBulkOverridesRef.current;

      const allKnown: EpisodeRow[] = [];
      const seenKeys = new Set<string>();
      for (const eps of refs.episodesBySeasonRef.current.values()) {
        for (const ep of eps) {
          if (!seenKeys.has(ep.key)) {
            seenKeys.add(ep.key);
            allKnown.push(ep);
          }
        }
      }
      for (const ep of refs.snapRef.current.episodes) {
        if (!seenKeys.has(ep.key)) {
          seenKeys.add(ep.key);
          allKnown.push(ep);
        }
      }

      const prevEntries = new Map<string, WatchProgressRow | undefined>();
      for (const ep of allKnown) {
        prevEntries.set(ep.key, refs.snapRef.current.episodeProgressByKey.get(ep.key));
      }

      refs.seriesBulkWatchedRef.current = watched;
      setSeriesBulkWatched(watched);
      const clearedOverrides = new Map<number, boolean>();
      refs.seasonBulkOverridesRef.current = clearedOverrides;
      setSeasonBulkOverrides(clearedOverrides);

      if (allKnown.length > 0) {
        updateSnap((prev) => {
          const nextMap = new Map(prev.episodeProgressByKey);
          for (const ep of allKnown) {
            nextMap.set(
              ep.key,
              buildOptimisticEpisodeWatchedRow(nextMap.get(ep.key), watched, {
                sourceId: reqSourceId,
                seriesKey: reqSeriesKey,
                episode: ep,
                fallbackTitle: title,
                logo: posterUri ?? backdropUri,
                profileId: activeProfileId,
              }),
            );
          }
          return { ...prev, episodeProgressByKey: nextMap };
        });
      }

      const rollback = () => {
        if (
          !refs.mountedRef.current ||
          refs.activeSeriesKeyRef.current !== reqSeriesKey ||
          bulkWatchedGenRef.current !== gen
        ) {
          return;
        }
        refs.seriesBulkWatchedRef.current = prevBulk;
        setSeriesBulkWatched(prevBulk);
        refs.seasonBulkOverridesRef.current = prevSeasonOverrides;
        setSeasonBulkOverrides(prevSeasonOverrides);
        if (prevEntries.size > 0) {
          updateSnap((prev) => {
            const nextMap = new Map(prev.episodeProgressByKey);
            for (const [k, prevVal] of prevEntries) {
              if (prevVal === undefined) nextMap.delete(k);
              else nextMap.set(k, prevVal);
            }
            return { ...prev, episodeProgressByKey: nextMap };
          });
        }
      };

      refs.bulkWatchedInFlightRef.current += 1;
      try {
        if (typeof catalog.setSeriesWatched === 'function') {
          const res = await catalog.setSeriesWatched(reqSeriesKey, watched);
          if (!refs.mountedRef.current || refs.activeSeriesKeyRef.current !== reqSeriesKey) {
            return res.ok;
          }
          if (!res.ok) {
            rollback();
            return false;
          }
          return true;
        }
        const okAll = await persistEpisodesFallback(allKnown, watched, reqSeriesKey, reqSourceId);
        if (!okAll) {
          rollback();
          return false;
        }
        return true;
      } catch {
        rollback();
        return false;
      } finally {
        refs.bulkWatchedInFlightRef.current = Math.max(0, refs.bulkWatchedInFlightRef.current - 1);
      }
    },
    [
      activeProfileId,
      backdropUri,
      catalog,
      persistEpisodesFallback,
      posterUri,
      refs,
      setSeasonBulkOverrides,
      setSeriesBulkWatched,
      target.kind,
      title,
      updateSnap,
    ],
  );

  return {
    toggleMyList,
    toggleWatched,
    toggleRating,
    toggleEpisodeWatched,
    markSeasonWatched,
    markSeriesWatched,
  };
}
