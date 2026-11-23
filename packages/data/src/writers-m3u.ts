import type { SqlDriver, SqlValue } from '@elv/domain';
import { hashLiveRow, hashMovieRow, hashSeriesRow } from './content-hash';
import { foldText, sortTitleKey } from './fold';
import { parseLiveVariant } from './live-variants';
import { parseVodVersion } from './vod-versions';

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

const LIVE_SQL = `INSERT INTO live_next (source_id, key, legacy_key, num, name, name_fold, sort_title, variant_base_fold, quality_rank, logo, guide_id, catchup_days, url_template, headers_json, backup_urls_json, epg_shift_ms, run_id, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET legacy_key = excluded.legacy_key, num = excluded.num, name = excluded.name,
    name_fold = excluded.name_fold, sort_title = excluded.sort_title, variant_base_fold = excluded.variant_base_fold,
    quality_rank = excluded.quality_rank, logo = excluded.logo, guide_id = excluded.guide_id,
    catchup_days = excluded.catchup_days, url_template = excluded.url_template, headers_json = excluded.headers_json,
    backup_urls_json = excluded.backup_urls_json, epg_shift_ms = excluded.epg_shift_ms, run_id = excluded.run_id,
    content_hash = excluded.content_hash`;

const MOVIE_SQL = `INSERT INTO movies_next (source_id, key, legacy_key, name, name_fold, sort_title, version_group_key, version_label, logo, url_template, headers_json, backup_urls_json, run_id, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET legacy_key = excluded.legacy_key, name = excluded.name,
    name_fold = excluded.name_fold, sort_title = excluded.sort_title, version_group_key = excluded.version_group_key,
    version_label = excluded.version_label, logo = excluded.logo, url_template = excluded.url_template,
    headers_json = excluded.headers_json, backup_urls_json = excluded.backup_urls_json, run_id = excluded.run_id,
    content_hash = excluded.content_hash`;

const SERIES_SQL = `INSERT INTO series_next (source_id, key, name, name_fold, sort_title, run_id, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    sort_title = excluded.sort_title, run_id = excluded.run_id, content_hash = excluded.content_hash`;

const EPISODE_SQL = `INSERT INTO episodes_next (source_id, key, legacy_key, series_key, title, title_fold, url_template, headers_json, backup_urls_json, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET legacy_key = excluded.legacy_key, series_key = excluded.series_key,
    title = excluded.title, title_fold = excluded.title_fold, url_template = excluded.url_template, headers_json = excluded.headers_json,
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
    rows.map((r) => {
      const nameFold = foldText(r.name);
      const sortTitle = sortTitleKey(r.name);
      const variant = parseLiveVariant(r.name);
      const contentHash = hashLiveRow({
        num: r.num,
        name: r.name,
        nameFold,
        logo: r.logo,
        guideId: r.guideId,
        catchupDays: r.catchupDays,
        urlTemplate: r.template,
        headersJson: r.headersJson,
        backupUrlsJson: r.backupUrlsJson,
        epgShiftMs: r.epgShiftMs,
      });
      return [
        sourceId,
        r.key,
        orNull(r.legacyKey),
        orNull(r.num),
        r.name,
        nameFold,
        sortTitle,
        variant.baseFold,
        variant.qualityRank,
        orNull(r.logo),
        orNull(r.guideId),
        orNull(r.catchupDays),
        r.template,
        orNull(r.headersJson),
        orNull(r.backupUrlsJson),
        orNull(r.epgShiftMs),
        runId,
        contentHash,
      ];
    }),
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
    rows.map((r) => {
      const nameFold = foldText(r.name);
      const sortTitle = sortTitleKey(r.name);
      const version = parseVodVersion(r.name, null);
      const versionLabel = version.versionLabel.length > 0 ? version.versionLabel : null;
      const contentHash = hashMovieRow({
        name: r.name,
        nameFold,
        logo: r.logo,
        urlTemplate: r.template,
        headersJson: r.headersJson,
        backupUrlsJson: r.backupUrlsJson,
      });
      return [
        sourceId,
        r.key,
        orNull(r.legacyKey),
        r.name,
        nameFold,
        sortTitle,
        version.groupKey,
        versionLabel,
        orNull(r.logo),
        r.template,
        orNull(r.headersJson),
        orNull(r.backupUrlsJson),
        runId,
        contentHash,
      ];
    }),
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
    rows.map((r) => {
      const nameFold = foldText(r.name);
      const sortTitle = sortTitleKey(r.name);
      const contentHash = hashSeriesRow({ name: r.name, nameFold });
      return [sourceId, r.key, r.name, nameFold, sortTitle, runId, contentHash];
    }),
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
      foldText(r.name),
      r.template,
      orNull(r.headersJson),
      orNull(r.backupUrlsJson),
      runId,
    ]),
  );
}
