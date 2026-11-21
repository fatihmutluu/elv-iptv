import { ok, type SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { foldText } from './fold';
import { openCatalog } from './migrate';
import {
  buildFtsQuery,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TOKENS,
  querySearch,
} from './search';
import { removeSource } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';

async function seedSource(db: SqlDriver, id: string, kind: 'xtream' | 'm3u' = 'xtream') {
  await db.run(
    'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
    [id, kind, `Source ${id}`, 100, '{}'],
  );
}

describe('buildFtsQuery', () => {
  it('returns null for empty, whitespace, or punctuation-only queries', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   \t\n  ')).toBeNull();
    expect(buildFtsQuery('*** --- ::: "" ()')).toBeNull();
  });

  it('folds Turkish characters and formats prefix-AND quoted tokens', () => {
    expect(buildFtsQuery('İstanbul Haber')).toBe('"istanbul"* AND "haber"*');
    expect(buildFtsQuery('ıstanbul')).toBe('"istanbul"*');
    expect(buildFtsQuery('İSTANBUL')).toBe('"istanbul"*');
    expect(buildFtsQuery('Çığlık Güneş Şeker Özgür')).toBe(
      '"ciglik"* AND "gunes"* AND "seker"* AND "ozgur"*',
    );
  });

  it('caps tokens at MAX_SEARCH_TOKENS and neutralizes FTS5 operators', () => {
    expect(DEFAULT_SEARCH_LIMIT).toBe(40);
    expect(MAX_SEARCH_LIMIT).toBe(60);
    expect(MAX_SEARCH_TOKENS).toBe(12);

    const twentyWords = Array.from({ length: 20 }, (_, i) => `tok${i}`).join(' ');
    const capped = buildFtsQuery(twentyWords);
    expect(capped).toBe(
      Array.from({ length: MAX_SEARCH_TOKENS }, (_, i) => `"tok${i}"*`).join(' AND '),
    );

    expect(buildFtsQuery('NOT OR "foo"* (bar):baz ^NEAR')).toBe(
      '"not"* AND "or"* AND "foo"* AND "bar"* AND "baz"* AND "near"*',
    );
  });
});

