import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';
import { placeholderNames } from './m3u-templating';
import { purgeSourceRows } from './sources';
import type { UrlVars } from './templates';

/** A playlist entry ready to store: `key`, `template` and `headersJson` are credential-free. */
export interface M3uRow {
  key: string;
  name: string;
  logo: string | null;
  template: string;
  headersJson: string | null;
}

/** Live-only columns. */
export interface M3uLiveRow extends M3uRow {
  num: number | null;
  guideId: string | null;
  catchupDays: number | null;
}

const LIVE_SQL = `INSERT INTO live (source_id, key, num, name, name_fold, logo, guide_id, catchup_days, url_template, headers_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET num = excluded.num, name = excluded.name, name_fold = excluded.name_fold,
    logo = excluded.logo, guide_id = excluded.guide_id, catchup_days = excluded.catchup_days,
    url_template = excluded.url_template, headers_json = excluded.headers_json, run_id = excluded.run_id`;

const MOVIE_SQL = `INSERT INTO movies (source_id, key, name, name_fold, logo, url_template, headers_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    logo = excluded.logo, url_template = excluded.url_template, headers_json = excluded.headers_json, run_id = excluded.run_id`;

const SERIES_SQL = `INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    run_id = excluded.run_id`;

const EPISODE_SQL = `INSERT INTO episodes (source_id, key, series_key, title, url_template, headers_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET series_key = excluded.series_key, title = excluded.title,
    url_template = excluded.url_template, headers_json = excluded.headers_json, run_id = excluded.run_id`;

const orNull = (v: SqlValue | undefined): SqlValue => v ?? null;

/** Upserts live channels by `(source_id, key)`, keeping row ids stable. */
export async function writeM3uLive(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  rows: readonly M3uLiveRow[],
): Promise<void> {
  await db.batch(
    LIVE_SQL,
    rows.map((r) => [
      sourceId,
      r.key,
      orNull(r.num),
      r.name,
      foldText(r.name),
      orNull(r.logo),
      orNull(r.guideId),
      orNull(r.catchupDays),
      r.template,
      orNull(r.headersJson),
      runId,
    ]),
  );
}

/** Upserts movies. */
export async function writeM3uMovies(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  rows: readonly M3uRow[],
): Promise<void> {
  await db.batch(
    MOVIE_SQL,
    rows.map((r) => [
      sourceId,
      r.key,
      r.name,
      foldText(r.name),
      orNull(r.logo),
      r.template,
      orNull(r.headersJson),
      runId,
    ]),
  );
}

/** Upserts the synthetic series that group episodes. */
export async function writeM3uSeries(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  rows: readonly { key: string; name: string }[],
): Promise<void> {
  await db.batch(
    SERIES_SQL,
    rows.map((r) => [sourceId, r.key, r.name, foldText(r.name), runId]),
  );
}

/** Upserts episodes of synthetic series. */
export async function writeM3uEpisodes(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  rows: readonly (M3uRow & { seriesKey: string })[],
): Promise<void> {
  await db.batch(
    EPISODE_SQL,
    rows.map((r) => [
      sourceId,
      r.key,
      r.seriesKey,
      r.name,
      r.template,
      orNull(r.headersJson),
      runId,
    ]),
  );
}

function unresolved(text: string | null, vars: UrlVars): boolean {
  if (text === null) return false;
  return placeholderNames(text).some((name) => name !== '(' && !Object.hasOwn(vars, name));
}

/**
 * Removes rows written by a failed M3U run whose placeholders are absent from `oldVars`, so SQLite never holds
 * unplayable templates when `urlvars-too-large` or `secret-write-failed` aborts commit.
 */
export async function rollbackUnresolvedM3uRows(
  db: SqlDriver,
  sourceId: string,
  runId: number,
  oldVars: UrlVars,
): Promise<void> {
  await db.transaction(async (tx) => {
    const priorOk = await tx.all(
      "SELECT 1 FROM import_runs WHERE source_id = ? AND kind = 'catalog' AND status = 'ok' LIMIT 1",
      [sourceId],
    );
    if (priorOk.length === 0) {
      await purgeSourceRows(tx, sourceId, ['import_runs']);
      return;
    }
    for (const table of ['live', 'movies', 'episodes'] as const) {
      const cols =
        table === 'episodes'
          ? 'id, url_template, headers_json'
          : 'id, url_template, logo, headers_json';
      const rows = await tx.all<{
        id: number;
        url_template: string | null;
        logo?: string | null;
        headers_json: string | null;
      }>(`SELECT ${cols} FROM ${table} WHERE source_id = ? AND run_id = ?`, [sourceId, runId]);
      const bad = rows
        .filter(
          (r) =>
            unresolved(r.url_template, oldVars) ||
            unresolved(r.logo ?? null, oldVars) ||
            unresolved(r.headers_json, oldVars),
        )
        .map((r) => [r.id]);
      await tx.batch(`DELETE FROM ${table} WHERE id = ?`, bad);
    }
    await tx.run(
      `DELETE FROM series WHERE source_id = ? AND run_id = ?
         AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.source_id = series.source_id AND e.series_key = series.key)`,
      [sourceId, runId],
    );
    for (const [kind, table] of [
      ['live', 'live'],
      ['movie', 'movies'],
      ['series', 'series'],
    ] as const) {
      await tx.run(
        `DELETE FROM placements WHERE source_id = ? AND kind = ? AND run_id = ?
           AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.source_id = placements.source_id AND t.key = placements.item_key)`,
        [sourceId, kind, runId],
      );
      await tx.run(
        `DELETE FROM categories WHERE source_id = ? AND kind = ? AND run_id = ?
           AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.source_id = categories.source_id AND p.kind = categories.kind AND p.category_id = categories.provider_id)`,
        [sourceId, kind, runId],
      );
    }
  });
}
