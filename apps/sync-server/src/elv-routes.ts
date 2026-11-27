import { isEnglishLang, translateSynopsisWithWorkersAi } from './elv-ai-translate.ts';
import { createImdbUpstreamClient, selectBestImdbMatch } from './elv-imdb-client.ts';
import type {
  ElvBatchMatchEntry,
  ElvFeedItem,
  ElvFeedKey,
  ElvMatchBatchItemInput,
  ElvMatchIndexRecord,
  ElvTitleRecord,
  ElvTitleSummary,
  ElvUpstreamClient,
  ImdbSuggestionCandidate,
  WorkersAiBinding,
} from './elv-types.ts';
import {
  buildMatchLookupKey,
  validateElvLang,
  validateElvMatchBatchInput,
  validateElvSearchParams,
  validateImdbId,
} from './elv-validation.ts';
import type { RateLimitConfig } from './rate-limit.ts';
import type { SyncServerStorage } from './storage.ts';
import { BODY_LIMITS, readBoundedJson } from './validation.ts';

const TITLE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FEEDS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_UPSTREAM_LOOKUPS_PER_BATCH = 25;
const BATCH_UPSTREAM_CONCURRENCY = 5;
const MAX_SEARCH_RESULTS = 12;

const CACHE_CONTROL_TITLE = 'public, max-age=86400';
const CACHE_CONTROL_TITLE_FALLBACK = 'public, max-age=300';
const CACHE_CONTROL_FEEDS = 'public, max-age=3600, stale-while-revalidate=86400';
const CACHE_CONTROL_SEARCH = 'public, max-age=300';
const CACHE_CONTROL_MATCH_BATCH = 'private, max-age=60';

/** Dependencies injected by `createSyncApp` into Wave E1 `/v1/elv/*` route handlers. */
export interface ElvRoutesContext {
  readonly storage: SyncServerStorage;
  readonly nowMs: () => number;
  readonly ai?: WorkersAiBinding | undefined;
  readonly upstream?: ElvUpstreamClient | undefined;
  readonly tmdbApiKey?: string | undefined;
  readonly checkRateLimit: (
    request: Request,
    bucket: keyof RateLimitConfig,
    directClientIp?: string,
  ) => Response | null;
  readonly jsonResponse: (
    status: number,
    body: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ) => Response;
}

/** Route handlers for `/v1/elv/{match-batch,title/:imdbId,feeds,search}`. */
export interface ElvRouteHandlers {
  handleElvMatchBatch(request: Request, clientIp?: string): Promise<Response>;
  handleElvTitleDetail(
    request: Request,
    imdbId: string,
    url: URL,
    clientIp?: string,
  ): Promise<Response>;
  handleElvFeeds(request: Request, clientIp?: string): Promise<Response>;
  handleElvSearch(request: Request, url: URL, clientIp?: string): Promise<Response>;
}

function isDetailComplete(record: ElvTitleRecord): boolean {
  return (
    record.originalSynopsis !== null ||
    record.cast.length > 0 ||
    record.runtimeMin !== null ||
    record.director !== null ||
    record.backdropUrl !== null
  );
}

