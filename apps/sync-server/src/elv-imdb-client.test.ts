import { describe, expect, it, vi } from 'vitest';
import {
  createImdbUpstreamClient,
  fetchImdbFeeds,
  fetchImdbTitleDetail,
  MIN_MATCH_CONFIDENCE,
  resizeImdbImageUrl,
  scoreImdbCandidate,
  searchImdbSuggestions,
  selectBestImdbMatch,
} from './elv-imdb-client.ts';
import type { ElvFetchFn, ImdbSuggestionCandidate } from './elv-types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resizeImdbImageUrl (SSRF-safe CDN resizer)', () => {
  it('rewrites IMDb/Amazon CDN image URLs cleanly to requested width presets', () => {
    const raw =
      'https://m.media-amazon.com/images/M/MV5BMjAxMzY3NjcxNF5BMl5BanBnXkFtZTcwNTI5OTM0Mw@@._V1_FMjpg_UX1000_.jpg';
    expect(resizeImdbImageUrl(raw, 300)).toBe(
      'https://m.media-amazon.com/images/M/MV5BMjAxMzY3NjcxNF5BMl5BanBnXkFtZTcwNTI5OTM0Mw@@._V1_QL75_UX300_.jpg',
    );
    expect(resizeImdbImageUrl(raw, 140)).toBe(
      'https://m.media-amazon.com/images/M/MV5BMjAxMzY3NjcxNF5BMl5BanBnXkFtZTcwNTI5OTM0Mw@@._V1_QL75_UX140_.jpg',
    );
    expect(resizeImdbImageUrl(raw, 1280)).toBe(
      'https://m.media-amazon.com/images/M/MV5BMjAxMzY3NjcxNF5BMl5BanBnXkFtZTcwNTI5OTM0Mw@@._V1_QL75_UX1280_.jpg',
    );
  });

  it('rejects non-HTTPS, non-IMDb hosts, credentials, private IPs, and custom ports', () => {
    expect(resizeImdbImageUrl('http://m.media-amazon.com/images/M/abc._V1_.jpg', 300)).toBe('');
    expect(resizeImdbImageUrl('https://evil.example/images/M/abc._V1_.jpg', 300)).toBe('');
    expect(resizeImdbImageUrl('https://169.254.169.254/latest/meta-data', 300)).toBe('');
    expect(
      resizeImdbImageUrl('https://user:pass@m.media-amazon.com/images/M/abc._V1_.jpg', 300),
    ).toBe('');
    expect(resizeImdbImageUrl('https://m.media-amazon.com:8443/images/M/abc._V1_.jpg', 300)).toBe(
      '',
    );
    expect(resizeImdbImageUrl('https://m.media-amazon.com.evil.test/a._V1_.jpg', 300)).toBe('');
    expect(resizeImdbImageUrl('not-a-url', 300)).toBe('');
  });
});

