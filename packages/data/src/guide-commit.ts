import type { SqlDriver, SqlValue } from '@elv/domain';
import { resolveMappings } from './guide-match';
import { type RunCtx, warn } from './import-run';
import { reconcileRemindersAfterGuideImport } from './reminders-repo';

const PROGRAMME_COLUMNS =
  'source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold';

/** Upserts one staged programme into `programmes_next`. */
export const STAGE_PROGRAMME_SQL = `INSERT INTO programmes_next (${PROGRAMME_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title,
    sub_title = excluded.sub_title, description = excluded.description, categories_json = excluded.categories_json,
    episode_num = excluded.episode_num, icon = excluded.icon, run_id = excluded.run_id,
    genre = excluded.genre, flags = excluded.flags, rating_system = excluded.rating_system,
    rating_value = excluded.rating_value, title_fold = excluded.title_fold,
    description_fold = excluded.description_fold`;

const GUIDE_CHANNEL_SQL = `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, icon, run_id, lcn)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    icon = excluded.icon, run_id = excluded.run_id, lcn = excluded.lcn`;

const PRESERVE_RETAINED_PROGRAMMES = `INSERT OR IGNORE INTO programmes_next (${PROGRAMME_COLUMNS})
  SELECT
    source_id,
    guide_id,
    start,
    stop,
    title,
    sub_title,
    description,
    categories_json,
    episode_num,
    icon,
    ?,
    genre,
    flags,
    rating_system,
    rating_value,
    title_fold,
    description_fold
  FROM programmes
  WHERE source_id = ?
    AND stop > ?
    AND start < COALESCE(
      (SELECT MIN(pn.start) FROM programmes_next pn
        WHERE pn.source_id = programmes.source_id
          AND pn.guide_id = programmes.guide_id
          AND pn.run_id = ?
          AND pn.start >= ?),
      ?
    )`;

const SWAP_PROGRAMMES = `INSERT INTO programmes (${PROGRAMME_COLUMNS})
  SELECT
    source_id,
    guide_id,
    start,
    CASE WHEN next_start IS NOT NULL AND stop > next_start THEN next_start ELSE stop END AS stop,
    title,
    sub_title,
    description,
    categories_json,
    episode_num,
    icon,
    run_id,
    genre,
    flags,
    rating_system,
    rating_value,
    title_fold,
    description_fold
  FROM (
    SELECT ${PROGRAMME_COLUMNS},
      LEAD(start) OVER (PARTITION BY guide_id ORDER BY start) AS next_start
    FROM programmes_next
    WHERE source_id = ? AND run_id = ? AND guide_id IN (SELECT guide_id FROM channel_guide WHERE source_id = ?)
  )
  WHERE CASE WHEN next_start IS NOT NULL AND stop > next_start THEN next_start ELSE stop END > start`;

/** Cap per `tx.batch` chunk in guide commit so 5,000-channel JSI marshalling stays under 100 ms (`#478`). */
const MAX_COMMIT_BATCH = 500;
/** Mapped `guide_id`s indexed per `programmes_fts` chunk (`<= 251` bind params, well below 999 ceiling `#478`). */
const FTS_GUIDE_ID_CHUNK = 250;

const POPULATE_PROGRAMMES_FTS_PREFIX = `INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold)
  SELECT source_id, guide_id, start, stop, title_fold, description_fold
  FROM programmes
  WHERE source_id = ? AND guide_id IN (`;

