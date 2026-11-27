import type {
  ElvBatchMatchEntry,
  ElvFeedItem,
  ElvFeedsPayload,
  ElvImdbRatingRecord,
  ElvLocalizedSynopsisRecord,
  ElvMatchBatchItemInput,
  ElvSubrequestBudget,
  ElvTitleRecord,
  ElvTitleSummary,
  ImdbSuggestionCandidate,
} from './elv-types.ts';
import { isEnglishLang } from './elv-validation.ts';
import type { SyncServerStorage } from './storage.ts';

export function createSubrequestBudget(max: number): ElvSubrequestBudget {
  let left = Math.max(0, max);
  return {
    remaining: () => left,
    tryConsume(count = 1): boolean {
      if (left < count) return false;
      left -= count;
      return true;
    },
  };
}

export function isRichSummaryComplete(record: ElvTitleRecord): boolean {
  return (
    record.genres.length > 0 ||
    record.backdropUrl !== null ||
    record.rating !== null ||
    record.originalSynopsis !== null
  );
}

export function buildStubTitleFromSuggestion(
  candidate: ImdbSuggestionCandidate,
  nowMs: number,
): ElvTitleRecord {
  return {
    imdbId: candidate.imdbId,
    tmdbId: null,
    mediaType: candidate.mediaType === 'series' ? 'series' : 'movie',
    originalTitle: candidate.title,
    englishTitle: candidate.title,
    year: candidate.year,
    rating: null,
    votes: null,
    runtimeMin: null,
    genres: [],
    posterUrl: candidate.posterUrl,
    backdropUrl: null,
    trailerStreamUrl: null,
    trailerYoutubeId: null,
    director: null,
    cast: [],
    mltImdbIds: [],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    originalSynopsis: null,
    updatedAt: nowMs,
  };
}

function toTitleSummary(
  imdbId: string,
  fallbackItem: ElvMatchBatchItemInput,
  record: ElvTitleRecord | undefined,
  localizedTitle: string | null,
  imdbRating: ElvImdbRatingRecord | undefined,
): ElvTitleSummary {
  if (!record) {
    return {
      imdbId,
      tmdbId: fallbackItem.providerTmdbId ?? null,
      mediaType: fallbackItem.mediaType,
      originalTitle: fallbackItem.cleanTitle,
      englishTitle: fallbackItem.cleanTitle,
      localizedTitle,
      year: fallbackItem.year,
      rating: imdbRating?.rating ?? null,
      votes: imdbRating?.votes ?? null,
      runtimeMin: null,
      genres: [],
      posterUrl: null,
      backdropUrl: null,
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
    };
  }
  return {
    imdbId: record.imdbId,
    tmdbId: record.tmdbId,
    mediaType: record.mediaType,
    originalTitle: record.originalTitle,
    englishTitle: record.englishTitle,
    localizedTitle,
    year: record.year,
    rating: imdbRating ? imdbRating.rating : record.rating,
    votes: imdbRating ? imdbRating.votes : record.votes,
    runtimeMin: record.runtimeMin,
    genres: record.genres,
    posterUrl: record.posterUrl,
    backdropUrl: record.backdropUrl,
    franchiseKey: record.franchiseKey,
    franchiseName: record.franchiseName,
    franchiseOrder: record.franchiseOrder,
  };
}

