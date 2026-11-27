import type { SqlDriver, SqlValue } from '@elv/domain';
import { escapeLikePattern } from './elv-enrichment-search';
import {
  type ElvFeedItem,
  type ElvFeedRecord,
  type ElvGenreSummary,
  type ElvMatchedPersonTitle,
  type ElvMatchRecord,
  type ElvMediaType,
  type ElvPersonQuery,
  type ElvPersonRole,
  type ElvSourceFilterOptions,
  type ElvTitleRecord,
  type ListMatchedTitlesByGenreOptions,
  type ListMatchedTitlesByPersonOptions,
  type ListTopRatedMatchedTitlesOptions,
  mapMatchRow,
  mapTitleRow,
  parseStringArray,
  type RawMatchRow,
  type RawTitleRow,
  uniqueNonEmpty,
} from './elv-enrichment-types';
import { foldText } from './fold';
import { normalizeCatalogImdbId } from './writers';

const IN_CHUNK_SIZE = 400;
const DEFAULT_TOP_RATED_LIMIT = 150;
const MAX_TOP_RATED_LIMIT = 500;
const DEFAULT_GENRE_PAGE_LIMIT = 60;
const MAX_GENRE_PAGE_LIMIT = 200;
const DEFAULT_PERSON_LIMIT = 50;
const MAX_PERSON_LIMIT = 200;
const MAX_NON_ASCII_PERSON_FALLBACK_ROWS = 2_000;

const BAYESIAN_SQL_EXPR =
  '((COALESCE(t.votes, 0) / (COALESCE(t.votes, 0) + 1000.0)) * COALESCE(t.rating, 6.8) + (1000.0 / (COALESCE(t.votes, 0) + 1000.0)) * 6.8)';

const EFFECTIVE_LOWER_TITLE_SQL =
  "LOWER(COALESCE(NULLIF(TRIM(t.english_title), ''), t.original_title))";

const ALPHA_SORT_SQL_EXPR = `CASE
  WHEN ${EFFECTIVE_LOWER_TITLE_SQL} LIKE 'the %' THEN LTRIM(SUBSTR(${EFFECTIVE_LOWER_TITLE_SQL}, 5))
  WHEN ${EFFECTIVE_LOWER_TITLE_SQL} LIKE 'an %' THEN LTRIM(SUBSTR(${EFFECTIVE_LOWER_TITLE_SQL}, 4))
  WHEN ${EFFECTIVE_LOWER_TITLE_SQL} LIKE 'a %' THEN LTRIM(SUBSTR(${EFFECTIVE_LOWER_TITLE_SQL}, 3))
  ELSE ${EFFECTIVE_LOWER_TITLE_SQL}
END`;

/** @internal Matched `(item_key, imdb_id, genres)` candidate row used for visible genre counting. */
export interface MatchedGenreCandidateRow {
  readonly item_key: string;
  readonly source_id: string;
  readonly imdb_id: string;
  readonly original_title: string;
  readonly english_title: string | null;
  readonly genres_json: string;
}

