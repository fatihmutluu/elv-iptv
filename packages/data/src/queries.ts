import type { SqlDriver, SqlValue } from '@elv/domain';
import { isAdultKeywordMatch, type ParentalQueryOptions } from './parental-policy';
import {
  type ActiveParentalFilter,
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
  isCategoryRestricted,
  isItemRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import {
  type AllSourcesCursorPage,
  allocateFairQuotas,
  queryAllSourcesItems,
  queryAllSourcesItemsByCursor,
  queryCatalogByIdCursor,
  type SourceNameCursor,
} from './queries-all-sources';
import {
  type BrowseKind,
  categoryId,
  clampPage,
  ITEM_COLS,
  ITEM_TABLE,
  type ItemRow,
  type ItemSortOrder,
  type ListItemsOptions,
  mapItemRow,
  parseCategoryId,
  type RawItemRow,
  sourceOfKey,
  watchedFilterClause,
} from './queries-shared';

export {
  type AllSourcesCursorPage,
  allocateFairQuotas,
  type BrowseKind,
  type ItemRow,
  type ItemSortOrder,
  type ListItemsOptions,
  parseCategoryId,
  queryAllSourcesItems,
  queryAllSourcesItemsByCursor,
  queryCatalogByIdCursor,
  type SourceNameCursor,
  sourceOfKey,
};

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

/** A category of one source. `id` is opaque; hand it back to `items`. */
export interface CategoryRow {
  id: string;
  sourceId: string;
  kind: BrowseKind;
  name: string;
  /** Provider order, ascending. */
  position: number;
  itemCount: number;
}

/** Detail lookup row for a live channel, movie or series, including series synopsis and optional credits when present. */
export interface ItemDetailRow extends ItemRow {
  /** Series synopsis (`series.plot`); `null` for live channels and movies. */
  plot: string | null;
  /** Cast / actors metadata (`movies.cast_text` / `series.cast_text`) when present (`#397`). */
  readonly cast?: string | null;
  /** Director metadata (`movies.director_text` / `series.director_text`) when present (`#397`). */
  readonly director?: string | null;
}

/** One season of a series with the episodes stored for it. */
export interface SeasonRow {
  season: number;
  episodeCount: number;
}

/** One stored episode. */
export interface EpisodeRow {
  id: number;
  key: string;
  season: number;
  episode: number | null;
  title: string | null;
  durationSec: number | null;
}

/** Optional deduplication, visibility, and parental flags for {@link queryCategories} (`#218`, `#404`, `#31`). */
export interface CategoryQueryOptions {
  /** When `true` on `live`, counts distinct `variant_base_fold` groups per category (`#218`). */
  readonly collapseVariants?: boolean;
  /** When `true` on `movie`, counts distinct `version_group_key` groups per category (`#404`). */
  readonly groupVersions?: boolean;
  /** When `true`, includes `is_hidden = 1` categories (default `false`). */
  readonly includeHidden?: boolean;
  /** Profile identifier used for parental filtering (defaults to `'default'`). */
  readonly profileId?: string;
  /** When `true`, bypasses query-layer parental filtering for an unlocked session (`#31`). */
  readonly parentalUnlocked?: boolean;
}

/** Visible categories of one kind with the number of visible items placed in each, in provider order. */
export async function queryCategories(
  db: SqlDriver,
  sourceId: string,
  kind: BrowseKind,
  opts?: CategoryQueryOptions,
): Promise<CategoryRow[]> {
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  const hiddenClause = opts?.includeHidden === true ? '' : ' AND c.is_hidden = 0';
  const countExpr =
    kind === 'live' && opts?.collapseVariants === true
      ? "COUNT(DISTINCT COALESCE(NULLIF(t.variant_base_fold, ''), t.key))"
      : kind === 'movie' && opts?.groupVersions === true
        ? "COUNT(DISTINCT COALESCE(NULLIF(t.version_group_key, ''), t.key))"
        : 'COUNT(*)';

  if (filter === null) {
    const rows = await db.all<{ provider_id: string; name: string; position: number; n: number }>(
      `SELECT c.provider_id, c.name, c.position, COALESCE(p.n, 0) AS n
         FROM categories c
         LEFT JOIN (
           SELECT pl.category_id, ${countExpr} AS n
             FROM placements pl
             JOIN ${ITEM_TABLE[kind]} t
               ON t.source_id = pl.source_id AND t.key = pl.item_key
            WHERE pl.source_id = ? AND pl.kind = ?
              AND pl.is_hidden = 0 AND t.is_hidden = 0
            GROUP BY pl.category_id
         ) p ON p.category_id = c.provider_id
        WHERE c.source_id = ? AND c.kind = ?${hiddenClause}
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = c.source_id AND s.deleting = 0)
        ORDER BY c.position, c.provider_id`,
      [sourceId, kind, sourceId, kind],
    );
    return rows.map((r) => ({
      id: categoryId(sourceId, kind, r.provider_id),
      sourceId,
      kind,
      name: r.name,
      position: r.position,
      itemCount: r.n,
    }));
  }

  const sqlRestrict = buildSqlItemRestrictionClause(
    filter,
    kind,
    'pl.source_id',
    't.key',
    sourceId,
  );
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');
  const rows = await db.all<{
    provider_id: string;
    name: string;
    name_fold: string;
    position: number;
    n: number;
  }>(
    `SELECT c.provider_id, c.name, c.name_fold, c.position, COALESCE(p.n, 0) AS n
       FROM categories c
       LEFT JOIN (
         SELECT pl.category_id, ${countExpr} AS n
           FROM placements pl
           JOIN ${ITEM_TABLE[kind]} t
             ON t.source_id = pl.source_id AND t.key = pl.item_key
          WHERE pl.source_id = ? AND pl.kind = ?
            AND pl.is_hidden = 0 AND t.is_hidden = 0${sqlRestrict.clause}${adultExcl}
          GROUP BY pl.category_id
       ) p ON p.category_id = c.provider_id
      WHERE c.source_id = ? AND c.kind = ?${hiddenClause}
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = c.source_id AND s.deleting = 0)
      ORDER BY c.position, c.provider_id`,
    [sourceId, kind, ...sqlRestrict.params, sourceId, kind],
  );
  return rows
    .filter(
      (r) => !isCategoryRestricted(filter, sourceId, kind, r.provider_id, r.name, r.name_fold),
    )
    .map((r) => ({
      id: categoryId(sourceId, kind, r.provider_id),
      sourceId,
      kind,
      name: r.name,
      position: r.position,
      itemCount: r.n,
    }));
}

function dedupGroupSpec(
  kind: BrowseKind,
  opts?: Pick<ListItemsOptions, 'collapseVariants' | 'groupVersions'>,
):
  | {
      readonly groupExpr: string;
      readonly rankOrder: string;
      readonly countCol: 'variant_count' | 'version_count';
    }
  | undefined {
  if (kind === 'live' && opts?.collapseVariants === true) {
    return {
      groupExpr: "COALESCE(NULLIF(t.variant_base_fold, ''), t.key)",
      rankOrder: 't.quality_rank DESC, p.position ASC, t.key ASC',
      countCol: 'variant_count',
    };
  }
  if (kind === 'movie' && opts?.groupVersions === true) {
    return {
      groupExpr: "COALESCE(NULLIF(t.version_group_key, ''), t.key)",
      rankOrder: 'p.position ASC, t.key ASC',
      countCol: 'version_count',
    };
  }
  return undefined;
}

async function fetchRawCategoryPage(
  db: SqlDriver,
  ref: { sourceId: string; kind: BrowseKind; providerId: string },
  offset: number,
  limit: number,
  opts: ListItemsOptions | undefined,
  filter: ActiveParentalFilter | null,
): Promise<RawItemRow[]> {
  const table = ITEM_TABLE[ref.kind];
  const dedup = dedupGroupSpec(ref.kind, opts);
  if (dedup !== undefined) {
    const watched = watchedFilterClause('t.key', opts);
    const restrict =
      filter === null
        ? { clause: '', params: [] as readonly SqlValue[] }
        : buildSqlItemRestrictionClause(filter, ref.kind, 'p.source_id', 't.key', ref.sourceId);
    const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');
    const orderBy = opts?.sortBy === 'alpha' ? 'sort_title ASC, key ASC' : 'group_pos ASC, key ASC';
    return db.all<RawItemRow>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.provider_id, t.name, t.sort_title, ${ITEM_COLS[ref.kind]},
                COUNT(*) OVER (PARTITION BY ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn,
                MIN(p.position) OVER (PARTITION BY ${dedup.groupExpr}) AS group_pos
           FROM placements p
           JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
          WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, provider_id, name, logo, rating, year, num, ${dedup.countCol}
         FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [
        ref.sourceId,
        ref.kind,
        ref.providerId,
        ...watched.params,
        ...restrict.params,
        limit,
        offset,
      ],
    );
  }
  if (opts?.sortBy === 'alpha') {
    const watched = watchedFilterClause('t.key', opts);
    const restrict =
      filter === null
        ? { clause: '', params: [] as readonly SqlValue[] }
        : buildSqlItemRestrictionClause(filter, ref.kind, 'p.source_id', 't.key', ref.sourceId);
    const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');
    return db.all<RawItemRow>(
      `SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_COLS[ref.kind]}
         FROM placements p
         JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
        WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
        ORDER BY t.sort_title ASC, t.key ASC LIMIT ? OFFSET ?`,
      [
        ref.sourceId,
        ref.kind,
        ref.providerId,
        ...watched.params,
        ...restrict.params,
        limit,
        offset,
      ],
    );
  }
  const watched = watchedFilterClause('placements.item_key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(
          filter,
          ref.kind,
          'placements.source_id',
          'placements.item_key',
          ref.sourceId,
        );
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 'jt.name', 'jt.name_fold');
  return db.all<RawItemRow>(
    `SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_COLS[ref.kind]}
       FROM (
         SELECT source_id, item_key, position FROM placements
          WHERE source_id = ? AND kind = ? AND category_id = ? AND is_hidden = 0
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = placements.source_id AND s.deleting = 0)
            AND EXISTS (SELECT 1 FROM ${table} jt WHERE jt.source_id = placements.source_id AND jt.key = placements.item_key AND jt.is_hidden = 0${adultExcl})${watched.clause}${restrict.clause}
          ORDER BY position, item_key LIMIT ? OFFSET ?
       ) p
       JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
      ORDER BY p.position, t.id`,
    [ref.sourceId, ref.kind, ref.providerId, ...watched.params, ...restrict.params, limit, offset],
  );
}

