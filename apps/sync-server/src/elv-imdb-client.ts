import {
  IMDB_POSTER_WIDTH_PX,
  MIN_MATCH_CONFIDENCE,
  mapImdbQidToMediaType,
  resizeImdbImageUrl,
  scoreImdbCandidate,
  selectBestImdbMatch,
} from './elv-imdb-parser.ts';
import {
  fetchTmdbFeeds,
  fetchTmdbTitleDetail,
  findAndFetchByImdbId,
  resolveTmdbExternalImdbId,
  searchTmdbMatch,
} from './elv-tmdb-client.ts';
import type {
  ElvFeedsPayload,
  ElvFetchFn,
  ElvTitleRecord,
  ElvUpstreamClient,
  ImdbSuggestionCandidate,
} from './elv-types.ts';
import { validateImdbId } from './elv-validation.ts';

export { MIN_MATCH_CONFIDENCE, resizeImdbImageUrl, scoreImdbCandidate, selectBestImdbMatch };

const SUGGESTION_TIMEOUT_MS = 4_000;
const MAX_SUGGESTION_BYTES = 128 * 1024;
const IMDB_TITLE_ID_RE = /^tt\d{5,10}$/;

function defaultFetchFn(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

async function readBoundedResponsePrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

/** Queries IMDb's public JSON suggestion endpoint (`v3.sg.media-imdb.com`, never HTML scraping). */
export async function searchImdbSuggestions(
  query: string,
  fetchFn: ElvFetchFn = defaultFetchFn,
): Promise<readonly ImdbSuggestionCandidate[]> {
  const clean = query.trim();
  if (clean.length === 0) return [];
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(clean)}.json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUGGESTION_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return [];

  let parsed: unknown;
  try {
    const body = await readBoundedResponsePrefix(res, MAX_SUGGESTION_BYTES);
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const rawList = asRecord(parsed)?.d;
  if (!Array.isArray(rawList)) return [];

  const candidates: ImdbSuggestionCandidate[] = [];
  for (const entry of rawList) {
    const rec = asRecord(entry);
    const id = typeof rec?.id === 'string' ? rec.id.trim() : '';
    const title = typeof rec?.l === 'string' ? rec.l.trim() : '';
    if (!IMDB_TITLE_ID_RE.test(id) || !title) continue;

    const rawYear = rec?.y;
    const year =
      typeof rawYear === 'number' && Number.isInteger(rawYear) && rawYear >= 1880 && rawYear <= 2100
        ? rawYear
        : null;
    const qid = typeof rec?.qid === 'string' ? rec.qid : null;
    const mediaType = mapImdbQidToMediaType(qid, rec?.q);
    const stars = typeof rec?.s === 'string' && rec.s.trim().length > 0 ? rec.s.trim() : null;
    const rawImageUrl = asRecord(rec?.i)?.imageUrl;
    const posterUrl =
      typeof rawImageUrl === 'string'
        ? resizeImdbImageUrl(rawImageUrl, IMDB_POSTER_WIDTH_PX) || null
        : null;

    candidates.push({ imdbId: id, title, year, mediaType, qid, stars, posterUrl });
  }
  return candidates;
}

/** Options for `fetchImdbTitleDetail` and `createImdbUpstreamClient`. */
export interface ImdbUpstreamOptions {
  readonly fetchFn?: ElvFetchFn;
  readonly tmdbApiKey?: string;
  readonly now?: () => number;
  readonly lang?: string;
}

function buildRecordFromSuggestion(exact: ImdbSuggestionCandidate, nowMs: number): ElvTitleRecord {
  return {
    imdbId: exact.imdbId,
    tmdbId: null,
    mediaType: exact.mediaType === 'series' ? 'series' : 'movie',
    originalTitle: exact.title,
    englishTitle: exact.title,
    year: exact.year,
    rating: null,
    votes: null,
    runtimeMin: null,
    genres: [],
    posterUrl: exact.posterUrl,
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

/**
 * Fetches title detail via official TMDB v3 API when `tmdbApiKey` is set,
 * falling back cleanly to `v3.sg.media-imdb.com` JSON suggestions (never scraping `www.imdb.com`).
 */
export async function fetchImdbTitleDetail(
  imdbId: string,
  fetchFn: ElvFetchFn = defaultFetchFn,
  options: Omit<ImdbUpstreamOptions, 'fetchFn'> = {},
): Promise<ElvTitleRecord | null> {
  const valid = validateImdbId(imdbId);
  if (!valid.ok) return null;
  const nowMs = options.now ? options.now() : Date.now();
  const tmdbApiKey = options.tmdbApiKey?.trim() ?? '';

  if (tmdbApiKey.length > 0) {
    const tmdbRes = await findAndFetchByImdbId(valid.value, options.lang ?? 'en', {
      tmdbApiKey,
      fetchFn,
      nowMs,
    });
    if (tmdbRes.payload) {
      return tmdbRes.payload.record;
    }
  }

  const suggestions = await searchImdbSuggestions(valid.value, fetchFn);
  const exact = suggestions.find((c) => c.imdbId === valid.value);
  return exact ? buildRecordFromSuggestion(exact, nowMs) : null;
}

/** Fetches trending/top-rated feeds via TMDB v3 when `tmdbApiKey` is configured. */
export async function fetchImdbFeeds(
  fetchFn: ElvFetchFn = defaultFetchFn,
  tmdbApiKey = '',
): Promise<ElvFeedsPayload> {
  if (!tmdbApiKey.trim()) {
    return { topPicks: [], movieMeter: [], tvMeter: [], currentUpcomingTv: [] };
  }
  return fetchTmdbFeeds(tmdbApiKey, { fetchFn });
}

/** Creates the live hybrid TMDB-primary + IMDb-suggestion-fallback `ElvUpstreamClient`. */
export function createImdbUpstreamClient(options: ImdbUpstreamOptions = {}): ElvUpstreamClient {
  const fetchFn = options.fetchFn ?? defaultFetchFn;
  const tmdbApiKey = options.tmdbApiKey?.trim() ?? '';
  const nowFn = options.now ?? (() => Date.now());
  const isTmdbEnabled = tmdbApiKey.length > 0;

  return {
    isTmdbEnabled,
    searchSuggestions: (query) => searchImdbSuggestions(query, fetchFn),
    fetchTitleDetail: (imdbId, lang) =>
      fetchImdbTitleDetail(imdbId, fetchFn, {
        ...(tmdbApiKey ? { tmdbApiKey } : {}),
        now: nowFn,
        ...(lang ? { lang } : {}),
      }),
    fetchFeeds: (resolveCachedImdbIds) =>
      isTmdbEnabled
        ? fetchTmdbFeeds(tmdbApiKey, {
            fetchFn,
            ...(resolveCachedImdbIds ? { resolveCachedImdbIds } : {}),
          })
        : Promise.resolve({ topPicks: [], movieMeter: [], tvMeter: [], currentUpcomingTv: [] }),
    resolveTmdbToImdb: async (tmdbId, mediaType) => {
      if (!tmdbApiKey) return null;
      return resolveTmdbExternalImdbId(tmdbId, mediaType, tmdbApiKey, fetchFn);
    },
    ...(isTmdbEnabled
      ? {
          searchRichMatch: (query, mediaType, year, lang, budget) =>
            searchTmdbMatch(query, mediaType, year, lang, {
              tmdbApiKey,
              fetchFn,
              nowMs: nowFn(),
              ...(budget ? { budget } : {}),
            }),
          fetchRichTitleByTmdbId: (tmdbId, mediaType, lang, budget) =>
            fetchTmdbTitleDetail(tmdbId, mediaType, lang, {
              tmdbApiKey,
              fetchFn,
              nowMs: nowFn(),
              ...(budget ? { budget } : {}),
            }),
          fetchRichTitleByImdbId: (imdbId, lang, knownTmdbId, knownMediaType, budget) =>
            knownTmdbId && knownMediaType
              ? fetchTmdbTitleDetail(
                  knownTmdbId,
                  knownMediaType,
                  lang,
                  { tmdbApiKey, fetchFn, nowMs: nowFn(), ...(budget ? { budget } : {}) },
                  imdbId,
                ).then((res) =>
                  res.payload
                    ? res
                    : findAndFetchByImdbId(imdbId, lang, {
                        tmdbApiKey,
                        fetchFn,
                        nowMs: nowFn(),
                        ...(budget ? { budget } : {}),
                      }),
                )
              : findAndFetchByImdbId(imdbId, lang, {
                  tmdbApiKey,
                  fetchFn,
                  nowMs: nowFn(),
                  ...(budget ? { budget } : {}),
                }),
        }
      : {}),
  };
}
