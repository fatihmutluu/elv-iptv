import {
  buildElvMatchUpsertStatement,
  buildElvTitleUpsertStatement,
  buildImdbRatingsUpsertStatement,
  chunkItems,
  type ElvLocalizedSynopsisRow,
  type ElvMatchRow,
  type ElvTitleRow,
  executeChunkedSelect,
  MAX_IN_CLAUSE_SIZE,
  MAX_LOCALIZED_IN_CLAUSE_SIZE,
  MAX_MATCH_UPSERT_ROWS_PER_STMT,
  MAX_RATING_UPSERT_ROWS_PER_STMT,
  MAX_TITLE_UPSERT_ROWS_PER_STMT,
  mapLocalizedSynopsisRow,
  mapMatchRow,
  mapTitleRow,
  safeParseArray,
  sliceBatches,
  TITLE_SELECT_COLUMNS,
} from './elv-storage-d1-queries.ts';
import type {
  ElvFeedCacheRecord,
  ElvFeedItem,
  ElvFeedKey,
  ElvImdbRatingRecord,
  ElvLocalizedSynopsisRecord,
  ElvMatchIndexRecord,
  ElvMediaType,
  ElvMetadataStorage,
  ElvTitleRecord,
} from './elv-types.ts';
import type { D1Database } from './storage-d1-types.ts';

interface ElvImdbRatingRow {
  readonly imdb_id: string;
  readonly rating: number;
  readonly votes: number;
  readonly updated_at: number;
}

interface ElvFeedRow {
  readonly feed_key: string;
  readonly items_json: string;
  readonly updated_at: number;
}

/** Creates the Cloudflare D1 persistence adapter for collective ELV metadata tables (`0003` + `0004`). */
export function createD1ElvStorage(db: D1Database): ElvMetadataStorage {
  return {
    async getElvTitle(imdbId: string): Promise<ElvTitleRecord | null> {
      const row = await db
        .prepare(`SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE imdb_id = ?`)
        .bind(imdbId)
        .first<ElvTitleRow>();
      return row ? mapTitleRow(row) : null;
    },

    async getElvTitleByTmdbId(
      tmdbId: string,
      mediaType?: ElvMediaType,
    ): Promise<ElvTitleRecord | null> {
      const row = mediaType
        ? await db
            .prepare(
              `SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE tmdb_id = ? AND media_type = ? LIMIT 1`,
            )
            .bind(tmdbId, mediaType)
            .first<ElvTitleRow>()
        : await db
            .prepare(
              `SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE tmdb_id = ? ORDER BY updated_at DESC LIMIT 1`,
            )
            .bind(tmdbId)
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
      for (const row of await executeChunkedSelect<ElvTitleRow>(db, statements)) {
        result.set(row.imdb_id, mapTitleRow(row));
      }
      return result;
    },

    async getElvTitlesByTmdbIds(
      tmdbIds: readonly string[],
      mediaType?: ElvMediaType,
    ): Promise<Map<string, ElvTitleRecord>> {
      const result = new Map<string, ElvTitleRecord>();
      const chunkSize = mediaType ? MAX_LOCALIZED_IN_CLAUSE_SIZE : MAX_IN_CLAUSE_SIZE;
      const statements = chunkItems(tmdbIds, chunkSize).map((chunk) => {
        const placeholders = chunk.map(() => '?').join(', ');
        if (mediaType) {
          return db
            .prepare(
              `SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE media_type = ? AND tmdb_id IN (${placeholders})`,
            )
            .bind(mediaType, ...chunk);
        }
        return db
          .prepare(
            `SELECT ${TITLE_SELECT_COLUMNS} FROM elv_title_cache WHERE tmdb_id IN (${placeholders})`,
          )
          .bind(...chunk);
      });
      for (const row of await executeChunkedSelect<ElvTitleRow>(db, statements)) {
        if (row.tmdb_id) result.set(row.tmdb_id, mapTitleRow(row));
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
            `SELECT lookup_key, media_type, year, imdb_id, tmdb_id, confidence, updated_at
             FROM elv_title_match_index
             WHERE lookup_key IN (${placeholders})`,
          )
          .bind(...chunk);
      });
      for (const row of await executeChunkedSelect<ElvMatchRow>(db, statements)) {
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
      for (const row of await executeChunkedSelect<ElvLocalizedSynopsisRow>(db, statements)) {
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
            synopsis = CASE WHEN length(excluded.synopsis) > 0 THEN excluded.synopsis ELSE elv_localized_synopses.synopsis END,
            source = CASE WHEN length(excluded.synopsis) > 0 THEN excluded.source ELSE elv_localized_synopses.source END,
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

    async upsertElvLocalizedSynopsesBatch(
      records: readonly ElvLocalizedSynopsisRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      const deduped = [...new Map(records.map((r) => [`${r.imdbId}:${r.lang}`, r])).values()];
      const statements = sliceBatches(deduped, MAX_MATCH_UPSERT_ROWS_PER_STMT).map((batch) => {
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const params: unknown[] = [];
        for (const r of batch) {
          params.push(r.imdbId, r.lang, r.localizedTitle, r.synopsis, r.source, r.updatedAt);
        }
        return db
          .prepare(
            `INSERT INTO elv_localized_synopses (
              imdb_id, lang, localized_title, synopsis, source, updated_at
            ) VALUES ${placeholders}
            ON CONFLICT(imdb_id, lang) DO UPDATE SET
              localized_title = COALESCE(excluded.localized_title, elv_localized_synopses.localized_title),
              synopsis = CASE WHEN length(excluded.synopsis) > 0 THEN excluded.synopsis ELSE elv_localized_synopses.synopsis END,
              source = CASE WHEN length(excluded.synopsis) > 0 THEN excluded.source ELSE elv_localized_synopses.source END,
              updated_at = excluded.updated_at`,
          )
          .bind(...params);
      });
      await db.batch(statements);
    },

    async getImdbRatingsByIds(
      imdbIds: readonly string[],
    ): Promise<Map<string, ElvImdbRatingRecord>> {
      const result = new Map<string, ElvImdbRatingRecord>();
      const statements = chunkItems(imdbIds, MAX_IN_CLAUSE_SIZE).map((chunk) => {
        const placeholders = chunk.map(() => '?').join(', ');
        return db
          .prepare(
            `SELECT imdb_id, rating, votes, updated_at
             FROM elv_imdb_ratings
             WHERE imdb_id IN (${placeholders})`,
          )
          .bind(...chunk);
      });
      for (const row of await executeChunkedSelect<ElvImdbRatingRow>(db, statements)) {
        result.set(row.imdb_id, {
          imdbId: row.imdb_id,
          rating: Number(row.rating),
          votes: Number(row.votes),
          updatedAt: Number(row.updated_at),
        });
      }
      return result;
    },

    async upsertImdbRatingsBatch(ratings: readonly ElvImdbRatingRecord[]): Promise<void> {
      if (ratings.length === 0) return;
      const deduped = [...new Map(ratings.map((r) => [r.imdbId, r])).values()];
      const statements = sliceBatches(deduped, MAX_RATING_UPSERT_ROWS_PER_STMT).map((batch) =>
        buildImdbRatingsUpsertStatement(db, batch),
      );
      await db.batch(statements);
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
