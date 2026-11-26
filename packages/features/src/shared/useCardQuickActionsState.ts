import type {
  CatalogService,
  ItemRow,
  RatingValue,
  SetRatingInput,
  ToggleFavoriteInput,
  UserItemKind,
} from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const EMPTY_FAV_SET: ReadonlySet<string> = new Set();
const EMPTY_WATCHED_MAP: ReadonlyMap<string, boolean> = new Map();
const EMPTY_RATING_MAP: ReadonlyMap<string, RatingValue> = new Map();

/** Target payload for {@link useRatingMapState} optimistic Like/Dislike mutations. */
export interface RatingToggleTarget {
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: UserItemKind;
  readonly title: string;
  readonly logo?: string | null;
  readonly year?: number | null;
  readonly rating?: number | null;
}

/** Options for {@link useCardQuickActionsState}. */
export interface UseCardQuickActionsStateOptions {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
}

/** Optimistic favorite, watched & rating mutation controller for poster cards (`#409`). */
export interface CardQuickActionsState {
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly ratingByKey: ReadonlyMap<string, RatingValue>;
  readonly toggleFavorite: (item: ItemRow) => Promise<boolean>;
  readonly toggleWatched: (item: ItemRow, currentWatched: boolean) => Promise<boolean>;
  readonly toggleRating: (item: ItemRow, next: RatingValue) => Promise<boolean>;
}

