import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';

const BACKFILL_BATCH_SIZE = 1_000;

/**
 * Migration v12 (`#397`, `#407`):
 * - `movies[_next].{cast_text,director_text,cast_fold,director_fold}` + `series[_next].{cast_text,director_text,cast_fold,director_fold}`
 * - `episodes[_next].title_fold`
 * - Rebuilds `movies_fts` and `series_fts` as 3-column external-content FTS5 `(name_fold, cast_fold, director_fold)`
 * - Creates `episodes_fts` external-content FTS5 `(title_fold)` with `_ai`/`_ad`/`_au` triggers
 * - Creates standalone `programmes_fts` FTS5 virtual table (`programmes` is `WITHOUT ROWID`) + guide lookup indexes
 */
export const MIGRATION_V12 = `
ALTER TABLE movies ADD COLUMN cast_text TEXT;
ALTER TABLE movies ADD COLUMN director_text TEXT;
ALTER TABLE movies ADD COLUMN cast_fold TEXT;
ALTER TABLE movies ADD COLUMN director_fold TEXT;

ALTER TABLE movies_next ADD COLUMN cast_text TEXT;
ALTER TABLE movies_next ADD COLUMN director_text TEXT;
ALTER TABLE movies_next ADD COLUMN cast_fold TEXT;
ALTER TABLE movies_next ADD COLUMN director_fold TEXT;

ALTER TABLE series ADD COLUMN cast_text TEXT;
ALTER TABLE series ADD COLUMN director_text TEXT;
ALTER TABLE series ADD COLUMN cast_fold TEXT;
ALTER TABLE series ADD COLUMN director_fold TEXT;

ALTER TABLE series_next ADD COLUMN cast_text TEXT;
ALTER TABLE series_next ADD COLUMN director_text TEXT;
ALTER TABLE series_next ADD COLUMN cast_fold TEXT;
ALTER TABLE series_next ADD COLUMN director_fold TEXT;

ALTER TABLE episodes ADD COLUMN title_fold TEXT NOT NULL DEFAULT '';
ALTER TABLE episodes_next ADD COLUMN title_fold TEXT NOT NULL DEFAULT '';

DROP TRIGGER IF EXISTS movies_ai;
DROP TRIGGER IF EXISTS movies_ad;
DROP TRIGGER IF EXISTS movies_au;
DROP TABLE IF EXISTS movies_fts;

CREATE VIRTUAL TABLE movies_fts USING fts5(
  name_fold,
  cast_fold,
  director_fold,
  content='movies',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER movies_ai AFTER INSERT ON movies BEGIN
  INSERT INTO movies_fts(rowid, name_fold, cast_fold, director_fold)
  VALUES (new.id, new.name_fold, new.cast_fold, new.director_fold);
END;
CREATE TRIGGER movies_ad AFTER DELETE ON movies BEGIN
  INSERT INTO movies_fts(movies_fts, rowid, name_fold, cast_fold, director_fold)
  VALUES ('delete', old.id, old.name_fold, old.cast_fold, old.director_fold);
END;
CREATE TRIGGER movies_au AFTER UPDATE OF name_fold, cast_fold, director_fold ON movies
WHEN old.name_fold IS NOT new.name_fold
  OR old.cast_fold IS NOT new.cast_fold
  OR old.director_fold IS NOT new.director_fold
BEGIN
  INSERT INTO movies_fts(movies_fts, rowid, name_fold, cast_fold, director_fold)
  VALUES ('delete', old.id, old.name_fold, old.cast_fold, old.director_fold);
  INSERT INTO movies_fts(rowid, name_fold, cast_fold, director_fold)
  VALUES (new.id, new.name_fold, new.cast_fold, new.director_fold);
END;
INSERT INTO movies_fts(movies_fts) VALUES ('rebuild');

DROP TRIGGER IF EXISTS series_ai;
DROP TRIGGER IF EXISTS series_ad;
DROP TRIGGER IF EXISTS series_au;
DROP TABLE IF EXISTS series_fts;

CREATE VIRTUAL TABLE series_fts USING fts5(
  name_fold,
  cast_fold,
  director_fold,
  content='series',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER series_ai AFTER INSERT ON series BEGIN
  INSERT INTO series_fts(rowid, name_fold, cast_fold, director_fold)
  VALUES (new.id, new.name_fold, new.cast_fold, new.director_fold);
END;
CREATE TRIGGER series_ad AFTER DELETE ON series BEGIN
  INSERT INTO series_fts(series_fts, rowid, name_fold, cast_fold, director_fold)
  VALUES ('delete', old.id, old.name_fold, old.cast_fold, old.director_fold);
END;
CREATE TRIGGER series_au AFTER UPDATE OF name_fold, cast_fold, director_fold ON series
WHEN old.name_fold IS NOT new.name_fold
  OR old.cast_fold IS NOT new.cast_fold
  OR old.director_fold IS NOT new.director_fold
BEGIN
  INSERT INTO series_fts(series_fts, rowid, name_fold, cast_fold, director_fold)
  VALUES ('delete', old.id, old.name_fold, old.cast_fold, old.director_fold);
  INSERT INTO series_fts(rowid, name_fold, cast_fold, director_fold)
  VALUES (new.id, new.name_fold, new.cast_fold, new.director_fold);
END;
INSERT INTO series_fts(series_fts) VALUES ('rebuild');

DROP TRIGGER IF EXISTS episodes_ai;
DROP TRIGGER IF EXISTS episodes_ad;
DROP TRIGGER IF EXISTS episodes_au;
DROP TABLE IF EXISTS episodes_fts;

CREATE VIRTUAL TABLE episodes_fts USING fts5(
  title_fold,
  content='episodes',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, title_fold) VALUES (new.id, new.title_fold);
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title_fold)
  VALUES ('delete', old.id, old.title_fold);
END;
CREATE TRIGGER episodes_au AFTER UPDATE OF title_fold ON episodes
WHEN old.title_fold IS NOT new.title_fold
BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title_fold)
  VALUES ('delete', old.id, old.title_fold);
  INSERT INTO episodes_fts(rowid, title_fold) VALUES (new.id, new.title_fold);
END;
INSERT INTO episodes_fts(episodes_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE IF NOT EXISTS programmes_fts USING fts5(
  source_id UNINDEXED,
  guide_id UNINDEXED,
  start UNINDEXED,
  stop UNINDEXED,
  title_fold,
  description_fold,
  tokenize='unicode61'
);

CREATE INDEX IF NOT EXISTS idx_channel_guide_guide ON channel_guide (source_id, guide_id);
CREATE INDEX IF NOT EXISTS idx_live_guide_id ON live (source_id, guide_id);
`;

