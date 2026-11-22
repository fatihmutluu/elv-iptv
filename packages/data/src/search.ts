import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';
import type { BrowseKind, ItemRow } from './queries';

/** Default per-kind search result cap. */
export const DEFAULT_SEARCH_LIMIT = 40;

/** Hard upper bound on per-kind search results returned by one query. */
export const MAX_SEARCH_LIMIT = 60;

/** Maximum whitespace-separated folded tokens compiled into one FTS5 or fallback query. */
export const MAX_SEARCH_TOKENS = 8;

/** Filter scope accepted by {@link querySearch} and `CatalogService.search`. */
export type SearchScope = 'all' | 'live' | 'movie' | 'series';

/** Options controlling {@link querySearch} scope, source filtering, and per-kind result cap. */
export interface SearchOptions {
  readonly scope?: SearchScope;
  readonly limit?: number;
  readonly sourceId?: string;
}

/** Grouped catalog search results across live channels, movies, and series. */
export interface SearchResults {
  readonly live: ItemRow[];
  readonly movies: ItemRow[];
  readonly series: ItemRow[];
}

interface RawSearchRow {
  id: number;
  key: string;
  source_id: string;
  provider_id: string | null;
  name: string;
  logo: string | null;
  rating: number | null;
  year: number | null;
  num: number | null;
}

const SEARCH_SPEC: Record<
  BrowseKind,
  { readonly table: string; readonly fts: string; readonly cols: string }
> = {
  live: {
    table: 'live',
    fts: 'live_fts',
    cols: 't.logo AS logo, NULL AS rating, NULL AS year, t.num AS num',
  },
  movie: {
    table: 'movies',
    fts: 'movies_fts',
    cols: 't.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num',
  },
  series: {
    table: 'series',
    fts: 'series_fts',
    cols: 't.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num',
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

function mapSearchRow(kind: BrowseKind, r: RawSearchRow): ItemRow {
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
  };
}

async function searchKindLikeFallback(
  db: SqlDriver,
  kind: BrowseKind,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
): Promise<ItemRow[]> {
  const { table, cols } = SEARCH_SPEC[kind];
  const sourceClause = sourceId === undefined ? '' : ' AND t.source_id = ?';
  const likeClauses = tokens.map(() => "t.name_fold LIKE ? ESCAPE '\\'").join(' AND ');
  const params: SqlValue[] = [
    ...(sourceId === undefined ? [] : [sourceId]),
    ...tokens.map((tok) => `%${escapeLikePattern(tok)}%`),
    limit,
  ];
  const rows = await db.all<RawSearchRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${cols}
       FROM ${table} t
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE t.is_hidden = 0${sourceClause} AND ${likeClauses}
      ORDER BY t.name COLLATE NOCASE ASC, t.id ASC
      LIMIT ?`,
    params,
  );
  return rows.map((r) => mapSearchRow(kind, r));
}

async function searchKind(
  db: SqlDriver,
  kind: BrowseKind,
  ftsQuery: string,
  foldedQuery: string,
  tokens: readonly string[],
  limit: number,
  sourceId: string | undefined,
): Promise<ItemRow[]> {
  const { table, fts, cols } = SEARCH_SPEC[kind];
  const sourceClause = sourceId === undefined ? '' : ' AND t.source_id = ?';
  const params: SqlValue[] =
    sourceId === undefined
      ? [ftsQuery, foldedQuery, foldedQuery, foldedQuery, limit]
      : [ftsQuery, sourceId, foldedQuery, foldedQuery, foldedQuery, limit];
  const rows = await db.all<RawSearchRow>(
    `SELECT t.id, t.key, t.source_id, t.provider_id, t.name, ${cols}
       FROM ${fts}
       JOIN ${table} t ON t.id = ${fts}.rowid
       JOIN sources s ON s.id = t.source_id AND s.deleting = 0
      WHERE ${fts} MATCH ? AND t.is_hidden = 0${sourceClause}
      ORDER BY CASE
                 WHEN t.name_fold = ? THEN 0
                 WHEN substr(t.name_fold, 1, length(?)) = ? THEN 1
                 ELSE 2
               END,
               bm25(${fts}),
               t.name
      LIMIT ?`,
    params,
  );
  if (rows.length > 0) return rows.map((r) => mapSearchRow(kind, r));
  return searchKindLikeFallback(db, kind, tokens, limit, sourceId);
}

/**
 * Runs a Turkish-folded FTS5 prefix search across the requested catalog kinds (`all` by default),
 * filtering `is_hidden = 0` in SQL before `LIMIT`, prioritizing exact folded matches, then prefix
 * matches, then BM25 with alphabetical tie-breaking. Falls back to a bounded `LIKE` substring
 * search on `name_fold` only when FTS5 returns 0 hits for a kind.
 * Returns empty lists with zero queries when the folded query is empty or `limit` clamps to `0`.
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
    return { live: [], movies: [], series: [] };
  }
  const ftsQuery = tokens.map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(' AND ');
  const scope: SearchScope = opts?.scope ?? 'all';
  const sourceId = opts?.sourceId;

  const [live, movies, series] = await Promise.all([
    scope === 'all' || scope === 'live'
      ? searchKind(db, 'live', ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
    scope === 'all' || scope === 'movie'
      ? searchKind(db, 'movie', ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
    scope === 'all' || scope === 'series'
      ? searchKind(db, 'series', ftsQuery, foldedQuery, tokens, limit, sourceId)
      : [],
  ]);

  return { live, movies, series };
}
