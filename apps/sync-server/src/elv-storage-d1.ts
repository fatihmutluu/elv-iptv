import type {
  ElvCastMember,
  ElvFeedCacheRecord,
  ElvFeedItem,
  ElvFeedKey,
  ElvLocalizedSynopsisRecord,
  ElvMatchIndexRecord,
  ElvMediaType,
  ElvMetadataStorage,
  ElvTitleRecord,
} from './elv-types.ts';
import type { D1Database } from './storage-d1-types.ts';

const MAX_IN_CLAUSE_SIZE = 50;
const MAX_LOCALIZED_IN_CLAUSE_SIZE = 49;
const MAX_TITLE_UPSERT_ROWS_PER_STMT = 2;
const MAX_MATCH_UPSERT_ROWS_PER_STMT = 8;

interface ElvTitleRow {
  readonly imdb_id: string;
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

interface ElvMatchRow {
  readonly lookup_key: string;
  readonly media_type: string;
  readonly year: number | null;
  readonly imdb_id: string;
  readonly confidence: number;
  readonly updated_at: number;
}

interface ElvLocalizedSynopsisRow {
  readonly imdb_id: string;
  readonly lang: string;
  readonly localized_title: string | null;
  readonly synopsis: string;
  readonly source: string;
  readonly updated_at: number;
}

interface ElvFeedRow {
  readonly feed_key: string;
  readonly items_json: string;
  readonly updated_at: number;
}

const TITLE_SELECT_COLUMNS = `imdb_id, media_type, original_title, english_title, year, rating, votes,
  runtime_min, genres_json, poster_url, backdrop_url, trailer_stream_url, trailer_youtube_id,
  director, cast_json, mlt_imdb_ids_json, franchise_key, franchise_name, franchise_order,
  original_synopsis, updated_at`;

function safeParseArray<T>(raw: string | null | undefined): T[] {
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

function mapTitleRow(row: ElvTitleRow): ElvTitleRecord {
  return {
    imdbId: row.imdb_id,
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

function mapMatchRow(row: ElvMatchRow): ElvMatchIndexRecord {
  return {
    lookupKey: row.lookup_key,
    mediaType: normalizeMediaType(row.media_type),
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    imdbId: row.imdb_id,
    confidence: Number(row.confidence),
    updatedAt: Number(row.updated_at),
  };
}

function mapLocalizedSynopsisRow(row: ElvLocalizedSynopsisRow): ElvLocalizedSynopsisRecord {
  return {
    imdbId: row.imdb_id,
    lang: row.lang,
    localizedTitle: row.localized_title ?? null,
    synopsis: row.synopsis,
    source: row.source,
    updatedAt: Number(row.updated_at),
  };
}

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const unique = [...new Set(items)];
  const chunks: T[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}

function sliceBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function executeChunkedSelect<TRow>(
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

function buildElvTitleUpsertStatement(db: D1Database, titles: readonly ElvTitleRecord[]) {
  const rowPlaceholders = titles
    .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .join(', ');
  const params: unknown[] = [];
  for (const title of titles) {
    params.push(
      title.imdbId,
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
        imdb_id, media_type, original_title, english_title, year, rating, votes,
        runtime_min, genres_json, poster_url, backdrop_url, trailer_stream_url,
        trailer_youtube_id, director, cast_json, mlt_imdb_ids_json,
        franchise_key, franchise_name, franchise_order, original_synopsis, updated_at
      ) VALUES ${rowPlaceholders}
      ON CONFLICT(imdb_id) DO UPDATE SET
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

function buildElvMatchUpsertStatement(db: D1Database, matches: readonly ElvMatchIndexRecord[]) {
  const rowPlaceholders = matches.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params: unknown[] = [];
  for (const entry of matches) {
    params.push(
      entry.lookupKey,
      entry.mediaType,
      entry.year,
      entry.imdbId,
      entry.confidence,
      entry.updatedAt,
    );
  }
  return db
    .prepare(
      `INSERT INTO elv_title_match_index (
        lookup_key, media_type, year, imdb_id, confidence, updated_at
      ) VALUES ${rowPlaceholders}
      ON CONFLICT(lookup_key) DO UPDATE SET
        media_type = excluded.media_type,
        year = excluded.year,
        imdb_id = excluded.imdb_id,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at`,
    )
    .bind(...params);
}

/** Creates the Cloudflare D1 persistence adapter for Wave E1 collective metadata tables (`0003`). */
export function createD1ElvStorage(db: D1Database): ElvMetadataStorage {
  return {
    async getElvTitle(imdbId: string): Promise<ElvTitleRecord | null> {
      const row = await db
        .prepare(`SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE imdb_id = ?`)
        .bind(imdbId)
        .first<ElvTitleRow>();
      return row ? mapTitleRow(row) : null;
    },

    async getElvTitlesByIds(imdbIds: readonly string[]): Promise<Map<string, ElvTitleRecord>> {
      const result = new Map<string, ElvTitleRecord>();
      const statements = chunkItems(imdbIds, MAX_IN_CLAUSE_SIZE).map((chunk) => {
        const placeholders = chunk.map(() => '?').join(', ');
        return db
          .prepare(
            `SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE imdb_id IN (${placeholders})`,
          )
          .bind(...chunk);
      });
      const rows = await executeChunkedSelect<ElvTitleRow>(db, statements);
      for (const row of rows) {
        result.set(row.imdb_id, mapTitleRow(row));
      }
      return result;
    },

    async upsertElvTitle(title: ElvTitleRecord): Promise<void> {
      await buildElvTitleUpsertStatement(db, [title]).run();
    },

    async upsertElvTitlesBatch(titles: readonly ElvTitleRecord[]): Promise<void> {
      if (titles.length === 0) return;
      const deduped = [...new Map(titles.map((t) => [t.imdbId, t])).values()];
      const statements = sliceBatches(deduped, MAX_TITLE_UPSERT_ROWS_PER_STMT).map((batch) =>
        buildElvTitleUpsertStatement(db, batch),
      );
      await db.batch(statements);
    },

    async getElvMatchesByKeys(
      lookupKeys: readonly string[],
    ): Promise<Map<string, ElvMatchIndexRecord>> {
      const result = new Map<string, ElvMatchIndexRecord>();
      const statements = chunkItems(lookupKeys, MAX_IN_CLAUSE_SIZE).map((chunk) => {
        const placeholders = chunk.map(() => '?').join(', ');
        return db
          .prepare(
            `SELECT lookup_key, media_type, year, imdb_id, confidence, updated_at
             FROM elv_title_match_index
             WHERE lookup_key IN (${placeholders})`,
          )
          .bind(...chunk);
      });
      const rows = await executeChunkedSelect<ElvMatchRow>(db, statements);
      for (const row of rows) {
        result.set(row.lookup_key, mapMatchRow(row));
      }
      return result;
    },

    async upsertElvMatches(matches: readonly ElvMatchIndexRecord[]): Promise<void> {
      if (matches.length === 0) return;
      const deduped = [...new Map(matches.map((m) => [m.lookupKey, m])).values()];
      const statements = sliceBatches(deduped, MAX_MATCH_UPSERT_ROWS_PER_STMT).map((batch) =>
        buildElvMatchUpsertStatement(db, batch),
      );
      await db.batch(statements);
    },

    async getElvLocalizedSynopsis(
      imdbId: string,
      lang: string,
    ): Promise<ElvLocalizedSynopsisRecord | null> {
      const row = await db
        .prepare(
          `SELECT imdb_id, lang, localized_title, synopsis, source, updated_at
           FROM elv_localized_synopses
           WHERE imdb_id = ? AND lang = ?`,
        )
        .bind(imdbId, lang)
        .first<ElvLocalizedSynopsisRow>();
      return row ? mapLocalizedSynopsisRow(row) : null;
    },

    async getElvLocalizedSynopsesByIds(
      imdbIds: readonly string[],
      lang: string,
    ): Promise<Map<string, ElvLocalizedSynopsisRecord>> {
      const result = new Map<string, ElvLocalizedSynopsisRecord>();
      const statements = chunkItems(imdbIds, MAX_LOCALIZED_IN_CLAUSE_SIZE).map((chunk) => {
        const placeholders = chunk.map(() => '?').join(', ');
        return db
          .prepare(
            `SELECT imdb_id, lang, localized_title, synopsis, source, updated_at
             FROM elv_localized_synopses
             WHERE lang = ? AND imdb_id IN (${placeholders})`,
          )
          .bind(lang, ...chunk);
      });
      const rows = await executeChunkedSelect<ElvLocalizedSynopsisRow>(db, statements);
      for (const row of rows) {
        result.set(row.imdb_id, mapLocalizedSynopsisRow(row));
      }
      return result;
    },

    async upsertElvLocalizedSynopsis(record: ElvLocalizedSynopsisRecord): Promise<void> {
      await db
        .prepare(
          `INSERT INTO elv_localized_synopses (
            imdb_id, lang, localized_title, synopsis, source, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(imdb_id, lang) DO UPDATE SET
            localized_title = COALESCE(excluded.localized_title, elv_localized_synopses.localized_title),
            synopsis = excluded.synopsis,
            source = excluded.source,
            updated_at = excluded.updated_at`,
        )
        .bind(
          record.imdbId,
          record.lang,
          record.localizedTitle,
          record.synopsis,
          record.source,
          record.updatedAt,
        )
        .run();
    },

    async getElvFeed(feedKey: ElvFeedKey): Promise<ElvFeedCacheRecord | null> {
      const row = await db
        .prepare('SELECT feed_key, items_json, updated_at FROM elv_feeds_cache WHERE feed_key = ?')
        .bind(feedKey)
        .first<ElvFeedRow>();
      if (!row) return null;
      return {
        feedKey,
        items: safeParseArray<ElvFeedItem>(row.items_json),
        updatedAt: Number(row.updated_at),
      };
    },

    async upsertElvFeed(
      feedKey: ElvFeedKey,
      items: readonly ElvFeedItem[],
      updatedAt: number,
    ): Promise<void> {
      await db
        .prepare(
          `INSERT INTO elv_feeds_cache (feed_key, items_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(feed_key) DO UPDATE SET
             items_json = excluded.items_json,
             updated_at = excluded.updated_at`,
        )
        .bind(feedKey, JSON.stringify(items), updatedAt)
        .run();
    },
  };
}