export async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const idx = cursor;
      cursor += 1;
      const task = tasks[idx];
      if (task) await task();
    }
  }
  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export async function lookupCachedTitlesByProviderTmdb(
  storage: SyncServerStorage,
  items: readonly ElvMatchBatchItemInput[],
): Promise<Map<string, ElvTitleRecord>> {
  const movieIds: string[] = [];
  const seriesIds: string[] = [];
  for (const item of items) {
    if (item.providerImdbId || !item.providerTmdbId) continue;
    if (item.mediaType === 'series') seriesIds.push(item.providerTmdbId);
    else movieIds.push(item.providerTmdbId);
  }
  const [movieMap, seriesMap] = await Promise.all([
    movieIds.length > 0
      ? storage.getElvTitlesByTmdbIds(movieIds, 'movie')
      : Promise.resolve(new Map<string, ElvTitleRecord>()),
    seriesIds.length > 0
      ? storage.getElvTitlesByTmdbIds(seriesIds, 'series')
      : Promise.resolve(new Map<string, ElvTitleRecord>()),
  ]);
  const out = new Map<string, ElvTitleRecord>();
  for (const [id, rec] of movieMap) out.set(`movie:${id}`, rec);
  for (const [id, rec] of seriesMap) out.set(`series:${id}`, rec);
  return out;
}

export async function overlayFeedImdbRatings(
  storage: SyncServerStorage,
  feeds: ElvFeedsPayload,
): Promise<ElvFeedsPayload> {
  const allIds = [
    ...new Set([
      ...feeds.topPicks.map((i) => i.imdbId),
      ...feeds.movieMeter.map((i) => i.imdbId),
      ...feeds.tvMeter.map((i) => i.imdbId),
      ...feeds.currentUpcomingTv.map((i) => i.imdbId),
    ]),
  ];
  if (allIds.length === 0) return feeds;
  const ratings = await storage.getImdbRatingsByIds(allIds);
  if (ratings.size === 0) return feeds;
  const apply = (items: readonly ElvFeedItem[]): ElvFeedItem[] =>
    items.map((item) => {
      const hit = ratings.get(item.imdbId);
      return hit ? { ...item, rating: hit.rating } : item;
    });
  return {
    topPicks: apply(feeds.topPicks),
    movieMeter: apply(feeds.movieMeter),
    tvMeter: apply(feeds.tvMeter),
    currentUpcomingTv: apply(feeds.currentUpcomingTv),
  };
}

export async function assembleBatchMatchEntries(params: {
  readonly items: readonly ElvMatchBatchItemInput[];
  readonly lang: string;
  readonly storage: SyncServerStorage;
  readonly resolvedByKey: ReadonlyMap<
    string,
    { readonly imdbId: string; readonly confidence: number }
  >;
  readonly titlesById: ReadonlyMap<string, ElvTitleRecord>;
  readonly newLocalizedByImdbId: ReadonlyMap<string, ElvLocalizedSynopsisRecord>;
}): Promise<Record<string, ElvBatchMatchEntry>> {
  const { items, lang, storage, resolvedByKey, titlesById, newLocalizedByImdbId } = params;
  const finalImdbIds = [...new Set([...resolvedByKey.values()].map((r) => r.imdbId))];
  const [imdbRatingsById, localizedById] = await Promise.all([
    finalImdbIds.length > 0
      ? storage.getImdbRatingsByIds(finalImdbIds)
      : Promise.resolve(new Map<string, ElvImdbRatingRecord>()),
    isEnglishLang(lang) || finalImdbIds.length === 0
      ? Promise.resolve(new Map<string, ElvLocalizedSynopsisRecord>())
      : storage.getElvLocalizedSynopsesByIds(finalImdbIds, lang),
  ]);

  const matches: Record<string, ElvBatchMatchEntry> = {};
  for (const item of items) {
    const hit = resolvedByKey.get(item.key);
    if (!hit) continue;
    const record = titlesById.get(hit.imdbId);
    const localizedTitle =
      newLocalizedByImdbId.get(hit.imdbId)?.localizedTitle ??
      localizedById.get(hit.imdbId)?.localizedTitle ??
      null;
    matches[item.key] = {
      key: item.key,
      imdbId: hit.imdbId,
      confidence: hit.confidence,
      mediaType: record?.mediaType ?? item.mediaType,
      title: toTitleSummary(
        hit.imdbId,
        item,
        record,
        localizedTitle,
        imdbRatingsById.get(hit.imdbId),
      ),
    };
  }
  return matches;
}
