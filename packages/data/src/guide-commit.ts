import type { SqlDriver, SqlValue } from '@elv/domain';
import { resolveMappings } from './guide-match';
import type { RunCtx } from './import-run';

const PROGRAMME_COLUMNS =
  'source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id';

/** Upserts one staged programme into `programmes_next`. */
export const STAGE_PROGRAMME_SQL = `INSERT INTO programmes_next (${PROGRAMME_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id, start) DO UPDATE SET stop = excluded.stop, title = excluded.title,
    sub_title = excluded.sub_title, description = excluded.description, categories_json = excluded.categories_json,
    episode_num = excluded.episode_num, icon = excluded.icon, run_id = excluded.run_id`;

const GUIDE_CHANNEL_SQL = `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, icon, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, guide_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    icon = excluded.icon, run_id = excluded.run_id`;

const SWAP_PROGRAMMES = `INSERT INTO programmes (${PROGRAMME_COLUMNS})
  SELECT ${PROGRAMME_COLUMNS} FROM programmes_next
  WHERE source_id = ? AND run_id = ? AND guide_id IN (SELECT guide_id FROM channel_guide WHERE source_id = ?)`;

/** What a guide run collected for its cleanup transaction. */
export interface GuideResult {
  /** `guide_channels` rows. */
  channelRows: SqlValue[][];
  /** `[channelKey, guideId]` pairs matched by guide id. */
  byId: [string, string][];
  /** `[channelKey, guideId]` pairs matched by a folded name; id matches win over them. */
  byName: [string, string][];
}

/**
 * Replaces the guide of a source inside the cleanup transaction: the mappings (id matches first, then unambiguous
 * name matches of channels without one), the guide channels, and the staged programmes of mapped guide ids only.
 * Sets `counts.mapped` and `counts.programmes` to what was stored.
 */
export async function commitGuide(tx: SqlDriver, c: RunCtx, g: GuideResult): Promise<void> {
  const mappings = resolveMappings(g.byId, g.byName);
  await tx.run('DELETE FROM channel_guide WHERE source_id = ?', [c.sourceId]);
  if (mappings.length > 0) {
    await tx.batch(
      'INSERT OR IGNORE INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)',
      mappings.map(([key, guideId]) => [c.sourceId, key, guideId]),
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
  c.counts.mapped = new Set(mappings.map(([, guideId]) => guideId)).size;
  c.counts.programmes = swapped.changes;
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
