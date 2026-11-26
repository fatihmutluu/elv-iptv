import { ok, type Result, type SqlDriver } from '@elv/domain';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './user-state-helpers';

/** Default maximum number of My List new episode rows returned. */
export const DEFAULT_MY_LIST_NEW_EPISODES_LIMIT = 24;

/** Hard upper bound on My List new episode rows returned per query. */
export const MAX_MY_LIST_NEW_EPISODES_LIMIT = 100;

/** Default per-series cooldown (ms) between provider refreshes (`30` minutes). */
export const DEFAULT_NEW_EPISODES_COOLDOWN_MS = 30 * 60_000;

/** Default maximum number of stale Xtream/Stalker My List series refreshed per pass. */
export const DEFAULT_NEW_EPISODES_MAX_SERIES = 10;

/** Hard upper bound on series refreshed in a single `refreshMyListNewEpisodes` pass. */
export const MAX_NEW_EPISODES_REFRESH_SERIES = 50;

/** One newly arrived episode row for an active My List series (`#502`). */
export interface MyListNewEpisodeRow {
  readonly profileId: string;
  readonly episodeKey: string;
  readonly seriesKey: string;
  readonly sourceId: string;
  readonly seriesTitle: string;
  readonly seriesLogo: string | null;
  readonly season: number | null;
  readonly episode: number | null;
  readonly episodeTitle: string;
  readonly detectedAt: number;
}

/** Options for {@link CatalogService.refreshMyListNewEpisodes}. */
export interface RefreshMyListNewEpisodesOptions {
  readonly cooldownMs?: number;
  readonly maxSeries?: number;
  readonly force?: boolean;
  /** Optional additional series keys (e.g. downloaded series) whose episodes should be refreshed without enrolling them in My List new-episode detection. */
  readonly extraSeriesKeys?: readonly string[];
}

/** Result of {@link CatalogService.refreshMyListNewEpisodes}. */
export interface RefreshMyListNewEpisodesResult {
  readonly checkedSeriesCount: number;
  readonly newlyDetectedCount: number;
}

interface RawNewEpisodeRow {
  profile_id: string;
  episode_key: string;
  series_key: string;
  source_id: string;
  series_title: string;
  series_logo: string | null;
  season: number | null;
  episode: number | null;
  episode_title: string;
  detected_at: number;
}

interface FavoriteSeriesRow {
  series_key: string;
  source_id: string;
  series_title: string;
  series_logo: string | null;
}

interface EpisodeSnapshotRow {
  key: string;
  season: number | null;
  episode: number | null;
  title: string | null;
}

interface BaselineRow {
  baseline_at: number;
  last_checked_at: number;
  known_keys_json: string;
}

function clampNewEpisodesLimit(limit: number | undefined): number {
  const n =
    limit === undefined || !Number.isFinite(limit)
      ? DEFAULT_MY_LIST_NEW_EPISODES_LIMIT
      : Math.floor(limit);
  return Math.min(MAX_MY_LIST_NEW_EPISODES_LIMIT, Math.max(0, n));
}

function parseKnownKeys(raw: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<string>();
    for (const item of parsed) {
      if (typeof item === 'string' && item !== '') out.add(item);
    }
    return out;
  } catch {
    return new Set();
  }
}

function mapNewEpisodeRow(r: RawNewEpisodeRow): MyListNewEpisodeRow {
  return {
    profileId: r.profile_id,
    episodeKey: r.episode_key,
    seriesKey: r.series_key,
    sourceId: r.source_id,
    seriesTitle: r.series_title,
    seriesLogo: r.series_logo,
    season: r.season,
    episode: r.episode,
    episodeTitle: r.episode_title,
    detectedAt: r.detected_at,
  };
}

/**
 * Captures the current cached episode keys of a favorited series as its baseline so existing
 * episodes are never flagged as newly arrived (`#502`). When no episodes are cached yet, writes
 * `baseline_at = 0` so the first future episode load establishes the baseline cleanly.
 */
