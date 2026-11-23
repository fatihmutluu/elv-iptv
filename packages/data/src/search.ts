import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';
import type { BrowseKind, ItemRow } from './queries';
import { backfillProgrammesFtsIfEmpty } from './schema-v12';

export {
  DEFAULT_SEARCH_SUGGESTIONS_LIMIT,
  MAX_SEARCH_SUGGESTIONS_LIMIT,
  querySearchSuggestions,
  type SearchSuggestion,
  type SearchSuggestionKind,
  type SearchSuggestionsOptions,
} from './search-suggestions';

/** Default per-kind search result cap. */
export const DEFAULT_SEARCH_LIMIT = 40;

/** Hard upper bound on per-kind search results returned by one query. */
export const MAX_SEARCH_LIMIT = 60;

/** Maximum whitespace-separated folded tokens compiled into one FTS5 or fallback query. */
export const MAX_SEARCH_TOKENS = 8;

/** Filter scope accepted by {@link querySearch} and `CatalogService.search` (`#397`). */
export type SearchScope = 'all' | 'live' | 'epg' | 'movie' | 'series' | 'episode';

/** Field that matched a movie or series search hit (`#397`). */
export type SearchMatchedBy = 'title' | 'cast' | 'director';

/** A live channel, movie, or series search hit with optional match attribution (`#397`). */
export interface SearchItemHit extends ItemRow {
  readonly matchedBy?: SearchMatchedBy;
}

/** An EPG programme search hit joined to a visible live channel (`#397`). */
export interface SearchProgrammeHit {
  readonly sourceId: string;
  readonly guideId: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly channelLogoUrl: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly start: number;
  readonly stop: number;
  readonly category: string | null;
  readonly isLiveNow: boolean;
}

/** A series episode search hit joined to a visible parent series (`#397`). */
export interface SearchEpisodeHit {
  readonly sourceId: string;
  readonly itemKey: string;
  readonly seriesKey: string;
  readonly seriesName: string;
  readonly season: number;
  readonly episode: number;
  readonly title: string;
  readonly posterUrl: string | null;
}

/** Options controlling {@link querySearch} scope, source filtering, per-kind result cap, and reference clock. */
export interface SearchOptions {
  readonly scope?: SearchScope;
  readonly limit?: number;
  readonly sourceId?: string;
  /** Reference epoch-ms timestamp for EPG active/upcoming ranking; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

/** Grouped catalog search results across live channels, EPG programmes, movies, series, and episodes (`#397`). */
export interface SearchResults {
  readonly live: SearchItemHit[];
  readonly epg: SearchProgrammeHit[];
  readonly movies: SearchItemHit[];
  readonly series: SearchItemHit[];
  readonly episodes: SearchEpisodeHit[];
}

/** Alias for {@link SearchResults} (`#397`). */
export type SearchResult = SearchResults;

interface RawSearchRow {
  id: number;
  key: string;
  source_id: string;
  provider_id: string | null;
  name: string;
  name_fold: string;
  cast_fold: string | null;
  director_fold: string | null;
  logo: string | null;
  rating: number | null;
  year: number | null;
  num: number | null;
}

interface RawProgrammeSearchRow {
  source_id: string;
  guide_id: string;
  channel_key: string;
  channel_name: string;
  channel_logo: string | null;
  title: string;
  description: string | null;
  start: number;
  stop: number;
  categories_json: string | null;
  genre: string | null;
}

interface RawEpisodeSearchRow {
  source_id: string;
  item_key: string;
  series_key: string;
  series_name: string;
  season: number;
  episode: number;
  title: string;
  poster_url: string | null;
}

const SEARCH_SPEC: Record<
  BrowseKind,
  {
    readonly table: string;
    readonly fts: string;
    readonly cols: string;
    readonly foldCols: string;
    readonly bm25Expr: string;
    readonly hasCredits: boolean;
  }
> = {
  live: {
    table: 'live',
    fts: 'live_fts',
    cols: 't.logo AS logo, NULL AS rating, NULL AS year, t.num AS num',
    foldCols: 't.name_fold AS name_fold, NULL AS cast_fold, NULL AS director_fold',
    bm25Expr: 'bm25(live_fts)',
    hasCredits: false,
  },
  movie: {
    table: 'movies',
    fts: 'movies_fts',
    cols: 't.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num',
    foldCols:
      't.name_fold AS name_fold, t.cast_fold AS cast_fold, t.director_fold AS director_fold',
    bm25Expr: 'bm25(movies_fts, 4.0, 1.5, 1.5)',
    hasCredits: true,
  },
  series: {
    table: 'series',
    fts: 'series_fts',
    cols: 't.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num',
    foldCols:
      't.name_fold AS name_fold, t.cast_fold AS cast_fold, t.director_fold AS director_fold',
    bm25Expr: 'bm25(series_fts, 4.0, 1.5, 1.5)',
    hasCredits: true,
  },
};

function clampSearchLimit(limit: number | undefined): number {
  const n =
    limit === undefined || !Number.isFinite(limit) ? DEFAULT_SEARCH_LIMIT : Math.floor(limit);
  return Math.min(MAX_SEARCH_LIMIT, Math.max(0, n));
}

function tokenizeFolded(folded: string): string[] {
  if (folded === '') return [];
  return folded
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_SEARCH_TOKENS);
}

