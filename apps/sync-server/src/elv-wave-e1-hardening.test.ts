import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createSyncApp } from './app.ts';
import { parseImdbTitleHtml, scoreImdbCandidate, selectBestImdbMatch } from './elv-imdb-parser.ts';
import type {
  ElvTitleRecord,
  ElvUpstreamClient,
  ImdbSuggestionCandidate,
  WorkersAiBinding,
} from './elv-types.ts';
import {
  buildMatchLookupKey,
  foldTitleForMatch,
  validateElvLang,
  validateElvMatchBatchInput,
} from './elv-validation.ts';
import { createD1Storage } from './storage-d1.ts';
import type { D1Database, D1PreparedStatement, D1Result } from './storage-d1-types.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'wave-e1-hardening-test-secret-at-least-32-chars';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function makeTitle(overrides: Partial<ElvTitleRecord> = {}): ElvTitleRecord {
  return {
    imdbId: 'tt6751668',
    mediaType: 'movie',
    originalTitle: 'Gisaengchung',
    englishTitle: 'Parasite',
    year: 2019,
    rating: 8.5,
    votes: 1_000_000,
    runtimeMin: 132,
    genres: ['Drama', 'Thriller'],
    posterUrl: 'https://m.media-amazon.com/images/M/MV5PARASITE._V1_QL75_UX300_.jpg',
    backdropUrl: 'https://m.media-amazon.com/images/M/MV5PARASITEBG._V1_QL75_UX1280_.jpg',
    trailerStreamUrl: 'https://imdb-video.media-imdb.com/vi6751668/hls.m3u8',
    trailerYoutubeId: null,
    director: 'Bong Joon Ho',
    cast: [
      {
        personId: 'nm0814280',
        name: 'Song Kang-ho',
        character: 'Ki Taek',
        portraitUrl: null,
      },
    ],
    mltImdbIds: ['tt0364569'],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    originalSynopsis: 'Greed and class discrimination threaten a symbiotic relationship.',
    updatedAt: 1_764_212_100_000,
    ...overrides,
  };
}

function makeStubTitle(overrides: Partial<ElvTitleRecord> = {}): ElvTitleRecord {
  return {
    imdbId: 'tt6751668',
    mediaType: 'movie',
    originalTitle: 'Parasite',
    englishTitle: 'Parasite',
    year: 2019,
    rating: null,
    votes: null,
    runtimeMin: null,
    genres: [],
    posterUrl: 'https://m.media-amazon.com/images/M/MV5PARASITE._V1_QL75_UX300_.jpg',
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
    updatedAt: 1_764_212_200_000,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<ImdbSuggestionCandidate>): ImdbSuggestionCandidate {
  return {
    imdbId: 'tt1160419',
    title: 'Dune',
    year: 2021,
    mediaType: 'movie',
    qid: 'movie',
    stars: 'Timothée Chalamet',
    posterUrl: 'https://m.media-amazon.com/images/M/MV5DUNE._V1_QL75_UX300_.jpg',
    ...overrides,
  };
}

function createInstrumentedD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const name of [
    '0001_init.sql',
    '0002_wave_p9_pairing_telemetry.sql',
    '0003_wave_e1_elv_metadata.sql',
  ]) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }

  let rpcCount = 0;
  let batchCalls = 0;
  const bindCounts: Array<{ readonly sql: string; readonly count: number }> = [];
  const stmtKind = new WeakMap<D1PreparedStatement, 'select' | 'write'>();

  function toParams(values: readonly unknown[]): SQLInputValue[] {
    return values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
      if (v instanceof Uint8Array) return v;
      return String(v);
    });
  }

  function makeStatement(query: string, bound: unknown[] = []): D1PreparedStatement {
    const trimmed = query.trim();
    const isSelect = /^SELECT\b/i.test(trimmed);
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return makeStatement(query, values);
      },
      async first<T>() {
        rpcCount += 1;
        bindCounts.push({ sql: trimmed, count: bound.length });
        const row = sqlite.prepare(query).get(...toParams(bound));
        return (row ? { ...row } : null) as T | null;
      },
      async all<T>() {
        rpcCount += 1;
        bindCounts.push({ sql: trimmed, count: bound.length });
        const rows = sqlite
          .prepare(query)
          .all(...toParams(bound))
          .map((r) => ({ ...r })) as T[];
        return { success: true, results: rows, meta: { changes: 0 } };
      },
      async run() {
        rpcCount += 1;
        bindCounts.push({ sql: trimmed, count: bound.length });
        const res = sqlite.prepare(query).run(...toParams(bound));
        return { success: true, meta: { changes: Number(res.changes) } };
      },
    };
    stmtKind.set(stmt, isSelect ? 'select' : 'write');
    return stmt;
  }

  const db: D1Database = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch<T>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batchCalls += 1;
      rpcCount += 1;
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        const prevRpc = rpcCount;
        const kind = stmtKind.get(stmt);
        const res = kind === 'select' ? await stmt.all<T>() : await stmt.run();
        rpcCount = prevRpc;
        results.push(res as D1Result<T>);
      }
      return results;
    },
  };

  return {
    db,
    sqlite,
    getRpcCount: () => rpcCount,
    getBatchCalls: () => batchCalls,
    resetMetrics: () => {
      rpcCount = 0;
      batchCalls = 0;
      bindCounts.length = 0;
    },
    bindCounts,
  };
}