/** What a guide run collected for its cleanup transaction. */
export interface GuideResult {
  /** `guide_channels` rows. */
  channelRows: SqlValue[][];
  /** `[channelKey, guideId]` pairs matched by exact guide id. */
  byId: [string, string][];
  /** `[channelKey, guideId]` pairs matched by case-insensitive guide id. */
  byCiId?: [string, string][];
  /** `[channelKey, guideId]` pairs matched by `@feedId`-stripped base guide id. */
  byBaseId?: [string, string][];
  /** Live channel folded display names keyed by channel key for regional `@feedId` disambiguation. */
  channelNameFolds?: ReadonlyMap<string, string>;
  /** `[channelKey, guideId]` pairs matched by exact folded name; id matches win over them. */
  byName: [string, string][];
  /** `[channelKey, guideId]` pairs matched by normalized name; exact folded names win over them. */
  byNormalizedName?: [string, string][];
  /** `[channelKey, guideId]` pairs matched by unique channel number; id and name matches win over them. */
  byNum: [string, string][];
  /** Programmes staged per guide id. */
  staged: Map<string, number>;
  /** Oldest catch-up retention boundary (`now - effectiveDaysBack * DAY_MS`); past rows with `stop > retentionFloorMs` are preserved. */
  retentionFloorMs?: number;
  /** Fallback upper start boundary (`now`) for preserving previously retained past programmes when a `guide_id` has no fresh rows at or after `retentionFloorMs`. */
  preserveBeforeMs?: number;
  /** Optional priority-ordered pre-resolved `[channelKey, guideId]` pairs produced by multi-guide ingestion (`#30`). */
  preResolvedMappings?: readonly (readonly [string, string])[];
  /** Optional winning `guide_sources.id` per channel key for `channel_guide_overrides` attribution (`#30`). */
  winningGuideSourceByChannel?: ReadonlyMap<string, string>;
  /** Optional sync metadata updates for synced `guide_sources` rows (`#30`). */
  syncedGuideSources?: readonly {
    readonly id: string;
    readonly lastSyncAt: number;
    readonly httpCacheJson: string | null;
  }[];
  /** Epoch-ms timestamp of this guide sync (used for auto attribution rows). */
  syncedAt?: number;
}

/**
 * Replaces the guide of a source inside the cleanup transaction: Tier-0 manual overrides
 * (`channel_guide_overrides WHERE is_manual = 1`) always win channel matching and are never
 * overwritten; automatic mappings (multi-guide priority-ordered or 6-tier single-guide) fill
 * remaining channels; guide channels and non-overlapping `[start, stop)` programmes swap
 * atomically; and scheduled programme reminders reconcile against shifted programme times.
 */
