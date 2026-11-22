import type { SqlDriver } from '@elv/domain';
import { type CatalogKind, removeStaleCatalog } from './runs';
import { purgeStagedCatalog } from './sources';

export { purgeStagedCatalog };

const ACTIVE_KINDS: readonly CatalogKind[] = ['live', 'movie', 'series'];

const UPSERT_CATEGORIES = `INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id)
  SELECT source_id, kind, provider_id, name, name_fold, position, run_id
  FROM categories_next
  WHERE source_id = ? AND kind = ? AND run_id = ?
  ON CONFLICT(source_id, kind, provider_id) DO UPDATE SET
    name = excluded.name,
    name_fold = excluded.name_fold,
    position = excluded.position,
    run_id = excluded.run_id`;

const UPSERT_LIVE = `INSERT INTO live (source_id, key, provider_id, num, name, name_fold, logo, guide_id, catchup_days, url_template, headers_json, run_id)
  SELECT source_id, key, provider_id, num, name, name_fold, logo, guide_id, catchup_days, url_template, headers_json, run_id
  FROM live_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    num = excluded.num,
    name = excluded.name,
    name_fold = excluded.name_fold,
    logo = excluded.logo,
    guide_id = excluded.guide_id,
    catchup_days = excluded.catchup_days,
    url_template = excluded.url_template,
    headers_json = excluded.headers_json,
    run_id = excluded.run_id`;

const UPSERT_MOVIES = `INSERT INTO movies (source_id, key, provider_id, name, name_fold, logo, rating, year, extension, added, url_template, headers_json, run_id)
  SELECT source_id, key, provider_id, name, name_fold, logo, rating, year, extension, added, url_template, headers_json, run_id
  FROM movies_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    name = excluded.name,
    name_fold = excluded.name_fold,
    logo = excluded.logo,
    rating = excluded.rating,
    year = excluded.year,
    extension = excluded.extension,
    added = excluded.added,
    url_template = excluded.url_template,
    headers_json = excluded.headers_json,
    run_id = excluded.run_id`;

const UPSERT_SERIES = `INSERT INTO series (source_id, key, provider_id, name, name_fold, cover, plot, rating, year, last_modified, run_id)
  SELECT source_id, key, provider_id, name, name_fold, cover, plot, rating, year, last_modified, run_id
  FROM series_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    name = excluded.name,
    name_fold = excluded.name_fold,
    cover = excluded.cover,
    plot = excluded.plot,
    rating = excluded.rating,
    year = excluded.year,
    last_modified = excluded.last_modified,
    run_id = excluded.run_id`;

const UPSERT_EPISODES = `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, extension, duration_sec, url_template, headers_json, run_id)
  SELECT source_id, key, provider_id, series_key, season, episode, title, extension, duration_sec, url_template, headers_json, run_id
  FROM episodes_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    series_key = excluded.series_key,
    season = excluded.season,
    episode = excluded.episode,
    title = excluded.title,
    extension = excluded.extension,
    duration_sec = excluded.duration_sec,
    url_template = excluded.url_template,
    headers_json = excluded.headers_json,
    run_id = excluded.run_id`;

const UPSERT_PLACEMENTS = `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
  SELECT source_id, kind, item_key, category_id, position, run_id
  FROM placements_next
  WHERE source_id = ? AND kind = ? AND run_id = ?
  ON CONFLICT(source_id, kind, category_id, item_key) DO UPDATE SET
    position = excluded.position,
    run_id = excluded.run_id`;

const MERGE_WATCH_PROGRESS = `UPDATE watch_progress
  SET position_ms = CASE WHEN old.updated_at > watch_progress.updated_at THEN old.position_ms ELSE watch_progress.position_ms END,
      duration_ms = CASE WHEN old.updated_at > watch_progress.updated_at THEN old.duration_ms ELSE watch_progress.duration_ms END,
      updated_at = MAX(watch_progress.updated_at, old.updated_at),
      watched = MAX(watch_progress.watched, old.watched)
  FROM watch_progress AS old
  WHERE watch_progress.source_id = ? AND watch_progress.item_key = ?
    AND old.source_id = watch_progress.source_id AND old.profile_id = watch_progress.profile_id AND old.item_key = ?`;

