import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import type { ImportDeps } from './import-types';
import { loadSeriesEpisodes } from './import-xtream';
import { reconcileMyListNewEpisodesForSource } from './my-list-new-episodes';
import { sourceOfKey } from './queries';
import { getSource } from './sources';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './user-state-helpers';

interface RawSeriesEpisodeRow {
  source_id: string;
  key: string;
  series_key: string;
  season: number;
  episode: number | null;
  title: string | null;
  duration_sec: number | null;
  series_name: string | null;
  series_cover: string | null;
}

interface RawSeriesMetaRow {
  source_id: string;
  name: string;
  cover: string | null;
}

interface SeriesWatchedQueueLike {
  run<T>(
    sourceId: string,
    kind: 'catalog' | 'guide' | 'series-episodes',
    signal: AbortSignal | undefined,
    fn: (runSignal: AbortSignal) => Promise<Result<T>>,
    opts?: { taskKey?: string },
  ): Promise<Result<T>>;
}

const UPSERT_EPISODE_WATCHED_SQL = `INSERT INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at,
  version_group_key, preferred_item_key
) VALUES (?, ?, ?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id,
  kind = 'episode',
  title = CASE WHEN watch_progress.title != '' THEN watch_progress.title ELSE excluded.title END,
  subtitle = COALESCE(watch_progress.subtitle, excluded.subtitle),
  logo = COALESCE(watch_progress.logo, excluded.logo),
  series_key = excluded.series_key,
  season = excluded.season,
  episode = excluded.episode,
  duration_ms = CASE
    WHEN watch_progress.duration_ms > 0 THEN watch_progress.duration_ms
    ELSE excluded.duration_ms
  END,
  position_ms = MAX(
    watch_progress.position_ms,
    CASE
      WHEN watch_progress.duration_ms > 0 THEN watch_progress.duration_ms
      ELSE excluded.duration_ms
    END
  ),
  watched = 1,
  updated_at = excluded.updated_at`;

const UPSERT_SERIES_WATCHED_SQL = `INSERT INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at,
  version_group_key, preferred_item_key
) VALUES (?, ?, ?, 'series', ?, NULL, ?, NULL, NULL, NULL, 0, 0, 1, ?, NULL, NULL)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  watched = 1,
  updated_at = excluded.updated_at`;

function episodeDurationMs(durationSec: number | null): number {
  return durationSec !== null && Number.isFinite(durationSec) && durationSec > 0
    ? Math.round(durationSec * 1000)
    : 0;
}

function episodeDisplayFields(ep: RawSeriesEpisodeRow): {
  title: string;
  subtitle: string | null;
} {
  const epTitle = ep.title?.trim() ?? '';
  const seriesName = ep.series_name?.trim() ?? '';
  if (epTitle !== '') {
    return { title: epTitle, subtitle: seriesName !== '' ? seriesName : null };
  }
  return { title: seriesName !== '' ? seriesName : ep.key, subtitle: null };
}

async function queryEpisodesForWatched(
  tx: Pick<SqlDriver, 'all'>,
  seriesKey: string,
  hintedSource: string | undefined,
  season?: number,
): Promise<RawSeriesEpisodeRow[]> {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (hintedSource !== undefined) {
    conditions.push('e.source_id = ?');
    params.push(hintedSource);
  }
  conditions.push('e.series_key = ?');
  params.push(seriesKey);
  if (season !== undefined) {
    if (season === 0) {
      conditions.push('(e.season = 0 OR e.season IS NULL)');
    } else {
      conditions.push('e.season = ?');
      params.push(season);
    }
  }
  const orderBy =
    season !== undefined ? 'e.episode ASC, e.id ASC' : 'e.season ASC, e.episode ASC, e.id ASC';
  return tx.all<RawSeriesEpisodeRow>(
    `SELECT e.source_id, e.key, e.series_key, COALESCE(e.season, 0) AS season, e.episode,
            e.title, e.duration_sec, s.name AS series_name, s.cover AS series_cover
       FROM episodes e
       LEFT JOIN series s ON s.source_id = e.source_id AND s.key = e.series_key
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}`,
    params,
  );
}

