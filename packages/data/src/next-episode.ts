import type { SqlDriver, SqlValue } from '@elv/domain';
import { isAdultKeywordMatch } from './parental-policy';
import { isItemRestricted, loadActiveParentalFilter } from './parental-repo';
import { type EpisodeRow, sourceOfKey } from './queries';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './user-state-helpers';

/** Next sequential or unplayed episode resolved across season boundaries (`#392`). */
export interface NextEpisodeRow extends EpisodeRow {
  sourceId: string;
  seriesKey: string;
  /** Parent series title from `series.name`, if available. */
  seriesTitle: string | null;
  /** Parent series cover from `series.cover` (M3U templates resolved by `CatalogService`), if available. */
  logo: string | null;
}

interface RawCurrentEpisodeRow {
  id: number;
  source_id: string;
  key: string;
  season: number;
  episode: number;
}

interface RawNextEpisodeRow {
  id: number;
  source_id: string;
  key: string;
  series_key: string;
  season: number;
  episode: number | null;
  title: string | null;
  duration_sec: number | null;
  series_title: string | null;
  logo: string | null;
}

const CURRENT_BY_SOURCE_AND_KEY = `
SELECT id, source_id, key, COALESCE(season, 0) AS season, COALESCE(episode, 0) AS episode
  FROM episodes
 WHERE source_id = ? AND series_key = ? AND key = ?
 LIMIT 1`;

const CURRENT_BY_KEY = `
SELECT id, source_id, key, COALESCE(season, 0) AS season, COALESCE(episode, 0) AS episode
  FROM episodes
 WHERE series_key = ? AND key = ?
 LIMIT 1`;

const NEXT_EPISODE_BASE_SQL = `
SELECT e.id, e.source_id, e.key, e.series_key,
       COALESCE(e.season, 0) AS season, e.episode, e.title, e.duration_sec,
       s.name AS series_title, s.cover AS logo
  FROM episodes e
  LEFT JOIN series s
    ON s.source_id = e.source_id AND s.key = e.series_key
  LEFT JOIN watch_progress wp
    ON wp.profile_id = ? AND wp.item_key = e.key
 WHERE e.source_id = ?
   AND e.series_key = ?
   AND (
     COALESCE(e.season, 0) > ?
     OR (COALESCE(e.season, 0) = ? AND COALESCE(e.episode, 0) > ?)
     OR (COALESCE(e.season, 0) = ? AND COALESCE(e.episode, 0) = ? AND e.id > ?)
     OR (COALESCE(e.season, 0) = ? AND COALESCE(e.episode, 0) = ? AND e.id = ? AND e.key > ?)
   )
 ORDER BY
   CASE WHEN wp.watched IS NULL OR wp.watched = 0 THEN 0 ELSE 1 END ASC,
   COALESCE(e.season, 0) ASC,
   COALESCE(e.episode, 0) ASC,
   e.id ASC,
   e.key ASC`;

const NEXT_EPISODE_SQL = `${NEXT_EPISODE_BASE_SQL}
 LIMIT 1`;

/**
 * Resolves the next deterministic episode for `seriesKey` strictly after `currentItemKey`
 * ordered by `(COALESCE(season, 0), COALESCE(episode, 0), id, key)` across season boundaries (`#392`).
 * Prefers the first unwatched subsequent episode for `profileId`; when all subsequent episodes are
 * already marked watched (rewatching), falls back to the immediate next sequential episode.
 * Returns `null` at the series finale, when `currentItemKey` is unknown, or when parental controls
 * restrict the series or all remaining episodes (`#31`).
 */
export async function queryNextEpisode(
  db: SqlDriver,
  seriesKey: string,
  currentItemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<NextEpisodeRow | null> {
  if (seriesKey.trim() === '' || currentItemKey.trim() === '') return null;

  const filter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);
  if (filter !== null && (await isItemRestricted(db, filter, seriesKey))) {
    return null;
  }

  const hintedSource = sourceOfKey(currentItemKey) ?? sourceOfKey(seriesKey);
  const currentSql = hintedSource === undefined ? CURRENT_BY_KEY : CURRENT_BY_SOURCE_AND_KEY;
  const currentParams: SqlValue[] =
    hintedSource === undefined
      ? [seriesKey, currentItemKey]
      : [hintedSource, seriesKey, currentItemKey];

  const currentRows = await db.all<RawCurrentEpisodeRow>(currentSql, currentParams);
  const current = currentRows[0];
  if (current === undefined) return null;

  const normalizedProfile = normalizeProfileId(profileId);
  const queryParams: SqlValue[] = [
    normalizedProfile,
    current.source_id,
    seriesKey,
    current.season,
    current.season,
    current.episode,
    current.season,
    current.episode,
    current.id,
    current.season,
    current.episode,
    current.id,
    current.key,
  ];
  const nextRows = await db.all<RawNextEpisodeRow>(
    filter === null ? NEXT_EPISODE_SQL : NEXT_EPISODE_BASE_SQL,
    queryParams,
  );
  const row =
    filter === null
      ? nextRows[0]
      : nextRows.find(
          (candidate) =>
            !filter.lockedItemKeys.has(candidate.key) &&
            !(
              filter.blockAdultKeywords &&
              candidate.title !== null &&
              isAdultKeywordMatch(candidate.title)
            ),
        );
  if (row === undefined) return null;

  return {
    id: row.id,
    sourceId: row.source_id,
    seriesKey: row.series_key,
    seriesTitle: row.series_title,
    logo: row.logo,
    key: row.key,
    season: row.season,
    episode: row.episode,
    title: row.title,
    durationSec: row.duration_sec,
  };
}
