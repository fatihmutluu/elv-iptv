import type { SqlDriver } from '@elv/domain';
import type { ItemRow } from './queries';
import { DEFAULT_PROFILE_ID } from './user-state-helpers';

interface RawLiveNumberRow {
  id: number;
  key: string;
  source_id: string;
  provider_id: string | null;
  name: string;
  logo: string | null;
  num: number | null;
}

const LIVE_BY_NUM_SQL = `SELECT l.id, l.key, l.source_id, l.provider_id, l.name, l.logo, l.num
  FROM live l
  JOIN sources s ON s.id = l.source_id AND s.deleting = 0
 WHERE l.source_id = ? AND l.num = ? AND l.is_hidden = 0
 ORDER BY l.id`;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function pickWinningNumberRow(
  db: SqlDriver,
  sourceId: string,
  rows: readonly RawLiveNumberRow[],
): Promise<RawLiveNumberRow> {
  if (rows.length === 1) return rows[0] as RawLiveNumberRow;
  const keys = rows.map((r) => r.key);
  const ph = placeholders(keys.length);
  const [favRows, posRows] = await Promise.all([
    db.all<{ item_key: string }>(
      `SELECT item_key FROM favorites WHERE profile_id = ? AND item_key IN (${ph})`,
      [DEFAULT_PROFILE_ID, ...keys],
    ),
    db.all<{ item_key: string; min_pos: number }>(
      `SELECT p.item_key, MIN(p.position) AS min_pos
         FROM placements p
         JOIN categories c
           ON c.source_id = p.source_id AND c.kind = p.kind AND c.provider_id = p.category_id
        WHERE p.source_id = ? AND p.kind = 'live' AND p.item_key IN (${ph})
          AND p.is_hidden = 0 AND c.is_hidden = 0
        GROUP BY p.item_key`,
      [sourceId, ...keys],
    ),
  ]);
  const favSet = new Set(favRows.map((r) => r.item_key));
  const posByKey = new Map(posRows.map((r) => [r.item_key, r.min_pos]));
  return [...rows].sort((a, b) => {
    const favDiff = (favSet.has(b.key) ? 1 : 0) - (favSet.has(a.key) ? 1 : 0);
    if (favDiff !== 0) return favDiff;
    const posA = posByKey.get(a.key) ?? Number.POSITIVE_INFINITY;
    const posB = posByKey.get(b.key) ?? Number.POSITIVE_INFINITY;
    if (posA !== posB) return posA - posB;
    return a.id - b.id;
  })[0] as RawLiveNumberRow;
}

async function queryChannelByNumberInSource(
  db: SqlDriver,
  sourceId: string,
  num: number,
): Promise<ItemRow | undefined> {
  const rows = await db.all<RawLiveNumberRow>(LIVE_BY_NUM_SQL, [sourceId, num]);
  if (rows.length === 0) return undefined;
  const r = await pickWinningNumberRow(db, sourceId, rows);
  return {
    id: r.id,
    key: r.key,
    kind: 'live',
    sourceId: r.source_id,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: null,
    year: null,
    num: r.num,
  };
}

/**
 * Looks up a live channel by finite non-negative channel number (including decimal sub-channels
 * such as `4.1`) using `idx_live_num (source_id, num)` with zero full-table scans. Ties within a
 * source break deterministically: favorites first, then lowest visible category placement position,
 * then `live.id`. When `sourceId` is omitted, probes sources in creation order.
 */
export async function queryChannelByNumber(
  db: SqlDriver,
  num: number,
  sourceId?: string,
): Promise<ItemRow | undefined> {
  if (!Number.isFinite(num) || num < 0) return undefined;
  if (sourceId !== undefined) {
    return queryChannelByNumberInSource(db, sourceId, num);
  }
  const sources = await db.all<{ id: string }>(
    'SELECT id FROM sources WHERE deleting = 0 ORDER BY created_at, id',
  );
  for (const src of sources) {
    const match = await queryChannelByNumberInSource(db, src.id, num);
    if (match !== undefined) return match;
  }
  return undefined;
}