/** One page of a category's visible items; supports optional `'alpha'` (`sort_title`) ordering, `excludeWatched` filtering (`#125`), parental controls (`#31`), and variant/version deduplication (`#218`, `#404`). */
export async function queryItems(
  db: SqlDriver,
  ref: { sourceId: string; kind: BrowseKind; providerId: string },
  offset: number,
  limit: number,
  opts?: ListItemsOptions,
): Promise<ItemRow[]> {
  const page = clampPage(offset, limit);
  if (page.limit === 0) return [];
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (filter !== null && isCategoryRestricted(filter, ref.sourceId, ref.kind, ref.providerId)) {
    return [];
  }
  const rows = await fetchRawCategoryPage(db, ref, page.offset, page.limit, opts, filter);
  return rows.map((r) => mapItemRow(ref.kind, ref.sourceId, r));
}

async function fetchRawCursorBatch(
  db: SqlDriver,
  ref: { sourceId: string; kind: BrowseKind; providerId: string },
  cursor: ItemsCursor | undefined,
  batchLimit: number,
  opts:
    | Pick<
        ListItemsOptions,
        'excludeWatched' | 'profileId' | 'parentalUnlocked' | 'collapseVariants' | 'groupVersions'
      >
    | undefined,
  filter: ActiveParentalFilter | null,
): Promise<Array<RawItemRow & { _pos: number }>> {
  const table = ITEM_TABLE[ref.kind];
  const dedup = dedupGroupSpec(ref.kind, opts);
  if (dedup !== undefined) {
    const watched = watchedFilterClause('t.key', opts);
    const restrict =
      filter === null
        ? { clause: '', params: [] as readonly SqlValue[] }
        : buildSqlItemRestrictionClause(filter, ref.kind, 'p.source_id', 't.key', ref.sourceId);
    const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');
    const cursorClause = cursor ? ' AND (group_pos > ? OR (group_pos = ? AND key > ?))' : '';
    const cursorParams = cursor ? [cursor.position, cursor.position, cursor.itemKey] : [];
    return db.all<RawItemRow & { _pos: number }>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_COLS[ref.kind]},
                COUNT(*) OVER (PARTITION BY ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn,
                MIN(p.position) OVER (PARTITION BY ${dedup.groupExpr}) AS group_pos
           FROM placements p
           JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
          WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, provider_id, name, logo, rating, year, num, ${dedup.countCol}, group_pos AS _pos
         FROM ranked
        WHERE rn = 1${cursorClause}
        ORDER BY group_pos ASC, key ASC
        LIMIT ?`,
      [
        ref.sourceId,
        ref.kind,
        ref.providerId,
        ...watched.params,
        ...restrict.params,
        ...cursorParams,
        batchLimit,
      ],
    );
  }
  const cursorClause = cursor
    ? ' AND position >= ? AND (position > ? OR (position = ? AND item_key > ?))'
    : '';
  const cursorParams = cursor
    ? [cursor.position, cursor.position, cursor.position, cursor.itemKey]
    : [];
  const watched = watchedFilterClause('placements.item_key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(
          filter,
          ref.kind,
          'placements.source_id',
          'placements.item_key',
          ref.sourceId,
        );
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 'jt.name', 'jt.name_fold');
  const params: SqlValue[] = [
    ref.sourceId,
    ref.kind,
    ref.providerId,
    ...cursorParams,
    ...watched.params,
    ...restrict.params,
    batchLimit,
  ];
  return db.all<RawItemRow & { _pos: number }>(
    `SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_COLS[ref.kind]}, p.position AS _pos
       FROM (
         SELECT source_id, item_key, position FROM placements
          WHERE source_id = ? AND kind = ? AND category_id = ? AND is_hidden = 0${cursorClause}
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = placements.source_id AND s.deleting = 0)
            AND EXISTS (SELECT 1 FROM ${table} jt WHERE jt.source_id = placements.source_id AND jt.key = placements.item_key AND jt.is_hidden = 0${adultExcl})${watched.clause}${restrict.clause}
          ORDER BY position ASC, item_key ASC LIMIT ?
       ) p
       JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key
      ORDER BY p.position ASC, p.item_key ASC`,
    params,
  );
}

/**
 * One key-cursor page of a category's visible items in `(position, item_key)` order (`#176`).
 * Backed by `idx_placements_visible` with `limit + 1` lookahead for exact `hasMore`.
 */