const MERGE_FAVORITES = `UPDATE favorites
  SET added_at = MAX(favorites.added_at, old.added_at)
  FROM favorites AS old
  WHERE favorites.source_id = ? AND favorites.item_key = ?
    AND old.source_id = favorites.source_id AND old.profile_id = favorites.profile_id AND old.item_key = ?`;

const MERGE_PLACEMENTS_HIDDEN = `UPDATE placements
  SET is_hidden = MAX(placements.is_hidden, old.is_hidden)
  FROM placements AS old
  WHERE placements.source_id = ? AND placements.kind = ? AND placements.item_key = ?
    AND old.source_id = placements.source_id AND old.kind = placements.kind
    AND old.category_id = placements.category_id AND old.item_key = ?`;

interface LegacyPair {
  legacy_key: string;
  key: string;
}

async function remapKeyColumn(
  tx: SqlDriver,
  table: string,
  col: string,
  sourceId: string,
  pairs: readonly LegacyPair[],
  extraWhere?: { clause: string; params: readonly string[] },
  mergeSql?: string,
): Promise<void> {
  if (pairs.length === 0) return;
  const suffix = extraWhere === undefined ? '' : ` AND ${extraWhere.clause}`;
  const extraParams = extraWhere?.params ?? [];
  if (mergeSql !== undefined) {
    await tx.batch(
      mergeSql,
      pairs.map((p) => [sourceId, ...extraParams, p.key, p.legacy_key]),
    );
  }
  await tx.batch(
    `UPDATE OR IGNORE ${table} SET ${col} = ? WHERE source_id = ?${suffix} AND ${col} = ?`,
    pairs.map((p) => [p.key, sourceId, ...extraParams, p.legacy_key]),
  );
  await tx.batch(
    `DELETE FROM ${table} WHERE source_id = ?${suffix} AND ${col} = ?`,
    pairs.map((p) => [sourceId, ...extraParams, p.legacy_key]),
  );
}

