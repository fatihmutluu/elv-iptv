import type { CatalogService, ItemRow, ToggleFavoriteInput } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const EMPTY_FAV_SET: ReadonlySet<string> = new Set();
const EMPTY_WATCHED_MAP: ReadonlyMap<string, boolean> = new Map();

/** Options for {@link useCardQuickActionsState}. */
export interface UseCardQuickActionsStateOptions {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion?: number;
}

/** Optimistic favorite & watched mutation controller for poster card quick-actions (`#409`). */
export interface CardQuickActionsState {
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly toggleFavorite: (item: ItemRow) => Promise<void>;
  readonly toggleWatched: (item: ItemRow, currentWatched: boolean) => Promise<void>;
}

function releaseCount(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
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
    async (item: ItemRow): Promise<void> => {
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
        return;
      }

      try {
        const res = catalog.setFavorite
          ? await catalog.setFavorite(input, nextFav)
          : await catalog.toggleFavorite?.(input);
        if (!mountedRef.current || !res) return;
        if (res.ok) {
          favCommittedRef.current.set(key, res.value);
        } else if (favGenRef.current.get(key) === gen) {
          setFavForKey(key, favCommittedRef.current.get(key) ?? false);
        }
      } catch {
        if (mountedRef.current && favGenRef.current.get(key) === gen) {
          setFavForKey(key, favCommittedRef.current.get(key) ?? false);
        }
      } finally {
        releaseCount(favInFlightRef.current, key);
      }
    },
    [catalog, setFavForKey],
  );

  const toggleWatched = useCallback(
    async (item: ItemRow, currentWatched: boolean): Promise<void> => {
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
        return;
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
        if (!mountedRef.current || !res) return;
        if (res.ok) {
          watchedCommittedRef.current.set(key, nextWatched);
        } else if (watchedGenRef.current.get(key) === gen) {
          setWatchedForKey(key, watchedCommittedRef.current.get(key));
        }
      } catch {
        if (mountedRef.current && watchedGenRef.current.get(key) === gen) {
          setWatchedForKey(key, watchedCommittedRef.current.get(key));
        }
      } finally {
        releaseCount(watchedInFlightRef.current, key);
      }
    },
    [catalog, setWatchedForKey],
  );

  return useMemo<CardQuickActionsState>(
    () => ({ favoriteKeys, watchedOverrides, toggleFavorite, toggleWatched }),
    [favoriteKeys, toggleFavorite, toggleWatched, watchedOverrides],
  );
}
