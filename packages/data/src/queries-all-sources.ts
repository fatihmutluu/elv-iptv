import type { SqlDriver, SqlValue } from '@elv/domain';
import { isAdultKeywordMatch } from './parental-policy';
import {
  type ActiveParentalFilter,
  buildSqlItemRestrictionClause,
  loadActiveParentalFilter,
} from './parental-repo';
import {
  type BrowseKind,
  clampPage,
  ITEM_COLS,
  ITEM_TABLE,
  type ItemRow,
  type ListItemsOptions,
  mapItemRow,
  type RawItemRow,
  watchedFilterClause,
} from './queries-shared';

/**
 * Water-fills `target` slots across sources with available capacities `counts`, distributing
 * `floor(remaining / activeCount)` evenly and redistributing deficit whenever smaller sources
 * exhaust early. Strictly monotonic in `target`, guaranteeing zero gaps and zero duplicates
 * across consecutive `(offset, limit)` pages.
 */
export function allocateFairQuotas(counts: readonly number[], target: number): number[] {
  const alloc = counts.map(() => 0);
  let remaining = Math.max(0, Math.floor(target));
  let active = counts.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);

  while (remaining > 0 && active.length > 0) {
    if (remaining >= active.length) {
      const base = Math.floor(remaining / active.length);
      for (const idx of active) {
        const cap = (counts[idx] ?? 0) - (alloc[idx] ?? 0);
        const take = Math.min(base, cap);
        alloc[idx] = (alloc[idx] ?? 0) + take;
        remaining -= take;
      }
      active = active.filter((idx) => (alloc[idx] ?? 0) < (counts[idx] ?? 0));
    } else {
      for (const idx of active) {
        if (remaining === 0) break;
        alloc[idx] = (alloc[idx] ?? 0) + 1;
        remaining -= 1;
      }
      break;
    }
  }
  return alloc;
}

async function resolveActiveSources(
  db: SqlDriver,
  sourceIds?: readonly string[],
): Promise<string[]> {
  if (sourceIds !== undefined) {
    const unique = [...new Set(sourceIds.filter((id) => id !== ''))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await db.all<{ id: string }>(
      `SELECT id FROM sources WHERE deleting = 0 AND id IN (${placeholders}) ORDER BY created_at, id`,
      unique,
    );
    return rows.map((r) => r.id);
  }
  const rows = await db.all<{ id: string }>(
    'SELECT id FROM sources WHERE deleting = 0 ORDER BY created_at, id',
  );
  return rows.map((r) => r.id);
}

function allSourcesDedupSpec(
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
      rankOrder: 't.quality_rank DESC, t.id ASC, t.key ASC',
      countCol: 'variant_count',
    };
  }
  if (kind === 'movie' && opts?.groupVersions === true) {
    return {
      groupExpr: "COALESCE(NULLIF(t.version_group_key, ''), t.key)",
      rankOrder: 't.id ASC, t.key ASC',
      countCol: 'version_count',
    };
  }
  return undefined;
}

async function fetchRawSourceSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  offset: number,
  limit: number,
  opts: ListItemsOptions | undefined,
  filter: ActiveParentalFilter | null,
): Promise<RawItemRow[]> {
  if (limit <= 0) return [];
  const watched = watchedFilterClause('t.key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', sourceId);
  const dedup = allSourcesDedupSpec(kind, opts);
  if (dedup !== undefined) {
    const orderBy = opts?.sortBy === 'alpha' ? 'sort_title ASC, key ASC' : 'name_fold ASC, id ASC';
    return db.all<RawItemRow>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, t.sort_title, ${ITEM_COLS[kind]},
                COUNT(*) OVER (PARTITION BY ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
           FROM ${ITEM_TABLE[kind]} t
          WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}${restrict.clause}
       )
       SELECT id, key, source_id, provider_id, name, logo, rating, year, num, ${dedup.countCol}
         FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [sourceId, ...watched.params, ...restrict.params, limit, offset],
    );
  }
  const orderBy =
    opts?.sortBy === 'alpha' ? 't.sort_title ASC, t.key ASC' : 't.name_fold ASC, t.id ASC';
  return db.all<RawItemRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${ITEM_COLS[kind]}
       FROM ${ITEM_TABLE[kind]} t
      WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}${restrict.clause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [sourceId, ...watched.params, ...restrict.params, limit, offset],
  );
}

