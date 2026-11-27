import { describe, expect, it, vi } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import type {
  ElvFeedsPayload,
  ElvTitleRecord,
  ElvUpstreamClient,
  ImdbSuggestionCandidate,
  WorkersAiBinding,
} from './elv-types.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'wave-e1-test-jwt-secret-at-least-32-chars-long';

function makeTitleRecord(overrides: Partial<ElvTitleRecord> = {}): ElvTitleRecord {
  return {
    imdbId: 'tt1375666',
    mediaType: 'movie',
    originalTitle: 'Inception',
    englishTitle: 'Inception',
    year: 2010,
    rating: 8.8,
    votes: 2_550_000,
    runtimeMin: 148,
    genres: ['Action', 'Adventure', 'Sci-Fi'],
    posterUrl: 'https://m.media-amazon.com/images/M/MV5INC._V1_QL75_UX300_.jpg',
    backdropUrl: 'https://m.media-amazon.com/images/M/MV5INCBG._V1_QL75_UX1280_.jpg',
    trailerStreamUrl: 'https://imdb-video.media-imdb.com/vi123/hls.m3u8',
    trailerYoutubeId: null,
    director: 'Christopher Nolan',
    cast: [
      {
        personId: 'nm0000138',
        name: 'Leonardo DiCaprio',
        character: 'Cobb',
        portraitUrl: 'https://m.media-amazon.com/images/M/MV5LEO._V1_QL75_UX140_.jpg',
      },
    ],
    mltImdbIds: ['tt0816692', 'tt0468569'],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    originalSynopsis:
      'A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea.',
    updatedAt: 1_764_212_100_000,
    ...overrides,
  };
}

function makeMockUpstream(
  overrides: Partial<{
    searchSuggestions: ElvUpstreamClient['searchSuggestions'];
    fetchTitleDetail: ElvUpstreamClient['fetchTitleDetail'];
    fetchFeeds: ElvUpstreamClient['fetchFeeds'];
    resolveTmdbToImdb: ElvUpstreamClient['resolveTmdbToImdb'];
  }> = {},
) {
  const searchSuggestions = vi.fn<ElvUpstreamClient['searchSuggestions']>(
    overrides.searchSuggestions ??
      (async (query): Promise<readonly ImdbSuggestionCandidate[]> => {
        if (query.toLowerCase().includes('inception')) {
          return [
            {
              imdbId: 'tt1375666',
              title: 'Inception',
              year: 2010,
              mediaType: 'movie',
              qid: 'movie',
              stars: 'Leonardo DiCaprio, Joseph Gordon-Levitt',
              posterUrl: 'https://m.media-amazon.com/images/M/MV5INC._V1_QL75_UX300_.jpg',
            },
          ];
        }
        if (query.toLowerCase().includes('jumanji')) {
          return [
            {
              imdbId: 'tt0113497',
              title: 'Jumanji',
              year: 1995,
              mediaType: 'movie',
              qid: 'movie',
              stars: 'Robin Williams',
              posterUrl: 'https://m.media-amazon.com/images/M/MV5JUM._V1_QL75_UX300_.jpg',
            },
          ];
        }
        return [];
      }),
  );

  const fetchTitleDetail = vi.fn<ElvUpstreamClient['fetchTitleDetail']>(
    overrides.fetchTitleDetail ??
      (async (imdbId) => {
        if (imdbId === 'tt1375666') return makeTitleRecord();
        return null;
      }),
  );

  const defaultFeeds: ElvFeedsPayload = {
    topPicks: [
      {
        imdbId: 'tt0111161',
        title: 'The Shawshank Redemption',
        mediaType: 'movie',
        year: 1994,
        rating: 9.3,
        posterUrl: 'https://m.media-amazon.com/images/M/MV5SHAW._V1_QL75_UX300_.jpg',
        genres: ['Drama'],
        rank: 1,
      },
    ],
    movieMeter: [
      {
        imdbId: 'tt15239678',
        title: 'Dune: Part Two',
        mediaType: 'movie',
        year: 2024,
        rating: 8.5,
        posterUrl: 'https://m.media-amazon.com/images/M/MV5DUNE2._V1_QL75_UX300_.jpg',
        genres: ['Sci-Fi'],
        rank: 1,
      },
    ],
    tvMeter: [
      {
        imdbId: 'tt0903747',
        title: 'Breaking Bad',
        mediaType: 'series',
        year: 2008,
        rating: 9.5,
        posterUrl: 'https://m.media-amazon.com/images/M/MV5BB._V1_QL75_UX300_.jpg',
        genres: ['Crime', 'Drama'],
        rank: 1,
      },
    ],
    currentUpcomingTv: [
      {
        imdbId: 'tt5753856',
        title: 'Dark',
        mediaType: 'series',
        year: 2017,
        rating: 8.7,
        posterUrl: 'https://m.media-amazon.com/images/M/MV5DARK._V1_QL75_UX300_.jpg',
        genres: ['Sci-Fi', 'Mystery'],
        rank: 1,
      },
    ],
  };

  const fetchFeeds = vi.fn<ElvUpstreamClient['fetchFeeds']>(
    overrides.fetchFeeds ?? (async () => defaultFeeds),
  );

  const resolveTmdbToImdb = vi.fn<ElvUpstreamClient['resolveTmdbToImdb']>(
    overrides.resolveTmdbToImdb ?? (async () => null),
  );

  return {
    client: {
      searchSuggestions,
      fetchTitleDetail,
      fetchFeeds,
      resolveTmdbToImdb,
    } satisfies ElvUpstreamClient,
    spies: { searchSuggestions, fetchTitleDetail, fetchFeeds, resolveTmdbToImdb },
  };
}

