import {
  IMDB_POSTER_WIDTH_PX,
  MIN_MATCH_CONFIDENCE,
  mapImdbQidToMediaType,
  parseImdbChartHtml,
  parseImdbTitleHtml,
  resizeImdbImageUrl,
  scoreImdbCandidate,
  selectBestImdbMatch,
} from './elv-imdb-parser.ts';
import type {
  ElvFeedItem,
  ElvFeedsPayload,
  ElvFetchFn,
  ElvMediaType,
  ElvTitleRecord,
  ElvUpstreamClient,
  ImdbSuggestionCandidate,
} from './elv-types.ts';
import { validateImdbId } from './elv-validation.ts';

export { MIN_MATCH_CONFIDENCE, resizeImdbImageUrl, scoreImdbCandidate, selectBestImdbMatch };

const SUGGESTION_TIMEOUT_MS = 4_000;
const DETAIL_TIMEOUT_MS = 6_000;
const FEED_TIMEOUT_MS = 5_000;
const TMDB_TIMEOUT_MS = 4_000;

const MAX_SUGGESTION_BYTES = 128 * 1024;
const MAX_IMDB_HTML_BYTES = 512 * 1024;
const MAX_TMDB_JSON_BYTES = 128 * 1024;

const IMDB_BROWSER_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const IMDB_CHART_URLS = {
  movieMeter: { url: 'https://www.imdb.com/chart/moviemeter/', mediaType: 'movie' as const },
  tvMeter: { url: 'https://www.imdb.com/chart/tvmeter/', mediaType: 'series' as const },
  topPicks: { url: 'https://www.imdb.com/chart/top/', mediaType: 'movie' as const },
  currentUpcomingTv: { url: 'https://www.imdb.com/chart/toptv/', mediaType: 'series' as const },
} as const;

const TMDB_IMAGE_PATH_RE = /^\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i;
const IMDB_TITLE_ID_RE = /^tt\d{5,10}$/;

function defaultFetchFn(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/** Reads at most `maxBytes` from a Response body stream cleanly without throwing on larger upstream HTML. */
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

async function fetchWithTimeout(
  fetchFn: ElvFetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

/** Queries IMDb's public suggestion endpoint with a 4s timeout and 128 KB bounded read. */
export async function searchImdbSuggestions(
  query: string,
  fetchFn: ElvFetchFn = defaultFetchFn,
): Promise<readonly ImdbSuggestionCandidate[]> {
  const clean = query.trim();
  if (clean.length === 0) return [];
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(clean)}.json`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchFn,
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      SUGGESTION_TIMEOUT_MS,
    );
  } catch {
    return [];
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

/** Optional TMDB enrichment seam used strictly as a secondary fallback when `tmdbApiKey` is set. */
async function fetchTmdbSupplemental(
  imdbId: string,
  tmdbApiKey: string,
  fetchFn: ElvFetchFn,
): Promise<{
  readonly backdropUrl: string | null;
  readonly originalSynopsis: string | null;
  readonly posterUrl: string | null;
} | null> {
  const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${encodeURIComponent(tmdbApiKey)}`;
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      TMDB_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const body = await readBoundedResponsePrefix(res, MAX_TMDB_JSON_BYTES);
    const parsed = asRecord(JSON.parse(body));
    const movies = Array.isArray(parsed?.movie_results) ? parsed.movie_results : [];
    const tv = Array.isArray(parsed?.tv_results) ? parsed.tv_results : [];
    const first = asRecord(movies[0] ?? tv[0]);
    if (!first) return null;

    const backdropPath =
      typeof first.backdrop_path === 'string' && TMDB_IMAGE_PATH_RE.test(first.backdrop_path)
        ? `https://image.tmdb.org/t/p/w1280${first.backdrop_path}`
        : null;
    const posterPath =
      typeof first.poster_path === 'string' && TMDB_IMAGE_PATH_RE.test(first.poster_path)
        ? `https://image.tmdb.org/t/p/w342${first.poster_path}`
        : null;
    const overview =
      typeof first.overview === 'string' && first.overview.trim().length > 0
        ? first.overview.trim()
        : null;
    return { backdropUrl: backdropPath, originalSynopsis: overview, posterUrl: posterPath };
  } catch {
    return null;
  }
}

