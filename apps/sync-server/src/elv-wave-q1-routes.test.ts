import { describe, expect, it, vi } from 'vitest';
import { createSyncApp } from './app.ts';
import { createImdbUpstreamClient } from './elv-imdb-client.ts';
import {
  computeTitleCacheTtlMs,
  OLD_TITLE_CACHE_TTL_MS,
  RECENT_TITLE_CACHE_TTL_MS,
} from './elv-routes.ts';
import type { ElvFetchFn, ElvTitleRecord, ElvTitleSummary, WorkersAiBinding } from './elv-types.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'wave-q1-routes-test-secret-at-least-32-chars-long';

function makeCachedTitle(overrides: Partial<ElvTitleRecord>): ElvTitleRecord {
  return {
    imdbId: 'tt1375666',
    tmdbId: '27205',
    mediaType: 'movie',
    originalTitle: 'Inception',
    englishTitle: 'Inception',
    year: 2010,
    rating: 8.3,
    votes: 36_000,
    runtimeMin: 148,
    genres: ['Action'],
    posterUrl: null,
    backdropUrl: '/bg.jpg',
    trailerStreamUrl: null,
    trailerYoutubeId: null,
    director: 'Christopher Nolan',
    cast: [],
    mltImdbIds: [],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    originalSynopsis: 'Old cached synopsis',
    updatedAt: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Wave Q1 Track A: Hybrid IMDb+TMDB routes, authoritative IMDb ratings overlay & tiered TTL', () => {
  it('hydrates rich match-batch summaries (genres, backdrop, tmdbId, localizedTitle, franchise) + overlays IMDb ratings', async () => {
    const storage = createMemoryStorage();
    await storage.upsertImdbRatingsBatch([
      { imdbId: 'tt1375666', rating: 8.8, votes: 2_610_000, updatedAt: 1_764_212_100_000 },
    ]);

    const seenUrls: string[] = [];
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      seenUrls.push(url);
      if (url.includes('/3/search/movie') && url.includes('Inception')) {
        return jsonResponse({
          results: [
            {
              id: 27205,
              title: 'Başlangıç',
              original_title: 'Inception',
              release_date: '2010-07-16',
              vote_count: 36_000,
              popularity: 120,
            },
          ],
        });
      }
      if (url.includes('/3/movie/27205?')) {
        return jsonResponse({
          id: 27205,
          original_language: 'en',
          original_title: 'Inception',
          title: 'Başlangıç',
          release_date: '2010-07-16',
          runtime: 148,
          vote_average: 8.3,
          vote_count: 36_000,
          poster_path: '/inc-poster.jpg',
          backdrop_path: '/inc-backdrop.jpg',
          overview: 'Rüyalara sızan bir hırsızın hikayesi.',
          genres: [
            { id: 28, name: 'Aksiyon' },
            { id: 878, name: 'Bilim-Kurgu' },
          ],
          belongs_to_collection: { id: 77, name: 'Dream Collection' },
          external_ids: { imdb_id: 'tt1375666' },
          credits: { crew: [{ name: 'Christopher Nolan', job: 'Director' }], cast: [] },
          videos: { results: [] },
          recommendations: { results: [] },
          translations: {
            translations: [
              {
                iso_639_1: 'en',
                iso_3166_1: 'US',
                data: { title: 'Inception', overview: 'A thief steals secrets from dreams.' },
              },
              {
                iso_639_1: 'tr',
                iso_3166_1: 'TR',
                data: { title: 'Başlangıç', overview: 'Rüyalara sızan bir hırsızın hikayesi.' },
              },
            ],
          },
        });
      }
      if (url.includes('/3/search/movie') && url.includes('NoTmdbMatch')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('v3.sg.media-imdb.com/suggestion/x/NoTmdbMatch.json')) {
        return jsonResponse({
          d: [{ id: 'tt0098765', l: 'NoTmdbMatch', y: 1998, qid: 'movie' }],
        });
      }
      return new Response('not found', { status: 404 });
    });

    const unusedAi: WorkersAiBinding = {
      run: vi.fn(async () => ({ response: 'unused' })),
    };
    const app = createSyncApp({
      storage,
      jwtSecret: TEST_JWT_SECRET,
      ai: unusedAi,
      tmdbApiKey: 'test-tmdb-key',
      now: () => 1_764_212_100_000,
      elvUpstream: createImdbUpstreamClient({
        fetchFn: fetchMock,
        tmdbApiKey: 'test-tmdb-key',
        now: () => 1_764_212_100_000,
      }),
    });

    const res = await app.fetch(
      new Request('https://sync.example.test/v1/elv/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lang: 'tr',
          items: [
            { key: 'm:inc', cleanTitle: 'Inception', year: 2010, mediaType: 'movie' },
            { key: 'm:fallback', cleanTitle: 'NoTmdbMatch', year: 1998, mediaType: 'movie' },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matches: Record<string, { imdbId: string; title: ElvTitleSummary }>;
      unmatchedKeys: string[];
      pendingKeys: string[];
    };

    const inc = body.matches['m:inc'];
    expect(inc?.imdbId).toBe('tt1375666');
    expect(inc?.title.tmdbId).toBe('27205');
    expect(inc?.title.genres).toEqual(['Action', 'Sci-Fi']);
    expect(inc?.title.posterUrl).toBe('https://image.tmdb.org/t/p/w342/inc-poster.jpg');
    expect(inc?.title.backdropUrl).toBe('https://image.tmdb.org/t/p/w1280/inc-backdrop.jpg');
    expect(inc?.title.localizedTitle).toBe('Başlangıç');
    expect(inc?.title.franchiseKey).toBe('tmdb-col:77');
    expect(inc?.title.franchiseName).toBe('Dream Collection');
    // Authoritative IMDb rating (8.8 / 2.61M) overrides TMDB vote_average (8.3 / 36K)
    expect(inc?.title.rating).toBe(8.8);
    expect(inc?.title.votes).toBe(2_610_000);

    // IMDb JSON suggestion fallback still matched when TMDB missed
    expect(body.matches['m:fallback']?.imdbId).toBe('tt0098765');

    // Localized TR synopsis persisted natively with source='tmdb' -> detail endpoint takes 0 upstream & 0 AI calls!
    const storedLoc = await storage.getElvLocalizedSynopsis('tt1375666', 'tr');
    expect(storedLoc?.source).toBe('tmdb');
    expect(storedLoc?.synopsis).toBe('Rüyalara sızan bir hırsızın hikayesi.');

    const callsBeforeDetail = fetchMock.mock.calls.length;
    const detailRes = await app.fetch(
      new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=tr'),
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      tmdbId: string;
      rating: number;
      votes: number;
      synopsis: string;
      synopsisSource: string;
      localizedTitle: string;
    };
    expect(detailBody.tmdbId).toBe('27205');
    expect(detailBody.rating).toBe(8.8);
    expect(detailBody.votes).toBe(2_610_000);
    expect(detailBody.synopsis).toBe('Rüyalara sızan bir hırsızın hikayesi.');
    expect(detailBody.synopsisSource).toBe('tmdb');
    expect(detailBody.localizedTitle).toBe('Başlangıç');
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeDetail);
    expect(unusedAi.run).not.toHaveBeenCalled();

    // Subsequent providerTmdbId request resolves from D1 in 0 upstream calls!
    const tmdbRes = await app.fetch(
      new Request('https://sync.example.test/v1/elv/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lang: 'tr',
          items: [
            {
              key: 'm:provider-tmdb',
              cleanTitle: 'Completely Different Alias',
              year: 2010,
              mediaType: 'movie',
              providerTmdbId: 27205,
            },
          ],
        }),
      }),
    );
    expect(tmdbRes.status).toBe(200);
    const tmdbBody = (await tmdbRes.json()) as {
      matches: Record<string, { imdbId: string; title: ElvTitleSummary }>;
    };
    expect(tmdbBody.matches['m:provider-tmdb']?.imdbId).toBe('tt1375666');
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeDetail);
    expect(seenUrls.every((u) => !u.includes('www.imdb.com'))).toBe(true);
  });

  it('caps rich TMDB match-batch lookups at <= 20 subrequests and emits overflow in pendingKeys', async () => {
    let subrequests = 0;
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      subrequests += 1;
      const q = new URL(url).searchParams.get('query') ?? '';
      const numMatch = /\d+/.exec(q)?.[0];
      if (url.includes('/3/search/movie') && numMatch) {
        const idNum = 100 + Number(numMatch);
        return jsonResponse({
          results: [
            {
              id: idNum,
              title: q,
              original_title: q,
              release_date: '2020-01-01',
              vote_count: 500,
            },
          ],
        });
      }
      const detMatch = /\/3\/movie\/(\d+)/.exec(url);
      if (detMatch?.[1]) {
        const idNum = Number(detMatch[1]);
        const idx = idNum - 100;
        return jsonResponse({
          id: idNum,
          original_language: 'en',
          original_title: `Film ${idx}`,
          title: `Film ${idx}`,
          release_date: '2020-01-01',
          genres: [{ id: 18 }],
          external_ids: { imdb_id: `tt${String(3000000 + idx)}` },
          credits: { crew: [], cast: [] },
          videos: { results: [] },
          recommendations: { results: [] },
          translations: { translations: [] },
        });
      }
      return jsonResponse({ results: [] });
    });

    const app = createSyncApp({
      storage: createMemoryStorage(),
      jwtSecret: TEST_JWT_SECRET,
      tmdbApiKey: 'test-tmdb-key',
      elvUpstream: createImdbUpstreamClient({ fetchFn: fetchMock, tmdbApiKey: 'test-tmdb-key' }),
    });

    const items = Array.from({ length: 16 }, (_, i) => ({
      key: `m:cap:${i + 1}`,
      cleanTitle: `Film ${i + 1}`,
      year: 2020,
      mediaType: 'movie' as const,
    }));

    const res = await app.fetch(
      new Request('https://sync.example.test/v1/elv/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, lang: 'en' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matches: Record<string, unknown>;
      pendingKeys: string[];
    };
    expect(subrequests).toBeLessThanOrEqual(20);
    expect(Object.keys(body.matches)).toHaveLength(10);
    expect(body.pendingKeys).toHaveLength(6);
  });

  it('enforces tiered cache TTL (180d for old movies >= 2y vs 14d for recent movies & series) and overlays IMDb ratings on /feeds', async () => {
    const now2026 = Date.UTC(2026, 10, 28);
    expect(computeTitleCacheTtlMs({ mediaType: 'movie', year: 2024 }, now2026)).toBe(
      OLD_TITLE_CACHE_TTL_MS,
    );
    expect(computeTitleCacheTtlMs({ mediaType: 'movie', year: 2025 }, now2026)).toBe(
      RECENT_TITLE_CACHE_TTL_MS,
    );
    expect(computeTitleCacheTtlMs({ mediaType: 'series', year: 2008 }, now2026)).toBe(
      RECENT_TITLE_CACHE_TTL_MS,
    );

    const storage = createMemoryStorage();
    await storage.upsertElvTitle(makeCachedTitle({ updatedAt: now2026 }));
    await storage.upsertElvTitle(
      makeCachedTitle({
        imdbId: 'tt0903747',
        tmdbId: '1396',
        mediaType: 'series',
        originalTitle: 'Breaking Bad',
        englishTitle: 'Breaking Bad',
        year: 2008,
        rating: 8.9,
        votes: 14_000,
        runtimeMin: 47,
        genres: ['Drama'],
        backdropUrl: '/bb.jpg',
        director: 'Vince Gilligan',
        originalSynopsis: 'Old series synopsis',
        updatedAt: now2026,
      }),
    );

    await storage.upsertImdbRatingsBatch([
      { imdbId: 'tt1375666', rating: 8.8, votes: 2_600_000, updatedAt: now2026 },
      { imdbId: 'tt0903747', rating: 9.5, votes: 2_200_000, updatedAt: now2026 },
    ]);

    let currentMs = now2026;
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('/3/tv/1396?')) {
        return jsonResponse({
          id: 1396,
          original_language: 'en',
          original_name: 'Breaking Bad',
          name: 'Breaking Bad',
          first_air_date: '2008-01-20',
          overview: 'Refreshed series synopsis',
          external_ids: { imdb_id: 'tt0903747' },
          translations: { translations: [] },
        });
      }
      if (url.includes('/3/trending/movie/week')) {
        return jsonResponse({
          results: [
            {
              id: 27205,
              title: 'Inception',
              release_date: '2010-07-16',
              vote_average: 8.2,
              genre_ids: [28],
            },
          ],
        });
      }
      if (url.includes('/3/trending/tv/week')) {
        return jsonResponse({
          results: [
            {
              id: 1396,
              name: 'Breaking Bad',
              first_air_date: '2008-01-20',
              vote_average: 8.9,
              genre_ids: [18],
            },
          ],
        });
      }
      return jsonResponse({ results: [] });
    });

    const app = createSyncApp({
      storage,
      jwtSecret: TEST_JWT_SECRET,
      tmdbApiKey: 'test-tmdb-key',
      now: () => currentMs,
      elvUpstream: createImdbUpstreamClient({
        fetchFn: fetchMock,
        tmdbApiKey: 'test-tmdb-key',
        now: () => currentMs,
      }),
    });

    // Advance 30 days: 2010 movie stays fresh (180d TTL, 0 upstream calls), while 2008 series refreshes (14d TTL)!
    currentMs += 30 * 24 * 60 * 60 * 1000;
    const oldMovieRes = await app.fetch(
      new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=en'),
    );
    expect(oldMovieRes.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const seriesRes = await app.fetch(
      new Request('https://sync.example.test/v1/elv/title/tt0903747?lang=en'),
    );
    expect(seriesRes.status).toBe(200);
    const seriesBody = (await seriesRes.json()) as { synopsis: string; rating: number };
    expect(seriesBody.synopsis).toBe('Refreshed series synopsis');
    expect(seriesBody.rating).toBe(9.5);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Feeds resolve tmdbIds from D1 (0 /external_ids calls) and overlay IMDb ratings over TMDB vote_average!
    const feedsRes = await app.fetch(new Request('https://sync.example.test/v1/elv/feeds'));
    expect(feedsRes.status).toBe(200);
    const feedsBody = (await feedsRes.json()) as {
      movieMeter: Array<{ imdbId: string; rating: number }>;
      tvMeter: Array<{ imdbId: string; rating: number }>;
    };
    expect(feedsBody.movieMeter[0]).toMatchObject({ imdbId: 'tt1375666', rating: 8.8 });
    expect(feedsBody.tvMeter[0]).toMatchObject({ imdbId: 'tt0903747', rating: 9.5 });
  });
});
