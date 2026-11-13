import type { SqlDriver, SqlValue } from '@elv/domain';
import type {
  XtreamCategory,
  XtreamEpisode,
  XtreamLive,
  XtreamMovie,
  XtreamSeries,
} from '@elv/sources';
import { foldText } from './fold';

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
  sql: `INSERT INTO live (source_id, key, provider_id, num, name, name_fold, logo, guide_id, catchup_days, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, num = excluded.num,
          name = excluded.name, name_fold = excluded.name_fold, logo = excluded.logo,
          guide_id = excluded.guide_id, catchup_days = excluded.catchup_days, run_id = excluded.run_id`,
  row: (sourceId, key, runId, i) => [
    sourceId,
    key,
    String(i.id),
    n(i.num),
    i.name,
    foldText(i.name),
    s(i.icon),
    s(i.epgId),
    i.catchupDays,
    runId,
  ],
};

export const movieWriter: ItemWriter<XtreamMovie> = {
  sql: `INSERT INTO movies (source_id, key, provider_id, name, name_fold, logo, rating, year, extension, added, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
          name_fold = excluded.name_fold, logo = excluded.logo, rating = excluded.rating, year = excluded.year,
          extension = excluded.extension, added = excluded.added, run_id = excluded.run_id`,
  row: (sourceId, key, runId, i) => [
    sourceId,
    key,
    String(i.id),
    i.name,
    foldText(i.name),
    s(i.icon),
    n(i.rating),
    n(i.year),
    i.extension,
    n(i.added),
    runId,
  ],
};

export const seriesWriter: ItemWriter<XtreamSeries> = {
  sql: `INSERT INTO series (source_id, key, provider_id, name, name_fold, cover, plot, rating, year, last_modified, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
          name_fold = excluded.name_fold, cover = excluded.cover, plot = excluded.plot, rating = excluded.rating,
          year = excluded.year, last_modified = excluded.last_modified, run_id = excluded.run_id`,
  row: (sourceId, key, runId, i) => [
    sourceId,
    key,
    String(i.id),
    i.name,
    foldText(i.name),
    s(i.cover),
    s(i.plot),
    n(i.rating),
    n(i.year),
    n(i.lastModified),
    runId,
  ],
};

const CATEGORY_SQL = `INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, kind, provider_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold,
    position = excluded.position, run_id = excluded.run_id`;

const PLACEMENT_SQL = `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, kind, category_id, item_key) DO UPDATE SET position = excluded.position,
    run_id = excluded.run_id`;

const EPISODE_SQL = `INSERT INTO episodes (source_id, key, series_key, season, episode, title, extension, duration_sec, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET series_key = excluded.series_key, season = excluded.season,
    episode = excluded.episode, title = excluded.title, extension = excluded.extension,
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
    rows.map((c, i) => [sourceId, kind, c.id, c.name, foldText(c.name), offset + i, runId]),
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

/** Upserts the episodes of one series. */
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