async function fetchSourceSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  offset: number,
  limit: number,
  opts: ListItemsOptions | undefined,
  filter: ActiveParentalFilter | null,
): Promise<ItemRow[]> {
  if (limit <= 0) return [];
  if (filter === null || !filter.blockAdultKeywords) {
    const rows = await fetchRawSourceSlice(db, kind, sourceId, offset, limit, opts, filter);
    return rows.map((r) => mapItemRow(kind, sourceId, r));
  }
  const chunkSize = Math.max(limit * 2, 64);
  const out: ItemRow[] = [];
  let rawOffset = 0;
  let skipped = 0;
  for (;;) {
    const batch = await fetchRawSourceSlice(db, kind, sourceId, rawOffset, chunkSize, opts, filter);
    if (batch.length === 0) break;
    rawOffset += batch.length;
    for (const r of batch) {
      if (isAdultKeywordMatch(r.name)) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      out.push(mapItemRow(kind, sourceId, r));
      if (out.length >= limit) return out;
    }
    if (batch.length < chunkSize) break;
  }
  return out;
}

function interleaveSlices(
  buckets: readonly (readonly ItemRow[])[],
  startAlloc: readonly number[],
  endAlloc: readonly number[],
): ItemRow[] {
  const out: ItemRow[] = [];
  const level = [...startAlloc];
  const cursor = buckets.map(() => 0);

  for (;;) {
    let minLevel = Number.POSITIVE_INFINITY;
    for (let i = 0; i < buckets.length; i += 1) {
      const lv = level[i] ?? 0;
      const end = endAlloc[i] ?? 0;
      if (lv < end && (cursor[i] ?? 0) < (buckets[i]?.length ?? 0) && lv < minLevel) {
        minLevel = lv;
      }
    }
    if (!Number.isFinite(minLevel)) break;
    for (let i = 0; i < buckets.length; i += 1) {
      if ((level[i] ?? 0) !== minLevel) continue;
      const end = endAlloc[i] ?? 0;
      const pos = cursor[i] ?? 0;
      const item = buckets[i]?.[pos];
      if ((level[i] ?? 0) < end && item !== undefined) {
        out.push(item);
        cursor[i] = pos + 1;
        level[i] = minLevel + 1;
      }
    }
  }
  return out;
}

/** One key-cursor page of a source's visible catalog items ordered by `id ASC` (`#176`). */
export async function queryCatalogByIdCursor(
  db: SqlDriver,
  sourceId: string,
  kind: BrowseKind,
  afterId: number,
  limit: number,
): Promise<ItemRow[]> {
  const page = clampPage(0, limit);
  if (page.limit === 0) return [];
  const cursorId = Number.isFinite(afterId) ? Math.floor(afterId) : 0;
  // Unary `+t.source_id` prevents SQLite from choosing secondary `(source_id, ...)` indexes that require TEMP B-TREE sorting.
  const rows = await db.all<RawItemRow>(
    `SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_COLS[kind]}
       FROM ${ITEM_TABLE[kind]} t
      WHERE +t.source_id = ? AND t.is_hidden = 0 AND t.id > ?
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = ? AND s.deleting = 0)
      ORDER BY t.id ASC
      LIMIT ?`,
    [sourceId, cursorId, sourceId, page.limit],
  );
  return rows.map((r) => mapItemRow(kind, sourceId, r));
}

/** Per-source key-cursor for drift-free multi-source pagination (`#176`). */
export interface SourceNameCursor {
  readonly nameFold: string;
  readonly id: number;
}

/** One page returned by {@link queryAllSourcesItemsByCursor}. */
export interface AllSourcesCursorPage {
  readonly items: ItemRow[];
  readonly nextCursors: Record<string, SourceNameCursor>;
  readonly hasMore: boolean;
}

interface CursorRawItemRow extends RawItemRow {
  name_fold: string;
}

