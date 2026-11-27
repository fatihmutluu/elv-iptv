import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createD1Storage } from './storage-d1.ts';
import type { D1Database, D1PreparedStatement, D1Result } from './storage-d1-types.ts';
import worker from './worker.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function createSqliteD1(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const name of [
    '0001_init.sql',
    '0002_wave_p9_pairing_telemetry.sql',
    '0003_wave_e1_elv_metadata.sql',
    '0004_wave_q1_dual_id_imdb_ratings.sql',
  ]) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }

  const toParams = (values: readonly unknown[]): SQLInputValue[] =>
    values.map((v) =>
      v === undefined || v === null
        ? null
        : typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint'
          ? v
          : String(v),
    );
  const stmtIsSelect = new WeakMap<D1PreparedStatement, boolean>();

  function makeStatement(query: string, bound: unknown[] = []): D1PreparedStatement {
    const stmt: D1PreparedStatement = {
      bind: (...values: unknown[]) => makeStatement(query, values),
      async first<T>() {
        const row = sqlite.prepare(query).get(...toParams(bound));
        return (row ? { ...row } : null) as T | null;
      },
      async all<T>() {
        const rows = sqlite
          .prepare(query)
          .all(...toParams(bound))
          .map((r) => ({ ...r })) as T[];
        return { success: true, results: rows, meta: { changes: 0 } };
      },
      async run() {
        const res = sqlite.prepare(query).run(...toParams(bound));
        return { success: true, meta: { changes: Number(res.changes) } };
      },
    };
    stmtIsSelect.set(stmt, /^\s*SELECT\b/i.test(query));
    return stmt;
  }

  const db: D1Database = {
    prepare: (query: string) => makeStatement(query),
    async batch<T>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        const res = stmtIsSelect.get(stmt) ? await stmt.all<T>() : await stmt.run();
        results.push(res as D1Result<T>);
      }
      return results;
    },
  };
  return { db, sqlite };
}

describe('Cloudflare D1 Wave Q1 dual-ID ELV metadata & IMDb ratings storage (0004)', () => {
  it('stores and queries dual imdb_id + tmdb_id, preserves tmdb_id via COALESCE, and overlays IMDb ratings with 0 Workers AI calls', async () => {
    const { db, sqlite } = createSqliteD1();
    const storage = createD1Storage(db);

    await storage.upsertElvTitle({
      imdbId: 'tt1375666',
      tmdbId: '27205',
      mediaType: 'movie',
      originalTitle: 'Inception',
      englishTitle: 'Inception',
      year: 2010,
      rating: 8.4,
      votes: 35_000,
      runtimeMin: 148,
      genres: ['Action', 'Sci-Fi'],
      posterUrl: 'https://image.tmdb.org/t/p/w342/inception.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/inception-bg.jpg',
      trailerStreamUrl: null,
      trailerYoutubeId: 'YoHD9XEInc0',
      director: 'Christopher Nolan',
      cast: [
        { personId: 'tmdb:6193', name: 'Leonardo DiCaprio', character: 'Cobb', portraitUrl: null },
      ],
      mltImdbIds: ['tt0816692'],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      originalSynopsis: 'A thief steals secrets through shared dreaming.',
      updatedAt: Date.now(),
    });

    expect((await storage.getElvTitle('tt1375666'))?.tmdbId).toBe('27205');
    expect((await storage.getElvTitleByTmdbId('27205', 'movie'))?.imdbId).toBe('tt1375666');
    expect((await storage.getElvTitleByTmdbId('27205'))?.imdbId).toBe('tt1375666');
    expect((await storage.getElvTitlesByTmdbIds(['27205'], 'movie')).size).toBe(1);
    expect((await storage.getElvTitlesByIds(['tt1375666'])).size).toBe(1);

    // Upserting null tmdbId preserves existing tmdb_id via COALESCE
    await storage.upsertElvTitle({
      imdbId: 'tt1375666',
      tmdbId: null,
      mediaType: 'movie',
      originalTitle: 'Inception',
      englishTitle: 'Inception',
      year: 2010,
      rating: null,
      votes: null,
      runtimeMin: null,
      genres: [],
      posterUrl: null,
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
      updatedAt: Date.now(),
    });
    expect((await storage.getElvTitle('tt1375666'))?.tmdbId).toBe('27205');

    await storage.upsertImdbRatingsBatch([
      { imdbId: 'tt1375666', rating: 8.8, votes: 2_600_000, updatedAt: 1_764_212_100_000 },
    ]);
    const ratingsMap = await storage.getImdbRatingsByIds(['tt1375666', 'tt9999999']);
    expect(ratingsMap.get('tt1375666')).toEqual({
      imdbId: 'tt1375666',
      rating: 8.8,
      votes: 2_600_000,
      updatedAt: 1_764_212_100_000,
    });
    expect(ratingsMap.has('tt9999999')).toBe(false);

    const bulkMatches = Array.from({ length: 65 }, (_, i) => ({
      lookupKey: `movie:film ${i}:2020`,
      mediaType: 'movie' as const,
      year: 2020,
      imdbId: `tt${String(1000000 + i)}`,
      tmdbId: String(5000 + i),
      confidence: 0.95,
      updatedAt: 1_764_212_100_000,
    }));
    await storage.upsertElvMatches(bulkMatches);
    const loadedMatches = await storage.getElvMatchesByKeys(bulkMatches.map((m) => m.lookupKey));
    expect(loadedMatches.size).toBe(65);
    expect(loadedMatches.get('movie:film 0:2020')?.tmdbId).toBe('5000');

    await storage.upsertElvLocalizedSynopsesBatch([
      {
        imdbId: 'tt1375666',
        lang: 'tr',
        localizedTitle: 'Başlangıç',
        synopsis: 'Rüyalardan sır çalan bir hırsızın hikayesi.',
        source: 'tmdb',
        updatedAt: 1_764_212_100_000,
      },
    ]);
    expect((await storage.getElvLocalizedSynopsis('tt1375666', 'tr'))?.localizedTitle).toBe(
      'Başlangıç',
    );
    expect((await storage.getElvLocalizedSynopsesByIds(['tt1375666'], 'tr')).size).toBe(1);

    let aiCalls = 0;
    const deRes = await worker.fetch(
      new Request('https://sync.example.test/v1/elv/title/tt1375666?lang=de'),
      {
        DB: db,
        JWT_SECRET: 'worker-secret-key-at-least-32-chars-long',
        AI: {
          run: async () => {
            aiCalls += 1;
            return { response: 'Should never be called' };
          },
        },
      },
    );
    expect(deRes.status).toBe(200);
    expect(aiCalls).toBe(0);
    const deBody = (await deRes.json()) as {
      tmdbId: string;
      rating: number;
      votes: number;
      synopsis: string;
      synopsisSource: string;
    };
    expect(deBody.tmdbId).toBe('27205');
    expect(deBody.rating).toBe(8.8);
    expect(deBody.votes).toBe(2_600_000);
    expect(deBody.synopsis).toBe('A thief steals secrets through shared dreaming.');
    expect(deBody.synopsisSource).toBe('fallback_en');
    sqlite.close();
  });
});