function createTestApp(overrides: Partial<SyncAppConfig> = {}) {
  const storage = overrides.storage ?? createMemoryStorage();
  let currentMs = 1_764_212_100_000;
  const { client: elvUpstream, spies } = makeMockUpstream();
  const app = createSyncApp({
    storage,
    jwtSecret: TEST_JWT_SECRET,
    now: () => currentMs,
    elvUpstream,
    ...overrides,
  });
  return {
    app,
    storage,
    spies,
    advanceMs: (deltaMs: number) => {
      currentMs += deltaMs;
    },
  };
}

describe('Wave E1 /v1/elv/* Cloudflare Worker routes', () => {
  describe('POST /v1/elv/match-batch', () => {
    it('serves collective cache hits with 0 upstream fetches on the 2nd user and sets private Cache-Control', async () => {
      const { app, spies } = createTestApp();

      // User 1 matches Inception -> 1 upstream suggestion fetch
      const req1 = new Request('https://sync.example.test/v1/elv/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ key: 'movie:srcA:1', cleanTitle: 'Inception', year: 2010, mediaType: 'movie' }],
          lang: 'en',
        }),
      });
      const res1 = await app.fetch(req1, { clientIp: '198.51.100.1' });
      expect(res1.status).toBe(200);
      expect(res1.headers.get('cache-control')).toBe('private, max-age=60');
      const body1 = (await res1.json()) as {
        matches: Record<
          string,
          { imdbId: string; confidence: number; title: { posterUrl: string } }
        >;
        unmatchedKeys: string[];
        pendingKeys: string[];
      };
      expect(body1.matches['movie:srcA:1']?.imdbId).toBe('tt1375666');
      expect(body1.matches['movie:srcA:1']?.confidence).toBeGreaterThanOrEqual(0.95);
      expect(body1.matches['movie:srcA:1']?.title.posterUrl).toContain('_UX300_.jpg');
      expect(body1.unmatchedKeys).toEqual([]);
      expect(body1.pendingKeys).toEqual([]);
      expect(spies.searchSuggestions).toHaveBeenCalledTimes(1);

      // User 2 requests the same movie with a different local key -> 0 upstream fetches!
      const req2 = new Request('https://sync.example.test/v1/elv/match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { key: 'movie:srcB:99', cleanTitle: 'Inception', year: 2010, mediaType: 'movie' },
          ],
          lang: 'en',
        }),
      });
      const res2 = await app.fetch(req2, { clientIp: '198.51.100.2' });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        matches: Record<string, { imdbId: string }>;
      };
      expect(body2.matches['movie:srcB:99']?.imdbId).toBe('tt1375666');
      expect(spies.searchSuggestions).toHaveBeenCalledTimes(1);
    });

    it('rejects remake year-mismatch (1995 vs 2024) cleanly without false merges', async () => {
      const { app } = createTestApp();
      const res = await app.fetch(
        new Request('https://sync.example.test/v1/elv/match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              { key: 'movie:src1:j24', cleanTitle: 'Jumanji', year: 2024, mediaType: 'movie' },
            ],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matches: Record<string, unknown>;
        unmatchedKeys: string[];
        pendingKeys: string[];
      };
      expect(body.matches['movie:src1:j24']).toBeUndefined();
      expect(body.unmatchedKeys).toEqual(['movie:src1:j24']);
      expect(body.pendingKeys).toEqual([]);
    });

    it('strictly rejects provider URLs, credentials, disallowed keys, and oversized titles (400)', async () => {
      const { app } = createTestApp();
      const badPayloads = [
        {
          items: [
            {
              key: 'm1',
              cleanTitle: 'http://provider.iptv.example/live/user/pass/1.ts',
              mediaType: 'movie',
            },
          ],
        },
        {
          items: [
            {
              key: 'm1',
              cleanTitle: 'Inception',
              mediaType: 'movie',
              serverUrl: 'https://provider.example',
            },
          ],
        },
        {
          items: [
            {
              key: 'm1',
              cleanTitle: 'Inception',
              mediaType: 'movie',
              password: 'secret',
            },
          ],
        },
        {
          items: [{ key: 'm1', cleanTitle: 'Inception', mediaType: 'movie' }],
          m3uUrl: 'https://provider.example/get.php?username=a&password=b',
        },
        {
          items: [{ key: 'm1', cleanTitle: 'A'.repeat(201), mediaType: 'movie' }],
        },
        {
          items: [],
        },
      ];

      for (const payload of badPayloads) {
        const res = await app.fetch(
          new Request('https://sync.example.test/v1/elv/match-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        );
        expect(res.status, `Expected 400 for payload ${JSON.stringify(payload)}`).toBe(400);
      }
    });

    it('enforces subrequest cap (<= 25 upstream lookups per batch) and returns overflow in pendingKeys', async () => {
      const { client, spies } = makeMockUpstream({
        searchSuggestions: async (query) => {
          const num = /\d+/.exec(query)?.[0] ?? '1';
          const padded = num.padStart(7, '0');
          return [
            {
              imdbId: `tt${padded}`,
              title: query,
              year: 2020,
              mediaType: 'movie',
              qid: 'movie',
              stars: null,
              posterUrl: null,
            },
          ];
        },
      });
      const { app } = createTestApp({ elvUpstream: client });

      const items = Array.from({ length: 40 }, (_, i) => ({
        key: `movie:src1:${i + 1}`,
        cleanTitle: `Unique Cinema Film ${i + 1}`,
        year: 2020,
        mediaType: 'movie' as const,
      }));

      const res = await app.fetch(
        new Request('https://sync.example.test/v1/elv/match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matches: Record<string, { imdbId: string }>;
        unmatchedKeys: string[];
        pendingKeys: string[];
      };
      expect(spies.searchSuggestions.mock.calls.length).toBeLessThanOrEqual(25);
      expect(Object.keys(body.matches)).toHaveLength(25);
      expect(body.pendingKeys).toHaveLength(15);
    });
  });

  describe('GET /v1/elv/title/:imdbId (Workers AI permanent translation cache)', () => {
    it('translates once per (imdb_id, lang) across 5 requests, calls AI 0x for lang=en, and sets edge Cache-Control', async () => {
      const run = vi.fn<WorkersAiBinding['run']>(async () => ({
        response: 'Kurumsal sırları rüyalar aracılığıyla çalan yetenekli bir hırsızın hikayesi.',
      }));
      const ai: WorkersAiBinding = { run };
      const { app, spies } = createTestApp({ ai });

      // English request -> 0 AI calls, 1 upstream detail fetch
      const enRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=en'),
      );
      expect(enRes.status).toBe(200);
      expect(enRes.headers.get('cache-control')).toBe('public, max-age=86400');
      const enBody = (await enRes.json()) as {
        synopsis: string;
        synopsisSource: string;
        synopsisLang: string;
        cast: unknown[];
      };
      expect(enBody.synopsis).toContain('dream-sharing technology');
      expect(enBody.synopsisSource).toBe('original');
      expect(enBody.synopsisLang).toBe('en');
      expect(enBody.cast).toHaveLength(1);
      expect(run).toHaveBeenCalledTimes(0);
      expect(spies.fetchTitleDetail).toHaveBeenCalledTimes(1);

      // 5 consecutive Turkish requests -> AI called ONCE ever, upstream detail called 0 extra times!
      for (let i = 0; i < 5; i += 1) {
        const trRes = await app.fetch(
          new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=tr'),
        );
        expect(trRes.status).toBe(200);
        const trBody = (await trRes.json()) as {
          synopsis: string;
          synopsisSource: string;
          synopsisLang: string;
        };
        expect(trBody.synopsis).toBe(
          'Kurumsal sırları rüyalar aracılığıyla çalan yetenekli bir hırsızın hikayesi.',
        );
        expect(trBody.synopsisSource).toBe('workers_ai');
        expect(trBody.synopsisLang).toBe('tr');
      }
      expect(run).toHaveBeenCalledTimes(1);
      expect(spies.fetchTitleDetail).toHaveBeenCalledTimes(1);
    });

    it('falls back gracefully to English synopsis when Workers AI fails and retries cleanly once recovered', async () => {
      let shouldFail = true;
      const run = vi.fn<WorkersAiBinding['run']>(async () => {
        if (shouldFail) throw new Error('AI outage');
        return { response: 'Başarılı Türkçe özet metni.' };
      });
      const { app } = createTestApp({ ai: { run } });

      const fallbackRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=tr'),
      );
      expect(fallbackRes.status).toBe(200);
      const fallbackBody = (await fallbackRes.json()) as {
        synopsis: string;
        synopsisSource: string;
      };
      expect(fallbackBody.synopsis).toContain('dream-sharing technology');
      expect(fallbackBody.synopsisSource).toBe('fallback_en');

      // Once AI recovers, next request translates and permanently caches!
      shouldFail = false;
      const recoveredRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=tr'),
      );
      expect(recoveredRes.status).toBe(200);
      const recoveredBody = (await recoveredRes.json()) as {
        synopsis: string;
        synopsisSource: string;
      };
      expect(recoveredBody.synopsis).toBe('Başarılı Türkçe özet metni.');
      expect(recoveredBody.synopsisSource).toBe('workers_ai');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('strictly validates imdbId and lang parameters and returns 404 for unknown titles', async () => {
      const { app } = createTestApp();
      expect(
        (await app.fetch(new Request('https://sync.example.test/v1/elv/title/bad-id'))).status,
      ).toBe(400);
      expect(
        (await app.fetch(new Request('https://sync.example.test/v1/elv/title/tt123'))).status,
      ).toBe(400);
      expect(
        (
          await app.fetch(
            new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=bad_lang'),
          )
        ).status,
      ).toBe(400);
      expect(
        (await app.fetch(new Request('https://sync.example.test/v1/elv/title/tt9999999'))).status,
      ).toBe(404);
    });
  });

  describe('GET /v1/elv/feeds and GET /v1/elv/search', () => {
    it('caches feeds, sets public stale-while-revalidate Cache-Control, and retains stale cache on upstream outage', async () => {
      let outage = false;
      const { client, spies } = makeMockUpstream({
        fetchFeeds: async () => {
          if (outage) {
            return { topPicks: [], movieMeter: [], tvMeter: [], currentUpcomingTv: [] };
          }
          return {
            topPicks: [
              {
                imdbId: 'tt0111161',
                title: 'The Shawshank Redemption',
                mediaType: 'movie',
                year: 1994,
                rating: 9.3,
                posterUrl: null,
                genres: ['Drama'],
                rank: 1,
              },
            ],
            movieMeter: [
              {
                imdbId: 'tt15239678',
                title: 'Dune: Part Two',
                mediaType: 'movie',
                year: 2024,
                rating: 8.5,
                posterUrl: null,
                genres: ['Sci-Fi'],
                rank: 1,
              },
            ],
            tvMeter: [
              {
                imdbId: 'tt0903747',
                title: 'Breaking Bad',
                mediaType: 'series',
                year: 2008,
                rating: 9.5,
                posterUrl: null,
                genres: ['Drama'],
                rank: 1,
              },
            ],
            currentUpcomingTv: [
              {
                imdbId: 'tt5753856',
                title: 'Dark',
                mediaType: 'series',
                year: 2017,
                rating: 8.7,
                posterUrl: null,
                genres: ['Mystery'],
                rank: 1,
              },
            ],
          };
        },
      });
      const { app, advanceMs } = createTestApp({ elvUpstream: client });

      const res1 = await app.fetch(new Request('https://sync.example.test/v1/elv/feeds'));
      expect(res1.status).toBe(200);
      expect(res1.headers.get('cache-control')).toBe(
        'public, max-age=3600, stale-while-revalidate=86400',
      );
      const feeds1 = (await res1.json()) as { topPicks: unknown[]; movieMeter: unknown[] };
      expect(feeds1.topPicks).toHaveLength(1);
      expect(spies.fetchFeeds).toHaveBeenCalledTimes(1);

      // Fresh cache hit -> 0 upstream calls
      const res2 = await app.fetch(new Request('https://sync.example.test/v1/elv/feeds'));
      expect(res2.status).toBe(200);
      expect(spies.fetchFeeds).toHaveBeenCalledTimes(1);

      // Advance past 6h TTL with upstream outage -> retains stale cached items!
      outage = true;
      advanceMs(7 * 60 * 60 * 1000);
      const res3 = await app.fetch(new Request('https://sync.example.test/v1/elv/feeds'));
      expect(res3.status).toBe(200);
      const feeds3 = (await res3.json()) as { topPicks: unknown[]; movieMeter: unknown[] };
      expect(feeds3.topPicks).toHaveLength(1);
      expect(feeds3.movieMeter).toHaveLength(1);
      expect(spies.fetchFeeds).toHaveBeenCalledTimes(2);
    });

    it('serves Fix-Match search with validation, type filtering, 12-item cap, and dedicated rate limiting', async () => {
      const { app } = createTestApp({
        rateLimits: { elvSearch: { windowMs: 60_000, maxRequests: 2 } },
      });

      const okRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/search?q=Inception&type=movie'),
        { clientIp: '203.0.113.10' },
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('cache-control')).toBe('public, max-age=300');
      const okBody = (await okRes.json()) as { results: Array<{ imdbId: string }> };
      expect(okBody.results).toHaveLength(1);
      expect(okBody.results[0]?.imdbId).toBe('tt1375666');

      // Invalid query (URL injection / invalid type) -> 400
      const badRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/search?q=https://provider.example/x'),
        { clientIp: '203.0.113.10' },
      );
      expect(badRes.status).toBe(400);

      // 3rd request from same IP hits elvSearch rate limit -> 429
      const limitedRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/search?q=Inception'),
        { clientIp: '203.0.113.10' },
      );
      expect(limitedRes.status).toBe(429);
      expect(limitedRes.headers.get('retry-after')).toBeTruthy();
    });

    it('resolves providerImdbId, providerTmdbId, localized titles in match-batch, and rejects invalid item fields', async () => {
      const { client } = makeMockUpstream({
        resolveTmdbToImdb: async (tmdbId) => (tmdbId === '27205' ? 'tt1375666' : null),
      });
      const { app, storage } = createTestApp({
        elvUpstream: client,
        tmdbApiKey: 'test-tmdb-key',
      });

      // Seed full detail + Turkish localized title, then verify stub upsert preserves full detail
      await storage.upsertElvTitle(makeTitleRecord());
      await storage.upsertElvTitle({
        ...makeTitleRecord(),
        cast: [],
        genres: [],
        originalSynopsis: null,
        director: null,
        posterUrl: null,
      });
      expect((await storage.getElvTitle('tt1375666'))?.cast).toHaveLength(1);
      await storage.upsertElvLocalizedSynopsis({
        imdbId: 'tt1375666',
        lang: 'tr',
        localizedTitle: 'Başlangıç',
        synopsis: 'Rüya hırsızı.',
        source: 'workers_ai',
        updatedAt: 1_764_212_100_000,
      });

      const res = await app.fetch(
        new Request('https://sync.example.test/v1/elv/match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lang: 'tr',
            items: [
              {
                key: 'm:direct',
                cleanTitle: 'Inception',
                year: 2010,
                mediaType: 'movie',
                providerImdbId: 'TT1375666',
              },
              {
                key: 'm:tmdb',
                cleanTitle: 'Baslangic',
                year: 2010,
                mediaType: 'movie',
                providerTmdbId: 27205,
              },
            ],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matches: Record<string, { imdbId: string; title: { localizedTitle: string | null } }>;
      };
      expect(body.matches['m:direct']?.imdbId).toBe('tt1375666');
      expect(body.matches['m:direct']?.title.localizedTitle).toBe('Başlangıç');
      expect(body.matches['m:tmdb']?.imdbId).toBe('tt1375666');

      // Edge validation cases: invalid year, invalid provider IDs, disallowed fields, bad URL encoding, invalid search type
      const extraInvalid = [
        { items: [{ key: 'k1', cleanTitle: 'Ok', mediaType: 'movie', year: 1800 }] },
        { items: [{ key: 'k1', cleanTitle: 'Ok', mediaType: 'movie', providerImdbId: 'bad' }] },
        { items: [{ key: 'k1', cleanTitle: 'Ok', mediaType: 'movie', providerTmdbId: 0 }] },
        { items: [{ key: 'k1', cleanTitle: 'Ok', mediaType: 'anime' }] },
        { items: [{ key: 'k1', cleanTitle: 'Ok', mediaType: 'movie', extraField: true }] },
        { items: [{ key: 'https://bad.url', cleanTitle: 'Ok', mediaType: 'movie' }] },
        { items: 'not-array' },
      ];
      for (const bad of extraInvalid) {
        const badRes = await app.fetch(
          new Request('https://sync.example.test/v1/elv/match-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bad),
          }),
        );
        expect(badRes.status).toBe(400);
      }

      expect(
        (await app.fetch(new Request('https://sync.example.test/v1/elv/search?q=Ok&type=anime')))
          .status,
      ).toBe(400);
      expect((await app.fetch(new Request('https://sync.example.test/v1/elv/search'))).status).toBe(
        400,
      );
      expect(
        (await app.fetch(new Request('https://sync.example.test/v1/elv/title/tt1375666/nested')))
          .status,
      ).toBe(404);
    });
  });
});
