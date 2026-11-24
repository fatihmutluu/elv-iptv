import type { SqlDriver, SqlValue } from '@elv/domain';
import {
  type ActiveParentalFilter,
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
} from './parental-repo';
import {
  type CursorPage,
  ITEM_COLS,
  type ItemRow,
  type ItemsCursor,
  LIVE_EFFECTIVE_NAME_EXPR,
  LIVE_EFFECTIVE_SORT_TITLE_EXPR,
  LIVE_OVERRIDE_META_COLS,
  type ListItemsOptions,
  liveOverrideHiddenClause,
  mapItemRow,
  type RawItemRow,
  resolveQueryProfileId,
  watchedFilterClause,
} from './queries-shared';

const LETTER_CASE_EXPR = (col: string) =>
  `CASE WHEN substr(COALESCE(${col}, ''), 1, 1) < 'a' THEN '#' WHEN substr(COALESCE(${col}, ''), 1, 1) <= 'z' THEN upper(substr(COALESCE(${col}, ''), 1, 1)) ELSE '…' END`;

/**
 * @internal Queries one page of live channels belonging to a user-defined custom group (`__custom:<groupId>`),
 * ordered by `custom_group_items.position` (or effective alphabetical order when `sortBy: 'alpha'`),
 * applying per-profile `channel_overrides` and active parental controls (`#60`, `#31`).
 */
export async function queryCustomGroupItemsPage(
  db: SqlDriver,
  groupId: string,
  offset: number,
  limit: number,
  opts: ListItemsOptions | undefined,
  filter: ActiveParentalFilter | null,
): Promise<ItemRow[]> {
  const profileId = resolveQueryProfileId(opts?.profileId);
  const includeHidden = opts?.includeHidden === true;
  const groupHiddenClause = includeHidden ? '' : ' AND g.is_hidden = 0';
  const overrideHidden = liveOverrideHiddenClause(includeHidden);
  const watched = watchedFilterClause('t.key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 't.source_id', 't.key');
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');

  if (opts?.collapseVariants === true) {
    const groupExpr = "t.source_id, COALESCE(NULLIF(t.variant_base_fold, ''), t.key)";
    const orderBy =
      opts.sortBy === 'alpha' ? 'eff_sort_title ASC, key ASC' : 'group_pos ASC, key ASC';
    const rows = await db.all<RawItemRow>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.source_id, t.provider_id,
                ${LIVE_EFFECTIVE_NAME_EXPR} AS name,
                ${LIVE_OVERRIDE_META_COLS},
                ${LIVE_EFFECTIVE_SORT_TITLE_EXPR} AS eff_sort_title,
                ${ITEM_COLS.live},
                COUNT(*) OVER (PARTITION BY ${groupExpr}) AS variant_count,
                ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY t.quality_rank DESC, cgi.position ASC, t.key ASC) AS rn,
                MIN(cgi.position) OVER (PARTITION BY ${groupExpr}) AS group_pos
           FROM custom_group_items cgi
           JOIN custom_groups g ON g.id = cgi.group_id
           JOIN live t ON t.source_id = cgi.source_id AND t.key = cgi.item_key
           JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
           LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = t.key
          WHERE cgi.group_id = ? AND g.profile_id = ?${groupHiddenClause}
            AND t.is_hidden = 0${overrideHidden}${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, source_id, provider_id, name, original_name, co_is_hidden, co_sort_order,
              logo, rating, year, num, catchup_days, variant_count
         FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [groupId, profileId, ...watched.params, ...restrict.params, limit, offset],
    );
    return rows.map((r) => mapItemRow('live', r.source_id ?? '', r));
  }

  const orderBy =
    opts?.sortBy === 'alpha'
      ? `${LIVE_EFFECTIVE_SORT_TITLE_EXPR} ASC, t.key ASC`
      : 'cgi.position ASC, t.id ASC';
  const rows = await db.all<RawItemRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id,
            ${LIVE_EFFECTIVE_NAME_EXPR} AS name,
            ${LIVE_OVERRIDE_META_COLS},
            ${ITEM_COLS.live}
       FROM custom_group_items cgi
       JOIN custom_groups g ON g.id = cgi.group_id
       JOIN live t ON t.source_id = cgi.source_id AND t.key = cgi.item_key
       JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
       LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = t.key
      WHERE cgi.group_id = ? AND g.profile_id = ?${groupHiddenClause}
        AND t.is_hidden = 0${overrideHidden}${watched.clause}${restrict.clause}${adultExcl}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [groupId, profileId, ...watched.params, ...restrict.params, limit, offset],
  );
  return rows.map((r) => mapItemRow('live', r.source_id ?? '', r));
}