/** Escapes SQLite `LIKE` wildcards (`%`, `_`, `\`) using `\` as the `ESCAPE` character. */
export function escapeLikePattern(token: string): string {
  return token.replace(/[\\%_]/g, '\\$&');
}

/**
 * Folds a raw user search string via {@link foldText} and compiles up to {@link MAX_SEARCH_TOKENS}
 * double-quoted prefix tokens joined by `AND` (`"tok1"* AND "tok2"*`), neutralizing FTS5 operators.
 * Returns `null` when no searchable tokens remain.
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const tokens = tokenizeFolded(foldText(rawQuery));
  if (tokens.length === 0) return null;
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(' AND ');
}

function fieldHasToken(fieldFold: string | null, token: string): boolean {
  return fieldFold !== null && fieldFold.length > 0 && fieldFold.includes(token);
}

function resolveMatchedBy(
  tokens: readonly string[],
  nameFold: string,
  castFold: string | null,
  directorFold: string | null,
): SearchMatchedBy {
  if (tokens.every((tok) => fieldHasToken(nameFold, tok))) {
    return 'title';
  }
  if (tokens.some((tok) => !fieldHasToken(nameFold, tok) && fieldHasToken(castFold, tok))) {
    return 'cast';
  }
  if (tokens.some((tok) => !fieldHasToken(nameFold, tok) && fieldHasToken(directorFold, tok))) {
    return 'director';
  }
  if (tokens.some((tok) => fieldHasToken(castFold, tok))) {
    return 'cast';
  }
  if (tokens.some((tok) => fieldHasToken(directorFold, tok))) {
    return 'director';
  }
  return 'title';
}

function mapSearchRow(
  kind: BrowseKind,
  r: RawSearchRow,
  tokens: readonly string[],
  hasCredits: boolean,
): SearchItemHit {
  const matchedBy = hasCredits
    ? resolveMatchedBy(tokens, r.name_fold, r.cast_fold, r.director_fold)
    : undefined;
  return {
    id: r.id,
    key: r.key,
    kind,
    sourceId: r.source_id,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: r.rating,
    year: r.year,
    num: r.num,
    ...(matchedBy !== undefined ? { matchedBy } : {}),
  };
}

function parseProgrammeCategory(
  categoriesJson: string | null,
  genre: string | null,
): string | null {
  if (categoriesJson !== null && categoriesJson !== '') {
    try {
      const parsed = JSON.parse(categoriesJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'string' && entry.trim() !== '') return entry.trim();
        }
      }
    } catch {
      // Fall through to genre
    }
  }
  return genre !== null && genre !== '' ? genre : null;
}

function mapProgrammeSearchRow(r: RawProgrammeSearchRow, nowMs: number): SearchProgrammeHit {
  return {
    sourceId: r.source_id,
    guideId: r.guide_id,
    channelKey: r.channel_key,
    channelName: r.channel_name,
    channelLogoUrl: r.channel_logo,
    title: r.title,
    description: r.description,
    start: r.start,
    stop: r.stop,
    category: parseProgrammeCategory(r.categories_json, r.genre),
    isLiveNow: r.start <= nowMs && r.stop > nowMs,
  };
}

function mapEpisodeSearchRow(r: RawEpisodeSearchRow): SearchEpisodeHit {
  return {
    sourceId: r.source_id,
    itemKey: r.item_key,
    seriesKey: r.series_key,
    seriesName: r.series_name,
    season: r.season,
    episode: r.episode,
    title: r.title,
    posterUrl: r.poster_url,
  };
}

async function searchKindLikeFallback(
  db: SqlDriver,
  kind: BrowseKind,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
): Promise<SearchItemHit[]> {
  const { table, cols, foldCols, hasCredits } = SEARCH_SPEC[kind];
  const sourceClause = sourceId === undefined ? '' : ' AND t.source_id = ?';
  if (!hasCredits) {
    const likeClauses = tokens.map(() => "t.name_fold LIKE ? ESCAPE '\\'").join(' AND ');
    const params: SqlValue[] = [
      ...(sourceId === undefined ? [] : [sourceId]),
      ...tokens.map((tok) => `%${escapeLikePattern(tok)}%`),
      limit,
    ];
    const rows = await db.all<RawSearchRow>(
      `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${foldCols}, ${cols}
         FROM ${table} t
         JOIN sources s ON s.id = t.source_id AND s.deleting = 0
        WHERE t.is_hidden = 0${sourceClause} AND ${likeClauses}
        ORDER BY t.name COLLATE NOCASE ASC, t.id ASC
        LIMIT ?`,
      params,
    );
    return rows.map((r) => mapSearchRow(kind, r, tokens, false));
  }

  const likeClauses = tokens
    .map(
      () =>
        "(t.name_fold LIKE ? ESCAPE '\\' OR COALESCE(t.cast_fold, '') LIKE ? ESCAPE '\\' OR COALESCE(t.director_fold, '') LIKE ? ESCAPE '\\')",
    )
    .join(' AND ');
  const tokenParams: SqlValue[] = [];
  for (const tok of tokens) {
    const pat = `%${escapeLikePattern(tok)}%`;
    tokenParams.push(pat, pat, pat);
  }
  const firstPat = `%${escapeLikePattern(tokens[0] ?? '')}%`;
  const params: SqlValue[] = [
    ...(sourceId === undefined ? [] : [sourceId]),
    ...tokenParams,
    firstPat,
    limit,
  ];
  const rows = await db.all<RawSearchRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${foldCols}, ${cols}
       FROM ${table} t
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE t.is_hidden = 0${sourceClause} AND ${likeClauses}
      ORDER BY CASE WHEN t.name_fold LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END ASC,
               t.name COLLATE NOCASE ASC,
               t.id ASC
      LIMIT ?`,
    params,
  );
  return rows.map((r) => mapSearchRow(kind, r, tokens, true));
}

async function searchKind(
  db: SqlDriver,
  kind: BrowseKind,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
): Promise<SearchItemHit[]> {
  const { table, fts, cols, foldCols, bm25Expr, hasCredits } = SEARCH_SPEC[kind];
  const sourceClause = sourceId === undefined ? '' : ' AND t.source_id = ?';
  const params: SqlValue[] =
    sourceId === undefined
      ? [ftsQuery, foldedQuery, foldedQuery, foldedQuery, limit]
      : [ftsQuery, sourceId, foldedQuery, foldedQuery, foldedQuery, limit];
  const rows = await db.all<RawSearchRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${foldCols}, ${cols}
       FROM ${fts}
       JOIN ${table} t ON t.id = ${fts}.rowid
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE ${fts} MATCH ? AND t.is_hidden = 0${sourceClause}
      ORDER BY CASE
                 WHEN t.name_fold = ? THEN 0
                 WHEN substr(t.name_fold, 1, length(?)) = ? THEN 1
                 ELSE 2
               END,
               ${bm25Expr},
               t.name
      LIMIT ?`,
    params,
  );
  if (rows.length > 0) return rows.map((r) => mapSearchRow(kind, r, tokens, hasCredits));
  return searchKindLikeFallback(db, kind, tokens, limit, sourceId);
}

const EPG_LIVE_JOIN = `JOIN live l
  ON l.source_id = p.source_id
 AND l.is_hidden = 0
 AND (
   l.key IN (
     SELECT cg.channel_key FROM channel_guide cg
      WHERE cg.source_id = p.source_id AND cg.guide_id = p.guide_id
   )
   OR (
     l.guide_id = p.guide_id
     AND NOT EXISTS (
       SELECT 1 FROM channel_guide cg2
        WHERE cg2.source_id = p.source_id AND cg2.guide_id = p.guide_id
     )
   )
 )`;

async function queryEpgFts(
  db: SqlDriver,
  ftsQuery: string,
  foldedQuery: string,
  limit: number,
  sourceId: string | undefined,
  nowMs: number,
): Promise<RawProgrammeSearchRow[]> {
  const sourceClause = sourceId === undefined ? '' : ' AND p.source_id = ?';
  const params: SqlValue[] = [
    ftsQuery,
    ...(sourceId === undefined ? [] : [sourceId]),
    nowMs,
    nowMs,
    nowMs,
    foldedQuery,
    foldedQuery,
    foldedQuery,
    limit,
  ];
  return db.all<RawProgrammeSearchRow>(
    `SELECT p.source_id,
            p.guide_id,
            l.key AS channel_key,
            l.name AS channel_name,
            l.logo AS channel_logo,
            p.title,
            p.description,
            p.start,
            p.stop,
            p.categories_json,
            p.genre
       FROM programmes_fts
       JOIN programmes p
         ON p.source_id = programmes_fts.source_id
        AND p.guide_id = programmes_fts.guide_id
        AND p.start = programmes_fts.start
       JOIN sources s ON s.id = p.source_id AND s.deleting = 0
       ${EPG_LIVE_JOIN}
      WHERE programmes_fts MATCH ?${sourceClause}
      ORDER BY CASE WHEN p.stop >= ? THEN 0 ELSE 1 END ASC,
               CASE WHEN p.start <= ? AND p.stop > ? THEN 0 ELSE 1 END ASC,
               CASE
                 WHEN programmes_fts.title_fold = ? THEN 0
                 WHEN substr(programmes_fts.title_fold, 1, length(?)) = ? THEN 1
                 ELSE 2
               END ASC,
               bm25(programmes_fts, 0.0, 0.0, 0.0, 0.0, 4.0, 1.0) ASC,
               p.start ASC,
               l.name ASC
      LIMIT ?`,
    params,
  );
}

async function searchEpg(
  db: SqlDriver,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
  nowMs: number,
): Promise<SearchProgrammeHit[]> {
  let rows = await queryEpgFts(db, ftsQuery, foldedQuery, limit, sourceId, nowMs);
  if (rows.length === 0) {
    const backfilled = await backfillProgrammesFtsIfEmpty(db);
    if (backfilled) {
      rows = await queryEpgFts(db, ftsQuery, foldedQuery, limit, sourceId, nowMs);
    }
  }
  if (rows.length > 0) {
    return rows.map((r) => mapProgrammeSearchRow(r, nowMs));
  }

  const sourceClause = sourceId === undefined ? '' : ' AND p.source_id = ?';
  const likeClauses = tokens
    .map(
      () =>
        "(programmes_fts.title_fold LIKE ? ESCAPE '\\' OR programmes_fts.description_fold LIKE ? ESCAPE '\\')",
    )
    .join(' AND ');
  const tokenParams: SqlValue[] = [];
  for (const tok of tokens) {
    const pat = `%${escapeLikePattern(tok)}%`;
    tokenParams.push(pat, pat);
  }
  const params: SqlValue[] = [
    ...(sourceId === undefined ? [] : [sourceId]),
    ...tokenParams,
    nowMs,
    nowMs,
    nowMs,
    limit,
  ];
  const fallbackRows = await db.all<RawProgrammeSearchRow>(
    `SELECT p.source_id,
            p.guide_id,
            l.key AS channel_key,
            l.name AS channel_name,
            l.logo AS channel_logo,
            p.title,
            p.description,
            p.start,
            p.stop,
            p.categories_json,
            p.genre
       FROM programmes_fts
       JOIN programmes p
         ON p.source_id = programmes_fts.source_id
        AND p.guide_id = programmes_fts.guide_id
        AND p.start = programmes_fts.start
       JOIN sources s ON s.id = p.source_id AND s.deleting = 0
       ${EPG_LIVE_JOIN}
      WHERE 1 = 1${sourceClause} AND ${likeClauses}
      ORDER BY CASE WHEN p.stop >= ? THEN 0 ELSE 1 END ASC,
               CASE WHEN p.start <= ? AND p.stop > ? THEN 0 ELSE 1 END ASC,
               p.start ASC,
               l.name ASC
      LIMIT ?`,
    params,
  );
  return fallbackRows.map((r) => mapProgrammeSearchRow(r, nowMs));
}

async function searchEpisodes(
  db: SqlDriver,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
): Promise<SearchEpisodeHit[]> {
  const sourceClause = sourceId === undefined ? '' : ' AND e.source_id = ?';
  const params: SqlValue[] = [
    ftsQuery,
    ...(sourceId === undefined ? [] : [sourceId]),
    foldedQuery,
    foldedQuery,
    foldedQuery,
    limit,
  ];
  const rows = await db.all<RawEpisodeSearchRow>(
    `SELECT e.source_id,
            e.key AS item_key,
            e.series_key,
            ser.name AS series_name,
            COALESCE(e.season, 0) AS season,
            COALESCE(e.episode, 0) AS episode,
            COALESCE(e.title, '') AS title,
            ser.cover AS poster_url
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.rowid
       JOIN series ser ON ser.source_id = e.source_id AND ser.key = e.series_key AND ser.is_hidden = 0
       JOIN sources s ON s.id = e.source_id AND s.deleting = 0
      WHERE episodes_fts MATCH ?${sourceClause}
      ORDER BY CASE
                 WHEN e.title_fold = ? THEN 0
                 WHEN substr(e.title_fold, 1, length(?)) = ? THEN 1
                 ELSE 2
               END,
               bm25(episodes_fts),
               ser.name ASC,
               COALESCE(e.season, 0) ASC,
               COALESCE(e.episode, 0) ASC
      LIMIT ?`,
    params,
  );
  if (rows.length > 0) return rows.map(mapEpisodeSearchRow);

  const likeClauses = tokens.map(() => "e.title_fold LIKE ? ESCAPE '\\'").join(' AND ');
  const fallbackParams: SqlValue[] = [
    ...(sourceId === undefined ? [] : [sourceId]),
    ...tokens.map((tok) => `%${escapeLikePattern(tok)}%`),
    limit,
  ];
  const fallbackRows = await db.all<RawEpisodeSearchRow>(
    `SELECT e.source_id,
            e.key AS item_key,
            e.series_key,
            ser.name AS series_name,
            COALESCE(e.season, 0) AS season,
            COALESCE(e.episode, 0) AS episode,
            COALESCE(e.title, '') AS title,
            ser.cover AS poster_url
       FROM episodes e
       JOIN series ser ON ser.source_id = e.source_id AND ser.key = e.series_key AND ser.is_hidden = 0
       JOIN sources s ON s.id = e.source_id AND s.deleting = 0
      WHERE 1 = 1${sourceClause} AND ${likeClauses}
      ORDER BY ser.name COLLATE NOCASE ASC,
               COALESCE(e.season, 0) ASC,
               COALESCE(e.episode, 0) ASC,
               e.id ASC
      LIMIT ?`,
    fallbackParams,
  );
  return fallbackRows.map(mapEpisodeSearchRow);
}

/**
 * Runs a Turkish-folded FTS5 prefix search across the requested catalog scopes (`all` by default),
 * filtering `is_hidden = 0` in SQL before `LIMIT`, prioritizing exact folded matches, then prefix
 * matches, then weighted BM25 (`4.0` title vs `1.5` cast/director on VOD/series; active/upcoming
 * EPG hits ahead of past programmes). Falls back to bounded `LIKE` substring queries when FTS5
 * returns 0 hits for a scope.
 */