export async function captureMyListSeriesBaseline(
  db: SqlDriver,
  profileId: string,
  seriesKey: string,
  sourceId: string,
  clock: () => number = Date.now,
): Promise<void> {
  const trimmedSeries = seriesKey.trim();
  const trimmedSource = sourceId.trim();
  if (trimmedSeries === '' || trimmedSource === '') return;
  const normalized = normalizeProfileId(profileId);
  const rows = await db.all<{ key: string }>(
    'SELECT key FROM episodes WHERE source_id = ? AND series_key = ? ORDER BY key ASC',
    [trimmedSource, trimmedSeries],
  );
  const now = rows.length > 0 ? Math.max(1, Math.round(clock())) : 0;
  const knownJson = rows.length > 0 ? JSON.stringify(rows.map((r) => r.key)) : '[]';
  await db.run(
    `INSERT INTO my_list_series_baselines (
       profile_id, series_key, source_id, baseline_at, last_checked_at, known_keys_json
     ) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(profile_id, series_key) DO UPDATE SET
       source_id = excluded.source_id,
       baseline_at = CASE
         WHEN my_list_series_baselines.baseline_at > 0 THEN my_list_series_baselines.baseline_at
         ELSE excluded.baseline_at
       END,
       known_keys_json = CASE
         WHEN my_list_series_baselines.baseline_at > 0 THEN my_list_series_baselines.known_keys_json
         ELSE excluded.known_keys_json
       END`,
    [normalized, trimmedSeries, trimmedSource, now, knownJson],
  );
}

/** Removes baseline and detected new-episode tracking for one `(profileId, seriesKey)` pair. */
export async function clearMyListSeriesTracking(
  db: SqlDriver,
  profileId: string,
  seriesKey: string,
): Promise<void> {
  const trimmedSeries = seriesKey.trim();
  if (trimmedSeries === '') return;
  const normalized = normalizeProfileId(profileId);
  await db.run('DELETE FROM my_list_series_baselines WHERE profile_id = ? AND series_key = ?', [
    normalized,
    trimmedSeries,
  ]);
  await db.run('DELETE FROM my_list_new_episodes WHERE profile_id = ? AND series_key = ?', [
    normalized,
    trimmedSeries,
  ]);
}

/** Records `last_checked_at` for a favorited series after a provider refresh attempt (`#502`). */
export async function stampMyListSeriesChecked(
  db: SqlDriver,
  profileId: string,
  seriesKey: string,
  sourceId: string,
  checkedAt: number,
): Promise<void> {
  const normalized = normalizeProfileId(profileId);
  const ts = Math.max(0, Math.round(checkedAt));
  await db.run(
    `INSERT INTO my_list_series_baselines (
       profile_id, series_key, source_id, baseline_at, last_checked_at, known_keys_json
     ) VALUES (?, ?, ?, 0, ?, '[]')
     ON CONFLICT(profile_id, series_key) DO UPDATE SET
       source_id = excluded.source_id,
       last_checked_at = excluded.last_checked_at`,
    [normalized, seriesKey, sourceId, ts],
  );
}

async function loadWatchedEpisodeKeys(
  db: SqlDriver,
  profileId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const watched = new Set<string>();
  const chunkSize = 200;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.all<{ item_key: string }>(
      `SELECT item_key
         FROM watch_progress
        WHERE profile_id = ? AND watched = 1 AND item_key IN (${placeholders})`,
      [profileId, ...chunk],
    );
    for (const r of rows) watched.add(r.item_key);
  }
  return watched;
}

/**
 * Reconciles `my_list_new_episodes` against current cached `episodes` for active My List series
 * of `profileId` (or one `seriesKey`). Establishes baselines cleanly for pre-v22 or 0-episode
 * favorites without flagging old episodes, prunes orphaned rows, and inserts newly discovered
 * unwatched episodes. Returns the number of newly inserted rows.
 */