describe('scoreImdbCandidate & selectBestImdbMatch (strict confidence scoring)', () => {
  const mkCandidate = (overrides: Partial<ImdbSuggestionCandidate>): ImdbSuggestionCandidate => ({
    imdbId: 'tt1375666',
    title: 'Inception',
    year: 2010,
    mediaType: 'movie',
    qid: 'movie',
    stars: 'Leonardo DiCaprio, Joseph Gordon-Levitt',
    posterUrl: 'https://m.media-amazon.com/images/M/abc._V1_QL75_UX300_.jpg',
    ...overrides,
  });

  it('scores exact title + exact year + matching type at 1.0 and ±1 year above threshold', () => {
    const exact = scoreImdbCandidate(
      { cleanTitle: 'Inception', year: 2010, mediaType: 'movie' },
      mkCandidate({}),
    );
    expect(exact).toBeGreaterThanOrEqual(0.98);

    const offByOne = scoreImdbCandidate(
      { cleanTitle: 'Inception', year: 2011, mediaType: 'movie' },
      mkCandidate({ year: 2010 }),
    );
    expect(offByOne).toBeGreaterThanOrEqual(MIN_MATCH_CONFIDENCE);
    expect(offByOne).toBeLessThan(exact);
  });

  it('handles Turkish diacritics and dotted/dotless I folding accurately', () => {
    const cand = mkCandidate({
      imdbId: 'tt3841424',
      title: 'Kış Uykusu',
      year: 2014,
    });
    const score = scoreImdbCandidate(
      { cleanTitle: 'Kis Uykusu', year: 2014, mediaType: 'movie' },
      cand,
    );
    expect(score).toBeGreaterThanOrEqual(0.95);

    const istanbulCand = mkCandidate({
      imdbId: 'tt1234567',
      title: 'İstanbul Hatırası',
      year: 2005,
    });
    const istanbulScore = scoreImdbCandidate(
      { cleanTitle: 'ISTANBUL HATIRASI', year: 2005, mediaType: 'movie' },
      istanbulCand,
    );
    expect(istanbulScore).toBeGreaterThanOrEqual(0.95);
  });

  it('heavily penalizes year mismatch >= 2 so remakes (1995 vs 2024) NEVER false-merge', () => {
    const remake1995 = mkCandidate({ imdbId: 'tt0113497', title: 'Jumanji', year: 1995 });
    const remake2024 = mkCandidate({ imdbId: 'tt9999999', title: 'Jumanji', year: 2024 });

    expect(
      scoreImdbCandidate({ cleanTitle: 'Jumanji', year: 2024, mediaType: 'movie' }, remake1995),
    ).toBeLessThan(MIN_MATCH_CONFIDENCE);

    expect(
      selectBestImdbMatch({ cleanTitle: 'Jumanji', year: 2024, mediaType: 'movie' }, [remake1995]),
    ).toBeNull();

    const matched = selectBestImdbMatch({ cleanTitle: 'Jumanji', year: 2024, mediaType: 'movie' }, [
      remake1995,
      remake2024,
    ]);
    expect(matched?.candidate.imdbId).toBe('tt9999999');
  });

  it('rejects mediaType mismatch (movie vs series) and sequel mismatches', () => {
    const seriesCand = mkCandidate({
      imdbId: 'tt0903747',
      title: 'Fargo',
      year: 2014,
      mediaType: 'series',
      qid: 'tvSeries',
    });
    expect(
      selectBestImdbMatch({ cleanTitle: 'Fargo', year: 2014, mediaType: 'movie' }, [seriesCand]),
    ).toBeNull();

    const sequelCand = mkCandidate({
      imdbId: 'tt15239678',
      title: 'Dune: Part Two',
      year: 2021,
      mediaType: 'movie',
    });
    expect(
      selectBestImdbMatch({ cleanTitle: 'Dune', year: 2021, mediaType: 'movie' }, [sequelCand]),
    ).toBeNull();
  });
});

