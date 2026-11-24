import type { SecretStore, SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { createProfile, deleteProfile } from './profiles-repo';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { removeSource, TABLES_BY_SOURCE } from './sources';
import { testDb } from './test-db';

async function plan(db: SqlDriver, sql: string, params: (string | number)[]) {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

describe('schema v18 (vod_enrichment, vod_collections & vod_collection_items)', () => {
  it('sets SCHEMA_VERSION to 18 and creates v18 tables and indexes on a fresh database', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBe(18);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 18 }]);

    expect(Object.keys(EXPECTED_TABLE_COLUMNS)).toEqual(
      expect.arrayContaining(['vod_enrichment', 'vod_collections', 'vod_collection_items']),
    );
    expect(TABLES_BY_SOURCE).toEqual(
      expect.arrayContaining(['vod_enrichment', 'vod_collection_items']),
    );

    const enrichCols = (await db.all<{ name: string }>('PRAGMA table_info(vod_enrichment)')).map(
      (c) => c.name,
    );
    expect(enrichCols).toEqual([
      'item_key',
      'source_id',
      'clean_title',
      'release_year',
      'rating',
      'rating_source',
      'genres_json',
      'synopsis',
      'certification',
      'fetched_at',
      'expires_at',
    ]);

    const colCols = (await db.all<{ name: string }>('PRAGMA table_info(vod_collections)')).map(
      (c) => c.name,
    );
    expect(colCols).toEqual([
      'id',
      'profile_id',
      'name',
      'name_fold',
      'sort_order',
      'created_at',
      'updated_at',
    ]);

    const itemCols = (
      await db.all<{ name: string }>('PRAGMA table_info(vod_collection_items)')
    ).map((c) => c.name);
    expect(itemCols).toEqual([
      'collection_id',
      'item_key',
      'source_id',
      'kind',
      'position',
      'added_at',
    ]);

    const enrichBySource = await plan(
      db,
      'SELECT item_key FROM vod_enrichment WHERE source_id = ?',
      ['s1'],
    );
    expect(enrichBySource).toContain('idx_vod_enrichment_source');

    const collectionsByProfile = await plan(
      db,
      'SELECT id FROM vod_collections WHERE profile_id = ? ORDER BY sort_order',
      ['default'],
    );
    expect(collectionsByProfile).toContain('idx_vod_collections_profile');
    expect(collectionsByProfile).not.toMatch(/TEMP B-TREE/);

    const itemsByOrder = await plan(
      db,
      'SELECT item_key FROM vod_collection_items WHERE collection_id = ? ORDER BY position',
      ['c1'],
    );
    expect(itemsByOrder).toContain('idx_vod_collection_items_order');
    expect(itemsByOrder).not.toMatch(/TEMP B-TREE/);

    const itemsBySource = await plan(
      db,
      'SELECT item_key FROM vod_collection_items WHERE source_id = ?',
      ['s1'],
    );
    expect(itemsBySource).toContain('idx_vod_collection_items_source');

    const itemsByKey = await plan(
      db,
      'SELECT collection_id FROM vod_collection_items WHERE item_key = ?',
      ['x:s1:movie:1'],
    );
    expect(itemsByKey).toContain('idx_vod_collection_items_key');
  });

  it('upgrades a v17 database to v18 while preserving existing rows', async () => {
    const { db } = testDb();
    for (let i = 0; i < 17; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 17');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:movie:1', 'Solaris', 'solaris', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 18 }]);
    expect(await db.all('SELECT key, name FROM movies')).toEqual([
      { key: 'm:s1:movie:1', name: 'Solaris' },
    ]);

    await db.run(
      `INSERT INTO vod_enrichment
         (item_key, source_id, clean_title, release_year, rating, rating_source, genres_json, synopsis, certification, fetched_at, expires_at)
       VALUES ('m:s1:movie:1', 's1', 'Solaris', 1972, 8.0, 'local-index', '["Sci-Fi"]', 'Space station.', 'PG', 1000, 2000)`,
    );
    await db.run(
      `INSERT INTO vod_collections (id, profile_id, name, name_fold, sort_order, created_at, updated_at)
       VALUES ('col1', 'default', 'Sci-Fi', 'sci fi', 0, 1000, 1000)`,
    );
    await db.run(
      `INSERT INTO vod_collection_items (collection_id, item_key, source_id, kind, position, added_at)
       VALUES ('col1', 'm:s1:movie:1', 's1', 'movie', 0, 1000)`,
    );

    expect(await db.all('SELECT clean_title, release_year FROM vod_enrichment')).toEqual([
      { clean_title: 'Solaris', release_year: 1972 },
    ]);
    expect(await db.all('SELECT collection_id, item_key FROM vod_collection_items')).toEqual([
      { collection_id: 'col1', item_key: 'm:s1:movie:1' },
    ]);
  });

  it('removeSource purges vod_enrichment, vod_collection_items, and Stalker secrets only for that source', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'stalker', 'Portal 1', 100, '{}')",
    );
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'stalker', 'Portal 2', 100, '{}')",
    );
    await secrets.set('source.s1.stalker', '{"portalUrl":"http://p1","mac":"00:1A:79:00:00:01"}');
    await secrets.set('source.s1.stalker_cmds', '{"live:1":"ffrt http://localhost/ch/1"}');
    await secrets.set('source.s2.stalker', '{"portalUrl":"http://p2","mac":"00:1A:79:00:00:02"}');

    await db.run(
      `INSERT INTO vod_enrichment (item_key, source_id, clean_title, fetched_at, expires_at)
       VALUES ('s:s1:movie:1', 's1', 'A', 1, 9999), ('s:s2:movie:2', 's2', 'B', 1, 9999)`,
    );
    await db.run(
      `INSERT INTO vod_collections (id, profile_id, name, name_fold, sort_order, created_at, updated_at)
       VALUES ('c1', 'default', 'Weekend', 'weekend', 0, 1, 1)`,
    );
    await db.run(
      `INSERT INTO vod_collection_items (collection_id, item_key, source_id, kind, position, added_at)
       VALUES ('c1', 's:s1:movie:1', 's1', 'movie', 0, 1), ('c1', 's:s2:movie:2', 's2', 'movie', 1, 2)`,
    );

    const res = await removeSource('s1', { db, secrets });
    expect(res.ok).toBe(true);

    expect(await db.all('SELECT item_key FROM vod_enrichment')).toEqual([
      { item_key: 's:s2:movie:2' },
    ]);
    expect(await db.all('SELECT item_key FROM vod_collection_items')).toEqual([
      { item_key: 's:s2:movie:2' },
    ]);
    expect(secrets.data.has('source.s1.stalker')).toBe(false);
    expect(secrets.data.has('source.s1.stalker_cmds')).toBe(false);
    expect(secrets.data.has('source.s2.stalker')).toBe(true);
  });

  it('deleteProfile cascades vod_collections and vod_collection_items for that profile', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const created = await createProfile(
      db,
      { name: 'Guest' },
      () => 1000,
      () => 'guest',
    );
    expect(created.ok).toBe(true);
    await db.run(
      `INSERT INTO vod_collections (id, profile_id, name, name_fold, sort_order, created_at, updated_at)
       VALUES ('c-def', 'default', 'Keep', 'keep', 0, 1, 1), ('c-guest', 'guest', 'Drop', 'drop', 0, 1, 1)`,
    );
    await db.run(
      `INSERT INTO vod_collection_items (collection_id, item_key, source_id, kind, position, added_at)
       VALUES ('c-def', 'x:s1:movie:1', 's1', 'movie', 0, 1), ('c-guest', 'x:s1:movie:2', 's1', 'movie', 0, 1)`,
    );

    const deleted = await deleteProfile(db, secrets, 'guest');
    expect(deleted.ok).toBe(true);
    expect(await db.all('SELECT id FROM vod_collections')).toEqual([{ id: 'c-def' }]);
    expect(await db.all('SELECT collection_id FROM vod_collection_items')).toEqual([
      { collection_id: 'c-def' },
    ]);
  });
});
