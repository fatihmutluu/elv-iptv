/** Kinds a menu browses; stored as `kind` in `categories` and `placements`. */
export type BrowseKind = 'live' | 'movie' | 'series';

/** Sort order for catalog browse queries (`#125`). */
export type ItemSortOrder = 'default' | 'alpha';

/** Optional sorting, watched-state filtering, parental unlock, and variant/version deduplication for browse queries (`#125`, `#218`, `#404`, `#31`). */
export interface ListItemsOptions {
  /** `'default'` preserves provider/category order; `'alpha'` orders by `sort_title ASC, key ASC`. */
  readonly sortBy?: ItemSortOrder;
  /** When `true`, excludes items marked `watched = 1` in `watch_progress` for `profileId`. */
  readonly excludeWatched?: boolean;
  /** Profile identifier for `excludeWatched` and parental filtering (defaults to `'default'`). */
  readonly profileId?: string;
  /** When `true`, bypasses query-layer parental restrictions for an unlocked session (`#31`). */
  readonly parentalUnlocked?: boolean;
  /** When `true` on `live` queries, collapses quality variants within `(source_id, category_id)` (`#218`). */
  readonly collapseVariants?: boolean;
  /** When `true` on `movie` queries, groups multi-version titles within `(source_id, category_id)` (`#404`). */
  readonly groupVersions?: boolean;
}

const DEFAULT_QUERY_PROFILE_ID = 'default';

/** @internal Builds an indexed `NOT EXISTS` predicate excluding watched items for a profile (`#125`). */
export function watchedFilterClause(
  keyExpr: 'placements.item_key' | 't.key',
  opts?: Pick<ListItemsOptions, 'excludeWatched' | 'profileId'>,
): { readonly clause: string; readonly params: readonly string[] } {
  if (opts?.excludeWatched !== true) return { clause: '', params: [] };
  const trimmed = opts.profileId?.trim();
  const profileId = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_QUERY_PROFILE_ID;
  return {
    clause: ` AND NOT EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = ? AND wp.item_key = ${keyExpr} AND wp.watched = 1)`,
    params: [profileId],
  };
}

/** Largest page `items` and `queryAllSourcesItems` return. */
const MAX_PAGE = 500;

/** A live channel, movie or series in a category or multi-source view. */
export interface ItemRow {
  /** Row id in its table; the argument of `seasons` and `episodes` for a series. */
  id: number;
  /** Stable content key; the argument of `resolveStream`. */
  key: string;
  kind: BrowseKind;
  sourceId: string;
  providerId: string | null;
  name: string;
  /** Logo or cover as stored (an M3U template is resolved by the service). */
  logo: string | null;
  rating: number | null;
  year: number | null;
  /** Channel number (live only). */
  num: number | null;
  /** Number of collapsed live quality variants when `collapseVariants` is enabled and `> 1` (`#218`). */
  readonly variantCount?: number;
  /** Number of grouped movie versions when `groupVersions` is enabled and `> 1` (`#404`). */
  readonly versionCount?: number;
}

/** @internal Raw SQLite item projection shared by category and multi-source browse queries. */
export interface RawItemRow {
  id: number;
  key: string;
  source_id?: string;
  provider_id: string | null;
  name: string;
  logo: string | null;
  rating: number | null;
  year: number | null;
  num: number | null;
  variant_count?: number;
  version_count?: number;
}

/** @internal Columns per kind; fixed strings, never built from data. */
export const ITEM_COLS: Record<BrowseKind, string> = {
  live: 't.logo AS logo, NULL AS rating, NULL AS year, t.num AS num',
  movie: 't.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num',
  series: 't.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num',
};

/** @internal Backing catalog table per kind; fixed strings, never built from data. */
export const ITEM_TABLE: Record<BrowseKind, string> = {
  live: 'live',
  movie: 'movies',
  series: 'series',
};

/** @internal Clamps a page request; `limit` is 0 to {@link MAX_PAGE}, `offset` at least 0. */
export function clampPage(offset: number, limit: number): { offset: number; limit: number } {
  const whole = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0);
  return {
    offset: Math.max(0, whole(offset)),
    limit: Math.min(MAX_PAGE, Math.max(0, whole(limit))),
  };
}

const CATEGORY_SEP = '|';

/** Encodes a category reference; source ids and kinds never contain the separator. */
export function categoryId(sourceId: string, kind: BrowseKind, providerId: string): string {
  return [sourceId, kind, providerId].join(CATEGORY_SEP);
}

/** Decodes {@link categoryId}; `undefined` for anything else. */
export function parseCategoryId(
  id: string,
): { sourceId: string; kind: BrowseKind; providerId: string } | undefined {
  const first = id.indexOf(CATEGORY_SEP);
  const second = id.indexOf(CATEGORY_SEP, first + 1);
  if (first < 0 || second < 0) return undefined;
  const kind = id.slice(first + 1, second);
  if (kind !== 'live' && kind !== 'movie' && kind !== 'series') return undefined;
  return { sourceId: id.slice(0, first), kind, providerId: id.slice(second + 1) };
}

/** The source id inside a content key (`x:<source>:...` or `m:<source>:...`), so lookups use the unique index. */
export function sourceOfKey(key: string): string | undefined {
  const parts = key.split(':');
  return (parts[0] === 'x' || parts[0] === 'm') && parts[1] ? parts[1] : undefined;
}

/** @internal Maps a raw SQLite item row to {@link ItemRow}. */
export function mapItemRow(kind: BrowseKind, sourceId: string, r: RawItemRow): ItemRow {
  return {
    id: r.id,
    key: r.key,
    kind,
    sourceId: r.source_id ?? sourceId,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: r.rating,
    year: r.year,
    num: r.num,
    ...(typeof r.variant_count === 'number' && r.variant_count > 1
      ? { variantCount: r.variant_count }
      : {}),
    ...(typeof r.version_count === 'number' && r.version_count > 1
      ? { versionCount: r.version_count }
      : {}),
  };
}
