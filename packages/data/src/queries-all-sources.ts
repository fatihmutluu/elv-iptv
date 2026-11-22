import type { SqlDriver } from '@elv/domain';
import {
  type BrowseKind,
  clampPage,
  ITEM_COLS,
  ITEM_TABLE,
  type ItemRow,
  mapItemRow,
  type RawItemRow,
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

async function fetchSourceSlice(
  db: SqlDriver,
  kind: BrowseKind,
  sourceId: string,
  offset: number,
  limit: number,
): Promise<ItemRow[]> {
  if (limit <= 0) return [];
  const rows = await db.all<RawItemRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${ITEM_COLS[kind]}
       FROM ${ITEM_TABLE[kind]} t
      WHERE t.source_id = ? AND t.is_hidden = 0
      ORDER BY t.name_fold ASC, t.id ASC
      LIMIT ? OFFSET ?`,
    [sourceId, limit, offset],
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

/**
 * Queries visible items (`is_hidden = 0`) of `kind` across active (`sources.deleting = 0`)
 * sources using fair per-source quotas (`floor(limit / activeSourceCount)` with remainder
 * redistribution when smaller sources exhaust early) so large sources never drown out small ones.
 */
export async function queryAllSourcesItems(
  db: SqlDriver,
  kind: BrowseKind,
  offset: number,
  limit: number,
  sourceIds?: readonly string[],
): Promise<ItemRow[]> {
  const page = clampPage(offset, limit);
  if (page.limit === 0) return [];
  const activeIds = await resolveActiveSources(db, sourceIds);
  if (activeIds.length === 0) return [];
  if (activeIds.length === 1) {
    return fetchSourceSlice(db, kind, activeIds[0] ?? '', page.offset, page.limit);
  }

  const endTarget = page.offset + page.limit;
  const table = ITEM_TABLE[kind];
  const counts = await Promise.all(
    activeIds.map(async (id) => {
      const rows = await db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM ${table} WHERE source_id = ? AND is_hidden = 0 LIMIT ?
         )`,
        [id, endTarget],
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
      return fetchSourceSlice(db, kind, id, start, count);
    }),
  );

  return interleaveSlices(buckets, startAlloc, endAlloc);
}