async function fetchRawSourceCursorSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  cursor: SourceNameCursor | undefined,
  limit: number,
  opts: Pick<ListItemsOptions, 'excludeWatched' | 'profileId' | 'parentalUnlocked'> | undefined,
  filter: ActiveParentalFilter | null,
): Promise<CursorRawItemRow[]> {
  if (limit <= 0) return [];
  const table = ITEM_TABLE[kind];
  const watched = watchedFilterClause('t.key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', sourceId);
  return cursor === undefined
    ? db.all<CursorRawItemRow>(
        `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, ${ITEM_COLS[kind]}
           FROM ${table} t
          WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}${restrict.clause}
          ORDER BY t.name_fold ASC, t.id ASC
          LIMIT ?`,
        [sourceId, ...watched.params, ...restrict.params, limit],
      )
    : db.all<CursorRawItemRow>(
        `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, ${ITEM_COLS[kind]}
           FROM ${table} t
          WHERE t.source_id = ? AND t.is_hidden = 0
            AND (t.name_fold > ? OR (t.name_fold = ? AND t.id > ?))${watched.clause}${restrict.clause}
          ORDER BY t.name_fold ASC, t.id ASC
          LIMIT ?`,
        [
          sourceId,
          cursor.nameFold,
          cursor.nameFold,
          cursor.id,
          ...watched.params,
          ...restrict.params,
          limit,
        ],
      );
}

async function fetchSourceCursorSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  cursor: SourceNameCursor | undefined,
  limit: number,
  opts: Pick<ListItemsOptions, 'excludeWatched' | 'profileId' | 'parentalUnlocked'> | undefined,
  filter: ActiveParentalFilter | null,
): Promise<{ rows: ItemRow[]; cursors: SourceNameCursor[] }> {
  if (limit <= 0) return { rows: [], cursors: [] };
  if (filter === null || !filter.blockAdultKeywords) {
    const raw = await fetchRawSourceCursorSlice(db, kind, sourceId, cursor, limit, opts, filter);
    return {
      rows: raw.map((r) => mapItemRow(kind, sourceId, r)),
      cursors: raw.map((r) => ({ nameFold: r.name_fold, id: r.id })),
    };
  }
  const rows: ItemRow[] = [];
  const cursors: SourceNameCursor[] = [];
  const batchSize = Math.max(limit * 2, 64);
  let scanCursor = cursor;
  for (;;) {
    const raw = await fetchRawSourceCursorSlice(
      db,
      kind,
      sourceId,
      scanCursor,
      batchSize,
      opts,
      filter,
    );
    if (raw.length === 0) break;
    for (const r of raw) {
      if (isAdultKeywordMatch(r.name)) continue;
      rows.push(mapItemRow(kind, sourceId, r));
      cursors.push({ nameFold: r.name_fold, id: r.id });
      if (rows.length >= limit) return { rows, cursors };
    }
    if (raw.length < batchSize) break;
    const tail = raw[raw.length - 1];
    if (tail === undefined) break;
    scanCursor = { nameFold: tail.name_fold, id: tail.id };
  }
  return { rows, cursors };
}

/**
 * Queries visible items (`is_hidden = 0`) of `kind` across active (`sources.deleting = 0`)
 * sources using fair per-source quotas and drift-free `(nameFold, id)` key cursors (`#176`).
 */
