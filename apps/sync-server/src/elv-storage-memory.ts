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

function isStubTitleRecord(record: ElvTitleRecord): boolean {
  return (
    record.director === null &&
    record.originalSynopsis === null &&
    record.cast.length === 0 &&
    record.runtimeMin === null &&
    record.backdropUrl === null &&
    record.rating === null &&
    record.genres.length === 0
  );
}

function mergeTitleRecords(
  existing: ElvTitleRecord | undefined,
  incoming: ElvTitleRecord,
): ElvTitleRecord {
  if (!existing) return incoming;
  const originalTitle =
    incoming.originalTitle.length === 0 ||
    (existing.originalTitle.length > 0 && isStubTitleRecord(incoming))
      ? existing.originalTitle
      : incoming.originalTitle;
  return {
    imdbId: incoming.imdbId,
    tmdbId: incoming.tmdbId ?? existing.tmdbId,
    mediaType: incoming.mediaType,
    originalTitle,
    englishTitle: incoming.englishTitle ?? existing.englishTitle,
    year: incoming.year ?? existing.year,
    rating: incoming.rating ?? existing.rating,
    votes: incoming.votes ?? existing.votes,
    runtimeMin: incoming.runtimeMin ?? existing.runtimeMin,
    genres: incoming.genres.length > 0 ? incoming.genres : existing.genres,
    posterUrl: incoming.posterUrl ?? existing.posterUrl,
    backdropUrl: incoming.backdropUrl ?? existing.backdropUrl,
    trailerStreamUrl: incoming.trailerStreamUrl ?? existing.trailerStreamUrl,
    trailerYoutubeId: incoming.trailerYoutubeId ?? existing.trailerYoutubeId,
    director: incoming.director ?? existing.director,
    cast: incoming.cast.length > 0 ? incoming.cast : existing.cast,
    mltImdbIds: incoming.mltImdbIds.length > 0 ? incoming.mltImdbIds : existing.mltImdbIds,
    franchiseKey: incoming.franchiseKey ?? existing.franchiseKey,
    franchiseName: incoming.franchiseName ?? existing.franchiseName,
    franchiseOrder: incoming.franchiseOrder ?? existing.franchiseOrder,
    originalSynopsis: incoming.originalSynopsis ?? existing.originalSynopsis,
    updatedAt: incoming.updatedAt,
  };
}