describe('searchImdbSuggestions', () => {
  it('calls IMDb suggestion JSON endpoint, filters non-title IDs, and resizes posters to 300px', async () => {
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      expect(url).toBe('https://v3.sg.media-imdb.com/suggestion/x/Inception.json');
      return jsonResponse({
        d: [
          {
            id: 'tt1375666',
            l: 'Inception',
            y: 2010,
            qid: 'movie',
            s: 'Leonardo DiCaprio, Joseph Gordon-Levitt',
            i: {
              imageUrl: 'https://m.media-amazon.com/images/M/MV5BMjAx._V1_FMjpg_UX1000_.jpg',
              width: 1000,
              height: 1500,
            },
          },
          {
            id: 'nm0000138',
            l: 'Leonardo DiCaprio',
            s: 'Actor',
          },
          {
            id: 'tt0903747',
            l: 'Breaking Bad',
            y: 2008,
            qid: 'tvSeries',
            s: 'Bryan Cranston, Aaron Paul',
            i: {
              imageUrl: 'https://evil.example/not-imdb._V1_.jpg',
            },
          },
        ],
      });
    });

    const results = await searchImdbSuggestions('Inception', fetchMock);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      imdbId: 'tt1375666',
      title: 'Inception',
      year: 2010,
      mediaType: 'movie',
      qid: 'movie',
      stars: 'Leonardo DiCaprio, Joseph Gordon-Levitt',
      posterUrl: 'https://m.media-amazon.com/images/M/MV5BMjAx._V1_QL75_UX300_.jpg',
    });
    expect(results[1]?.mediaType).toBe('series');
    expect(results[1]?.posterUrl).toBeNull();
  });

  it('returns empty array gracefully on upstream HTTP failure, network throw, empty query, or malformed JSON', async () => {
    const failFetch: ElvFetchFn = async () => new Response('down', { status: 503 });
    expect(await searchImdbSuggestions('Matrix', failFetch)).toEqual([]);
    expect(await searchImdbSuggestions('   ', failFetch)).toEqual([]);

    const throwFetch: ElvFetchFn = async () => {
      throw new Error('network down');
    };
    expect(await searchImdbSuggestions('Matrix', throwFetch)).toEqual([]);

    const badJsonFetch: ElvFetchFn = async () => new Response('{not json', { status: 200 });
    expect(await searchImdbSuggestions('Matrix', badJsonFetch)).toEqual([]);

    const emptyPayloadFetch: ElvFetchFn = async () => jsonResponse({ ok: true });
    expect(await searchImdbSuggestions('Matrix', emptyPayloadFetch)).toEqual([]);
  });
});