export async function queryItemsByCursor(
  db: SqlDriver,
  categoryIdInput: string | { sourceId: string; kind: BrowseKind; providerId: string },
  cursor: ItemsCursor | undefined,
  limit: number,
  opts?: Pick<
    ListItemsOptions,
    'excludeWatched' | 'profileId' | 'parentalUnlocked' | 'collapseVariants' | 'groupVersions'
  >,
): Promise<CursorPage<ItemRow, ItemsCursor>> {
  const ref =
    typeof categoryIdInput === 'string' ? parseCategoryId(categoryIdInput) : categoryIdInput;
  const page = clampPage(0, limit);
  if (ref === undefined || page.limit === 0) return { items: [], nextCursor: null, hasMore: false };
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (filter !== null && isCategoryRestricted(filter, ref.sourceId, ref.kind, ref.providerId)) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const rows = await fetchRawCursorBatch(db, ref, cursor, page.limit + 1, opts, filter);
  const hasMore = rows.length > page.limit;
  const slice = hasMore ? rows.slice(0, page.limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map((r) => mapItemRow(ref.kind, ref.sourceId, r)),
    nextCursor: hasMore && last !== undefined ? { position: last._pos, itemKey: last.key } : null,
    hasMore,
  };
}

/** A series row: what loading and listing episodes needs. */
export async function querySeries(
  db: SqlDriver,
  seriesId: number,
): Promise<{ sourceId: string; key: string } | undefined> {
  const row = (
    await db.all<{ source_id: string; key: string }>(
      'SELECT source_id, key FROM series WHERE id = ?',
      [seriesId],
    )
  )[0];
  return row === undefined ? undefined : { sourceId: row.source_id, key: row.key };
}

