import { describe, expect, it, vi } from 'vitest';
import {
  fetchTmdbTitleDetail,
  findAndFetchByImdbId,
  mapTmdbGenreIds,
  searchTmdbMatch,
  toTmdbBcp47Lang,
} from './elv-tmdb-client.ts';
import type { ElvFetchFn } from './elv-types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTmdbMovieDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 27205,
    imdb_id: 'tt1375666',
    original_language: 'en',
    original_title: 'Inception',
    title: 'Başlangıç',
    release_date: '2010-07-16',
    runtime: 148,
    vote_average: 8.367,
    vote_count: 36_120,
    poster_path: '/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg',
    backdrop_path: '/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
    overview: 'Yetenekli bir hırsız, rüyalara sızarak sırları çalar.',
    genres: [
      { id: 28, name: 'Aksiyon' },
      { id: 878, name: 'Bilim-Kurgu' },
      { id: 12, name: 'Macera' },
    ],
    belongs_to_collection: {
      id: 9001,
      name: 'Inception Collection',
    },
    external_ids: {
      imdb_id: 'tt1375666',
    },
    credits: {
      crew: [
        { id: 525, name: 'Christopher Nolan', job: 'Director' },
        { id: 999, name: 'Emma Thomas', job: 'Producer' },
      ],
      cast: Array.from({ length: 18 }, (_, i) => ({
        id: 1000 + i,
        name: i === 0 ? 'Leonardo DiCaprio' : `Actor ${i + 1}`,
        character: i === 0 ? 'Dom Cobb' : `Role ${i + 1}`,
        profile_path: i === 0 ? '/wo2hJpn04vbtmh0B9utCFdsQhxM.jpg' : null,
        order: i,
      })),
    },
    videos: {
      results: [
        { site: 'YouTube', type: 'Teaser', official: true, key: 'teaserKey12' },
        { site: 'YouTube', type: 'Trailer', official: true, key: 'YoHD9XEInc0' },
      ],
    },
    recommendations: {
      results: [{ id: 157336 }, { id: 155 }],
    },
    translations: {
      translations: [
        {
          iso_639_1: 'en',
          iso_3166_1: 'US',
          data: {
            title: 'Inception',
            overview: 'A thief who steals corporate secrets through dream-sharing technology.',
          },
        },
        {
          iso_639_1: 'tr',
          iso_3166_1: 'TR',
          data: {
            title: 'Başlangıç',
            overview: 'Yetenekli bir hırsız, rüyalara sızarak sırları çalar.',
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('TMDB v3 client (elv-tmdb-client)', () => {
  it('maps TMDB movie and TV genre IDs to canonical English genre buckets across any locale', () => {
    expect(
      mapTmdbGenreIds([
        { id: 28, name: 'Aksiyon' },
        { id: 878, name: 'Bilim-Kurgu' },
        { id: 10759, name: 'Aksiyon & Macera' },
        { id: 10765, name: 'Bilim Kurgu & Fantazi' },
        { id: 10768, name: 'Savaş & Politik' },
      ]),
    ).toEqual(['Action', 'Sci-Fi', 'Adventure', 'Fantasy', 'War']);

    expect(toTmdbBcp47Lang('tr')).toBe('tr-TR');
    expect(toTmdbBcp47Lang('en')).toBe('en-US');
    expect(toTmdbBcp47Lang('pt-BR')).toBe('pt-BR');
  });

  it('searches TMDB movie/tv, retries without year on 0 results, and returns full ElvTitleRecord + native TR localization', async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      seenUrls.push(url);
      if (url.includes('/3/search/movie') && url.includes('year=2011')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('/3/search/movie') && !url.includes('year=')) {
        return jsonResponse({
          results: [
            {
              id: 999999,
              title: 'Inception: The Cobol Job',
              original_title: 'Inception: The Cobol Job',
              release_date: '2010-12-07',
              vote_count: 50,
              popularity: 2.1,
            },
            {
              id: 27205,
              title: 'Başlangıç',
              original_title: 'Inception',
              release_date: '2010-07-16',
              vote_count: 36_120,
              popularity: 120.5,
            },
          ],
        });
      }
      if (url.includes('/3/movie/27205?')) {
        return jsonResponse(makeTmdbMovieDetail());
      }
      return new Response('not found', { status: 404 });
    });

    const result = await searchTmdbMatch('Inception', 'movie', 2011, 'tr', {
      tmdbApiKey: 'test-tmdb-key',
      fetchFn: fetchMock,
      nowMs: 1_764_212_100_000,
    });

    expect(result.match).not.toBeNull();
    expect(result.subrequestsUsed).toBe(3);
    expect(seenUrls[0]).toContain('language=tr-TR');
    expect(seenUrls[0]).toContain('year=2011');
    expect(seenUrls[2]).toContain(
      'append_to_response=credits%2Cexternal_ids%2Crecommendations%2Cvideos%2Ctranslations',
    );

    const match = result.match;
    expect(match?.record.imdbId).toBe('tt1375666');
    expect(match?.record.tmdbId).toBe('27205');
    expect(match?.record.originalTitle).toBe('Inception');
    expect(match?.record.englishTitle).toBe('Inception');
    expect(match?.localizedTitle).toBe('Başlangıç');
    expect(match?.record.year).toBe(2010);
    expect(match?.record.runtimeMin).toBe(148);
    expect(match?.record.genres).toEqual(['Action', 'Sci-Fi', 'Adventure']);
    expect(match?.record.posterUrl).toBe(
      'https://image.tmdb.org/t/p/w342/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg',
    );
    expect(match?.record.backdropUrl).toBe(
      'https://image.tmdb.org/t/p/w1280/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
    );
    expect(match?.record.trailerYoutubeId).toBe('YoHD9XEInc0');
    expect(match?.record.director).toBe('Christopher Nolan');
    expect(match?.record.cast).toHaveLength(15);
    expect(match?.record.cast[0]).toEqual({
      personId: 'tmdb:1000',
      name: 'Leonardo DiCaprio',
      character: 'Dom Cobb',
      portraitUrl: 'https://image.tmdb.org/t/p/w185/wo2hJpn04vbtmh0B9utCFdsQhxM.jpg',
    });
    expect(match?.record.franchiseKey).toBe('tmdb-col:9001');
    expect(match?.record.franchiseName).toBe('Inception Collection');
    expect(match?.record.originalSynopsis).toBe(
      'A thief who steals corporate secrets through dream-sharing technology.',
    );
    expect(match?.localizedSynopsis).toBe('Yetenekli bir hırsız, rüyalara sızarak sırları çalar.');
    expect(match?.record.rating).toBe(8.4);
    expect(match?.record.votes).toBe(36_120);
    expect(match?.recommendedTmdbIds).toEqual(['157336', '155']);
  });

  it('splits dual-title IPTV entries ("Local - Original" / "Local / Original") when full string misses', async () => {
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('/3/search/movie') && url.includes('Esaretin+Bedeli+-+The+Shawshank')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('/3/search/movie') && url.includes('query=Esaretin+Bedeli')) {
        return jsonResponse({
          results: [
            {
              id: 278,
              title: 'Esaretin Bedeli',
              original_title: 'The Shawshank Redemption',
              release_date: '1994-09-23',
              vote_count: 27_000,
              popularity: 110,
            },
          ],
        });
      }
      if (url.includes('/3/search/movie') && url.includes('The+Shawshank+Redemption')) {
        return jsonResponse({
          results: [
            {
              id: 278,
              title: 'Esaretin Bedeli',
              original_title: 'The Shawshank Redemption',
              release_date: '1994-09-23',
              vote_count: 27_000,
              popularity: 110,
            },
          ],
        });
      }
      if (url.includes('/3/movie/278?')) {
        return jsonResponse(
          makeTmdbMovieDetail({
            id: 278,
            imdb_id: 'tt0111161',
            original_title: 'The Shawshank Redemption',
            title: 'Esaretin Bedeli',
            release_date: '1994-09-23',
            belongs_to_collection: null,
            external_ids: { imdb_id: 'tt0111161' },
            translations: {
              translations: [
                {
                  iso_639_1: 'en',
                  iso_3166_1: 'US',
                  data: {
                    title: 'The Shawshank Redemption',
                    overview:
                      'Imprisoned in the 1940s for the double murder of his wife and her lover.',
                  },
                },
                {
                  iso_639_1: 'tr',
                  iso_3166_1: 'TR',
                  data: {
                    title: 'Esaretin Bedeli',
                    overview: '',
                  },
                },
              ],
            },
            overview: '',
          }),
        );
      }
      return jsonResponse({ results: [] });
    });

    const result = await searchTmdbMatch(
      'Esaretin Bedeli - The Shawshank Redemption',
      'movie',
      1994,
      'tr',
      { tmdbApiKey: 'test-tmdb-key', fetchFn: fetchMock, nowMs: 1_764_212_100_000 },
    );

    expect(result.match?.record.imdbId).toBe('tt0111161');
    expect(result.match?.record.tmdbId).toBe('278');
    expect(result.match?.localizedTitle).toBe('Esaretin Bedeli');
    expect(result.match?.localizedSynopsis).toBeNull();
    expect(result.match?.record.originalSynopsis).toContain('Imprisoned in the 1940s');
  });

  it('rejects remakes with year mismatch >= 2 and ambiguous remakes when year is null', async () => {
    const fetchMock: ElvFetchFn = async (url) => {
      if (url.includes('/3/search/movie')) {
        return jsonResponse({
          results: [
            {
              id: 841,
              title: 'Dune',
              original_title: 'Dune',
              release_date: '1984-12-14',
              vote_count: 3_100,
              popularity: 45,
            },
            {
              id: 438631,
              title: 'Dune',
              original_title: 'Dune',
              release_date: '2021-09-15',
              vote_count: 12_800,
              popularity: 95,
            },
          ],
        });
      }
      return jsonResponse({});
    };

    const ambiguous = await searchTmdbMatch('Dune', 'movie', null, 'en', {
      tmdbApiKey: 'test-tmdb-key',
      fetchFn: fetchMock,
    });
    expect(ambiguous.match).toBeNull();

    const wrongYear = await searchTmdbMatch('Dune', 'movie', 2024, 'en', {
      tmdbApiKey: 'test-tmdb-key',
      fetchFn: async () =>
        jsonResponse({
          results: [
            {
              id: 841,
              title: 'Dune',
              original_title: 'Dune',
              release_date: '1984-12-14',
              vote_count: 3_100,
            },
          ],
        }),
    });
    expect(wrongYear.match).toBeNull();
  });

  it('supports direct fetchTmdbTitleDetail (0 /find calls) and findAndFetchByImdbId for TV series', async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      seenUrls.push(url);
      if (url.includes('/3/find/tt0903747')) {
        return jsonResponse({
          movie_results: [],
          tv_results: [{ id: 1396 }],
        });
      }
      if (url.includes('/3/tv/1396?')) {
        return jsonResponse({
          id: 1396,
          original_language: 'en',
          original_name: 'Breaking Bad',
          name: 'Breaking Bad',
          first_air_date: '2008-01-20',
          episode_run_time: [47],
          vote_average: 8.9,
          vote_count: 14_500,
          poster_path: '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
          backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
          overview: 'A chemistry teacher turns to manufacturing meth.',
          genres: [
            { id: 18, name: 'Drama' },
            { id: 80, name: 'Crime' },
          ],
          created_by: [{ id: 66633, name: 'Vince Gilligan' }],
          external_ids: { imdb_id: 'tt0903747' },
          credits: { cast: [{ id: 17419, name: 'Bryan Cranston', character: 'Walter White' }] },
          videos: { results: [] },
          recommendations: { results: [] },
          translations: {
            translations: [
              {
                iso_639_1: 'en',
                iso_3166_1: 'US',
                data: {
                  name: 'Breaking Bad',
                  overview: 'A chemistry teacher turns to manufacturing meth.',
                },
              },
            ],
          },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const direct = await fetchTmdbTitleDetail('1396', 'series', 'en', {
      tmdbApiKey: 'test-tmdb-key',
      fetchFn: fetchMock,
      nowMs: 1_764_212_100_000,
    });
    expect(direct.payload?.record.imdbId).toBe('tt0903747');
    expect(direct.payload?.record.tmdbId).toBe('1396');
    expect(direct.payload?.record.director).toBe('Vince Gilligan');
    expect(direct.payload?.record.runtimeMin).toBe(47);
    expect(direct.subrequestsUsed).toBe(1);
    expect(seenUrls.some((u) => u.includes('/3/find/'))).toBe(false);

    const viaFind = await findAndFetchByImdbId('tt0903747', 'en', {
      tmdbApiKey: 'test-tmdb-key',
      fetchFn: fetchMock,
      nowMs: 1_764_212_100_000,
    });
    expect(viaFind.payload?.record.imdbId).toBe('tt0903747');
    expect(viaFind.subrequestsUsed).toBe(2);
  });
});
