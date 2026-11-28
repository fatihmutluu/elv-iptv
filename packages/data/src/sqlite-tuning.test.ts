import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { extinf, M3U_TOKEN, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { openCatalog } from './migrate';
import { OPEN_PRAGMAS } from './schema';
import { countingScheduler, memorySecrets, tempFileDb, testDb } from './test-db';

describe('SQLite pragmas & bounded PRAGMA optimize (DB-1)', () => {
  it('applies cache_size = -64000 and analysis_limit = 400 in OPEN_PRAGMAS', async () => {
    expect(OPEN_PRAGMAS).toContain('PRAGMA cache_size = -64000');
    expect(OPEN_PRAGMAS).toContain('PRAGMA analysis_limit = 400');

    const t = tempFileDb();
    try {
      expect((await openCatalog(t.db)).ok).toBe(true);
      expect(await t.db.all('PRAGMA cache_size')).toEqual([{ cache_size: -64_000 }]);
      expect(await t.db.all('PRAGMA analysis_limit')).toEqual([{ analysis_limit: 400 }]);
    } finally {
      t.close();
    }
  });

  it('populates sqlite_stat1 via bounded PRAGMA optimize after import without failing under concurrent read queries', async () => {
    const body = `#EXTM3U\n${Array.from({ length: 120 }, (_, i) =>
      extinf(
        `Channel ${i}`,
        `http://cdn.example:8080/${M3U_TOKEN}/live/${i}.ts`,
        'group-title="News"',
      ),
    ).join('')}`;
    const env = await setupM3u(body);

    // Run catalog import; performRun invokes PRAGMA wal_checkpoint(TRUNCATE) and PRAGMA optimize
    const res = await importCatalog(env.sourceId, env.deps);
    expect(res.ok).toBe(true);

    // Verify sqlite_stat1 exists and contains planner histograms for imported tables
    const stats = await env.db.all<{ tbl: string; idx: string; stat: string }>(
      'SELECT tbl, idx, stat FROM sqlite_stat1',
    );
    expect(stats.length).toBeGreaterThan(0);

    // Simulate a second file DB connection holding an active read transaction while PRAGMA optimize runs
    const fileDb = tempFileDb();
    try {
      expect((await openCatalog(fileDb.db)).ok).toBe(true);
      let optimizeFailed = false;
      const execSpy: SqlDriver = {
        ...fileDb.db,
        exec: async (sql) => {
          if (sql.toUpperCase().includes('PRAGMA OPTIMIZE')) {
            // Even if SQLite reports SQLITE_BUSY under an external reader/lock, import must still succeed
            optimizeFailed = true;
            throw new Error('SQLITE_BUSY');
          }
          return fileDb.db.exec(sql);
        },
      };
      const service = createCatalogService({
        db: execSpy,
        secrets: memorySecrets(),
        scheduler: countingScheduler(),
        http: env.deps.http,
        clock: () => 1_000,
        newId: () => 's1',
      });
      const added = await service.addSource({
        kind: 'm3u',
        name: 'Busy Test',
        playlistUrl: 'http://panel.example:8080/list.m3u',
      });
      expect(added.ok).toBe(true);
      const imported = await service.importSource('s1');
      expect(imported.ok).toBe(true);
      expect(optimizeFailed).toBe(true);
      await service.close();
    } finally {
      fileDb.close();
    }
  });

  it('runs best-effort PRAGMA optimize inside CatalogService.close() before db.close()', async () => {
    const t = testDb();
    await openCatalog(t.db);
    const events: string[] = [];
    const spyDb: SqlDriver = {
      ...t.db,
      exec: async (sql) => {
        if (sql.toUpperCase().includes('PRAGMA OPTIMIZE')) events.push('optimize');
        return t.db.exec(sql);
      },
      close: async () => {
        events.push('close');
        await t.db.close?.();
      },
    };
    const service = createCatalogService({
      db: spyDb,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        get: async () => {
          throw new Error('unused');
        },
      },
      clock: () => 1_000,
    });
    await service.close();
    expect(events).toEqual(['optimize', 'close']);

    // Failure during PRAGMA optimize on close() must never prevent db.close()
    const t2 = testDb();
    await openCatalog(t2.db);
    let closedAfterErr = false;
    const failingOptimizeDb: SqlDriver = {
      ...t2.db,
      exec: async (sql) => {
        if (sql.toUpperCase().includes('PRAGMA OPTIMIZE')) {
          throw new Error('SQLITE_BUSY');
        }
        return t2.db.exec(sql);
      },
      close: async () => {
        closedAfterErr = true;
        await t2.db.close?.();
      },
    };
    const service2 = createCatalogService({
      db: failingOptimizeDb,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        get: async () => {
          throw new Error('unused');
        },
      },
      clock: () => 1_000,
    });
    await expect(service2.close()).resolves.toBeUndefined();
    expect(closedAfterErr).toBe(true);
  });
});
