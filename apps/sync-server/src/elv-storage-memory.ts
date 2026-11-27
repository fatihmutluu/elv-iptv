import type {
  ElvFeedCacheRecord,
  ElvFeedItem,
  ElvFeedKey,
  ElvLocalizedSynopsisRecord,
  ElvMatchIndexRecord,
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

/** Creates an in-memory `ElvMetadataStorage` matching Cloudflare D1 Wave E1 semantics. */
export function createMemoryElvStorage(): ElvMetadataStorage {
  const titlesByImdbId = new Map<string, ElvTitleRecord>();
  const matchesByLookupKey = new Map<string, ElvMatchIndexRecord>();
  const synopsesByKey = new Map<string, ElvLocalizedSynopsisRecord>();
  const feedsByKey = new Map<ElvFeedKey, ElvFeedCacheRecord>();

  return {
    async getElvTitle(imdbId: string): Promise<ElvTitleRecord | null> {
      return titlesByImdbId.get(imdbId) ?? null;
    },

    async getElvTitlesByIds(imdbIds: readonly string[]): Promise<Map<string, ElvTitleRecord>> {
      const result = new Map<string, ElvTitleRecord>();
      for (const imdbId of imdbIds) {
        const record = titlesByImdbId.get(imdbId);
        if (record) result.set(imdbId, record);
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
        matchesByLookupKey.set(entry.lookupKey, entry);
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
      synopsesByKey.set(key, {
        ...record,
        localizedTitle: record.localizedTitle ?? existing?.localizedTitle ?? null,
      });
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
