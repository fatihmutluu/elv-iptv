import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { testDb } from './test-db';

describe('schema v20 (favorites.sort_order)', () => {
  it('sets SCHEMA_VERSION >= 20 and includes sort_order on favorites', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    expect(EXPECTED_TABLE_COLUMNS.favorites?.map((c) => c.name)).toContain('sort_order');

    const cols = (await db.all<{ name: string }>('PRAGMA table_info(favorites)')).map(
      (c) => c.name,
    );
    expect(cols).toContain('sort_order');
  });

  it('upgrades a v19 database to v20 while preserving existing favorites with default sort_order = 0', async () => {
    const { db } = testDb();
    for (let i = 0; i < 19; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 19');
    await db.run(
      `INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at)
       VALUES ('default', 's1', 'x:s1:live:1', 'live', 'Channel One', 1000)`,
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(await db.all('SELECT item_key, title, sort_order FROM favorites')).toEqual([
      { item_key: 'x:s1:live:1', title: 'Channel One', sort_order: 0 },
    ]);
  });

  it('self-heals a drifted database missing favorites.sort_order', async () => {
    const { db } = testDb();
    for (let i = 0; i < MIGRATIONS.length; i += 1) {
      if (i === 19) continue;
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    const colsBefore = (await db.all<{ name: string }>('PRAGMA table_info(favorites)')).map(
      (c) => c.name,
    );
    expect(colsBefore).not.toContain('sort_order');

    expect((await openCatalog(db)).ok).toBe(true);
    const colsAfter = (await db.all<{ name: string }>('PRAGMA table_info(favorites)')).map(
      (c) => c.name,
    );
    expect(colsAfter).toContain('sort_order');
  });
});
