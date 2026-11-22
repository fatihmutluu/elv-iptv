import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';

/** A playlist entry ready to stage: `key`, `legacyKey`, `template`, `headersJson` and `backupUrlsJson` are credential-free. */
export interface M3uRow {
  key: string;
  legacyKey?: string | null;
  name: string;
  logo: string | null;
  template: string;
  headersJson: string | null;
  backupUrlsJson?: string | null;
}

/** Live-only columns. */
export interface M3uLiveRow extends M3uRow {
  num: number | null;
  guideId: string | null;
  catchupDays: number | null;
  epgShiftMs?: number | null;
}

const LIVE_SQL = `INSERT INTO live_next (source_id, key, legacy_key, num, name, name_fold, logo, guide_id, catchup_days, url_template, headers_json, backup_urls_json, epg_shift_ms, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET legacy_key = excluded.legacy_key, num = excluded.num, name = excluded.name,
    name_fold = excluded.name_fold, logo = excluded.logo, guide_id = excluded.guide_id,
    catchup_days = excluded.catchup_days, url_template = excluded.url_template, headers_json = excluded.headers_json,
    backup_urls_json = excluded.backup_urls_json, epg_shift_ms = excluded.epg_shift_ms, run_id = excluded.run_id`;

const MOVIE_SQL = `INSERT INTO movies_next (source_id, key, legacy_key, name, name_fold, logo, url_template, headers_json, backup_urls_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET legacy_key = excluded.legacy_key, name = excluded.name,
    name_fold = excluded.name_fold, logo = excluded.logo, url_template = excluded.url_template,
    headers_json = excluded.headers_json, backup_urls_json = excluded.backup_urls_json, run_id = excluded.run_id`;

const SERIES_SQL = `INSERT INTO series_next (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    run_id = excluded.run_id`;

const EPISODE_SQL = `INSERT INTO episodes_next (source_id, key, legacy_key, series_key, title, url_template, headers_json, backup_urls_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET legacy_key = excluded.legacy_key, series_key = excluded.series_key,
    title = excluded.title, url_template = excluded.url_template, headers_json = excluded.headers_json,
    backup_urls_json = excluded.backup_urls_json, run_id = excluded.run_id`;

const orNull = (v: SqlValue | undefined): SqlValue => v ?? null;

/** Stages live channels into `live_next` by `(source_id, key)`. */
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
      orNull(r.legacyKey),
      orNull(r.num),
      r.name,
      foldText(r.name),
      orNull(r.logo),
      orNull(r.guideId),
      orNull(r.catchupDays),
      r.template,
      orNull(r.headersJson),
      orNull(r.backupUrlsJson),
      orNull(r.epgShiftMs),
      runId,
    ]),
  );
}

/** Stages movies into `movies_next`. */
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
      orNull(r.legacyKey),
      r.name,
      foldText(r.name),
      orNull(r.logo),
      r.template,
      orNull(r.headersJson),
      orNull(r.backupUrlsJson),
      runId,
    ]),
  );
}

/** Stages synthetic series that group M3U episodes into `series_next`. */
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

/** Stages episodes of synthetic M3U series into `episodes_next`. */
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
      orNull(r.legacyKey),
      r.seriesKey,
      r.name,
      r.template,
      orNull(r.headersJson),
      orNull(r.backupUrlsJson),
      runId,
    ]),
  );
}