export async function querySearch(
  db: SqlDriver,
  rawQuery: string,
  opts?: SearchOptions,
): Promise<SearchResults> {
  const foldedQuery = foldText(rawQuery);
  const tokens = tokenizeFolded(foldedQuery);
  const limit = clampSearchLimit(opts?.limit);
  if (tokens.length === 0 || limit === 0) {
    return { live: [], epg: [], movies: [], series: [], episodes: [] };
  }
  const ftsQuery = tokens.map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(' AND ');
  const scope: SearchScope = opts?.scope ?? 'all';
  const sourceId = opts?.sourceId;
  const nowMs = opts?.nowMs !== undefined && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  const [live, epg, movies, series, episodes] = await Promise.all([
    scope === 'all' || scope === 'live'
      ? searchKind(db, 'live', ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
    scope === 'all' || scope === 'epg'
      ? searchEpg(db, ftsQuery, foldedQuery, tokens, limit, sourceId, nowMs)
      : [],
    scope === 'all' || scope === 'movie'
      ? searchKind(db, 'movie', ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
    scope === 'all' || scope === 'series'
      ? searchKind(db, 'series', ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
    scope === 'all' || scope === 'episode'
      ? searchEpisodes(db, ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
  ]);

  return { live, epg, movies, series, episodes };
}
