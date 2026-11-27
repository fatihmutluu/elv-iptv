import { describe, expect, it, vi } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import {
  createElvCatalogMatcher,
  createElvHttpClient,
  type ElvMatchBatchRequestItem,
  type ElvMetadataClient,
} from './elv-matcher';
import { openCatalog } from './migrate';
import { testDb } from './test-db';

describe('3-Layer Zero-Wait ELV Catalog Matcher & HTTP Client (#511)', () => {
  describe('createElvHttpClient', () => {
    it('rejects insecure or credentialed baseUrls and never leaks URLs/credentials in matchBatch', async () => {
      expect(() => createElvHttpClient({ baseUrl: 'http://evil.example' })).toThrow();
      expect(() => createElvHttpClient({ baseUrl: 'https://user:pass@api.elv.app' })).toThrow();
      expect(() => createElvHttpClient({ baseUrl: 'ftp://api.elv.app' })).toThrow();

      const seenRequests: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seenRequests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        return new Response(
          JSON.stringify({
            matches: {
              'x:s1:movie:1': {
                key: 'x:s1:movie:1',
                imdbId: 'tt1375666',
                confidence: 0.96,
                mediaType: 'movie',
                title: {
                  imdbId: 'tt1375666',
                  tmdbId: 27205,
                  mediaType: 'movie',
                  originalTitle: 'Inception',
                  englishTitle: 'Inception',
                  localizedTitle: 'Başlangıç',
                  year: 2010,
                  rating: 8.8,
                  votes: 2_500_000,
                  runtimeMin: 148,
                  genres: ['Action', 'Sci-Fi'],
                  posterUrl: 'https://m.media-amazon.com/images/M/p._V1_QL75_UX300_.jpg',
                  backdropUrl: null,
                  franchiseKey: null,
                  franchiseName: null,
                  franchiseOrder: null,
                },
              },
            },
            unmatchedKeys: [],
            pendingKeys: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createElvHttpClient({
        baseUrl: 'https://sync.elv-iptv.example/',
        fetchFn,
      });

      const res = await client.matchBatch(
        [
          {
            key: 'x:s1:movie:1',
            cleanTitle: 'Inception https://secret-provider.example/user/pass/123.mp4',
            year: 2010,
            mediaType: 'movie',
            providerTmdbId: '27205',
          },
        ],
        'tr',
      );

      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]?.url).toBe('https://sync.elv-iptv.example/v1/elv/match-batch');
      const sentBody = String(seenRequests[0]?.init?.body ?? '');
      expect(sentBody).not.toContain('https://');
      expect(sentBody).not.toContain('secret-provider');
      expect(res.matches).toHaveLength(1);
      expect(res.matches[0]?.imdbId).toBe('tt1375666');
      expect(res.matches[0]?.title?.tmdbId).toBe('27205');
      expect(res.matches[0]?.title?.localizedTitles).toEqual({ tr: 'Başlangıç' });
    });

    it('fetches title detail, feeds, and search candidates cleanly matching worker contract', async () => {
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/v1/elv/title/tt1375666')) {
          return new Response(
            JSON.stringify({
              imdbId: 'tt1375666',
              tmdbId: '27205',
              mediaType: 'movie',
              originalTitle: 'Inception',
              englishTitle: 'Inception',
              localizedTitle: 'Başlangıç',
              year: 2010,
              rating: 8.8,
              votes: 2_500_000,
              runtimeMin: 148,
              genres: ['Action', 'Sci-Fi'],
              posterUrl: 'https://m.media-amazon.com/images/M/p._V1_QL75_UX300_.jpg',
              backdropUrl: 'https://m.media-amazon.com/images/M/b._V1_QL75_UX1280_.jpg',
              trailerStreamUrl: 'https://imdb-video.media-imdb.com/t.mp4',
              trailerYoutubeId: null,
              director: 'Christopher Nolan',
              cast: [{ personId: 'nm0000138', name: 'Leonardo DiCaprio', character: 'Cobb' }],
              mltImdbIds: ['tt0816692'],
              franchiseKey: null,
              franchiseName: null,
              franchiseOrder: null,
              synopsis: 'Rüya hırsızı Cobb...',
              synopsisLang: 'tr',
              synopsisSource: 'workers-ai',
              updatedAt: 1_700_000_000_000,
            }),
            { status: 200 },
          );
        }
        if (url.includes('/v1/elv/feeds')) {
          return new Response(
            JSON.stringify({
              topPicks: [{ imdbId: 'tt1375666', title: 'Inception', mediaType: 'movie', rank: 1 }],
              movieMeter: [],
              tvMeter: [],
              currentUpcomingTv: [],
              updatedAt: 1_700_000_000_000,
            }),
            { status: 200 },
          );
        }
        if (url.includes('/v1/elv/search')) {
          return new Response(
            JSON.stringify({
              query: 'Inception',
              results: [
                {
                  imdbId: 'tt1375666',
                  title: 'Inception',
                  year: 2010,
                  mediaType: 'movie',
                  posterUrl: 'https://m.media-amazon.com/images/M/p._V1_QL75_UX300_.jpg',
                  stars: 'Leonardo DiCaprio',
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      });

      const client = createElvHttpClient({ baseUrl: 'https://sync.elv-iptv.example', fetchFn });
      expect(await client.fetchTitleDetail('bad-id', 'tr')).toBeNull();
      const detail = await client.fetchTitleDetail('tt1375666', 'tr');
      expect(detail?.tmdbId).toBe('27205');
      expect(detail?.director).toBe('Christopher Nolan');
      expect(detail?.synopses).toEqual({ tr: 'Rüya hırsızı Cobb...' });
      expect(detail?.localizedTitles).toEqual({ tr: 'Başlangıç' });

      const feeds = await client.fetchFeeds();
      expect(feeds?.topPicks).toHaveLength(1);

      const search = await client.searchTitles('Inception', 'movie');
      expect(search).toHaveLength(1);
      expect(search[0]?.imdbId).toBe('tt1375666');
    });

    it('canonicalizes BCP-47 lang casing on the wire (pt-br -> pt-BR, TR -> tr, en_us -> en-US)', async () => {
      const seenUrls: string[] = [];
      const seenBodies: string[] = [];
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seenUrls.push(url);
        if (init?.body !== undefined) seenBodies.push(String(init.body));
        if (url.includes('/v1/elv/match-batch')) {
          return new Response(
            JSON.stringify({
              matches: [
                {
                  key: 'x:s1:movie:1',
                  imdbId: 'tt1375666',
                  confidence: 0.99,
                  mediaType: 'movie',
                  title: {
                    imdbId: 'tt1375666',
                    mediaType: 'movie',
                    originalTitle: 'Inception',
                    localizedTitle: 'A Origem',
                  },
                },
              ],
              unmatchedKeys: [],
              pendingKeys: [],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            imdbId: 'tt1375666',
            mediaType: 'movie',
            originalTitle: 'Inception',
            synopsis: 'Sinopse em português.',
            synopsisLang: 'pt-BR',
          }),
          { status: 200 },
        );
      });

      const client = createElvHttpClient({ baseUrl: 'https://sync.elv-iptv.example', fetchFn });
      const batch = await client.matchBatch(
        [{ key: 'x:s1:movie:1', cleanTitle: 'Inception', mediaType: 'movie' }],
        'pt-br',
      );
      expect(JSON.parse(seenBodies[0] ?? '{}')).toMatchObject({ lang: 'pt-BR' });
      expect(batch.matches[0]?.title?.localizedTitles).toEqual({ 'pt-br': 'A Origem' });

      await client.matchBatch(
        [{ key: 'x:s1:movie:1', cleanTitle: 'Inception', mediaType: 'movie' }],
        'TR',
      );
      expect(JSON.parse(seenBodies[1] ?? '{}')).toMatchObject({ lang: 'tr' });

      const detail = await client.fetchTitleDetail('tt1375666', 'pt-br');
      expect(seenUrls[2]).toBe('https://sync.elv-iptv.example/v1/elv/title/tt1375666?lang=pt-BR');
      expect(detail?.synopses).toEqual({ 'pt-br': 'Sinopse em português.' });

      await client.fetchTitleDetail('tt1375666', 'en_us');
      expect(seenUrls[3]).toBe('https://sync.elv-iptv.example/v1/elv/title/tt1375666?lang=en-US');
    });
  });

  describe('createElvCatalogMatcher (Layers 1, 2, 3)', () => {
    async function seedCatalog() {
      const catalog = testDb();
      expect((await openCatalog(catalog.db)).ok).toBe(true);
      await catalog.db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
      );
      await catalog.db.batch(
        `INSERT INTO movies (source_id, key, name, name_fold, year, provider_imdb_id, provider_tmdb_id, run_id)
         VALUES ('s1', ?, ?, ?, ?, ?, ?, 1)`,
        [
          [
            'x:s1:movie:1',
            'TR: Inception (2010) [4K] NF',
            'tr inception 2010 4k nf',
            2010,
            'tt1375666',
            '27205',
          ],
          [
            'x:s1:movie:2',
            'US | Interstellar (2014) IMAX',
            'us interstellar 2014 imax',
            2014,
            null,
            '157336',
          ],
          [
            'x:s1:movie:3',
            'The Matrix (1999) REMASTERED',
            'the matrix 1999 remastered',
            1999,
            null,
            null,
          ],
          ['x:s1:movie:4', 'Locked Film (2020)', 'locked film 2020', 2020, null, null],
        ],
      );
      await catalog.db.run(
        `INSERT INTO series (source_id, key, name, name_fold, year, provider_imdb_id, provider_tmdb_id, run_id)
         VALUES ('s1', 'x:s1:series:1', 'Dark [NF] (2017)', 'dark nf 2017', 2017, 'tt5753856', '70523', 1)`,
      );

      const enrichment = testDb();
      const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 50_000 });
      await store.setManualMatch('x:s1:movie:4', 's1', 'movie', 'tt9999999');
      return { catalogDb: catalog.db, store };
    }

    it('runs Layer 1 (0 ms provider_imdb_id), Layer 2 (priority viewport + paginated batches), and Layer 3 (incremental skip)', async () => {
      const { catalogDb, store } = await seedCatalog();
      const batchesSent: ElvMatchBatchRequestItem[][] = [];

      const client: ElvMetadataClient = {
        matchBatch: vi.fn(async (items: readonly ElvMatchBatchRequestItem[]) => {
          batchesSent.push([...items]);
          return {
            matches: items.map((item) => {
              const resolvedImdbId =
                item.providerImdbId ??
                (item.cleanTitle === 'Interstellar' ? 'tt0816692' : 'tt0133093');
              return {
                key: item.key,
                imdbId: resolvedImdbId,
                confidence: 0.94,
                mediaType: item.mediaType,
                title: {
                  imdbId: resolvedImdbId,
                  mediaType: item.mediaType,
                  originalTitle: item.cleanTitle,
                  year: item.year ?? null,
                  rating: 8.7,
                  posterUrl: `https://m.media-amazon.com/images/M/${resolvedImdbId}._V1_QL75_UX300_.jpg`,
                },
              };
            }),
            unmatchedKeys: [],
            pendingKeys: [],
          };
        }),
        fetchTitleDetail: vi.fn(async () => null),
        fetchFeeds: vi.fn(async () => null),
        searchTitles: vi.fn(async () => []),
      };

      const matcher = createElvCatalogMatcher({
        catalogDb,
        enrichmentStore: store,
        client,
        now: () => 60_000,
      });

      // Priority viewport enrichment for visible cards (1 Layer-1 with title hydration + 1 Layer-2 + 1 locked)
      const priorityRes = await matcher.enrichPriorityKeys(
        ['x:s1:movie:1', 'x:s1:movie:2', 'x:s1:movie:4'],
        { lang: 'tr' },
      );
      expect(priorityRes.layer1Matched).toBe(1);
      expect(priorityRes.remoteMatched).toBe(1);
      expect(priorityRes.skipped).toBe(1);
      expect((await store.getMatchForKey('x:s1:movie:1'))?.confidence).toBe(1);
      expect((await store.getMatchForKey('x:s1:movie:1'))?.imdbId).toBe('tt1375666');
      // Layer 1 item actually received hydrated IMDb title/poster/rating!
      expect((await store.getTitleByImdbId('tt1375666'))?.posterUrl).toContain('tt1375666');
      expect((await store.getMatchForKey('x:s1:movie:2'))?.imdbId).toBe('tt0816692');
      expect((await store.getMatchForKey('x:s1:movie:4'))?.imdbId).toBe('tt9999999');
      expect(batchesSent[0]).toEqual([
        {
          key: 'x:s1:movie:2',
          cleanTitle: 'Interstellar',
          year: 2014,
          mediaType: 'movie',
          providerTmdbId: '157336',
        },
        {
          key: 'x:s1:movie:1',
          cleanTitle: 'Inception',
          year: 2010,
          mediaType: 'movie',
          providerImdbId: 'tt1375666',
          providerTmdbId: '27205',
        },
      ]);

      // Background matching processes remaining unmatched items + hydrates Layer 1 series:1 title
      const progressEvents: number[] = [];
      const bgRes = await matcher.runBackgroundMatching({
        lang: 'tr',
        batchSize: 2,
        onProgress: (p) => progressEvents.push(p.scanned),
      });
      expect(bgRes.layer1Matched).toBe(1); // x:s1:series:1
      expect(bgRes.remoteMatched).toBe(1); // x:s1:movie:3
      expect(bgRes.skipped).toBeGreaterThanOrEqual(3); // movie:1, movie:2, movie:4 already matched
      expect((await store.getMatchForKey('x:s1:series:1'))?.imdbId).toBe('tt5753856');
      expect((await store.getMatchForKey('x:s1:series:1'))?.confidence).toBe(1);
      expect((await store.getTitleByImdbId('tt5753856'))?.posterUrl).toContain('tt5753856');
      expect((await store.getMatchForKey('x:s1:movie:3'))?.imdbId).toBe('tt0133093');
      expect(progressEvents.length).toBeGreaterThan(0);

      // Layer 3 incremental: second background pass makes ZERO remote matchBatch calls!
      const callsBefore = (client.matchBatch as ReturnType<typeof vi.fn>).mock.calls.length;
      const secondRun = await matcher.runBackgroundMatching({ lang: 'tr', batchSize: 2 });
      expect(secondRun.layer1Matched).toBe(0);
      expect(secondRun.remoteMatched).toBe(0);
      expect((client.matchBatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    it('skips remote hydration for Layer 1 items whose imdb_id already has a cached elv_titles row', async () => {
      const { catalogDb, store } = await seedCatalog();
      await store.upsertTitles([
        {
          imdbId: 'tt1375666',
          mediaType: 'movie',
          originalTitle: 'Inception',
          posterUrl: 'https://m.media-amazon.com/images/M/cached.jpg',
        },
      ]);
      const client: ElvMetadataClient = {
        matchBatch: vi.fn(async () => ({ matches: [], unmatchedKeys: [], pendingKeys: [] })),
        fetchTitleDetail: vi.fn(async () => null),
        fetchFeeds: vi.fn(async () => null),
        searchTitles: vi.fn(async () => []),
      };
      const matcher = createElvCatalogMatcher({ catalogDb, enrichmentStore: store, client });
      const res = await matcher.enrichPriorityKeys(['x:s1:movie:1']);
      expect(res.layer1Matched).toBe(1);
      expect(res.remoteMatched).toBe(0);
      expect(client.matchBatch).not.toHaveBeenCalled();
    });

    it('retries pendingKeys in bounded follow-up rounds for both enrichPriorityKeys and runBackgroundMatching and stops early on zero progress', async () => {
      const catalog = testDb();
      expect((await openCatalog(catalog.db)).ok).toBe(true);
      await catalog.db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
      );
      const rows = Array.from({ length: 25 }, (_, i) => [
        `x:s1:movie:${i + 1}`,
        `Test Film ${i + 1} (2020)`,
        `test film ${i + 1} 2020`,
        2020,
      ]);
      await catalog.db.batch(
        `INSERT INTO movies (source_id, key, name, name_fold, year, run_id)
         VALUES ('s1', ?, ?, ?, ?, 1)`,
        rows,
      );

      // 1) enrichPriorityKeys retries pendingKeys until all 25 items resolve (10 per worker round)
      const enrichment1 = testDb();
      const store1 = await openElvEnrichmentStore(enrichment1.db, { clock: () => 10_000 });
      const chunkedClient = (): ElvMetadataClient => ({
        matchBatch: vi.fn(async (items: readonly ElvMatchBatchRequestItem[]) => {
          const resolved = items.slice(0, 10);
          const pending = items.slice(10);
          return {
            matches: resolved.map((item) => {
              const num = Number(item.key.split(':').pop() ?? '1');
              const imdbId = `tt${String(1000000 + num)}`;
              return {
                key: item.key,
                imdbId,
                confidence: 0.92,
                mediaType: item.mediaType,
                title: { imdbId, mediaType: item.mediaType, originalTitle: item.cleanTitle },
              };
            }),
            unmatchedKeys: [],
            pendingKeys: pending.map((i) => i.key),
          };
        }),
        fetchTitleDetail: vi.fn(async () => null),
        fetchFeeds: vi.fn(async () => null),
        searchTitles: vi.fn(async () => []),
      });

      const prioClient = chunkedClient();
      const matcher1 = createElvCatalogMatcher({
        catalogDb: catalog.db,
        enrichmentStore: store1,
        client: prioClient,
      });
      const prioRes = await matcher1.enrichPriorityKeys(rows.map((r) => String(r[0])));
      expect(prioRes.remoteMatched).toBe(25);
      expect(prioClient.matchBatch).toHaveBeenCalledTimes(3);

      // 2) runBackgroundMatching retries pendingKeys across a full batch instead of dropping uncached items
      const enrichment2 = testDb();
      const store2 = await openElvEnrichmentStore(enrichment2.db, { clock: () => 10_000 });
      const bgClient = chunkedClient();
      const matcher2 = createElvCatalogMatcher({
        catalogDb: catalog.db,
        enrichmentStore: store2,
        client: bgClient,
      });
      const bgRes = await matcher2.runBackgroundMatching({ batchSize: 25 });
      expect(bgRes.remoteMatched).toBe(25);
      expect(bgClient.matchBatch).toHaveBeenCalledTimes(3);

      // 3) No-progress guard breaks immediately instead of looping infinitely
      const enrichment3 = testDb();
      const store3 = await openElvEnrichmentStore(enrichment3.db, { clock: () => 10_000 });
      const stuckClient: ElvMetadataClient = {
        matchBatch: vi.fn(async (items: readonly ElvMatchBatchRequestItem[]) => ({
          matches: [],
          unmatchedKeys: [],
          pendingKeys: items.map((i) => i.key),
        })),
        fetchTitleDetail: vi.fn(async () => null),
        fetchFeeds: vi.fn(async () => null),
        searchTitles: vi.fn(async () => []),
      };
      const matcher3 = createElvCatalogMatcher({
        catalogDb: catalog.db,
        enrichmentStore: store3,
        client: stuckClient,
      });
      const stuckRes = await matcher3.enrichPriorityKeys(['x:s1:movie:1', 'x:s1:movie:2']);
      expect(stuckRes.remoteMatched).toBe(0);
      expect(stuckClient.matchBatch).toHaveBeenCalledTimes(1);
    });

    it('respects AbortSignal cleanly during background matching', async () => {
      const { catalogDb, store } = await seedCatalog();
      const ac = new AbortController();
      ac.abort();

      const client: ElvMetadataClient = {
        matchBatch: vi.fn(async () => ({ matches: [], unmatchedKeys: [], pendingKeys: [] })),
        fetchTitleDetail: vi.fn(async () => null),
        fetchFeeds: vi.fn(async () => null),
        searchTitles: vi.fn(async () => []),
      };

      const matcher = createElvCatalogMatcher({ catalogDb, enrichmentStore: store, client });
      const res = await matcher.runBackgroundMatching({ signal: ac.signal });
      expect(res.aborted).toBe(true);
      expect(client.matchBatch).not.toHaveBeenCalled();
    });

    it('runs offline Layer 1 matching (provider_imdb_id + cached tmdb_id) when client is undefined and supports dynamic getClient activation', async () => {
      const { catalogDb, store } = await seedCatalog();
      // Cache Interstellar in local elv_titles with tmdbId so Layer 1 can match x:s1:movie:2 offline via tmdb_id!
      await store.upsertTitles([
        {
          imdbId: 'tt0816692',
          tmdbId: '157336',
          mediaType: 'movie',
          originalTitle: 'Interstellar',
          year: 2014,
        },
      ]);

      let activeClient: ElvMetadataClient | undefined;
      const matcher = createElvCatalogMatcher({
        catalogDb,
        enrichmentStore: store,
        getClient: () => activeClient,
        now: () => 80_000,
      });

      // Offline priority matching: x:s1:movie:1 via provider_imdb_id, x:s1:movie:2 via cached tmdb_id
      const offlinePrio = await matcher.enrichPriorityKeys(['x:s1:movie:1', 'x:s1:movie:2']);
      expect(offlinePrio.layer1Matched).toBe(2);
      expect(offlinePrio.remoteMatched).toBe(0);
      expect((await store.getMatchForKey('x:s1:movie:1'))?.imdbId).toBe('tt1375666');
      expect((await store.getMatchForKey('x:s1:movie:2'))?.imdbId).toBe('tt0816692');

      // Offline background matching still matches series:1 via provider_imdb_id without network
      const offlineBg = await matcher.runBackgroundMatching({ batchSize: 10 });
      expect(offlineBg.layer1Matched).toBe(1);
      expect(offlineBg.remoteMatched).toBe(0);
      expect((await store.getMatchForKey('x:s1:series:1'))?.imdbId).toBe('tt5753856');

      // Now configure server URL dynamically -> background matching resolves remaining x:s1:movie:3 remotely
      activeClient = {
        matchBatch: vi.fn(async (items: readonly ElvMatchBatchRequestItem[]) => ({
          matches: items.map((item) => ({
            key: item.key,
            imdbId: item.providerImdbId ?? 'tt0133093',
            confidence: 0.94,
            mediaType: item.mediaType,
            title: {
              imdbId: item.providerImdbId ?? 'tt0133093',
              mediaType: item.mediaType,
              originalTitle: item.cleanTitle,
            },
          })),
          unmatchedKeys: [],
          pendingKeys: [],
        })),
        fetchTitleDetail: vi.fn(async () => null),
        fetchFeeds: vi.fn(async () => null),
        searchTitles: vi.fn(async () => []),
      };

      const onlineBg = await matcher.runBackgroundMatching({ batchSize: 10 });
      expect(onlineBg.remoteMatched).toBe(1);
      expect((await store.getMatchForKey('x:s1:movie:3'))?.imdbId).toBe('tt0133093');
    });
  });
});