/** Creates an in-memory `ElvMetadataStorage` matching Cloudflare D1 collective metadata semantics. */
export function createMemoryElvStorage(): ElvMetadataStorage {
  const titlesByImdbId = new Map<string, ElvTitleRecord>();
  const matchesByLookupKey = new Map<string, ElvMatchIndexRecord>();
  const synopsesByKey = new Map<string, ElvLocalizedSynopsisRecord>();
  const ratingsByImdbId = new Map<string, ElvImdbRatingRecord>();
  const feedsByKey = new Map<ElvFeedKey, ElvFeedCacheRecord>();

  return {
    async getElvTitle(imdbId: string): Promise<ElvTitleRecord | null> {
      return titlesByImdbId.get(imdbId) ?? null;
    },

    async getElvTitleByTmdbId(
      tmdbId: string,
      mediaType?: ElvMediaType,
    ): Promise<ElvTitleRecord | null> {
      let best: ElvTitleRecord | null = null;
      for (const record of titlesByImdbId.values()) {
        if (record.tmdbId !== tmdbId) continue;
        if (mediaType && record.mediaType !== mediaType) continue;
        if (!best || record.updatedAt > best.updatedAt) {
          best = record;
        }
      }
      return best;
    },

    async getElvTitlesByIds(imdbIds: readonly string[]): Promise<Map<string, ElvTitleRecord>> {
      const result = new Map<string, ElvTitleRecord>();
      for (const imdbId of imdbIds) {
        const record = titlesByImdbId.get(imdbId);
        if (record) result.set(imdbId, record);
      }
      return result;
    },

    async getElvTitlesByTmdbIds(
      tmdbIds: readonly string[],
      mediaType?: ElvMediaType,
    ): Promise<Map<string, ElvTitleRecord>> {
      const wanted = new Set(tmdbIds);
      const result = new Map<string, ElvTitleRecord>();
      for (const record of titlesByImdbId.values()) {
        if (!record.tmdbId || !wanted.has(record.tmdbId)) continue;
        if (mediaType && record.mediaType !== mediaType) continue;
        result.set(record.tmdbId, record);
      }
      return result;
    },

    async upsertElvTitle(title: ElvTitleRecord): Promise<void> {
      const merged = mergeTitleRecords(titlesByImdbId.get(title.imdbId), title);
      titlesByImdbId.set(title.imdbId, merged);
    },

    async upsertElvTitlesBatch(titles: readonly ElvTitleRecord[]): Promise<void> {
      for (const title of titles) {
        const merged = mergeTitleRecords(titlesByImdbId.get(title.imdbId), title);
        titlesByImdbId.set(title.imdbId, merged);
      }
    },

    async getElvMatchesByKeys(
      lookupKeys: readonly string[],
    ): Promise<Map<string, ElvMatchIndexRecord>> {
      const result = new Map<string, ElvMatchIndexRecord>();
      for (const key of lookupKeys) {
        const entry = matchesByLookupKey.get(key);
        if (entry) result.set(key, entry);
      }
      return result;
    },

    async upsertElvMatches(matches: readonly ElvMatchIndexRecord[]): Promise<void> {
      for (const entry of matches) {
        const existing = matchesByLookupKey.get(entry.lookupKey);
        matchesByLookupKey.set(entry.lookupKey, {
          ...entry,
          tmdbId: entry.tmdbId ?? existing?.tmdbId ?? null,
        });
      }
    },

    async getElvLocalizedSynopsis(
      imdbId: string,
      lang: string,
    ): Promise<ElvLocalizedSynopsisRecord | null> {
      return synopsesByKey.get(`${imdbId}:${lang}`) ?? null;
    },

    async getElvLocalizedSynopsesByIds(
      imdbIds: readonly string[],
      lang: string,
    ): Promise<Map<string, ElvLocalizedSynopsisRecord>> {
      const result = new Map<string, ElvLocalizedSynopsisRecord>();
      for (const imdbId of imdbIds) {
        const rec = synopsesByKey.get(`${imdbId}:${lang}`);
        if (rec) result.set(imdbId, rec);
      }
      return result;
    },

    async upsertElvLocalizedSynopsis(record: ElvLocalizedSynopsisRecord): Promise<void> {
      const key = `${record.imdbId}:${record.lang}`;
      const existing = synopsesByKey.get(key);
      const hasSynopsis = record.synopsis.length > 0;
      synopsesByKey.set(key, {
        imdbId: record.imdbId,
        lang: record.lang,
        localizedTitle: record.localizedTitle ?? existing?.localizedTitle ?? null,
        synopsis: hasSynopsis ? record.synopsis : (existing?.synopsis ?? ''),
        source: hasSynopsis ? record.source : (existing?.source ?? record.source),
        updatedAt: record.updatedAt,
      });
    },

    async upsertElvLocalizedSynopsesBatch(
      records: readonly ElvLocalizedSynopsisRecord[],
    ): Promise<void> {
      for (const record of records) {
        const key = `${record.imdbId}:${record.lang}`;
        const existing = synopsesByKey.get(key);
        const hasSynopsis = record.synopsis.length > 0;
        synopsesByKey.set(key, {
          imdbId: record.imdbId,
          lang: record.lang,
          localizedTitle: record.localizedTitle ?? existing?.localizedTitle ?? null,
          synopsis: hasSynopsis ? record.synopsis : (existing?.synopsis ?? ''),
          source: hasSynopsis ? record.source : (existing?.source ?? record.source),
          updatedAt: record.updatedAt,
        });
      }
    },

    async getImdbRatingsByIds(
      imdbIds: readonly string[],
    ): Promise<Map<string, ElvImdbRatingRecord>> {
      const result = new Map<string, ElvImdbRatingRecord>();
      for (const imdbId of imdbIds) {
        const row = ratingsByImdbId.get(imdbId);
        if (row) result.set(imdbId, row);
      }
      return result;
    },

    async upsertImdbRatingsBatch(ratings: readonly ElvImdbRatingRecord[]): Promise<void> {
      for (const row of ratings) {
        ratingsByImdbId.set(row.imdbId, row);
      }
    },

    async getElvFeed(feedKey: ElvFeedKey): Promise<ElvFeedCacheRecord | null> {
      return feedsByKey.get(feedKey) ?? null;
    },

    async upsertElvFeed(
      feedKey: ElvFeedKey,
      items: readonly ElvFeedItem[],
      updatedAt: number,
    ): Promise<void> {
      feedsByKey.set(feedKey, { feedKey, items: [...items], updatedAt });
    },
  };
}
