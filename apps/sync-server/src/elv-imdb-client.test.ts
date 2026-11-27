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

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
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
  it('calls IMDb suggestion endpoint, filters non-title IDs, and resizes posters to 300px', async () => {
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

describe('fetchImdbTitleDetail', () => {
  it('extracts JSON-LD + __NEXT_DATA__ fields with resized posters, cast portraits, backdrop, trailer, MLT, and franchise', async () => {
    const ldJson = {
      '@type': 'Movie',
      name: 'Inception',
      datePublished: '2010-07-16',
      duration: 'PT2H28M',
      genre: ['Action', 'Adventure', 'Sci-Fi'],
      image: 'https://m.media-amazon.com/images/M/MV5POSTER._V1_FMjpg_UX1000_.jpg',
      description: 'A thief who steals corporate secrets through dream-sharing technology.',
      aggregateRating: { ratingValue: 8.8, ratingCount: 2_550_000 },
      director: [{ '@type': 'Person', name: 'Christopher Nolan' }],
      trailer: {
        thumbnailUrl: 'https://m.media-amazon.com/images/M/MV5BACKDROP._V1_FMjpg_UX1920_.jpg',
      },
    };
    const nextData = {
      props: {
        pageProps: {
          aboveTheFoldData: {
            originalTitleText: { text: 'Inception' },
            titleText: { text: 'Inception' },
            releaseYear: { year: 2010 },
            runtime: { seconds: 8880 },
            ratingsSummary: { aggregateRating: 8.8, voteCount: 2_550_000 },
            genres: { genres: [{ text: 'Action' }, { text: 'Sci-Fi' }] },
            primaryImage: {
              url: 'https://m.media-amazon.com/images/M/MV5POSTER._V1_FMjpg_UX1000_.jpg',
            },
            primaryVideos: {
              edges: [
                {
                  node: {
                    thumbnail: {
                      url: 'https://m.media-amazon.com/images/M/MV5BACKDROP16X9._V1_FMjpg_UX1920_.jpg',
                    },
                    playbackURLs: [
                      {
                        url: 'https://imdb-video.media-imdb.com/vi123/hls.m3u8',
                        videoMimeType: 'M3U8',
                      },
                    ],
                  },
                },
              ],
            },
            plot: {
              plotText: {
                plainText:
                  'A thief who steals corporate secrets through the use of dream-sharing technology is given the inverse task of planting an idea.',
              },
            },
          },
          mainColumnData: {
            cast: {
              edges: [
                {
                  node: {
                    name: {
                      id: 'nm0000138',
                      nameText: { text: 'Leonardo DiCaprio' },
                      primaryImage: {
                        url: 'https://m.media-amazon.com/images/M/MV5LEO._V1_FMjpg_UX800_.jpg',
                      },
                    },
                    characters: [{ name: 'Cobb' }],
                  },
                },
              ],
            },
            moreLikeThisTitles: {
              edges: [
                { node: { id: 'tt0816692' } },
                { node: { id: 'tt0468569' } },
                { node: { id: 'invalid-id' } },
              ],
            },
            directors: [{ credits: [{ name: { nameText: { text: 'Christopher Nolan' } } }] }],
          },
        },
      },
    };
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">${JSON.stringify(ldJson)}</script>
    </head><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
    </body></html>`;

    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      expect(url).toBe('https://www.imdb.com/title/tt1375666/');
      return htmlResponse(html);
    });

    const detail = await fetchImdbTitleDetail('tt1375666', fetchMock);
    expect(detail).not.toBeNull();
    expect(detail?.imdbId).toBe('tt1375666');
    expect(detail?.mediaType).toBe('movie');
    expect(detail?.originalTitle).toBe('Inception');
    expect(detail?.year).toBe(2010);
    expect(detail?.rating).toBe(8.8);
    expect(detail?.votes).toBe(2_550_000);
    expect(detail?.runtimeMin).toBe(148);
    expect(detail?.posterUrl).toBe(
      'https://m.media-amazon.com/images/M/MV5POSTER._V1_QL75_UX300_.jpg',
    );
    expect(detail?.backdropUrl).toBe(
      'https://m.media-amazon.com/images/M/MV5BACKDROP16X9._V1_QL75_UX1280_.jpg',
    );
    expect(detail?.trailerStreamUrl).toBe('https://imdb-video.media-imdb.com/vi123/hls.m3u8');
    expect(detail?.director).toBe('Christopher Nolan');
    expect(detail?.cast).toEqual([
      {
        personId: 'nm0000138',
        name: 'Leonardo DiCaprio',
        character: 'Cobb',
        portraitUrl: 'https://m.media-amazon.com/images/M/MV5LEO._V1_QL75_UX140_.jpg',
      },
    ]);
    expect(detail?.mltImdbIds).toEqual(['tt0816692', 'tt0468569']);
    expect(detail?.originalSynopsis).toContain('dream-sharing technology');
  });

  it('still parses JSON-LD safely when HTML exceeds 512 KB cap and falls back to suggestions on HTTP error', async () => {
    const ldJson = {
      '@type': 'TVSeries',
      name: 'Dark',
      datePublished: '2017-12-01',
      genre: ['Crime', 'Drama', 'Mystery'],
      image: 'https://m.media-amazon.com/images/M/MV5DARK._V1_.jpg',
      description: 'A family saga with a supernatural twist.',
      aggregateRating: { ratingValue: 8.7, ratingCount: 450_000 },
    };
    const bigHtml = `<html><head><script type="application/ld+json">${JSON.stringify(ldJson)}</script></head><body>${'x'.repeat(650 * 1024)}</body></html>`;
    const bigFetch: ElvFetchFn = async () => htmlResponse(bigHtml);

    const parsed = await fetchImdbTitleDetail('tt5753856', bigFetch);
    expect(parsed?.mediaType).toBe('series');
    expect(parsed?.originalTitle).toBe('Dark');
    expect(parsed?.year).toBe(2017);

    // Fallback to suggestion endpoint when IMDb detail page returns 403/202
    const fallbackFetch = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('/title/tt1375666/')) return new Response('blocked', { status: 403 });
      return jsonResponse({
        d: [
          {
            id: 'tt1375666',
            l: 'Inception',
            y: 2010,
            qid: 'movie',
            s: 'Leonardo DiCaprio',
            i: { imageUrl: 'https://m.media-amazon.com/images/M/MV5INC._V1_.jpg' },
          },
        ],
      });
    });
    const fallbackDetail = await fetchImdbTitleDetail('tt1375666', fallbackFetch);
    expect(fallbackDetail?.originalTitle).toBe('Inception');
    expect(fallbackDetail?.year).toBe(2010);
  });

  it('supports optional TMDB fallback seam only when tmdbApiKey is configured', async () => {
    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('imdb.com/title/')) {
        return htmlResponse(
          `<html><head><script type="application/ld+json">${JSON.stringify({
            '@type': 'Movie',
            name: 'The Fellowship of the Ring',
            datePublished: '2001-12-19',
            image: 'https://m.media-amazon.com/images/M/MV5LOTR._V1_.jpg',
          })}</script></head></html>`,
        );
      }
      if (url.includes('api.themoviedb.org/3/find/tt0120737')) {
        return jsonResponse({
          movie_results: [
            {
              id: 120,
              overview: 'A meek Hobbit from the Shire sets out on a journey.',
              backdrop_path: '/lotr-backdrop.jpg',
            },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    });

    const client = createImdbUpstreamClient({ fetchFn: fetchMock, tmdbApiKey: 'test-tmdb-key' });
    const detail = await client.fetchTitleDetail('tt0120737');
    expect(detail?.originalSynopsis).toBe('A meek Hobbit from the Shire sets out on a journey.');
    expect(detail?.backdropUrl).toBe('https://image.tmdb.org/t/p/w1280/lotr-backdrop.jpg');

    // Without tmdbApiKey, TMDB must NEVER be called
    const noTmdbFetch = vi.fn<ElvFetchFn>(async (url) => {
      expect(url).not.toContain('themoviedb.org');
      return htmlResponse(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          '@type': 'Movie',
          name: 'The Fellowship of the Ring',
          datePublished: '2001-12-19',
        })}</script></head></html>`,
      );
    });
    const imdbOnlyClient = createImdbUpstreamClient({ fetchFn: noTmdbFetch });
    const imdbOnlyDetail = await imdbOnlyClient.fetchTitleDetail('tt0120737');
    expect(imdbOnlyDetail?.originalTitle).toBe('The Fellowship of the Ring');
    expect(noTmdbFetch).toHaveBeenCalledTimes(1);
    expect(await imdbOnlyClient.resolveTmdbToImdb('120', 'movie')).toBeNull();
    expect(await fetchImdbTitleDetail('invalid-id', noTmdbFetch)).toBeNull();

    // TMDB external_ids resolution when tmdbApiKey is configured
    const tmdbExtFetch = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('/3/tv/1396/external_ids')) {
        return jsonResponse({ imdb_id: 'tt0903747' });
      }
      return new Response('not found', { status: 404 });
    });
    const tmdbClient = createImdbUpstreamClient({
      fetchFn: tmdbExtFetch,
      tmdbApiKey: 'test-tmdb-key',
    });
    expect(await tmdbClient.resolveTmdbToImdb('1396', 'series')).toBe('tt0903747');
    expect(await tmdbClient.resolveTmdbToImdb('99999', 'movie')).toBeNull();
    expect(await tmdbClient.resolveTmdbToImdb('0', 'movie')).toBeNull();
  });
});

