import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';

/** A playlist entry ready to store: `key` and `template` are credential-free. */
export interface M3uRow {
  key: string;
  name: string;
  logo: string | null;
  template: string;
}

/** Live-only columns. */
export interface M3uLiveRow extends M3uRow {
  num: number | null;
  guideId: string | null;
  catchupDays: number | null;
  headersJson: string | null;
}

const LIVE_SQL = `INSERT INTO live (source_id, key, num, name, name_fold, logo, guide_id, catchup_days, url_template, headers_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET num = excluded.num, name = excluded.name, name_fold = excluded.name_fold,
    logo = excluded.logo, guide_id = excluded.guide_id, catchup_days = excluded.catchup_days,
    url_template = excluded.url_template, headers_json = excluded.headers_json, run_id = excluded.run_id`;

const MOVIE_SQL = `INSERT INTO movies (source_id, key, name, name_fold, logo, url_template, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    logo = excluded.logo, url_template = excluded.url_template, run_id = excluded.run_id`;

const SERIES_SQL = `INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    run_id = excluded.run_id`;

const EPISODE_SQL = `INSERT INTO episodes (source_id, key, series_key, title, url_template, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET series_key = excluded.series_key, title = excluded.title,
    url_template = excluded.url_template, run_id = excluded.run_id`;

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
    rows.map((r) => [sourceId, r.key, r.name, foldText(r.name), orNull(r.logo), r.template, runId]),
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
    rows.map((r) => [sourceId, r.key, r.seriesKey, r.name, r.template, runId]),
  );
}
