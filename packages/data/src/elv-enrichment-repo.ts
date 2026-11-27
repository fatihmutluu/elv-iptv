import type { SqlDriver, SqlValue } from '@elv/domain';
import {
  getTitlesByImdbIds,
  listFeeds,
  listImdbGenreCounts,
  listMatchedMatchesForImdbIds,
  listMatchedTitlesByGenre,
  listMatchedTitlesByPerson,
  listTitlesByFranchise,
  listTopRatedMatchedTitles,
} from './elv-enrichment-discovery-queries';
import {
  ELV_ENRICHMENT_OPEN_PRAGMAS,
  ELV_ENRICHMENT_SCHEMA_SQL,
  ELV_ENRICHMENT_SCHEMA_VERSION,
  ELV_ENRICHMENT_TITLES_TMDB_INDEX_SQL,
} from './elv-enrichment-schema';
import { escapeLikePattern, searchMatchedItemKeysByAlias } from './elv-enrichment-search';
import {
  clampConfidence,
  type ElvEnrichmentStore,
  type ElvFeedItem,
  type ElvItemEnrichment,
  type ElvTitleRecord,
  mapMatchRow,
  mapQualityRow,
  mapTitleRow,
  mergeElvTitle,
  type OpenElvEnrichmentStoreOptions,
  parseStringArray,
  type RawMatchRow,
  type RawQualityRow,
  type RawTitleRow,
  titleToParams,
  toMediaType,
  type UpsertElvTitleInput,
  uniqueNonEmpty,
} from './elv-enrichment-types';
import { normalizeCatalogImdbId, normalizeCatalogTmdbId } from './writers';

export type {
  ElvCastMember,
  ElvEnrichmentStore,
  ElvFeedItem,
  ElvFeedRecord,
  ElvGenreSummary,
  ElvItemEnrichment,
  ElvMatchedPersonTitle,
  ElvMatchRecord,
  ElvMediaType,
  ElvPersonQuery,
  ElvPersonRole,
  ElvQualityMemoryRecord,
  ElvSourceFilterOptions,
  ElvTitleRecord,
  ListMatchedTitlesByGenreOptions,
  ListMatchedTitlesByPersonOptions,
  ListTopRatedMatchedTitlesOptions,
  OpenElvEnrichmentStoreOptions,
  SearchMatchedItemKeysByAliasOptions,
  UpsertElvMatchInput,
  UpsertElvTitleInput,
} from './elv-enrichment-types';

interface RawJoinedRow extends RawMatchRow {
  t_imdb_id: string | null;
  tmdb_id: string | null;
  t_media_type: string | null;
  original_title: string | null;
  english_title: string | null;
  localized_titles_json: string | null;
  year: number | null;
  rating: number | null;
  votes: number | null;
  runtime_min: number | null;
  genres_json: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  trailer_stream_url: string | null;
  trailer_youtube_id: string | null;
  director: string | null;
  cast_json: string | null;
  mlt_imdb_ids_json: string | null;
  franchise_key: string | null;
  franchise_name: string | null;
  franchise_order: number | null;
  synopses_json: string | null;
  detail_fetched_at: number | null;
  t_updated_at: number | null;
}

const IN_CHUNK_SIZE = 400;

const UPSERT_MATCH_AUTO_SQL = `INSERT INTO elv_item_matches (
    item_key, source_id, media_type, imdb_id, confidence, manual_lock, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(item_key) DO UPDATE SET
    source_id = excluded.source_id, media_type = excluded.media_type,
    imdb_id = excluded.imdb_id, confidence = excluded.confidence, updated_at = excluded.updated_at
  WHERE elv_item_matches.manual_lock = 0`;

const UPSERT_MATCH_FORCE_SQL = `INSERT INTO elv_item_matches (
    item_key, source_id, media_type, imdb_id, confidence, manual_lock, updated_at
  ) VALUES (?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(item_key) DO UPDATE SET
    source_id = excluded.source_id, media_type = excluded.media_type,
    imdb_id = excluded.imdb_id, confidence = excluded.confidence,
    manual_lock = 1, updated_at = excluded.updated_at`;