describe('fetchImdbFeeds', () => {
  it('parses IMDb chart JSON-LD ItemLists and tolerates partial upstream failures', async () => {
    const chartHtml = (id: string, name: string, type: 'Movie' | 'TVSeries') =>
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'ItemList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            item: {
              '@type': type,
              url: `https://www.imdb.com/title/${id}/`,
              name,
              image: `https://m.media-amazon.com/images/M/MV5${id}._V1_FMjpg_UX1000_.jpg`,
              aggregateRating: { ratingValue: 8.6 },
              genre: 'Drama, Sci-Fi',
            },
          },
        ],
      })}</script></head></html>`;

    const fetchMock = vi.fn<ElvFetchFn>(async (url) => {
      if (url.includes('/chart/moviemeter/')) {
        return htmlResponse(chartHtml('tt15239678', 'Dune: Part Two', 'Movie'));
      }
      if (url.includes('/chart/tvmeter/')) {
        return htmlResponse(chartHtml('tt0903747', 'Breaking Bad', 'TVSeries'));
      }
      if (url.includes('/chart/top/')) {
        return new Response('rate limited', { status: 503 });
      }
      return htmlResponse(chartHtml('tt5753856', 'Dark', 'TVSeries'));
    });

    const feeds = await fetchImdbFeeds(fetchMock);
    expect(feeds.movieMeter).toHaveLength(1);
    expect(feeds.movieMeter[0]).toEqual({
      imdbId: 'tt15239678',
      title: 'Dune: Part Two',
      mediaType: 'movie',
      year: null,
      rating: 8.6,
      posterUrl: 'https://m.media-amazon.com/images/M/MV5tt15239678._V1_QL75_UX300_.jpg',
      genres: ['Drama', 'Sci-Fi'],
      rank: 1,
    });
    expect(feeds.tvMeter[0]?.mediaType).toBe('series');
    expect(feeds.topPicks).toEqual([]);
    expect(feeds.currentUpcomingTv).toHaveLength(1);
  });
});
