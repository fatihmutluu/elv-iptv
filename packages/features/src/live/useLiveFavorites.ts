import type { CatalogService, FavoriteRow, ItemRow, SourceRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PagedListSource, useCatalogUiCache } from '../shared';
import { moveFavoriteItem } from './live-favorite-reorder';
import { createStaticPagedListSource } from './live-model';

const MAX_LIVE_FAVORITES = 200;

/** Live favorite channels state returned by {@link useLiveFavorites}. */
export interface LiveFavoritesState {
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoriteChannels: readonly ItemRow[];
  readonly favoriteSource: PagedListSource<ItemRow>;
  readonly favoritesVersion: number;
  readonly toggleFavorite: (channel: ItemRow) => Promise<void>;
  readonly reorderFavorite: (fromIndex: number, toIndex: number) => Promise<void>;
}

function fallbackItemFromFavorite(fav: FavoriteRow, idx: number): ItemRow {
  return {
    id: idx + 1,
    key: fav.itemKey,
    kind: 'live',
    sourceId: fav.sourceId,
    providerId: fav.itemKey,
    name: fav.title,
    logo: fav.logo,
    rating: fav.rating,
    year: fav.year,
    num: null,
  };
}

/**
 * Loads favorited live channels from `catalog` (`listFavoriteKeys` + `listFavorites` + `itemDetail`),
 * hydrates synchronously from `CatalogUiCache`, builds a synchronous `PagedListSource<ItemRow>` for
 * `LiveZapDrawer`, and handles committed-baseline optimistic 1-click favorite toggling (`#230`).
 */
