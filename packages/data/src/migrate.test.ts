import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { tempFileDb, testDb } from './test-db';

const TABLES = [
  'sources',
  'import_runs',
  'categories',
  'live',
  'movies',
  'series',
  'episodes',
  'placements',
  'guide_channels',
  'channel_guide',
  'programmes',
  'programmes_next',
];

async function names(db: SqlDriver, type: 'table' | 'index') {
  const rows = await db.all<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name',
    [type, 'sqlite_%'],
  );
  return rows.map((r) => r.name);
}

async function plan(db: SqlDriver, sql: string, params: (string | number)[]) {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

describe('openCatalog', () => {
  it('creates schema v1 on a fresh database', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBe(1);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 1 }]);
    expect(await names(db, 'table')).toEqual([...TABLES].sort());
    expect(await names(db, 'index')).toEqual(
      expect.arrayContaining(['idx_placements_browse', 'idx_live_num']),
    );
  });

  it('is a no-op the second time', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s','m3u','n',0,'{}')",
    );
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('SELECT count(*) AS n FROM sources')).toEqual([{ n: 1 }]);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 1 }]);
  });

  it('applies pragmas, with WAL on file databases', async () => {
    const t = tempFileDb();
    try {
      await openCatalog(t.db);
      expect(await t.db.all('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
      expect(await t.db.all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      expect(await t.db.all('PRAGMA synchronous')).toEqual([{ synchronous: 1 }]);
      expect(await t.db.all('PRAGMA temp_store')).toEqual([{ temp_store: 2 }]);
    } finally {
      t.close();
    }
  });

  it('reports memory journal mode for in-memory databases', async () => {
    const { db } = testDb();
    await openCatalog(db);
    expect(await db.all('PRAGMA journal_mode')).toEqual([{ journal_mode: 'memory' }]);
    expect(await db.all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });

  it('recovers interrupted runs after a migration too', async () => {
    const { db } = testDb();
    const statements: string[] = [];
    const recording: SqlDriver = {
      ...db,
      run: (sql, params) => {
        statements.push(sql);
        return db.run(sql, params);
      },
    };
    expect((await openCatalog(recording)).ok).toBe(true);
    expect(statements.some((s) => s.includes("error_code = 'interrupted'"))).toBe(true);
  });

  it('refuses a database written by a newer version', async () => {
    const { db } = testDb();
    await db.exec('PRAGMA user_version = 2');
    const r = await openCatalog(db);
    expect(r).toMatchObject({ ok: false, error: { category: 'storage', code: 'schema-too-new' } });
    expect(await names(db, 'table')).toEqual([]);
  });

  it('returns a storage error when the migration fails', async () => {
    const { db } = testDb();
    await db.exec('CREATE TABLE sources (x)');
    const r = await openCatalog(db);
    expect(r).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'migration-failed' },
    });
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 0 }]);
  });

  it('uses the intended indexes', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const browse = await plan(
      db,
      'SELECT item_key FROM placements WHERE source_id = ? AND kind = ? AND category_id = ? ORDER BY position',
      ['s', 'live', 1],
    );
    expect(browse).toContain('idx_placements_browse');
    expect(browse).not.toMatch(/TEMP B-TREE/);
    const live = await plan(db, 'SELECT id FROM live WHERE source_id = ? ORDER BY num', ['s']);
    expect(live).toContain('idx_live_num');
    expect(live).not.toMatch(/TEMP B-TREE/);
    const epg = await plan(
      db,
      'SELECT title FROM programmes WHERE source_id = ? AND guide_id = ? AND start >= ? ORDER BY start',
      ['s', 'g', 0],
    );
    expect(epg).toMatch(/SEARCH programmes USING PRIMARY KEY/);
    expect(epg).not.toMatch(/TEMP B-TREE/);
    const episodes = await plan(
      db,
      'SELECT provider_id, extension FROM episodes WHERE source_id = ? AND series_key = ? ORDER BY season, episode',
      ['s', 'x:s:series:1'],
    );
    expect(episodes).toContain('idx_episodes_series');
    expect(episodes).not.toMatch(/TEMP B-TREE/);
  });
});