/** Seasons of a series that have stored episodes, ascending; a missing season number counts as 0. */
export async function querySeasons(
  db: SqlDriver,
  series: { sourceId: string; key: string },
  opts?: ParentalQueryOptions,
): Promise<SeasonRow[]> {
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (filter === null) {
    const rows = await db.all<{ season: number; n: number }>(
      `SELECT COALESCE(season, 0) AS season, COUNT(*) AS n FROM episodes
        WHERE source_id = ? AND series_key = ? GROUP BY COALESCE(season, 0) ORDER BY season`,
      [series.sourceId, series.key],
    );
    return rows.map((r) => ({ season: r.season, episodeCount: r.n }));
  }
  if (await isItemRestricted(db, filter, series.key)) {
    return [];
  }
  const rows = await db.all<{ season: number; key: string; title: string | null }>(
    `SELECT COALESCE(season, 0) AS season, key, title FROM episodes
      WHERE source_id = ? AND series_key = ?
      ORDER BY season`,
    [series.sourceId, series.key],
  );
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (filter.lockedItemKeys.has(r.key)) continue;
    if (filter.blockAdultKeywords && r.title !== null && isAdultKeywordMatch(r.title)) continue;
    counts.set(r.season, (counts.get(r.season) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodeCount]) => ({ season, episodeCount }));
}