export async function queryAllSourcesItemsByCursor(
  db: SqlDriver,
  kind: BrowseKind,
  cursors: Readonly<Record<string, SourceNameCursor>>,
  limit: number,
  sourceIds?: readonly string[],
  opts?: Pick<ListItemsOptions, 'excludeWatched' | 'profileId' | 'parentalUnlocked'>,
): Promise<AllSourcesCursorPage> {
  const page = clampPage(0, limit);
  const nextCursors: Record<string, SourceNameCursor> = { ...cursors };
  if (page.limit === 0) return { items: [], nextCursors, hasMore: false };
  const activeIds = await resolveActiveSources(db, sourceIds);
  if (activeIds.length === 0) return { items: [], nextCursors, hasMore: false };
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);

  if (activeIds.length === 1) {
    const id = activeIds[0] ?? '';
    const slice = await fetchSourceCursorSlice(
      db,
      kind,
      id,
      cursors[id],
      page.limit + 1,
      opts,
      filter,
    );
    const hasMore = slice.rows.length > page.limit;
    const items = hasMore ? slice.rows.slice(0, page.limit) : slice.rows;
    const lastCursor = slice.cursors[items.length - 1];
    if (lastCursor !== undefined) nextCursors[id] = lastCursor;
    return { items, nextCursors, hasMore };
  }

  const cap = page.limit + 1;
  const table = ITEM_TABLE[kind];
  const watched = watchedFilterClause('t.key', opts);
  const counts = await Promise.all(
    activeIds.map(async (id) => {
      if (filter?.blockAdultKeywords) {
        const probe = await fetchSourceCursorSlice(db, kind, id, cursors[id], cap, opts, filter);
        return probe.rows.length;
      }
      const restrict =
        filter === null
          ? { clause: '', params: [] as readonly SqlValue[] }
          : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', id);
      const c = cursors[id];
      const rows =
        c === undefined
          ? await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM ${table} t WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}${restrict.clause} LIMIT ?
               )`,
              [id, ...watched.params, ...restrict.params, cap],
            )
          : await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM ${table} t
                  WHERE t.source_id = ? AND t.is_hidden = 0
                    AND (t.name_fold > ? OR (t.name_fold = ? AND t.id > ?))${watched.clause}${restrict.clause}
                  LIMIT ?
               )`,
              [id, c.nameFold, c.nameFold, c.id, ...watched.params, ...restrict.params, cap],
            );
      return rows[0]?.n ?? 0;
    }),
  );

  const quotas = allocateFairQuotas(counts, page.limit);
  const slices = await Promise.all(
    activeIds.map((id, i) =>
      fetchSourceCursorSlice(db, kind, id, cursors[id], quotas[i] ?? 0, opts, filter),
    ),
  );
  for (let i = 0; i < activeIds.length; i += 1) {
    const id = activeIds[i] ?? '';
    const sliceCursors = slices[i]?.cursors;
    const last = sliceCursors?.[sliceCursors.length - 1];
    if (last !== undefined) nextCursors[id] = last;
  }

  const zeros = activeIds.map(() => 0);
  const items = interleaveSlices(
    slices.map((s) => s.rows),
    zeros,
    quotas,
  );
  const hasMore = counts.some((c, i) => c > (quotas[i] ?? 0));
  return { items, nextCursors, hasMore };
}

async function fetchRawGlobalAlphaSlice(
  db: SqlDriver,
  kind: BrowseKind,
  activeIds: readonly string[],
  offset: number,
  limit: number,
  opts: ListItemsOptions | undefined,
  filter: ActiveParentalFilter | null,
): Promise<RawItemRow[]> {
  if (limit <= 0 || activeIds.length === 0) return [];
  const table = ITEM_TABLE[kind];
  const placeholders = activeIds.map(() => '?').join(', ');
  const watched = watchedFilterClause('t.key', opts);
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key');
  const dedup = allSourcesDedupSpec(kind, opts);
  if (dedup !== undefined) {
    return db.all<RawItemRow>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, t.sort_title, ${ITEM_COLS[kind]},
                COUNT(*) OVER (PARTITION BY t.source_id, ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY t.source_id, ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
           FROM ${table} t
          WHERE t.source_id IN (${placeholders}) AND t.is_hidden = 0${watched.clause}${restrict.clause}
       )
       SELECT id, key, source_id, provider_id, name, logo, rating, year, num, ${dedup.countCol}
         FROM ranked
        WHERE rn = 1
        ORDER BY sort_title ASC, key ASC
        LIMIT ? OFFSET ?`,
      [...activeIds, ...watched.params, ...restrict.params, limit, offset],
    );
  }
  return db.all<RawItemRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${ITEM_COLS[kind]}
       FROM ${table} t
      WHERE t.source_id IN (${placeholders}) AND t.is_hidden = 0${watched.clause}${restrict.clause}
      ORDER BY t.sort_title ASC, t.key ASC
      LIMIT ? OFFSET ?`,
    [...activeIds, ...watched.params, ...restrict.params, limit, offset],
  );
}

