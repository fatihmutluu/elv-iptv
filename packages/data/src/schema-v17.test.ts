import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { testDb } from './test-db';

async function plan(db: SqlDriver, sql: string, params: (string | number)[]) {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

describe('schema v17 (failover_groups & failover_group_members)', () => {
  it('sets SCHEMA_VERSION to 17 and creates failover tables and indexes on a fresh database', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(17);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    expect(Object.keys(EXPECTED_TABLE_COLUMNS)).toEqual(
      expect.arrayContaining(['failover_groups', 'failover_group_members']),
    );

    const groupCols = (await db.all<{ name: string }>('PRAGMA table_info(failover_groups)')).map(
      (c) => c.name,
    );
    expect(groupCols).toEqual([
      'id',
      'name',
      'name_fold',
      'auto_matched',
      'created_at',
      'updated_at',
    ]);

    const memberCols = (
      await db.all<{ name: string }>('PRAGMA table_info(failover_group_members)')
    ).map((c) => c.name);
    expect(memberCols).toEqual(['group_id', 'source_id', 'channel_key', 'position']);

    const byGroup = await plan(
      db,
      'SELECT channel_key FROM failover_group_members WHERE group_id = ? ORDER BY position',
      ['fg1'],
    );
    expect(byGroup).toContain('idx_failover_members_group');
    expect(byGroup).not.toMatch(/TEMP B-TREE/);

    const byChannel = await plan(
      db,
      'SELECT group_id FROM failover_group_members WHERE channel_key = ?',
      ['m:s1:live:1'],
    );
    expect(byChannel).toContain('idx_failover_members_channel');

    const bySource = await plan(
      db,
      'SELECT group_id FROM failover_group_members WHERE source_id = ?',
      ['s1'],
    );
    expect(bySource).toContain('idx_failover_members_source');
  });

  it('upgrades a v16 database to v17 while preserving existing catalog rows', async () => {
    const { db } = testDb();
    for (let i = 0; i < 16; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 16');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:1', 'News One', 'news one', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(await db.all('SELECT key, name FROM live')).toEqual([
      { key: 'm:s1:live:1', name: 'News One' },
    ]);

    await db.run(
      `INSERT INTO failover_groups (id, name, name_fold, auto_matched, created_at, updated_at)
       VALUES ('fg1', 'News One', 'news one', 0, 100, 100)`,
    );
    await db.run(
      `INSERT INTO failover_group_members (group_id, source_id, channel_key, position)
       VALUES ('fg1', 's1', 'm:s1:live:1', 0)`,
    );
    expect(
      await db.all('SELECT group_id, source_id, channel_key, position FROM failover_group_members'),
    ).toEqual([{ group_id: 'fg1', source_id: 's1', channel_key: 'm:s1:live:1', position: 0 }]);
  });
});
