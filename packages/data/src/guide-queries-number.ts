import type { SqlDriver } from '@elv/domain';
import type { ParentalQueryOptions } from './parental-policy';
import {
  type ActiveParentalFilter,
  findRestrictedItemKeys,
  loadActiveParentalFilter,
} from './parental-repo';
import type { ItemRow } from './queries-shared';
import { normalizeProfileId } from './user-state-helpers';

interface RawLiveNumberRow {
  id: number;
  key: string;
  source_id: string;
  provider_id: string | null;
  name: string;
  raw_name: string;
  original_name: string | null;
  co_sort_order: number | null;
  logo: string | null;
  num: number | null;
  catchup_days: number | null;
}

const LIVE_BY_NUM_SQL = `SELECT l.id, l.key, l.source_id, l.provider_id,
  COALESCE(NULLIF(co.custom_name, ''), l.name) AS name,
  l.name AS raw_name,
  CASE WHEN NULLIF(co.custom_name, '') IS NOT NULL THEN l.name ELSE NULL END AS original_name,
  co.sort_order AS co_sort_order,
  l.logo, l.num, l.catchup_days
  FROM live l
  JOIN sources s ON s.id = l.source_id AND s.deleting = 0
  LEFT JOIN channel_overrides co ON co.profile_id = ? AND co.item_key = l.key
 WHERE l.source_id = ? AND l.num = ? AND l.is_hidden = 0 AND COALESCE(co.is_hidden, 0) = 0
 ORDER BY l.id`;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function pickWinningNumberRow(
  db: SqlDriver,
  sourceId: string,
  rows: readonly RawLiveNumberRow[],
  profileId: string,
): Promise<RawLiveNumberRow> {
  if (rows.length === 1) return rows[0] as RawLiveNumberRow;
  const keys = rows.map((r) => r.key);
  const ph = placeholders(keys.length);
  const [favRows, posRows] = await Promise.all([
    db.all<{ item_key: string }>(
      `SELECT item_key FROM favorites WHERE profile_id = ? AND item_key IN (${ph})`,
      [profileId, ...keys],
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
  profileId: string,
  filter: ActiveParentalFilter | null,
): Promise<ItemRow | undefined> {
  let rows = await db.all<RawLiveNumberRow>(LIVE_BY_NUM_SQL, [profileId, sourceId, num]);
  if (rows.length === 0) return undefined;
  if (filter !== null) {
    const restricted = await findRestrictedItemKeys(
      db,
      filter,
      rows.map((r) => ({
        itemKey: r.key,
        sourceId: r.source_id,
        kind: 'live' as const,
        title: r.raw_name,
      })),
    );
    rows = rows.filter((r) => !restricted.has(r.key));
    if (rows.length === 0) return undefined;
  }
  const r = await pickWinningNumberRow(db, sourceId, rows, profileId);
  return {
    id: r.id,
    key: r.key,
    kind: 'live',
    sourceId: r.source_id,
    providerId: r.provider_id,
    name: r.name,
    ...(r.original_name !== null && r.original_name !== ''
      ? { originalName: r.original_name }
      : {}),
    ...(typeof r.co_sort_order === 'number' ? { customSortOrder: r.co_sort_order } : {}),
    logo: r.logo,
    rating: null,
    year: null,
    num: r.num,
    ...(typeof r.catchup_days === 'number' && Number.isFinite(r.catchup_days) && r.catchup_days > 0
      ? { catchupDays: r.catchup_days }
      : {}),
  };
}

/**
 * Looks up a live channel by finite non-negative channel number (including decimal sub-channels
 * such as `4.1`) using `idx_live_num (source_id, num)` with zero full-table scans. Ties within a
 * source break deterministically: profile favorites first, then lowest visible category placement
 * position, then `live.id`. When `sourceId` is omitted, probes sources in creation order.
 */
export async function queryChannelByNumber(
  db: SqlDriver,
  num: number,
  sourceId?: string,
  opts?: ParentalQueryOptions,
): Promise<ItemRow | undefined> {
  if (!Number.isFinite(num) || num < 0) return undefined;
  const profileId = normalizeProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
  if (sourceId !== undefined) {
    return queryChannelByNumberInSource(db, sourceId, num, profileId, filter);
  }
  const sources = await db.all<{ id: string }>(
    'SELECT id FROM sources WHERE deleting = 0 ORDER BY created_at, id',
  );
  for (const src of sources) {
    const match = await queryChannelByNumberInSource(db, src.id, num, profileId, filter);
    if (match !== undefined) return match;
  }
  return undefined;
}
