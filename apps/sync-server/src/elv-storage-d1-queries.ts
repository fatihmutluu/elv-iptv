import type {
  ElvCastMember,
  ElvImdbRatingRecord,
  ElvLocalizedSynopsisRecord,
  ElvMatchIndexRecord,
  ElvMediaType,
  ElvTitleRecord,
} from './elv-types.ts';
import type { D1Database } from './storage-d1-types.ts';

export const MAX_IN_CLAUSE_SIZE = 50;
export const MAX_LOCALIZED_IN_CLAUSE_SIZE = 49;
export const MAX_TITLE_UPSERT_ROWS_PER_STMT = 2; // 2 * 22 = 44 params <= 50
export const MAX_MATCH_UPSERT_ROWS_PER_STMT = 7; // 7 * 7 = 49 params <= 50
export const MAX_RATING_UPSERT_ROWS_PER_STMT = 12; // 12 * 4 = 48 params <= 50

export interface ElvTitleRow {
  readonly imdb_id: string;
  readonly tmdb_id: string | null;
  readonly media_type: string;
  readonly original_title: string;
  readonly english_title: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly votes: number | null;
  readonly runtime_min: number | null;
  readonly genres_json: string;
  readonly poster_url: string | null;
  readonly backdrop_url: string | null;
  readonly trailer_stream_url: string | null;
  readonly trailer_youtube_id: string | null;
  readonly director: string | null;
  readonly cast_json: string;
  readonly mlt_imdb_ids_json: string;
  readonly franchise_key: string | null;
  readonly franchise_name: string | null;
  readonly franchise_order: number | null;
  readonly original_synopsis: string | null;
  readonly updated_at: number;
}

export interface ElvMatchRow {
  readonly lookup_key: string;
  readonly media_type: string;
  readonly year: number | null;
  readonly imdb_id: string;
  readonly tmdb_id: string | null;
  readonly confidence: number;
  readonly updated_at: number;
}

export interface ElvLocalizedSynopsisRow {
  readonly imdb_id: string;
  readonly lang: string;
  readonly localized_title: string | null;
  readonly synopsis: string;
  readonly source: string;
  readonly updated_at: number;
}

export const TITLE_SELECT_COLUMNS = `imdb_id, tmdb_id, media_type, original_title, english_title, year, rating, votes,
  runtime_min, genres_json, poster_url, backdrop_url, trailer_stream_url, trailer_youtube_id,
  director, cast_json, mlt_imdb_ids_json, franchise_key, franchise_name, franchise_order,
  original_synopsis, updated_at`;

export function safeParseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function normalizeMediaType(raw: string): ElvMediaType {
  return raw === 'series' ? 'series' : 'movie';
}

export function mapTitleRow(row: ElvTitleRow): ElvTitleRecord {
  return {
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id ?? null,
    mediaType: normalizeMediaType(row.media_type),
    originalTitle: row.original_title,
    englishTitle: row.english_title ?? null,
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    votes: row.votes === null || row.votes === undefined ? null : Number(row.votes),
    runtimeMin:
      row.runtime_min === null || row.runtime_min === undefined ? null : Number(row.runtime_min),
    genres: safeParseArray<string>(row.genres_json),
    posterUrl: row.poster_url ?? null,
    backdropUrl: row.backdrop_url ?? null,
    trailerStreamUrl: row.trailer_stream_url ?? null,
    trailerYoutubeId: row.trailer_youtube_id ?? null,
    director: row.director ?? null,
    cast: safeParseArray<ElvCastMember>(row.cast_json),
    mltImdbIds: safeParseArray<string>(row.mlt_imdb_ids_json),
    franchiseKey: row.franchise_key ?? null,
    franchiseName: row.franchise_name ?? null,
    franchiseOrder:
      row.franchise_order === null || row.franchise_order === undefined
        ? null
        : Number(row.franchise_order),
    originalSynopsis: row.original_synopsis ?? null,
    updatedAt: Number(row.updated_at),
  };
}

export function mapMatchRow(row: ElvMatchRow): ElvMatchIndexRecord {
  return {
    lookupKey: row.lookup_key,
    mediaType: normalizeMediaType(row.media_type),
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id ?? null,
    confidence: Number(row.confidence),
    updatedAt: Number(row.updated_at),
  };
}