export async function commitGuide(tx: SqlDriver, c: RunCtx, g: GuideResult): Promise<void> {
  const autoMappings =
    g.preResolvedMappings !== undefined
      ? g.preResolvedMappings
      : resolveMappings(g.byId, g.byName, g.byNum, g.byNormalizedName, {
          ...(g.byCiId === undefined ? {} : { byCiId: g.byCiId }),
          ...(g.byBaseId === undefined ? {} : { byBaseId: g.byBaseId }),
          ...(g.channelNameFolds === undefined ? {} : { channelNameFolds: g.channelNameFolds }),
        });

  const manualRows = await tx.all<{ channel_key: string; guide_id: string }>(
    `SELECT channel_key, guide_id
       FROM channel_guide_overrides
      WHERE source_id = ? AND is_manual = 1 AND guide_id IS NOT NULL AND guide_id != ''`,
    [c.sourceId],
  );
  const finalMap = new Map<string, string>();
  for (const m of manualRows) {
    finalMap.set(m.channel_key, m.guide_id);
  }
  for (const [key, guideId] of autoMappings) {
    if (!finalMap.has(key)) finalMap.set(key, guideId);
  }
  const mappings = [...finalMap];

  const mapped = new Set(mappings.map(([, guideId]) => guideId));
  const empty = ![...mapped].some((guideId) => (g.staged.get(guideId) ?? 0) > 0);
  if (empty && (await hasProgrammes(tx, c.sourceId))) {
    await tx.run('DELETE FROM programmes_next WHERE source_id = ? AND run_id = ?', [
      c.sourceId,
      c.runId,
    ]);
    c.keepTables.add('guide_channels');
    warn(c, 'guide/empty');
    c.counts.mapped = mapped.size;
    c.counts.programmes = 0;
    return;
  }
  const commitChunk = Math.min(c.batchSize, MAX_COMMIT_BATCH);
  await tx.run('DELETE FROM channel_guide WHERE source_id = ?', [c.sourceId]);
  for (let i = 0; i < mappings.length; i += commitChunk) {
    await tx.batch(
      'INSERT OR IGNORE INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
      mappings.slice(i, i + commitChunk).map(([key, guideId]) => [c.sourceId, key, guideId]),
    );
    if (i + commitChunk < mappings.length) {
      await c.deps.scheduler.yieldNow();
    }
  }
  if (g.winningGuideSourceByChannel !== undefined) {
    await tx.run('DELETE FROM channel_guide_overrides WHERE source_id = ? AND is_manual = 0', [
      c.sourceId,
    ]);
    const syncedAt = g.syncedAt ?? c.deps.clock();
    const autoAttrRows: SqlValue[][] = [];
    for (const [channelKey, guideSourceId] of g.winningGuideSourceByChannel) {
      const guideId = finalMap.get(channelKey);
      if (guideId === undefined) continue;
      autoAttrRows.push([c.sourceId, channelKey, guideSourceId, guideId, syncedAt]);
    }
    for (let i = 0; i < autoAttrRows.length; i += commitChunk) {
      await tx.batch(
        `INSERT OR IGNORE INTO channel_guide_overrides
           (source_id, channel_key, guide_source_id, guide_id, epg_shift_ms, is_manual, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?)`,
        autoAttrRows.slice(i, i + commitChunk),
      );
      if (i + commitChunk < autoAttrRows.length) {
        await c.deps.scheduler.yieldNow();
      }
    }
  }
  if (g.syncedGuideSources !== undefined) {
    for (const gs of g.syncedGuideSources) {
      await tx.run(
        'UPDATE guide_sources SET last_sync_at = ?, http_cache_json = ? WHERE source_id = ? AND id = ?',
        [gs.lastSyncAt, gs.httpCacheJson, c.sourceId, gs.id],
      );
    }
  }
  for (let i = 0; i < g.channelRows.length; i += commitChunk) {
    await tx.batch(GUIDE_CHANNEL_SQL, g.channelRows.slice(i, i + commitChunk));
    if (i + commitChunk < g.channelRows.length) {
      await c.deps.scheduler.yieldNow();
    }
  }
  if (g.retentionFloorMs !== undefined && g.preserveBeforeMs !== undefined) {
    await tx.run(PRESERVE_RETAINED_PROGRAMMES, [
      c.runId,
      c.sourceId,
      g.retentionFloorMs,
      c.runId,
      g.retentionFloorMs,
      g.preserveBeforeMs,
    ]);
  }
  await tx.run('DELETE FROM programmes WHERE source_id = ?', [c.sourceId]);
  const swapped = await tx.run(SWAP_PROGRAMMES, [c.sourceId, c.runId, c.sourceId]);
  await tx.run('DELETE FROM programmes_fts WHERE source_id = ?', [c.sourceId]);
  if (swapped.changes > 0) {
    const mappedIds = [...mapped];
    for (let i = 0; i < mappedIds.length; i += FTS_GUIDE_ID_CHUNK) {
      const chunk = mappedIds.slice(i, i + FTS_GUIDE_ID_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      await tx.run(`${POPULATE_PROGRAMMES_FTS_PREFIX}${placeholders})`, [c.sourceId, ...chunk]);
      if (i + FTS_GUIDE_ID_CHUNK < mappedIds.length) {
        await c.deps.scheduler.yieldNow();
      }
    }
  }
  await tx.run('DELETE FROM programmes_next WHERE source_id = ? AND run_id = ?', [
    c.sourceId,
    c.runId,
  ]);
  await reconcileRemindersAfterGuideImport(tx, c.sourceId);
  c.counts.mapped = mapped.size;
  c.counts.programmes = swapped.changes;
}

async function hasProgrammes(tx: SqlDriver, sourceId: string): Promise<boolean> {
  return (
    (await tx.all('SELECT 1 FROM programmes WHERE source_id = ? LIMIT 1', [sourceId])).length > 0
  );
}

/** Clears the staged programmes of one run; a failure here must not hide the error that ended the run. */
export async function dropStaging(db: SqlDriver, sourceId: string, runId: number): Promise<void> {
  try {
    await db.run('DELETE FROM programmes_next WHERE source_id = ? AND run_id = ?', [
      sourceId,
      runId,
    ]);
  } catch {
    // the next guide run clears leftovers before it starts
  }
}
