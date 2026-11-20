import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { EXPECTED_TABLE_COLUMNS } from './schema';
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
      expect.arrayContaining(['idx_placements_browse', 'idx_live_num', 'idx_import_runs_source']),
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
      await t.db.exec('PRAGMA busy_timeout = 0');
      await openCatalog(t.db);
      expect(await t.db.all('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
      expect(await t.db.all('PRAGMA busy_timeout')).toEqual([{ timeout: 5000 }]);
      expect(await t.db.all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      expect(await t.db.all('PRAGMA synchronous')).toEqual([{ synchronous: 1 }]);
      expect(await t.db.all('PRAGMA temp_store')).toEqual([{ temp_store: 2 }]);
      expect(await t.db.all('PRAGMA journal_size_limit')).toEqual([
        { journal_size_limit: 67_108_864 },
      ]);
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
    const runs = await plan(
      db,
      "SELECT 1 FROM import_runs WHERE source_id = ? AND kind = 'catalog' AND status = 'ok'",
      ['s'],
    );
    expect(runs).toContain('idx_import_runs_source');
  });

  it('keeps EXPECTED_TABLE_COLUMNS aligned with every table and column in MIGRATIONS', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const tables = await names(db, 'table');
    expect(Object.keys(EXPECTED_TABLE_COLUMNS).sort()).toEqual(tables);
    for (const [table, expected] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
      const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
      expect(cols.map((c) => c.name)).toEqual(expected.map((c) => c.name));
    }
  });

  it('heals missing columns on a drifted database when user_version matches SCHEMA_VERSION', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    // Simulate drifted schema: drop columns from movies & episodes while user_version stays at SCHEMA_VERSION.
    await db.exec('ALTER TABLE movies DROP COLUMN added');
    await db.exec('ALTER TABLE movies DROP COLUMN headers_json');
    await db.exec('ALTER TABLE episodes DROP COLUMN duration_sec');
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'k1', 'Film', 'film', 1)",
    );

    const txAlters: string[] = [];
    let repairTxCount = 0;
    const spy: SqlDriver = {
      ...db,
      transaction: async (fn) => {
        repairTxCount += 1;
        return db.transaction((tx) =>
          fn({
            ...tx,
            exec: async (sql) => {
              txAlters.push(sql);
              return tx.exec(sql);
            },
          }),
        );
      },
    };

    expect((await openCatalog(spy)).ok).toBe(true);
    expect(repairTxCount).toBe(1);
    expect(txAlters).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ALTER TABLE movies ADD COLUMN added /),
        expect.stringMatching(/^ALTER TABLE movies ADD COLUMN headers_json /),
        expect.stringMatching(/^ALTER TABLE episodes ADD COLUMN duration_sec /),
      ]),
    );
    expect(txAlters).toHaveLength(3);

    const movieRows = await db.all<{
      key: string;
      added: number | null;
      headers_json: string | null;
    }>('SELECT key, added, headers_json FROM movies');
    expect(movieRows).toEqual([{ key: 'k1', added: null, headers_json: null }]);

    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, duration_sec, run_id) VALUES ('s1', 'ep1', 'ser1', 1800, 1)",
    );
    const epRows = await db.all<{ key: string; duration_sec: number }>(
      'SELECT key, duration_sec FROM episodes',
    );
    expect(epRows).toEqual([{ key: 'ep1', duration_sec: 1800 }]);
  });

  it('returns storage/schema-corrupt when a required table is missing at SCHEMA_VERSION', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.exec('DROP TABLE episodes');

    const result = await openCatalog(db);
    expect(result).toMatchObject({
      ok: false,
      error: { category: 'storage', code: 'schema-corrupt' },
    });
  });

  it('runs zero ALTER TABLE statements on a healthy database', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);

    const execCalls: string[] = [];
    let txCalls = 0;
    const spy: SqlDriver = {
      ...db,
      exec: async (sql) => {
        execCalls.push(sql);
        return db.exec(sql);
      },
      transaction: async (fn) => {
        txCalls += 1;
        return db.transaction(fn);
      },
    };

    expect((await openCatalog(spy)).ok).toBe(true);
    expect(txCalls).toBe(0);
    expect(execCalls.filter((sql) => sql.toUpperCase().includes('ALTER TABLE'))).toEqual([]);
  });
});