/**
 * @internal Key-cursor pagination over a custom group's live channels in `(position, item_key)` order (`#60`).
 */
export async function queryCustomGroupItemsByCursor(
  db: SqlDriver,
  groupId: string,
  cursor: ItemsCursor | undefined,
  limit: number,
  opts:
    | Pick<
        ListItemsOptions,
        | 'excludeWatched'
        | 'profileId'
        | 'parentalUnlocked'
        | 'collapseVariants'
        | 'groupVersions'
        | 'includeHidden'
      >
    | undefined,
  filter: ActiveParentalFilter | null,
): Promise<CursorPage<ItemRow, ItemsCursor>> {
  const profileId = resolveQueryProfileId(opts?.profileId);
  const includeHidden = opts?.includeHidden === true;
  const groupHiddenClause = includeHidden ? '' : ' AND g.is_hidden = 0';
  const overrideHidden = liveOverrideHiddenClause(includeHidden);
  const watched = watchedFilterClause('t.key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 't.source_id', 't.key');
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');
  const batchLimit = limit + 1;

  let rows: Array<RawItemRow & { _pos: number }>;
  if (opts?.collapseVariants === true) {
    const groupExpr = "t.source_id, COALESCE(NULLIF(t.variant_base_fold, ''), t.key)";
    const cursorClause = cursor ? ' AND (group_pos > ? OR (group_pos = ? AND key > ?))' : '';
    const cursorParams = cursor ? [cursor.position, cursor.position, cursor.itemKey] : [];
    rows = await db.all<RawItemRow & { _pos: number }>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.source_id, t.provider_id,
                ${LIVE_EFFECTIVE_NAME_EXPR} AS name,
                ${LIVE_OVERRIDE_META_COLS},
                ${ITEM_COLS.live},
                COUNT(*) OVER (PARTITION BY ${groupExpr}) AS variant_count,
                ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY t.quality_rank DESC, cgi.position ASC, t.key ASC) AS rn,
                MIN(cgi.position) OVER (PARTITION BY ${groupExpr}) AS group_pos
           FROM custom_group_items cgi
           JOIN custom_groups g ON g.id = cgi.group_id
           JOIN live t ON t.source_id = cgi.source_id AND t.key = cgi.item_key
           JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
           LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = t.key
          WHERE cgi.group_id = ? AND g.profile_id = ?${groupHiddenClause}
            AND t.is_hidden = 0${overrideHidden}${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, source_id, provider_id, name, original_name, co_is_hidden, co_sort_order,
              logo, rating, year, num, catchup_days, variant_count, group_pos AS _pos
         FROM ranked
        WHERE rn = 1${cursorClause}
        ORDER BY group_pos ASC, key ASC
        LIMIT ?`,
      [groupId, profileId, ...watched.params, ...restrict.params, ...cursorParams, batchLimit],
    );
  } else {
    const cursorClause = cursor
      ? ' AND (cgi.position > ? OR (cgi.position = ? AND cgi.item_key > ?))'
      : '';
    const cursorParams = cursor ? [cursor.position, cursor.position, cursor.itemKey] : [];
    rows = await db.all<RawItemRow & { _pos: number }>(
      `SELECT t.id, t.key, t.source_id, t.provider_id,
              ${LIVE_EFFECTIVE_NAME_EXPR} AS name,
              ${LIVE_OVERRIDE_META_COLS},
              ${ITEM_COLS.live},
              cgi.position AS _pos
         FROM custom_group_items cgi
         JOIN custom_groups g ON g.id = cgi.group_id
         JOIN live t ON t.source_id = cgi.source_id AND t.key = cgi.item_key
         JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
         LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = t.key
        WHERE cgi.group_id = ? AND g.profile_id = ?${groupHiddenClause}
          AND t.is_hidden = 0${overrideHidden}${cursorClause}${watched.clause}${restrict.clause}${adultExcl}
        ORDER BY cgi.position ASC, cgi.item_key ASC
        LIMIT ?`,
      [groupId, profileId, ...cursorParams, ...watched.params, ...restrict.params, batchLimit],
    );
  }

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map((r) => mapItemRow('live', r.source_id ?? '', r)),
    nextCursor: hasMore && last !== undefined ? { position: last._pos, itemKey: last.key } : null,
    hasMore,
  };
}

/** @internal Computes alphabet bucket rows for a custom group (`__custom:<groupId>`). */
export async function queryCustomGroupAlphabetRows(
  db: SqlDriver,
  groupId: string,
  opts: {
    readonly profileId?: string;
    readonly includeHidden?: boolean;
    readonly collapseVariants?: boolean;
    readonly excludeWatched?: boolean;
  },
  filter: ActiveParentalFilter | null,
): Promise<readonly { letter: string; count: number }[]> {
  const profileId = resolveQueryProfileId(opts.profileId);
  const includeHidden = opts.includeHidden === true;
  const groupHiddenClause = includeHidden ? '' : ' AND g.is_hidden = 0';
  const overrideHidden = liveOverrideHiddenClause(includeHidden);
  const watched = watchedFilterClause('t.key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, 'live', 't.source_id', 't.key');
  const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');

  if (opts.collapseVariants === true) {
    const groupExpr = "t.source_id, COALESCE(NULLIF(t.variant_base_fold, ''), t.key)";
    return db.all<{ letter: string; count: number }>(
      `WITH ranked AS (
         SELECT ${LIVE_EFFECTIVE_SORT_TITLE_EXPR} AS eff_sort_title,
                ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY t.quality_rank DESC, cgi.position ASC, t.key ASC) AS rn
           FROM custom_group_items cgi
           JOIN custom_groups g ON g.id = cgi.group_id
           JOIN live t ON t.source_id = cgi.source_id AND t.key = cgi.item_key
           JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
           LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = t.key
          WHERE cgi.group_id = ? AND g.profile_id = ?${groupHiddenClause}
            AND t.is_hidden = 0${overrideHidden}${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT ${LETTER_CASE_EXPR('eff_sort_title')} AS letter, COUNT(*) AS count
         FROM ranked
        WHERE rn = 1
        GROUP BY letter`,
      [groupId, profileId, ...watched.params, ...restrict.params],
    );
  }

  return db.all<{ letter: string; count: number }>(
    `SELECT ${LETTER_CASE_EXPR(LIVE_EFFECTIVE_SORT_TITLE_EXPR)} AS letter, COUNT(*) AS count
       FROM custom_group_items cgi
       JOIN custom_groups g ON g.id = cgi.group_id
       JOIN live t ON t.source_id = cgi.source_id AND t.key = cgi.item_key
       JOIN sources s ON s.id = cgi.source_id AND s.deleting = 0
       LEFT JOIN channel_overrides co ON co.profile_id = g.profile_id AND co.item_key = t.key
      WHERE cgi.group_id = ? AND g.profile_id = ?${groupHiddenClause}
        AND t.is_hidden = 0${overrideHidden}${watched.clause}${restrict.clause}${adultExcl}
      GROUP BY letter`,
    [groupId, profileId, ...watched.params, ...restrict.params],
  );
}
