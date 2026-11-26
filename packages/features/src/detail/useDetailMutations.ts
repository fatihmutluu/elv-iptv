import type { CatalogService, RatingValue, WatchProgressRow } from '@elv/data';
import { type MutableRefObject, useCallback } from 'react';
import { type DetailTarget, useProfile } from '../shared';
import { buildOptimisticWatchedRow, type DetailSnapshot } from './detail-data-helpers';

/** Shared mutable refs coordinating optimistic Detail mutations with background hydration. */
export interface DetailMutationRefs {
  readonly mountedRef: MutableRefObject<boolean>;
  readonly snapRef: MutableRefObject<DetailSnapshot>;
  readonly activeItemKeyRef: MutableRefObject<string>;
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
}

/**
 * Optimistic generation-tracked `toggleMyList`, `toggleWatched`, and `toggleRating` actions for
 * {@link useDetailData}. Tracks the last committed baseline so even-count rapid toggles whose
 * writes fail roll back to persisted truth instead of an unpersisted intermediate state (`#230`).
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
}): {
  readonly toggleMyList: () => Promise<void>;
  readonly toggleWatched: () => Promise<void>;
  readonly toggleRating: (next: RatingValue) => Promise<void>;
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
  } = opts;
  const { activeProfileId } = useProfile();

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

  return { toggleMyList, toggleWatched, toggleRating };
}
