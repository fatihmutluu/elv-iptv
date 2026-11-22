import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { EXPECTED_FTS_TABLES, EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { tempFileDb, testDb } from './test-db';

const TABLES = [
  'sources',
  'import_runs',
  'categories',
  'categories_next',
  'live',
  'live_next',
  'movies',
  'movies_next',
  'series',
  'series_next',
  'episodes',
  'episodes_next',
  'placements',
  'placements_next',
  'guide_channels',
  'channel_guide',
  'programmes',
  'programmes_next',
  'watch_progress',
  'favorites',
];

const FTS_TABLE_PREFIXES = ['live_fts', 'movies_fts', 'series_fts'] as const;

function isFtsTableOrShadow(name: string): boolean {
  return FTS_TABLE_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`));
}

async function names(db: SqlDriver, type: 'table' | 'index') {
  const rows = await db.all<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name',
    [type, 'sqlite_%'],
  );
  return rows.map((r) => r.name);
}

async function regularTableNames(db: SqlDriver) {
  return (await names(db, 'table')).filter((name) => !isFtsTableOrShadow(name));
}

async function plan(db: SqlDriver, sql: string, params: (string | number)[]) {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

describe('openCatalog', () => {
  it('creates schema v6 with FTS5 tables, staging tables, backup_urls_json, epg_shift_ms, and visible browse index on a fresh database', async () => {
    const { db } = testDb();
    expect(SCHEMA_VERSION).toBe(6);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
    expect(await regularTableNames(db)).toEqual([...TABLES].sort());
    expect(await names(db, 'table')).toEqual(expect.arrayContaining([...EXPECTED_FTS_TABLES]));
    expect(await names(db, 'index')).toEqual(
      expect.arrayContaining([
        'idx_placements_browse',
        'idx_placements_visible',
        'idx_live_num',
        'idx_import_runs_source',
        'idx_watch_progress_recent',
        'idx_watch_progress_source',
        'idx_favorites_recent',
        'idx_favorites_source',
        'idx_programmes_source_start_stop',
      ]),
    );
  });

  it('upgrades a v1 database to v6 while preserving existing catalog rows and rebuilding FTS5', async () => {
    const { db } = testDb();
    await db.exec(MIGRATIONS[0] ?? '');
    await db.exec('PRAGMA user_version = 1');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1','m3u','Main',100,'{}')",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:1', 'Silent Horizon', 'silent horizon', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
    expect(await db.all('SELECT id, name, deleting FROM sources')).toEqual([
      { id: 's1', name: 'Main', deleting: 0 },
    ]);
    expect(await db.all('SELECT key, name, is_hidden, backup_urls_json FROM movies')).toEqual([
      { key: 'm:s1:1', name: 'Silent Horizon', is_hidden: 0, backup_urls_json: null },
    ]);
    expect(await regularTableNames(db)).toEqual([...TABLES].sort());
    expect(await names(db, 'index')).toContain('idx_programmes_source_start_stop');
    expect(await names(db, 'index')).toContain('idx_placements_visible');
    expect(
      await db.all<{ key: string }>(
        `SELECT t.key FROM movies_fts JOIN movies t ON t.id = movies_fts.rowid WHERE movies_fts MATCH '"silent"*'`,
      ),
    ).toEqual([{ key: 'm:s1:1' }]);
  });

  it('upgrades a v2 database to v6 and makes pre-existing live, movie, and series rows immediately searchable', async () => {
    const { db } = testDb();
    await db.exec(MIGRATIONS[0] ?? '');
    await db.exec(MIGRATIONS[1] ?? '');
    await db.exec('PRAGMA user_version = 2');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1','xtream','Main',100,'{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:live:1', 'İstanbul Haber HD', 'istanbul haber hd', 1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:1', 'Güneş Yolu', 'gunes yolu', 1)",
    );
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:series:1', 'Özgür Gece', 'ozgur gece', 1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
    expect(await names(db, 'index')).toContain('idx_programmes_source_start_stop');
    expect(
      await db.all<{ key: string }>(
        `SELECT t.key FROM live_fts JOIN live t ON t.id = live_fts.rowid WHERE live_fts MATCH '"istanbul"*'`,
      ),
    ).toEqual([{ key: 'x:s1:live:1' }]);
    expect(
      await db.all<{ key: string }>(
        `SELECT t.key FROM movies_fts JOIN movies t ON t.id = movies_fts.rowid WHERE movies_fts MATCH '"gunes"*'`,
      ),
    ).toEqual([{ key: 'x:s1:movie:1' }]);
    expect(
      await db.all<{ key: string }>(
        `SELECT t.key FROM series_fts JOIN series t ON t.id = series_fts.rowid WHERE series_fts MATCH '"ozgur"*'`,
      ),
    ).toEqual([{ key: 'x:s1:series:1' }]);
  });

  it('upgrades a v3 database to v6, creates idx_programmes_source_start_stop, and preserves programmes', async () => {
    const { db } = testDb();
    await db.exec(MIGRATIONS[0] ?? '');
    await db.exec(MIGRATIONS[1] ?? '');
    await db.exec(MIGRATIONS[2] ?? '');
    await db.exec('PRAGMA user_version = 3');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1','xtream','Main',100,'{}')",
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, run_id)
       VALUES ('s1', 'g1', 1000, 4600, 'Morning Brief', 1)`,
    );
    expect(await names(db, 'index')).not.toContain('idx_programmes_source_start_stop');

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
    expect(await names(db, 'index')).toContain('idx_programmes_source_start_stop');
    expect(await db.all('SELECT guide_id, title FROM programmes')).toEqual([
      { guide_id: 'g1', title: 'Morning Brief' },
    ]);
  });

  it('upgrades a v4 database to v6, defaulting deleting/is_hidden to 0 and creating all 6 staging tables', async () => {
    const { db } = testDb();
    await db.exec(MIGRATIONS[0] ?? '');
    await db.exec(MIGRATIONS[1] ?? '');
    await db.exec(MIGRATIONS[2] ?? '');
    await db.exec(MIGRATIONS[3] ?? '');
    await db.exec('PRAGMA user_version = 4');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1','m3u','Main',100,'{}')",
    );
    await db.run(
      "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1','live','c1','News','news',0,1)",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1','m:s1:live:1','Ch1','ch1',1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1','m:s1:movie:1','Mov1','mov1',1)",
    );
    await db.run(
      "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s1','m:s1:series:1','Ser1','ser1',1)",
    );
    await db.run(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1','live','m:s1:live:1','c1',0,1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
    expect(await db.all('SELECT id, deleting FROM sources')).toEqual([{ id: 's1', deleting: 0 }]);
    expect(await db.all('SELECT provider_id, is_hidden FROM categories')).toEqual([
      { provider_id: 'c1', is_hidden: 0 },
    ]);
    expect(await db.all('SELECT key, is_hidden, backup_urls_json, epg_shift_ms FROM live')).toEqual(
      [{ key: 'm:s1:live:1', is_hidden: 0, backup_urls_json: null, epg_shift_ms: null }],
    );
    expect(await db.all('SELECT key, is_hidden, backup_urls_json FROM movies')).toEqual([
      { key: 'm:s1:movie:1', is_hidden: 0, backup_urls_json: null },
    ]);
    expect(await db.all('SELECT key, is_hidden FROM series')).toEqual([
      { key: 'm:s1:series:1', is_hidden: 0 },
    ]);
    expect(await db.all('SELECT item_key, is_hidden FROM placements')).toEqual([
      { item_key: 'm:s1:live:1', is_hidden: 0 },
    ]);
    expect(await regularTableNames(db)).toEqual(
      expect.arrayContaining([
        'categories_next',
        'live_next',
        'movies_next',
        'series_next',
        'episodes_next',
        'placements_next',
      ]),
    );
    expect(await names(db, 'index')).toContain('idx_placements_visible');
  });

  it('upgrades a v5 database to v6, adding backup_urls_json and epg_shift_ms cleanly', async () => {
    const { db } = testDb();
    for (let i = 0; i < 5; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 5');
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1','m3u','Main',100,'{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1','m:s1:live:1','Ch1','ch1',1)",
    );
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1','m:s1:movie:1','Mov1','mov1',1)",
    );
    await db.run(
      "INSERT INTO episodes (source_id, key, series_key, run_id) VALUES ('s1','m:s1:ep:1','m:s1:ser:1',1)",
    );

    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
    expect(await db.all('SELECT key, backup_urls_json, epg_shift_ms FROM live')).toEqual([
      { key: 'm:s1:live:1', backup_urls_json: null, epg_shift_ms: null },
    ]);
    expect(await db.all('SELECT key, backup_urls_json FROM movies')).toEqual([
      { key: 'm:s1:movie:1', backup_urls_json: null },
    ]);
    expect(await db.all('SELECT key, backup_urls_json FROM episodes')).toEqual([
      { key: 'm:s1:ep:1', backup_urls_json: null },
    ]);
    for (const table of [
      'live',
      'live_next',
      'movies',
      'movies_next',
      'episodes',
      'episodes_next',
    ]) {
      const cols = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(
        (c) => c.name,
      );
      expect(cols).toContain('backup_urls_json');
      if (table === 'live' || table === 'live_next') expect(cols).toContain('epg_shift_ms');
    }
  });

  it('is a no-op the second time', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s','m3u','n',0,'{}')",
    );
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('SELECT count(*) AS n FROM sources')).toEqual([{ n: 1 }]);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 6 }]);
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

  it('reaps interrupted runs and purges programmes_next in one transaction after a migration too', async () => {
    const { db } = testDb();
    const statements: string[] = [];
    const recording: SqlDriver = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            run: (sql, params) => {
              statements.push(sql);
              return tx.run(sql, params);
            },
          }),
        ),
    };
    expect((await openCatalog(recording)).ok).toBe(true);
    expect(statements.some((s) => s.includes("error_code = 'interrupted'"))).toBe(true);
    expect(statements.some((s) => s.includes('DELETE FROM programmes_next'))).toBe(true);
  });

  it('refuses a database written by a newer version', async () => {
    const { db } = testDb();
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
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
    const visibleBrowse = await plan(
      db,
      'SELECT item_key FROM placements WHERE source_id = ? AND kind = ? AND category_id = ? AND is_hidden = 0 ORDER BY position',
      ['s', 'live', '1'],
    );
    expect(visibleBrowse).toContain('idx_placements_visible');
    expect(visibleBrowse).not.toMatch(/TEMP B-TREE/);
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
    const crossChannelEpg = await plan(
      db,
      'SELECT guide_id, title FROM programmes WHERE source_id = ? AND start < ? AND stop > ?',
      ['s', 5000, 1000],
    );
    expect(crossChannelEpg).toContain('idx_programmes_source_start_stop');
    expect(crossChannelEpg).not.toMatch(/\bSCAN programmes\b/);
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
    const recentProgress = await plan(
      db,
      'SELECT item_key FROM watch_progress WHERE profile_id = ? AND watched = 0 AND position_ms >= ? ORDER BY updated_at DESC LIMIT ?',
      ['default', 10_000, 20],
    );
    expect(recentProgress).toContain('idx_watch_progress_recent');
    expect(recentProgress).not.toMatch(/TEMP B-TREE/);
    const progressBySource = await plan(
      db,
      'SELECT item_key FROM watch_progress WHERE source_id = ?',
      ['s'],
    );
    expect(progressBySource).toContain('idx_watch_progress_source');
    const recentFavorites = await plan(
      db,
      'SELECT item_key FROM favorites WHERE profile_id = ? ORDER BY added_at DESC LIMIT ?',
      ['default', 20],
    );
    expect(recentFavorites).toContain('idx_favorites_recent');
    expect(recentFavorites).not.toMatch(/TEMP B-TREE/);
    const favoritesBySource = await plan(db, 'SELECT item_key FROM favorites WHERE source_id = ?', [
      's',
    ]);
    expect(favoritesBySource).toContain('idx_favorites_source');
  });

  it('keeps EXPECTED_TABLE_COLUMNS and EXPECTED_FTS_TABLES aligned with MIGRATIONS', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const tables = await regularTableNames(db);
    expect(Object.keys(EXPECTED_TABLE_COLUMNS).sort()).toEqual(tables);
    for (const [table, expected] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
      const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
      expect(cols.map((c) => c.name)).toEqual(expected.map((c) => c.name));
    }
    expect(EXPECTED_FTS_TABLES).toEqual(['live_fts', 'movies_fts', 'series_fts']);
    for (const fts of EXPECTED_FTS_TABLES) {
      expect(Object.hasOwn(EXPECTED_TABLE_COLUMNS, fts)).toBe(false);
    }
  });

  it('heals missing columns on a drifted database when user_version matches SCHEMA_VERSION', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    // Simulate drifted schema: drop columns from sources, live, movies, episodes & live_next while user_version stays at SCHEMA_VERSION.
    await db.exec('ALTER TABLE sources DROP COLUMN deleting');
    await db.exec('ALTER TABLE live DROP COLUMN epg_shift_ms');
    await db.exec('ALTER TABLE movies DROP COLUMN added');
    await db.exec('ALTER TABLE movies DROP COLUMN headers_json');
    await db.exec('DROP INDEX idx_movies_visible_key');
    await db.exec('ALTER TABLE movies DROP COLUMN is_hidden');
    await db.exec('ALTER TABLE movies DROP COLUMN backup_urls_json');
    await db.exec('ALTER TABLE episodes DROP COLUMN duration_sec');
    await db.exec('ALTER TABLE live_next DROP COLUMN legacy_key');
    await db.exec('ALTER TABLE live_next DROP COLUMN backup_urls_json');
    await db.run(
      "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'k1', 'Film', 'film', 1)",
    );

    const txAlters: string[] = [];
    let repairTxCount = 0;
    const spy: SqlDriver = {
      ...db,
      transaction: async (fn) => {
        const before = txAlters.length;
        const result = await db.transaction((tx) =>
          fn({
            ...tx,
            exec: async (sql) => {
              txAlters.push(sql);
              return tx.exec(sql);
            },
          }),
        );
        if (txAlters.length > before) repairTxCount += 1;
        return result;
      },
    };

    expect((await openCatalog(spy)).ok).toBe(true);
    expect(repairTxCount).toBe(1);
    expect(txAlters).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ALTER TABLE sources ADD COLUMN deleting /),
        expect.stringMatching(/^ALTER TABLE live ADD COLUMN epg_shift_ms /),
        expect.stringMatching(/^ALTER TABLE movies ADD COLUMN added /),
        expect.stringMatching(/^ALTER TABLE movies ADD COLUMN headers_json /),
        expect.stringMatching(/^ALTER TABLE movies ADD COLUMN is_hidden /),
        expect.stringMatching(/^ALTER TABLE movies ADD COLUMN backup_urls_json /),
        expect.stringMatching(/^ALTER TABLE episodes ADD COLUMN duration_sec /),
        expect.stringMatching(/^ALTER TABLE live_next ADD COLUMN legacy_key /),
        expect.stringMatching(/^ALTER TABLE live_next ADD COLUMN backup_urls_json /),
      ]),
    );
    expect(txAlters).toHaveLength(9);

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

  it('returns storage/schema-corrupt when an FTS5 virtual table is missing at SCHEMA_VERSION', async () => {
    for (const fts of ['live_fts', 'movies_fts', 'series_fts'] as const) {
      const { db } = testDb();
      expect((await openCatalog(db)).ok).toBe(true);
      await db.exec(`DROP TABLE ${fts}`);

      const result = await openCatalog(db);
      expect(result).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'schema-corrupt' },
      });
    }
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
    // Only the startup reapOrphanedRuns transaction runs on a healthy database; zero ALTER TABLE statements.
    expect(txCalls).toBe(1);
    expect(execCalls.filter((sql) => sql.toUpperCase().includes('ALTER TABLE'))).toEqual([]);
  });
});
