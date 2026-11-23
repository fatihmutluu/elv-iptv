import type {
  CategoryRow,
  EpisodeRow,
  FavoriteRow,
  ItemDetailRow,
  ItemRow,
  NowNextEntry,
  ProgrammeRow,
  SearchResults,
  SearchScope,
  SeasonRow,
  WatchProgressRow,
} from '@elv/data';
import type { ElvError } from '@elv/domain';
import type { DisplayCategory } from './catalog-helpers';

/** Bounded Home snapshot stored in {@link CatalogUiCache}. */
export interface CachedHomeSnapshot {
  readonly continueWatching: readonly WatchProgressRow[];
  readonly favorites: readonly FavoriteRow[];
  readonly favoriteKeys: ReadonlySet<string>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly liveCategory: CategoryRow | null;
  readonly liveItems: readonly ItemRow[];
  readonly recentChannels?: readonly ItemRow[];
  readonly movies: readonly ItemRow[];
  readonly series: readonly ItemRow[];
}

/** Cached Home entry combining the bounded snapshot and active hero carousel index. */
export interface CachedHomeEntry {
  readonly snapshot: CachedHomeSnapshot;
  readonly heroIndex: number;
}

/** Cached Movies or Series discovery slice stored in {@link CatalogUiCache}. */
export interface CachedCatalogKindState {
  readonly categories: readonly DisplayCategory[];
  readonly continueItems: readonly WatchProgressRow[];
  readonly railItemsByCategoryId: ReadonlyMap<string, readonly ItemRow[]>;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
  /** Whether this cached movie discovery slice was fetched with `groupVersions: true` (`#404`). */
  readonly groupVersions?: boolean;
}

/** Cached Live TV categories and favorites state stored in {@link CatalogUiCache}. */
export interface CachedLiveState {
  readonly categories: readonly DisplayCategory[];
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoriteChannels: readonly ItemRow[];
  readonly hasLoadedCategories: boolean;
  readonly hasLoadedFavorites: boolean;
}

/** Cached EPG channel-window programme slice with timestamp for stale-while-revalidate checks. */
export interface CachedEpgProgramEntry {
  readonly rows: readonly ProgrammeRow[];
  readonly storedAt: number;
}

/** Loading / error / ready state for a series's season list. */
export type CachedDetailSeasonsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ElvError }
  | { readonly kind: 'ready'; readonly seasons: readonly SeasonRow[] };

/** Atomic hydrated state snapshot for a movie or series Detail screen. */
export interface CachedDetailSnapshot {
  readonly detailRow: ItemDetailRow | null;
  readonly inMyList: boolean;
  readonly movieProgress: WatchProgressRow | null;
  readonly seasonsState: CachedDetailSeasonsState;
  readonly selectedSeason: number | null;
  readonly episodes: readonly EpisodeRow[];
  readonly episodesLoading: boolean;
  readonly episodesRefreshing: boolean;
  readonly episodeProgressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly related: readonly ItemRow[];
  readonly relatedCategoryId: string | undefined;
  readonly relatedProgressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/** Cached Detail entry holding snapshot, prewarmed season episodes, and episode watch progress. */
export interface CachedDetailEntry {
  readonly sourceId: string;
  readonly snap: CachedDetailSnapshot;
  readonly episodesBySeason: ReadonlyMap<number, readonly EpisodeRow[]>;
  readonly episodeProgressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/** Cached Search result slice keyed by query, scope, and catalog revision. */
export interface CachedSearchSnapshot {
  readonly query: string;
  readonly scope: SearchScope;
  readonly catalogRevision: number;
  readonly results: SearchResults;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/** Bounded insertion-ordered LRU map with optional TTL expiry. */
export interface BoundedTtlMap<T> {
  get(key: string, nowMs: number): T | undefined;
  set(key: string, value: T, nowMs: number): void;
  deleteWhere(predicate: (key: string) => boolean): void;
  snapshot(nowMs: number): Map<string, T>;
  clear(): void;
  size(): number;
}

/** Options for {@link createCatalogUiCache}. */
export interface CatalogUiCacheOptions {
  readonly revision?: number;
  readonly locale?: string;
}

/** Lightweight diagnostic hit/miss counters for {@link CatalogUiCache} (`#160`). */
export interface CatalogUiCacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly hitRatePct: number | null;
}

/**
 * Bounded, `catalogRevision`-keyed in-memory UI snapshot cache powering zero-blink tab switches,
 * category drill-downs, detail re-opens, season switches, and search returns (`#445`).
 */
export interface CatalogUiCache {
  getRevision(): number;
  getLocale(): string;
  setRevision(revision: number, locale: string): void;
  getMetrics?(): CatalogUiCacheMetrics;
  getHome(): CachedHomeEntry | null;
  setHome(snapshot: CachedHomeSnapshot): void;
  setHomeHeroIndex(heroIndex: number): void;
  getCatalog(
    kind: 'movie' | 'series',
    opts?: { readonly groupVersions?: boolean },
  ): CachedCatalogKindState | null;
  setCatalog(kind: 'movie' | 'series', state: CachedCatalogKindState): void;
  getGridFirstPage(
    kind: 'movie' | 'series',
    categoryId: string,
    opts?: { readonly groupVersions?: boolean },
  ): readonly ItemRow[] | undefined;
  setGridFirstPage(
    kind: 'movie' | 'series',
    categoryId: string,
    rows: readonly ItemRow[],
    opts?: { readonly groupVersions?: boolean },
  ): void;
  getLive(): CachedLiveState | null;
  setLiveCategories(categories: readonly DisplayCategory[]): void;
  setLiveFavorites(favoriteKeys: ReadonlySet<string>, favoriteChannels: readonly ItemRow[]): void;
  getLiveFirstChannels(categoryId: string): readonly ItemRow[] | undefined;
  setLiveFirstChannels(categoryId: string, rows: readonly ItemRow[]): void;
  readonly nowNext: BoundedTtlMap<NowNextEntry>;
  getNowNextSnapshot(nowMs: number): Map<string, NowNextEntry>;
  readonly epgWindow: BoundedTtlMap<CachedEpgProgramEntry>;
  getDetail(itemKey: string): CachedDetailEntry | null;
  setDetail(itemKey: string, entry: CachedDetailEntry): void;
  getSearch(query: string, scope: SearchScope): CachedSearchSnapshot | null;
  setSearch(snapshot: CachedSearchSnapshot): void;
  clearSearch(): void;
  invalidateSource(sourceId: string): void;
  clear(): void;
}