async function fetchGlobalAlphaSlice(
  db: SqlDriver,
  kind: BrowseKind,
  activeIds: readonly string[],
  offset: number,
  limit: number,
  opts: ListItemsOptions | undefined,
  filter: ActiveParentalFilter | null,
): Promise<ItemRow[]> {
  if (limit <= 0 || activeIds.length === 0) return [];
  if (filter === null || !filter.blockAdultKeywords) {
    const rows = await fetchRawGlobalAlphaSlice(db, kind, activeIds, offset, limit, opts, filter);
    return rows.map((r) => mapItemRow(kind, r.source_id ?? '', r));
  }
  const chunkSize = Math.max(limit * 2, 64);
  const out: ItemRow[] = [];
  let rawOffset = 0;
  let skipped = 0;
  for (;;) {
    const batch = await fetchRawGlobalAlphaSlice(
      db,
      kind,
      activeIds,
      rawOffset,
      chunkSize,
      opts,
      filter,
    );
    if (batch.length === 0) break;
    rawOffset += batch.length;
    for (const r of batch) {
      if (isAdultKeywordMatch(r.name)) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      out.push(mapItemRow(kind, r.source_id ?? '', r));
      if (out.length >= limit) return out;
    }
    if (batch.length < chunkSize) break;
  }
  return out;
}

/**
 * Queries visible items (`is_hidden = 0`) of `kind` across active (`sources.deleting = 0`)
 * sources. Uses global `ORDER BY sort_title ASC, key ASC` when `opts?.sortBy === 'alpha'` so
 * all-sources alphabetical browsing aligns 1:1 with `queryAlphabetIndex`, and fair per-source
 * quotas (`floor(limit / activeSourceCount)` with remainder redistribution) for `'default'` order.
 */
export async function queryAllSourcesItems(
  db: SqlDriver,
  kind: BrowseKind,
  offset: number,
  limit: number,
  sourceIds?: readonly string[],
  opts?: ListItemsOptions,
): Promise<ItemRow[]> {
  const page = clampPage(offset, limit);
  if (page.limit === 0) return [];
  const activeIds = await resolveActiveSources(db, sourceIds);
  if (activeIds.length === 0) return [];
  const filter = await loadActiveParentalFilter(db, opts?.profileId, opts?.parentalUnlocked);
  if (activeIds.length === 1) {
    return fetchSourceSlice(db, kind, activeIds[0] ?? '', page.offset, page.limit, opts, filter);
  }
  if (opts?.sortBy === 'alpha') {
    return fetchGlobalAlphaSlice(db, kind, activeIds, page.offset, page.limit, opts, filter);
  }

  const endTarget = page.offset + page.limit;
  const table = ITEM_TABLE[kind];
  const watched = watchedFilterClause('t.key', opts);
  const dedup = allSourcesDedupSpec(kind, opts);
  const counts = await Promise.all(
    activeIds.map(async (id) => {
      if (filter?.blockAdultKeywords) {
        const probe = await fetchSourceSlice(db, kind, id, 0, endTarget, opts, filter);
        return probe.length;
      }
      const restrict =
        filter === null
          ? { clause: '', params: [] as readonly SqlValue[] }
          : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', id);
      const rows =
        dedup === undefined
          ? await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM ${table} t WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}${restrict.clause} LIMIT ?
               )`,
              [id, ...watched.params, ...restrict.params, endTarget],
            )
          : await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM (
                   SELECT ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
                     FROM ${table} t
                    WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}${restrict.clause}
                 ) WHERE rn = 1 LIMIT ?
               )`,
              [id, ...watched.params, ...restrict.params, endTarget],
            );
      return rows[0]?.n ?? 0;
    }),
  );

  const startAlloc = allocateFairQuotas(counts, page.offset);
  const endAlloc = allocateFairQuotas(counts, endTarget);

  const buckets = await Promise.all(
    activeIds.map((id, i) => {
      const start = startAlloc[i] ?? 0;
      const count = (endAlloc[i] ?? 0) - start;
      return fetchSourceSlice(db, kind, id, start, count, opts, filter);
    }),
  );

  return interleaveSlices(buckets, startAlloc, endAlloc);
}
