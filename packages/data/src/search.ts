import type { SqlDriver, SqlValue } from '@elv/domain';
import { foldText } from './fold';
import type { BrowseKind, ItemRow } from './queries';

/** Default per-kind search result cap. */
export const DEFAULT_SEARCH_LIMIT = 40;

/** Hard upper bound on per-kind search results returned by one query. */
export const MAX_SEARCH_LIMIT = 60;

/** Maximum whitespace-separated folded tokens compiled into one FTS5 query. */
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

const EMPTY_RESULTS: SearchResults = { live: [], movies: [], series: [] };

function clampSearchLimit(limit: number | undefined): number {
  const n =
    limit === undefined || !Number.isFinite(limit) ? DEFAULT_SEARCH_LIMIT : Math.floor(limit);
  return Math.min(MAX_SEARCH_LIMIT, Math.max(0, n));
}

/**
 * Folds a raw user search string via {@link foldText} and compiles up to {@link MAX_SEARCH_TOKENS}
 * double-quoted prefix tokens joined by `AND` (`"tok1"* AND "tok2"*`), neutralizing FTS5 operators.
 * Returns `null` when no searchable tokens remain.
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const folded = foldText(rawQuery);
  if (folded === '') return null;
  const tokens = folded
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_SEARCH_TOKENS);
  if (tokens.length === 0) return null;
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(' AND ');
}

async function searchKind(
  db: SqlDriver,
  kind: BrowseKind,
  ftsQuery: string,
  foldedQuery: string,
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
      WHERE ${fts} MATCH ?${sourceClause}
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
  return rows.map((r) => ({
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
  }));
}

/**
 * Runs a Turkish-folded FTS5 prefix search across the requested catalog kinds (`all` by default),
 * prioritizing exact folded matches, then prefix matches, then BM25 with alphabetical tie-breaking.
 * Returns empty lists with zero queries when the folded query is empty or `limit` clamps to `0`.
 */
export async function querySearch(
  db: SqlDriver,
  rawQuery: string,
  opts?: SearchOptions,
): Promise<SearchResults> {
  const ftsQuery = buildFtsQuery(rawQuery);
  const limit = clampSearchLimit(opts?.limit);
  if (ftsQuery === null || limit === 0) {
    return { live: [...EMPTY_RESULTS.live], movies: [], series: [] };
  }
  const foldedQuery = foldText(rawQuery);
  const scope: SearchScope = opts?.scope ?? 'all';
  const sourceId = opts?.sourceId;

  const [live, movies, series] = await Promise.all([
    scope === 'all' || scope === 'live'
      ? searchKind(db, 'live', ftsQuery, foldedQuery, limit, sourceId)
      : [],
    scope === 'all' || scope === 'movie'
      ? searchKind(db, 'movie', ftsQuery, foldedQuery, limit, sourceId)
      : [],
    scope === 'all' || scope === 'series'
      ? searchKind(db, 'series', ftsQuery, foldedQuery, limit, sourceId)
      : [],
  ]);

  return { live, movies, series };
}
