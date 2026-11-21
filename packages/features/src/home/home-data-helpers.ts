import type {
  BrowseKind,
  CatalogService,
  CategoryRow,
  FavoriteRow,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import type { CachedHomeSnapshot } from '../shared';

const HOME_FAVORITES_LIMIT = 24;
const MAX_SOURCES_TO_PROBE = 3;

export const EMPTY_HOME_SNAPSHOT: CachedHomeSnapshot = {
  continueWatching: [],
  favorites: [],
  favoriteKeys: new Set<string>(),
  progressByKey: new Map<string, WatchProgressRow>(),
  liveCategory: null,
  liveItems: [],
  movies: [],
  series: [],
};

function pickFirstCategory(lists: readonly (readonly CategoryRow[])[]): CategoryRow | null {
  let fallback: CategoryRow | null = null;
  for (const list of lists) {
    for (const cat of list) {
      if (fallback === null) fallback = cat;
      if (cat.itemCount > 0) return cat;
    }
  }
  return fallback;
}

/** Fetches the first populated category for `kind` across up to 3 active sources. */
export async function fetchHomeKindCategory(
  catalog: CatalogService,
  sources: readonly SourceRow[],
  kind: BrowseKind,
): Promise<CategoryRow | null> {
  const lists = await Promise.all(
    sources
      .slice(0, MAX_SOURCES_TO_PROBE)
      .map((source) => catalog.categories(source.id, kind).catch(() => [] as CategoryRow[])),
  );
  return pickFirstCategory(lists);
}

/** Decrements an in-flight counter map entry, deleting the key once it reaches zero. */
export function releaseInFlightKey(map: Map<string, number>, key: string): void {
  const rem = Math.max(0, (map.get(key) ?? 1) - 1);
  if (rem === 0) map.delete(key);
  else map.set(key, rem);
}

/**
 * Merges a freshly fetched Home snapshot with any currently in-flight optimistic My List or
 * Watched mutations so background revalidation never clobbers pending user toggles (`#230`).
 */
export function mergeOptimisticHomeSnapshot(
  fetched: CachedHomeSnapshot,
  current: CachedHomeSnapshot,
  favInFlight: ReadonlyMap<string, number>,
  watchedInFlight: ReadonlyMap<string, number>,
): CachedHomeSnapshot {
  let favoriteKeys = fetched.favoriteKeys;
  let favorites = fetched.favorites;
  let progressByKey = fetched.progressByKey;
  let continueWatching = fetched.continueWatching;

  for (const [key, count] of favInFlight) {
    if (count <= 0) continue;
    const isFav = current.favoriteKeys.has(key);
    const nextKeys = new Set(favoriteKeys);
    if (isFav) nextKeys.add(key);
    else nextKeys.delete(key);
    favoriteKeys = nextKeys;
    const filtered = favorites.filter((f) => f.itemKey !== key);
    const curRow = current.favorites.find((f) => f.itemKey === key);
    favorites =
      isFav && curRow !== undefined
        ? [curRow, ...filtered].slice(0, HOME_FAVORITES_LIMIT)
        : filtered;
  }

  for (const [key, count] of watchedInFlight) {
    if (count <= 0) continue;
    const nextProg = new Map(progressByKey);
    const curProg = current.progressByKey.get(key);
    if (curProg !== undefined) nextProg.set(key, curProg);
    else nextProg.delete(key);
    progressByKey = nextProg;
    const filteredCw = continueWatching.filter((r) => r.itemKey !== key);
    const curCw = current.continueWatching.find((r) => r.itemKey === key);
    continueWatching =
      curCw !== undefined
        ? [curCw, ...filteredCw].sort((a, b) => b.updatedAt - a.updatedAt)
        : filteredCw;
  }

  return { ...fetched, favoriteKeys, favorites, progressByKey, continueWatching };
}

/** Applies an optimistic My List update to a {@link CachedHomeSnapshot}. */
export function applyHomeFavUpdate(
  prev: CachedHomeSnapshot,
  itemKey: string,
  inList: boolean,
  row: FavoriteRow | undefined,
): CachedHomeSnapshot {
  const nextKeys = new Set(prev.favoriteKeys);
  if (inList) nextKeys.add(itemKey);
  else nextKeys.delete(itemKey);
  const filtered = prev.favorites.filter((f) => f.itemKey !== itemKey);
  const nextFavs =
    inList && row !== undefined ? [row, ...filtered].slice(0, HOME_FAVORITES_LIMIT) : filtered;
  return { ...prev, favoriteKeys: nextKeys, favorites: nextFavs };
}

/** Applies an optimistic Watched update to a {@link CachedHomeSnapshot}. */
export function applyHomeWatchedUpdate(
  prev: CachedHomeSnapshot,
  itemKey: string,
  row: WatchProgressRow | undefined,
  restoreCw: WatchProgressRow | undefined,
): CachedHomeSnapshot {
  const nextProg = new Map(prev.progressByKey);
  if (row !== undefined) nextProg.set(itemKey, row);
  else nextProg.delete(itemKey);
  const filtered = prev.continueWatching.filter((r) => r.itemKey !== itemKey);
  const nextCw =
    restoreCw !== undefined
      ? [restoreCw, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt)
      : filtered;
  return { ...prev, progressByKey: nextProg, continueWatching: nextCw };
}
