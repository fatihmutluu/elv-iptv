import { describe, expect, it } from 'vitest';
import { commitStagedCatalog, purgeStagedCatalog } from './catalog-commit';
import { performRun } from './import-run';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';

async function setup() {
  const t = testDb();
  await openCatalog(t.db);
  await t.db.batch(
    'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
    [
      ['s1', 'm3u', 'One', 1, '{}'],
      ['s2', 'm3u', 'Two', 1, '{}'],
    ],
  );
  return t;
}

describe('catalog-commit', () => {
  it('upserts staged catalog rows preserving existing ids and is_hidden, removes stale rows, and purges *_next for sourceId only', async () => {
    const { db } = await setup();

    // Seed run 1 live rows with is_hidden = 1 on one category, live channel, movie, series, and placement.
    await db.run(
      "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id, is_hidden) VALUES ('s1', 'live', 'News', 'News', 'news', 0, 1, 1)",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id, is_hidden) VALUES ('s1', 'm:s1:live:t:ch1', 'Channel 1', 'channel 1', 1, 1)",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id, is_hidden) VALUES ('s1', 'm:s1:live:t:stale', 'Stale', 'stale', 1, 0)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id, is_hidden) VALUES ('s1', 'm:s1:movie:n:m1|films', 'Movie 1', 'movie 1', 1, 1)",
    );
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, run_id, is_hidden) VALUES ('s1', 'm:s1:series:s1', 'Series 1', 'series 1', 1, 1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id, is_hidden) VALUES ('s1', 'live', 'm:s1:live:t:ch1', 'News', 0, 1, 1)",
    );

    const liveIdBefore = (
      await db.all<{ id: number }>("SELECT id FROM live WHERE key = 'm:s1:live:t:ch1'")
    )[0]?.id;
    const movieIdBefore = (
      await db.all<{ id: number }>("SELECT id FROM movies WHERE key = 'm:s1:movie:n:m1|films'")
    )[0]?.id;
    const seriesIdBefore = (
      await db.all<{ id: number }>("SELECT id FROM series WHERE key = 'm:s1:series:s1'")
    )[0]?.id;

    // Stage run 2 for s1 + an unrelated staged row for s2.
    await db.run(
      "INSERT INTO categories_next (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'News', 'News Updated', 'news updated', 0, 2)",
    );
    await db.run(
      "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:t:ch1', 'Channel 1 HD', 'channel 1 hd', 2)",
    );
    await db.run(
      "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s2', 'm:s2:live:t:other', 'Other', 'other', 1)",
    );
    await db.run(
      "INSERT INTO movies_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:movie:n:m1|films', 'Movie 1 Remastered', 'movie 1 remastered', 2)",
    );
    await db.run(
      "INSERT INTO series_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:series:s1', 'Series 1 Updated', 'series 1 updated', 2)",
    );
    await db.run(
      "INSERT INTO episodes_next (source_id, key, series_key, title, run_id) VALUES ('s1', 'm:s1:episode:n:ep1|s1', 'm:s1:series:s1', 'Ep 1', 2)",
    );
    await db.run(
      "INSERT INTO placements_next (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', 'm:s1:live:t:ch1', 'News', 0, 2)",
    );

    const removed = await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, []));
    expect(removed.live).toBe(1);

    // IDs and is_hidden are preserved; updated names and run_id applied.
    expect(
      await db.all("SELECT id, name, is_hidden, run_id FROM live WHERE source_id = 's1'"),
    ).toEqual([{ id: liveIdBefore, name: 'Channel 1 HD', is_hidden: 1, run_id: 2 }]);
    expect(
      await db.all("SELECT id, name, is_hidden, run_id FROM movies WHERE source_id = 's1'"),
    ).toEqual([{ id: movieIdBefore, name: 'Movie 1 Remastered', is_hidden: 1, run_id: 2 }]);
    expect(
      await db.all("SELECT id, name, is_hidden, run_id FROM series WHERE source_id = 's1'"),
    ).toEqual([{ id: seriesIdBefore, name: 'Series 1 Updated', is_hidden: 1, run_id: 2 }]);
    expect(
      await db.all("SELECT name, is_hidden, run_id FROM categories WHERE source_id = 's1'"),
    ).toEqual([{ name: 'News Updated', is_hidden: 1, run_id: 2 }]);
    expect(
      await db.all("SELECT item_key, is_hidden, run_id FROM placements WHERE source_id = 's1'"),
    ).toEqual([{ item_key: 'm:s1:live:t:ch1', is_hidden: 1, run_id: 2 }]);
    expect(await db.all("SELECT key FROM episodes WHERE source_id = 's1'")).toEqual([
      { key: 'm:s1:episode:n:ep1|s1' },
    ]);

    // FTS5 stays synchronized with the preserved rowid.
    const fts = await db.all<{ rowid: number }>(
      "SELECT rowid FROM live_fts WHERE live_fts MATCH 'hd'",
    );
    expect(fts.map((r) => r.rowid)).toEqual([liveIdBefore]);

    // s1 staging cleared, s2 staging untouched.
    expect(await db.all("SELECT * FROM live_next WHERE source_id = 's1'")).toEqual([]);
    expect(await db.all("SELECT key FROM live_next WHERE source_id = 's2'")).toEqual([
      { key: 'm:s2:live:t:other' },
    ]);

    // purgeStagedCatalog without sourceId clears remaining rows across all sources.
    expect(await purgeStagedCatalog(db)).toBe(1);
    expect(await db.all('SELECT * FROM live_next')).toEqual([]);
  });

  it('skips kinds in keepKinds without overwriting or deleting their existing live rows', async () => {
    const { db } = await setup();
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:movie:n:keep|f', 'Keep Movie', 'keep movie', 1)",
    );
    await db.run(
      "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:t:c1', 'Live 1', 'live 1', 2)",
    );

    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, ['movie']));
    expect(await db.all("SELECT key, run_id FROM movies WHERE source_id = 's1'")).toEqual([
      { key: 'm:s1:movie:n:keep|f', run_id: 1 },
    ]);
    expect(await db.all("SELECT key, run_id FROM live WHERE source_id = 's1'")).toEqual([
      { key: 'm:s1:live:t:c1', run_id: 2 },
    ]);
  });

  it('migrates legacy M3U keys across watch_progress, favorites, channel_guide, and live tables even when target keys already exist', async () => {
    const { db } = await setup();
    const legacyLive = 'm:s1:http://cdn.example/{{*}}/101.ts|Haber Bir';
    const stableLive = 'm:s1:live:t:haber1.tr';
    const legacyMovie = 'm:s1:http://cdn.example/movie/*/*/201.mkv|Film A';
    const stableMovie = 'm:s1:movie:n:film a|films';

    // Existing live/movie rows under legacy keys with is_hidden = 1.
    await db.run(
      'INSERT INTO live (source_id, key, name, name_fold, run_id, is_hidden) VALUES (?, ?, ?, ?, 1, 1)',
      ['s1', legacyLive, 'Haber Bir', 'haber bir'],
    );
    await db.run(
      'INSERT INTO movies (source_id, key, name, name_fold, run_id, is_hidden) VALUES (?, ?, ?, ?, 1, 1)',
      ['s1', legacyMovie, 'Film A', 'film a'],
    );
    // Also pre-seed a colliding target key in movies to verify UPDATE OR IGNORE + DELETE cleanup.
    await db.run(
      'INSERT INTO movies (source_id, key, name, name_fold, run_id, is_hidden) VALUES (?, ?, ?, ?, 1, 0)',
      ['s1', stableMovie, 'Film A Existing', 'film a existing'],
    );

    // User state under legacy keys + one colliding profile row on watch_progress & favorites.
    await db.batch(
      'INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ['p1', 's1', legacyLive, 'live', 'Haber Bir', 100],
        ['p2', 's1', legacyLive, 'live', 'Haber Bir', 101],
        ['p2', 's1', stableLive, 'live', 'Haber Bir New', 200],
        ['p1', 's1', legacyMovie, 'movie', 'Film A', 102],
      ],
    );
    await db.batch(
      `INSERT INTO watch_progress (profile_id, source_id, item_key, kind, title, position_ms, duration_ms, watched, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ['p1', 's1', legacyMovie, 'movie', 'Film A', 30_000, 90_000, 0, 100],
        ['p2', 's1', legacyMovie, 'movie', 'Film A', 10_000, 90_000, 0, 101],
        ['p2', 's1', stableMovie, 'movie', 'Film A', 50_000, 90_000, 0, 200],
      ],
    );
    await db.run('INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES (?, ?, ?)', [
      's1',
      legacyLive,
      'haber1.tr',
    ]);

    const liveIdBefore = (
      await db.all<{ id: number }>('SELECT id FROM live WHERE key = ?', [legacyLive])
    )[0]?.id;

    // Stage run 2 with stable keys + legacy_key references.
    await db.run(
      'INSERT INTO live_next (source_id, key, legacy_key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?, 2)',
      ['s1', stableLive, legacyLive, 'Haber Bir HD', 'haber bir hd'],
    );
    await db.run(
      'INSERT INTO movies_next (source_id, key, legacy_key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?, 2)',
      ['s1', stableMovie, legacyMovie, 'Film A HD', 'film a hd'],
    );

    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, []));

    // Live row kept its id and is_hidden = 1, migrated to stableLive; legacyLive gone.
    expect(await db.all("SELECT id, key, is_hidden FROM live WHERE source_id = 's1'")).toEqual([
      { id: liveIdBefore, key: stableLive, is_hidden: 1 },
    ]);
    // Movies kept single stableMovie row; legacyMovie cleaned up cleanly AND preserved is_hidden = 1!
    expect(await db.all("SELECT key, name, is_hidden FROM movies WHERE source_id = 's1'")).toEqual([
      { key: stableMovie, name: 'Film A HD', is_hidden: 1 },
    ]);
    // Favorites migrated for p1, redundant legacy row deleted for p2 without overwriting p2's newer row.
    expect(
      await db.all(
        'SELECT profile_id, item_key, added_at FROM favorites ORDER BY profile_id, item_key',
      ),
    ).toEqual([
      { profile_id: 'p1', item_key: stableLive, added_at: 100 },
      { profile_id: 'p1', item_key: stableMovie, added_at: 102 },
      { profile_id: 'p2', item_key: stableLive, added_at: 200 },
    ]);
    // Watch progress migrated for p1, redundant legacy row deleted for p2.
    expect(
      await db.all(
        'SELECT profile_id, item_key, position_ms FROM watch_progress ORDER BY profile_id, item_key',
      ),
    ).toEqual([
      { profile_id: 'p1', item_key: stableMovie, position_ms: 30_000 },
      { profile_id: 'p2', item_key: stableMovie, position_ms: 50_000 },
    ]);
    // channel_guide migrated to stableLive.
    expect(await db.all('SELECT channel_key, guide_id FROM channel_guide')).toEqual([
      { channel_key: stableLive, guide_id: 'haber1.tr' },
    ]);
  });

  it('losslessly merges conflicting watch_progress, favorites, live, movies, and placements rows on legacy M3U remap (#201)', async () => {
    const { db } = await setup();
    const legacyLive = 'm:s1:http://cdn.example/{{*}}/101.ts|Ch 1';
    const stableLive = 'm:s1:live:t:ch1';
    const legacyMovie = 'm:s1:http://cdn.example/movie/*/*/201.mkv|Film A';
    const stableMovie = 'm:s1:movie:n:film a|films';

    // Colliding live & placements rows: legacy has is_hidden = 1, stable has is_hidden = 0.
    await db.batch(
      'INSERT INTO live (source_id, key, name, name_fold, run_id, is_hidden) VALUES (?, ?, ?, ?, 1, ?)',
      [
        ['s1', legacyLive, 'Ch 1', 'ch 1', 1],
        ['s1', stableLive, 'Ch 1', 'ch 1', 0],
      ],
    );
    await db.batch(
      'INSERT INTO movies (source_id, key, name, name_fold, run_id, is_hidden) VALUES (?, ?, ?, ?, 1, ?)',
      [
        ['s1', legacyMovie, 'Film A', 'film a', 1],
        ['s1', stableMovie, 'Film A', 'film a', 0],
      ],
    );
    await db.batch(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id, is_hidden) VALUES ('s1', 'live', ?, 'News', 0, 1, ?)",
      [
        [legacyLive, 1],
        [stableLive, 0],
      ],
    );

    // watch_progress conflicts:
    // - p1: legacy is NEWER (updated_at=300) and watched=1, stable is older (updated_at=200, watched=0) -> adopt legacy pos/dur/updated_at + watched=1.
    // - p2: stable is NEWER (updated_at=400, watched=0), legacy is older (updated_at=100) but watched=1 -> keep stable pos/dur/updated_at + MAX(watched)=1.
    await db.batch(
      `INSERT INTO watch_progress (profile_id, source_id, item_key, kind, title, position_ms, duration_ms, watched, updated_at)
       VALUES (?, 's1', ?, 'movie', 'Film A', ?, ?, ?, ?)`,
      [
        ['p1', legacyMovie, 45_000, 95_000, 1, 300],
        ['p1', stableMovie, 10_000, 80_000, 0, 200],
        ['p2', legacyMovie, 70_000, 90_000, 1, 100],
        ['p2', stableMovie, 15_000, 92_000, 0, 400],
      ],
    );

    // favorites conflict: legacy has higher added_at (500) than stable (200) -> preserve MAX(added_at)=500.
    await db.batch(
      "INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at) VALUES (?, 's1', ?, 'live', 'Ch 1', ?)",
      [
        ['p1', legacyLive, 500],
        ['p1', stableLive, 200],
      ],
    );

    await db.run(
      'INSERT INTO live_next (source_id, key, legacy_key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?, 2)',
      ['s1', stableLive, legacyLive, 'Ch 1 HD', 'ch 1 hd'],
    );
    await db.run(
      'INSERT INTO movies_next (source_id, key, legacy_key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?, 2)',
      ['s1', stableMovie, legacyMovie, 'Film A HD', 'film a hd'],
    );
    await db.run(
      "INSERT INTO placements_next (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', ?, 'News', 0, 2)",
      [stableLive],
    );

    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, []));

    expect(
      await db.all(
        'SELECT profile_id, item_key, position_ms, duration_ms, watched, updated_at FROM watch_progress ORDER BY profile_id',
      ),
    ).toEqual([
      {
        profile_id: 'p1',
        item_key: stableMovie,
        position_ms: 45_000,
        duration_ms: 95_000,
        watched: 1,
        updated_at: 300,
      },
      {
        profile_id: 'p2',
        item_key: stableMovie,
        position_ms: 15_000,
        duration_ms: 92_000,
        watched: 1,
        updated_at: 400,
      },
    ]);
    expect(await db.all('SELECT profile_id, item_key, added_at FROM favorites')).toEqual([
      { profile_id: 'p1', item_key: stableLive, added_at: 500 },
    ]);
    expect(await db.all("SELECT key, is_hidden FROM live WHERE source_id = 's1'")).toEqual([
      { key: stableLive, is_hidden: 1 },
    ]);
    expect(await db.all("SELECT key, is_hidden FROM movies WHERE source_id = 's1'")).toEqual([
      { key: stableMovie, is_hidden: 1 },
    ]);
    expect(
      await db.all("SELECT item_key, is_hidden FROM placements WHERE source_id = 's1'"),
    ).toEqual([{ item_key: stableLive, is_hidden: 1 }]);
  });

  it('commits and remaps only staged rows matching runId and purges orphaned older run_id rows (#418)', async () => {
    const { db } = await setup();
    const orphanLegacy = 'm:s1:http://cdn.example/old/999.ts|Orphan';
    await db.run(
      "INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at) VALUES ('p1', 's1', ?, 'live', 'Orphan', 10)",
      [orphanLegacy],
    );
    // Seed an orphaned row from run 1 alongside valid run 2 rows.
    await db.batch(
      'INSERT INTO live_next (source_id, key, legacy_key, name, name_fold, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ['s1', 'm:s1:live:t:orphan', orphanLegacy, 'Orphan', 'orphan', 1],
        ['s1', 'm:s1:live:t:valid', null, 'Valid', 'valid', 2],
      ],
    );
    await db.batch(
      'INSERT INTO categories_next (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        ['s1', 'live', 'OldCat', 'OldCat', 'oldcat', 0, 1],
        ['s1', 'live', 'NewCat', 'NewCat', 'newcat', 0, 2],
      ],
    );
    await db.batch(
      'INSERT INTO placements_next (source_id, kind, item_key, category_id, position, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ['s1', 'live', 'm:s1:live:t:orphan', 'OldCat', 0, 1],
        ['s1', 'live', 'm:s1:live:t:valid', 'NewCat', 0, 2],
      ],
    );

    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, []));

    expect(await db.all("SELECT key FROM live WHERE source_id = 's1'")).toEqual([
      { key: 'm:s1:live:t:valid' },
    ]);
    expect(await db.all("SELECT provider_id FROM categories WHERE source_id = 's1'")).toEqual([
      { provider_id: 'NewCat' },
    ]);
    expect(await db.all("SELECT item_key FROM placements WHERE source_id = 's1'")).toEqual([
      { item_key: 'm:s1:live:t:valid' },
    ]);
    // Orphan legacy favorite was NOT remapped by the orphaned run 1 row.
    expect(await db.all('SELECT item_key FROM favorites')).toEqual([{ item_key: orphanLegacy }]);
    // All *_next tables for s1 were purged, including the orphaned run 1 rows.
    expect(await db.all("SELECT * FROM live_next WHERE source_id = 's1'")).toEqual([]);
    expect(await db.all("SELECT * FROM categories_next WHERE source_id = 's1'")).toEqual([]);
    expect(await db.all("SELECT * FROM placements_next WHERE source_id = 's1'")).toEqual([]);
  });

  it('performRun purges pre-existing *_next rows for sourceId before execute() starts (#418)', async () => {
    const { db } = await setup();
    await db.run(
      "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:t:leftover', 'Leftover', 'leftover', 1)",
    );
    await db.run(
      "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s2', 'm:s2:live:t:other', 'Other', 'other', 1)",
    );

    let s1CountAtExecuteStart = -1;
    let s2CountAtExecuteStart = -1;
    const res = await performRun(
      { id: 's1', kind: 'm3u', name: 'One', createdAt: 1, settings: {} },
      {
        db,
        http: {
          get: async () => {
            throw new Error('unused');
          },
        },
        secrets: memorySecrets(),
        scheduler: countingScheduler(),
        clock: () => 1000,
      },
      {},
      {
        execute: async (c) => {
          s1CountAtExecuteStart = (await c.db.all("SELECT * FROM live_next WHERE source_id = 's1'"))
            .length;
          s2CountAtExecuteStart = (await c.db.all("SELECT * FROM live_next WHERE source_id = 's2'"))
            .length;
          await c.db.run(
            "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:t:fresh', 'Fresh', 'fresh', ?)",
            [c.runId],
          );
          c.counts.live = 1;
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(s1CountAtExecuteStart).toBe(0);
    expect(s2CountAtExecuteStart).toBe(1);
    expect(await db.all("SELECT key FROM live WHERE source_id = 's1'")).toEqual([
      { key: 'm:s1:live:t:fresh' },
    ]);
  });
});
