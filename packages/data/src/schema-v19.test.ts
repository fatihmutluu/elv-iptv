import type { SecretStore, SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { removeSource, secretKey, TABLES_BY_SOURCE } from './sources';
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

describe('schema v19 (item_drm_meta)', () => {
  it('sets SCHEMA_VERSION to 19 and creates item_drm_meta with only non-secret columns and index', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBe(19);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 19 }]);

    expect(Object.keys(EXPECTED_TABLE_COLUMNS)).toContain('item_drm_meta');
    expect(TABLES_BY_SOURCE).toContain('item_drm_meta');

    const cols = (await db.all<{ name: string }>('PRAGMA table_info(item_drm_meta)')).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['source_id', 'item_key', 'scheme']);

    const byPk = await plan(
      db,
      'SELECT scheme FROM item_drm_meta WHERE source_id = ? AND item_key = ?',
      ['s1', 'm:s1:live:1'],
    );
    expect(byPk).toMatch(/SEARCH item_drm_meta USING PRIMARY KEY/);

    const bySource = await plan(db, 'SELECT item_key FROM item_drm_meta WHERE source_id = ?', [
      's1',
    ]);
    expect(bySource).toMatch(/idx_item_drm_meta_source|PRIMARY KEY/);
  });

  it('upgrades a v18 database to v19 while preserving existing rows', async () => {
    const { db } = testDb();
    for (let i = 0; i < 18; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 18');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:1', 'Sports HD', 'sports hd', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 19 }]);
    expect(await db.all('SELECT key, name FROM live')).toEqual([
      { key: 'm:s1:live:1', name: 'Sports HD' },
    ]);

    await db.run(
      "INSERT INTO item_drm_meta (source_id, item_key, scheme) VALUES ('s1', 'm:s1:live:1', 'clearkey')",
    );
    expect(await db.all('SELECT source_id, item_key, scheme FROM item_drm_meta')).toEqual([
      { source_id: 's1', item_key: 'm:s1:live:1', scheme: 'clearkey' },
    ]);
  });

  it('removeSource deletes item_drm_meta rows and drm_specs secrets only for that source', async () => {
    const { db } = testDb();
    const secrets = memorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'M1', 100, '{}')",
    );
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'm3u', 'M2', 100, '{}')",
    );
    await db.run(
      `INSERT INTO item_drm_meta (source_id, item_key, scheme)
       VALUES ('s1', 'm:s1:live:1', 'widevine'), ('s2', 'm:s2:live:1', 'clearkey')`,
    );
    await secrets.set(
      secretKey('s1', 'drm_specs'),
      JSON.stringify({ 'm:s1:live:1': { scheme: 'widevine', licenseUrl: 'https://l1.test/wv' } }),
    );
    await secrets.set(
      secretKey('s2', 'drm_specs'),
      JSON.stringify({
        'm:s2:live:1': {
          scheme: 'clearkey',
          clearKeys: [
            {
              kid: ['0011223344556677', '8899aabbccddeeff'].join(''),
              key: ['aabbccddeeff0011', '2233445566778899'].join(''),
            },
          ],
        },
      }),
    );

    const res = await removeSource('s1', { db, secrets });
    expect(res.ok).toBe(true);
    expect(await db.all('SELECT source_id, item_key, scheme FROM item_drm_meta')).toEqual([
      { source_id: 's2', item_key: 'm:s2:live:1', scheme: 'clearkey' },
    ]);
    expect(secrets.data.has(secretKey('s1', 'drm_specs'))).toBe(false);
    expect(secrets.data.has(secretKey('s2', 'drm_specs'))).toBe(true);
  });
});
