import type {
  BrowseKind,
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  MyListNewEpisodeRow,
  SourceRow,
  WatchProgressRow,
} from '@elv/data';
import type { CachedHomeSnapshot, HydratedVodCollection } from '../shared';
import { HOME_LIVE_RAIL_LIMIT } from './home-model';

const HOME_FAVORITES_LIMIT = 250;
const HOME_COLLECTIONS_LIMIT = 20;
const MAX_SOURCES_TO_PROBE = 3;

export const EMPTY_HOME_SNAPSHOT: CachedHomeSnapshot = {
  continueWatching: [],
  newEpisodes: [],
  favorites: [],
  favoriteKeys: new Set<string>(),
  progressByKey: new Map<string, WatchProgressRow>(),
  liveCategory: null,
  liveItems: [],
  recentChannels: [],
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

/** Collects up to `HOME_LIVE_RAIL_LIMIT` unique live channel keys in Favorites -> Recent -> On-Now order. */
export function collectUnifiedLiveKeys(
  favorites: readonly FavoriteRow[],
  recentChannels: readonly ItemRow[],
  liveItems: readonly ItemRow[],
): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  const pushKey = (key: string) => {
    if (keys.length >= HOME_LIVE_RAIL_LIMIT || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  for (const fav of favorites) {
    if (fav.kind === 'live') pushKey(fav.itemKey);
  }
  for (const item of recentChannels) pushKey(item.key);
  for (const item of liveItems) pushKey(item.key);
  return keys;
}

/** Loads up to `HOME_COLLECTIONS_LIMIT` custom VOD collections with their items. */
export async function fetchHydratedCollections(
  catalog: CatalogService,
): Promise<readonly HydratedVodCollection[] | null> {
  if (
    typeof catalog.listCollections !== 'function' ||
    typeof catalog.listCollectionItems !== 'function'
  ) {
    return [];
  }
  try {
    const cols = await catalog.listCollections();
    const bounded = cols.slice(0, HOME_COLLECTIONS_LIMIT);
    return await Promise.all(
      bounded.map(async (collection) => ({
        collection,
        items:
          (await catalog.listCollectionItems?.(collection.id).catch(() => [] as ItemRow[])) ?? [],
      })),
    );
  } catch {
    return null;
  }
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
  newEpisodeInFlight?: ReadonlyMap<string, number>,
): CachedHomeSnapshot {
  let favoriteKeys = fetched.favoriteKeys;
  let favorites = fetched.favorites;
  let progressByKey = fetched.progressByKey;
  let continueWatching = fetched.continueWatching;
  let newEpisodes = fetched.newEpisodes ?? [];

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
    if (!isFav) {
      newEpisodes = newEpisodes.filter((ep) => ep.seriesKey !== key);
    }
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
    if (curProg?.watched === true) {
      newEpisodes = newEpisodes.filter((ep) => ep.episodeKey !== key);
    }
  }

  if (newEpisodeInFlight && newEpisodeInFlight.size > 0) {
    newEpisodes = newEpisodes.filter((row) => (newEpisodeInFlight.get(row.episodeKey) ?? 0) <= 0);
  }

  return { ...fetched, favoriteKeys, favorites, progressByKey, continueWatching, newEpisodes };
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
  const currentNewEpisodes = prev.newEpisodes ?? [];
  const nextNewEpisodes = inList
    ? currentNewEpisodes
    : currentNewEpisodes.filter((ep) => ep.seriesKey !== itemKey);
  return { ...prev, favoriteKeys: nextKeys, favorites: nextFavs, newEpisodes: nextNewEpisodes };
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
  const currentNewEpisodes = prev.newEpisodes ?? [];
  const nextNewEpisodes =
    row?.watched === true
      ? currentNewEpisodes.filter((ep) => ep.episodeKey !== itemKey)
      : currentNewEpisodes;
  return {
    ...prev,
    progressByKey: nextProg,
    continueWatching: nextCw,
    newEpisodes: nextNewEpisodes,
  };
}

/** Optimistically removes an item from Continue Watching and clears its cached progress row. */
export function applyHomeRemoveContinueWatching(
  prev: CachedHomeSnapshot,
  itemKey: string,
): CachedHomeSnapshot {
  const nextProg = new Map(prev.progressByKey);
  nextProg.delete(itemKey);
  const nextCw = prev.continueWatching.filter((r) => r.itemKey !== itemKey);
  return { ...prev, progressByKey: nextProg, continueWatching: nextCw };
}

function compareNewEpisodes(a: MyListNewEpisodeRow, b: MyListNewEpisodeRow): number {
  if (b.detectedAt !== a.detectedAt) return b.detectedAt - a.detectedAt;
  const seasonDiff = (b.season ?? 0) - (a.season ?? 0);
  if (seasonDiff !== 0) return seasonDiff;
  const epDiff = (b.episode ?? 0) - (a.episode ?? 0);
  if (epDiff !== 0) return epDiff;
  return a.episodeKey.localeCompare(b.episodeKey);
}

/** Optimistically removes one newly arrived My List episode from the Home snapshot. */
export function applyHomeRemoveNewEpisode(
  prev: CachedHomeSnapshot,
  episodeKey: string,
): CachedHomeSnapshot {
  const current = prev.newEpisodes ?? [];
  const next = current.filter((row) => row.episodeKey !== episodeKey);
  return { ...prev, newEpisodes: next };
}

/** Restores a rolled-back newly arrived My List episode into its canonical Home sort position. */
export function applyHomeRestoreNewEpisode(
  prev: CachedHomeSnapshot,
  row: MyListNewEpisodeRow | undefined,
): CachedHomeSnapshot {
  if (row === undefined) return prev;
  const current = prev.newEpisodes ?? [];
  if (current.some((entry) => entry.episodeKey === row.episodeKey)) return prev;
  return { ...prev, newEpisodes: [...current, row].sort(compareNewEpisodes) };
}
