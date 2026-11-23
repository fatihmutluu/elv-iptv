import type { SqlDriver } from '@elv/domain';
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

async function fetchSourceSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  offset: number,
  limit: number,
  opts?: ListItemsOptions,
): Promise<ItemRow[]> {
  if (limit <= 0) return [];
  const watched = watchedFilterClause('t.key', opts);
  const dedup = allSourcesDedupSpec(kind, opts);
  if (dedup !== undefined) {
    const orderBy = opts?.sortBy === 'alpha' ? 'sort_title ASC, key ASC' : 'name_fold ASC, id ASC';
    const rows = await db.all<RawItemRow>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, t.sort_title, ${ITEM_COLS[kind]},
                COUNT(*) OVER (PARTITION BY ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
           FROM ${ITEM_TABLE[kind]} t
          WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}
       )
       SELECT id, key, source_id, provider_id, name, logo, rating, year, num, ${dedup.countCol}
         FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [sourceId, ...watched.params, limit, offset],
    );
    return rows.map((r) => mapItemRow(kind, sourceId, r));
  }
  const orderBy =
    opts?.sortBy === 'alpha' ? 't.sort_title ASC, t.key ASC' : 't.name_fold ASC, t.id ASC';
  const rows = await db.all<RawItemRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${ITEM_COLS[kind]}
       FROM ${ITEM_TABLE[kind]} t
      WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [sourceId, ...watched.params, limit, offset],
  );
  return rows.map((r) => mapItemRow(kind, sourceId, r));
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