function toTitleSummary(
  imdbId: string,
  fallbackItem: ElvMatchBatchItemInput,
  record: ElvTitleRecord | undefined,
  localizedTitle: string | null,
): ElvTitleSummary {
  if (!record) {
    return {
      imdbId,
      mediaType: fallbackItem.mediaType,
      originalTitle: fallbackItem.cleanTitle,
      englishTitle: fallbackItem.cleanTitle,
      localizedTitle,
      year: fallbackItem.year,
      rating: null,
      votes: null,
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
    mediaType: record.mediaType,
    originalTitle: record.originalTitle,
    englishTitle: record.englishTitle,
    localizedTitle,
    year: record.year,
    rating: record.rating,
    votes: record.votes,
    runtimeMin: record.runtimeMin,
    genres: record.genres,
    posterUrl: record.posterUrl,
    backdropUrl: record.backdropUrl,
    franchiseKey: record.franchiseKey,
    franchiseName: record.franchiseName,
    franchiseOrder: record.franchiseOrder,
  };
}

function buildStubTitleFromSuggestion(
  candidate: ImdbSuggestionCandidate,
  nowMs: number,
): ElvTitleRecord {
  return {
    imdbId: candidate.imdbId,
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

async function runWithConcurrency<T>(
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

/** Creates handlers for Wave E1 IMDb-first metadata enrichment endpoints (`/v1/elv/*`). */
export function createElvRouteHandlers(ctx: ElvRoutesContext): ElvRouteHandlers {
  const { storage, nowMs, ai, checkRateLimit, jsonResponse } = ctx;
  const hasTmdbApiKey = Boolean(ctx.tmdbApiKey && ctx.tmdbApiKey.trim().length > 0);
  const upstream: ElvUpstreamClient =
    ctx.upstream ??
    createImdbUpstreamClient({
      ...(hasTmdbApiKey && ctx.tmdbApiKey ? { tmdbApiKey: ctx.tmdbApiKey } : {}),
      now: nowMs,
    });

  return {
    async handleElvMatchBatch(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'elvMatch', clientIp);
      if (limited) return limited;

      const parsed = await readBoundedJson(request, BODY_LIMITS.elvMatch);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      const valid = validateElvMatchBatchInput(parsed.value);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const { items, lang } = valid.value;
      const currentMs = nowMs();

      // Step 1: Compute canonical lookup keys (null when folded title is empty)
      const lookupKeysByItemKey = new Map<string, string | null>();
      const keysToLookupInCache: string[] = [];
      for (const item of items) {
        const lookupKey = buildMatchLookupKey(item.cleanTitle, item.mediaType, item.year);
        lookupKeysByItemKey.set(item.key, lookupKey);
        if (!item.providerImdbId && lookupKey !== null) {
          keysToLookupInCache.push(lookupKey);
        }
      }

      // Step 2: Collective D1 match cache lookup (0 upstream calls for cached titles; skip empty folds)
      const cachedMatches =
        keysToLookupInCache.length > 0
          ? await storage.getElvMatchesByKeys(keysToLookupInCache)
          : new Map<string, ElvMatchIndexRecord>();

      // Step 3: Resolve immediate hits (providerImdbId or collective D1 cache) and group misses
      const resolvedByKey = new Map<
        string,
        { readonly imdbId: string; readonly confidence: number }
      >();
      const unresolvedGroups = new Map<
        string,
        { readonly persistLookupKey: string | null; readonly items: ElvMatchBatchItemInput[] }
      >();
      const unmatchedKeys: string[] = [];

      for (const item of items) {
        if (item.providerImdbId) {
          resolvedByKey.set(item.key, { imdbId: item.providerImdbId, confidence: 1 });
          continue;
        }
        const lookupKey = lookupKeysByItemKey.get(item.key) ?? null;
        const cached = lookupKey !== null ? cachedMatches.get(lookupKey) : undefined;
        if (cached) {
          resolvedByKey.set(item.key, { imdbId: cached.imdbId, confidence: cached.confidence });
          continue;
        }
        if (lookupKey === null && !(hasTmdbApiKey && item.providerTmdbId)) {
          unmatchedKeys.push(item.key);
          continue;
        }
        const groupKey =
          lookupKey ?? `__tmdb__:${item.mediaType}:${item.providerTmdbId ?? item.key}`;
        const existingGroup = unresolvedGroups.get(groupKey);
        if (existingGroup) {
          existingGroup.items.push(item);
        } else {
          unresolvedGroups.set(groupKey, { persistLookupKey: lookupKey, items: [item] });
        }
      }

      // Step 4: Bounded upstream lookups (strictly <= 25 subrequests total, concurrency = 5)
      const unresolvedEntries = [...unresolvedGroups.values()];
      const activeEntries = unresolvedEntries.slice(0, MAX_UPSTREAM_LOOKUPS_PER_BATCH);
      const overflowEntries = unresolvedEntries.slice(MAX_UPSTREAM_LOOKUPS_PER_BATCH);

      const pendingKeys: string[] = [];
      for (const entry of overflowEntries) {
        for (const item of entry.items) pendingKeys.push(item.key);
      }

      const newMatchRecords: ElvMatchIndexRecord[] = [];
      const newTitleStubsById = new Map<string, ElvTitleRecord>();
      let remainingSubrequests = MAX_UPSTREAM_LOOKUPS_PER_BATCH;

      const lookupTasks = activeEntries.map(({ persistLookupKey, items: group }) => async () => {
        const representative = group[0];
        if (!representative) return;

        let matchedImdbId: string | null = null;
        let matchedConfidence = 0;
        let matchedCandidate: ImdbSuggestionCandidate | null = null;

        if (hasTmdbApiKey && representative.providerTmdbId && remainingSubrequests > 0) {
          remainingSubrequests -= 1;
          const resolvedImdb = await upstream.resolveTmdbToImdb(
            representative.providerTmdbId,
            representative.mediaType,
          );
          if (resolvedImdb) {
            matchedImdbId = resolvedImdb;
            matchedConfidence = 0.98;
          }
        }

        if (!matchedImdbId && persistLookupKey !== null) {
          if (remainingSubrequests > 0) {
            remainingSubrequests -= 1;
            const candidates = await upstream.searchSuggestions(representative.cleanTitle);
            const best = selectBestImdbMatch(
              {
                cleanTitle: representative.cleanTitle,
                year: representative.year,
                mediaType: representative.mediaType,
              },
              candidates,
            );
            if (best) {
              matchedImdbId = best.candidate.imdbId;
              matchedConfidence = best.confidence;
              matchedCandidate = best.candidate;
            }
          } else {
            for (const item of group) pendingKeys.push(item.key);
            return;
          }
        }

        if (!matchedImdbId) {
          for (const item of group) unmatchedKeys.push(item.key);
          return;
        }

        if (persistLookupKey !== null) {
          newMatchRecords.push({
            lookupKey: persistLookupKey,
            mediaType: representative.mediaType,
            year: representative.year,
            imdbId: matchedImdbId,
            confidence: matchedConfidence,
            updatedAt: currentMs,
          });
        }
        if (matchedCandidate && !newTitleStubsById.has(matchedImdbId)) {
          newTitleStubsById.set(
            matchedImdbId,
            buildStubTitleFromSuggestion(matchedCandidate, currentMs),
          );
        }
        for (const item of group) {
          resolvedByKey.set(item.key, { imdbId: matchedImdbId, confidence: matchedConfidence });
        }
      });

      await runWithConcurrency(lookupTasks, BATCH_UPSTREAM_CONCURRENCY);

      // Step 5: Hydrate elv_title_cache and fetch missing IMDb summaries for provider/cache hits within remaining budget
      const orderedImdbIds: string[] = [];
      const seenImdbIds = new Set<string>();
      for (const item of items) {
        const hit = resolvedByKey.get(item.key);
        if (hit && !seenImdbIds.has(hit.imdbId)) {
          seenImdbIds.add(hit.imdbId);
          orderedImdbIds.push(hit.imdbId);
        }
      }

      const titlesById =
        orderedImdbIds.length > 0
          ? await storage.getElvTitlesByIds(orderedImdbIds)
          : new Map<string, ElvTitleRecord>();
      for (const [imdbId, stub] of newTitleStubsById) {
        if (!titlesById.has(imdbId)) {
          titlesById.set(imdbId, stub);
        }
      }

      const missingImdbIds = orderedImdbIds.filter((imdbId) => !titlesById.has(imdbId));
      const deferredMissingImdbIds = new Set<string>();
      if (missingImdbIds.length > 0) {
        const hydrationTasks = missingImdbIds.map((imdbId) => async () => {
          if (remainingSubrequests <= 0) {
            deferredMissingImdbIds.add(imdbId);
            return;
          }
          remainingSubrequests -= 1;
          const suggestions = await upstream.searchSuggestions(imdbId);
          const exact = suggestions.find((c) => c.imdbId === imdbId);
          let hydrated: ElvTitleRecord | null = exact
            ? buildStubTitleFromSuggestion(exact, currentMs)
            : null;
          if (!hydrated && remainingSubrequests > 0) {
            remainingSubrequests -= 1;
            hydrated = await upstream.fetchTitleDetail(imdbId);
          }
          if (hydrated) {
            newTitleStubsById.set(imdbId, hydrated);
            titlesById.set(imdbId, hydrated);
          }
        });
        await runWithConcurrency(hydrationTasks, BATCH_UPSTREAM_CONCURRENCY);
      }

      if (deferredMissingImdbIds.size > 0) {
        for (const item of items) {
          const hit = resolvedByKey.get(item.key);
          if (hit && deferredMissingImdbIds.has(hit.imdbId)) {
            resolvedByKey.delete(item.key);
            pendingKeys.push(item.key);
          }
        }
      }

      // Step 6: Batch-persist newly discovered matches & title summaries to collective D1 cache
      if (newMatchRecords.length > 0) {
        await storage.upsertElvMatches(newMatchRecords);
      }
      if (newTitleStubsById.size > 0) {
        await storage.upsertElvTitlesBatch([...newTitleStubsById.values()]);
      }

      // Step 7: Batch-hydrate localized titles and assemble final match response
      const finalImdbIds = [...new Set([...resolvedByKey.values()].map((r) => r.imdbId))];
      const localizedById =
        isEnglishLang(lang) || finalImdbIds.length === 0
          ? new Map()
          : await storage.getElvLocalizedSynopsesByIds(finalImdbIds, lang);

      const matches: Record<string, ElvBatchMatchEntry> = {};
      for (const item of items) {
        const hit = resolvedByKey.get(item.key);
        if (!hit) continue;
        const record = titlesById.get(hit.imdbId);
        const localizedTitle = localizedById.get(hit.imdbId)?.localizedTitle ?? null;
        matches[item.key] = {
          key: item.key,
          imdbId: hit.imdbId,
          confidence: hit.confidence,
          mediaType: record?.mediaType ?? item.mediaType,
          title: toTitleSummary(hit.imdbId, item, record, localizedTitle),
        };
      }

      return jsonResponse(
        200,
        { matches, unmatchedKeys, pendingKeys },
        { 'Cache-Control': CACHE_CONTROL_MATCH_BATCH },
      );
    },

    async handleElvTitleDetail(
      request: Request,
      imdbId: string,
      url: URL,
      clientIp?: string,
    ): Promise<Response> {
      const limited = checkRateLimit(request, 'elvDetail', clientIp);
      if (limited) return limited;

      const validId = validateImdbId(imdbId);
      if (!validId.ok) return jsonResponse(400, { error: validId.error });
      const validLang = validateElvLang(url.searchParams.get('lang'));
      if (!validLang.ok) return jsonResponse(400, { error: validLang.error });

      const cleanId = validId.value;
      const lang = validLang.value;
      const currentMs = nowMs();

      let title = await storage.getElvTitle(cleanId);
      const needsFetch =
        !title || !isDetailComplete(title) || currentMs - title.updatedAt >= TITLE_CACHE_TTL_MS;

      if (needsFetch) {
        const fetched = await upstream.fetchTitleDetail(cleanId);
        if (fetched) {
          await storage.upsertElvTitle(fetched);
          title = (await storage.getElvTitle(cleanId)) ?? fetched;
        }
      }

      if (!title) {
        return jsonResponse(404, { error: 'title_not_found' });
      }

      let synopsis: string | null = title.originalSynopsis;
      let localizedTitle: string | null = null;
      let synopsisSource: string = 'original';

      if (!isEnglishLang(lang)) {
        const cachedLocalized = await storage.getElvLocalizedSynopsis(cleanId, lang);
        if (cachedLocalized) {
          synopsis = cachedLocalized.synopsis;
          localizedTitle = cachedLocalized.localizedTitle;
          synopsisSource = cachedLocalized.source;
        } else if (title.originalSynopsis && title.originalSynopsis.trim().length > 0) {
          const translated = await translateSynopsisWithWorkersAi({
            ai,
            title: title.englishTitle ?? title.originalTitle,
            originalSynopsis: title.originalSynopsis,
            targetLang: lang,
          });
          synopsis = translated.synopsis;
          synopsisSource = translated.source;
          if (translated.translated) {
            await storage.upsertElvLocalizedSynopsis({
              imdbId: cleanId,
              lang,
              localizedTitle: null,
              synopsis: translated.synopsis,
              source: 'workers_ai',
              updatedAt: currentMs,
            });
          }
        }
      }

      const cacheControl =
        synopsisSource === 'fallback_en' || !isDetailComplete(title)
          ? CACHE_CONTROL_TITLE_FALLBACK
          : CACHE_CONTROL_TITLE;

      return jsonResponse(
        200,
        {
          imdbId: title.imdbId,
          mediaType: title.mediaType,
          originalTitle: title.originalTitle,
          englishTitle: title.englishTitle,
          localizedTitle,
          year: title.year,
          rating: title.rating,
          votes: title.votes,
          runtimeMin: title.runtimeMin,
          genres: title.genres,
          posterUrl: title.posterUrl,
          backdropUrl: title.backdropUrl,
          trailerStreamUrl: title.trailerStreamUrl,
          trailerYoutubeId: title.trailerYoutubeId,
          director: title.director,
          cast: title.cast,
          mltImdbIds: title.mltImdbIds,
          franchiseKey: title.franchiseKey,
          franchiseName: title.franchiseName,
          franchiseOrder: title.franchiseOrder,
          synopsis,
          synopsisLang: lang,
          synopsisSource,
          updatedAt: title.updatedAt,
        },
        { 'Cache-Control': cacheControl },
      );
    },

    async handleElvFeeds(request: Request, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'elvFeeds', clientIp);
      if (limited) return limited;

      const currentMs = nowMs();
      const [cachedTopPicks, cachedMovieMeter, cachedTvMeter, cachedUpcomingTv] = await Promise.all(
        [
          storage.getElvFeed('top_picks'),
          storage.getElvFeed('moviemeter'),
          storage.getElvFeed('tvmeter'),
          storage.getElvFeed('current_upcoming_tv'),
        ],
      );

      const allFresh =
        cachedTopPicks !== null &&
        cachedMovieMeter !== null &&
        cachedTvMeter !== null &&
        cachedUpcomingTv !== null &&
        currentMs - cachedTopPicks.updatedAt < FEEDS_CACHE_TTL_MS &&
        currentMs - cachedMovieMeter.updatedAt < FEEDS_CACHE_TTL_MS &&
        currentMs - cachedTvMeter.updatedAt < FEEDS_CACHE_TTL_MS &&
        currentMs - cachedUpcomingTv.updatedAt < FEEDS_CACHE_TTL_MS;

      if (allFresh) {
        const updatedAt = Math.max(
          cachedTopPicks.updatedAt,
          cachedMovieMeter.updatedAt,
          cachedTvMeter.updatedAt,
          cachedUpcomingTv.updatedAt,
        );
        return jsonResponse(
          200,
          {
            topPicks: cachedTopPicks.items,
            movieMeter: cachedMovieMeter.items,
            tvMeter: cachedTvMeter.items,
            currentUpcomingTv: cachedUpcomingTv.items,
            updatedAt,
          },
          { 'Cache-Control': CACHE_CONTROL_FEEDS },
        );
      }

      const fetched = await upstream.fetchFeeds();

      async function resolveFeed(
        key: ElvFeedKey,
        freshItems: readonly ElvFeedItem[],
        staleItems: readonly ElvFeedItem[] | undefined,
      ): Promise<readonly ElvFeedItem[]> {
        if (freshItems.length > 0) {
          await storage.upsertElvFeed(key, freshItems, currentMs);
          return freshItems;
        }
        return staleItems ?? [];
      }

      const [topPicks, movieMeter, tvMeter, currentUpcomingTv] = await Promise.all([
        resolveFeed('top_picks', fetched.topPicks, cachedTopPicks?.items),
        resolveFeed('moviemeter', fetched.movieMeter, cachedMovieMeter?.items),
        resolveFeed('tvmeter', fetched.tvMeter, cachedTvMeter?.items),
        resolveFeed('current_upcoming_tv', fetched.currentUpcomingTv, cachedUpcomingTv?.items),
      ]);

      return jsonResponse(
        200,
        { topPicks, movieMeter, tvMeter, currentUpcomingTv, updatedAt: currentMs },
        { 'Cache-Control': CACHE_CONTROL_FEEDS },
      );
    },

    async handleElvSearch(request: Request, url: URL, clientIp?: string): Promise<Response> {
      const limited = checkRateLimit(request, 'elvSearch', clientIp);
      if (limited) return limited;

      const valid = validateElvSearchParams(url);
      if (!valid.ok) return jsonResponse(400, { error: valid.error });

      const candidates = await upstream.searchSuggestions(valid.value.query);
      const filtered = candidates
        .filter((cand) => {
          if (cand.mediaType === 'other') return false;
          if (valid.value.mediaType && cand.mediaType !== valid.value.mediaType) return false;
          return true;
        })
        .slice(0, MAX_SEARCH_RESULTS)
        .map((cand) => ({
          imdbId: cand.imdbId,
          title: cand.title,
          year: cand.year,
          mediaType: cand.mediaType,
          posterUrl: cand.posterUrl,
          stars: cand.stars,
        }));

      return jsonResponse(
        200,
        { query: valid.value.query, results: filtered },
        { 'Cache-Control': CACHE_CONTROL_SEARCH },
      );
    },
  };
}
