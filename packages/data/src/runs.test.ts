import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import { finishRun, removeStale, startRun } from './runs';
import { testDb } from './test-db';

async function fresh() {
  const t = testDb();
  await openCatalog(t.db);
  return t;
}

describe('runs', () => {
  it('starts a running row and finishes it with counts', async () => {
    const { db } = await fresh();
    const a = await startRun(db, 's1', 'catalog', 10);
    const b = await startRun(db, 's1', 'guide', 11);
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
    const id = await startRun(db, 's1', 'catalog', 1);
    await finishRun(
      db,
      id,
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

  it('refuses tables that are not run-scoped', async () => {
    const { db } = await fresh();
    await expect(removeStale(db, 's1', 1, ['sources'])).rejects.toThrow();
  });
});
