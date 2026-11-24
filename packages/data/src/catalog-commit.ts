import type { SqlDriver } from '@elv/domain';
import type { CatalogKind } from './runs';
import { purgeStagedCatalog } from './sources';

export { purgeStagedCatalog };

const ACTIVE_KINDS: readonly CatalogKind[] = ['live', 'movie', 'series'];

const UPSERT_CATEGORIES = `INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id, content_hash)
  SELECT source_id, kind, provider_id, name, name_fold, position, run_id, content_hash
  FROM categories_next
  WHERE source_id = ? AND kind = ? AND run_id = ?
  ON CONFLICT(source_id, kind, provider_id) DO UPDATE SET
    name = excluded.name,
    name_fold = excluded.name_fold,
    position = excluded.position,
    run_id = excluded.run_id,
    content_hash = excluded.content_hash
  WHERE categories.content_hash IS NULL
     OR excluded.content_hash IS NULL
     OR categories.content_hash != excluded.content_hash`;

const UPSERT_LIVE = `INSERT INTO live (source_id, key, provider_id, num, name, name_fold, sort_title, variant_base_fold, quality_rank, logo, guide_id, catchup_days, url_template, headers_json, backup_urls_json, epg_shift_ms, run_id, content_hash)
  SELECT source_id, key, provider_id, num, name, name_fold, sort_title, variant_base_fold, quality_rank, logo, guide_id, catchup_days, url_template, headers_json, backup_urls_json, epg_shift_ms, run_id, content_hash
  FROM live_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    num = excluded.num,
    name = excluded.name,
    name_fold = excluded.name_fold,
    sort_title = excluded.sort_title,
    variant_base_fold = excluded.variant_base_fold,
    quality_rank = excluded.quality_rank,
    logo = excluded.logo,
    guide_id = excluded.guide_id,
    catchup_days = excluded.catchup_days,
    url_template = excluded.url_template,
    headers_json = excluded.headers_json,
    backup_urls_json = excluded.backup_urls_json,
    epg_shift_ms = excluded.epg_shift_ms,
    run_id = excluded.run_id,
    content_hash = excluded.content_hash
  WHERE live.content_hash IS NULL
     OR excluded.content_hash IS NULL
     OR live.content_hash != excluded.content_hash
     OR live.sort_title != excluded.sort_title
     OR live.variant_base_fold != excluded.variant_base_fold
     OR live.quality_rank != excluded.quality_rank`;

const UPSERT_MOVIES = `INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, version_group_key, version_label, logo, rating, year, extension, added, url_template, headers_json, backup_urls_json, cast_text, director_text, cast_fold, director_fold, run_id, content_hash)
  SELECT source_id, key, provider_id, name, name_fold, sort_title, version_group_key, version_label, logo, rating, year, extension, added, url_template, headers_json, backup_urls_json, cast_text, director_text, cast_fold, director_fold, run_id, content_hash
  FROM movies_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    name = excluded.name,
    name_fold = excluded.name_fold,
    sort_title = excluded.sort_title,
    version_group_key = excluded.version_group_key,
    version_label = excluded.version_label,
    logo = excluded.logo,
    rating = excluded.rating,
    year = excluded.year,
    extension = excluded.extension,
    added = excluded.added,
    url_template = excluded.url_template,
    headers_json = excluded.headers_json,
    backup_urls_json = excluded.backup_urls_json,
    cast_text = COALESCE(excluded.cast_text, movies.cast_text),
    director_text = COALESCE(excluded.director_text, movies.director_text),
    cast_fold = COALESCE(excluded.cast_fold, movies.cast_fold),
    director_fold = COALESCE(excluded.director_fold, movies.director_fold),
    run_id = excluded.run_id,
    content_hash = excluded.content_hash
  WHERE movies.content_hash IS NULL
     OR excluded.content_hash IS NULL
     OR movies.content_hash != excluded.content_hash
     OR movies.sort_title != excluded.sort_title
     OR movies.version_group_key != excluded.version_group_key
     OR movies.version_label IS NOT excluded.version_label
     OR (excluded.cast_fold IS NOT NULL AND movies.cast_fold IS NOT excluded.cast_fold)
     OR (excluded.director_fold IS NOT NULL AND movies.director_fold IS NOT excluded.director_fold)`;