export function mapLocalizedSynopsisRow(row: ElvLocalizedSynopsisRow): ElvLocalizedSynopsisRecord {
  return {
    imdbId: row.imdb_id,
    lang: row.lang,
    localizedTitle: row.localized_title ?? null,
    synopsis: row.synopsis,
    source: row.source,
    updatedAt: Number(row.updated_at),
  };
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const unique = [...new Set(items)];
  const chunks: T[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}

export function sliceBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export async function executeChunkedSelect<TRow>(
  db: D1Database,
  statements: readonly ReturnType<D1Database['prepare']>[],
): Promise<TRow[]> {
  if (statements.length === 0) return [];
  if (statements.length === 1) {
    const first = statements[0];
    if (!first) return [];
    const res = await first.all<TRow>();
    return [...(res.results ?? [])];
  }
  const batchResults = await db.batch<TRow>(statements);
  const rows: TRow[] = [];
  for (const res of batchResults) {
    for (const row of res.results ?? []) {
      rows.push(row);
    }
  }
  return rows;
}

export function buildElvTitleUpsertStatement(db: D1Database, titles: readonly ElvTitleRecord[]) {
  const rowPlaceholders = titles
    .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .join(', ');
  const params: unknown[] = [];
  for (const title of titles) {
    params.push(
      title.imdbId,
      title.tmdbId,
      title.mediaType,
      title.originalTitle,
      title.englishTitle,
      title.year,
      title.rating,
      title.votes,
      title.runtimeMin,
      JSON.stringify(title.genres),
      title.posterUrl,
      title.backdropUrl,
      title.trailerStreamUrl,
      title.trailerYoutubeId,
      title.director,
      JSON.stringify(title.cast),
      JSON.stringify(title.mltImdbIds),
      title.franchiseKey,
      title.franchiseName,
      title.franchiseOrder,
      title.originalSynopsis,
      title.updatedAt,
    );
  }
  return db
    .prepare(
      `INSERT INTO elv_title_cache (
        imdb_id, tmdb_id, media_type, original_title, english_title, year, rating, votes,
        runtime_min, genres_json, poster_url, backdrop_url, trailer_stream_url,
        trailer_youtube_id, director, cast_json, mlt_imdb_ids_json,
        franchise_key, franchise_name, franchise_order, original_synopsis, updated_at
      ) VALUES ${rowPlaceholders}
      ON CONFLICT(imdb_id) DO UPDATE SET
        tmdb_id = COALESCE(excluded.tmdb_id, elv_title_cache.tmdb_id),
        media_type = excluded.media_type,
        original_title = CASE
          WHEN length(excluded.original_title) = 0 THEN elv_title_cache.original_title
          WHEN length(elv_title_cache.original_title) > 0
            AND excluded.director IS NULL
            AND excluded.original_synopsis IS NULL
            AND excluded.cast_json = '[]'
            AND excluded.runtime_min IS NULL
            AND excluded.backdrop_url IS NULL
            AND excluded.rating IS NULL
            AND excluded.genres_json = '[]'
            THEN elv_title_cache.original_title
          ELSE excluded.original_title
        END,
        english_title = COALESCE(excluded.english_title, elv_title_cache.english_title),
        year = COALESCE(excluded.year, elv_title_cache.year),
        rating = COALESCE(excluded.rating, elv_title_cache.rating),
        votes = COALESCE(excluded.votes, elv_title_cache.votes),
        runtime_min = COALESCE(excluded.runtime_min, elv_title_cache.runtime_min),
        genres_json = CASE WHEN excluded.genres_json != '[]' THEN excluded.genres_json ELSE elv_title_cache.genres_json END,
        poster_url = COALESCE(excluded.poster_url, elv_title_cache.poster_url),
        backdrop_url = COALESCE(excluded.backdrop_url, elv_title_cache.backdrop_url),
        trailer_stream_url = COALESCE(excluded.trailer_stream_url, elv_title_cache.trailer_stream_url),
        trailer_youtube_id = COALESCE(excluded.trailer_youtube_id, elv_title_cache.trailer_youtube_id),
        director = COALESCE(excluded.director, elv_title_cache.director),
        cast_json = CASE WHEN excluded.cast_json != '[]' THEN excluded.cast_json ELSE elv_title_cache.cast_json END,
        mlt_imdb_ids_json = CASE WHEN excluded.mlt_imdb_ids_json != '[]' THEN excluded.mlt_imdb_ids_json ELSE elv_title_cache.mlt_imdb_ids_json END,
        franchise_key = COALESCE(excluded.franchise_key, elv_title_cache.franchise_key),
        franchise_name = COALESCE(excluded.franchise_name, elv_title_cache.franchise_name),
        franchise_order = COALESCE(excluded.franchise_order, elv_title_cache.franchise_order),
        original_synopsis = COALESCE(excluded.original_synopsis, elv_title_cache.original_synopsis),
        updated_at = excluded.updated_at`,
    )
    .bind(...params);
}

export function buildElvMatchUpsertStatement(
  db: D1Database,
  matches: readonly ElvMatchIndexRecord[],
) {
  const rowPlaceholders = matches.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
  const params: unknown[] = [];
  for (const entry of matches) {
    params.push(
      entry.lookupKey,
      entry.mediaType,
      entry.year,
      entry.imdbId,
      entry.tmdbId,
      entry.confidence,
      entry.updatedAt,
    );
  }
  return db
    .prepare(
      `INSERT INTO elv_title_match_index (
        lookup_key, media_type, year, imdb_id, tmdb_id, confidence, updated_at
      ) VALUES ${rowPlaceholders}
      ON CONFLICT(lookup_key) DO UPDATE SET
        media_type = excluded.media_type,
        year = excluded.year,
        imdb_id = excluded.imdb_id,
        tmdb_id = COALESCE(excluded.tmdb_id, elv_title_match_index.tmdb_id),
        confidence = excluded.confidence,
        updated_at = excluded.updated_at`,
    )
    .bind(...params);
}

export function buildImdbRatingsUpsertStatement(
  db: D1Database,
  ratings: readonly ElvImdbRatingRecord[],
) {
  const rowPlaceholders = ratings.map(() => '(?, ?, ?, ?)').join(', ');
  const params: unknown[] = [];
  for (const entry of ratings) {
    params.push(entry.imdbId, entry.rating, entry.votes, entry.updatedAt);
  }
  return db
    .prepare(
      `INSERT INTO elv_imdb_ratings (imdb_id, rating, votes, updated_at)
       VALUES ${rowPlaceholders}
       ON CONFLICT(imdb_id) DO UPDATE SET
         rating = excluded.rating,
         votes = excluded.votes,
         updated_at = excluded.updated_at`,
    )
    .bind(...params);
}
