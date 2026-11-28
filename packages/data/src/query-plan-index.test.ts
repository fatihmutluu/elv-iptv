import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import { queryEpisodes, querySeasons } from './queries';
import { testDb } from './test-db';

async function explainPlan(
  db: SqlDriver,
  sql: string,
  params: (string | number)[] = [],
): Promise<string> {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

describe('SQLite index-friendly query plans audit (F-14 #2 / Wave Q7-B)', () => {
  it('verifies key live, VOD, episodes, recent channels, favorites, EPG, and live favorite folder queries use B-tree indexes cleanly', async () => {
    const { db } = testDb();
    await openCatalog(db);

    // Seed minimal rows including season=NULL legacy episode and season=1 episodes
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
    );
    await db.run(
      "INSERT INTO series (source_id, key, provider_id, name, name_fold, sort_title, run_id) VALUES ('s1', 'x:s1:series:1', '1', 'Show', 'show', 'show', 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id) VALUES ('s1', 'x:s1:ep:0', 'x:s1:series:1', NULL, 1, 'Special', 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id) VALUES ('s1', 'x:s1:ep:1', 'x:s1:series:1', 1, 1, 'Pilot', 1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, season, episode, title, run_id) VALUES ('s1', 'x:s1:ep:2', 'x:s1:series:1', 1, 2, 'Second', 1)",
    );

    // Functional correctness for NULL/0 season + season 1 after index-friendly refactor
    expect(await querySeasons(db, { sourceId: 's1', key: 'x:s1:series:1' })).toEqual([
      { season: 0, episodeCount: 1 },
      { season: 1, episodeCount: 2 },
    ]);
    expect(
      (await queryEpisodes(db, { sourceId: 's1', key: 'x:s1:series:1' }, 0)).map((e) => e.key),
    ).toEqual(['x:s1:ep:0']);
    expect(
      (await queryEpisodes(db, { sourceId: 's1', key: 'x:s1:series:1' }, 1)).map((e) => e.key),
    ).toEqual(['x:s1:ep:1', 'x:s1:ep:2']);

    // 1. Episodes season query uses idx_episodes_series with zero TEMP B-TREE
    const episodesPlan = await explainPlan(
      db,
      `SELECT id, key, COALESCE(season, 0) AS season, episode, title, duration_sec
         FROM episodes
        WHERE source_id = ? AND series_key = ? AND season = ?
        ORDER BY episode, id`,
      ['s1', 'x:s1:series:1', 1],
    );
    expect(episodesPlan).toContain('idx_episodes_series');
    expect(episodesPlan).not.toMatch(/TEMP B-TREE/);

    // 2. Seasons aggregation uses covering idx_episodes_series with zero TEMP B-TREE
    const seasonsPlan = await explainPlan(
      db,
      `SELECT season, COUNT(*) AS n
         FROM episodes
        WHERE source_id = ? AND series_key = ?
        GROUP BY season
        ORDER BY season`,
      ['s1', 'x:s1:series:1'],
    );
    expect(seasonsPlan).toContain('idx_episodes_series');
    expect(seasonsPlan).not.toMatch(/TEMP B-TREE/);

    // 3. Recent channels ordering uses idx_recent_channels_order with zero TEMP B-TREE
    const recentPlan = await explainPlan(
      db,
      `SELECT r.item_key
         FROM recent_channels r
        WHERE r.profile_id = ?
        ORDER BY r.watched_at DESC, r.item_key ASC
        LIMIT 20`,
      ['default'],
    );
    expect(recentPlan).toContain('idx_recent_channels_order');
    expect(recentPlan).not.toMatch(/TEMP B-TREE/);

    // 4. Category placements browse uses idx_placements_visible with zero TEMP B-TREE
    const placementsPlan = await explainPlan(
      db,
      `SELECT p.item_key
         FROM placements p
        WHERE p.source_id = ? AND p.kind = 'live' AND p.category_id = ? AND p.is_hidden = 0
        ORDER BY p.position
        LIMIT 50`,
      ['s1', 'cat1'],
    );
    expect(placementsPlan).toContain('idx_placements_visible');
    expect(placementsPlan).not.toMatch(/TEMP B-TREE/);

    // 5. Alpha browse on live / movies / series uses idx_*_sort_title with zero TEMP B-TREE
    for (const table of ['live', 'movies', 'series'] as const) {
      const alphaPlan = await explainPlan(
        db,
        `SELECT key FROM ${table} WHERE source_id = ? AND is_hidden = 0 ORDER BY sort_title ASC, key ASC LIMIT 50`,
        ['s1'],
      );
      expect(alphaPlan).toContain(`idx_${table}_sort_title`);
      expect(alphaPlan).not.toMatch(/TEMP B-TREE/);
    }

    // 6. EPG programmes window uses indexed primary key or idx_programmes_source_start_stop (no full SCAN)
    const epgPlan = await explainPlan(
      db,
      `SELECT guide_id, start, stop, title
         FROM programmes
        WHERE source_id = ? AND start < ? AND stop > ?`,
      ['s1', 2000, 1000],
    );
    expect(epgPlan).toMatch(/USING INDEX idx_programmes_source_(?:start_)?stop/);
    expect(epgPlan).not.toMatch(/\bSCAN programmes\b/);

    // 7. Favorites lookup uses idx_favorites_recent
    const favPlan = await explainPlan(
      db,
      `SELECT item_key FROM favorites WHERE profile_id = ? ORDER BY added_at DESC LIMIT 50`,
      ['default'],
    );
    expect(favPlan).toContain('idx_favorites_recent');
    expect(favPlan).not.toMatch(/TEMP B-TREE/);

    // 8. Live favorite folders & items use v26 indexes cleanly with zero TEMP B-TREE
    const foldersPlan = await explainPlan(
      db,
      `SELECT id, name FROM live_favorite_folders WHERE profile_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC`,
      ['default'],
    );
    expect(foldersPlan).toContain('idx_live_fav_folders_profile');
    expect(foldersPlan).not.toMatch(/TEMP B-TREE/);

    const folderItemsPlan = await explainPlan(
      db,
      `SELECT item_key FROM live_favorite_folder_items WHERE folder_id = ? ORDER BY position`,
      ['lff_1'],
    );
    expect(folderItemsPlan).toContain('idx_live_fav_folder_items_folder');
    expect(folderItemsPlan).not.toMatch(/TEMP B-TREE/);

    const folderItemsSourcePlan = await explainPlan(
      db,
      `SELECT item_key FROM live_favorite_folder_items WHERE source_id = ?`,
      ['s1'],
    );
    expect(folderItemsSourcePlan).toContain('idx_live_fav_folder_items_source');
  });
});
