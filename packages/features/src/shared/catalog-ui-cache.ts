import type { ElvItemEnrichment, ItemRow, NowNextEntry } from '@elv/data';
import type {
  BoundedTtlMap,
  CachedCatalogKindState,
  CachedDetailEntry,
  CachedEpgProgramEntry,
  CachedHomeEntry,
  CachedLiveState,
  CachedSearchSnapshot,
  CatalogUiCache,
  CatalogUiCacheMetrics,
  CatalogUiCacheOptions,
  ElvEnrichmentCacheSnapshot,
} from './catalog-ui-cache-types';

export type {
  CachedDetailEntry,
  CachedDetailSeasonsState,
  CachedDetailSnapshot,
  CachedEpgProgramEntry,
  CachedHomeSnapshot,
  CatalogUiCache,
  CatalogUiCacheOptions,
  ElvEnrichmentCacheSnapshot,
} from './catalog-ui-cache-types';

/** Max category rails retained per Movies/Series discovery slice (safe for 1 GB TV sticks). */
export const MAX_CATALOG_RAIL_CATEGORIES = 16;
/** Max preview items retained per category rail. */
export const MAX_CATALOG_RAIL_ITEMS = 18;
/** Max category grid first pages retained per kind via LRU. */
export const MAX_GRID_FIRST_PAGES = 12;
/** Max live categories with cached initial channel slices via LRU. */
export const MAX_LIVE_CHANNEL_CATEGORIES = 8;
/** Max channel rows retained per cached live category slice. */
export const LIVE_CHANNEL_ROWS_CAP = 120;
/** Max Detail screen entries retained in the bounded LRU cache. */
export const MAX_DETAIL_ENTRIES = 32;
/** Max ELV enrichment entries (matched or settled-unmatched) retained via LRU (`#511`). */
export const MAX_ELV_ENRICHMENT_ENTRIES = 1_500;
const CACHE_EPG_MAX_ENTRIES = 240;
const CACHE_NOW_NEXT_TTL_MS = 90_000;

function createBoundedLru<V>(maxEntries: number) {
  const cap = Math.max(1, Math.floor(maxEntries));
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const hit = map.get(key);
      if (hit === undefined) return undefined;
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    set(key: string, value: V): void {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    deleteWhere(predicate: (key: string, value: V) => boolean): void {
      for (const [key, value] of [...map.entries()]) {
        if (predicate(key, value)) map.delete(key);
      }
    },
    clear(): void {
      map.clear();
    },
  };
}

function createBoundedTtlMap<T>(
  maxEntries: number,
  ttlMs: number,
  onLookup?: (hit: boolean) => void,
): BoundedTtlMap<T> {
  const cap = Math.max(1, Math.floor(maxEntries));
  const ttl = Math.max(1, Math.floor(ttlMs));
  const map = new Map<string, { value: T; storedAt: number }>();

  return {
    get(key, nowMs) {
      const hit = map.get(key);
      if (hit === undefined) {
        onLookup?.(false);
        return undefined;
      }
      if (nowMs - hit.storedAt > ttl) {
        map.delete(key);
        onLookup?.(false);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit);
      onLookup?.(true);
      return hit.value;
    },
    set(key, value, nowMs) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, storedAt: nowMs });
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    deleteWhere(predicate) {
      for (const key of [...map.keys()]) {
        if (predicate(key)) map.delete(key);
      }
    },
    snapshot(nowMs) {
      const out = new Map<string, T>();
      for (const [key, entry] of [...map.entries()]) {
        if (nowMs - entry.storedAt > ttl) {
          map.delete(key);
        } else {
          out.set(key, entry.value);
        }
      }
      return out;
    },
    clear() {
      map.clear();
    },
    size: () => map.size,
  };
}

function itemKeyBelongsToSource(itemKey: string, sourceId: string): boolean {
  return itemKey.split(':')[1] === sourceId;
}

function capCatalogRails(
  rails: ReadonlyMap<string, readonly ItemRow[]>,
): ReadonlyMap<string, readonly ItemRow[]> {
  const out = new Map<string, readonly ItemRow[]>();
  for (const [catId, rows] of rails) {
    if (out.size >= MAX_CATALOG_RAIL_CATEGORIES) break;
    out.set(
      catId,
      rows.length > MAX_CATALOG_RAIL_ITEMS ? rows.slice(0, MAX_CATALOG_RAIL_ITEMS) : rows,
    );
  }
  return out;
}

