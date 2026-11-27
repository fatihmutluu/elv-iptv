import type { SqlDriver, SqlValue } from '@elv/domain';
import { parseCustomGroupCategoryId } from './custom-groups-repo';
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
import { type CursorPage, type ItemsCursor, queryItemsByCursor } from './queries-cursor';
import { queryCustomGroupItemsPage } from './queries-custom-groups';
import {
  type BrowseKind,
  categoryId,
  clampPage,
  ITEM_COLS,
  ITEM_TABLE,
  type ItemRow,
  type ItemSortOrder,
  LIVE_EFFECTIVE_NAME_EXPR,
  LIVE_EFFECTIVE_SORT_TITLE_EXPR,
  LIVE_MANUAL_CURSOR_OFFSET,
  LIVE_MANUAL_ORDER_PREFIX,
  LIVE_OVERRIDE_JOIN,
  LIVE_OVERRIDE_META_COLS,
  type ListItemsOptions,
  liveOverrideHiddenClause,
  mapItemRow,
  parseCategoryId,
  type RawItemRow,
  resolveQueryProfileId,
  sourceOfKey,
  watchedFilterClause,
} from './queries-shared';

export {
  type AllSourcesCursorPage,
  allocateFairQuotas,
  type BrowseKind,
  type CursorPage,
  type ItemRow,
  type ItemSortOrder,
  type ItemsCursor,
  type ListItemsOptions,
  parseCategoryId,
  queryAllSourcesItems,
  queryAllSourcesItemsByCursor,
  queryCatalogByIdCursor,
  queryItemsByCursor,
  type SourceNameCursor,
  sourceOfKey,
};

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
  /** Provider-supplied IMDb ID (`tt...`) persisted in catalog v24 when present (`#511`). */
  readonly providerImdbId?: string | null;
  /** Provider-supplied numeric TMDB ID persisted in catalog v24 when present (`#511`). */
  readonly providerTmdbId?: string | null;
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
  const profileId = resolveQueryProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
  const hiddenClause = opts?.includeHidden === true ? '' : ' AND c.is_hidden = 0';
  const liveJoin = kind === 'live' ? `\n             ${LIVE_OVERRIDE_JOIN}` : '';
  const liveJoinParams: SqlValue[] = kind === 'live' ? [profileId] : [];
  const liveHiddenClause = kind === 'live' ? liveOverrideHiddenClause(opts?.includeHidden) : '';
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
               ON t.source_id = pl.source_id AND t.key = pl.item_key${liveJoin}
            WHERE pl.source_id = ? AND pl.kind = ?
              AND pl.is_hidden = 0 AND t.is_hidden = 0${liveHiddenClause}
            GROUP BY pl.category_id
         ) p ON p.category_id = c.provider_id
        WHERE c.source_id = ? AND c.kind = ?${hiddenClause}
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = c.source_id AND s.deleting = 0)
        ORDER BY c.position, c.provider_id`,
      [...liveJoinParams, sourceId, kind, sourceId, kind],
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
             ON t.source_id = pl.source_id AND t.key = pl.item_key${liveJoin}
          WHERE pl.source_id = ? AND pl.kind = ?
            AND pl.is_hidden = 0 AND t.is_hidden = 0${liveHiddenClause}${sqlRestrict.clause}${adultExcl}
          GROUP BY pl.category_id
       ) p ON p.category_id = c.provider_id
      WHERE c.source_id = ? AND c.kind = ?${hiddenClause}
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = c.source_id AND s.deleting = 0)
      ORDER BY c.position, c.provider_id`,
    [...liveJoinParams, sourceId, kind, ...sqlRestrict.params, sourceId, kind],
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
  const isLive = ref.kind === 'live';
  const profileId = resolveQueryProfileId(opts?.profileId);
  const liveJoin = isLive ? `\n           ${LIVE_OVERRIDE_JOIN}` : '';
  const liveJoinParams: SqlValue[] = isLive ? [profileId] : [];
  const liveHidden = isLive ? liveOverrideHiddenClause(opts?.includeHidden) : '';
  const nameExpr = isLive
    ? `${LIVE_EFFECTIVE_NAME_EXPR} AS name, ${LIVE_OVERRIDE_META_COLS}`
    : 't.name';
  const sortExpr = isLive ? `${LIVE_EFFECTIVE_SORT_TITLE_EXPR} AS sort_title` : 't.sort_title';
  const metaSelect = isLive ? ', original_name, co_is_hidden, co_sort_order' : '';
  const effPosExpr = isLive
    ? `CASE WHEN co.sort_order IS NOT NULL THEN co.sort_order - ${LIVE_MANUAL_CURSOR_OFFSET} ELSE p.position END`
    : 'p.position';
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
         SELECT t.id, t.key, t.provider_id, ${nameExpr}, ${sortExpr}, ${ITEM_COLS[ref.kind]},
                COUNT(*) OVER (PARTITION BY ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn,
                MIN(${effPosExpr}) OVER (PARTITION BY ${dedup.groupExpr}) AS group_pos
           FROM placements p
           JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key${liveJoin}
          WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0${liveHidden}
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, provider_id, name${metaSelect}, logo, rating, year, num, catchup_days, ${dedup.countCol}
         FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [
        ...liveJoinParams,
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
    const orderBy = isLive
      ? `${LIVE_EFFECTIVE_SORT_TITLE_EXPR} ASC, t.key ASC`
      : 't.sort_title ASC, t.key ASC';
    return db.all<RawItemRow>(
      `SELECT t.id, t.key, t.provider_id, ${nameExpr}, ${ITEM_COLS[ref.kind]}
         FROM placements p
         JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key${liveJoin}
        WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0${liveHidden}
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [
        ...liveJoinParams,
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
  if (isLive) {
    return db.all<RawItemRow>(
      `SELECT t.id, t.key, t.provider_id,
              COALESCE(NULLIF(p.custom_name, ''), t.name) AS name,
              CASE WHEN NULLIF(p.custom_name, '') IS NOT NULL THEN t.name ELSE NULL END AS original_name,
              p.co_is_hidden,
              p.co_sort_order,
              ${ITEM_COLS.live}
         FROM (
           SELECT placements.source_id, placements.item_key, placements.position,
                  co.custom_name, COALESCE(co.is_hidden, 0) AS co_is_hidden, co.sort_order AS co_sort_order
             FROM placements
             LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = placements.item_key
            WHERE placements.source_id = ? AND placements.kind = ? AND placements.category_id = ? AND placements.is_hidden = 0${liveHidden}
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = placements.source_id AND s.deleting = 0)
              AND EXISTS (SELECT 1 FROM live jt WHERE jt.source_id = placements.source_id AND jt.key = placements.item_key AND jt.is_hidden = 0${adultExcl})${watched.clause}${restrict.clause}
            ORDER BY ${LIVE_MANUAL_ORDER_PREFIX}, placements.position ASC, placements.item_key ASC LIMIT ? OFFSET ?
         ) p
         JOIN live t ON t.source_id = p.source_id AND t.key = p.item_key
        ORDER BY CASE WHEN p.co_sort_order IS NULL THEN 1 ELSE 0 END ASC, p.co_sort_order ASC, p.position ASC, t.id ASC`,
      [
        profileId,
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

/** One page of a category's or custom group's (`__custom:<groupId>`) visible items; supports `'alpha'` ordering, `excludeWatched` (`#125`), parental controls (`#31`), channel overrides (`#60`), and variant/version deduplication (`#218`, `#404`). */
export async function queryItems(
  db: SqlDriver,
  refInput: string | { sourceId: string; kind: BrowseKind; providerId: string },
  offset: number,
  limit: number,
  opts?: ListItemsOptions,
): Promise<ItemRow[]> {
  const page = clampPage(offset, limit);
  if (page.limit === 0) return [];
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (typeof refInput === 'string') {
    const customGroupId = parseCustomGroupCategoryId(refInput);
    if (customGroupId !== undefined) {
      return queryCustomGroupItemsPage(db, customGroupId, page.offset, page.limit, opts, filter);
    }
  }
  const ref = typeof refInput === 'string' ? parseCategoryId(refInput) : refInput;
  if (ref === undefined) return [];
  if (filter !== null && isCategoryRestricted(filter, ref.sourceId, ref.kind, ref.providerId)) {
    return [];
  }
  const rows = await fetchRawCategoryPage(db, ref, page.offset, page.limit, opts, filter);
  return rows.map((r) => mapItemRow(ref.kind, ref.sourceId, r));
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
  /** Kind of the Xtream/Stalker stream path. */
  streamKind: 'live' | 'movie' | 'series';
  providerId: string | null;
  extension: string | null;
  urlTemplate: string | null;
  headersJson: string | null;
  backupUrlsJson: string | null;
  /** 1-based episode number when resolving a series episode (used by Stalker `create_link`). */
  readonly episodeNumber?: number | null;
}

/** Finds a live channel, movie or series detail row by content key via the `UNIQUE (source_id, key)` index. */
export async function queryItemDetail(
  db: SqlDriver,
  itemKey: string,
  opts?: ParentalQueryOptions,
): Promise<ItemDetailRow | undefined> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return undefined;
  const profileId = resolveQueryProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
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
      provider_imdb_id: string | null;
      provider_tmdb_id: string | null;
    }
  >(
    `SELECT live.id, live.key, 'live' AS kind, live.source_id, live.provider_id,
            COALESCE(NULLIF(co.custom_name, ''), live.name) AS name,
            CASE WHEN NULLIF(co.custom_name, '') IS NOT NULL THEN live.name ELSE NULL END AS original_name,
            COALESCE(co.is_hidden, 0) AS co_is_hidden,
            co.sort_order AS co_sort_order,
            live.logo, NULL AS rating, NULL AS year, live.num, live.catchup_days, NULL AS plot, NULL AS cast_text, NULL AS director_text, NULL AS provider_imdb_id, NULL AS provider_tmdb_id
       FROM live
       LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = live.key
      WHERE live.source_id = ? AND live.key = ?
     UNION ALL
     SELECT id, key, 'movie', source_id, provider_id, name, NULL, 0, NULL, logo, rating, year, NULL, NULL, NULL, cast_text, director_text, provider_imdb_id, provider_tmdb_id
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT id, key, 'series', source_id, provider_id, name, NULL, 0, NULL, cover, rating, year, NULL, NULL, plot, cast_text, director_text, provider_imdb_id, provider_tmdb_id
       FROM series WHERE source_id = ? AND key = ?
     LIMIT 1`,
    [profileId, sourceId, itemKey, sourceId, itemKey, sourceId, itemKey],
  );
  const r = rows[0];
  return r === undefined
    ? undefined
    : {
        ...mapItemRow(r.kind, r.source_id, r),
        plot: r.plot,
        ...(r.cast_text !== null ? { cast: r.cast_text } : {}),
        ...(r.director_text !== null ? { director: r.director_text } : {}),
        ...(r.provider_imdb_id !== null ? { providerImdbId: r.provider_imdb_id } : {}),
        ...(r.provider_tmdb_id !== null ? { providerTmdbId: r.provider_tmdb_id } : {}),
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
    episode_number: number | null;
  }>(
    `SELECT source_id, 'live' AS stream_kind, provider_id, NULL AS extension, url_template, headers_json, backup_urls_json, NULL AS episode_number
       FROM live WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'movie', provider_id, extension, url_template, headers_json, backup_urls_json, NULL
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'series', provider_id, extension, url_template, headers_json, backup_urls_json, episode
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
    ...(r.episode_number !== null ? { episodeNumber: r.episode_number } : {}),
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
