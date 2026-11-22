import type { SqlDriver } from '@elv/domain';
import { allocateFairQuotas, queryAllSourcesItems } from './queries-all-sources';
import {
  type BrowseKind,
  clampPage,
  ITEM_COLS,
  ITEM_TABLE,
  type ItemRow,
  mapItemRow,
  type RawItemRow,
} from './queries-shared';

export { allocateFairQuotas, type BrowseKind, type ItemRow, queryAllSourcesItems };

/** A category of one source. `id` is opaque; hand it back to `items`. */
export interface CategoryRow {
  id: string;
  sourceId: string;
  kind: BrowseKind;
  name: string;
  /** Provider order, ascending. */
  position: number;
  itemCount: number;
}

/** Detail lookup row for a live channel, movie or series, including series synopsis when present. */
export interface ItemDetailRow extends ItemRow {
  /** Series synopsis (`series.plot`); `null` for live channels and movies. */
  plot: string | null;
}

/** One season of a series with the episodes stored for it. */
export interface SeasonRow {
  season: number;
  episodeCount: number;
}

/** One stored episode. */
export interface EpisodeRow {
  id: number;
  key: string;
  season: number;
  episode: number | null;
  title: string | null;
  durationSec: number | null;
}

const SEP = '|';

/** Encodes a category reference; source ids and kinds never contain the separator. */
function categoryId(sourceId: string, kind: BrowseKind, providerId: string): string {
  return [sourceId, kind, providerId].join(SEP);
}

/** Decodes {@link categoryId}; `undefined` for anything else. */
export function parseCategoryId(
  id: string,
): { sourceId: string; kind: BrowseKind; providerId: string } | undefined {
  const first = id.indexOf(SEP);
  const second = id.indexOf(SEP, first + 1);
  if (first < 0 || second < 0) return undefined;
  const kind = id.slice(first + 1, second);
  if (kind !== 'live' && kind !== 'movie' && kind !== 'series') return undefined;
  return { sourceId: id.slice(0, first), kind, providerId: id.slice(second + 1) };
}

/** Visible categories of one kind with the number of visible items placed in each, in provider order. */
export async function queryCategories(
  db: SqlDriver,
  sourceId: string,
  kind: BrowseKind,
): Promise<CategoryRow[]> {
  const rows = await db.all<{ provider_id: string; name: string; position: number; n: number }>(
    `SELECT c.provider_id, c.name, c.position, COALESCE(p.n, 0) AS n
       FROM categories c
       LEFT JOIN (
         SELECT pl.category_id, COUNT(*) AS n
           FROM placements pl
           JOIN ${ITEM_TABLE[kind]} t
             ON t.source_id = pl.source_id AND t.key = pl.item_key
          WHERE pl.source_id = ? AND pl.kind = ?
            AND pl.is_hidden = 0 AND t.is_hidden = 0
          GROUP BY pl.category_id
       ) p ON p.category_id = c.provider_id
      WHERE c.source_id = ? AND c.kind = ? AND c.is_hidden = 0
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = c.source_id AND s.deleting = 0)
      ORDER BY c.position, c.provider_id`,
    [sourceId, kind, sourceId, kind],
  );
  return rows.map((r) => ({
    id: categoryId(sourceId, kind, r.provider_id),
    sourceId,
    kind,
    name: r.name,
    position: r.position,
    itemCount: r.n,
  }));
}

