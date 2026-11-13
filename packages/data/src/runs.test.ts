import type { Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import { finishRun, removeStale, startRun } from './runs';
import { testDb } from './test-db';

async function id(r: Promise<Result<number>>): Promise<number> {
  const v = await r;
  if (!v.ok) throw new Error(v.error.code);
  return v.value;
}

async function fresh() {
  const t = testDb();
  await openCatalog(t.db);
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

  it('marks leftover running runs failed/interrupted when the catalog is opened', async () => {
    const { db } = await fresh();
    const a = await id(startRun(db, 's1', 'catalog', 1));
    const b = await id(startRun(db, 's1', 'guide', 1));
    await finishRun(db, b, { status: 'ok' }, 2);
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
    await id(startRun(db, 's1', 'catalog', 60));
  });

  it('refuses tables that are not run-scoped', async () => {
    const { db } = await fresh();
    await expect(removeStale(db, 's1', 1, ['sources'])).rejects.toThrow();
  });
});