export async function reconcileMyListNewEpisodes(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: { readonly seriesKey?: string; readonly clock?: () => number },
): Promise<number> {
  const normalized = normalizeProfileId(profileId);
  const now = Math.max(1, Math.round((opts?.clock ?? Date.now)()));
  const targetSeries = opts?.seriesKey?.trim();
  const hasTarget = targetSeries !== undefined && targetSeries !== '';

  if (hasTarget) {
    await db.run(
      `DELETE FROM my_list_new_episodes
        WHERE profile_id = ?
          AND series_key = ?
          AND (
            NOT EXISTS (
              SELECT 1 FROM favorites f
               WHERE f.profile_id = my_list_new_episodes.profile_id
                 AND f.item_key = my_list_new_episodes.series_key
                 AND f.kind = 'series'
            )
            OR NOT EXISTS (
              SELECT 1 FROM episodes e
               WHERE e.source_id = my_list_new_episodes.source_id
                 AND e.key = my_list_new_episodes.episode_key
            )
          )`,
      [normalized, targetSeries],
    );
    await db.run(
      `DELETE FROM my_list_series_baselines
        WHERE profile_id = ?
          AND series_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM favorites f
             WHERE f.profile_id = my_list_series_baselines.profile_id
               AND f.item_key = my_list_series_baselines.series_key
               AND f.kind = 'series'
          )`,
      [normalized, targetSeries],
    );
  } else {
    await db.run(
      `DELETE FROM my_list_new_episodes
        WHERE profile_id = ?
          AND (
            NOT EXISTS (
              SELECT 1 FROM favorites f
               WHERE f.profile_id = my_list_new_episodes.profile_id
                 AND f.item_key = my_list_new_episodes.series_key
                 AND f.kind = 'series'
            )
            OR NOT EXISTS (
              SELECT 1 FROM episodes e
               WHERE e.source_id = my_list_new_episodes.source_id
                 AND e.key = my_list_new_episodes.episode_key
            )
          )`,
      [normalized],
    );
    await db.run(
      `DELETE FROM my_list_series_baselines
        WHERE profile_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM favorites f
             WHERE f.profile_id = my_list_series_baselines.profile_id
               AND f.item_key = my_list_series_baselines.series_key
               AND f.kind = 'series'
          )`,
      [normalized],
    );
  }

  const favSeries = hasTarget
    ? await db.all<FavoriteSeriesRow>(
        `SELECT f.item_key AS series_key,
                f.source_id,
                COALESCE(NULLIF(TRIM(s.name), ''), f.title) AS series_title,
                COALESCE(s.cover, f.logo) AS series_logo
           FROM favorites f
           LEFT JOIN series s ON s.source_id = f.source_id AND s.key = f.item_key
          WHERE f.profile_id = ? AND f.kind = 'series' AND f.item_key = ?`,
        [normalized, targetSeries],
      )
    : await db.all<FavoriteSeriesRow>(
        `SELECT f.item_key AS series_key,
                f.source_id,
                COALESCE(NULLIF(TRIM(s.name), ''), f.title) AS series_title,
                COALESCE(s.cover, f.logo) AS series_logo
           FROM favorites f
           LEFT JOIN series s ON s.source_id = f.source_id AND s.key = f.item_key
          WHERE f.profile_id = ? AND f.kind = 'series'`,
        [normalized],
      );

  let newlyDetectedCount = 0;

  for (const fav of favSeries) {
    const episodes = await db.all<EpisodeSnapshotRow>(
      `SELECT key, season, episode, title
         FROM episodes
        WHERE source_id = ? AND series_key = ?
        ORDER BY COALESCE(season, 0) ASC, COALESCE(episode, 0) ASC, key ASC`,
      [fav.source_id, fav.series_key],
    );
    const baselines = await db.all<BaselineRow>(
      `SELECT baseline_at, last_checked_at, known_keys_json
         FROM my_list_series_baselines
        WHERE profile_id = ? AND series_key = ?
        LIMIT 1`,
      [normalized, fav.series_key],
    );
    const baseline = baselines[0];

    if (episodes.length === 0) {
      if (baseline === undefined) {
        await db.run(
          `INSERT OR IGNORE INTO my_list_series_baselines (
             profile_id, series_key, source_id, baseline_at, last_checked_at, known_keys_json
           ) VALUES (?, ?, ?, 0, 0, '[]')`,
          [normalized, fav.series_key, fav.source_id],
        );
      }
      continue;
    }

    if (baseline === undefined || baseline.baseline_at <= 0) {
      const knownJson = JSON.stringify(episodes.map((e) => e.key));
      const lastChecked = baseline?.last_checked_at ?? 0;
      await db.run(
        `INSERT INTO my_list_series_baselines (
           profile_id, series_key, source_id, baseline_at, last_checked_at, known_keys_json
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, series_key) DO UPDATE SET
           source_id = excluded.source_id,
           baseline_at = excluded.baseline_at,
           known_keys_json = excluded.known_keys_json`,
        [normalized, fav.series_key, fav.source_id, now, lastChecked, knownJson],
      );
      continue;
    }

    const knownSet = parseKnownKeys(baseline.known_keys_json);
    const candidates = episodes.filter((ep) => !knownSet.has(ep.key));
    if (candidates.length === 0) continue;

    const watchedSet = await loadWatchedEpisodeKeys(
      db,
      normalized,
      candidates.map((ep) => ep.key),
    );

    for (const ep of candidates) {
      if (watchedSet.has(ep.key)) continue;
      const epTitle = ep.title?.trim() ?? '';
      const res = await db.run(
        `INSERT OR IGNORE INTO my_list_new_episodes (
           profile_id, episode_key, series_key, source_id, series_title, series_logo,
           season, episode, episode_title, detected_at, dismissed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          normalized,
          ep.key,
          fav.series_key,
          fav.source_id,
          fav.series_title,
          fav.series_logo,
          ep.season,
          ep.episode,
          epTitle,
          now,
        ],
      );
      if (res.changes > 0) newlyDetectedCount += 1;
    }

    for (const ep of episodes) knownSet.add(ep.key);
    await db.run(
      `UPDATE my_list_series_baselines
          SET source_id = ?, known_keys_json = ?
        WHERE profile_id = ? AND series_key = ?`,
      [fav.source_id, JSON.stringify([...knownSet]), normalized, fav.series_key],
    );
  }

  return newlyDetectedCount;
}

/**
 * Reconciles My List new episodes across every profile that has favorited series in `sourceId`
 * (optionally narrowed to a single `seriesKey`).
 */
export async function reconcileMyListNewEpisodesForSource(
  db: SqlDriver,
  sourceId: string,
  opts?: { readonly seriesKey?: string; readonly clock?: () => number },
): Promise<number> {
  const targetSeries = opts?.seriesKey?.trim();
  const hasTarget = targetSeries !== undefined && targetSeries !== '';
  const profileRows = hasTarget
    ? await db.all<{ profile_id: string }>(
        `SELECT DISTINCT profile_id
           FROM favorites
          WHERE source_id = ? AND kind = 'series' AND item_key = ?`,
        [sourceId, targetSeries],
      )
    : await db.all<{ profile_id: string }>(
        `SELECT DISTINCT profile_id
           FROM favorites
          WHERE source_id = ? AND kind = 'series'`,
        [sourceId],
      );
  let total = 0;
  for (const row of profileRows) {
    total += await reconcileMyListNewEpisodes(db, row.profile_id, opts);
  }
  return total;
}

/**
 * Lists active, undismissed, unwatched newly arrived episodes for `profileId`'s My List series,
 * respecting active parental locks, ordered newest first (`#502`).
 */
export async function listMyListNewEpisodes(
  db: SqlDriver,
  limit = DEFAULT_MY_LIST_NEW_EPISODES_LIMIT,
  profileId: string = DEFAULT_PROFILE_ID,
  opts?: { readonly parentalUnlocked?: boolean },
): Promise<MyListNewEpisodeRow[]> {
  const clamped = clampNewEpisodesLimit(limit);
  if (clamped === 0) return [];
  const normalized = normalizeProfileId(profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(400, clamped * 4);
  const rows = await db.all<RawNewEpisodeRow>(
    `SELECT n.profile_id,
            n.episode_key,
            n.series_key,
            n.source_id,
            n.series_title,
            COALESCE(s.cover, n.series_logo) AS series_logo,
            n.season,
            n.episode,
            n.episode_title,
            n.detected_at
       FROM my_list_new_episodes n
       INNER JOIN favorites f
         ON f.profile_id = n.profile_id
        AND f.item_key = n.series_key
        AND f.kind = 'series'
       INNER JOIN episodes e
         ON e.source_id = n.source_id
        AND e.key = n.episode_key
       LEFT JOIN series s
         ON s.source_id = n.source_id
        AND s.key = n.series_key
       LEFT JOIN watch_progress wp
         ON wp.profile_id = n.profile_id
        AND wp.item_key = n.episode_key
      WHERE n.profile_id = ?
        AND n.dismissed = 0
        AND COALESCE(wp.watched, 0) = 0
      ORDER BY n.detected_at DESC,
               COALESCE(n.season, 0) DESC,
               COALESCE(n.episode, 0) DESC,
               n.episode_key ASC
      LIMIT ?`,
    [normalized, fetchLimit],
  );
  const mapped = rows.map(mapNewEpisodeRow);
  if (filter === null) return mapped;
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    mapped.map((r) => ({
      itemKey: r.episodeKey,
      sourceId: r.sourceId,
      kind: 'episode' as const,
      title: r.seriesTitle,
      seriesKey: r.seriesKey,
    })),
  );
  return mapped.filter((r) => !restricted.has(r.episodeKey)).slice(0, clamped);
}

/** Dismisses a newly arrived My List episode so it no longer appears on Home (`#502`). */
export async function dismissMyListNewEpisode(
  db: SqlDriver,
  episodeKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<void>> {
  const trimmed = episodeKey.trim();
  if (trimmed === '') return ok(undefined);
  const normalized = normalizeProfileId(profileId);
  await db.run(
    'UPDATE my_list_new_episodes SET dismissed = 1 WHERE profile_id = ? AND episode_key = ?',
    [normalized, trimmed],
  );
  return ok(undefined);
}
