import type { SqlDriver, SqlValue } from '@elv/domain';
import { sourceOfKey } from './queries';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './user-state-helpers';

const MAX_SERIES_UNPLAYED_KEYS = 200;

/** Batched unplayed episode summary for one series (`#409`). */
export interface SeriesUnplayedSummary {
  readonly seriesKey: string;
  readonly total: number;
  readonly unplayed: number;
  readonly watched: boolean;
}

interface RawSeriesUnplayedRow {
  series_key: string;
  total: number;
  unplayed: number;
  explicitly_watched: number;
}

/**
 * Computes batched unplayed episode counts and completion state for up to 200 distinct series keys
 * in a single indexed SQL aggregation over `episodes` and `watch_progress` (`#409`).
 * Series with zero imported episodes are omitted unless the series key itself is explicitly marked
 * watched in `watch_progress`.
 */
export async function listSeriesUnplayedCounts(
  db: SqlDriver,
  seriesKeys: readonly string[],
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<SeriesUnplayedSummary[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of seriesKeys) {
    if (key.trim() === '' || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
    if (unique.length >= MAX_SERIES_UNPLAYED_KEYS) break;
  }
  if (unique.length === 0) return [];

  const normalizedProfile = normalizeProfileId(profileId);
  const keyPlaceholders = unique.map(() => '?').join(', ');

  const sourceIds: string[] = [];
  const seenSources = new Set<string>();
  let allHaveSource = true;
  for (const key of unique) {
    const src = sourceOfKey(key);
    if (src === undefined) {
      allHaveSource = false;
      break;
    }
    if (!seenSources.has(src)) {
      seenSources.add(src);
      sourceIds.push(src);
    }
  }

  const episodeWhere =
    allHaveSource && sourceIds.length > 0
      ? `e.source_id IN (${sourceIds.map(() => '?').join(', ')}) AND e.series_key IN (${keyPlaceholders})`
      : `e.series_key IN (${keyPlaceholders})`;

  const params: SqlValue[] =
    allHaveSource && sourceIds.length > 0
      ? [normalizedProfile, ...sourceIds, ...unique, normalizedProfile, ...unique]
      : [normalizedProfile, ...unique, normalizedProfile, ...unique];

  const sql = `
    SELECT series_key,
           SUM(total) AS total,
           SUM(unplayed) AS unplayed,
           MAX(explicitly_watched) AS explicitly_watched
      FROM (
        SELECT e.series_key AS series_key,
               COUNT(*) AS total,
               SUM(CASE WHEN COALESCE(wp.watched, 0) = 0 THEN 1 ELSE 0 END) AS unplayed,
               0 AS explicitly_watched
          FROM episodes e
          LEFT JOIN watch_progress wp
            ON wp.profile_id = ? AND wp.item_key = e.key
         WHERE ${episodeWhere}
         GROUP BY e.series_key
        UNION ALL
        SELECT wp.item_key AS series_key,
               0 AS total,
               0 AS unplayed,
               1 AS explicitly_watched
          FROM watch_progress wp
         WHERE wp.profile_id = ? AND wp.item_key IN (${keyPlaceholders}) AND wp.watched = 1
      )
     GROUP BY series_key`;

  const rows = await db.all<RawSeriesUnplayedRow>(sql, params);
  return rows.map((row) => {
    const total = Number(row.total);
    const rawUnplayed = Number(row.unplayed);
    const explicitlyWatched = row.explicitly_watched !== 0;
    const unplayed = explicitlyWatched ? 0 : rawUnplayed;
    return {
      seriesKey: row.series_key,
      total,
      unplayed,
      watched: explicitlyWatched || (total > 0 && unplayed === 0),
    };
  });
}
