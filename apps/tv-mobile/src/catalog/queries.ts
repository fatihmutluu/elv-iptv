import type { SqlDriver } from '@elv/domain';

/** Kinds a menu browses; stored as `kind` in `categories` and `placements`. */
export type BrowseKind = 'live' | 'movie' | 'series';

/** Largest page `items` returns. */
const MAX_PAGE = 500;

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

/** A live channel, movie or series in a category. */
export interface ItemRow {
  /** Row id in its table; the argument of `seasons` and `episodes` for a series. */
  id: number;
  /** Stable content key; the argument of `resolveStream`. */
  key: string;
  kind: BrowseKind;
  sourceId: string;
  providerId: string | null;
  name: string;
  /** Logo or cover as stored (an M3U template is resolved by the service). */
  logo: string | null;
  rating: number | null;
  year: number | null;
  /** Channel number (live only). */
  num: number | null;
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

/** Clamps a page request; `limit` is 0 to {@link MAX_PAGE}, `offset` at least 0. */
function clampPage(offset: number, limit: number): { offset: number; limit: number } {
  const whole = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0);
  return {
    offset: Math.max(0, whole(offset)),
    limit: Math.min(MAX_PAGE, Math.max(0, whole(limit))),
  };
}

/** Categories of one kind with the number of items placed in each, in provider order. */
export async function queryCategories(
  db: SqlDriver,
  sourceId: string,
  kind: BrowseKind,
): Promise<CategoryRow[]> {
  const rows = await db.all<{ provider_id: string; name: string; position: number; n: number }>(
    `SELECT c.provider_id, c.name, c.position,
            (SELECT COUNT(*) FROM placements p
              WHERE p.source_id = c.source_id AND p.kind = c.kind AND p.category_id = c.provider_id) AS n
       FROM categories c WHERE c.source_id = ? AND c.kind = ? ORDER BY c.position, c.provider_id`,
    [sourceId, kind],
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

/** Table and columns per kind; fixed strings, never built from data. */
const ITEM_SQL: Record<BrowseKind, string> = {
  live: `t.logo AS logo, NULL AS rating, NULL AS year, t.num AS num FROM placements p
         JOIN live t ON t.source_id = p.source_id AND t.key = p.item_key`,
  movie: `t.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num FROM placements p
          JOIN movies t ON t.source_id = p.source_id AND t.key = p.item_key`,
  series: `t.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num FROM placements p
           JOIN series t ON t.source_id = p.source_id AND t.key = p.item_key`,
};

/** One page of a category's items in provider order. */
export async function queryItems(
  db: SqlDriver,
  ref: { sourceId: string; kind: BrowseKind; providerId: string },
  offset: number,
  limit: number,
): Promise<ItemRow[]> {
  const page = clampPage(offset, limit);
  if (page.limit === 0) return [];
  const rows = await db.all<{
    id: number;
    key: string;
    provider_id: string | null;
    name: string;
    logo: string | null;
    rating: number | null;
    year: number | null;
    num: number | null;
  }>(
    `SELECT t.id, t.key, t.provider_id, t.name, ${ITEM_SQL[ref.kind]}
      WHERE p.source_id = ? AND p.kind = ? AND p.category_id = ?
      ORDER BY p.position, t.id LIMIT ? OFFSET ?`,
    [ref.sourceId, ref.kind, ref.providerId, page.limit, page.offset],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    kind: ref.kind,
    sourceId: ref.sourceId,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: r.rating,
    year: r.year,
    num: r.num,
  }));
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
function sourceOfKey(key: string): string | undefined {
  const parts = key.split(':');
  return (parts[0] === 'x' || parts[0] === 'm') && parts[1] ? parts[1] : undefined;
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
     SELECT source_id, 'movie', provider_id, extension, url_template, NULL
       FROM movies WHERE source_id = ? AND key = ?
     UNION ALL
     SELECT source_id, 'series', provider_id, extension, url_template, NULL
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
