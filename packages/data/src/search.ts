import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';
import { isAdultKeywordMatch } from './parental-policy';
import {
  type ActiveParentalFilter,
  buildSqlItemRestrictionClause,
  loadActiveParentalFilter,
} from './parental-repo';
import type { BrowseKind } from './queries-shared';
import {
  LIVE_EFFECTIVE_NAME_EXPR,
  LIVE_OVERRIDE_JOIN,
  LIVE_OVERRIDE_META_COLS,
  resolveQueryProfileId,
} from './queries-shared';
import {
  escapeLikePattern,
  MAX_SEARCH_LIMIT,
  mergeLiveSearchHits,
  type SearchItemHit,
  type SearchMatchedBy,
  searchLiveCustomNames,
} from './search-channel-overrides';
import {
  type SearchEpisodeHit,
  type SearchProgrammeHit,
  searchEpg,
  searchEpisodes,
} from './search-epg-episodes';

export {
  DEFAULT_SEARCH_SUGGESTIONS_LIMIT,
  MAX_SEARCH_SUGGESTIONS_LIMIT,
  querySearchSuggestions,
  type SearchSuggestion,
  type SearchSuggestionKind,
  type SearchSuggestionsOptions,
} from './search-suggestions';
export {
  escapeLikePattern,
  MAX_SEARCH_LIMIT,
  type SearchEpisodeHit,
  type SearchItemHit,
  type SearchMatchedBy,
  type SearchProgrammeHit,
};

/** Default per-kind search result cap. */
export const DEFAULT_SEARCH_LIMIT = 40;

/** Maximum whitespace-separated folded tokens compiled into one FTS5 or fallback query. */
export const MAX_SEARCH_TOKENS = 8;

/** Filter scope accepted by {@link querySearch} and `CatalogService.search` (`#397`). */
export type SearchScope = 'all' | 'live' | 'epg' | 'movie' | 'series' | 'episode';

/** Options controlling {@link querySearch} scope, source filtering, per-kind result cap, parental state, and reference clock. */
export interface SearchOptions {
  readonly scope?: SearchScope;
  readonly limit?: number;
  readonly sourceId?: string;
  /** Reference epoch-ms timestamp for EPG active/upcoming ranking; defaults to `Date.now()`. */
  readonly nowMs?: number;
  /** Profile identifier for query-layer parental filtering (defaults to `'default'`). */
  readonly profileId?: string;
  /** When `true`, bypasses query-layer parental filtering for an unlocked session (`#31`). */
  readonly parentalUnlocked?: boolean;
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
  raw_name?: string;
  original_name?: string | null;
  co_sort_order?: number | null;
  name_fold: string;
  cast_fold: string | null;
  director_fold: string | null;
  logo: string | null;
  rating: number | null;
  year: number | null;
  num: number | null;
  catchup_days?: number | null;
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
    cols: 't.logo AS logo, NULL AS rating, NULL AS year, t.num AS num, t.catchup_days AS catchup_days',
    foldCols: 't.name_fold AS name_fold, NULL AS cast_fold, NULL AS director_fold',
    bm25Expr: 'bm25(live_fts)',
    hasCredits: false,
  },
  movie: {
    table: 'movies',
    fts: 'movies_fts',
    cols: 't.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num, NULL AS catchup_days',
    foldCols:
      't.name_fold AS name_fold, t.cast_fold AS cast_fold, t.director_fold AS director_fold',
    bm25Expr: 'bm25(movies_fts, 4.0, 1.5, 1.5)',
    hasCredits: true,
  },
  series: {
    table: 'series',
    fts: 'series_fts',
    cols: 't.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num, NULL AS catchup_days',
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
    ...(typeof r.original_name === 'string' && r.original_name !== ''
      ? { originalName: r.original_name }
      : {}),
    ...(typeof r.co_sort_order === 'number' ? { customSortOrder: r.co_sort_order } : {}),
    logo: r.logo,
    rating: r.rating,
    year: r.year,
    num: r.num,
    ...(typeof r.catchup_days === 'number' && Number.isFinite(r.catchup_days) && r.catchup_days > 0
      ? { catchupDays: r.catchup_days }
      : {}),
    ...(matchedBy !== undefined ? { matchedBy } : {}),
  };
}