/** One page of a category's visible items in provider order; filters hidden rows before `LIMIT`/`OFFSET`. */
export async function queryItems(
  db: SqlDriver,
  ref: { sourceId: string; kind: BrowseKind; providerId: string },
  offset: number,
  limit: number,
): Promise<ItemRow[]> {
  const page = clampPage(offset, limit);
  if (page.limit === 0) return [];
  const rows = await db.all<RawItemRow>(
    `SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_COLS[ref.kind]}
       FROM (
         SELECT source_id, item_key, position FROM placements
          WHERE source_id = ? AND kind = ? AND category_id = ? AND is_hidden = 0
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = placements.source_id AND s.deleting = 0)
            AND EXISTS (
              SELECT 1 FROM ${ITEM_TABLE[ref.kind]} jt
               WHERE jt.source_id = placements.source_id
                 AND jt.key = placements.item_key
                 AND jt.is_hidden = 0
            )
          ORDER BY position, item_key LIMIT ? OFFSET ?
       ) p
       JOIN ${ITEM_TABLE[ref.kind]} t ON t.source_id = p.source_id AND t.key = p.item_key
      ORDER BY p.position, t.id`,
    [ref.sourceId, ref.kind, ref.providerId, page.limit, page.offset],
  );
  return rows.map((r) => mapItemRow(ref.kind, ref.sourceId, r));
}

/** A series row: what loading and listing episodes needs. */
export async function querySeries(
  db: SqlDriver,
  seriesId: number,
): Promise<{ sourceId: string; key: string } | undefined> {
  const rows = await db.all<{ source_id: string; key: string }>(
    'SELECT source_id, key FROM series WHERE id = ?',
    [seriesId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { sourceId: row.source_id, key: row.key };
}

/** Seasons of a series that have stored episodes, ascending; a missing season number counts as 0. */
export async function querySeasons(
  db: SqlDriver,
  series: { sourceId: string; key: string },
): Promise<SeasonRow[]> {
  const rows = await db.all<{ season: number; n: number }>(
    `SELECT COALESCE(season, 0) AS season, COUNT(*) AS n FROM episodes
      WHERE source_id = ? AND series_key = ? GROUP BY COALESCE(season, 0) ORDER BY season`,
    [series.sourceId, series.key],
  );
  return rows.map((r) => ({ season: r.season, episodeCount: r.n }));
}

/** Episodes of one season in episode order. */
export async function queryEpisodes(
  db: SqlDriver,
  series: { sourceId: string; key: string },
  season: number,
): Promise<EpisodeRow[]> {
  const rows = await db.all<{
    id: number;
    key: string;
    season: number;
    episode: number | null;
    title: string | null;
    duration_sec: number | null;
  }>(
    `SELECT id, key, COALESCE(season, 0) AS season, episode, title, duration_sec FROM episodes
      WHERE source_id = ? AND series_key = ? AND COALESCE(season, 0) = ?
      ORDER BY episode, id`,
    [series.sourceId, series.key, season],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    season: r.season,
    episode: r.episode,
    title: r.title,
    durationSec: r.duration_sec,
  }));
}

/** Where a playable key lives. */
export interface PlayableRow {
  sourceId: string;
  /** Kind of the Xtream stream path. */
  streamKind: 'live' | 'movie' | 'series';
  providerId: string | null;
  extension: string | null;
  urlTemplate: string | null;
  headersJson: string | null;
}

/** The source id inside a content key (`x:<source>:...` or `m:<source>:...`), so lookups use the unique index. */
export function sourceOfKey(key: string): string | undefined {
  const parts = key.split(':');
  return (parts[0] === 'x' || parts[0] === 'm') && parts[1] ? parts[1] : undefined;
}

/** Finds a live channel, movie or series detail row by content key via the `UNIQUE (source_id, key)` index. */
export async function queryItemDetail(
  db: SqlDriver,
  itemKey: string,
): Promise<ItemDetailRow | undefined> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return undefined;
  const rows = await db.all<{
    id: number;
    key: string;
    kind: BrowseKind;
    source_id: string;
    provider_id: string | null;
    name: string;
    logo: string | null;
    rating: number | null;
    year: number | null;
    num: number | null;
    plot: string | null;
  }>(
    `SELECT id, key, 'live' AS kind, source_id, provider_id, name, logo, NULL AS rating, NULL AS year, num, NULL AS plot
       FROM live WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT id, key, 'movie', source_id, provider_id, name, logo, rating, year, NULL, NULL
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT id, key, 'series', source_id, provider_id, name, cover, rating, year, NULL, plot
       FROM series WHERE source_id = ? AND key = ?
     LIMIT 1`,
    [sourceId, itemKey, sourceId, itemKey, sourceId, itemKey],
  );
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    sourceId: r.source_id,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: r.rating,
    year: r.year,
    num: r.num,
    plot: r.plot,
  };
}

