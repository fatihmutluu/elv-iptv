import type { SqlDriver, SqlValue } from '@elv/domain';
import type {
  XtreamCategory,
  XtreamEpisode,
  XtreamLive,
  XtreamMovie,
  XtreamSeries,
} from '@elv/sources';
import { hashCategoryRow, hashLiveRow, hashMovieRow, hashSeriesRow } from './content-hash';
import { foldText, sortTitleKey } from './fold';

/** An item with the fields every Xtream list shares. */
export interface Listed {
  id: number;
  categoryIds: string[];
}

/** SQL and row mapping that upsert one kind of item by `(source_id, key)`, keeping the row id stable. */
export interface ItemWriter<T extends Listed> {
  sql: string;
  row(sourceId: string, key: string, runId: number, item: T): SqlValue[];
}

const n = (v: number | undefined): SqlValue => v ?? null;
const s = (v: string | undefined): SqlValue => v ?? null;

export const liveWriter: ItemWriter<XtreamLive> = {
  sql: `INSERT INTO live_next (source_id, key, provider_id, num, name, name_fold, sort_title, logo, guide_id, catchup_days, run_id, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, num = excluded.num,
          name = excluded.name, name_fold = excluded.name_fold, sort_title = excluded.sort_title, logo = excluded.logo,
          guide_id = excluded.guide_id, catchup_days = excluded.catchup_days, run_id = excluded.run_id,
          content_hash = excluded.content_hash`,
  row: (sourceId, key, runId, i) => {
    const providerId = String(i.id);
    const nameFold = foldText(i.name);
    const sortTitle = sortTitleKey(i.name);
    const contentHash = hashLiveRow({
      providerId,
      num: i.num,
      name: i.name,
      nameFold,
      logo: i.icon,
      guideId: i.epgId,
      catchupDays: i.catchupDays,
    });
    return [
      sourceId,
      key,
      providerId,
      n(i.num),
      i.name,
      nameFold,
      sortTitle,
      s(i.icon),
      s(i.epgId),
      i.catchupDays,
      runId,
      contentHash,
    ];
  },
};

export const movieWriter: ItemWriter<XtreamMovie> = {
  sql: `INSERT INTO movies_next (source_id, key, provider_id, name, name_fold, sort_title, logo, rating, year, extension, added, run_id, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
          name_fold = excluded.name_fold, sort_title = excluded.sort_title, logo = excluded.logo, rating = excluded.rating, year = excluded.year,
          extension = excluded.extension, added = excluded.added, run_id = excluded.run_id,
          content_hash = excluded.content_hash`,
  row: (sourceId, key, runId, i) => {
    const providerId = String(i.id);
    const nameFold = foldText(i.name);
    const sortTitle = sortTitleKey(i.name);
    const contentHash = hashMovieRow({
      providerId,
      name: i.name,
      nameFold,
      logo: i.icon,
      rating: i.rating,
      year: i.year,
      extension: i.extension,
      added: i.added,
    });
    return [
      sourceId,
      key,
      providerId,
      i.name,
      nameFold,
      sortTitle,
      s(i.icon),
      n(i.rating),
      n(i.year),
      i.extension,
      n(i.added),
      runId,
      contentHash,
    ];
  },
};

export const seriesWriter: ItemWriter<XtreamSeries> = {
  sql: `INSERT INTO series_next (source_id, key, provider_id, name, name_fold, sort_title, cover, plot, rating, year, last_modified, run_id, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
          name_fold = excluded.name_fold, sort_title = excluded.sort_title, cover = excluded.cover, plot = excluded.plot, rating = excluded.rating,
          year = excluded.year, last_modified = excluded.last_modified, run_id = excluded.run_id,
          content_hash = excluded.content_hash`,
  row: (sourceId, key, runId, i) => {
    const providerId = String(i.id);
    const nameFold = foldText(i.name);
    const sortTitle = sortTitleKey(i.name);
    const contentHash = hashSeriesRow({
      providerId,
      name: i.name,
      nameFold,
      cover: i.cover,
      plot: i.plot,
      rating: i.rating,
      year: i.year,
      lastModified: i.lastModified,
    });
    return [
      sourceId,
      key,
      providerId,
      i.name,
      nameFold,
      sortTitle,
      s(i.cover),
      s(i.plot),
      n(i.rating),
      n(i.year),
      n(i.lastModified),
      runId,
      contentHash,
    ];
  },
};

const CATEGORY_SQL = `INSERT INTO categories_next (source_id, kind, provider_id, name, name_fold, position, run_id, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, kind, provider_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    position = excluded.position, run_id = excluded.run_id, content_hash = excluded.content_hash`;

const PLACEMENT_SQL = `INSERT INTO placements_next (source_id, kind, item_key, category_id, position, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, kind, category_id, item_key) DO UPDATE SET position = excluded.position,
    run_id = excluded.run_id`;

const EPISODE_SQL = `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, extension,
    duration_sec, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, series_key = excluded.series_key,
    season = excluded.season, episode = excluded.episode, title = excluded.title, extension = excluded.extension,
    duration_sec = excluded.duration_sec, run_id = excluded.run_id`;

/** Upserts categories of one kind; `offset` is the position of the first one. */
export async function writeCategories(
  db: SqlDriver,
  sourceId: string,
  kind: 'live' | 'movie' | 'series',
  runId: number,
  rows: readonly XtreamCategory[],
  offset: number,
): Promise<void> {
  await db.batch(
    CATEGORY_SQL,
    rows.map((c, i) => {
      const nameFold = foldText(c.name);
      const position = offset + i;
      const contentHash = hashCategoryRow({ name: c.name, nameFold, position });
      return [sourceId, kind, c.id, c.name, nameFold, position, runId, contentHash];
    }),
  );
}

/** Upserts a batch of items. */
export async function writeItems<T extends Listed>(
  db: SqlDriver,
  writer: ItemWriter<T>,
  sourceId: string,
  runId: number,
  items: readonly { key: string; item: T }[],
): Promise<void> {
  await db.batch(
    writer.sql,
    items.map(({ key, item }) => writer.row(sourceId, key, runId, item)),
  );
}

/** Upserts placements given as `[itemKey, categoryId, position]` triples of one kind. */
export async function writePlacements(
  db: SqlDriver,
  sourceId: string,
  kind: 'live' | 'movie' | 'series',
  runId: number,
  rows: readonly (readonly [string, string, number])[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    PLACEMENT_SQL,
    rows.map(([key, category, position]) => [sourceId, kind, key, category, position, runId]),
  );
}

/** Upserts the episodes of one series; `provider_id` and `extension` are what playback needs. */
export async function writeEpisodes(
  db: SqlDriver,
  sourceId: string,
  seriesKey: string,
  runId: number,
  rows: readonly { key: string; episode: XtreamEpisode }[],
): Promise<void> {
  await db.batch(
    EPISODE_SQL,
    rows.map(({ key, episode: e }) => [
      sourceId,
      key,
      String(e.id),
      seriesKey,
      e.season,
      e.episode,
      e.title,
      e.extension,
      n(e.durationSec),
      runId,
    ]),
  );
}