describe('hybrid fetchImdbTitleDetail & createImdbUpstreamClient (zero www.imdb.com HTML scraping)', () => {
  it('uses official TMDB v3 primary when tmdbApiKey is set and falls back cleanly to suggestion JSON when TMDB misses', async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      seenUrls.push(url);
      expect(url).not.toContain('www.imdb.com');
      if (url.includes('/3/find/tt0120737')) {
        return jsonResponse({ movie_results: [{ id: 120 }], tv_results: [] });
      }
      if (url.includes('/3/movie/120?')) {
        return jsonResponse({
          id: 120,
          original_language: 'en',
          original_title: 'The Lord of the Rings: The Fellowship of the Ring',
          title: 'The Lord of the Rings: The Fellowship of the Ring',
          release_date: '2001-12-19',
          runtime: 178,
          vote_average: 8.4,
          vote_count: 25_000,
          poster_path: '/lotr-poster.jpg',
          backdrop_path: '/lotr-backdrop.jpg',
          overview: 'A meek Hobbit from the Shire sets out on a journey.',
          genres: [
            { id: 12, name: 'Adventure' },
            { id: 14, name: 'Fantasy' },
          ],
          external_ids: { imdb_id: 'tt0120737' },
          credits: { crew: [{ name: 'Peter Jackson', job: 'Director' }], cast: [] },
          videos: { results: [] },
          recommendations: { results: [] },
          translations: { translations: [] },
        });
      }
      if (url.includes('/3/find/tt9990001')) {
        return jsonResponse({ movie_results: [], tv_results: [] });
      }
      if (url.includes('v3.sg.media-imdb.com/suggestion/x/tt9990001.json')) {
        return jsonResponse({
          d: [
            {
              id: 'tt9990001',
              l: 'Obscure Festival Short',
              y: 2019,
              qid: 'movie',
              i: { imageUrl: 'https://m.media-amazon.com/images/M/MV5SHORT._V1_.jpg' },
            },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    });

    const client = createImdbUpstreamClient({ fetchFn: fetchMock, tmdbApiKey: 'test-tmdb-key' });
    expect(client.isTmdbEnabled).toBe(true);

    const detail = await client.fetchTitleDetail('tt0120737');
    expect(detail?.tmdbId).toBe('120');
    expect(detail?.originalSynopsis).toBe('A meek Hobbit from the Shire sets out on a journey.');
    expect(detail?.backdropUrl).toBe('https://image.tmdb.org/t/p/w1280/lotr-backdrop.jpg');
    expect(detail?.genres).toEqual(['Adventure', 'Fantasy']);

    // When TMDB misses, falls back to clean JSON suggestion endpoint without HTML scraping
    const fallbackDetail = await client.fetchTitleDetail('tt9990001');
    expect(fallbackDetail?.originalTitle).toBe('Obscure Festival Short');
    expect(fallbackDetail?.tmdbId).toBeNull();
    expect(seenUrls.every((u) => !u.includes('www.imdb.com'))).toBe(true);
  });

  it('without tmdbApiKey never calls themoviedb.org or www.imdb.com and uses suggestion JSON only', async () => {
    const noTmdbFetch = vi.fn<ElvFetchFn>(async (url) => {
      expect(url).not.toContain('themoviedb.org');
      expect(url).not.toContain('www.imdb.com');
      return jsonResponse({
        d: [{ id: 'tt0120737', l: 'The Fellowship of the Ring', y: 2001, qid: 'movie' }],
      });
    });

    const imdbOnlyClient = createImdbUpstreamClient({ fetchFn: noTmdbFetch });
    expect(imdbOnlyClient.isTmdbEnabled).toBe(false);
    const detail = await imdbOnlyClient.fetchTitleDetail('tt0120737');
    expect(detail?.originalTitle).toBe('The Fellowship of the Ring');
    expect(noTmdbFetch).toHaveBeenCalledTimes(1);
    expect(await imdbOnlyClient.resolveTmdbToImdb('120', 'movie')).toBeNull();
    expect(await fetchImdbTitleDetail('invalid-id', noTmdbFetch)).toBeNull();

    // Feeds return empty when tmdbApiKey is unset (no broken www.imdb.com/chart scraping)
    const emptyFeeds = await fetchImdbFeeds(noTmdbFetch);
    expect(emptyFeeds).toEqual({
      topPicks: [],
      movieMeter: [],
      tvMeter: [],
      currentUpcomingTv: [],
    });
    expect(noTmdbFetch).toHaveBeenCalledTimes(1);
  });

  it('resolves TMDB external_ids and TMDB feeds cleanly when tmdbApiKey is configured', async () => {
    const tmdbExtFetch = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('/3/tv/1396/external_ids')) {
        return jsonResponse({ imdb_id: 'tt0903747' });
      }
      if (url.includes('/3/trending/movie/week')) {
        return jsonResponse({
          results: [
            {
              id: 27205,
              title: 'Inception',
              release_date: '2010-07-16',
              vote_average: 8.4,
              genre_ids: [28, 878],
            },
          ],
        });
      }
      if (url.includes('/3/movie/27205/external_ids')) {
        return jsonResponse({ imdb_id: 'tt1375666' });
      }
      return jsonResponse({ results: [] });
    });

    const tmdbClient = createImdbUpstreamClient({
      fetchFn: tmdbExtFetch,
      tmdbApiKey: 'test-tmdb-key',
    });
    expect(await tmdbClient.resolveTmdbToImdb('1396', 'series')).toBe('tt0903747');
    expect(await tmdbClient.resolveTmdbToImdb('99999', 'movie')).toBeNull();
    expect(await tmdbClient.resolveTmdbToImdb('0', 'movie')).toBeNull();

    const feeds = await fetchImdbFeeds(tmdbExtFetch, 'test-tmdb-key');
    expect(feeds.movieMeter).toHaveLength(1);
    expect(feeds.movieMeter[0]?.imdbId).toBe('tt1375666');
    expect(feeds.movieMeter[0]?.genres).toEqual(['Action', 'Sci-Fi']);
  });
});