/** @internal Paginated genre title query result exposing raw SQL row count alongside post-filtered titles. */
export interface MatchedTitlesByGenrePage {
  readonly titles: readonly ElvTitleRecord[];
  readonly rawCount: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function buildSourceFilterClause(
  alias: string,
  opts?: ElvSourceFilterOptions,
): { readonly empty: boolean; readonly clause: string; readonly params: SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (opts?.allowedSourceIds !== undefined) {
    const allowed = uniqueNonEmpty(opts.allowedSourceIds);
    const excludedSet = new Set(uniqueNonEmpty(opts.excludedSourceIds ?? []));
    const effective = excludedSet.size > 0 ? allowed.filter((s) => !excludedSet.has(s)) : allowed;
    if (effective.length === 0) return { empty: true, clause: '', params: [] };
    parts.push(`${alias}.source_id IN (${placeholders(effective.length)})`);
    params.push(...effective);
  } else if (opts?.excludedSourceIds !== undefined) {
    const excluded = uniqueNonEmpty(opts.excludedSourceIds);
    if (excluded.length > 0) {
      parts.push(`${alias}.source_id NOT IN (${placeholders(excluded.length)})`);
      params.push(...excluded);
    }
  }
  return {
    empty: false,
    clause: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '',
    params,
  };
}

/** @internal Batched `IN (...)` lookup of IMDb title records in `elv_titles`. */
export async function getTitlesByImdbIds(
  driver: SqlDriver,
  imdbIds: readonly string[],
): Promise<Map<string, ElvTitleRecord>> {
  const out = new Map<string, ElvTitleRecord>();
  const unique = uniqueNonEmpty(
    imdbIds.map((id) => normalizeCatalogImdbId(id)).filter((id): id is string => id !== null),
  );
  if (unique.length === 0) return out;
  for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
    const rows = await driver.all<RawTitleRow>(
      `SELECT * FROM elv_titles WHERE imdb_id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const r of rows) out.set(r.imdb_id, mapTitleRow(r));
  }
  return out;
}

/** @internal Batched `IN (...)` lookup of matched `elv_item_matches` rows grouped by `imdb_id`. */
export async function listMatchedMatchesForImdbIds(
  driver: SqlDriver,
  imdbIds: readonly string[],
  mediaType?: ElvMediaType,
  opts?: ElvSourceFilterOptions,
): Promise<Map<string, readonly ElvMatchRecord[]>> {
  const out = new Map<string, ElvMatchRecord[]>();
  const unique = uniqueNonEmpty(
    imdbIds.map((id) => normalizeCatalogImdbId(id)).filter((id): id is string => id !== null),
  );
  if (unique.length === 0) return out;
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return out;
  const maxChunk = Math.max(1, IN_CHUNK_SIZE - srcFilter.params.length - 1);

  for (let i = 0; i < unique.length; i += maxChunk) {
    const chunk = unique.slice(i, i + maxChunk);
    const typeClause = mediaType === undefined ? '' : ' AND m.media_type = ?';
    const params: SqlValue[] = [
      ...chunk,
      ...(mediaType === undefined ? [] : [mediaType]),
      ...srcFilter.params,
    ];
    const rows = await driver.all<RawMatchRow>(
      `SELECT m.item_key, m.source_id, m.media_type, m.imdb_id, m.confidence, m.manual_lock, m.updated_at
         FROM elv_item_matches m
        WHERE m.imdb_id IN (${placeholders(chunk.length)})${typeClause}${srcFilter.clause}
        ORDER BY m.manual_lock DESC, m.confidence DESC, m.item_key ASC`,
      params,
    );
    for (const r of rows) {
      const mapped = mapMatchRow(r);
      const bucket = out.get(mapped.imdbId);
      if (bucket === undefined) out.set(mapped.imdbId, [mapped]);
      else bucket.push(mapped);
    }
  }
  return out;
}

/** @internal Queries top Bayesian-rated matched IMDb titles for Pool B recommendations (`#512`). */
export async function listTopRatedMatchedTitles(
  driver: SqlDriver,
  opts?: ListTopRatedMatchedTitlesOptions,
): Promise<readonly ElvTitleRecord[]> {
  if (opts?.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit <= 0)) return [];
  const limit = Math.max(
    1,
    Math.min(MAX_TOP_RATED_LIMIT, Math.floor(opts?.limit ?? DEFAULT_TOP_RATED_LIMIT)),
  );
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return [];

  const mediaClause = opts?.mediaType === undefined ? '' : ' AND m.media_type = ?';
  const titleMediaClause = opts?.mediaType === undefined ? '' : 't.media_type = ? AND ';
  const params: SqlValue[] = [
    ...(opts?.mediaType === undefined ? [] : [opts.mediaType, opts.mediaType]),
    ...srcFilter.params,
    limit,
  ];
  const rows = await driver.all<RawTitleRow>(
    `SELECT t.*
       FROM elv_titles t
      WHERE ${titleMediaClause}EXISTS (
              SELECT 1 FROM elv_item_matches m
               WHERE m.imdb_id = t.imdb_id${mediaClause}${srcFilter.clause}
            )
      ORDER BY ${BAYESIAN_SQL_EXPR} DESC, COALESCE(t.votes, 0) DESC, t.imdb_id ASC
      LIMIT ?`,
    params,
  );
  return rows.map(mapTitleRow);
}

/** @internal Counts distinct matched IMDb titles per genre for a media type (`#512`). */
export async function listImdbGenreCounts(
  driver: SqlDriver,
  mediaType: ElvMediaType,
  opts?: ElvSourceFilterOptions,
): Promise<ElvGenreSummary[]> {
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return [];
  const rows = await driver.all<{ genres_json: string }>(
    `SELECT DISTINCT t.imdb_id, t.genres_json
       FROM elv_item_matches m
       JOIN elv_titles t ON t.imdb_id = m.imdb_id
      WHERE m.media_type = ?${srcFilter.clause}`,
    [mediaType, ...srcFilter.params],
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const seenForTitle = new Set<string>();
    for (const genre of parseStringArray(row.genres_json)) {
      const trimmed = genre.trim();
      if (trimmed !== '' && !seenForTitle.has(trimmed)) {
        seenForTitle.add(trimmed);
        counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([genre, itemCount]) => ({ genre, itemCount }))
    .sort((a, b) => b.itemCount - a.itemCount || a.genre.localeCompare(b.genre));
}

/** @internal Lists matched item keys + IMDb title genre metadata for visible/parental-filtered genre counting. */
export async function listMatchedTitleGenreCandidates(
  driver: SqlDriver,
  mediaType: ElvMediaType,
  opts?: ElvSourceFilterOptions,
): Promise<readonly MatchedGenreCandidateRow[]> {
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return [];
  return driver.all<MatchedGenreCandidateRow>(
    `SELECT m.item_key, m.source_id, t.imdb_id, t.original_title, t.english_title, t.genres_json
       FROM elv_item_matches m
       JOIN elv_titles t ON t.imdb_id = m.imdb_id
      WHERE m.media_type = ?${srcFilter.clause}`,
    [mediaType, ...srcFilter.params],
  );
}

/** @internal Queries a bounded page of distinct matched IMDb titles belonging to `genre` along with raw SQL row count (`#512`). */
export async function listMatchedTitlesByGenrePage(
  driver: SqlDriver,
  mediaType: ElvMediaType,
  genre: string,
  opts?: ListMatchedTitlesByGenreOptions,
): Promise<MatchedTitlesByGenrePage> {
  const trimmed = genre.trim();
  if (trimmed === '') return { titles: [], rawCount: 0 };
  if (opts?.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    return { titles: [], rawCount: 0 };
  }
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const limit = Math.max(
    1,
    Math.min(MAX_GENRE_PAGE_LIMIT, Math.floor(opts?.limit ?? DEFAULT_GENRE_PAGE_LIMIT)),
  );
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return { titles: [], rawCount: 0 };

  const lowerGenre = trimmed.toLowerCase();
  const likePattern = `%"${escapeLikePattern(lowerGenre)}"%`;
  const orderClause =
    opts?.sortBy === 'alpha'
      ? `${ALPHA_SORT_SQL_EXPR} ASC, t.imdb_id ASC`
      : `${BAYESIAN_SQL_EXPR} DESC, COALESCE(t.year, 0) DESC, t.imdb_id ASC`;
  const rows = await driver.all<RawTitleRow>(
    `SELECT t.*
       FROM elv_titles t
      WHERE LOWER(t.genres_json) LIKE ? ESCAPE '\\'
        AND EXISTS (
              SELECT 1 FROM elv_item_matches m
               WHERE m.imdb_id = t.imdb_id AND m.media_type = ?${srcFilter.clause}
             )
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?`,
    [likePattern, mediaType, ...srcFilter.params, limit, offset],
  );
  const titles = rows
    .map(mapTitleRow)
    .filter((title) => title.genres.some((g) => g.trim().toLowerCase() === lowerGenre));
  return { titles, rawCount: rows.length };
}

/** @internal Queries a bounded page of distinct matched IMDb titles belonging to `genre` (`#512`). */
export async function listMatchedTitlesByGenre(
  driver: SqlDriver,
  mediaType: ElvMediaType,
  genre: string,
  opts?: ListMatchedTitlesByGenreOptions,
): Promise<readonly ElvTitleRecord[]> {
  return (await listMatchedTitlesByGenrePage(driver, mediaType, genre, opts)).titles;
}

/** @internal Lists chronological matched titles sharing `franchise_key` via `idx_elv_titles_franchise` (`#512`). */
export async function listTitlesByFranchise(
  driver: SqlDriver,
  franchiseKey: string,
  opts?: ElvSourceFilterOptions,
): Promise<readonly ElvTitleRecord[]> {
  const key = franchiseKey.trim();
  if (key === '') return [];
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return [];

  const rows = await driver.all<RawTitleRow>(
    `SELECT t.*
       FROM elv_titles t
      WHERE t.franchise_key = ?
        AND EXISTS (
              SELECT 1 FROM elv_item_matches m
               WHERE m.imdb_id = t.imdb_id${srcFilter.clause}
            )
      ORDER BY CASE WHEN t.franchise_order IS NULL THEN 1 ELSE 0 END ASC,
               t.franchise_order ASC,
               CASE WHEN t.year IS NULL THEN 1 ELSE 0 END ASC,
               t.year ASC,
               t.imdb_id ASC`,
    [key, ...srcFilter.params],
  );
  return rows.map(mapTitleRow);
}

function splitDirectors(director: string | null): string[] {
  if (director === null || director.trim() === '') return [];
  return director
    .split(/[,;&/]/g)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function matchPersonOnTitle(
  title: ElvTitleRecord,
  normalizedPersonId: string,
  foldedName: string,
): ElvMatchedPersonTitle | null {
  let matchedDirector = false;
  if (foldedName !== '' && title.director !== null) {
    for (const dir of splitDirectors(title.director)) {
      if (foldText(dir) === foldedName) {
        matchedDirector = true;
        break;
      }
    }
  }

  let matchedCast = false;
  let character: string | null = null;
  for (const member of title.cast) {
    const idHit =
      normalizedPersonId !== '' &&
      typeof member.personId === 'string' &&
      member.personId.trim().toLowerCase() === normalizedPersonId;
    const nameHit = foldedName !== '' && foldText(member.name) === foldedName;
    if (idHit || nameHit) {
      matchedCast = true;
      if (
        character === null &&
        typeof member.character === 'string' &&
        member.character.trim() !== ''
      ) {
        character = member.character.trim();
      }
      break;
    }
  }

  if (!matchedDirector && !matchedCast) return null;
  const role: ElvPersonRole =
    matchedDirector && matchedCast ? 'both' : matchedDirector ? 'director' : 'cast';
  return { title, role, character };
}

/** @internal Lists matched titles crediting a given actor (`personId` / `name`) or director (`#512`). */
export async function listMatchedTitlesByPerson(
  driver: SqlDriver,
  person: ElvPersonQuery,
  opts?: ListMatchedTitlesByPersonOptions,
): Promise<readonly ElvMatchedPersonTitle[]> {
  const normalizedPersonId = (person.personId ?? '').trim().toLowerCase();
  const foldedName = foldText(person.name);
  if (normalizedPersonId === '' && foldedName === '') return [];
  if (opts?.limit !== undefined && (!Number.isFinite(opts.limit) || opts.limit <= 0)) return [];
  const limit = Math.max(
    1,
    Math.min(MAX_PERSON_LIMIT, Math.floor(opts?.limit ?? DEFAULT_PERSON_LIMIT)),
  );
  const srcFilter = buildSourceFilterClause('m', opts);
  if (srcFilter.empty) return [];

  const candidatePredicates: string[] = [];
  const candidateParams: SqlValue[] = [];
  if (normalizedPersonId !== '') {
    candidatePredicates.push("LOWER(t.cast_json) LIKE ? ESCAPE '\\'");
    candidateParams.push(`%${escapeLikePattern(normalizedPersonId)}%`);
  }
  const nameTokens = foldedName.split(' ').filter((tok) => tok.length >= 2);
  if (nameTokens.length > 0) {
    const directorAll = nameTokens
      .map(() => "LOWER(COALESCE(t.director, '')) LIKE ? ESCAPE '\\'")
      .join(' AND ');
    const castAll = nameTokens.map(() => "LOWER(t.cast_json) LIKE ? ESCAPE '\\'").join(' AND ');
    candidatePredicates.push(`(${directorAll})`, `(${castAll})`);
    for (const tok of nameTokens) candidateParams.push(`%${escapeLikePattern(tok)}%`);
    for (const tok of nameTokens) candidateParams.push(`%${escapeLikePattern(tok)}%`);
  }

  const found = new Map<string, ElvMatchedPersonTitle>();
  const collect = (rows: readonly RawTitleRow[]) => {
    for (const raw of rows) {
      if (found.has(raw.imdb_id)) continue;
      const title = mapTitleRow(raw);
      const hit = matchPersonOnTitle(title, normalizedPersonId, foldedName);
      if (hit !== null) found.set(title.imdbId, hit);
    }
  };

  if (candidatePredicates.length > 0) {
    const pass1Rows = await driver.all<RawTitleRow>(
      `SELECT t.*
         FROM elv_titles t
        WHERE (${candidatePredicates.join(' OR ')})
          AND EXISTS (
                SELECT 1 FROM elv_item_matches m
                 WHERE m.imdb_id = t.imdb_id${srcFilter.clause}
              )
        ORDER BY CASE WHEN t.year IS NULL THEN 1 ELSE 0 END ASC,
                 t.year DESC,
                 COALESCE(t.rating, 0) DESC,
                 t.imdb_id ASC
        LIMIT ?`,
      [...candidateParams, ...srcFilter.params, Math.min(limit * 4, 400)],
    );
    collect(pass1Rows);
  }

  // Non-ASCII fallback for diacritic names SQLite ASCII LOWER() cannot fold (e.g. Penélope Cruz <-> Penelope Cruz)
  if (found.size < limit && foldedName !== '') {
    const pass2Rows = await driver.all<RawTitleRow>(
      `SELECT t.*
         FROM elv_titles t
        WHERE (COALESCE(t.director, '') GLOB '*[^ -~]*' OR t.cast_json GLOB '*[^ -~]*')
          AND EXISTS (
                SELECT 1 FROM elv_item_matches m
                 WHERE m.imdb_id = t.imdb_id${srcFilter.clause}
              )
        ORDER BY CASE WHEN t.year IS NULL THEN 1 ELSE 0 END ASC,
                 t.year DESC,
                 COALESCE(t.rating, 0) DESC,
                 t.imdb_id ASC
        LIMIT ?`,
      [...srcFilter.params, MAX_NON_ASCII_PERSON_FALLBACK_ROWS],
    );
    collect(pass2Rows);
  }

  return [...found.values()]
    .sort(
      (a, b) =>
        (b.title.year ?? -1) - (a.title.year ?? -1) ||
        (b.title.rating ?? -1) - (a.title.rating ?? -1) ||
        a.title.imdbId.localeCompare(b.title.imdbId),
    )
    .slice(0, limit);
}

/** @internal Reads multiple cached `elv_feeds` rows in one query (`#512`). */
export async function listFeeds(
  driver: SqlDriver,
  feedKeys?: readonly string[],
): Promise<ElvFeedRecord[]> {
  let rows: { feed_key: string; items_json: string; updated_at: number }[];
  if (feedKeys === undefined) {
    rows = await driver.all<{ feed_key: string; items_json: string; updated_at: number }>(
      'SELECT feed_key, items_json, updated_at FROM elv_feeds ORDER BY feed_key ASC',
    );
  } else {
    const unique = uniqueNonEmpty(feedKeys);
    if (unique.length === 0) return [];
    rows = await driver.all<{ feed_key: string; items_json: string; updated_at: number }>(
      `SELECT feed_key, items_json, updated_at FROM elv_feeds WHERE feed_key IN (${placeholders(unique.length)})`,
      unique,
    );
  }
  return rows.map((row) => {
    let items: ElvFeedItem[] = [];
    try {
      const parsed: unknown = JSON.parse(row.items_json);
      if (Array.isArray(parsed)) items = parsed as ElvFeedItem[];
    } catch {
      items = [];
    }
    return { feedKey: row.feed_key, items, updatedAt: row.updated_at };
  });
}