describe('Wave E1 Fix Pass Stage 1: sync-server hardening regressions', () => {
  describe('P0-2: Non-Latin Unicode folding & empty-fold D1 index bypass', () => {
    it('preserves Cyrillic, Arabic, Greek, Korean, Japanese (with dakuten), and Chinese titles without collapsing to empty', () => {
      const titles = ['Брат 2', 'الهيبة', 'Ελλάδα', '기생충', 'ドラゴンボール', '卧虎藏龙'];
      const folded = titles.map((t) => foldTitleForMatch(t));
      for (const f of folded) {
        expect(f.length).toBeGreaterThan(0);
      }
      expect(new Set(folded).size).toBe(titles.length);
      expect(foldTitleForMatch('ドラゴンボール')).toBe('ドラゴンボール');
      expect(foldTitleForMatch('기생충')).toBe('기생충');
      expect(foldTitleForMatch('Брат 2')).toBe('брат 2');
      expect(foldTitleForMatch('İstanbul Hatırası')).toBe('istanbul hatirasi');
      expect(foldTitleForMatch('!!! --- ???')).toBe('');
      expect(buildMatchLookupKey('!!! ---', 'movie', 2024)).toBeNull();
      expect(buildMatchLookupKey('기생충', 'movie', 2019)).toBe('movie:기생충:2019');
    });

    it('never reads or writes elv_title_match_index for punctuation-only titles and keeps Cyrillic/Korean titles distinct in D1', async () => {
      const { db, sqlite } = createInstrumentedD1();
      const storage = createD1Storage(db);
      const searchSuggestions = vi.fn<ElvUpstreamClient['searchSuggestions']>(async (query) => {
        if (query === 'Брат') {
          return [makeCandidate({ imdbId: 'tt0118767', title: 'Брат', year: 1997 })];
        }
        if (query === '기생충') {
          return [makeCandidate({ imdbId: 'tt6751668', title: '기생충', year: 2019 })];
        }
        return [];
      });
      const app = createSyncApp({
        storage,
        jwtSecret: TEST_JWT_SECRET,
        elvUpstream: {
          searchSuggestions,
          fetchTitleDetail: async () => null,
          fetchFeeds: async () => ({
            topPicks: [],
            movieMeter: [],
            tvMeter: [],
            currentUpcomingTv: [],
          }),
          resolveTmdbToImdb: async () => null,
        },
      });

      const res = await app.fetch(
        new Request('https://sync.example.test/v1/elv/match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              { key: 'm:ru:1', cleanTitle: 'Брат', year: 1997, mediaType: 'movie' },
              { key: 'm:ko:1', cleanTitle: '기생충', year: 2019, mediaType: 'movie' },
              { key: 'm:empty:1', cleanTitle: '!!! ---', year: 2020, mediaType: 'movie' },
            ],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matches: Record<string, { imdbId: string }>;
        unmatchedKeys: string[];
      };
      expect(body.matches['m:ru:1']?.imdbId).toBe('tt0118767');
      expect(body.matches['m:ko:1']?.imdbId).toBe('tt6751668');
      expect(body.unmatchedKeys).toEqual(['m:empty:1']);
      // Punctuation-only title never wasted an upstream suggestion call or wrote an empty lookup_key
      expect(searchSuggestions).toHaveBeenCalledTimes(2);
      const rows = sqlite
        .prepare('SELECT lookup_key, imdb_id FROM elv_title_match_index ORDER BY lookup_key')
        .all() as Array<{ lookup_key: string; imdb_id: string }>;
      expect(rows.map((r) => r.lookup_key)).toEqual(['movie:брат:1997', 'movie:기생충:2019']);
      sqlite.close();
    });
  });

  describe('P0-4: M3U tvg-id keys containing @ and strict validation', () => {
    it('accepts realistic M3U keys with @ and : while rejecting schemes, whitespace/control chars, >160 chars, and credentials in cleanTitle', () => {
      const ok = validateElvMatchBatchInput({
        items: [
          {
            key: 'm:src1:live:t:cnn.us@hd',
            cleanTitle: 'Inception',
            year: 2010,
            mediaType: 'movie',
          },
          {
            key: 'm:src1:movie:t:bbc.one@uk.hd#2',
            cleanTitle: 'Interstellar',
            year: 2014,
            mediaType: 'movie',
          },
        ],
      });
      expect(ok.ok).toBe(true);

      const badKeys = [
        'https://provider.example/live/1.ts',
        'http:provider.example/live/1.ts',
        'rtmp://provider.example/stream',
        'rtmp:provider.example/stream',
        'key with spaces',
        'key\nwith\nnewline',
        'key\x00null',
        'k'.repeat(161),
      ];
      for (const badKey of badKeys) {
        const res = validateElvMatchBatchInput({
          items: [{ key: badKey, cleanTitle: 'Inception', mediaType: 'movie' }],
        });
        expect(res.ok, `Expected rejection for key "${badKey}"`).toBe(false);
      }

      // cleanTitle must still strictly reject user:pass@host credentials and URLs
      const credInTitle = validateElvMatchBatchInput({
        items: [
          {
            key: 'm:src1:movie:t:cnn.us@hd',
            cleanTitle: 'alice:secretpass@provider.example',
            mediaType: 'movie',
          },
        ],
      });
      expect(credInTitle.ok).toBe(false);
    });
  });

  describe('P1-7: Missing elv_title_cache hydration for providerImdbId / providerTmdbId / collective cache hits', () => {
    it('fetches IMDb summary metadata within 25-subrequest budget and returns overflow keys in pendingKeys', async () => {
      const searchSuggestions = vi.fn<ElvUpstreamClient['searchSuggestions']>(async (query) => {
        if (/^tt\d{7}$/.test(query)) {
          return [
            makeCandidate({
              imdbId: query,
              title: `Resolved ${query}`,
              year: 2022,
              posterUrl: `https://m.media-amazon.com/images/M/MV5${query}._V1_QL75_UX300_.jpg`,
            }),
          ];
        }
        return [];
      });
      const resolveTmdbToImdb = vi.fn<ElvUpstreamClient['resolveTmdbToImdb']>(async (tmdbId) =>
        tmdbId === '55555' ? 'tt0000099' : null,
      );
      const storage = createMemoryStorage();
      // Seed collective match cache without elv_title_cache row
      await storage.upsertElvMatches([
        {
          lookupKey: 'movie:cached orphan:2022',
          mediaType: 'movie',
          year: 2022,
          imdbId: 'tt0000098',
          confidence: 0.95,
          updatedAt: 1_764_212_100_000,
        },
      ]);

      const app = createSyncApp({
        storage,
        jwtSecret: TEST_JWT_SECRET,
        tmdbApiKey: 'test-tmdb-key',
        elvUpstream: {
          searchSuggestions,
          fetchTitleDetail: async () => null,
          fetchFeeds: async () => ({
            topPicks: [],
            movieMeter: [],
            tvMeter: [],
            currentUpcomingTv: [],
          }),
          resolveTmdbToImdb,
        },
      });

      // 1 providerTmdbId (costs 1 TMDB + 1 IMDb summary = 2) + 1 collective cache orphan (1) + 27 providerImdbId (22 fit, 5 overflow) = 25 subrequests
      const items = [
        {
          key: 'k:tmdb',
          cleanTitle: 'TMDB Movie',
          year: 2022,
          mediaType: 'movie' as const,
          providerTmdbId: '55555',
        },
        {
          key: 'k:cache-orphan',
          cleanTitle: 'Cached Orphan',
          year: 2022,
          mediaType: 'movie' as const,
        },
        ...Array.from({ length: 27 }, (_, i) => ({
          key: `k:imdb:${i + 1}`,
          cleanTitle: `Provider Film ${i + 1}`,
          year: 2022,
          mediaType: 'movie' as const,
          providerImdbId: `tt${String(1000001 + i)}`,
        })),
      ];

      const res = await app.fetch(
        new Request('https://sync.example.test/v1/elv/match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matches: Record<string, { imdbId: string; title: { posterUrl: string | null } }>;
        pendingKeys: string[];
        unmatchedKeys: string[];
      };

      // Total upstream subrequests strictly <= 25
      const totalSubrequests =
        resolveTmdbToImdb.mock.calls.length + searchSuggestions.mock.calls.length;
      expect(totalSubrequests).toBeLessThanOrEqual(25);
      expect(body.matches['k:tmdb']?.title.posterUrl).toContain('tt0000099');
      expect(body.matches['k:cache-orphan']?.title.posterUrl).toContain('tt0000098');
      expect(body.pendingKeys).toHaveLength(5);
      expect(Object.keys(body.matches)).toHaveLength(24);
      // Pending items are not emitted as hollow matches
      for (const pendingKey of body.pendingKeys) {
        expect(body.matches[pendingKey]).toBeUndefined();
      }
      expect(body.unmatchedKeys).toEqual([]);
    });
  });

  describe('P1-9: Ambiguous remake rejection & leading-article tightening', () => {
    it('rejects ambiguous remakes with different years when query.year is null', () => {
      const dune1984 = makeCandidate({ imdbId: 'tt0087182', title: 'Dune', year: 1984 });
      const dune2021 = makeCandidate({ imdbId: 'tt1160419', title: 'Dune', year: 2021 });
      expect(
        selectBestImdbMatch({ cleanTitle: 'Dune', year: null, mediaType: 'movie' }, [
          dune1984,
          dune2021,
        ]),
      ).toBeNull();

      const lion1994 = makeCandidate({ imdbId: 'tt0110357', title: 'The Lion King', year: 1994 });
      const lion2019 = makeCandidate({ imdbId: 'tt6105098', title: 'The Lion King', year: 2019 });
      expect(
        selectBestImdbMatch({ cleanTitle: 'The Lion King', year: null, mediaType: 'movie' }, [
          lion1994,
          lion2019,
        ]),
      ).toBeNull();

      // With explicit year, the right remake matches cleanly
      expect(
        selectBestImdbMatch({ cleanTitle: 'Dune', year: 2021, mediaType: 'movie' }, [
          dune1984,
          dune2021,
        ])?.candidate.imdbId,
      ).toBe('tt1160419');
    });

    it('rejects leading-article-stripped collisions when query.year is null, but allows them with matching year', () => {
      const room2015 = makeCandidate({ imdbId: 'tt3170832', title: 'Room', year: 2015 });
      expect(
        scoreImdbCandidate({ cleanTitle: 'The Room', year: null, mediaType: 'movie' }, room2015),
      ).toBeLessThan(0.78);
      expect(
        selectBestImdbMatch({ cleanTitle: 'The Room', year: null, mediaType: 'movie' }, [room2015]),
      ).toBeNull();

      const batman1989 = makeCandidate({ imdbId: 'tt0096895', title: 'Batman', year: 1989 });
      expect(
        selectBestImdbMatch({ cleanTitle: 'The Batman', year: null, mediaType: 'movie' }, [
          batman1989,
        ]),
      ).toBeNull();

      // Matching year allows missing leading article ("Godfather" 1972 -> "The Godfather" 1972)
      const godfather = makeCandidate({ imdbId: 'tt0068646', title: 'The Godfather', year: 1972 });
      expect(
        selectBestImdbMatch({ cleanTitle: 'Godfather', year: 1972, mediaType: 'movie' }, [
          godfather,
        ])?.candidate.imdbId,
      ).toBe('tt0068646');
    });
  });

  describe('P1-12: D1 batching <= 20 queries, 49-param chunking, original_title preservation, TMDB budget & BCP-47 lang', () => {
    it('normalizes BCP-47 lang tags case-insensitively', () => {
      expect(validateElvLang('pt-br')).toEqual({ ok: true, value: 'pt-BR' });
      expect(validateElvLang('en-us')).toEqual({ ok: true, value: 'en-US' });
      expect(validateElvLang('TR')).toEqual({ ok: true, value: 'tr' });
      expect(validateElvLang('zh-cn')).toEqual({ ok: true, value: 'zh-CN' });
      expect(validateElvLang('invalid_lang')).toEqual({ ok: false, error: 'invalid_lang' });
    });

    it('preserves native original_title when a stub upserts over a full record in both D1 and memory storage', async () => {
      const { db, sqlite } = createInstrumentedD1();
      const d1 = createD1Storage(db);
      const mem = createMemoryStorage();

      for (const store of [d1, mem]) {
        await store.upsertElvTitle(makeTitle());
        await store.upsertElvTitlesBatch([makeStubTitle()]);
        const afterStub = await store.getElvTitle('tt6751668');
        expect(afterStub?.originalTitle).toBe('Gisaengchung');
        expect(afterStub?.director).toBe('Bong Joon Ho');

        // Upgrading an existing stub to a full detail record updates originalTitle cleanly
        await store.upsertElvTitlesBatch([
          makeStubTitle({
            imdbId: 'tt6468322',
            originalTitle: 'Money Heist',
            englishTitle: 'Money Heist',
          }),
        ]);
        await store.upsertElvTitle(
          makeTitle({
            imdbId: 'tt6468322',
            mediaType: 'series',
            originalTitle: 'La casa de papel',
            englishTitle: 'Money Heist',
            director: null,
          }),
        );
        expect((await store.getElvTitle('tt6468322'))?.originalTitle).toBe('La casa de papel');
      }
      sqlite.close();
    });

    it('uses db.batch() with <= 20 D1 queries for a 500-item match-batch and chunks localized synopses at <= 50 params (1 + 49)', async () => {
      const { db, sqlite, getRpcCount, getBatchCalls, resetMetrics, bindCounts } =
        createInstrumentedD1();
      const storage = createD1Storage(db);

      // Verify 49-item chunking (max 50 params including lang) in getElvLocalizedSynopsesByIds
      const ids = Array.from({ length: 105 }, (_, i) => `tt${String(2000000 + i)}`);
      resetMetrics();
      await storage.getElvLocalizedSynopsesByIds(ids, 'pt-BR');
      for (const entry of bindCounts) {
        expect(entry.count).toBeLessThanOrEqual(50);
      }

      // Run a full 500-item match-batch with lang='pt-br' (normalized to 'pt-BR') and 25 new matches + 475 pending
      const app = createSyncApp({
        storage,
        jwtSecret: TEST_JWT_SECRET,
        elvUpstream: {
          searchSuggestions: async (query) => {
            const num = /\d+/.exec(query)?.[0] ?? '1';
            return [
              makeCandidate({
                imdbId: `tt${num.padStart(7, '0')}`,
                title: query,
                year: 2021,
              }),
            ];
          },
          fetchTitleDetail: async () => null,
          fetchFeeds: async () => ({
            topPicks: [],
            movieMeter: [],
            tvMeter: [],
            currentUpcomingTv: [],
          }),
          resolveTmdbToImdb: async () => null,
        },
      });

      const items = Array.from({ length: 500 }, (_, i) => ({
        key: `m:src1:movie:${i + 1}`,
        cleanTitle: `Batch Film ${i + 1}`,
        year: 2021,
        mediaType: 'movie' as const,
      }));

      resetMetrics();
      const res = await app.fetch(
        new Request('https://sync.example.test/v1/elv/match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, lang: 'pt-br' }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matches: Record<string, unknown>;
        pendingKeys: string[];
      };
      expect(Object.keys(body.matches)).toHaveLength(25);
      expect(body.pendingKeys).toHaveLength(475);
      expect(getBatchCalls()).toBeGreaterThanOrEqual(2);
      expect(getRpcCount()).toBeLessThanOrEqual(20);
      for (const entry of bindCounts) {
        expect(entry.count).toBeLessThanOrEqual(50);
      }
      sqlite.close();
    });

    it('does NOT decrement subrequest budget for resolveTmdbToImdb when tmdbApiKey is unconfigured', async () => {
      const searchSuggestions = vi.fn<ElvUpstreamClient['searchSuggestions']>(async (query) => {
        const num = /\d+/.exec(query)?.[0] ?? '1';
        return [
          makeCandidate({
            imdbId: `tt${num.padStart(7, '0')}`,
            title: query,
            year: 2023,
          }),
        ];
      });
      const resolveTmdbToImdb = vi.fn<ElvUpstreamClient['resolveTmdbToImdb']>(async () => null);
      const app = createSyncApp({
        storage: createMemoryStorage(),
        jwtSecret: TEST_JWT_SECRET,
        elvUpstream: {
          searchSuggestions,
          fetchTitleDetail: async () => null,
          fetchFeeds: async () => ({
            topPicks: [],
            movieMeter: [],
            tvMeter: [],
            currentUpcomingTv: [],
          }),
          resolveTmdbToImdb,
        },
      });

      const items = Array.from({ length: 25 }, (_, i) => ({
        key: `x:s1:movie:${i + 1}`,
        cleanTitle: `Xtream Film ${i + 1}`,
        year: 2023,
        mediaType: 'movie' as const,
        providerTmdbId: String(9000 + i),
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
        matches: Record<string, unknown>;
        pendingKeys: string[];
      };
      expect(resolveTmdbToImdb).not.toHaveBeenCalled();
      expect(Object.keys(body.matches)).toHaveLength(25);
      expect(body.pendingKeys).toEqual([]);
    });
  });

  describe('P2 hardening: HTML entity surrogate safety, trailer port rejection & fallback Cache-Control', () => {
    it('safely handles surrogate and out-of-range numeric HTML entities and rejects trailer URLs with explicit ports', () => {
      const html = `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'Movie',
        name: 'Safe &#x27;Title&#x27; &#xD800; &#x110000; &#999999999;',
        datePublished: '2024-01-01',
        description: 'Valid &#8217; quote and surrogate &#55296; check.',
        trailer: {
          contentUrl: 'https://imdb-video.media-imdb.com:8443/vi123/hls.m3u8',
        },
      })}</script></head></html>`;

      const parsed = parseImdbTitleHtml('tt1234567', html, 1_764_212_100_000);
      expect(parsed).not.toBeNull();
      expect(parsed?.originalTitle).toBe("Safe 'Title' &#xD800; &#x110000; &#999999999;");
      expect(parsed?.originalSynopsis).toBe('Valid ’ quote and surrogate &#55296; check.');
      expect(parsed?.trailerStreamUrl).toBeNull();
    });

    it('sets Cache-Control: public, max-age=300 on fallback_en synopses and stub detail fallbacks', async () => {
      const failingAi: WorkersAiBinding = {
        run: async () => {
          throw new Error('AI unavailable');
        },
      };
      const app = createSyncApp({
        storage: createMemoryStorage(),
        jwtSecret: TEST_JWT_SECRET,
        ai: failingAi,
        elvUpstream: {
          searchSuggestions: async () => [],
          fetchTitleDetail: async (imdbId) => {
            if (imdbId === 'tt6751668') return makeTitle();
            if (imdbId === 'tt0000403') return makeStubTitle({ imdbId: 'tt0000403' });
            return null;
          },
          fetchFeeds: async () => ({
            topPicks: [],
            movieMeter: [],
            tvMeter: [],
            currentUpcomingTv: [],
          }),
          resolveTmdbToImdb: async () => null,
        },
      });

      const aiFallbackRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/title/tt6751668?lang=pt-br'),
      );
      expect(aiFallbackRes.status).toBe(200);
      expect(aiFallbackRes.headers.get('cache-control')).toBe('public, max-age=300');

      const stubFallbackRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/title/tt0000403?lang=en'),
      );
      expect(stubFallbackRes.status).toBe(200);
      expect(stubFallbackRes.headers.get('cache-control')).toBe('public, max-age=300');

      const healthyEnRes = await app.fetch(
        new Request('https://sync.example.test/v1/elv/title/tt6751668?lang=en'),
      );
      expect(healthyEnRes.status).toBe(200);
      expect(healthyEnRes.headers.get('cache-control')).toBe('public, max-age=86400');
    });
  });
});