async function querySeriesMeta(
  tx: Pick<SqlDriver, 'all'>,
  seriesKey: string,
  hintedSource: string | undefined,
): Promise<RawSeriesMetaRow | undefined> {
  const rows =
    hintedSource !== undefined
      ? await tx.all<RawSeriesMetaRow>(
          'SELECT source_id, name, cover FROM series WHERE source_id = ? AND key = ? LIMIT 1',
          [hintedSource, seriesKey],
        )
      : await tx.all<RawSeriesMetaRow>(
          'SELECT source_id, name, cover FROM series WHERE key = ? LIMIT 1',
          [seriesKey],
        );
  return rows[0];
}

/**
 * @internal Resolves the parent `series_key` for an episode `itemKey` (checking `watch_progress`
 * first, then `episodes`) so unmarking a single episode unwatched clears any stale series-level
 * watched flag on `(profileId, parentSeriesKey)`.
 */
export async function lookupParentSeriesKeyForUnwatch(
  tx: Pick<SqlDriver, 'all'>,
  profileId: string,
  itemKey: string,
): Promise<string | null> {
  const trimmed = itemKey.trim();
  if (trimmed === '') return null;
  const wpRows = await tx.all<{ series_key: string | null }>(
    'SELECT series_key FROM watch_progress WHERE profile_id = ? AND item_key = ? LIMIT 1',
    [profileId, trimmed],
  );
  const fromProgress = wpRows[0]?.series_key?.trim() ?? '';
  if (fromProgress !== '') return fromProgress;

  const hintedSource = sourceOfKey(trimmed);
  const epRows =
    hintedSource !== undefined
      ? await tx.all<{ series_key: string | null }>(
          'SELECT series_key FROM episodes WHERE source_id = ? AND key = ? LIMIT 1',
          [hintedSource, trimmed],
        )
      : await tx.all<{ series_key: string | null }>(
          'SELECT series_key FROM episodes WHERE key = ? LIMIT 1',
          [trimmed],
        );
  const fromEpisode = epRows[0]?.series_key?.trim() ?? '';
  return fromEpisode !== '' ? fromEpisode : null;
}

/**
 * Transactionally marks all stored episodes of one season watched or unwatched for `profileId`.
 * Marking watched upserts each episode in `watch_progress` preserving any existing positive
 * `duration_ms` and advancing `position_ms` to at least `duration_ms`. Marking unwatched resets
 * matching episode rows and clears any series-level watched flag on `seriesKey`.
 */