const UPSERT_TITLE_SQL = `INSERT INTO elv_titles (
    imdb_id, tmdb_id, media_type, original_title, english_title, localized_titles_json,
    year, rating, votes, runtime_min, genres_json, poster_url, backdrop_url,
    trailer_stream_url, trailer_youtube_id, director, cast_json, mlt_imdb_ids_json,
    franchise_key, franchise_name, franchise_order, synopses_json, detail_fetched_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(imdb_id) DO UPDATE SET
    tmdb_id = excluded.tmdb_id, media_type = excluded.media_type, original_title = excluded.original_title,
    english_title = excluded.english_title, localized_titles_json = excluded.localized_titles_json,
    year = excluded.year, rating = excluded.rating, votes = excluded.votes,
    runtime_min = excluded.runtime_min, genres_json = excluded.genres_json,
    poster_url = excluded.poster_url, backdrop_url = excluded.backdrop_url,
    trailer_stream_url = excluded.trailer_stream_url, trailer_youtube_id = excluded.trailer_youtube_id,
    director = excluded.director, cast_json = excluded.cast_json,
    mlt_imdb_ids_json = excluded.mlt_imdb_ids_json, franchise_key = excluded.franchise_key,
    franchise_name = excluded.franchise_name, franchise_order = excluded.franchise_order,
    synopses_json = excluded.synopses_json, detail_fetched_at = excluded.detail_fetched_at,
    updated_at = excluded.updated_at`;

const UPSERT_QUALITY_SQL = `INSERT INTO elv_quality_memory (
    item_key, actual_width, actual_height, actual_video_codec, actual_audio_codec,
    actual_audio_channels, actual_hdr, claimed_label, is_fake_4k, fail_count,
    last_success_at, last_fail_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_key) DO UPDATE SET
    actual_width = excluded.actual_width, actual_height = excluded.actual_height,
    actual_video_codec = excluded.actual_video_codec, actual_audio_codec = excluded.actual_audio_codec,
    actual_audio_channels = excluded.actual_audio_channels, actual_hdr = excluded.actual_hdr,
    claimed_label = excluded.claimed_label, is_fake_4k = excluded.is_fake_4k,
    fail_count = excluded.fail_count, last_success_at = excluded.last_success_at,
    last_fail_at = excluded.last_fail_at, updated_at = excluded.updated_at`;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function mapJoinedTitle(r: RawJoinedRow): ElvTitleRecord | null {
  if (r.t_imdb_id === null || r.original_title === null) return null;
  return mapTitleRow({
    imdb_id: r.t_imdb_id,
    tmdb_id: r.tmdb_id,
    media_type: r.t_media_type ?? r.media_type,
    original_title: r.original_title,
    english_title: r.english_title,
    localized_titles_json: r.localized_titles_json ?? '{}',
    year: r.year,
    rating: r.rating,
    votes: r.votes,
    runtime_min: r.runtime_min,
    genres_json: r.genres_json ?? '[]',
    poster_url: r.poster_url,
    backdrop_url: r.backdrop_url,
    trailer_stream_url: r.trailer_stream_url,
    trailer_youtube_id: r.trailer_youtube_id,
    director: r.director,
    cast_json: r.cast_json ?? '[]',
    mlt_imdb_ids_json: r.mlt_imdb_ids_json ?? '[]',
    franchise_key: r.franchise_key,
    franchise_name: r.franchise_name,
    franchise_order: r.franchise_order,
    synopses_json: r.synopses_json ?? '{}',
    detail_fetched_at: r.detail_fetched_at,
    updated_at: r.t_updated_at ?? r.updated_at,
  });
}

/**
 * Opens and initializes the isolated local `elv-enrichment.db` store on its own `SqlDriver` (`#511`).
 * Never mutates `catalog.db`; all DDL statements are idempotent.
 */