async function runBackfillProgrammesFts(tx: SqlDriver): Promise<boolean> {
  const hasProgrammes = await tx.all<{ one: number }>('SELECT 1 AS one FROM programmes LIMIT 1');
  if (hasProgrammes.length === 0) return false;
  const hasFts = await tx.all<{ one: number }>('SELECT 1 AS one FROM programmes_fts LIMIT 1');
  if (hasFts.length > 0) return false;

  let inserted = false;
  let lastSourceId = '';
  let lastGuideId = '';
  let lastStart = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows = await tx.all<{
      source_id: string;
      guide_id: string;
      start: number;
      stop: number;
      title: string;
      description: string | null;
    }>(
      `SELECT source_id, guide_id, start, stop, title, description
         FROM programmes
        WHERE source_id > ?
           OR (source_id = ? AND guide_id > ?)
           OR (source_id = ? AND guide_id = ? AND start > ?)
        ORDER BY source_id ASC, guide_id ASC, start ASC
        LIMIT ?`,
      [
        lastSourceId,
        lastSourceId,
        lastGuideId,
        lastSourceId,
        lastGuideId,
        lastStart,
        BACKFILL_BATCH_SIZE,
      ],
    );
    if (rows.length === 0) break;
    await tx.batch(
      'INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold) VALUES (?, ?, ?, ?, ?, ?)',
      rows.map((r) => [
        r.source_id,
        r.guide_id,
        r.start,
        r.stop,
        foldText(r.title),
        foldText(r.description ?? ''),
      ]),
    );
    inserted = true;
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < BACKFILL_BATCH_SIZE) break;
    lastSourceId = last.source_id;
    lastGuideId = last.guide_id;
    lastStart = last.start;
  }
  return inserted;
}

