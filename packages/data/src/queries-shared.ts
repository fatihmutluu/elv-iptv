/** Kinds a menu browses; stored as `kind` in `categories` and `placements`. */
export type BrowseKind = 'live' | 'movie' | 'series';

/** Sort order for catalog browse queries (`#125`). */
export type ItemSortOrder = 'default' | 'alpha';

/** Key-cursor pointing to the last returned placement row in category order (`#176`). */
export interface ItemsCursor {
  readonly position: number;
  readonly itemKey: string;
}

/** One key-cursor page along with the cursor for the next page, if any (`#176`). */
export interface CursorPage<T, C> {
  readonly items: T[];
  readonly nextCursor: C | null;
  readonly hasMore: boolean;
}

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
  /** When `true` on `live` queries, includes channels hidden via per-profile `channel_overrides` (`#60`). */
  readonly includeHidden?: boolean;
}

const DEFAULT_QUERY_PROFILE_ID = 'default';

/** @internal Resolves an optional query `profileId` to `'default'` when blank. */
export function resolveQueryProfileId(profileId?: string): string {
  const trimmed = profileId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_QUERY_PROFILE_ID;
}

/** @internal Shared SQL fragments for per-profile `channel_overrides` projection on `live` table alias `t`. */
export const LIVE_OVERRIDE_JOIN =
  'LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = t.key';

export const LIVE_EFFECTIVE_NAME_EXPR = "COALESCE(NULLIF(co.custom_name, ''), t.name)";

export const LIVE_EFFECTIVE_SORT_TITLE_EXPR =
  "COALESCE(NULLIF(co.custom_name_fold, ''), t.sort_title)";

export const LIVE_OVERRIDE_META_COLS =
  "CASE WHEN NULLIF(co.custom_name, '') IS NOT NULL THEN t.name ELSE NULL END AS original_name, COALESCE(co.is_hidden, 0) AS co_is_hidden, co.sort_order AS co_sort_order";

export const LIVE_MANUAL_ORDER_PREFIX =
  'CASE WHEN co.sort_order IS NULL THEN 1 ELSE 0 END ASC, co.sort_order ASC';

/** @internal Cursor offset keeping manual `sort_order` (`0..999_999_999`) strictly below provider `position >= 0`. */
export const LIVE_MANUAL_CURSOR_OFFSET = 1_000_000_000;

/** @internal SQL filter excluding per-profile hidden live channels unless `includeHidden` is `true`. */
export function liveOverrideHiddenClause(includeHidden?: boolean): string {
  return includeHidden === true ? '' : ' AND COALESCE(co.is_hidden, 0) = 0';
}

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
  /** Catch-up archive retention window in days when supported (live only, `#220`). */
  readonly catchupDays?: number | null;
  /** Number of collapsed live quality variants when `collapseVariants` is enabled and `> 1` (`#218`). */
  readonly variantCount?: number;
  /** Number of grouped movie versions when `groupVersions` is enabled and `> 1` (`#404`). */
  readonly versionCount?: number;
  /** Original provider title when overridden by a per-profile custom channel name (`#60`). */
  readonly originalName?: string;
  /** `true` when hidden via per-profile `channel_overrides` (returned when `includeHidden: true` or via `itemDetail`, `#60`). */
  readonly isHidden?: boolean;
  /** Per-profile manual sort order when assigned (`#60`). */
  readonly customSortOrder?: number;
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
  catchup_days?: number | null;
  variant_count?: number;
  version_count?: number;
  original_name?: string | null;
  co_is_hidden?: number | null;
  co_sort_order?: number | null;
}

/** @internal Columns per kind; fixed strings, never built from data. */
export const ITEM_COLS: Record<BrowseKind, string> = {
  live: 't.logo AS logo, NULL AS rating, NULL AS year, t.num AS num, t.catchup_days AS catchup_days',
  movie: 't.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num, NULL AS catchup_days',
  series: 't.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num, NULL AS catchup_days',
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
    ...(typeof r.catchup_days === 'number' && Number.isFinite(r.catchup_days) && r.catchup_days > 0
      ? { catchupDays: r.catchup_days }
      : {}),
    ...(typeof r.variant_count === 'number' && r.variant_count > 1
      ? { variantCount: r.variant_count }
      : {}),
    ...(typeof r.version_count === 'number' && r.version_count > 1
      ? { versionCount: r.version_count }
      : {}),
    ...(typeof r.original_name === 'string' && r.original_name !== ''
      ? { originalName: r.original_name }
      : {}),
    ...(typeof r.co_is_hidden === 'number' && r.co_is_hidden !== 0 ? { isHidden: true } : {}),
    ...(typeof r.co_sort_order === 'number' ? { customSortOrder: r.co_sort_order } : {}),
  };
}