describe('querySearch', () => {
  it('matches Turkish-folded live, movie, and series names across case, diacritics, and multi-word prefixes', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, 's1');
      await db.run(
        `INSERT INTO live (source_id, key, provider_id, num, name, name_fold, logo, run_id)
         VALUES ('s1', 'x:s1:live:1', '1', 101, 'İstanbul Haber HD', ?, 'https://img/ist.png', 1)`,
        [foldText('İstanbul Haber HD')],
      );
      await db.run(
        `INSERT INTO movies (source_id, key, provider_id, name, name_fold, logo, rating, year, run_id)
         VALUES
           ('s1', 'x:s1:movie:1', '10', 'Çığlık', ?, NULL, 7.5, 2024, 1),
           ('s1', 'x:s1:movie:2', '11', 'Güneş Altında', ?, NULL, 8.1, 2025, 1),
           ('s1', 'x:s1:movie:3', '12', 'Şeker Portakalı', ?, NULL, 8.4, 2023, 1)`,
        [foldText('Çığlık'), foldText('Güneş Altında'), foldText('Şeker Portakalı')],
      );
      await db.run(
        `INSERT INTO series (source_id, key, provider_id, name, name_fold, cover, rating, year, run_id)
         VALUES ('s1', 'x:s1:series:1', '20', 'Özgür Rüzgar', ?, 'https://img/ozgur.png', 8.9, 2026, 1)`,
        [foldText('Özgür Rüzgar')],
      );

      for (const variant of ['ıstanbul', 'İSTANBUL', 'Istanbul', 'ist hab']) {
        const res = await querySearch(db, variant);
        expect(res.live.map((r) => r.name)).toEqual(['İstanbul Haber HD']);
        expect(res.live[0]).toMatchObject({
          key: 'x:s1:live:1',
          kind: 'live',
          sourceId: 's1',
          num: 101,
          logo: 'https://img/ist.png',
        });
        expect(res.movies).toEqual([]);
        expect(res.series).toEqual([]);
      }

      expect((await querySearch(db, 'cigli')).movies.map((m) => m.name)).toEqual(['Çığlık']);
      expect((await querySearch(db, 'gunes')).movies.map((m) => m.name)).toEqual(['Güneş Altında']);
      expect((await querySearch(db, 'seker')).movies.map((m) => m.name)).toEqual([
        'Şeker Portakalı',
      ]);
      expect((await querySearch(db, 'ozgur')).series.map((s) => s.name)).toEqual(['Özgür Rüzgar']);
      expect((await querySearch(db, 'ozgur')).series[0]).toMatchObject({
        key: 'x:s1:series:1',
        kind: 'series',
        logo: 'https://img/ozgur.png',
        rating: 8.9,
        year: 2026,
      });
    } finally {
      close();
    }
  });

  it('respects scope, sourceId, and limit clamping, and runs zero queries for empty/zero-limit inputs', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, 's1');
      await seedSource(db, 's2');
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:live:1', 'Horizon Live', 'horizon live', 1)",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:1', 'Horizon Movie 1', 'horizon movie 1', 1)",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s2', 'x:s2:movie:2', 'Horizon Movie 2', 'horizon movie 2', 1)",
      );
      await db.run(
        "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:series:1', 'Horizon Series', 'horizon series', 1)",
      );

      const queriedTables: string[] = [];
      const spy: SqlDriver = {
        ...db,
        all: (sql, params) => {
          queriedTables.push(sql);
          return db.all(sql, params);
        },
      };

      expect(await querySearch(spy, '   ')).toEqual({ live: [], movies: [], series: [] });
      expect(await querySearch(spy, 'horizon', { limit: 0 })).toEqual({
        live: [],
        movies: [],
        series: [],
      });
      expect(queriedTables).toHaveLength(0);

      const liveOnly = await querySearch(spy, 'horizon', { scope: 'live' });
      expect(liveOnly.live).toHaveLength(1);
      expect(liveOnly.movies).toEqual([]);
      expect(liveOnly.series).toEqual([]);
      expect(queriedTables).toHaveLength(1);
      expect(queriedTables[0]).toContain('live_fts');

      queriedTables.length = 0;
      const movieS2 = await querySearch(spy, 'horizon', { scope: 'movie', sourceId: 's2' });
      expect(movieS2.movies.map((m) => m.key)).toEqual(['x:s2:movie:2']);
      expect(queriedTables).toHaveLength(1);
      expect(queriedTables[0]).toContain('movies_fts');

      queriedTables.length = 0;
      const seriesOnly = await querySearch(spy, 'horizon', { scope: 'series' });
      expect(seriesOnly.series.map((s) => s.key)).toEqual(['x:s1:series:1']);
      expect(queriedTables).toHaveLength(1);
      expect(queriedTables[0]).toContain('series_fts');

      // Limit clamping at MAX_SEARCH_LIMIT (60)
      await db.transaction(async (tx) => {
        const rows = Array.from({ length: 70 }, (_, i) => [
          's1',
          `x:s1:live:extra:${i}`,
          `Clamp Channel ${i}`,
          `clamp channel ${i}`,
          1,
        ]);
        await tx.batch(
          'INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?)',
          rows,
        );
      });
      expect((await querySearch(db, 'clamp', { scope: 'live', limit: 999 })).live).toHaveLength(
        MAX_SEARCH_LIMIT,
      );
      expect((await querySearch(db, 'clamp', { scope: 'live' })).live).toHaveLength(
        DEFAULT_SEARCH_LIMIT,
      );
      expect((await querySearch(db, 'clamp', { scope: 'live', limit: 5 })).live).toHaveLength(5);
    } finally {
      close();
    }
  });

  it('never throws on adversarial FTS5 operator syntax inputs', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, 's1');
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:live:1', 'Normal Channel', 'normal channel', 1)",
      );

      for (const hostile of [
        'NOT OR "foo"* (bar):baz ^NEAR',
        '"""""',
        'name_fold:normal OR 1=1',
        'NEAR(a b, 5)',
        '-foo +bar *baz',
        'a AND OR NOT ()',
      ]) {
        await expect(querySearch(db, hostile)).resolves.toMatchObject({
          live: expect.any(Array),
          movies: expect.any(Array),
          series: expect.any(Array),
        });
      }
    } finally {
      close();
    }
  });

  it('keeps FTS5 triggers synced across updates, deletes, and removeSource', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const secrets = memorySecrets();
      await seedSource(db, 's1');
      await seedSource(db, 's2');
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:live:1', 'Old Name', 'old name', 1)",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:1', 'Remove Film', 'remove film', 1)",
      );
      await db.run(
        "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s2', 'x:s2:series:1', 'Keep Series', 'keep series', 1)",
      );

      // Update name_fold -> old term gone, new term searchable
      await db.run(
        "UPDATE live SET name = 'Renamed Channel', name_fold = 'renamed channel' WHERE key = 'x:s1:live:1'",
      );
      expect((await querySearch(db, 'old')).live).toEqual([]);
      expect((await querySearch(db, 'renamed')).live.map((r) => r.name)).toEqual([
        'Renamed Channel',
      ]);

      // Updating non-name_fold column (or unchanged name_fold) preserves searchability
      await db.run(
        "UPDATE live SET run_id = 2, name_fold = 'renamed channel' WHERE key = 'x:s1:live:1'",
      );
      expect((await querySearch(db, 'renamed')).live.map((r) => r.name)).toEqual([
        'Renamed Channel',
      ]);

      // removeSource purges s1 entries from live_fts and movies_fts while keeping s2 intact
      const removed = await removeSource('s1', { db, secrets });
      expect(removed.ok).toBe(true);
      expect(await querySearch(db, 'renamed')).toEqual({ live: [], movies: [], series: [] });
      expect(await querySearch(db, 'remove')).toEqual({ live: [], movies: [], series: [] });
      expect((await querySearch(db, 'keep')).series.map((s) => s.key)).toEqual(['x:s2:series:1']);
    } finally {
      close();
    }
  });

  it('resolves M3U logo templates at read time in CatalogService.search without storing secrets in SQLite', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const secrets = memorySecrets();
      const synthToken = ['m3u', 'Logo', 'Tok', '998877'].join('_');
      const playlist = [
        '#EXTM3U',
        `#EXTINF:-1 tvg-id="c1" tvg-logo="http://cdn.example/logos/${synthToken}/ist.png" group-title="Haber",İstanbul Haber HD`,
        `http://stream.example/live/${synthToken}/1.ts`,
        `#EXTINF:-1 tvg-id="c2" tvg-logo="http://cdn.example/logos/${synthToken}/gunes.png" group-title="Movies",Güneş Yolu.mp4`,
        `http://stream.example/movie/${synthToken}/2.mp4`,
        '',
      ].join('\n');

      const service = createCatalogService({
        db,
        secrets,
        scheduler: countingScheduler(),
        http: {
          async get() {
            const bytes = new TextEncoder().encode(playlist);
            return ok({
              status: 200,
              headers: {},
              body: {
                async *[Symbol.asyncIterator]() {
                  yield bytes;
                },
              },
            });
          },
        },
        clock: () => 1_000,
      });

      const added = await service.addSource({
        kind: 'm3u',
        name: 'Turkish M3U',
        playlistUrl: `http://provider.example/list.m3u?tok=${synthToken}`,
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const imported = await service.importSource(added.value.id);
      expect(imported.ok).toBe(true);

      // Verify raw SQLite stores template placeholder, NOT the secret token
      const rawLive = await db.all<{ logo: string | null }>('SELECT logo FROM live');
      expect(rawLive[0]?.logo).toContain('{{');
      expect(rawLive[0]?.logo).not.toContain(synthToken);

      // Search returns resolved logos at read time
      const liveHit = await service.search?.('ıstanbul');
      expect(liveHit?.live).toHaveLength(1);
      expect(liveHit?.live[0]?.logo).toBe(`http://cdn.example/logos/${synthToken}/ist.png`);

      const movieHit = await service.search?.('gunes');
      expect(movieHit?.movies).toHaveLength(1);
      expect(movieHit?.movies[0]?.logo).toBe(`http://cdn.example/logos/${synthToken}/gunes.png`);

      // Removing source purges all FTS5 entries
      expect((await service.removeSource(added.value.id)).ok).toBe(true);
      expect(await service.search?.('ıstanbul')).toEqual({ live: [], movies: [], series: [] });
      expect(await service.search?.('gunes')).toEqual({ live: [], movies: [], series: [] });

      await service.close();
    } finally {
      close();
    }
  });

  it('searches 25,000 synthetic rows with Turkish-folded multi-word query in under 50ms', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      await seedSource(db, 'perf');

      const totalRows = 25_000;
      const targetIndex = 18_432;
      await db.transaction(async (tx) => {
        const rows: [string, string, string, string, number][] = [];
        for (let i = 0; i < totalRows; i += 1) {
          const name =
            i === targetIndex
              ? 'İstanbul Özel Şehir Belgeseli 4K'
              : `Synthetic Broadcast Channel ${i} Region ${i % 97}`;
          rows.push(['perf', `x:perf:live:${i}`, name, foldText(name), 1]);
        }
        await tx.batch(
          'INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?)',
          rows,
        );
      });

      const start = performance.now();
      const results = await querySearch(db, 'ıst ozel seh', { scope: 'live' });
      const elapsedMs = performance.now() - start;

      expect(results.live.map((r) => r.key)).toEqual([`x:perf:live:${targetIndex}`]);
      expect(results.live[0]?.name).toBe('İstanbul Özel Şehir Belgeseli 4K');
      expect(elapsedMs).toBeLessThan(50);
    } finally {
      close();
    }
  });
});
