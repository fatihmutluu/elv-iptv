import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { sampleCatalog, setup as setupPanel } from './import-test-helpers';
import {
  createCatalogService,
  listContinueWatching,
  MIGRATIONS,
  openCatalog,
  queryAllSourcesItems,
  queryAllSourcesItemsByCursor,
  queryItems,
  queryItemsByCursor,
  SCHEMA_VERSION,
  saveWatchProgress,
  setItemWatched,
  sortTitleKey,
} from './index';
import { countingScheduler, testDb } from './test-db';

function m3uHttp(body: string): HttpClient {
  const bytes = new TextEncoder().encode(body);
  return {
    async get() {
      return ok({
        status: 200,
        headers: {},
        body: (async function* () {
          yield bytes;
        })(),
      });
    },
  };
}

async function indexNames(db: ReturnType<typeof testDb>['db']): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

async function queryPlan(
  db: ReturnType<typeof testDb>['db'],
  sql: string,
  params: (string | number)[],
): Promise<string> {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

describe('Schema v8 migration — sort_title (#125)', () => {
  it('opens a fresh database at version 8+ with sort_title columns and sort indexes', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    for (const table of ['live', 'live_next', 'movies', 'movies_next', 'series', 'series_next']) {
      const cols = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (c) => c.name,
      );
      expect(cols).toContain('sort_title');
    }

    const indexes = await indexNames(db);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_live_sort_title',
        'idx_movies_sort_title',
        'idx_series_sort_title',
      ]),
    );

    for (const [table, index] of [
      ['live', 'idx_live_sort_title'],
      ['movies', 'idx_movies_sort_title'],
      ['series', 'idx_series_sort_title'],
    ] as const) {
      const plan = await queryPlan(
        db,
        `SELECT key FROM ${table} WHERE source_id = ? AND is_hidden = 0 ORDER BY sort_title ASC, key ASC`,
        ['s1'],
      );
      expect(plan).toContain(index);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('upgrades a v7 database to v8 and deterministically backfills sort_title via sortTitleKey', async () => {
    const { db } = testDb();
    for (let i = 0; i < 7; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 7');

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1','xtream','Main',100,'{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:live:1', 'The News Network', 'the news network', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:1', 'The Matrix', 'the matrix', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:2', 'A Quiet Place', 'a quiet place', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:3', 'An American Tale', 'an american tale', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:4', '---', '', 1)",
    );
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:series:1', 'Bir Zamanlar', 'bir zamanlar', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    expect(await db.all('SELECT key, sort_title FROM live')).toEqual([
      { key: 'x:s1:live:1', sort_title: sortTitleKey('The News Network') },
    ]);
    expect(
      await db.all('SELECT key, sort_title FROM movies ORDER BY sort_title ASC, key ASC'),
    ).toEqual([
      { key: 'x:s1:movie:4', sort_title: '' },
      { key: 'x:s1:movie:3', sort_title: 'american tale' },
      { key: 'x:s1:movie:1', sort_title: 'matrix' },
      { key: 'x:s1:movie:2', sort_title: 'quiet place' },
    ]);
    expect(await db.all('SELECT key, sort_title FROM series')).toEqual([
      { key: 'x:s1:series:1', sort_title: 'zamanlar' },
    ]);
  });
});