const UPSERT_SERIES = `INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, cover, plot, rating, year, last_modified, cast_text, director_text, cast_fold, director_fold, run_id, content_hash)
  SELECT source_id, key, provider_id, name, name_fold, sort_title, cover, plot, rating, year, last_modified, cast_text, director_text, cast_fold, director_fold, run_id, content_hash
  FROM series_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    name = excluded.name,
    name_fold = excluded.name_fold,
    sort_title = excluded.sort_title,
    cover = excluded.cover,
    plot = excluded.plot,
    rating = excluded.rating,
    year = excluded.year,
    last_modified = excluded.last_modified,
    cast_text = COALESCE(excluded.cast_text, series.cast_text),
    director_text = COALESCE(excluded.director_text, series.director_text),
    cast_fold = COALESCE(excluded.cast_fold, series.cast_fold),
    director_fold = COALESCE(excluded.director_fold, series.director_fold),
    run_id = excluded.run_id,
    content_hash = excluded.content_hash
  WHERE series.content_hash IS NULL
     OR excluded.content_hash IS NULL
     OR series.content_hash != excluded.content_hash
     OR series.sort_title != excluded.sort_title
     OR (excluded.cast_fold IS NOT NULL AND series.cast_fold IS NOT excluded.cast_fold)
     OR (excluded.director_fold IS NOT NULL AND series.director_fold IS NOT excluded.director_fold)`;

const UPSERT_EPISODES = `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, extension, duration_sec, url_template, headers_json, backup_urls_json, run_id)
  SELECT source_id, key, provider_id, series_key, season, episode, title, title_fold, extension, duration_sec, url_template, headers_json, backup_urls_json, run_id
  FROM episodes_next
  WHERE source_id = ? AND run_id = ?
  ON CONFLICT(source_id, key) DO UPDATE SET
    provider_id = excluded.provider_id,
    series_key = excluded.series_key,
    season = excluded.season,
    episode = excluded.episode,
    title = excluded.title,
    title_fold = excluded.title_fold,
    extension = excluded.extension,
    duration_sec = excluded.duration_sec,
    url_template = excluded.url_template,
    headers_json = excluded.headers_json,
    backup_urls_json = excluded.backup_urls_json,
    run_id = excluded.run_id`;

const UPSERT_PLACEMENTS = `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
  SELECT source_id, kind, item_key, category_id, position, run_id
  FROM placements_next
  WHERE source_id = ? AND kind = ? AND run_id = ?
  ON CONFLICT(source_id, kind, category_id, item_key) DO UPDATE SET
    position = excluded.position,
    run_id = excluded.run_id
  WHERE placements.position != excluded.position`;

const DELETE_STALE_LIVE = `DELETE FROM live
  WHERE source_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM live_next n
      WHERE n.source_id = live.source_id AND n.key = live.key AND n.run_id = ?
    )`;

const DELETE_STALE_MOVIES = `DELETE FROM movies
  WHERE source_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM movies_next n
      WHERE n.source_id = movies.source_id AND n.key = movies.key AND n.run_id = ?
    )`;

const DELETE_STALE_SERIES = `DELETE FROM series
  WHERE source_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM series_next n
      WHERE n.source_id = series.source_id AND n.key = series.key AND n.run_id = ?
    )`;

const DELETE_STALE_EPISODES_BY_STAGED = `DELETE FROM episodes
  WHERE source_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM episodes_next n
      WHERE n.source_id = episodes.source_id AND n.key = episodes.key AND n.run_id = ?
    )`;

const DELETE_ORPHAN_EPISODES_BY_SERIES = `DELETE FROM episodes
  WHERE source_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM series_next n
      WHERE n.source_id = episodes.source_id AND n.key = episodes.series_key AND n.run_id = ?
    )`;

const DELETE_STALE_CATEGORIES = `DELETE FROM categories
  WHERE source_id = ? AND kind = ?
    AND NOT EXISTS (
      SELECT 1 FROM categories_next n
      WHERE n.source_id = categories.source_id
        AND n.kind = categories.kind
        AND n.provider_id = categories.provider_id
        AND n.run_id = ?
    )`;

const DELETE_STALE_PLACEMENTS = `DELETE FROM placements
  WHERE source_id = ? AND kind = ?
    AND NOT EXISTS (
      SELECT 1 FROM placements_next n
      WHERE n.source_id = placements.source_id
        AND n.kind = placements.kind
        AND n.category_id = placements.category_id
        AND n.item_key = placements.item_key
        AND n.run_id = ?
    )`;

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

