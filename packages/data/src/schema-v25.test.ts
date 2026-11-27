import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { commitStagedCatalog } from './catalog-commit';
import { hydrateBestPlayableMatches } from './elv-discovery-helpers';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { loadSeriesEpisodes } from './import-xtream';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { queryCategories, queryItemDetail, queryItems } from './queries';
import { queryAllSourcesItems, queryAllSourcesItemsByCursor } from './queries-all-sources';
import { queryItemsByCursor } from './queries-cursor';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { querySearch } from './search';
import { addXtreamSource } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { addItemToCollection, createCollection, listCollectionItems } from './vod-collections-repo';
import { movieWriter, seriesWriter, writeItems } from './writers';

describe('schema v25 (nullable backdrop column on movies and series)', () => {
  it('sets SCHEMA_VERSION >= 25 and adds nullable backdrop TEXT column to movies, movies_next, series, series_next', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    for (const table of ['movies', 'movies_next', 'series', 'series_next'] as const) {
      const expected = EXPECTED_TABLE_COLUMNS[table]?.map((c) => c.name) ?? [];
      expect(expected).toContain('backdrop');

      const cols = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (c) => c.name,
      );
      expect(cols).toContain('backdrop');
    }
  });

  it('upgrades a v24 database to v25 idempotently while preserving existing movie and series rows', async () => {
    const { db } = testDb();
    for (let i = 0; i < 24; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 24');
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
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(await db.all('SELECT key, name, backdrop FROM movies')).toEqual([
      { key: 'x:s1:movie:1', name: 'Inception', backdrop: null },
    ]);
    expect(await db.all('SELECT key, name, backdrop FROM series')).toEqual([
      { key: 'x:s1:series:1', name: 'Dark', backdrop: null },
    ]);
  });

  it('self-heals drifted databases missing backdrop columns', async () => {
    const { db } = testDb();
    for (let i = 0; i < MIGRATIONS.length; i += 1) {
      if (i === 24) continue;
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    const before = (await db.all<{ name: string }>('PRAGMA table_info(movies)')).map((c) => c.name);
    expect(before).not.toContain('backdrop');

    expect((await openCatalog(db)).ok).toBe(true);
    for (const table of ['movies', 'movies_next', 'series', 'series_next'] as const) {
      const after = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (c) => c.name,
      );
      expect(after).toContain('backdrop');
    }
  });

  it('persists and projects backdrop across writers, commit, browse queries, itemDetail, search, collections, and discovery helpers', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.run(
      "INSERT INTO categories_next (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'movie', '1', 'Movies', 'movies', 0, 1), ('s1', 'series', '2', 'Series', 'series', 0, 1)",
    );

    await writeItems(db, movieWriter, 's1', 1, [
      {
        key: 'x:s1:movie:10',
        item: {
          id: 10,
          name: 'Dune (2021)',
          categoryIds: ['1'],
          extension: 'mp4',
          year: 2021,
          icon: 'https://img.example/dune-poster.jpg',
          backdrop: 'https://img.example/dune-backdrop.jpg',
        },
      },
      {
        key: 'x:s1:movie:11',
        item: {
          id: 11,
          name: 'Legacy Film',
          categoryIds: ['1'],
          extension: 'mkv',
        },
      },
    ]);

    await writeItems(db, seriesWriter, 's1', 1, [
      {
        key: 'x:s1:series:20',
        item: {
          id: 20,
          name: 'Severance',
          categoryIds: ['2'],
          year: 2022,
          cover: 'https://img.example/sev-cover.jpg',
          backdrop: 'https://img.example/sev-backdrop.jpg',
        },
      },
    ]);

    await db.run(
      "INSERT INTO placements_next (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'movie', 'x:s1:movie:10', '1', 0, 1), ('s1', 'movie', 'x:s1:movie:11', '1', 1, 1), ('s1', 'series', 'x:s1:series:20', '2', 0, 1)",
    );
    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 1, ['live']));

    const mCat = (await queryCategories(db, 's1', 'movie'))[0];
    if (mCat === undefined) throw new Error('expected movie category');
    const movieItems = await queryItems(db, mCat.id, 0, 10);
    expect(movieItems.find((i) => i.key === 'x:s1:movie:10')?.backdrop).toBe(
      'https://img.example/dune-backdrop.jpg',
    );
    expect(Object.hasOwn(movieItems.find((i) => i.key === 'x:s1:movie:11') ?? {}, 'backdrop')).toBe(
      false,
    );

    const movieCursor = await queryItemsByCursor(db, mCat.id, undefined, 10);
    expect(movieCursor.items.find((i) => i.key === 'x:s1:movie:10')?.backdrop).toBe(
      'https://img.example/dune-backdrop.jpg',
    );

    const allMovies = await queryAllSourcesItems(db, 'movie', 0, 10);
    expect(allMovies.find((i) => i.key === 'x:s1:movie:10')?.backdrop).toBe(
      'https://img.example/dune-backdrop.jpg',
    );
    const allCursor = await queryAllSourcesItemsByCursor(db, 'movie', {}, 10);
    expect(allCursor.items.find((i) => i.key === 'x:s1:movie:10')?.backdrop).toBe(
      'https://img.example/dune-backdrop.jpg',
    );

    const m10Detail = await queryItemDetail(db, 'x:s1:movie:10');
    expect(m10Detail?.backdrop).toBe('https://img.example/dune-backdrop.jpg');
    const s20Detail = await queryItemDetail(db, 'x:s1:series:20');
    expect(s20Detail?.backdrop).toBe('https://img.example/sev-backdrop.jpg');

    const searchRes = await querySearch(db, 'Dune');
    expect(searchRes.movies[0]?.backdrop).toBe('https://img.example/dune-backdrop.jpg');

    const col = await createCollection(db, { name: 'Sci-Fi' }, 100);
    expect(col.ok).toBe(true);
    if (col.ok) {
      await addItemToCollection(db, col.value.id, 'x:s1:movie:10', 'movie', 'default', 101);
      const colItems = await listCollectionItems(db, col.value.id);
      expect(colItems[0]?.backdrop).toBe('https://img.example/dune-backdrop.jpg');
    }

    const enrichmentDb = testDb();
    const enrichmentStore = await openElvEnrichmentStore(enrichmentDb.db);
    await enrichmentStore.upsertMatches([
      {
        itemKey: 'x:s1:movie:10',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1160419',
        confidence: 0.99,
      },
    ]);
    await enrichmentStore.upsertTitles([
      { imdbId: 'tt1160419', mediaType: 'movie', originalTitle: 'Dune', year: 2021 },
    ]);
    const matchesByImdb = await enrichmentStore.listMatchedMatchesForImdbIds(['tt1160419']);
    const titleByImdb = await enrichmentStore.getTitlesByImdbIds(['tt1160419']);
    const hydrated = await hydrateBestPlayableMatches({
      catalogDb: db,
      enrichmentStore,
      orderedImdbIds: ['tt1160419'],
      matchesByImdb,
      titleByImdb,
      parentalFilter: null,
      maxRatingAge: null,
    });
    expect(hydrated.get('tt1160419')?.item.backdrop).toBe('https://img.example/dune-backdrop.jpg');
    await enrichmentStore.close();
  });

  it('persists backdrop from Xtream seriesInfo via loadSeriesEpisodes', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    const added = await addXtreamSource(
      { id: 's1', name: 'Panel', server: 'https://panel.example', username: 'u', password: 'p' },
      { db, secrets, newId: () => 's1', clock: () => 1 },
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceId = added.value.id;

    await db.run(
      `INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, run_id)
       VALUES (?, ?, '55', 'Andor', 'andor', 'andor', 1)`,
      [sourceId, `x:${sourceId}:series:55`],
    );

    const fakeSeriesHttp = {
      get: async () => {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            info: {
              backdrop_path: ['https://img.example/andor-info-bg.jpg'],
            },
            episodes: {
              '1': [{ id: 5501, episode_num: 1, title: 'Kassa', container_extension: 'mp4' }],
            },
          }),
        );
        return ok({
          status: 200,
          headers: {},
          body: (async function* () {
            yield bytes;
          })(),
        });
      },
    };
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: countingScheduler(),
      http: fakeSeriesHttp,
      clock: () => 200,
    });
    const res = await loadSeriesEpisodes(sourceId, `x:${sourceId}:series:55`, {
      db,
      secrets,
      scheduler: countingScheduler(),
      http: fakeSeriesHttp,
      clock: () => 200,
    });
    expect(res.ok).toBe(true);
    const detail = await svc.itemDetail?.(`x:${sourceId}:series:55`);
    expect(detail?.backdrop).toBe('https://img.example/andor-info-bg.jpg');
    await svc.close();
  });
});
