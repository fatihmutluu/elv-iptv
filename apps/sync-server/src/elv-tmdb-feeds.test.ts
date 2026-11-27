import { describe, expect, it, vi } from 'vitest';
import { fetchTmdbFeeds } from './elv-tmdb-client.ts';
import type { ElvFetchFn } from './elv-types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TMDB v3 trending & top-rated feeds (elv-tmdb-feeds)', () => {
  it('fetches TMDB feeds, resolves cached tmdb_id first without /external_ids, and caps total subrequests < 50', async () => {
    let networkCalls = 0;
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      networkCalls += 1;
      if (url.includes('/3/trending/movie/week')) {
        return jsonResponse({
          results: Array.from({ length: 25 }, (_, i) => ({
            id: 100 + i,
            title: `Trending Movie ${i + 1}`,
            release_date: '2024-05-01',
            vote_average: 7.5,
            poster_path: `/m${i}.jpg`,
            genre_ids: [28, 878],
          })),
        });
      }
      if (url.includes('/3/trending/tv/week')) {
        return jsonResponse({
          results: Array.from({ length: 25 }, (_, i) => ({
            id: 200 + i,
            name: `Trending Show ${i + 1}`,
            first_air_date: '2025-02-01',
            vote_average: 8.1,
            poster_path: `/t${i}.jpg`,
            genre_ids: [10765],
          })),
        });
      }
      if (url.includes('/3/movie/top_rated')) {
        return jsonResponse({
          results: Array.from({ length: 25 }, (_, i) => ({
            id: 300 + i,
            title: `Top Movie ${i + 1}`,
            release_date: '1994-09-23',
            vote_average: 8.9,
            poster_path: `/tm${i}.jpg`,
            genre_ids: [18],
          })),
        });
      }
      if (url.includes('/3/tv/top_rated')) {
        return jsonResponse({
          results: Array.from({ length: 25 }, (_, i) => ({
            id: 400 + i,
            name: `Top TV ${i + 1}`,
            first_air_date: '2008-01-20',
            vote_average: 9.0,
            poster_path: `/tt${i}.jpg`,
            genre_ids: [80, 18],
          })),
        });
      }
      const extMatch = /\/3\/(movie|tv)\/(\d+)\/external_ids/.exec(url);
      if (extMatch?.[2]) {
        const idNum = Number(extMatch[2]);
        return jsonResponse({ imdb_id: `tt${String(1_000_000 + idNum)}` });
      }
      return new Response('not found', { status: 404 });
    });

    const cachedMovies = new Map<string, string>([
      ['100', 'tt0000100'],
      ['300', 'tt0000300'],
    ]);
    const feeds = await fetchTmdbFeeds('test-tmdb-key', {
      fetchFn: fetchMock,
      resolveCachedImdbIds: async (tmdbIds, mediaType) => {
        const out = new Map<string, string>();
        if (mediaType === 'movie') {
          for (const id of tmdbIds) {
            const hit = cachedMovies.get(id);
            if (hit) out.set(id, hit);
          }
        }
        return out;
      },
    });

    expect(networkCalls).toBeLessThan(50);
    expect(feeds.movieMeter[0]).toEqual({
      imdbId: 'tt0000100',
      title: 'Trending Movie 1',
      mediaType: 'movie',
      year: 2024,
      rating: 7.5,
      posterUrl: 'https://image.tmdb.org/t/p/w342/m0.jpg',
      genres: ['Action', 'Sci-Fi'],
      rank: 1,
    });
    expect(feeds.topPicks[0]?.imdbId).toBe('tt0000300');
    expect(feeds.tvMeter.length).toBeGreaterThan(0);
    expect(feeds.tvMeter[0]?.genres).toEqual(['Sci-Fi', 'Fantasy']);
    expect(feeds.currentUpcomingTv.length).toBeGreaterThan(0);
  });
});