const MERGE_CHANNEL_OVERRIDES = `UPDATE channel_overrides
  SET custom_name = CASE WHEN old.updated_at > channel_overrides.updated_at THEN old.custom_name ELSE COALESCE(channel_overrides.custom_name, old.custom_name) END,
      is_hidden = CASE WHEN old.updated_at > channel_overrides.updated_at THEN old.is_hidden ELSE MAX(channel_overrides.is_hidden, old.is_hidden) END,
      sort_order = CASE WHEN old.updated_at > channel_overrides.updated_at THEN old.sort_order ELSE COALESCE(channel_overrides.sort_order, old.sort_order) END,
      updated_at = MAX(channel_overrides.updated_at, old.updated_at)
  FROM channel_overrides AS old
  WHERE channel_overrides.source_id = ? AND channel_overrides.item_key = ?
    AND old.source_id = channel_overrides.source_id AND old.profile_id = channel_overrides.profile_id AND old.item_key = ?`;

const MERGE_CUSTOM_GROUP_ITEMS = `UPDATE custom_group_items
  SET position = MIN(custom_group_items.position, old.position),
      added_at = MIN(custom_group_items.added_at, old.added_at)
  FROM custom_group_items AS old
  WHERE custom_group_items.source_id = ? AND custom_group_items.item_key = ?
    AND old.source_id = custom_group_items.source_id AND old.group_id = custom_group_items.group_id AND old.item_key = ?`;

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

    const overridePairs = await tx.all<LegacyPair>(
      `SELECT DISTINCT n.legacy_key, n.key FROM live_next n
       WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
         AND n.legacy_key IN (SELECT item_key FROM channel_overrides WHERE source_id = ?)`,
      [sourceId, runId, sourceId],
    );
    await remapKeyColumn(
      tx,
      'channel_overrides',
      'item_key',
      sourceId,
      overridePairs,
      undefined,
      MERGE_CHANNEL_OVERRIDES,
    );

    const customGroupItemPairs = await tx.all<LegacyPair>(
      `SELECT DISTINCT n.legacy_key, n.key FROM live_next n
       WHERE n.source_id = ? AND n.run_id = ? AND n.legacy_key IS NOT NULL AND n.legacy_key != n.key
         AND n.legacy_key IN (SELECT item_key FROM custom_group_items WHERE source_id = ?)`,
      [sourceId, runId, sourceId],
    );
    await remapKeyColumn(
      tx,
      'custom_group_items',
      'item_key',
      sourceId,
      customGroupItemPairs,
      undefined,
      MERGE_CUSTOM_GROUP_ITEMS,
    );
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

async function deleteStaleFromStaged(
  tx: SqlDriver,
  sourceId: string,
  runId: number,
  skip: ReadonlySet<CatalogKind>,
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const add = (table: string, changes: number) => {
    removed[table] = (removed[table] ?? 0) + changes;
  };
  if (!skip.has('live')) {
    add('live', (await tx.run(DELETE_STALE_LIVE, [sourceId, runId])).changes);
  }
  if (!skip.has('movie')) {
    add('movies', (await tx.run(DELETE_STALE_MOVIES, [sourceId, runId])).changes);
  }
  if (!skip.has('series')) {
    add('series', (await tx.run(DELETE_STALE_SERIES, [sourceId, runId])).changes);
    const hasStagedEpisodes =
      (
        await tx.all('SELECT 1 FROM episodes_next WHERE source_id = ? AND run_id = ? LIMIT 1', [
          sourceId,
          runId,
        ])
      ).length > 0;
    const epSql = hasStagedEpisodes
      ? DELETE_STALE_EPISODES_BY_STAGED
      : DELETE_ORPHAN_EPISODES_BY_SERIES;
    add('episodes', (await tx.run(epSql, [sourceId, runId])).changes);
  }
  for (const kind of ACTIVE_KINDS) {
    if (skip.has(kind)) continue;
    add('categories', (await tx.run(DELETE_STALE_CATEGORIES, [sourceId, kind, runId])).changes);
    add('placements', (await tx.run(DELETE_STALE_PLACEMENTS, [sourceId, kind, runId])).changes);
  }
  return removed;
}

/**
 * Atomically commits staged `*_next` catalog rows for `(sourceId, runId)` inside an open transaction (`#418`, `#201`, `#192`):
 * 1. Losslessly remaps legacy URL-based M3U keys in `watch_progress`, `favorites`, `channel_guide`, live tables, and `placements`.
 * 2. Upserts staged rows for `runId` into live tables guarded by `content_hash` (zero UPDATEs for unchanged rows), preserving `id`, `is_hidden`, and original `run_id`, skipping `keepKinds`.
 * 3. Removes deleted live rows via indexed `NOT EXISTS` lookups against `*_next` (honoring `keepKinds` and preserving surviving Xtream episodes), then purges all 6 `*_next` tables for `sourceId`.
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

  const removed = await deleteStaleFromStaged(tx, sourceId, runId, skip);
  await purgeStagedCatalog(tx, sourceId);
  return removed;
}
