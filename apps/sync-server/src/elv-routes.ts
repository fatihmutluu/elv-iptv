import { buildStubTitleFromSuggestion, overlayFeedImdbRatings } from './elv-batch-helpers.ts';
import { executeElvMatchBatch } from './elv-batch-hydrate.ts';
import { createImdbUpstreamClient } from './elv-imdb-client.ts';
import type {
  ElvFeedItem,
  ElvFeedKey,
  ElvMediaType,
  ElvTitleRecord,
  ElvUpstreamClient,
  WorkersAiBinding,
} from './elv-types.ts';
import {
  isEnglishLang,
  validateElvLang,
  validateElvMatchBatchInput,
  validateElvSearchParams,
  validateImdbId,
} from './elv-validation.ts';
import type { RateLimitConfig } from './rate-limit.ts';
import type { SyncServerStorage } from './storage.ts';
import { BODY_LIMITS, readBoundedJson } from './validation.ts';

/** 180-day cache TTL for catalog movies released >= 2 years ago. */
export const OLD_TITLE_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 14-day cache TTL for recent movies (< 2 years) and all series. */
export const RECENT_TITLE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FEEDS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_LOCALE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_SEARCH_RESULTS = 12;
const CACHE_CONTROL_TITLE = 'public, max-age=86400';
const CACHE_CONTROL_TITLE_FALLBACK = 'public, max-age=300';
const CACHE_CONTROL_FEEDS = 'public, max-age=3600, stale-while-revalidate=86400';
const CACHE_CONTROL_SEARCH = 'public, max-age=300';
const CACHE_CONTROL_MATCH_BATCH = 'private, max-age=60';

/** Computes tiered D1 cache TTL based on media type and release year. */
export function computeTitleCacheTtlMs(
  title: Pick<ElvTitleRecord, 'mediaType' | 'year'>,
  nowMs: number,
): number {
  const currentYear = new Date(nowMs).getUTCFullYear();
  if (title.mediaType === 'movie' && title.year !== null && title.year <= currentYear - 2) {
    return OLD_TITLE_CACHE_TTL_MS;
  }
  return RECENT_TITLE_CACHE_TTL_MS;
}

/** Dependencies injected by `createSyncApp` into `/v1/elv/*` route handlers. */
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