describe('sort_title writing, alpha sorting & watched filtering (#125)', () => {
  it('writes sort_title on Xtream and M3U imports and supports sortBy alpha and excludeWatched', async () => {
    const data = sampleCatalog();
    data.vod = [
      { stream_id: 200, name: 'The Matrix', category_id: '10', container_extension: 'mp4' },
      { stream_id: 201, name: 'A Quiet Place', category_id: '10', container_extension: 'mp4' },
      { stream_id: 202, name: 'An American Tale', category_id: '10', container_extension: 'mp4' },
      { stream_id: 203, name: 'Zeta Drift', category_id: '10', container_extension: 'mp4' },
    ];
    data.series = [
      { series_id: 300, name: 'The Wire', category_id: '20' },
      { series_id: 301, name: 'A Bit of Light', category_id: '20' },
    ];
    const panel = await setupPanel(data);
    const service = createCatalogService({
      db: panel.db,
      secrets: panel.secrets,
      scheduler: panel.scheduler,
      http: panel.deps.http,
      clock: () => 5_000,
    });
    expect((await service.importSource(panel.sourceId)).ok).toBe(true);

    const movieCat = (await service.categories(panel.sourceId, 'movie'))[0];
    expect(movieCat).toBeDefined();
    const catId = movieCat?.id ?? '';

    // Default preserves provider placement order
    const defaultOrder = await service.items(catId, 0, 10);
    expect(defaultOrder.map((i) => i.name)).toEqual([
      'The Matrix',
      'A Quiet Place',
      'An American Tale',
      'Zeta Drift',
    ]);

    // Alpha sorts by sort_title ASC, key ASC (leading articles stripped)
    const alphaOrder = await service.items(catId, 0, 10, { sortBy: 'alpha' });
    expect(alphaOrder.map((i) => i.name)).toEqual([
      'An American Tale',
      'The Matrix',
      'A Quiet Place',
      'Zeta Drift',
    ]);

    // Mark "The Matrix" watched on default profile, and "A Quiet Place" in-progress (unwatched)
    const matrixKey = defaultOrder[0]?.key ?? '';
    const quietKey = defaultOrder[1]?.key ?? '';
    await setItemWatched(panel.db, matrixKey, true, () => 6_000);
    await saveWatchProgress(
      panel.db,
      {
        sourceId: panel.sourceId,
        itemKey: quietKey,
        kind: 'movie',
        title: 'A Quiet Place',
        positionMs: 30_000,
        durationMs: 100_000,
      },
      () => 6_100,
    );

    // excludeWatched hides watched movie on default profile while keeping in-progress movie
    const unwatchedDefault = await service.items(catId, 0, 10, { excludeWatched: true });
    expect(unwatchedDefault.map((i) => i.name)).toEqual([
      'A Quiet Place',
      'An American Tale',
      'Zeta Drift',
    ]);

    // excludeWatched + sortBy alpha combined
    const unwatchedAlpha = await service.items(catId, 0, 10, {
      sortBy: 'alpha',
      excludeWatched: true,
    });
    expect(unwatchedAlpha.map((i) => i.name)).toEqual([
      'An American Tale',
      'A Quiet Place',
      'Zeta Drift',
    ]);

    // Different profile still sees The Matrix
    const kidsItems = await service.items(catId, 0, 10, {
      sortBy: 'alpha',
      excludeWatched: true,
      profileId: 'kids',
    });
    expect(kidsItems.map((i) => i.name)).toEqual([
      'An American Tale',
      'The Matrix',
      'A Quiet Place',
      'Zeta Drift',
    ]);

    // Cursor browse honors excludeWatched as well
    const cursorPage = await queryItemsByCursor(panel.db, catId, undefined, 10, {
      excludeWatched: true,
    });
    expect(cursorPage.items.map((i) => i.name)).toEqual([
      'A Quiet Place',
      'An American Tale',
      'Zeta Drift',
    ]);

    // Series watched filtering excludes series marked watched by series key
    const seriesCat = (await service.categories(panel.sourceId, 'series'))[0];
    const seriesAll = await service.items(seriesCat?.id ?? '', 0, 10, { sortBy: 'alpha' });
    expect(seriesAll.map((s) => s.name)).toEqual(['A Bit of Light', 'The Wire']);
    await setItemWatched(panel.db, seriesAll[0]?.key ?? '', true, () => 6_200);
    const unwatchedSeries = await service.items(seriesCat?.id ?? '', 0, 10, {
      sortBy: 'alpha',
      excludeWatched: true,
    });
    expect(unwatchedSeries.map((s) => s.name)).toEqual(['The Wire']);

    // Multi-source allSourcesItems with M3U + Xtream: sort_title written for M3U, alpha & excludeWatched work
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="VOD",The Abyss',
      'http://m3u.example/movie/abyss.mp4',
      '#EXTINF:-1 group-title="VOD",An Orchard',
      'http://m3u.example/movie/orchard.mp4',
    ].join('\n');
    const m3uService = createCatalogService({
      db: panel.db,
      secrets: panel.secrets,
      scheduler: countingScheduler(),
      http: m3uHttp(playlist),
      clock: () => 7_000,
      newId: () => 'm3u1',
    });
    const added = await m3uService.addSource({
      kind: 'm3u',
      name: 'M3U',
      playlistUrl: 'http://m3u.example/list.m3u',
      vodPlaylist: true,
    });
    if (!added.ok) throw new Error('expected m3u addSource ok');
    expect((await m3uService.importSource(added.value.id)).ok).toBe(true);

    const m3uStored = await panel.db.all<{ name: string; sort_title: string }>(
      "SELECT name, sort_title FROM movies WHERE source_id = 'm3u1' ORDER BY sort_title ASC",
    );
    expect(m3uStored).toEqual([
      { name: 'The Abyss', sort_title: 'abyss' },
      { name: 'An Orchard', sort_title: 'orchard' },
    ]);

    // Single-source allSourcesItems alpha + excludeWatched
    const singleAll = await queryAllSourcesItems(panel.db, 'movie', 0, 10, [panel.sourceId], {
      sortBy: 'alpha',
      excludeWatched: true,
    });
    expect(singleAll.map((i) => i.name)).toEqual([
      'An American Tale',
      'A Quiet Place',
      'Zeta Drift',
    ]);

    // Multi-source allSourcesItems alpha + excludeWatched sorts globally by sort_title without watched items
    const multiAll = await m3uService.allSourcesItems?.('movie', 0, 10, undefined, {
      sortBy: 'alpha',
      excludeWatched: true,
    });
    expect(multiAll?.map((i) => i.name)).toEqual([
      'The Abyss',
      'An American Tale',
      'An Orchard',
      'A Quiet Place',
      'Zeta Drift',
    ]);

    // Direct queryItems pagination with excludeWatched returns full page (filters before LIMIT)
    const ref = { sourceId: panel.sourceId, kind: 'movie' as const, providerId: '10' };
    const firstTwo = await queryItems(panel.db, ref, 0, 2, { excludeWatched: true });
    expect(firstTwo.map((i) => i.name)).toEqual(['A Quiet Place', 'An American Tale']);

    // Multi-source cursor browse honors excludeWatched too
    const multiCursor = await queryAllSourcesItemsByCursor(panel.db, 'movie', {}, 10, undefined, {
      excludeWatched: true,
    });
    expect(multiCursor.items.map((i) => i.name)).not.toContain('The Matrix');
    expect(multiCursor.items).toHaveLength(5);
  });

  it('deduplicates multiple in-progress episodes of the same series_key to 1 Continue Watching card', async () => {
    const { db } = testDb();
    await openCatalog(db);
    let now = 1_000;
    const clock = () => {
      now += 100;
      return now;
    };

    // Completed episode S01E01 of series A (must not appear)
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:episode:101',
        kind: 'episode',
        title: 'Show Alpha',
        subtitle: 'S01E01',
        seriesKey: 'x:s1:series:10',
        season: 1,
        episode: 1,
        positionMs: 95_000,
        durationMs: 100_000,
      },
      clock,
    );
    // Older in-progress episode S01E02 of series A
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:episode:102',
        kind: 'episode',
        title: 'Show Alpha',
        subtitle: 'S01E02',
        seriesKey: 'x:s1:series:10',
        season: 1,
        episode: 2,
        positionMs: 40_000,
        durationMs: 100_000,
      },
      clock,
    );
    // Standalone movie in-progress
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:movie:200',
        kind: 'movie',
        title: 'Lone Film',
        positionMs: 25_000,
        durationMs: 100_000,
      },
      clock,
    );
    // Newest in-progress episode S01E03 of series A (must be the sole card for series A)
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:episode:103',
        kind: 'episode',
        title: 'Show Alpha',
        subtitle: 'S01E03',
        seriesKey: 'x:s1:series:10',
        season: 1,
        episode: 3,
        positionMs: 15_000,
        durationMs: 100_000,
      },
      clock,
    );
    // Earlier in-progress episode S01E04 backdated older than S01E03
    await saveWatchProgress(
      db,
      {
        sourceId: 's1',
        itemKey: 'x:s1:episode:104',
        kind: 'episode',
        title: 'Show Alpha',
        subtitle: 'S01E04',
        seriesKey: 'x:s1:series:10',
        season: 1,
        episode: 4,
        positionMs: 20_000,
        durationMs: 100_000,
      },
      () => 1_150,
    );

    const rows = await listContinueWatching(db, 10);
    expect(rows.map((r) => ({ itemKey: r.itemKey, seriesKey: r.seriesKey }))).toEqual([
      { itemKey: 'x:s1:episode:103', seriesKey: 'x:s1:series:10' },
      { itemKey: 'x:s1:movie:200', seriesKey: null },
    ]);
  });

  it('heals missing sort_title column on drifted schema v8', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await db.exec('DROP INDEX idx_movies_sort_title');
    await db.exec('ALTER TABLE movies DROP COLUMN sort_title');
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'k1', 'The Drift', 'the drift', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('SELECT key, sort_title FROM movies')).toEqual([
      { key: 'k1', sort_title: 'drift' },
    ]);
  });
});