/** Episodes of one season in episode order. */
export async function queryEpisodes(
  db: SqlDriver,
  series: { sourceId: string; key: string },
  season: number,
  opts?: ParentalQueryOptions,
): Promise<EpisodeRow[]> {
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (filter !== null && (await isItemRestricted(db, filter, series.key))) {
    return [];
  }
  const rows = await db.all<{
    id: number;
    key: string;
    season: number;
    episode: number | null;
    title: string | null;
    duration_sec: number | null;
  }>(
    `SELECT id, key, COALESCE(season, 0) AS season, episode, title, duration_sec FROM episodes
      WHERE source_id = ? AND series_key = ? AND COALESCE(season, 0) = ?
      ORDER BY episode, id`,
    [series.sourceId, series.key, season],
  );
  const filtered =
    filter === null
      ? rows
      : rows.filter(
          (r) =>
            !filter.lockedItemKeys.has(r.key) &&
            !(filter.blockAdultKeywords && r.title !== null && isAdultKeywordMatch(r.title)),
        );
  return filtered.map((r) => ({
    id: r.id,
    key: r.key,
    season: r.season,
    episode: r.episode,
    title: r.title,
    durationSec: r.duration_sec,
  }));
}

/** Where a playable key lives. */
export interface PlayableRow {
  sourceId: string;
  /** Kind of the Xtream stream path. */
  streamKind: 'live' | 'movie' | 'series';
  providerId: string | null;
  extension: string | null;
  urlTemplate: string | null;
  headersJson: string | null;
  backupUrlsJson: string | null;
}

/** Finds a live channel, movie or series detail row by content key via the `UNIQUE (source_id, key)` index. */
export async function queryItemDetail(
  db: SqlDriver,
  itemKey: string,
  opts?: ParentalQueryOptions,
): Promise<ItemDetailRow | undefined> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return undefined;
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (filter !== null && (await isItemRestricted(db, filter, itemKey))) {
    return undefined;
  }
  const rows = await db.all<
    RawItemRow & {
      kind: BrowseKind;
      source_id: string;
      plot: string | null;
      cast_text: string | null;
      director_text: string | null;
    }
  >(
    `SELECT id, key, 'live' AS kind, source_id, provider_id, name, logo, NULL AS rating, NULL AS year, num, NULL AS plot, NULL AS cast_text, NULL AS director_text
       FROM live WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT id, key, 'movie', source_id, provider_id, name, logo, rating, year, NULL, NULL, cast_text, director_text
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT id, key, 'series', source_id, provider_id, name, cover, rating, year, NULL, plot, cast_text, director_text
       FROM series WHERE source_id = ? AND key = ?
     LIMIT 1`,
    [sourceId, itemKey, sourceId, itemKey, sourceId, itemKey],
  );
  const r = rows[0];
  return r === undefined
    ? undefined
    : {
        ...mapItemRow(r.kind, r.source_id, r),
        plot: r.plot,
        ...(r.cast_text !== null ? { cast: r.cast_text } : {}),
        ...(r.director_text !== null ? { director: r.director_text } : {}),
      };
}