async function migrateLegacyKeysForTable(
  tx: SqlDriver,
  sourceId: string,
  runId: number,
  nextTable: 'live_next' | 'movies_next' | 'episodes_next',
  liveTable: 'live' | 'movies' | 'episodes',
  placementKind: 'live' | 'movie' | undefined,
): Promise<void> {
  const hasLegacy = await tx.all(
    `SELECT 1 FROM ${nextTable} WHERE source_id = ? AND run_id = ? AND legacy_key IS NOT NULL AND legacy_key != key LIMIT 1`,
    [sourceId, runId],
  );
  if (hasLegacy.length === 0) return;

  const progressPairs = await tx.all<LegacyPair>(
    `SELECT DISTINCT n.legacy_key, n.key FROM ${nextTable} n
     WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
       AND n.legacy_key IN (SELECT item_key FROM watch_progress WHERE source_id = ?)`,
    [sourceId, runId, sourceId],
  );
  await remapKeyColumn(
    tx,
    'watch_progress',
    'item_key',
    sourceId,
    progressPairs,
    undefined,
    MERGE_WATCH_PROGRESS,
  );

  const favPairs = await tx.all<LegacyPair>(
    `SELECT DISTINCT n.legacy_key, n.key FROM ${nextTable} n
     WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
       AND n.legacy_key IN (SELECT item_key FROM favorites WHERE source_id = ?)`,
    [sourceId, runId, sourceId],
  );
  await remapKeyColumn(tx, 'favorites', 'item_key', sourceId, favPairs, undefined, MERGE_FAVORITES);

  if (nextTable === 'live_next') {
    const guidePairs = await tx.all<LegacyPair>(
      `SELECT DISTINCT n.legacy_key, n.key FROM live_next n
       WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
         AND EXISTS (SELECT 1 FROM channel_guide g WHERE g.source_id = n.source_id AND g.channel_key = n.legacy_key)`,
      [sourceId, runId],
    );
    await remapKeyColumn(tx, 'channel_guide', 'channel_key', sourceId, guidePairs);
  }

  const livePairs = await tx.all<LegacyPair>(
    `SELECT DISTINCT n.legacy_key, n.key FROM ${nextTable} n
     WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
       AND EXISTS (SELECT 1 FROM ${liveTable} t WHERE t.source_id = n.source_id AND t.key = n.legacy_key)`,
    [sourceId, runId],
  );
  const mergeLiveHidden =
    liveTable === 'episodes'
      ? undefined
      : `UPDATE ${liveTable}
         SET is_hidden = MAX(${liveTable}.is_hidden, old.is_hidden)
         FROM ${liveTable} AS old
         WHERE ${liveTable}.source_id = ? AND ${liveTable}.key = ?
           AND old.source_id = ${liveTable}.source_id AND old.key = ?`;
  await remapKeyColumn(tx, liveTable, 'key', sourceId, livePairs, undefined, mergeLiveHidden);

  if (placementKind !== undefined) {
    const placementPairs = await tx.all<LegacyPair>(
      `SELECT DISTINCT n.legacy_key, n.key FROM ${nextTable} n
       WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
         AND n.legacy_key IN (SELECT item_key FROM placements WHERE source_id = ? AND kind = ?)`,
      [sourceId, runId, sourceId, placementKind],
    );
    await remapKeyColumn(
      tx,
      'placements',
      'item_key',
      sourceId,
      placementPairs,
      { clause: 'kind = ?', params: [placementKind] },
      MERGE_PLACEMENTS_HIDDEN,
    );
  }
}

/**
 * Atomically commits staged `*_next` catalog rows for `(sourceId, runId)` inside an open transaction (`#418`, `#201`):
 * 1. Losslessly remaps legacy URL-based M3U keys in `watch_progress`, `favorites`, `channel_guide`, live tables, and `placements`.
 * 2. Upserts staged rows for `runId` into live tables preserving existing row `id` and `is_hidden`, skipping `keepKinds`.
 * 3. Removes stale live rows (`run_id < runId`) honoring `keepKinds` and purges all 6 `*_next` tables for `sourceId`.
 */
export async function commitStagedCatalog(
  tx: SqlDriver,
  sourceId: string,
  runId: number,
  keepKinds: readonly CatalogKind[],
): Promise<Record<string, number>> {
  const skip = new Set<CatalogKind>(keepKinds);

  if (!skip.has('live')) {
    await migrateLegacyKeysForTable(tx, sourceId, runId, 'live_next', 'live', 'live');
    await tx.run(UPSERT_LIVE, [sourceId, runId]);
  }
  if (!skip.has('movie')) {
    await migrateLegacyKeysForTable(tx, sourceId, runId, 'movies_next', 'movies', 'movie');
    await tx.run(UPSERT_MOVIES, [sourceId, runId]);
  }
  if (!skip.has('series')) {
    await migrateLegacyKeysForTable(tx, sourceId, runId, 'episodes_next', 'episodes', undefined);
    await tx.run(UPSERT_SERIES, [sourceId, runId]);
    await tx.run(UPSERT_EPISODES, [sourceId, runId]);
  }
  for (const kind of ACTIVE_KINDS) {
    if (skip.has(kind)) continue;
    await tx.run(UPSERT_CATEGORIES, [sourceId, kind, runId]);
    await tx.run(UPSERT_PLACEMENTS, [sourceId, kind, runId]);
  }

  const removed = await removeStaleCatalog(tx, sourceId, runId, keepKinds);
  await purgeStagedCatalog(tx, sourceId);
  return removed;
}