export async function openElvEnrichmentStore(
  driver: SqlDriver,
  opts: OpenElvEnrichmentStoreOptions = {},
): Promise<ElvEnrichmentStore> {
  const clock = opts.clock ?? Date.now;
  for (const pragma of ELV_ENRICHMENT_OPEN_PRAGMAS) {
    await driver.exec(pragma);
  }
  await driver.transaction(async (tx) => {
    await tx.exec(ELV_ENRICHMENT_SCHEMA_SQL);
    const titleCols = await tx.all<{ name: string }>('PRAGMA table_info(elv_titles)');
    if (!titleCols.some((c) => c.name === 'tmdb_id')) {
      await tx.exec('ALTER TABLE elv_titles ADD COLUMN tmdb_id TEXT');
    }
    await tx.exec(ELV_ENRICHMENT_TITLES_TMDB_INDEX_SQL);
    await tx.run(
      `INSERT INTO elv_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [ELV_ENRICHMENT_SCHEMA_VERSION],
    );
  });

  return {
    driver,

    async upsertMatches(matches) {
      if (matches.length === 0) return 0;
      const nowMs = clock();
      const autoRows: SqlValue[][] = [];
      const forcedRows: SqlValue[][] = [];
      for (const m of matches) {
        const imdbId = normalizeCatalogImdbId(m.imdbId);
        if (imdbId === null || m.itemKey.trim() === '' || m.sourceId.trim() === '') continue;
        const row: SqlValue[] = [
          m.itemKey,
          m.sourceId,
          m.mediaType,
          imdbId,
          clampConfidence(m.confidence),
          m.updatedAt ?? nowMs,
        ];
        if (m.forceManual === true) forcedRows.push(row);
        else autoRows.push(row);
      }
      if (autoRows.length === 0 && forcedRows.length === 0) return 0;
      return driver.transaction(async (tx) => {
        let total = 0;
        for (const row of autoRows) total += (await tx.run(UPSERT_MATCH_AUTO_SQL, row)).changes;
        for (const row of forcedRows) total += (await tx.run(UPSERT_MATCH_FORCE_SQL, row)).changes;
        return total;
      });
    },

    async setManualMatch(itemKey, sourceId, mediaType, imdbId, updatedAt) {
      const normalized = normalizeCatalogImdbId(imdbId);
      if (normalized === null) throw new Error(`Invalid IMDb ID: ${imdbId}`);
      await driver.run(UPSERT_MATCH_FORCE_SQL, [
        itemKey,
        sourceId,
        mediaType,
        normalized,
        1,
        updatedAt ?? clock(),
      ]);
    },

    async clearSourceMatches(sourceId) {
      const escaped = escapeLikePattern(sourceId);
      return driver.transaction(async (tx) => {
        await tx.run(
          `DELETE FROM elv_quality_memory
            WHERE item_key IN (SELECT item_key FROM elv_item_matches WHERE source_id = ?)
               OR item_key LIKE ? ESCAPE '\\'
               OR item_key LIKE ? ESCAPE '\\'
               OR item_key LIKE ? ESCAPE '\\'`,
          [sourceId, `x:${escaped}:%`, `m:${escaped}:%`, `s:${escaped}:%`],
        );
        return (await tx.run('DELETE FROM elv_item_matches WHERE source_id = ?', [sourceId]))
          .changes;
      });
    },

    async getMatchForKey(itemKey) {
      const rows = await driver.all<RawMatchRow>(
        'SELECT item_key, source_id, media_type, imdb_id, confidence, manual_lock, updated_at FROM elv_item_matches WHERE item_key = ? LIMIT 1',
        [itemKey],
      );
      const row = rows[0];
      return row === undefined ? null : mapMatchRow(row);
    },

    async listMatchedKeysForSet(itemKeys) {
      const unique = uniqueNonEmpty(itemKeys);
      const matched = new Set<string>();
      for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
        const rows = await driver.all<{ item_key: string }>(
          `SELECT item_key FROM elv_item_matches WHERE item_key IN (${placeholders(chunk.length)})`,
          chunk,
        );
        for (const r of rows) matched.add(r.item_key);
      }
      return matched;
    },

    async listMatchesByImdbId(imdbId, mediaType, minConfidence = 0) {
      const normalized = normalizeCatalogImdbId(imdbId);
      if (normalized === null) return [];
      const rows = await driver.all<RawMatchRow>(
        `SELECT item_key, source_id, media_type, imdb_id, confidence, manual_lock, updated_at
           FROM elv_item_matches
          WHERE imdb_id = ? AND media_type = ? AND (manual_lock = 1 OR confidence >= ?)
          ORDER BY manual_lock DESC, confidence DESC, item_key ASC`,
        [normalized, mediaType, minConfidence],
      );
      return rows.map(mapMatchRow);
    },

    async upsertTitles(titles) {
      if (titles.length === 0) return;
      const nowMs = clock();
      const valid: { imdbId: string; input: UpsertElvTitleInput }[] = [];
      for (const input of titles) {
        const imdbId = normalizeCatalogImdbId(input.imdbId);
        if (imdbId !== null) valid.push({ imdbId, input });
      }
      if (valid.length === 0) return;

      await driver.transaction(async (tx) => {
        const existingMap = new Map<string, ElvTitleRecord>();
        const uniqueIds = uniqueNonEmpty(valid.map((v) => v.imdbId));
        for (let i = 0; i < uniqueIds.length; i += IN_CHUNK_SIZE) {
          const chunk = uniqueIds.slice(i, i + IN_CHUNK_SIZE);
          const rows = await tx.all<RawTitleRow>(
            `SELECT * FROM elv_titles WHERE imdb_id IN (${placeholders(chunk.length)})`,
            chunk,
          );
          for (const r of rows) existingMap.set(r.imdb_id, mapTitleRow(r));
        }

        for (const { imdbId, input } of valid) {
          existingMap.set(imdbId, mergeElvTitle(existingMap.get(imdbId), input, imdbId, nowMs));
        }

        const params: SqlValue[][] = [];
        for (const imdbId of uniqueIds) {
          const merged = existingMap.get(imdbId);
          if (merged !== undefined) params.push(titleToParams(merged));
        }
        await tx.batch(UPSERT_TITLE_SQL, params);
      });
    },

    async getEnrichmentForKeys(itemKeys) {
      const out = new Map<string, ElvItemEnrichment>();
      const unique = uniqueNonEmpty(itemKeys);
      if (unique.length === 0) return out;
      for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
        const rows = await driver.all<RawJoinedRow>(
          `SELECT m.item_key, m.source_id, m.media_type, m.imdb_id, m.confidence, m.manual_lock, m.updated_at,
                  t.imdb_id AS t_imdb_id, t.tmdb_id, t.media_type AS t_media_type, t.original_title, t.english_title,
                  t.localized_titles_json, t.year, t.rating, t.votes, t.runtime_min, t.genres_json,
                  t.poster_url, t.backdrop_url, t.trailer_stream_url, t.trailer_youtube_id, t.director,
                  t.cast_json, t.mlt_imdb_ids_json, t.franchise_key, t.franchise_name, t.franchise_order,
                  t.synopses_json, t.detail_fetched_at, t.updated_at AS t_updated_at
             FROM elv_item_matches m
             LEFT JOIN elv_titles t ON t.imdb_id = m.imdb_id
            WHERE m.item_key IN (${placeholders(chunk.length)})`,
          chunk,
        );
        for (const r of rows) {
          out.set(r.item_key, {
            itemKey: r.item_key,
            sourceId: r.source_id,
            mediaType: toMediaType(r.media_type),
            imdbId: r.imdb_id,
            confidence: r.confidence,
            manualLock: r.manual_lock !== 0,
            title: mapJoinedTitle(r),
          });
        }
      }
      return out;
    },

    async getTitleByImdbId(imdbId) {
      const normalized = normalizeCatalogImdbId(imdbId);
      if (normalized === null) return null;
      const rows = await driver.all<RawTitleRow>(
        'SELECT * FROM elv_titles WHERE imdb_id = ? LIMIT 1',
        [normalized],
      );
      const row = rows[0];
      return row === undefined ? null : mapTitleRow(row);
    },

    getTitlesByImdbIds: (imdbIds) => getTitlesByImdbIds(driver, imdbIds),

    async getTitlesByTmdbIds(tmdbIds, mediaType) {
      const out = new Map<string, ElvTitleRecord>();
      const unique = uniqueNonEmpty(
        tmdbIds.map((id) => normalizeCatalogTmdbId(id)).filter((id): id is string => id !== null),
      );
      if (unique.length === 0) return out;
      const typeClause = mediaType === undefined ? '' : ' AND media_type = ?';
      for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
        const params: SqlValue[] = mediaType === undefined ? chunk : [...chunk, mediaType];
        const rows = await driver.all<RawTitleRow>(
          `SELECT * FROM elv_titles WHERE tmdb_id IN (${placeholders(chunk.length)})${typeClause} ORDER BY updated_at DESC`,
          params,
        );
        for (const r of rows) {
          const mapped = mapTitleRow(r);
          if (mapped.tmdbId !== null && mapped.tmdbId !== undefined && !out.has(mapped.tmdbId)) {
            out.set(mapped.tmdbId, mapped);
          }
        }
      }
      return out;
    },

    listImdbGenreCounts: (mediaType, filterOpts) =>
      listImdbGenreCounts(driver, mediaType, filterOpts),

    listMatchedTitlesByGenre: (mediaType, genre, genreOpts) =>
      listMatchedTitlesByGenre(driver, mediaType, genre, genreOpts),

    listTopRatedMatchedTitles: (topOpts) => listTopRatedMatchedTitles(driver, topOpts),

    listTitlesByFranchise: (franchiseKey, filterOpts) =>
      listTitlesByFranchise(driver, franchiseKey, filterOpts),

    listMatchedTitlesByPerson: (person, personOpts) =>
      listMatchedTitlesByPerson(driver, person, personOpts),

    listMatchedMatchesForImdbIds: (imdbIds, mediaType, filterOpts) =>
      listMatchedMatchesForImdbIds(driver, imdbIds, mediaType, filterOpts),

    listFeeds: (feedKeys) => listFeeds(driver, feedKeys),

    async listImdbGenres(mediaType, allowedItemKeys) {
      const counts = new Map<string, number>();
      const tally = (rows: readonly { genres_json: string }[]) => {
        for (const row of rows) {
          for (const genre of parseStringArray(row.genres_json)) {
            counts.set(genre, (counts.get(genre) ?? 0) + 1);
          }
        }
      };

      if (allowedItemKeys === undefined) {
        tally(
          await driver.all<{ genres_json: string }>(
            `SELECT t.genres_json FROM elv_item_matches m
               JOIN elv_titles t ON t.imdb_id = m.imdb_id WHERE m.media_type = ?`,
            [mediaType],
          ),
        );
      } else {
        const unique = uniqueNonEmpty(
          Array.isArray(allowedItemKeys) ? allowedItemKeys : [...allowedItemKeys],
        );
        if (unique.length === 0) return [];
        for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
          const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
          tally(
            await driver.all<{ genres_json: string }>(
              `SELECT t.genres_json FROM elv_item_matches m
                 JOIN elv_titles t ON t.imdb_id = m.imdb_id
                WHERE m.media_type = ? AND m.item_key IN (${placeholders(chunk.length)})`,
              [mediaType, ...chunk],
            ),
          );
        }
      }

      return [...counts.entries()]
        .map(([genre, itemCount]) => ({ genre, itemCount }))
        .sort((a, b) => b.itemCount - a.itemCount || a.genre.localeCompare(b.genre));
    },

    async listMatchedItemKeysForImdbIds(imdbIds, mediaType) {
      const out = new Map<string, string[]>();
      const unique = uniqueNonEmpty(
        imdbIds.map((id) => normalizeCatalogImdbId(id)).filter((id): id is string => id !== null),
      );
      if (unique.length === 0) return out;
      for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
        const typeClause = mediaType === undefined ? '' : ' AND media_type = ?';
        const params: SqlValue[] = mediaType === undefined ? chunk : [...chunk, mediaType];
        const rows = await driver.all<{ imdb_id: string; item_key: string }>(
          `SELECT imdb_id, item_key FROM elv_item_matches
            WHERE imdb_id IN (${placeholders(chunk.length)})${typeClause}
            ORDER BY manual_lock DESC, confidence DESC, item_key ASC`,
          params,
        );
        for (const r of rows) {
          const bucket = out.get(r.imdb_id);
          if (bucket === undefined) out.set(r.imdb_id, [r.item_key]);
          else bucket.push(r.item_key);
        }
      }
      return out;
    },

    searchMatchedItemKeysByAlias: (query, searchOpts) =>
      searchMatchedItemKeysByAlias(driver, query, searchOpts),

    async upsertFeed(feedKey, items, updatedAt) {
      const key = feedKey.trim();
      if (key === '') return;
      await driver.run(
        `INSERT INTO elv_feeds (feed_key, items_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(feed_key) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`,
        [key, JSON.stringify(items), updatedAt ?? clock()],
      );
    },

    async getFeed(feedKey) {
      const rows = await driver.all<{ feed_key: string; items_json: string; updated_at: number }>(
        'SELECT feed_key, items_json, updated_at FROM elv_feeds WHERE feed_key = ? LIMIT 1',
        [feedKey],
      );
      const row = rows[0];
      if (row === undefined) return null;
      let items: ElvFeedItem[] = [];
      try {
        const parsed: unknown = JSON.parse(row.items_json);
        if (Array.isArray(parsed)) items = parsed as ElvFeedItem[];
      } catch {
        items = [];
      }
      return { feedKey: row.feed_key, items, updatedAt: row.updated_at };
    },

    async getQualityMemory(itemKey) {
      const rows = await driver.all<RawQualityRow>(
        'SELECT * FROM elv_quality_memory WHERE item_key = ? LIMIT 1',
        [itemKey],
      );
      const row = rows[0];
      return row === undefined ? null : mapQualityRow(row);
    },

    async getQualityMemoryForKeys(itemKeys) {
      const out = new Map<string, ReturnType<typeof mapQualityRow>>();
      const unique = uniqueNonEmpty(itemKeys);
      if (unique.length === 0) return out;
      for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
        const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
        const rows = await driver.all<RawQualityRow>(
          `SELECT * FROM elv_quality_memory WHERE item_key IN (${placeholders(chunk.length)})`,
          chunk,
        );
        for (const r of rows) out.set(r.item_key, mapQualityRow(r));
      }
      return out;
    },

    async upsertQualityMemory(record) {
      await driver.run(UPSERT_QUALITY_SQL, [
        record.itemKey,
        record.actualWidth,
        record.actualHeight,
        record.actualVideoCodec,
        record.actualAudioCodec,
        record.actualAudioChannels,
        record.actualHdr,
        record.claimedLabel,
        record.isFake4k ? 1 : 0,
        record.failCount,
        record.lastSuccessAt,
        record.lastFailAt,
        record.updatedAt,
      ]);
    },

    async wipeAll() {
      await driver.transaction(async (tx) => {
        await tx.run('DELETE FROM elv_item_matches');
        await tx.run('DELETE FROM elv_titles');
        await tx.run('DELETE FROM elv_feeds');
        await tx.run('DELETE FROM elv_quality_memory');
      });
    },

    async close() {
      await driver.close?.();
    },
  };
}