/** Finds a live channel, movie or episode by content key. */
export async function queryPlayable(db: SqlDriver, key: string): Promise<PlayableRow | undefined> {
  const sourceId = sourceOfKey(key);
  if (sourceId === undefined) return undefined;
  const rows = await db.all<{
    source_id: string;
    stream_kind: PlayableRow['streamKind'];
    provider_id: string | null;
    extension: string | null;
    url_template: string | null;
    headers_json: string | null;
    backup_urls_json: string | null;
  }>(
    `SELECT source_id, 'live' AS stream_kind, provider_id, NULL AS extension, url_template, headers_json, backup_urls_json
       FROM live WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'movie', provider_id, extension, url_template, headers_json, backup_urls_json
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'series', provider_id, extension, url_template, headers_json, backup_urls_json
       FROM episodes WHERE source_id = ? AND key = ?
     LIMIT 1`,
    [sourceId, key, sourceId, key, sourceId, key],
  );
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    sourceId: r.source_id,
    streamKind: r.stream_kind,
    providerId: r.provider_id,
    extension: r.extension,
    urlTemplate: r.url_template,
    headersJson: r.headers_json,
    backupUrlsJson: r.backup_urls_json,
  };
}

/**
 * Looks up the raw stored `logo` / `cover` template for an item in the catalog tables
 * (`live`, `movies`, `series`, or parent `series.cover` for `episode`), so user-state writes
 * never persist secret-resolved M3U logo URLs into SQLite.
 */
async function queryItemLogoTemplate(
  db: SqlDriver,
  ref: {
    sourceId: string;
    kind: BrowseKind | 'episode';
    itemKey: string;
    seriesKey?: string | null;
  },
): Promise<{ found: true; logo: string | null } | { found: false }> {
  if (ref.kind === 'episode') {
    const ep = await db.all<{ logo: string | null }>(
      `SELECT s.cover AS logo
         FROM episodes e
         LEFT JOIN series s ON s.source_id = e.source_id AND s.key = e.series_key
        WHERE e.source_id = ? AND e.key = ? LIMIT 1`,
      [ref.sourceId, ref.itemKey],
    );
    if (ep[0] !== undefined) return { found: true, logo: ep[0].logo };
    if (ref.seriesKey) {
      const ser = await db.all<{ logo: string | null }>(
        'SELECT cover AS logo FROM series WHERE source_id = ? AND key = ? LIMIT 1',
        [ref.sourceId, ref.seriesKey],
      );
      if (ser[0] !== undefined) return { found: true, logo: ser[0].logo };
    }
    return { found: false };
  }
  const col = ref.kind === 'series' ? 'cover' : 'logo';
  const rows = await db.all<{ logo: string | null }>(
    `SELECT ${col} AS logo FROM ${ITEM_TABLE[ref.kind]} WHERE source_id = ? AND key = ? LIMIT 1`,
    [ref.sourceId, ref.itemKey],
  );
  return rows[0] === undefined ? { found: false } : { found: true, logo: rows[0].logo };
}

/**
 * Resolves the safe `logo` value to persist into `watch_progress` or `favorites`: prefers the raw
 * catalog template when present and refuses caller-supplied logos for M3U sources so resolved
 * credentials never enter SQLite.
 */
export async function resolveSafeStorageLogo(
  db: SqlDriver,
  input: {
    sourceId: string;
    itemKey: string;
    kind: BrowseKind | 'episode';
    seriesKey?: string | null;
    logo?: string | null;
  },
): Promise<string | null> {
  const fromCatalog = await queryItemLogoTemplate(db, input);
  if (fromCatalog.found) return fromCatalog.logo;
  const src = await db.all<{ kind: string }>('SELECT kind FROM sources WHERE id = ? LIMIT 1', [
    input.sourceId,
  ]);
  return src[0]?.kind === 'm3u' ? null : (input.logo ?? null);
}