function searchFetchLimit(limit: number, filter: ActiveParentalFilter | null): number {
  return filter === null ? limit : Math.min(MAX_SEARCH_LIMIT * 4, Math.max(limit * 4, 60));
}

function filterSearchRows(
  rows: readonly RawSearchRow[],
  limit: number,
  filter: ActiveParentalFilter | null,
): RawSearchRow[] {
  if (filter === null || !filter.blockAdultKeywords) return rows.slice(0, limit);
  const out: RawSearchRow[] = [];
  for (const r of rows) {
    if (
      isAdultKeywordMatch(r.raw_name ?? r.name) ||
      isAdultKeywordMatch(r.name) ||
      isAdultKeywordMatch(r.name_fold)
    ) {
      continue;
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

async function searchKindLikeFallback(
  db: SqlDriver,
  kind: BrowseKind,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
  profileId: string,
  filter: ActiveParentalFilter | null,
): Promise<SearchItemHit[]> {
  const { table, cols, foldCols, hasCredits } = SEARCH_SPEC[kind];
  const isLive = kind === 'live';
  const sourceClause = sourceId === undefined ? '' : ' AND t.source_id = ?';
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', sourceId);
  const fetchLimit = searchFetchLimit(limit, filter);
  if (!hasCredits) {
    const likeClauses = tokens.map(() => "t.name_fold LIKE ? ESCAPE '\\'").join(' AND ');
    const liveJoin = isLive ? `\n         ${LIVE_OVERRIDE_JOIN}` : '';
    const liveHidden = isLive ? ' AND COALESCE(co.is_hidden, 0) = 0' : '';
    const nameCols = isLive
      ? `${LIVE_EFFECTIVE_NAME_EXPR} AS name, t.name AS raw_name, ${LIVE_OVERRIDE_META_COLS}`
      : 't.name';
    const params: SqlValue[] = [
      ...(isLive ? [profileId] : []),
      ...(sourceId === undefined ? [] : [sourceId]),
      ...restrict.params,
      ...tokens.map((tok) => `%${escapeLikePattern(tok)}%`),
      fetchLimit,
    ];
    const rows = await db.all<RawSearchRow>(
      `SELECT t.id, t.key, t.source_id, t.provider_id, ${nameCols}, ${foldCols}, ${cols}
         FROM ${table} t
         JOIN sources s ON s.id = t.source_id AND s.deleting = 0${liveJoin}
        WHERE t.is_hidden = 0${liveHidden}${sourceClause}${restrict.clause} AND ${likeClauses}
        ORDER BY name COLLATE NOCASE ASC, t.id ASC
        LIMIT ?`,
      params,
    );
    return filterSearchRows(rows, limit, filter).map((r) => mapSearchRow(kind, r, tokens, false));
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
    ...restrict.params,
    ...tokenParams,
    firstPat,
    fetchLimit,
  ];
  const rows = await db.all<RawSearchRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${foldCols}, ${cols}
       FROM ${table} t
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE t.is_hidden = 0${sourceClause}${restrict.clause} AND ${likeClauses}
      ORDER BY CASE WHEN t.name_fold LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END ASC,
               t.name COLLATE NOCASE ASC,
               t.id ASC
      LIMIT ?`,
    params,
  );
  return filterSearchRows(rows, limit, filter).map((r) => mapSearchRow(kind, r, tokens, true));
}

async function searchKind(
  db: SqlDriver,
  kind: BrowseKind,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
  profileId: string,
  filter: ActiveParentalFilter | null,
): Promise<SearchItemHit[]> {
  const { table, fts, cols, foldCols, bm25Expr, hasCredits } = SEARCH_SPEC[kind];
  const isLive = kind === 'live';
  const liveJoin = isLive ? `\n       ${LIVE_OVERRIDE_JOIN}` : '';
  const liveHidden = isLive ? ' AND COALESCE(co.is_hidden, 0) = 0' : '';
  const nameCols = isLive
    ? `${LIVE_EFFECTIVE_NAME_EXPR} AS name, t.name AS raw_name, ${LIVE_OVERRIDE_META_COLS}`
    : 't.name';
  const sourceClause = sourceId === undefined ? '' : ' AND t.source_id = ?';
  const restrict =
    filter === null
      ? { clause: '', params: [] as readonly SqlValue[] }
      : buildSqlItemRestrictionClause(filter, kind, 't.source_id', 't.key', sourceId);
  const fetchLimit = searchFetchLimit(limit, filter);
  const params: SqlValue[] = [
    ...(isLive ? [profileId] : []),
    ftsQuery,
    ...(sourceId === undefined ? [] : [sourceId]),
    ...restrict.params,
    foldedQuery,
    foldedQuery,
    foldedQuery,
    fetchLimit,
  ];
  const [rows, customHits] = await Promise.all([
    db.all<RawSearchRow>(
      `SELECT t.id, t.key, t.source_id, t.provider_id, ${nameCols}, ${foldCols}, ${cols}
         FROM ${fts}
         JOIN ${table} t ON t.id = ${fts}.rowid
         JOIN sources s ON s.id = t.source_id AND s.deleting = 0${liveJoin}
        WHERE ${fts} MATCH ? AND t.is_hidden = 0${liveHidden}${sourceClause}${restrict.clause}
        ORDER BY CASE
                   WHEN t.name_fold = ? THEN 0
                   WHEN substr(t.name_fold, 1, length(?)) = ? THEN 1
                   ELSE 2
                 END,
                 ${bm25Expr},
                 t.name
        LIMIT ?`,
      params,
    ),
    isLive
      ? searchLiveCustomNames(db, tokens, foldedQuery, limit, sourceId, profileId, filter)
      : Promise.resolve([] as SearchItemHit[]),
  ]);
  const filtered = filterSearchRows(rows, limit, filter);
  if (filtered.length > 0) {
    const hits = filtered.map((r) => mapSearchRow(kind, r, tokens, hasCredits));
    return isLive ? mergeLiveSearchHits(customHits, hits, limit) : hits;
  }
  if (rows.length > 0) return isLive ? customHits : [];
  const fallback = await searchKindLikeFallback(
    db,
    kind,
    tokens,
    limit,
    sourceId,
    profileId,
    filter,
  );
  return isLive ? mergeLiveSearchHits(customHits, fallback, limit) : fallback;
}

/**
 * Runs a Turkish-folded FTS5 prefix search across the requested catalog scopes (`all` by default),
 * filtering `is_hidden = 0` and active parental restrictions (`#31`) before `LIMIT`, prioritizing
 * exact folded matches, then prefix matches, then weighted BM25 (`4.0` title vs `1.5` cast/director
 * on VOD/series; active/upcoming EPG hits ahead of past programmes). Falls back to bounded `LIKE`
 * substring queries when FTS5 returns 0 hits for a scope.
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
  const profileId = resolveQueryProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(db, profileId, opts?.parentalUnlocked);

  const [live, epg, movies, series, episodes] = await Promise.all([
    scope === 'all' || scope === 'live'
      ? searchKind(db, 'live', ftsQuery, foldedQuery, tokens, limit, sourceId, profileId, filter)
      : [],
    scope === 'all' || scope === 'epg'
      ? searchEpg(db, ftsQuery, foldedQuery, tokens, limit, sourceId, nowMs, profileId, filter)
      : [],
    scope === 'all' || scope === 'movie'
      ? searchKind(db, 'movie', ftsQuery, foldedQuery, tokens, limit, sourceId, profileId, filter)
      : [],
    scope === 'all' || scope === 'series'
      ? searchKind(db, 'series', ftsQuery, foldedQuery, tokens, limit, sourceId, profileId, filter)
      : [],
    scope === 'all' || scope === 'episode'
      ? searchEpisodes(db, ftsQuery, foldedQuery, tokens, limit, sourceId, filter)
      : [],
  ]);

  return { live, epg, movies, series, episodes };
}
