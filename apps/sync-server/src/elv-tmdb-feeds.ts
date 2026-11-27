import { asRecord, defaultTmdbFetchFn, fetchTmdbJson } from './elv-tmdb-http.ts';
import { buildTmdbImageUrl, mapTmdbGenreIds } from './elv-tmdb-mapper.ts';
import { parseTmdbReleaseYear } from './elv-tmdb-scoring.ts';
import type {
  ElvCachedTmdbResolver,
  ElvFeedItem,
  ElvFeedsPayload,
  ElvFetchFn,
  ElvMediaType,
} from './elv-types.ts';
import { validateImdbId } from './elv-validation.ts';

const MAX_SEARCH_BYTES = 128 * 1024;
const MAX_FEED_ITEMS = 25;
const MAX_FEED_EXTERNAL_ID_LOOKUPS = 40;
const FEED_CONCURRENCY = 8;
const TMDB_ID_RE = /^[1-9]\d{0,9}$/;

/** Options accepted by `fetchTmdbFeeds`. */
export interface TmdbFeedsOptions {
  readonly fetchFn?: ElvFetchFn;
  readonly resolveCachedImdbIds?: ElvCachedTmdbResolver;
  readonly maxExternalIdLookups?: number;
}

interface RawFeedEntry {
  readonly tmdbId: string;
  readonly title: string;
  readonly mediaType: ElvMediaType;
  readonly year: number | null;
  readonly rating: number | null;
  readonly posterUrl: string | null;
  readonly genres: readonly string[];
}

/** Resolves a single TMDB movie/TV ID to its external IMDb ID (`tt...`). */
export async function resolveTmdbExternalImdbId(
  tmdbId: string,
  mediaType: ElvMediaType,
  tmdbApiKey: string,
  fetchFn: ElvFetchFn = defaultTmdbFetchFn,
): Promise<string | null> {
  if (!TMDB_ID_RE.test(tmdbId.trim())) return null;
  const kind = mediaType === 'series' ? 'tv' : 'movie';
  const parsed = asRecord(
    await fetchTmdbJson(
      `/${kind}/${tmdbId.trim()}/external_ids`,
      {},
      tmdbApiKey,
      fetchFn,
      MAX_SEARCH_BYTES,
    ),
  );
  const valid = validateImdbId(parsed?.imdb_id);
  return valid.ok ? valid.value : null;
}

function parseRawTmdbFeedList(raw: unknown, mediaType: ElvMediaType): RawFeedEntry[] {
  const results = asRecord(raw)?.results;
  if (!Array.isArray(results)) return [];
  const items: RawFeedEntry[] = [];
  for (const entry of results) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const tmdbId =
      typeof rec.id === 'number' && Number.isInteger(rec.id) && rec.id > 0 ? String(rec.id) : null;
    const title =
      typeof rec[mediaType === 'series' ? 'name' : 'title'] === 'string'
        ? String(rec[mediaType === 'series' ? 'name' : 'title']).trim()
        : '';
    if (!tmdbId || !title) continue;
    const rawRating = rec.vote_average;
    items.push({
      tmdbId,
      title,
      mediaType,
      year: parseTmdbReleaseYear(mediaType === 'series' ? rec.first_air_date : rec.release_date),
      rating:
        typeof rawRating === 'number' && Number.isFinite(rawRating) && rawRating > 0
          ? Math.round(rawRating * 10) / 10
          : null,
      posterUrl: buildTmdbImageUrl(rec.poster_path, 'w342'),
      genres: mapTmdbGenreIds(rec.genre_ids),
    });
    if (items.length >= MAX_FEED_ITEMS) break;
  }
  return items;
}

/**
 * Fetches trending & top-rated feeds from TMDB v3, resolves `tmdbId -> imdbId` from D1 cache first,
 * and interleaves bounded `/external_ids` lookups to stay strictly under Worker's 50-subrequest limit.
 */