export function useLiveFavorites(opts: {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly onFavoritesMutated?: () => void;
}): LiveFavoritesState {
  const { catalog, sources, refreshToken, userStateVersion = 0, onFavoritesMutated } = opts;
  const uiCache = useCatalogUiCache();
  const uiCacheRef = useRef(uiCache);
  uiCacheRef.current = uiCache;
  const onFavoritesMutatedRef = useRef(onFavoritesMutated);
  onFavoritesMutatedRef.current = onFavoritesMutated;
  const initialLive = sources.length > 0 ? (uiCache?.getLive() ?? null) : null;

  const [favoriteKeys, setFavoriteKeys] = useState<ReadonlySet<string>>(
    () => initialLive?.favoriteKeys ?? new Set(),
  );
  const [favoriteChannels, setFavoriteChannels] = useState<readonly ItemRow[]>(
    () => initialLive?.favoriteChannels ?? [],
  );
  const [favoritesVersion, setFavoritesVersion] = useState(0);

  const aliveRef = useRef(true);
  const favKeysRef = useRef(favoriteKeys);
  favKeysRef.current = favoriteKeys;
  const favChannelsRef = useRef(favoriteChannels);
  favChannelsRef.current = favoriteChannels;
  const toggleGenByKeyRef = useRef(new Map<string, number>());
  const inFlightByKeyRef = useRef(new Map<string, number>());
  const committedFavByKeyRef = useRef(new Map<string, boolean>());
  const reorderGenRef = useRef(0);
  const reorderInFlightRef = useRef(0);
  const committedOrderRef = useRef<readonly ItemRow[] | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken and userStateVersion reload favorites
  useEffect(() => {
    let active = true;
    if (sources.length === 0) {
      setFavoriteKeys(new Set());
      setFavoriteChannels([]);
      setFavoritesVersion((v) => v + 1);
      return undefined;
    }

    const readyIds = new Set(sources.map((s) => s.id));
    const keysPromise: Promise<readonly string[] | null> = catalog.listFavoriteKeys
      ? catalog.listFavoriteKeys().catch(() => null)
      : Promise.resolve([]);
    const rowsPromise: Promise<readonly FavoriteRow[] | null> = catalog.listFavorites
      ? catalog.listFavorites(MAX_LIVE_FAVORITES).catch(() => null)
      : Promise.resolve([]);

    void Promise.all([keysPromise, rowsPromise]).then(async ([rawKeys, rawRows]) => {
      if (!active) return;
      if (rawKeys === null && rawRows === null) return;

      let nextChannels: ItemRow[];
      if (rawRows === null) {
        nextChannels = [...favChannelsRef.current];
      } else {
        const liveRows = rawRows.filter((r) => r.kind === 'live' && readyIds.has(r.sourceId));
        const resolved = await Promise.all(
          liveRows.map(async (fav, idx): Promise<ItemRow | null> => {
            if (!catalog.itemDetail) return fallbackItemFromFavorite(fav, idx);
            const detail = await catalog.itemDetail(fav.itemKey).catch(() => null);
            return detail && detail.kind === 'live' ? detail : null;
          }),
        );
        if (!active) return;
        nextChannels = [];
        const seen = new Set<string>();
        for (const ch of resolved) {
          if (ch && !seen.has(ch.key)) {
            seen.add(ch.key);
            nextChannels.push(ch);
          }
        }
      }

      const seen = new Set(nextChannels.map((ch) => ch.key));
      const nextKeys = new Set<string>(rawKeys ?? favKeysRef.current);
      for (const ch of nextChannels) nextKeys.add(ch.key);

      // Preserve any in-flight optimistic toggles so background refresh never clobbers them.
      for (const [key, count] of inFlightByKeyRef.current) {
        if (count <= 0) continue;
        const optFav = favKeysRef.current.has(key);
        if (optFav) {
          nextKeys.add(key);
          if (!seen.has(key)) {
            const cur = favChannelsRef.current.find((c) => c.key === key);
            if (cur) nextChannels.unshift(cur);
          }
        } else {
          nextKeys.delete(key);
          const idx = nextChannels.findIndex((c) => c.key === key);
          if (idx >= 0) nextChannels.splice(idx, 1);
        }
      }

      const resolvedChannels =
        reorderInFlightRef.current > 0 ? favChannelsRef.current : nextChannels;
      uiCacheRef.current?.setLiveFavorites(nextKeys, resolvedChannels);
      setFavoriteKeys(nextKeys);
      if (rawRows !== null && reorderInFlightRef.current === 0) {
        setFavoriteChannels(nextChannels);
      }
      setFavoritesVersion((v) => v + 1);
    });

    return () => {
      active = false;
    };
  }, [catalog, refreshToken, sources, userStateVersion]);

  const toggleFavorite = useCallback(
    async (channel: ItemRow): Promise<void> => {
      const key = channel.key;
      const gen = (toggleGenByKeyRef.current.get(key) ?? 0) + 1;
      toggleGenByKeyRef.current.set(key, gen);

      const activeInFlight = inFlightByKeyRef.current.get(key) ?? 0;
      const wasFav = favKeysRef.current.has(key);
      if (activeInFlight === 0) {
        committedFavByKeyRef.current.set(key, wasFav);
      }
      inFlightByKeyRef.current.set(key, activeInFlight + 1);

      const nextActive = !wasFav;
      const applyState = (shouldBeFav: boolean) => {
        const nextKeys = new Set(favKeysRef.current);
        if (shouldBeFav) nextKeys.add(key);
        else nextKeys.delete(key);
        const nextChannels = shouldBeFav
          ? [channel, ...favChannelsRef.current.filter((c) => c.key !== key)]
          : favChannelsRef.current.filter((c) => c.key !== key);
        favKeysRef.current = nextKeys;
        favChannelsRef.current = nextChannels;
        uiCacheRef.current?.setLiveFavorites(nextKeys, nextChannels);
        setFavoriteKeys(nextKeys);
        setFavoriteChannels(nextChannels);
        setFavoritesVersion((v) => v + 1);
      };

      applyState(nextActive);

      const favInput = {
        itemKey: channel.key,
        sourceId: channel.sourceId,
        kind: 'live' as const,
        title: channel.name,
        logo: channel.logo ?? null,
      };
      if (!catalog.setFavorite && !catalog.toggleFavorite) {
        committedFavByKeyRef.current.set(key, nextActive);
        const rem = Math.max(0, (inFlightByKeyRef.current.get(key) ?? 1) - 1);
        if (rem === 0) inFlightByKeyRef.current.delete(key);
        else inFlightByKeyRef.current.set(key, rem);
        return;
      }
      try {
        const res = catalog.setFavorite
          ? await catalog.setFavorite(favInput, nextActive)
          : await catalog.toggleFavorite?.(favInput);
        if (!aliveRef.current || !res) return;
        if (res.ok) {
          committedFavByKeyRef.current.set(key, res.value);
          if (toggleGenByKeyRef.current.get(key) === gen && res.value !== nextActive) {
            applyState(res.value);
          }
          onFavoritesMutatedRef.current?.();
        } else if (toggleGenByKeyRef.current.get(key) === gen) {
          applyState(committedFavByKeyRef.current.get(key) ?? false);
        }
      } catch {
        if (aliveRef.current && toggleGenByKeyRef.current.get(key) === gen) {
          applyState(committedFavByKeyRef.current.get(key) ?? false);
        }
      } finally {
        const rem = Math.max(0, (inFlightByKeyRef.current.get(key) ?? 1) - 1);
        if (rem === 0) inFlightByKeyRef.current.delete(key);
        else inFlightByKeyRef.current.set(key, rem);
      }
    },
    [catalog],
  );

  const reorderFavorite = useCallback(
    async (fromIndex: number, toIndex: number): Promise<void> => {
      const prevChannels = favChannelsRef.current;
      const nextChannels = moveFavoriteItem(prevChannels, fromIndex, toIndex);
      if (nextChannels === prevChannels) return;

      const gen = reorderGenRef.current + 1;
      reorderGenRef.current = gen;
      if (reorderInFlightRef.current === 0) {
        committedOrderRef.current = prevChannels;
      }
      reorderInFlightRef.current += 1;

      const applyChannels = (channels: readonly ItemRow[]) => {
        const nextKeys = new Set(favKeysRef.current);
        for (const ch of channels) nextKeys.add(ch.key);
        favKeysRef.current = nextKeys;
        favChannelsRef.current = channels;
        uiCacheRef.current?.setLiveFavorites(nextKeys, channels);
        setFavoriteKeys(nextKeys);
        setFavoriteChannels(channels);
        setFavoritesVersion((v) => v + 1);
      };

      applyChannels(nextChannels);

      if (!catalog.reorderFavorites) {
        committedOrderRef.current = nextChannels;
        onFavoritesMutatedRef.current?.();
        reorderInFlightRef.current = Math.max(0, reorderInFlightRef.current - 1);
        return;
      }

      try {
        const res = await catalog.reorderFavorites(nextChannels.map((c) => c.key));
        if (!aliveRef.current) return;
        if (res.ok) {
          committedOrderRef.current = nextChannels;
          onFavoritesMutatedRef.current?.();
        } else if (reorderGenRef.current === gen && committedOrderRef.current !== null) {
          applyChannels(committedOrderRef.current);
        }
      } catch {
        if (
          aliveRef.current &&
          reorderGenRef.current === gen &&
          committedOrderRef.current !== null
        ) {
          applyChannels(committedOrderRef.current);
        }
      } finally {
        reorderInFlightRef.current = Math.max(0, reorderInFlightRef.current - 1);
      }
    },
    [catalog],
  );

  const favoriteSource = useMemo(
    () => createStaticPagedListSource(favoriteChannels),
    [favoriteChannels],
  );

  return useMemo<LiveFavoritesState>(
    () => ({
      favoriteKeys,
      favoriteChannels,
      favoriteSource,
      favoritesVersion,
      toggleFavorite,
      reorderFavorite,
    }),
    [
      favoriteChannels,
      favoriteKeys,
      favoriteSource,
      favoritesVersion,
      reorderFavorite,
      toggleFavorite,
    ],
  );
}