async function fetchSourceCursorSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  cursor: SourceNameCursor | undefined,
  limit: number,
  opts?: Pick<ListItemsOptions, 'excludeWatched' | 'profileId'>,
): Promise<{ rows: ItemRow[]; cursors: SourceNameCursor[] }> {
  if (limit <= 0) return { rows: [], cursors: [] };
  const table = ITEM_TABLE[kind];
  const watched = watchedFilterClause('t.key', opts);
  const raw =
    cursor === undefined
      ? await db.all<CursorRawItemRow>(
          `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, ${ITEM_COLS[kind]}
             FROM ${table} t
            WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}
            ORDER BY t.name_fold ASC, t.id ASC
            LIMIT ?`,
          [sourceId, ...watched.params, limit],
        )
      : await db.all<CursorRawItemRow>(
          `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, ${ITEM_COLS[kind]}
             FROM ${table} t
            WHERE t.source_id = ? AND t.is_hidden = 0
              AND (t.name_fold > ? OR (t.name_fold = ? AND t.id > ?))${watched.clause}
            ORDER BY t.name_fold ASC, t.id ASC
            LIMIT ?`,
          [sourceId, cursor.nameFold, cursor.nameFold, cursor.id, ...watched.params, limit],
        );
  return {
    rows: raw.map((r) => mapItemRow(kind, sourceId, r)),
    cursors: raw.map((r) => ({ nameFold: r.name_fold, id: r.id })),
  };
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
  opts?: Pick<ListItemsOptions, 'excludeWatched' | 'profileId'>,
): Promise<AllSourcesCursorPage> {
  const page = clampPage(0, limit);
  const nextCursors: Record<string, SourceNameCursor> = { ...cursors };
  if (page.limit === 0) return { items: [], nextCursors, hasMore: false };
  const activeIds = await resolveActiveSources(db, sourceIds);
  if (activeIds.length === 0) return { items: [], nextCursors, hasMore: false };

  if (activeIds.length === 1) {
    const id = activeIds[0] ?? '';
    const slice = await fetchSourceCursorSlice(db, kind, id, cursors[id], page.limit + 1, opts);
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
      const c = cursors[id];
      const rows =
        c === undefined
          ? await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM ${table} t WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause} LIMIT ?
               )`,
              [id, ...watched.params, cap],
            )
          : await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM ${table} t
                  WHERE t.source_id = ? AND t.is_hidden = 0
                    AND (t.name_fold > ? OR (t.name_fold = ? AND t.id > ?))${watched.clause}
                  LIMIT ?
               )`,
              [id, c.nameFold, c.nameFold, c.id, ...watched.params, cap],
            );
      return rows[0]?.n ?? 0;
    }),
  );

  const quotas = allocateFairQuotas(counts, page.limit);
  const slices = await Promise.all(
    activeIds.map((id, i) =>
      fetchSourceCursorSlice(db, kind, id, cursors[id], quotas[i] ?? 0, opts),
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

async function fetchGlobalAlphaSlice(
  db: SqlDriver,
  kind: BrowseKind,
  activeIds: readonly string[],
  offset: number,
  limit: number,
  opts?: ListItemsOptions,
): Promise<ItemRow[]> {
  if (limit <= 0 || activeIds.length === 0) return [];
  const table = ITEM_TABLE[kind];
  const placeholders = activeIds.map(() => '?').join(', ');
  const watched = watchedFilterClause('t.key', opts);
  const dedup = allSourcesDedupSpec(kind, opts);
  if (dedup !== undefined) {
    const rows = await db.all<RawItemRow>(
      `WITH ranked AS (
         SELECT t.id, t.key, t.source_id, t.provider_id, t.name, t.name_fold, t.sort_title, ${ITEM_COLS[kind]},
                COUNT(*) OVER (PARTITION BY t.source_id, ${dedup.groupExpr}) AS ${dedup.countCol},
                ROW_NUMBER() OVER (PARTITION BY t.source_id, ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
           FROM ${table} t
          WHERE t.source_id IN (${placeholders}) AND t.is_hidden = 0${watched.clause}
       )
       SELECT id, key, source_id, provider_id, name, logo, rating, year, num, ${dedup.countCol}
         FROM ranked
        WHERE rn = 1
        ORDER BY sort_title ASC, key ASC
        LIMIT ? OFFSET ?`,
      [...activeIds, ...watched.params, limit, offset],
    );
    return rows.map((r) => mapItemRow(kind, r.source_id ?? '', r));
  }
  const rows = await db.all<RawItemRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${ITEM_COLS[kind]}
       FROM ${table} t
      WHERE t.source_id IN (${placeholders}) AND t.is_hidden = 0${watched.clause}
      ORDER BY t.sort_title ASC, t.key ASC
      LIMIT ? OFFSET ?`,
    [...activeIds, ...watched.params, limit, offset],
  );
  return rows.map((r) => mapItemRow(kind, r.source_id ?? '', r));
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
  if (activeIds.length === 1) {
    return fetchSourceSlice(db, kind, activeIds[0] ?? '', page.offset, page.limit, opts);
  }
  if (opts?.sortBy === 'alpha') {
    return fetchGlobalAlphaSlice(db, kind, activeIds, page.offset, page.limit, opts);
  }

  const endTarget = page.offset + page.limit;
  const table = ITEM_TABLE[kind];
  const watched = watchedFilterClause('t.key', opts);
  const dedup = allSourcesDedupSpec(kind, opts);
  const counts = await Promise.all(
    activeIds.map(async (id) => {
      const rows =
        dedup === undefined
          ? await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM ${table} t WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause} LIMIT ?
               )`,
              [id, ...watched.params, endTarget],
            )
          : await db.all<{ n: number }>(
              `SELECT COUNT(*) AS n FROM (
                 SELECT 1 FROM (
                   SELECT ROW_NUMBER() OVER (PARTITION BY ${dedup.groupExpr} ORDER BY ${dedup.rankOrder}) AS rn
                     FROM ${table} t
                    WHERE t.source_id = ? AND t.is_hidden = 0${watched.clause}
                 ) WHERE rn = 1 LIMIT ?
               )`,
              [id, ...watched.params, endTarget],
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
      return fetchSourceSlice(db, kind, id, start, count, opts);
    }),
  );

  return interleaveSlices(buckets, startAlloc, endAlloc);
}
