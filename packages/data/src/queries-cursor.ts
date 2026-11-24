import type { SqlDriver, SqlValue } from '@elv/domain';
import { parseCustomGroupCategoryId } from './custom-groups-repo';
import {
  type ActiveParentalFilter,
  buildSqlAdultKeywordExclusionClause,
  buildSqlItemRestrictionClause,
  isCategoryRestricted,
  loadActiveParentalFilter,
} from './parental-repo';
import { queryCustomGroupItemsByCursor } from './queries-custom-groups';
import {
  type BrowseKind,
  type CursorPage,
  clampPage,
  ITEM_COLS,
  ITEM_TABLE,
  type ItemRow,
  type ItemsCursor,
  LIVE_EFFECTIVE_NAME_EXPR,
  LIVE_MANUAL_CURSOR_OFFSET,
  LIVE_OVERRIDE_JOIN,
  LIVE_OVERRIDE_META_COLS,
  type ListItemsOptions,
  liveOverrideHiddenClause,
  mapItemRow,
  parseCategoryId,
  type RawItemRow,
  resolveQueryProfileId,
  watchedFilterClause,
} from './queries-shared';

export type { CursorPage, ItemsCursor };

function dedupCursorSpec(
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

async function fetchRawCursorBatch(
  db: SqlDriver,
  ref: { sourceId: string; kind: BrowseKind; providerId: string },
  cursor: ItemsCursor | undefined,
  batchLimit: number,
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
): Promise<Array<RawItemRow & { _pos: number }>> {
  const table = ITEM_TABLE[ref.kind];
  const isLive = ref.kind === 'live';
  const profileId = resolveQueryProfileId(opts?.profileId);
  const liveJoin = isLive ? `\n           ${LIVE_OVERRIDE_JOIN}` : '';
  const liveJoinParams: SqlValue[] = isLive ? [profileId] : [];
  const liveHidden = isLive ? liveOverrideHiddenClause(opts?.includeHidden) : '';
  const nameExpr = isLive
    ? `${LIVE_EFFECTIVE_NAME_EXPR} AS name, ${LIVE_OVERRIDE_META_COLS}`
    : 't.name';
  const metaSelect = isLive ? ', original_name, co_is_hidden, co_sort_order' : '';
  const effPosExpr = isLive
    ? `CASE WHEN co.sort_order IS NOT NULL THEN co.sort_order - ${LIVE_MANUAL_CURSOR_OFFSET} ELSE p.position END`
    : 'p.position';
  const dedup = dedupCursorSpec(ref.kind, opts);
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
         SELECT t.id, t.key, t.provider_id, ${nameExpr}, ${ITEM_COLS[ref.kind]},
                COUNT(*) OVER (PARTITION BY ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn,
                MIN(${effPosExpr}) OVER (PARTITION BY ${dedup.groupExpr}) AS group_pos
           FROM placements p
           JOIN ${table} t ON t.source_id = p.source_id AND t.key = p.item_key${liveJoin}
          WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0${liveHidden}
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, provider_id, name${metaSelect}, logo, rating, year, num, catchup_days, ${dedup.countCol}, group_pos AS _pos
         FROM ranked
        WHERE rn = 1${cursorClause}
        ORDER BY group_pos ASC, key ASC
        LIMIT ?`,
      [
        ...liveJoinParams,
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
  if (isLive) {
    const watched = watchedFilterClause('t.key', opts);
    const restrict =
      filter === null
        ? { clause: '', params: [] as readonly SqlValue[] }
        : buildSqlItemRestrictionClause(filter, 'live', 'p.source_id', 't.key', ref.sourceId);
    const adultExcl = buildSqlAdultKeywordExclusionClause(filter, 't.name', 't.name_fold');
    const cursorClause = cursor ? ' WHERE (_pos > ? OR (_pos = ? AND key > ?))' : '';
    const cursorParams = cursor ? [cursor.position, cursor.position, cursor.itemKey] : [];
    return db.all<RawItemRow & { _pos: number }>(
      `WITH projected AS (
         SELECT t.id, t.key, t.provider_id, ${nameExpr}, ${ITEM_COLS.live}, ${effPosExpr} AS _pos
           FROM placements p
           JOIN live t ON t.source_id = p.source_id AND t.key = p.item_key
           ${LIVE_OVERRIDE_JOIN}
          WHERE p.source_id = ? AND p.kind = 'live' AND p.category_id = ? AND p.is_hidden = 0 AND t.is_hidden = 0${liveHidden}
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND s.deleting = 0)${watched.clause}${restrict.clause}${adultExcl}
       )
       SELECT id, key, provider_id, name, original_name, co_is_hidden, co_sort_order, logo, rating, year, num, catchup_days, _pos
         FROM projected${cursorClause}
        ORDER BY _pos ASC, key ASC
        LIMIT ?`,
      [
        profileId,
        ref.sourceId,
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
 * One key-cursor page of a category's or custom group's (`__custom:<groupId>`) visible items in `(position, item_key)` order (`#176`, `#60`).
 * Backed by `idx_placements_visible` with `limit + 1` lookahead for exact `hasMore`.
 */
export async function queryItemsByCursor(
  db: SqlDriver,
  categoryIdInput: string | { sourceId: string; kind: BrowseKind; providerId: string },
  cursor: ItemsCursor | undefined,
  limit: number,
  opts?: Pick<
    ListItemsOptions,
    | 'excludeWatched'
    | 'profileId'
    | 'parentalUnlocked'
    | 'collapseVariants'
    | 'groupVersions'
    | 'includeHidden'
  >,
): Promise<CursorPage<ItemRow, ItemsCursor>> {
  const page = clampPage(0, limit);
  if (page.limit === 0) return { items: [], nextCursor: null, hasMore: false };
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (typeof categoryIdInput === 'string') {
    const customGroupId = parseCustomGroupCategoryId(categoryIdInput);
    if (customGroupId !== undefined) {
      return queryCustomGroupItemsByCursor(db, customGroupId, cursor, page.limit, opts, filter);
    }
  }
  const ref =
    typeof categoryIdInput === 'string' ? parseCategoryId(categoryIdInput) : categoryIdInput;
  if (ref === undefined) return { items: [], nextCursor: null, hasMore: false };
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
