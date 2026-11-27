import type { SqlDriver, SqlValue } from '@elv/domain';
import {
  parseStringMap,
  type SearchMatchedItemKeysByAliasOptions,
  uniqueNonEmpty,
} from './elv-enrichment-types';
import { foldText } from './fold';

const DEFAULT_ALIAS_SEARCH_LIMIT = 50;
const MAX_ALIAS_SEARCH_LIMIT = 100;
const MAX_ALIAS_QUERY_TOKENS = 8;
const MAX_NON_ASCII_FALLBACK_ROWS = 2_000;

interface RawAliasSearchRow {
  readonly item_key: string;
  readonly manual_lock: number;
  readonly confidence: number;
  readonly original_title: string;
  readonly english_title: string | null;
  readonly localized_titles_json: string;
}

interface RankedAliasMatch {
  readonly itemKey: string;
  readonly rank: number;
  readonly manualLock: number;
  readonly confidence: number;
}

/** @internal Escapes `%`, `_`, and `\` for parameterized SQLite `LIKE ... ESCAPE '\'` predicates. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function rankAliasCandidate(
  rawAlias: string,
  foldedQuery: string,
  compactQuery: string,
  queryTokens: readonly string[],
): number | null {
  const foldedAlias = foldText(rawAlias);
  if (foldedAlias === '') return null;
  if (foldedAlias === foldedQuery) return 0;
  if (foldedAlias.startsWith(foldedQuery)) return 1;

  const aliasTokens = foldedAlias.split(' ').filter(Boolean);
  if (queryTokens.every((qTok) => aliasTokens.some((aTok) => aTok.startsWith(qTok)))) {
    return 2;
  }
  if (
    queryTokens.every(
      (qTok) =>
        aliasTokens.some((aTok) => aTok.startsWith(qTok)) ||
        (qTok.length >= 3 && foldedAlias.includes(qTok)),
    )
  ) {
    return 3;
  }
  if (compactQuery.length >= 3 && foldedAlias.replace(/ /g, '').includes(compactQuery)) {
    return 4;
  }
  return null;
}

function rankAliasRow(
  row: RawAliasSearchRow,
  foldedQuery: string,
  compactQuery: string,
  queryTokens: readonly string[],
): number | null {
  let best: number | null = null;
  const consider = (candidate: string | null | undefined) => {
    if (candidate === null || candidate === undefined || candidate === '') return;
    const rank = rankAliasCandidate(candidate, foldedQuery, compactQuery, queryTokens);
    if (rank !== null && (best === null || rank < best)) best = rank;
  };

  consider(row.original_title);
  consider(row.english_title);
  const localized = parseStringMap(row.localized_titles_json);
  for (const title of Object.values(localized)) {
    consider(title);
  }
  return best;
}

/**
 * @internal Searches `elv_titles` (`original_title`, `english_title`, `localized_titles_json`)
 * joined with `elv_item_matches` using folded, case- and diacritic-insensitive matching (`#511`).
 */
export async function searchMatchedItemKeysByAlias(
  driver: SqlDriver,
  query: string,
  opts?: SearchMatchedItemKeysByAliasOptions,
): Promise<readonly string[]> {
  const foldedQuery = foldText(query);
  if (foldedQuery === '') return [];
  const queryTokens = foldedQuery.split(' ').filter(Boolean).slice(0, MAX_ALIAS_QUERY_TOKENS);
  if (queryTokens.length === 0) return [];

  if (opts?.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    return [];
  }
  const limit = Math.max(
    1,
    Math.min(MAX_ALIAS_SEARCH_LIMIT, Math.floor(opts?.limit ?? DEFAULT_ALIAS_SEARCH_LIMIT)),
  );
  const compactQuery = foldedQuery.replace(/ /g, '');
  const excluded = uniqueNonEmpty(opts?.excludedSourceIds ?? []);

  const baseClauses: string[] = [];
  const baseParams: SqlValue[] = [];
  if (opts?.mediaType !== undefined) {
    baseClauses.push('m.media_type = ?');
    baseParams.push(opts.mediaType);
  }
  if (excluded.length > 0) {
    baseClauses.push(`m.source_id NOT IN (${placeholders(excluded.length)})`);
    baseParams.push(...excluded);
  }

  const matched = new Map<string, RankedAliasMatch>();
  const collectRows = (rows: readonly RawAliasSearchRow[]) => {
    for (const row of rows) {
      const rank = rankAliasRow(row, foldedQuery, compactQuery, queryTokens);
      if (rank === null) continue;
      const existing = matched.get(row.item_key);
      if (existing === undefined || rank < existing.rank) {
        matched.set(row.item_key, {
          itemKey: row.item_key,
          rank,
          manualLock: row.manual_lock,
          confidence: row.confidence,
        });
      }
    }
  };

  // Pass 1: fast SQL LIKE pre-filter over original, English, and localized titles
  const haystackExpr =
    "LOWER(t.original_title || ' ' || COALESCE(t.english_title, '') || ' ' || t.localized_titles_json)";
  const likeClauses = [...baseClauses];
  const likeParams: SqlValue[] = [...baseParams];
  for (const token of queryTokens) {
    likeClauses.push(`${haystackExpr} LIKE ? ESCAPE '\\'`);
    likeParams.push(`%${escapeLikePattern(token)}%`);
  }
  const pass1Limit = Math.min(limit * 4, 400);
  const pass1Rows = await driver.all<RawAliasSearchRow>(
    `SELECT m.item_key, m.manual_lock, m.confidence,
            t.original_title, t.english_title, t.localized_titles_json
       FROM elv_titles t
       JOIN elv_item_matches m ON m.imdb_id = t.imdb_id
      WHERE ${likeClauses.join(' AND ')}
      ORDER BY m.manual_lock DESC, m.confidence DESC, m.item_key ASC
      LIMIT ?`,
    [...likeParams, pass1Limit],
  );
  collectRows(pass1Rows);

  // Pass 2: diacritic/non-ASCII fallback for rows SQLite ASCII LOWER() cannot fold (e.g. Başlangıç <-> Baslangic)
  if (matched.size < limit) {
    const nonAsciiClauses = [
      ...baseClauses,
      "(t.original_title GLOB '*[^ -~]*' OR COALESCE(t.english_title, '') GLOB '*[^ -~]*' OR t.localized_titles_json GLOB '*[^ -~]*')",
    ];
    const pass2Rows = await driver.all<RawAliasSearchRow>(
      `SELECT m.item_key, m.manual_lock, m.confidence,
              t.original_title, t.english_title, t.localized_titles_json
         FROM elv_titles t
         JOIN elv_item_matches m ON m.imdb_id = t.imdb_id
        WHERE ${nonAsciiClauses.join(' AND ')}
        ORDER BY m.manual_lock DESC, m.confidence DESC, m.item_key ASC
        LIMIT ?`,
      [...baseParams, MAX_NON_ASCII_FALLBACK_ROWS],
    );
    collectRows(pass2Rows);
  }

  return [...matched.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.manualLock - a.manualLock ||
        b.confidence - a.confidence ||
        a.itemKey.localeCompare(b.itemKey),
    )
    .slice(0, limit)
    .map((entry) => entry.itemKey);
}
