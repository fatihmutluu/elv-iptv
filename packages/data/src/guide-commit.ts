import type { SqlDriver, SqlValue } from '@elv/domain';
import { resolveMappings } from './guide-match';
import { type RunCtx, warn } from './import-run';

const PROGRAMME_COLUMNS =
  'source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id, genre, flags';

/** Upserts one staged programme into `programmes_next`. */
export const STAGE_PROGRAMME_SQL = `INSERT INTO programmes_next (${PROGRAMME_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title,
    sub_title = excluded.sub_title, description = excluded.description, categories_json = excluded.categories_json,
    episode_num = excluded.episode_num, icon = excluded.icon, run_id = excluded.run_id,
    genre = excluded.genre, flags = excluded.flags`;

const GUIDE_CHANNEL_SQL = `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, icon, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    icon = excluded.icon, run_id = excluded.run_id`;

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
    flags
  FROM (
    SELECT ${PROGRAMME_COLUMNS},
      LEAD(start) OVER (PARTITION BY guide_id ORDER BY start) AS next_start
    FROM programmes_next
    WHERE source_id = ? AND run_id = ? AND guide_id IN (SELECT guide_id FROM channel_guide WHERE source_id = ?)
  )
  WHERE CASE WHEN next_start IS NOT NULL AND stop > next_start THEN next_start ELSE stop END > start`;

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
}

/**
 * Replaces the guide of a source inside the cleanup transaction: the mappings (exact/CI/base id matches first,
 * then unambiguous exact/normalized name matches, then unambiguous channel-number matches), the guide channels,
 * and the staged programmes of mapped guide ids normalized into strictly non-overlapping `[start, stop)`
 * intervals. Sets `counts.mapped` and `counts.programmes` to what was stored. A guide that would store no
 * programme while the previous one has some is dropped instead: the previous guide stays (also its channels,
 * via `keepTables`) and the run gets the warning `guide/empty`.
 */
export async function commitGuide(tx: SqlDriver, c: RunCtx, g: GuideResult): Promise<void> {
  const mappings = resolveMappings(g.byId, g.byName, g.byNum, g.byNormalizedName, {
    ...(g.byCiId === undefined ? {} : { byCiId: g.byCiId }),
    ...(g.byBaseId === undefined ? {} : { byBaseId: g.byBaseId }),
    ...(g.channelNameFolds === undefined ? {} : { channelNameFolds: g.channelNameFolds }),
  });
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
  await tx.run('DELETE FROM channel_guide WHERE source_id = ?', [c.sourceId]);
  for (let i = 0; i < mappings.length; i += c.batchSize) {
    await tx.batch(
      'INSERT OR IGNORE INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
      mappings.slice(i, i + c.batchSize).map(([key, guideId]) => [c.sourceId, key, guideId]),
    );
  }
  for (let i = 0; i < g.channelRows.length; i += c.batchSize) {
    await tx.batch(GUIDE_CHANNEL_SQL, g.channelRows.slice(i, i + c.batchSize));
  }
  await tx.run('DELETE FROM programmes WHERE source_id = ?', [c.sourceId]);
  const swapped = await tx.run(SWAP_PROGRAMMES, [c.sourceId, c.runId, c.sourceId]);
  await tx.run('DELETE FROM programmes_next WHERE source_id = ? AND run_id = ?', [
    c.sourceId,
    c.runId,
  ]);
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