export async function fetchTmdbFeeds(
  tmdbApiKey: string,
  options: TmdbFeedsOptions = {},
): Promise<ElvFeedsPayload> {
  if (!tmdbApiKey.trim()) {
    return { topPicks: [], movieMeter: [], tvMeter: [], currentUpcomingTv: [] };
  }
  const fetchFn = options.fetchFn ?? defaultTmdbFetchFn;
  const maxExtLookups = options.maxExternalIdLookups ?? MAX_FEED_EXTERNAL_ID_LOOKUPS;

  const [trendingMoviesRaw, trendingTvRaw, topMoviesRaw, topTvRaw] = await Promise.all([
    fetchTmdbJson(
      '/trending/movie/week',
      { language: 'en-US' },
      tmdbApiKey,
      fetchFn,
      MAX_SEARCH_BYTES,
    ),
    fetchTmdbJson(
      '/trending/tv/week',
      { language: 'en-US' },
      tmdbApiKey,
      fetchFn,
      MAX_SEARCH_BYTES,
    ),
    fetchTmdbJson('/movie/top_rated', { language: 'en-US' }, tmdbApiKey, fetchFn, MAX_SEARCH_BYTES),
    fetchTmdbJson('/tv/top_rated', { language: 'en-US' }, tmdbApiKey, fetchFn, MAX_SEARCH_BYTES),
  ]);

  const rawLists = {
    movieMeter: parseRawTmdbFeedList(trendingMoviesRaw, 'movie'),
    tvMeter: parseRawTmdbFeedList(trendingTvRaw, 'series'),
    topPicks: parseRawTmdbFeedList(topMoviesRaw, 'movie'),
    currentUpcomingTv: parseRawTmdbFeedList(topTvRaw, 'series'),
  };

  const movieTmdbIds = [
    ...new Set([...rawLists.movieMeter, ...rawLists.topPicks].map((i) => i.tmdbId)),
  ];
  const seriesTmdbIds = [
    ...new Set([...rawLists.tvMeter, ...rawLists.currentUpcomingTv].map((i) => i.tmdbId)),
  ];

  const [cachedMovies, cachedSeries] = options.resolveCachedImdbIds
    ? await Promise.all([
        movieTmdbIds.length > 0
          ? options.resolveCachedImdbIds(movieTmdbIds, 'movie')
          : new Map<string, string>(),
        seriesTmdbIds.length > 0
          ? options.resolveCachedImdbIds(seriesTmdbIds, 'series')
          : new Map<string, string>(),
      ])
    : [new Map<string, string>(), new Map<string, string>()];

  const resolvedMap = new Map<string, string>();
  for (const [id, imdb] of cachedMovies) resolvedMap.set(`movie:${id}`, imdb);
  for (const [id, imdb] of cachedSeries) resolvedMap.set(`series:${id}`, imdb);

  const queue: {
    readonly key: string;
    readonly tmdbId: string;
    readonly mediaType: ElvMediaType;
  }[] = [];
  const queuedKeys = new Set<string>();
  const feedOrder = [
    rawLists.movieMeter,
    rawLists.tvMeter,
    rawLists.topPicks,
    rawLists.currentUpcomingTv,
  ];
  for (let idx = 0; idx < MAX_FEED_ITEMS; idx += 1) {
    for (const list of feedOrder) {
      const entry = list[idx];
      if (!entry) continue;
      const cacheKey = `${entry.mediaType}:${entry.tmdbId}`;
      if (resolvedMap.has(cacheKey) || queuedKeys.has(cacheKey)) continue;
      queuedKeys.add(cacheKey);
      queue.push({ key: cacheKey, tmdbId: entry.tmdbId, mediaType: entry.mediaType });
    }
  }

  const boundedQueue = queue.slice(0, maxExtLookups);
  let cursor = 0;
  async function extWorker(): Promise<void> {
    while (cursor < boundedQueue.length) {
      const i = cursor;
      cursor += 1;
      const item = boundedQueue[i];
      if (!item) continue;
      const imdbId = await resolveTmdbExternalImdbId(
        item.tmdbId,
        item.mediaType,
        tmdbApiKey,
        fetchFn,
      );
      if (imdbId) resolvedMap.set(item.key, imdbId);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FEED_CONCURRENCY, boundedQueue.length) }, () => extWorker()),
  );

  function finalize(entries: readonly RawFeedEntry[]): ElvFeedItem[] {
    const items: ElvFeedItem[] = [];
    for (const entry of entries) {
      const imdbId = resolvedMap.get(`${entry.mediaType}:${entry.tmdbId}`);
      if (!imdbId) continue;
      items.push({
        imdbId,
        title: entry.title,
        mediaType: entry.mediaType,
        year: entry.year,
        rating: entry.rating,
        posterUrl: entry.posterUrl,
        genres: entry.genres,
        rank: items.length + 1,
      });
    }
    return items;
  }

  return {
    topPicks: finalize(rawLists.topPicks),
    movieMeter: finalize(rawLists.movieMeter),
    tvMeter: finalize(rawLists.tvMeter),
    currentUpcomingTv: finalize(rawLists.currentUpcomingTv),
  };
}