function releaseCount(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Loads `ratingByKey` via `catalog.listRatingMap?.()` and exposes optimistic generation-tracked
 * `toggleRating` for Movies & Series ONLY (strictly no-ops for Live TV / non-VOD kinds).
 */
export function useRatingMapState(opts: {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly profileKey?: string;
}): {
  readonly ratingByKey: ReadonlyMap<string, RatingValue>;
  readonly toggleRating: (target: RatingToggleTarget, next: RatingValue) => Promise<boolean>;
} {
  const { catalog, refreshToken, userStateVersion = 0, profileKey = '' } = opts;
  const [ratingByKey, setRatingByKey] =
    useState<ReadonlyMap<string, RatingValue>>(EMPTY_RATING_MAP);

  const mountedRef = useRef(true);
  const ratingByKeyRef = useRef(ratingByKey);
  ratingByKeyRef.current = ratingByKey;
  const ratingGenRef = useRef(new Map<string, number>());
  const ratingInFlightRef = useRef(new Map<string, number>());
  const ratingCommittedRef = useRef(new Map<string, RatingValue | null>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, and profileKey trigger fresh rating-map reads
  useEffect(() => {
    let cancelled = false;
    if (!catalog.listRatingMap) return undefined;
    void catalog
      .listRatingMap()
      .then((record) => {
        if (cancelled || !mountedRef.current) return;
        setRatingByKey((prev) => {
          const next = new Map<string, RatingValue>();
          for (const [k, v] of Object.entries(record)) {
            if (v === 'like' || v === 'dislike') next.set(k, v);
          }
          for (const [key, count] of ratingInFlightRef.current) {
            if (count <= 0) continue;
            const optimistic = prev.get(key);
            if (optimistic !== undefined) next.set(key, optimistic);
            else next.delete(key);
          }
          ratingByKeyRef.current = next;
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, profileKey, refreshToken, userStateVersion]);

  const setRatingForKey = useCallback((key: string, value: RatingValue | null) => {
    setRatingByKey((prev) => {
      const current = prev.get(key) ?? null;
      if (current === value) return prev;
      const next = new Map(prev);
      if (value === null) next.delete(key);
      else next.set(key, value);
      ratingByKeyRef.current = next;
      return next;
    });
  }, []);

  const toggleRating = useCallback(
    async (target: RatingToggleTarget, next: RatingValue): Promise<boolean> => {
      if (target.kind !== 'movie' && target.kind !== 'series') return false;
      const key = target.itemKey;
      const gen = (ratingGenRef.current.get(key) ?? 0) + 1;
      ratingGenRef.current.set(key, gen);
      const inFlight = ratingInFlightRef.current.get(key) ?? 0;
      const current = ratingByKeyRef.current.get(key) ?? null;
      if (inFlight === 0) {
        ratingCommittedRef.current.set(key, current);
      }
      ratingInFlightRef.current.set(key, inFlight + 1);

      const nextVal: RatingValue | null = current === next ? null : next;
      setRatingForKey(key, nextVal);

      const input: SetRatingInput = {
        sourceId: target.sourceId,
        itemKey: key,
        kind: target.kind,
        title: target.title,
        logo: target.logo ?? null,
        year: target.year ?? null,
        rating: target.rating ?? null,
      };
      if (!catalog.setRating) {
        ratingCommittedRef.current.set(key, nextVal);
        releaseCount(ratingInFlightRef.current, key);
        return true;
      }

      try {
        const res = await catalog.setRating(input, nextVal);
        if (!mountedRef.current) return Boolean(res.ok);
        if (res.ok) {
          ratingCommittedRef.current.set(key, res.value);
          return true;
        }
        if (ratingGenRef.current.get(key) === gen) {
          setRatingForKey(key, ratingCommittedRef.current.get(key) ?? null);
        }
        return false;
      } catch {
        if (mountedRef.current && ratingGenRef.current.get(key) === gen) {
          setRatingForKey(key, ratingCommittedRef.current.get(key) ?? null);
        }
        return false;
      } finally {
        releaseCount(ratingInFlightRef.current, key);
      }
    },
    [catalog, setRatingForKey],
  );

  return useMemo(() => ({ ratingByKey, toggleRating }), [ratingByKey, toggleRating]);
}

/**
 * Tracks favorite keys and optimistic watched overrides for poster-card hover quick-actions (`#409`),
 * rolling back cleanly if `catalog.setFavorite`/`toggleFavorite` or `catalog.setWatched` rejects
 * or returns an error `Result`.
 */
export function useCardQuickActionsState({
  catalog,
  refreshToken,
  userStateVersion = 0,
}: UseCardQuickActionsStateOptions): CardQuickActionsState {
  const [favoriteKeys, setFavoriteKeys] = useState<ReadonlySet<string>>(EMPTY_FAV_SET);
  const [watchedOverrides, setWatchedOverrides] =
    useState<ReadonlyMap<string, boolean>>(EMPTY_WATCHED_MAP);

  const mountedRef = useRef(true);
  const favKeysRef = useRef(favoriteKeys);
  favKeysRef.current = favoriteKeys;
  const favGenRef = useRef(new Map<string, number>());
  const favInFlightRef = useRef(new Map<string, number>());
  const favCommittedRef = useRef(new Map<string, boolean>());

  const watchedGenRef = useRef(new Map<string, number>());
  const watchedInFlightRef = useRef(new Map<string, number>());
  const watchedCommittedRef = useRef(new Map<string, boolean | undefined>());
  const watchedOverridesRef = useRef(watchedOverrides);
  watchedOverridesRef.current = watchedOverrides;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion trigger fresh favorite reads and clear settled watched overrides
  useEffect(() => {
    let cancelled = false;
    setWatchedOverrides((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map<string, boolean>();
      for (const [k, v] of prev) {
        if ((watchedInFlightRef.current.get(k) ?? 0) > 0) next.set(k, v);
      }
      return next.size === 0 ? EMPTY_WATCHED_MAP : next;
    });

    if (!catalog.listFavoriteKeys) return undefined;
    void catalog
      .listFavoriteKeys()
      .then((keys) => {
        if (cancelled || !mountedRef.current) return;
        setFavoriteKeys((prev) => {
          const next = new Set(keys);
          for (const [key, count] of favInFlightRef.current) {
            if (count <= 0) continue;
            if (prev.has(key)) next.add(key);
            else next.delete(key);
          }
          favKeysRef.current = next;
          return next;
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [catalog, refreshToken, userStateVersion]);

  const setFavForKey = useCallback((key: string, active: boolean) => {
    setFavoriteKeys((prev) => {
      if (prev.has(key) === active) return prev;
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      favKeysRef.current = next;
      return next;
    });
  }, []);

  const setWatchedForKey = useCallback((key: string, value: boolean | undefined) => {
    setWatchedOverrides((prev) => {
      const next = new Map(prev);
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      watchedOverridesRef.current = next;
      return next;
    });
  }, []);

  const toggleFavorite = useCallback(
    async (item: ItemRow): Promise<boolean> => {
      const key = item.key;
      const gen = (favGenRef.current.get(key) ?? 0) + 1;
      favGenRef.current.set(key, gen);
      const inFlight = favInFlightRef.current.get(key) ?? 0;
      const currentlyFav = favKeysRef.current.has(key);
      if (inFlight === 0) {
        favCommittedRef.current.set(key, currentlyFav);
      }
      favInFlightRef.current.set(key, inFlight + 1);

      const nextFav = !currentlyFav;
      setFavForKey(key, nextFav);

      const input: ToggleFavoriteInput = {
        sourceId: item.sourceId,
        itemKey: key,
        kind: item.kind,
        title: item.name,
        logo: item.logo,
        year: item.year,
        rating: item.rating,
      };
      if (!catalog.setFavorite && !catalog.toggleFavorite) {
        favCommittedRef.current.set(key, nextFav);
        releaseCount(favInFlightRef.current, key);
        return true;
      }

      try {
        const res = catalog.setFavorite
          ? await catalog.setFavorite(input, nextFav)
          : await catalog.toggleFavorite?.(input);
        if (!mountedRef.current || !res) return Boolean(res?.ok);
        if (res.ok) {
          favCommittedRef.current.set(key, res.value);
          return true;
        }
        if (favGenRef.current.get(key) === gen) {
          setFavForKey(key, favCommittedRef.current.get(key) ?? false);
        }
        return false;
      } catch {
        if (mountedRef.current && favGenRef.current.get(key) === gen) {
          setFavForKey(key, favCommittedRef.current.get(key) ?? false);
        }
        return false;
      } finally {
        releaseCount(favInFlightRef.current, key);
      }
    },
    [catalog, setFavForKey],
  );

  const toggleWatched = useCallback(
    async (item: ItemRow, currentWatched: boolean): Promise<boolean> => {
      const key = item.key;
      const gen = (watchedGenRef.current.get(key) ?? 0) + 1;
      watchedGenRef.current.set(key, gen);
      const inFlight = watchedInFlightRef.current.get(key) ?? 0;
      if (inFlight === 0) {
        watchedCommittedRef.current.set(key, watchedOverridesRef.current.get(key));
      }
      watchedInFlightRef.current.set(key, inFlight + 1);

      const nextWatched = !currentWatched;
      setWatchedForKey(key, nextWatched);

      if (!catalog.setWatched && !(nextWatched && catalog.saveProgress)) {
        watchedCommittedRef.current.set(key, nextWatched);
        releaseCount(watchedInFlightRef.current, key);
        return true;
      }

      try {
        const res = catalog.setWatched
          ? await catalog.setWatched(key, nextWatched)
          : await catalog.saveProgress?.({
              sourceId: item.sourceId,
              itemKey: key,
              kind: item.kind,
              title: item.name,
              logo: item.logo,
              positionMs: 0,
              durationMs: 0,
              watched: true,
            });
        if (!mountedRef.current || !res) return Boolean(res?.ok);
        if (res.ok) {
          watchedCommittedRef.current.set(key, nextWatched);
          return true;
        }
        if (watchedGenRef.current.get(key) === gen) {
          setWatchedForKey(key, watchedCommittedRef.current.get(key));
        }
        return false;
      } catch {
        if (mountedRef.current && watchedGenRef.current.get(key) === gen) {
          setWatchedForKey(key, watchedCommittedRef.current.get(key));
        }
        return false;
      } finally {
        releaseCount(watchedInFlightRef.current, key);
      }
    },
    [catalog, setWatchedForKey],
  );

  const { ratingByKey, toggleRating: toggleRatingEntry } = useRatingMapState({
    catalog,
    refreshToken,
    userStateVersion,
  });

  const toggleRating = useCallback(
    (item: ItemRow, next: RatingValue): Promise<boolean> =>
      toggleRatingEntry(
        {
          sourceId: item.sourceId,
          itemKey: item.key,
          kind: item.kind,
          title: item.name,
          logo: item.logo,
          year: item.year,
          rating: item.rating,
        },
        next,
      ),
    [toggleRatingEntry],
  );

  return useMemo<CardQuickActionsState>(
    () => ({
      favoriteKeys,
      watchedOverrides,
      ratingByKey,
      toggleFavorite,
      toggleWatched,
      toggleRating,
    }),
    [favoriteKeys, ratingByKey, toggleFavorite, toggleRating, toggleWatched, watchedOverrides],
  );
}