/** Creates handlers for Wave Q1 hybrid IMDb+TMDB metadata endpoints (`/v1/elv/*`). */
export function createElvRouteHandlers(ctx: ElvRoutesContext): ElvRouteHandlers {
  const { storage, nowMs, checkRateLimit, jsonResponse } = ctx;
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

      const result = await executeElvMatchBatch({
        input: valid.value,
        storage,
        upstream,
        hasTmdbApiKey,
        currentMs: nowMs(),
      });
      return jsonResponse(200, result, { 'Cache-Control': CACHE_CONTROL_MATCH_BATCH });
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
      const isExpired =
        title !== null && currentMs - title.updatedAt >= computeTitleCacheTtlMs(title, currentMs);
      const needsFetch = !title || !isDetailComplete(title) || isExpired;

      let cachedLocalized = !isEnglishLang(lang)
        ? await storage.getElvLocalizedSynopsis(cleanId, lang)
        : null;

      const isLocaleCacheFresh =
        cachedLocalized !== null &&
        (cachedLocalized.synopsis.trim().length > 0 ||
          (cachedLocalized.source === 'fallback_en' &&
            currentMs - cachedLocalized.updatedAt < FALLBACK_LOCALE_CACHE_TTL_MS));

      const needsLocaleFetch =
        !needsFetch &&
        !isEnglishLang(lang) &&
        !isLocaleCacheFresh &&
        Boolean(upstream.fetchRichTitleByImdbId);

      if (needsFetch || needsLocaleFetch) {
        let resolvedViaRich = false;
        if (upstream.fetchRichTitleByImdbId) {
          const richRes = await upstream.fetchRichTitleByImdbId(
            cleanId,
            lang,
            title?.tmdbId ?? null,
            title?.mediaType ?? null,
          );
          if (richRes.payload) {
            resolvedViaRich = true;
            let recordToSave = richRes.payload.record;
            if (
              recordToSave.mltImdbIds.length === 0 &&
              richRes.payload.recommendedTmdbIds.length > 0
            ) {
              const cachedRecs = await storage.getElvTitlesByTmdbIds(
                richRes.payload.recommendedTmdbIds,
                recordToSave.mediaType,
              );
              const resolvedMlt = richRes.payload.recommendedTmdbIds
                .map((id) => cachedRecs.get(id)?.imdbId)
                .filter((id): id is string => Boolean(id));
              if (resolvedMlt.length > 0) {
                recordToSave = { ...recordToSave, mltImdbIds: resolvedMlt };
              }
            }
            if (needsFetch) {
              await storage.upsertElvTitle(recordToSave);
              title = (await storage.getElvTitle(cleanId)) ?? recordToSave;
            }
            if (!isEnglishLang(lang)) {
              const locRecord = {
                imdbId: cleanId,
                lang,
                localizedTitle: richRes.payload.localizedTitle,
                synopsis: richRes.payload.localizedSynopsis ?? '',
                source: richRes.payload.localizedSynopsis ? 'tmdb' : 'fallback_en',
                updatedAt: currentMs,
              };
              await storage.upsertElvLocalizedSynopsis(locRecord);
              cachedLocalized = locRecord;
            }
          } else if (needsLocaleFetch && !isEnglishLang(lang)) {
            const locRecord = {
              imdbId: cleanId,
              lang,
              localizedTitle: cachedLocalized?.localizedTitle ?? null,
              synopsis: '',
              source: 'fallback_en',
              updatedAt: currentMs,
            };
            await storage.upsertElvLocalizedSynopsis(locRecord);
            cachedLocalized = locRecord;
          }
        }
        if (!resolvedViaRich && needsFetch) {
          let fetched: ElvTitleRecord | null = null;
          if (upstream.fetchRichTitleByImdbId) {
            const suggestions = await upstream.searchSuggestions(cleanId);
            const exact = suggestions.find((c) => c.imdbId === cleanId);
            fetched = exact ? buildStubTitleFromSuggestion(exact, currentMs) : null;
          } else {
            fetched = await upstream.fetchTitleDetail(cleanId, lang);
          }
          if (fetched) {
            await storage.upsertElvTitle(fetched);
            title = (await storage.getElvTitle(cleanId)) ?? fetched;
          }
        }
      }

      if (!title) {
        return jsonResponse(404, { error: 'title_not_found' });
      }

      const authoritativeRating = (await storage.getImdbRatingsByIds([cleanId])).get(cleanId);

      // Option 2A: Native TMDB localized title/synopsis only (0 Workers AI calls); fallback cleanly to EN
      let synopsis: string | null = title.originalSynopsis;
      let localizedTitle: string | null = null;
      let synopsisSource = 'original';

      if (!isEnglishLang(lang)) {
        localizedTitle = cachedLocalized?.localizedTitle ?? null;
        if (cachedLocalized && cachedLocalized.synopsis.trim().length > 0) {
          synopsis = cachedLocalized.synopsis;
          synopsisSource = cachedLocalized.source;
        } else {
          synopsis = title.originalSynopsis;
          synopsisSource = 'fallback_en';
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
          tmdbId: title.tmdbId,
          mediaType: title.mediaType,
          originalTitle: title.originalTitle,
          englishTitle: title.englishTitle,
          localizedTitle,
          year: title.year,
          rating: authoritativeRating ? authoritativeRating.rating : title.rating,
          votes: authoritativeRating ? authoritativeRating.votes : title.votes,
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
        const overlaid = await overlayFeedImdbRatings(storage, {
          topPicks: cachedTopPicks.items,
          movieMeter: cachedMovieMeter.items,
          tvMeter: cachedTvMeter.items,
          currentUpcomingTv: cachedUpcomingTv.items,
        });
        return jsonResponse(
          200,
          { ...overlaid, updatedAt },
          { 'Cache-Control': CACHE_CONTROL_FEEDS },
        );
      }

      const resolveCachedTmdb = async (
        tmdbIds: readonly string[],
        mediaType: ElvMediaType,
      ): Promise<ReadonlyMap<string, string>> => {
        const map = await storage.getElvTitlesByTmdbIds(tmdbIds, mediaType);
        const out = new Map<string, string>();
        for (const [tmdbId, record] of map) out.set(tmdbId, record.imdbId);
        return out;
      };

      const fetched = await upstream.fetchFeeds(resolveCachedTmdb);

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

      const overlaid = await overlayFeedImdbRatings(storage, {
        topPicks,
        movieMeter,
        tvMeter,
        currentUpcomingTv,
      });
      return jsonResponse(
        200,
        { ...overlaid, updatedAt: currentMs },
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