/** Finds a live channel, movie or episode by content key. */
export async function queryPlayable(db: SqlDriver, key: string): Promise<PlayableRow | undefined> {
  const sourceId = sourceOfKey(key);
  if (sourceId === undefined) return undefined;
  const rows = await db.all<{
    source_id: string;
    stream_kind: PlayableRow['streamKind'];
    provider_id: string | null;
    extension: string | null;
    url_template: string | null;
    headers_json: string | null;
  }>(
    `SELECT source_id, 'live' AS stream_kind, provider_id, NULL AS extension, url_template, headers_json
       FROM live WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'movie', provider_id, extension, url_template, headers_json
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'series', provider_id, extension, url_template, headers_json
       FROM episodes WHERE source_id = ? AND key = ?
     LIMIT 1`,
    [sourceId, key, sourceId, key, sourceId, key],
  );
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    sourceId: r.source_id,
    streamKind: r.stream_kind,
    providerId: r.provider_id,
    extension: r.extension,
    urlTemplate: r.url_template,
    headersJson: r.headers_json,
  };
}

/**
 * Looks up the raw stored `logo` / `cover` template for an item in the catalog tables
 * (`live`, `movies`, `series`, or parent `series.cover` for `episode`), so user-state writes
 * never persist secret-resolved M3U logo URLs into SQLite.
 */
async function queryItemLogoTemplate(
  db: SqlDriver,
  ref: {
    sourceId: string;
    kind: BrowseKind | 'episode';
    itemKey: string;
    seriesKey?: string | null;
  },
): Promise<{ found: true; logo: string | null } | { found: false }> {
  if (ref.kind === 'episode') {
    const ep = await db.all<{ logo: string | null }>(
      `SELECT s.cover AS logo
         FROM episodes e
         LEFT JOIN series s ON s.source_id = e.source_id AND s.key = e.series_key
        WHERE e.source_id = ? AND e.key = ? LIMIT 1`,
      [ref.sourceId, ref.itemKey],
    );
    if (ep[0] !== undefined) return { found: true, logo: ep[0].logo };
    if (ref.seriesKey) {
      const ser = await db.all<{ logo: string | null }>(
        'SELECT cover AS logo FROM series WHERE source_id = ? AND key = ? LIMIT 1',
        [ref.sourceId, ref.seriesKey],
      );
      if (ser[0] !== undefined) return { found: true, logo: ser[0].logo };
    }
    return { found: false };
  }
  const col = ref.kind === 'series' ? 'cover' : 'logo';
  const rows = await db.all<{ logo: string | null }>(
    `SELECT ${col} AS logo FROM ${ITEM_TABLE[ref.kind]} WHERE source_id = ? AND key = ? LIMIT 1`,
    [ref.sourceId, ref.itemKey],
  );
  return rows[0] === undefined ? { found: false } : { found: true, logo: rows[0].logo };
}

/**
 * Resolves the safe `logo` value to persist into `watch_progress` or `favorites`: prefers the raw
 * catalog template when present and refuses caller-supplied logos for M3U sources so resolved
 * credentials never enter SQLite.
 */
export async function resolveSafeStorageLogo(
  db: SqlDriver,
  input: {
    sourceId: string;
    itemKey: string;
    kind: BrowseKind | 'episode';
    seriesKey?: string | null;
    logo?: string | null;
  },
): Promise<string | null> {
  const fromCatalog = await queryItemLogoTemplate(db, input);
  if (fromCatalog.found) return fromCatalog.logo;
  const src = await db.all<{ kind: string }>('SELECT kind FROM sources WHERE id = ? LIMIT 1', [
    input.sourceId,
  ]);
  return src[0]?.kind === 'm3u' ? null : (input.logo ?? null);
}