/** Creates a scoped {@link CatalogUiCache} instance (one per `AppShell` catalog instance). */
export function createCatalogUiCache(opts: CatalogUiCacheOptions = {}): CatalogUiCache {
  let revision = opts.revision ?? 0;
  let locale = opts.locale ?? 'en';
  let profileKey = opts.profileKey ?? 'default:0';
  let elvKey = opts.elvKey ?? 'elv:0';
  let hits = 0;
  let misses = 0;
  const recordLookup = (hit: boolean): void => {
    if (hit) hits += 1;
    else misses += 1;
  };

  let home: CachedHomeEntry | null = null;
  const catalogByKind: Record<'movie' | 'series', CachedCatalogKindState | null> = {
    movie: null,
    series: null,
  };
  const gridFirstPages = {
    movie: createBoundedLru<readonly ItemRow[]>(MAX_GRID_FIRST_PAGES),
    series: createBoundedLru<readonly ItemRow[]>(MAX_GRID_FIRST_PAGES),
  };

  let live: CachedLiveState | null = null;
  const liveFirstChannels = createBoundedLru<readonly ItemRow[]>(MAX_LIVE_CHANNEL_CATEGORIES);
  const nowNext = createBoundedTtlMap<NowNextEntry>(
    CACHE_EPG_MAX_ENTRIES,
    CACHE_NOW_NEXT_TTL_MS,
    recordLookup,
  );
  const epgWindow = createBoundedTtlMap<CachedEpgProgramEntry>(
    CACHE_EPG_MAX_ENTRIES,
    Number.MAX_SAFE_INTEGER,
    recordLookup,
  );

  const detailByItemKey = createBoundedLru<CachedDetailEntry>(MAX_DETAIL_ENTRIES);
  const elvEnrichment = createBoundedLru<ElvItemEnrichment | null>(MAX_ELV_ENRICHMENT_ENTRIES);
  let search: CachedSearchSnapshot | null = null;

  function clearAll(preserveElvEnrichment = false): void {
    home = null;
    catalogByKind.movie = null;
    catalogByKind.series = null;
    gridFirstPages.movie.clear();
    gridFirstPages.series.clear();
    live = null;
    liveFirstChannels.clear();
    nowNext.clear();
    epgWindow.clear();
    detailByItemKey.clear();
    if (!preserveElvEnrichment) {
      elvEnrichment.clear();
    }
    search = null;
  }

  return {
    getRevision: () => revision,
    getLocale: () => locale,
    getProfileKey: () => profileKey,
    getElvKey: () => elvKey,
    getMetrics(): CatalogUiCacheMetrics {
      const total = hits + misses;
      return {
        hits,
        misses,
        hitRatePct: total > 0 ? Math.round((hits / total) * 100) : null,
      };
    },

    setRevision(nextRevision, nextLocale, nextProfileKey, nextElvKey) {
      const resolvedProfileKey = nextProfileKey ?? profileKey;
      const resolvedElvKey = nextElvKey ?? elvKey;
      if (
        nextRevision === revision &&
        nextLocale === locale &&
        resolvedProfileKey === profileKey &&
        resolvedElvKey === elvKey
      ) {
        return;
      }
      const localeChanged = nextLocale !== locale;
      revision = nextRevision;
      locale = nextLocale;
      profileKey = resolvedProfileKey;
      elvKey = resolvedElvKey;
      clearAll(!localeChanged);
    },

    getHome: () => {
      recordLookup(home !== null);
      return home;
    },
    setHome(snapshot) {
      home = { snapshot, heroIndex: home?.heroIndex ?? 0 };
    },
    clearHome() {
      home = null;
    },
    setHomeHeroIndex(heroIndex) {
      if (home === null) return;
      home = { snapshot: home.snapshot, heroIndex };
    },

    getCatalog: (kind, opts) => {
      const hit = catalogByKind[kind];
      const wantGrouped = kind === 'movie' && opts?.groupVersions === true;
      const valid = hit !== null && (hit.groupVersions === true) === wantGrouped ? hit : null;
      recordLookup(valid !== null);
      return valid;
    },
    setCatalog(kind, state) {
      catalogByKind[kind] = {
        categories: state.categories,
        continueItems: state.continueItems,
        railItemsByCategoryId: capCatalogRails(state.railItemsByCategoryId),
        progressByKey: state.progressByKey,
        ...(kind === 'movie' && state.groupVersions === true ? { groupVersions: true } : {}),
      };
    },

    getGridFirstPage: (kind, categoryId, opts) => {
      const key =
        kind === 'movie' && opts?.groupVersions === true ? `${categoryId}|gv` : categoryId;
      const hit = gridFirstPages[kind].get(key);
      recordLookup(hit !== undefined);
      return hit;
    },
    setGridFirstPage(kind, categoryId, rows, opts) {
      const key =
        kind === 'movie' && opts?.groupVersions === true ? `${categoryId}|gv` : categoryId;
      gridFirstPages[kind].set(key, rows);
    },

    getLive: () => {
      recordLookup(live !== null);
      return live;
    },
    setLiveCategories(categories) {
      live = {
        categories,
        favoriteKeys: live?.favoriteKeys ?? new Set(),
        favoriteChannels: live?.favoriteChannels ?? [],
        hasLoadedCategories: true,
        hasLoadedFavorites: live?.hasLoadedFavorites ?? false,
      };
    },
    setLiveFavorites(favoriteKeys, favoriteChannels) {
      live = {
        categories: live?.categories ?? [],
        favoriteKeys,
        favoriteChannels,
        hasLoadedCategories: live?.hasLoadedCategories ?? false,
        hasLoadedFavorites: true,
      };
    },

    getLiveFirstChannels: (categoryId) => {
      const hit = liveFirstChannels.get(categoryId);
      recordLookup(hit !== undefined);
      return hit;
    },
    setLiveFirstChannels(categoryId, rows) {
      const capped =
        rows.length > LIVE_CHANNEL_ROWS_CAP ? rows.slice(0, LIVE_CHANNEL_ROWS_CAP) : rows;
      liveFirstChannels.set(categoryId, capped);
    },

    nowNext,
    getNowNextSnapshot: (nowMs) => nowNext.snapshot(nowMs),
    epgWindow,

    getDetail: (itemKey) => {
      const hit = detailByItemKey.get(itemKey) ?? null;
      recordLookup(hit !== null);
      return hit;
    },
    setDetail(itemKey, entry) {
      detailByItemKey.set(itemKey, entry);
    },

    getSearch(query, scope) {
      if (search === null) {
        recordLookup(false);
        return null;
      }
      if (search.catalogRevision !== revision || search.query !== query || search.scope !== scope) {
        recordLookup(false);
        return null;
      }
      recordLookup(true);
      return search;
    },
    setSearch(snapshot) {
      search = snapshot;
    },
    clearSearch() {
      search = null;
    },

    getElvEnrichmentSnapshot(keys): ElvEnrichmentCacheSnapshot {
      const enrichmentByKey = new Map<string, ElvItemEnrichment>();
      const resolvedKeys = new Set<string>();
      for (const key of keys) {
        if (key === '') continue;
        const hit = elvEnrichment.get(key);
        if (hit !== undefined) {
          resolvedKeys.add(key);
          if (hit !== null) {
            enrichmentByKey.set(key, hit);
          }
        }
      }
      return { enrichmentByKey, resolvedKeys };
    },
    setElvEnrichmentBatch(entries, resolvedKeys) {
      if (resolvedKeys !== undefined) {
        for (const key of resolvedKeys) {
          if (key === '') continue;
          elvEnrichment.set(key, entries.get(key) ?? null);
        }
      }
      for (const [key, value] of entries) {
        if (key !== '') {
          elvEnrichment.set(key, value);
        }
      }
    },

    invalidateSource(sourceId) {
      const catPrefix = `${sourceId}|`;
      home = null;
      for (const kind of ['movie', 'series'] as const) {
        const cur = catalogByKind[kind];
        if (cur !== null) {
          const nextRails = new Map<string, readonly ItemRow[]>();
          for (const [catId, rows] of cur.railItemsByCategoryId) {
            if (!catId.startsWith(catPrefix)) nextRails.set(catId, rows);
          }
          catalogByKind[kind] = {
            categories: cur.categories.filter((c) => c.row.sourceId !== sourceId),
            continueItems: cur.continueItems.filter((r) => r.sourceId !== sourceId),
            railItemsByCategoryId: nextRails,
            progressByKey: cur.progressByKey,
            ...(cur.groupVersions === true ? { groupVersions: true } : {}),
          };
        }
        gridFirstPages[kind].deleteWhere((catId) => catId.startsWith(catPrefix));
      }
      if (live !== null) {
        const nextFavKeys = new Set<string>();
        for (const key of live.favoriteKeys) {
          if (!itemKeyBelongsToSource(key, sourceId)) nextFavKeys.add(key);
        }
        live = {
          ...live,
          categories: live.categories.filter((c) => c.row.sourceId !== sourceId),
          favoriteKeys: nextFavKeys,
          favoriteChannels: live.favoriteChannels.filter((c) => c.sourceId !== sourceId),
        };
      }
      liveFirstChannels.deleteWhere((catId) => catId.startsWith(catPrefix));
      nowNext.deleteWhere((key) => itemKeyBelongsToSource(key, sourceId));
      epgWindow.deleteWhere((cacheKey) => {
        const chKey = cacheKey.split('|')[0] ?? '';
        return itemKeyBelongsToSource(chKey, sourceId);
      });
      detailByItemKey.deleteWhere(
        (key, entry) => entry.sourceId === sourceId || itemKeyBelongsToSource(key, sourceId),
      );
      elvEnrichment.deleteWhere(
        (key, entry) =>
          (entry !== null && entry.sourceId === sourceId) || itemKeyBelongsToSource(key, sourceId),
      );
      search = null;
    },

    clear: () => clearAll(false),
  };
}
