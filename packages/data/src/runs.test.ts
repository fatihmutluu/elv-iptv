import type { Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { sampleCatalog, setup as setupPanel } from './import-test-helpers';
import { DEFAULT_BATCH_SIZE } from './import-types';
import { openCatalog } from './migrate';
import { finishRun, latestImportHealth, reapOrphanedRuns, removeStale, startRun } from './runs';
import { testDb } from './test-db';

async function id(r: Promise<Result<number>>): Promise<number> {
  const v = await r;
  if (!v.ok) throw new Error(v.error.code);
  return v.value;
}

async function fresh() {
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

describe('runs', () => {
  it('starts a running row and finishes it with counts', async () => {
    const { db } = await fresh();
    const a = await id(startRun(db, 's1', 'catalog', 10));
    const b = await id(startRun(db, 's1', 'guide', 11));
    expect(b).toBe(a + 1);
    await finishRun(db, a, { status: 'ok', counts: { live: 3 } }, 20);
    const rows = await db.all<Record<string, unknown>>('SELECT * FROM import_runs ORDER BY id');
    expect(rows[0]).toMatchObject({
      status: 'ok',
      started_at: 10,
      finished_at: 20,
      counts_json: '{"live":3}',
      error_category: null,
    });
    expect(rows[1]).toMatchObject({ status: 'running', kind: 'guide', finished_at: null });
  });

  it('stores only category and code of an error', async () => {
    const { db } = await fresh();
    const runId = await id(startRun(db, 's1', 'catalog', 1));
    await finishRun(
      db,
      runId,
      { status: 'failed', error: { category: 'network', code: 'http-500', detail: 'secret-ish' } },
      2,
    );
    const row = (await db.all<Record<string, unknown>>('SELECT * FROM import_runs'))[0];
    expect(row).toMatchObject({
      status: 'failed',
      error_category: 'network',
      error_code: 'http-500',
    });
    expect(JSON.stringify(row)).not.toContain('secret-ish');
  });

  it('removes only rows of other runs of the same source', async () => {
    const { db } = await fresh();
    const sql =
      'INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?,?,?,?,?,?,?)';
    await db.batch(sql, [
      ['s1', 'live', '1', 'a', 'a', 0, 1],
      ['s1', 'live', '2', 'b', 'b', 1, 2],
      ['s2', 'live', '1', 'a', 'a', 0, 1],
    ]);
    const removed = await removeStale(db, 's1', 2, ['categories', 'live']);
    expect(removed).toEqual({ categories: 1, live: 0 });
    const left = await db.all<{ source_id: string; provider_id: string }>(
      'SELECT source_id, provider_id FROM categories ORDER BY source_id',
    );
    expect(left).toEqual([
      { source_id: 's1', provider_id: '2' },
      { source_id: 's2', provider_id: '1' },
    ]);
  });

  it('leaves rows of a higher run id alone', async () => {
    const { db } = await fresh();
    const sql =
      'INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?,?,?,?,?,?,?)';
    await db.batch(sql, [
      ['s1', 'live', '1', 'a', 'a', 0, 1],
      ['s1', 'live', '2', 'b', 'b', 1, 3],
    ]);
    expect(await removeStale(db, 's1', 2, ['categories'])).toEqual({ categories: 1 });
    const left = await db.all<{ provider_id: string }>('SELECT provider_id FROM categories');
    expect(left).toEqual([{ provider_id: '2' }]);
  });

  it('refuses a second running run of the same source and kind', async () => {
    const { db } = await fresh();
    const a = await id(startRun(db, 's1', 'catalog', 1));
    const busy = await startRun(db, 's1', 'catalog', 2);
    expect(busy).toEqual({ ok: false, error: { category: 'storage', code: 'import-in-progress' } });
    await id(startRun(db, 's1', 'guide', 2));
    await id(startRun(db, 's2', 'catalog', 2));
    await finishRun(db, a, { status: 'ok' }, 3);
    await id(startRun(db, 's1', 'catalog', 4));
    expect(await db.all('SELECT id FROM import_runs')).toHaveLength(4);
  });

  it('marks leftover running runs failed/interrupted and purges programmes_next when the catalog is opened', async () => {
    const { db } = await fresh();
    const a = await id(startRun(db, 's1', 'catalog', 1));
    const b = await id(startRun(db, 's1', 'guide', 1));
    await finishRun(db, b, { status: 'ok' }, 2);
    await db.run(
      "INSERT INTO programmes_next (source_id, guide_id, start, stop, title, run_id) VALUES ('s1', 'g1', 10, 20, 'Stale', 1)",
    );
    expect((await openCatalog(db, () => 50)).ok).toBe(true);
    const rows = await db.all<Record<string, unknown>>('SELECT * FROM import_runs ORDER BY id');
    expect(rows[0]).toMatchObject({
      id: a,
      status: 'failed',
      error_category: 'storage',
      error_code: 'interrupted',
      finished_at: 50,
    });
    expect(rows[1]).toMatchObject({ status: 'ok', finished_at: 2 });
    expect(await db.all('SELECT * FROM programmes_next')).toEqual([]);
    await id(startRun(db, 's1', 'catalog', 60));
  });

  it('reapOrphanedRuns reaps running catalog and guide runs, leaves finished runs alone, and purges programmes_next', async () => {
    const { db } = await fresh();
    const runningCat = await id(startRun(db, 's1', 'catalog', 10));
    const runningGuide = await id(startRun(db, 's1', 'guide', 11));
    const okRun = await id(startRun(db, 's2', 'catalog', 12));
    await finishRun(db, okRun, { status: 'ok', counts: { live: 2 } }, 15);
    const failedRun = await id(startRun(db, 's2', 'catalog', 16));
    await finishRun(
      db,
      failedRun,
      { status: 'failed', error: { category: 'network', code: 'http-503' } },
      18,
    );
    const cancelledRun = await id(startRun(db, 's2', 'guide', 19));
    await finishRun(
      db,
      cancelledRun,
      { status: 'cancelled', error: { category: 'network', code: 'aborted' } },
      20,
    );
    await db.batch(
      'INSERT INTO programmes_next (source_id, guide_id, start, stop, title, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ['s1', 'g1', 100, 200, 'Show A', runningGuide],
        ['s1', 'g2', 200, 300, 'Show B', runningGuide],
      ],
    );

    const reaped = await reapOrphanedRuns(db, 999);
    expect(reaped).toEqual({
      reapedRuns: 2,
      purgedProgrammes: 2,
      purgedStaged: 0,
      completedDeletes: 0,
    });

    const rows = await db.all<Record<string, unknown>>('SELECT * FROM import_runs ORDER BY id');
    expect(rows.find((r) => r.id === runningCat)).toMatchObject({
      status: 'failed',
      error_category: 'storage',
      error_code: 'interrupted',
      finished_at: 999,
    });
    expect(rows.find((r) => r.id === runningGuide)).toMatchObject({
      status: 'failed',
      error_category: 'storage',
      error_code: 'interrupted',
      finished_at: 999,
    });
    expect(rows.find((r) => r.id === okRun)).toMatchObject({
      status: 'ok',
      error_category: null,
      error_code: null,
      finished_at: 15,
    });
    expect(rows.find((r) => r.id === failedRun)).toMatchObject({
      status: 'failed',
      error_category: 'network',
      error_code: 'http-503',
      finished_at: 18,
    });
    expect(rows.find((r) => r.id === cancelledRun)).toMatchObject({
      status: 'cancelled',
      error_category: 'network',
      error_code: 'aborted',
      finished_at: 20,
    });
    expect(await db.all('SELECT * FROM programmes_next')).toEqual([]);

    // Reaping again is a clean no-op, and new runs start immediately.
    expect(await reapOrphanedRuns(db, 1000)).toEqual({
      reapedRuns: 0,
      purgedProgrammes: 0,
      purgedStaged: 0,
      completedDeletes: 0,
    });
    await id(startRun(db, 's1', 'catalog', 1001));
    await id(startRun(db, 's1', 'guide', 1002));
  });

  it('reapOrphanedRuns purges all 6 catalog *_next staging tables and resumes deleting = 1 sources (#418, #138)', async () => {
    const { db } = await fresh();
    await db.run(
      "INSERT INTO categories_next (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'c1', 'Cat', 'cat', 0, 1)",
    );
    await db.run(
      "INSERT INTO live_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'k1', 'Ch', 'ch', 1)",
    );
    await db.run(
      "INSERT INTO movies_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'k2', 'M', 'm', 1)",
    );
    await db.run(
      "INSERT INTO series_next (source_id, key, name, name_fold, run_id) VALUES ('s1', 'k3', 'S', 's', 1)",
    );
    await db.run(
      "INSERT INTO episodes_next (source_id, key, series_key, title, run_id) VALUES ('s1', 'k4', 'k3', 'E', 1)",
    );
    await db.run(
      "INSERT INTO placements_next (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', 'k1', 'c1', 0, 1)",
    );

    // Mark s2 as mid-delete crash with leftover catalog & user-state rows.
    await db.run("UPDATE sources SET deleting = 1 WHERE id = 's2'");
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s2', 'k2', 'Ch2', 'ch2', 1)",
    );
    await db.run(
      "INSERT INTO favorites (profile_id, source_id, item_key, kind, title, added_at) VALUES ('default', 's2', 'k2', 'live', 'Ch2', 1)",
    );
    expect(await startRun(db, 's2', 'catalog', 10)).toEqual({
      ok: false,
      error: { category: 'storage', code: 'source-not-found' },
    });

    const res = await reapOrphanedRuns(db, 2000);
    expect(res).toEqual({
      reapedRuns: 0,
      purgedProgrammes: 0,
      purgedStaged: 6,
      completedDeletes: 1,
    });
    for (const t of [
      'categories_next',
      'live_next',
      'movies_next',
      'series_next',
      'episodes_next',
      'placements_next',
    ]) {
      expect(await db.all(`SELECT * FROM ${t}`)).toEqual([]);
    }
    expect(await db.all('SELECT id FROM sources ORDER BY id')).toEqual([{ id: 's1' }]);
    expect(await db.all("SELECT * FROM live WHERE source_id = 's2'")).toEqual([]);
    expect(await db.all("SELECT * FROM favorites WHERE source_id = 's2'")).toEqual([]);
  });

  it('uses a modest 200-row DEFAULT_BATCH_SIZE for WAL write transactions', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(200);
  });

  it('refuses to start a run for a source that is gone', async () => {
    const { db } = await fresh();
    expect(await startRun(db, 'gone', 'catalog', 1)).toEqual({
      ok: false,
      error: { category: 'storage', code: 'source-not-found' },
    });
    expect(await db.all('SELECT id FROM import_runs')).toEqual([]);
  });

  it('refuses tables that are not run-scoped', async () => {
    const { db } = await fresh();
    await expect(removeStale(db, 's1', 1, ['sources'])).rejects.toThrow();
  });

  it('reports latestImportHealth only when the latest catalog run failed while cached items remain (#141)', async () => {
    const { db } = await fresh();

    // No runs yet -> empty
    expect(await latestImportHealth(db)).toEqual([]);

    // First run failed with no cached items -> not reported as cached-catalog failure
    const r1 = await id(startRun(db, 's1', 'catalog', 100));
    await finishRun(
      db,
      r1,
      { status: 'failed', error: { category: 'network', code: 'http-503' } },
      110,
    );
    expect(await latestImportHealth(db)).toEqual([]);

    // Second run succeeds and writes a cached live channel
    const r2 = await id(startRun(db, 's1', 'catalog', 200));
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 's1:live:1', 'News 1', 'news 1', ?)",
      [r2],
    );
    await finishRun(db, r2, { status: 'ok', counts: { live: 1 } }, 210);
    expect(await latestImportHealth(db)).toEqual([]);

    // Third run fails -> cached live row remains untouched, latestImportHealth reports s1
    const r3 = await id(startRun(db, 's1', 'catalog', 300));
    await finishRun(
      db,
      r3,
      { status: 'failed', error: { category: 'network', code: 'timeout' } },
      350,
    );
    expect(await latestImportHealth(db)).toEqual([
      {
        sourceId: 's1',
        status: 'failed',
        errorCategory: 'network',
        errorCode: 'timeout',
        finishedAt: 350,
        hasCachedItems: true,
      },
    ]);
    expect(await latestImportHealth(db, 's1')).toHaveLength(1);
    expect(await latestImportHealth(db, 's2')).toEqual([]);

    // Fourth run recovers -> healthy again
    const r4 = await id(startRun(db, 's1', 'catalog', 400));
    await finishRun(db, r4, { status: 'ok', counts: { live: 1 } }, 410);
    expect(await latestImportHealth(db)).toEqual([]);
  });

  it('CatalogService persists maxConnections/activeConnections and preserves cached rows on failed refresh (#87, #141)', async () => {
    const data = sampleCatalog();
    data.user = {
      auth: 1,
      status: 'Active',
      is_trial: '0',
      max_connections: '3',
      active_cons: '1',
      allowed_output_formats: ['ts'],
    };
    const panel = await setupPanel(data);
    let failRefresh = false;
    const baseHttp = panel.panel.http;
    const service = createCatalogService({
      db: panel.db,
      secrets: panel.secrets,
      scheduler: panel.scheduler,
      http: {
        get: async (url, opts) =>
          failRefresh
            ? { ok: false, error: { category: 'network', code: 'http-503' } }
            : baseHttp.get(url, opts),
      },
      clock: () => 5_000,
    });
    const added = await service.addSource({
      kind: 'xtream',
      name: 'Conn Panel',
      server: 'http://panel.example:8080',
      username: 'u',
      password: 'p',
    });
    if (!added.ok) throw new Error('add failed');
    const sid = added.value.id;
    expect((await service.importSource(sid)).ok).toBe(true);
    expect((await service.listSources()).find((s) => s.id === sid)?.accountMeta).toEqual({
      isTrial: false,
      maxConnections: 3,
      activeConnections: 1,
    });
    expect(await service.latestImportHealth?.(sid)).toEqual([]);
    const catsBefore = await service.categories(sid, 'live');
    expect(catsBefore.length).toBeGreaterThan(0);

    failRefresh = true;
    expect((await service.importSource(sid)).ok).toBe(false);
    expect(await service.categories(sid, 'live')).toEqual(catsBefore);
    expect(await service.latestImportHealth?.(sid)).toEqual([
      {
        sourceId: sid,
        status: 'failed',
        errorCategory: 'network',
        errorCode: 'http-503',
        finishedAt: 5_000,
        hasCachedItems: true,
      },
    ]);
    await service.close();
  });
});
