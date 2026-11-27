import { describe, expect, it } from 'vitest';
import { commitStagedCatalog } from './catalog-commit';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { queryItemDetail } from './queries';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { testDb } from './test-db';
import { movieWriter, seriesWriter, writeItems } from './writers';
import { writeM3uMovies } from './writers-m3u';

describe('schema v24 (provider_imdb_id & provider_tmdb_id on movies and series)', () => {
  it('sets SCHEMA_VERSION >= 24 and adds provider_imdb_id/provider_tmdb_id to movies, movies_next, series, series_next', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(24);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    for (const table of ['movies', 'movies_next', 'series', 'series_next'] as const) {
      const expected = EXPECTED_TABLE_COLUMNS[table]?.map((c) => c.name) ?? [];
      expect(expected).toContain('provider_imdb_id');
      expect(expected).toContain('provider_tmdb_id');

      const cols = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (c) => c.name,
      );
      expect(cols).toContain('provider_imdb_id');
      expect(cols).toContain('provider_tmdb_id');
    }

    const indexes = (
      await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
    ).map((r) => r.name);
    expect(indexes).toContain('idx_movies_provider_imdb');
    expect(indexes).toContain('idx_series_provider_imdb');
  });

  it('upgrades a v23 database to v24 while preserving existing movie and series rows', async () => {
    const { db } = testDb();
    for (let i = 0; i < 23; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 23');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:1', 'Inception', 'inception', 1)",
    );
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:series:1', 'Dark', 'dark', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(
      await db.all('SELECT key, name, provider_imdb_id, provider_tmdb_id FROM movies'),
    ).toEqual([
      { key: 'x:s1:movie:1', name: 'Inception', provider_imdb_id: null, provider_tmdb_id: null },
    ]);
    expect(
      await db.all('SELECT key, name, provider_imdb_id, provider_tmdb_id FROM series'),
    ).toEqual([
      { key: 'x:s1:series:1', name: 'Dark', provider_imdb_id: null, provider_tmdb_id: null },
    ]);
  });

  it('self-heals drifted databases missing provider_imdb_id / provider_tmdb_id', async () => {
    const { db } = testDb();
    for (let i = 0; i < MIGRATIONS.length; i += 1) {
      if (i === 23) continue;
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    const before = (await db.all<{ name: string }>('PRAGMA table_info(movies)')).map((c) => c.name);
    expect(before).not.toContain('provider_imdb_id');

    expect((await openCatalog(db)).ok).toBe(true);
    for (const table of ['movies', 'movies_next', 'series', 'series_next'] as const) {
      const after = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (c) => c.name,
      );
      expect(after).toContain('provider_imdb_id');
      expect(after).toContain('provider_tmdb_id');
    }
  });

  it('persists provider_imdb_id & provider_tmdb_id through movieWriter, seriesWriter, writeM3uMovies, commitStagedCatalog, and queryItemDetail', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'm3u', 'M3U', 1, '{}')",
    );

    await writeItems(db, movieWriter, 's1', 1, [
      {
        key: 'x:s1:movie:10',
        item: {
          id: 10,
          name: 'Inception (2010)',
          categoryIds: ['1'],
          extension: 'mp4',
          year: 2010,
          providerImdbId: 'TT1375666',
          providerTmdbId: '27205',
        },
      },
      {
        key: 'x:s1:movie:11',
        item: {
          id: 11,
          name: 'Legacy Caller Movie',
          categoryIds: ['1'],
          extension: 'mkv',
          providerImdbId: 'invalid-id',
          providerTmdbId: '0',
        },
      },
    ]);

    await writeItems(db, seriesWriter, 's1', 1, [
      {
        key: 'x:s1:series:20',
        item: {
          id: 20,
          name: 'Dark',
          categoryIds: ['2'],
          year: 2017,
          providerImdbId: 'tt5753856',
          providerTmdbId: '70523',
        },
      },
    ]);

    await writeM3uMovies(db, 's2', 1, [
      {
        key: 'm:s2:movie:1',
        name: 'Interstellar (2014)',
        logo: null,
        template: 'http://cdn.example/1.mp4',
        headersJson: null,
        providerImdbId: 'tt0816692',
        providerTmdbId: '157336',
      },
    ]);

    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 1, ['live']));
    await db.transaction((tx) => commitStagedCatalog(tx, 's2', 1, ['live', 'series']));

    const m10 = await queryItemDetail(db, 'x:s1:movie:10');
    expect(m10?.providerImdbId).toBe('tt1375666');
    expect(m10?.providerTmdbId).toBe('27205');

    const m11 = await queryItemDetail(db, 'x:s1:movie:11');
    expect(m11?.providerImdbId).toBeUndefined();
    expect(m11?.providerTmdbId).toBeUndefined();

    const s20 = await queryItemDetail(db, 'x:s1:series:20');
    expect(s20?.providerImdbId).toBe('tt5753856');
    expect(s20?.providerTmdbId).toBe('70523');

    const m3uMovie = await queryItemDetail(db, 'm:s2:movie:1');
    expect(m3uMovie?.providerImdbId).toBe('tt0816692');
    expect(m3uMovie?.providerTmdbId).toBe('157336');
  });
});