async function resolveTmdbExternalImdbId(
  tmdbId: string,
  mediaType: ElvMediaType,
  tmdbApiKey: string,
  fetchFn: ElvFetchFn,
): Promise<string | null> {
  if (!/^[1-9]\d{0,9}$/.test(tmdbId)) return null;
  const kind = mediaType === 'series' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${kind}/${tmdbId}/external_ids?api_key=${encodeURIComponent(tmdbApiKey)}`;
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      TMDB_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const body = await readBoundedResponsePrefix(res, MAX_TMDB_JSON_BYTES);
    const parsed = asRecord(JSON.parse(body));
    const valid = validateImdbId(parsed?.imdb_id);
    return valid.ok ? valid.value : null;
  } catch {
    return null;
  }
}

/** Options for `fetchImdbTitleDetail` and `createImdbUpstreamClient`. */
export interface ImdbUpstreamOptions {
  readonly fetchFn?: ElvFetchFn;
  readonly tmdbApiKey?: string;
  readonly now?: () => number;
}

/** Fetches IMDb title detail via JSON-LD + `__NEXT_DATA__` with graceful suggestion & optional TMDB fallbacks. */
export async function fetchImdbTitleDetail(
  imdbId: string,
  fetchFn: ElvFetchFn = defaultFetchFn,
  options: Omit<ImdbUpstreamOptions, 'fetchFn'> = {},
): Promise<ElvTitleRecord | null> {
  const valid = validateImdbId(imdbId);
  if (!valid.ok) return null;
  const nowMs = options.now ? options.now() : Date.now();
  let detail: ElvTitleRecord | null = null;

  try {
    const res = await fetchWithTimeout(
      fetchFn,
      `https://www.imdb.com/title/${valid.value}/`,
      { method: 'GET', headers: IMDB_BROWSER_HEADERS },
      DETAIL_TIMEOUT_MS,
    );
    if (res.ok) {
      const html = await readBoundedResponsePrefix(res, MAX_IMDB_HTML_BYTES);
      detail = parseImdbTitleHtml(valid.value, html, nowMs);
    }
  } catch {
    detail = null;
  }

  if (!detail) {
    const suggestions = await searchImdbSuggestions(valid.value, fetchFn);
    const exact = suggestions.find((c) => c.imdbId === valid.value);
    if (exact) {
      detail = {
        imdbId: exact.imdbId,
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
  }

  if (
    detail &&
    options.tmdbApiKey &&
    options.tmdbApiKey.trim().length > 0 &&
    (!detail.originalSynopsis || !detail.backdropUrl || !detail.posterUrl)
  ) {
    const extra = await fetchTmdbSupplemental(valid.value, options.tmdbApiKey.trim(), fetchFn);
    if (extra) {
      detail = {
        ...detail,
        posterUrl: detail.posterUrl ?? extra.posterUrl,
        backdropUrl: detail.backdropUrl ?? extra.backdropUrl,
        originalSynopsis: detail.originalSynopsis ?? extra.originalSynopsis,
      };
    }
  }

  return detail;
}

async function fetchSingleFeed(
  url: string,
  mediaType: ElvMediaType,
  fetchFn: ElvFetchFn,
): Promise<readonly ElvFeedItem[]> {
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      url,
      { method: 'GET', headers: IMDB_BROWSER_HEADERS },
      FEED_TIMEOUT_MS,
    );
    if (!res.ok) return [];
    const html = await readBoundedResponsePrefix(res, MAX_IMDB_HTML_BYTES);
    return parseImdbChartHtml(html, mediaType);
  } catch {
    return [];
  }
}

/** Fetches IMDb editorial/trending charts with 5s timeout and 512 KB bounded HTML reads. */
export async function fetchImdbFeeds(
  fetchFn: ElvFetchFn = defaultFetchFn,
): Promise<ElvFeedsPayload> {
  const [movieMeter, tvMeter, topPicks, currentUpcomingTv] = await Promise.all([
    fetchSingleFeed(IMDB_CHART_URLS.movieMeter.url, IMDB_CHART_URLS.movieMeter.mediaType, fetchFn),
    fetchSingleFeed(IMDB_CHART_URLS.tvMeter.url, IMDB_CHART_URLS.tvMeter.mediaType, fetchFn),
    fetchSingleFeed(IMDB_CHART_URLS.topPicks.url, IMDB_CHART_URLS.topPicks.mediaType, fetchFn),
    fetchSingleFeed(
      IMDB_CHART_URLS.currentUpcomingTv.url,
      IMDB_CHART_URLS.currentUpcomingTv.mediaType,
      fetchFn,
    ),
  ]);
  return { topPicks, movieMeter, tvMeter, currentUpcomingTv };
}

/** Creates the live IMDb-first `ElvUpstreamClient` with an optional TMDB fallback seam. */
export function createImdbUpstreamClient(options: ImdbUpstreamOptions = {}): ElvUpstreamClient {
  const fetchFn = options.fetchFn ?? defaultFetchFn;
  const tmdbApiKey = options.tmdbApiKey?.trim() ?? '';
  return {
    searchSuggestions: (query) => searchImdbSuggestions(query, fetchFn),
    fetchTitleDetail: (imdbId) =>
      fetchImdbTitleDetail(imdbId, fetchFn, {
        ...(tmdbApiKey ? { tmdbApiKey } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
    fetchFeeds: () => fetchImdbFeeds(fetchFn),
    resolveTmdbToImdb: async (tmdbId, mediaType) => {
      if (!tmdbApiKey) return null;
      return resolveTmdbExternalImdbId(tmdbId, mediaType, tmdbApiKey, fetchFn);
    },
  };
}