/**
 * Backfills standalone `programmes_fts` from `programmes` across all sources when `programmes` is
 * non-empty and `programmes_fts` is empty (e.g. after `MIGRATION_V12` upgrade or schema self-healing).
 * Returns `true` when rows were actually inserted, `false` otherwise.
 * Pass `inTransaction = true` when invoked inside an existing SQLite transaction.
 */
export async function backfillProgrammesFtsIfEmpty(
  db: SqlDriver,
  inTransaction = false,
): Promise<boolean> {
  if (inTransaction) {
    return runBackfillProgrammesFts(db);
  }
  const hasProgrammes = await db.all<{ one: number }>('SELECT 1 AS one FROM programmes LIMIT 1');
  if (hasProgrammes.length === 0) return false;
  const hasFts = await db.all<{ one: number }>('SELECT 1 AS one FROM programmes_fts LIMIT 1');
  if (hasFts.length > 0) return false;
  return db.transaction((tx) => runBackfillProgrammesFts(tx));
}

/**
 * Idempotently backfills `episodes.title_fold` (with Turkish-accurate JS {@link foldText}),
 * `movies`/`series` `cast_fold` & `director_fold`, and standalone `programmes_fts` inside an open
 * migration or schema-repair transaction (`#397`).
 */
export async function backfillWaveC4aMetadata(tx: SqlDriver): Promise<void> {
  let lastEpisodeId = 0;
  for (;;) {
    const rows = await tx.all<{
      id: number;
      title: string | null;
      title_fold: string;
    }>('SELECT id, title, title_fold FROM episodes WHERE id > ? ORDER BY id ASC LIMIT ?', [
      lastEpisodeId,
      BACKFILL_BATCH_SIZE,
    ]);
    if (rows.length === 0) break;
    const updates: SqlValue[][] = [];
    for (const row of rows) {
      const folded = foldText(row.title ?? '');
      if (row.title_fold !== folded) {
        updates.push([folded, row.id]);
      }
      lastEpisodeId = row.id;
    }
    if (updates.length > 0) {
      await tx.batch('UPDATE episodes SET title_fold = ? WHERE id = ?', updates);
    }
    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }

  for (const table of ['movies', 'series'] as const) {
    let lastId = 0;
    for (;;) {
      const rows = await tx.all<{
        id: number;
        cast_text: string | null;
        director_text: string | null;
        cast_fold: string | null;
        director_fold: string | null;
      }>(
        `SELECT id, cast_text, director_text, cast_fold, director_fold
           FROM ${table}
          WHERE id > ? AND ((cast_text IS NOT NULL AND cast_fold IS NULL) OR (director_text IS NOT NULL AND director_fold IS NULL))
          ORDER BY id ASC
          LIMIT ?`,
        [lastId, BACKFILL_BATCH_SIZE],
      );
      if (rows.length === 0) break;
      const updates: SqlValue[][] = [];
      for (const row of rows) {
        const castFold = row.cast_text !== null ? foldText(row.cast_text) : null;
        const directorFold = row.director_text !== null ? foldText(row.director_text) : null;
        updates.push([castFold, directorFold, row.id]);
        lastId = row.id;
      }
      if (updates.length > 0) {
        await tx.batch(
          `UPDATE ${table} SET cast_fold = ?, director_fold = ? WHERE id = ?`,
          updates,
        );
      }
      if (rows.length < BACKFILL_BATCH_SIZE) break;
    }
  }

  await backfillProgrammesFtsIfEmpty(tx, true);
}