export async function setSeasonWatchedInDb(
  db: SqlDriver,
  seriesKey: string,
  season: number,
  watched: boolean,
  clock: () => number = Date.now,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<number>> {
  const trimmedKey = seriesKey.trim();
  if (trimmedKey === '' || !Number.isSafeInteger(season) || season < 0) {
    return err(elvError('source-format', 'invalid-series-watched'));
  }
  const normalizedProfile = normalizeProfileId(profileId);
  const updatedAt = Math.round(clock());
  const hintedSource = sourceOfKey(trimmedKey);

  if (watched) {
    const affected = await db.transaction(async (tx) => {
      const episodes = await queryEpisodesForWatched(tx, trimmedKey, hintedSource, season);
      for (const ep of episodes) {
        const durationMs = episodeDurationMs(ep.duration_sec);
        const { title, subtitle } = episodeDisplayFields(ep);
        await tx.run(UPSERT_EPISODE_WATCHED_SQL, [
          normalizedProfile,
          ep.source_id,
          ep.key,
          title,
          subtitle,
          ep.series_cover,
          trimmedKey,
          ep.season,
          ep.episode,
          durationMs,
          durationMs,
          updatedAt,
        ]);
      }
      return episodes.length;
    });
    return ok(affected);
  }

  const updatedCount = await db.transaction(async (tx) => {
    const seasonExpr = season === 0 ? '(season = 0 OR season IS NULL)' : 'season = ?';
    const subWhere =
      hintedSource !== undefined
        ? `source_id = ? AND series_key = ? AND ${seasonExpr}`
        : `series_key = ? AND ${seasonExpr}`;
    const subParams: SqlValue[] =
      hintedSource !== undefined
        ? season === 0
          ? [hintedSource, trimmedKey]
          : [hintedSource, trimmedKey, season]
        : season === 0
          ? [trimmedKey]
          : [trimmedKey, season];
    const epRes = await tx.run(
      `UPDATE watch_progress
          SET watched = 0, position_ms = 0, updated_at = ?
        WHERE profile_id = ?
          AND (
            (series_key = ? AND ${seasonExpr})
            OR item_key IN (SELECT key FROM episodes WHERE ${subWhere})
          )`,
      [updatedAt, normalizedProfile, trimmedKey, ...(season === 0 ? [] : [season]), ...subParams],
    );
    await tx.run(
      `UPDATE watch_progress
          SET watched = 0, position_ms = 0, updated_at = ?
        WHERE profile_id = ? AND item_key = ?`,
      [updatedAt, normalizedProfile, trimmedKey],
    );
    return epRes.changes;
  });
  return ok(updatedCount);
}

/**
 * Transactionally marks an entire series (every stored episode plus the series-level row) watched
 * or unwatched for `profileId`, keeping `listWatched`, `listSeriesUnplayedCounts`, and
 * `queryNextEpisode` consistent.
 */
export async function setSeriesWatchedInDb(
  db: SqlDriver,
  seriesKey: string,
  watched: boolean,
  clock: () => number = Date.now,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Result<number>> {
  const trimmedKey = seriesKey.trim();
  if (trimmedKey === '') {
    return err(elvError('source-format', 'invalid-series-watched'));
  }
  const normalizedProfile = normalizeProfileId(profileId);
  const updatedAt = Math.round(clock());
  const hintedSource = sourceOfKey(trimmedKey);

  if (watched) {
    const affected = await db.transaction(async (tx) => {
      const episodes = await queryEpisodesForWatched(tx, trimmedKey, hintedSource);
      const seriesMeta = await querySeriesMeta(tx, trimmedKey, hintedSource);
      for (const ep of episodes) {
        const durationMs = episodeDurationMs(ep.duration_sec);
        const { title, subtitle } = episodeDisplayFields(ep);
        await tx.run(UPSERT_EPISODE_WATCHED_SQL, [
          normalizedProfile,
          ep.source_id,
          ep.key,
          title,
          subtitle,
          ep.series_cover,
          trimmedKey,
          ep.season,
          ep.episode,
          durationMs,
          durationMs,
          updatedAt,
        ]);
      }
      const seriesSourceId = seriesMeta?.source_id ?? episodes[0]?.source_id;
      if (seriesSourceId !== undefined) {
        const seriesTitle =
          seriesMeta !== undefined && seriesMeta.name.trim() !== ''
            ? seriesMeta.name.trim()
            : trimmedKey;
        await tx.run(UPSERT_SERIES_WATCHED_SQL, [
          normalizedProfile,
          seriesSourceId,
          trimmedKey,
          seriesTitle,
          seriesMeta?.cover ?? null,
          updatedAt,
        ]);
      } else {
        await tx.run(
          'UPDATE watch_progress SET watched = 1, updated_at = ? WHERE profile_id = ? AND item_key = ?',
          [updatedAt, normalizedProfile, trimmedKey],
        );
      }
      return episodes.length;
    });
    return ok(affected);
  }

  const updatedCount = await db.transaction(async (tx) => {
    const subWhere =
      hintedSource !== undefined ? 'source_id = ? AND series_key = ?' : 'series_key = ?';
    const subParams: SqlValue[] =
      hintedSource !== undefined ? [hintedSource, trimmedKey] : [trimmedKey];
    const epRes = await tx.run(
      `UPDATE watch_progress
          SET watched = 0, position_ms = 0, updated_at = ?
        WHERE profile_id = ?
          AND (
            series_key = ?
            OR item_key IN (SELECT key FROM episodes WHERE ${subWhere})
          )`,
      [updatedAt, normalizedProfile, trimmedKey, ...subParams],
    );
    await tx.run(
      `UPDATE watch_progress
          SET watched = 0, position_ms = 0, updated_at = ?
        WHERE profile_id = ? AND item_key = ?`,
      [updatedAt, normalizedProfile, trimmedKey],
    );
    return epRes.changes;
  });
  return ok(updatedCount);
}

async function ensureSeriesEpisodesHydrated(
  db: SqlDriver,
  seriesKey: string,
  clock: () => number,
  importDeps: ImportDeps,
  queue: SeriesWatchedQueueLike,
): Promise<Result<void>> {
  const hintedSource = sourceOfKey(seriesKey);
  const existing =
    hintedSource !== undefined
      ? await db.all<{ found: number }>(
          'SELECT 1 AS found FROM episodes WHERE source_id = ? AND series_key = ? LIMIT 1',
          [hintedSource, seriesKey],
        )
      : await db.all<{ found: number }>(
          'SELECT 1 AS found FROM episodes WHERE series_key = ? LIMIT 1',
          [seriesKey],
        );
  if (existing.length > 0) return ok(undefined);

  const seriesMeta = await querySeriesMeta(db, seriesKey, hintedSource);
  if (seriesMeta === undefined) return ok(undefined);

  const source = await getSource(db, seriesMeta.source_id);
  if (source?.kind !== 'xtream' && source?.kind !== 'stalker') return ok(undefined);

  const loaded = await queue.run(
    seriesMeta.source_id,
    'series-episodes',
    undefined,
    (runSignal) =>
      loadSeriesEpisodes(seriesMeta.source_id, seriesKey, importDeps, { signal: runSignal }),
    { taskKey: seriesKey },
  );
  if (!loaded.ok) return loaded;
  await reconcileMyListNewEpisodesForSource(db, seriesMeta.source_id, {
    seriesKey,
    clock,
  }).catch(() => undefined);
  return ok(undefined);
}

/** @internal Builds `CatalogService.setSeasonWatched` and `setSeriesWatched` with lazy episode hydration and backup sync. */
export function createCatalogSeriesWatchedOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  importDeps: ImportDeps;
  queue: SeriesWatchedQueueLike;
  syncUserData: () => Promise<void> | undefined;
}): {
  setSeasonWatched(
    seriesKey: string,
    season: number,
    watched: boolean,
    profileId?: string,
  ): Promise<Result<number>>;
  setSeriesWatched(
    seriesKey: string,
    watched: boolean,
    profileId?: string,
  ): Promise<Result<number>>;
} {
  const { db, clock, importDeps, queue, syncUserData } = deps;
  return {
    async setSeasonWatched(seriesKey, season, watched, profileId) {
      const trimmedKey = seriesKey.trim();
      if (trimmedKey === '' || !Number.isSafeInteger(season) || season < 0) {
        return err(elvError('source-format', 'invalid-series-watched'));
      }
      if (watched) {
        const hydrated = await ensureSeriesEpisodesHydrated(
          db,
          trimmedKey,
          clock,
          importDeps,
          queue,
        );
        if (!hydrated.ok) return hydrated;
      }
      const res = await setSeasonWatchedInDb(db, trimmedKey, season, watched, clock, profileId);
      if (res.ok) await syncUserData();
      return res;
    },
    async setSeriesWatched(seriesKey, watched, profileId) {
      const trimmedKey = seriesKey.trim();
      if (trimmedKey === '') {
        return err(elvError('source-format', 'invalid-series-watched'));
      }
      if (watched) {
        const hydrated = await ensureSeriesEpisodesHydrated(
          db,
          trimmedKey,
          clock,
          importDeps,
          queue,
        );
        if (!hydrated.ok) return hydrated;
      }
      const res = await setSeriesWatchedInDb(db, trimmedKey, watched, clock, profileId);
      if (res.ok) await syncUserData();
      return res;
    },
  };
}
