import { describe, expect, it } from 'vitest';
import { countingScheduler, memorySecrets, testDb } from './test-db';

async function setup() {
  const t = testDb();
  await t.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)');
  return t;
}

describe('sync SQL driver', () => {
  it('runs and queries with parameters', async () => {
    const { db } = await setup();
    const r = await db.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    expect(r.changes).toBe(1);
    expect(await db.all('SELECT id, v FROM t WHERE id = ?', [1])).toEqual([{ id: 1, v: 'a' }]);
    expect(await db.all('SELECT id FROM t')).toEqual([{ id: 1 }]);
    expect((await db.run('DELETE FROM t')).changes).toBe(1);
  });

  it('round-trips Uint8Array', async () => {
    const { db } = await setup();
    await db.run('INSERT INTO t (id, b) VALUES (1, ?)', [new Uint8Array([1, 2, 255])]);
    const rows = await db.all<{ b: Uint8Array }>('SELECT b FROM t');
    expect([...(rows[0]?.b ?? [])]).toEqual([1, 2, 255]);
  });

  it('batch inserts 10,000 rows in one call', async () => {
    const { db } = await setup();
    const rows = Array.from({ length: 10_000 }, (_, i) => [i, `v${i}`] as const);
    await db.batch('INSERT INTO t (id, v) VALUES (?, ?)', rows);
    expect(await db.all('SELECT count(*) AS n FROM t')).toEqual([{ n: 10_000 }]);
  });

  it('rolls the whole batch back when a row fails', async () => {
    const { db } = await setup();
    const rows = Array.from({ length: 100 }, (_, i) => [i === 50 ? 1 : i, 'x'] as const);
    await expect(db.batch('INSERT INTO t (id, v) VALUES (?, ?)', rows)).rejects.toThrow();
    expect(await db.all('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
    await db.batch('INSERT INTO t (id, v) VALUES (?, ?)', [[1, 'ok']]);
  });

  it('batch inside a transaction joins it', async () => {
    const { db } = await setup();
    await expect(
      db.transaction(async (tx) => {
        await tx.batch('INSERT INTO t (id, v) VALUES (?, ?)', [[1, 'a']]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.all('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });

  it('commits a transaction when fn resolves', async () => {
    const { db } = await setup();
    const out = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (id, v) VALUES (1, ?)', ['a']);
      await tx.exec("INSERT INTO t (id, v) VALUES (2, 'b')");
      return (await tx.all('SELECT id FROM t')).length;
    });
    expect(out).toBe(2);
    expect(await db.all('SELECT count(*) AS n FROM t')).toEqual([{ n: 2 }]);
  });

  it('rolls back on throw and leaves no open transaction', async () => {
    const { db, raw } = await setup();
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t (id, v) VALUES (1, ?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.all('SELECT id FROM t')).toEqual([]);
    expect(raw.inTransaction).toBe(false);
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (id, v) VALUES (1, ?)', ['b']);
    });
    expect(await db.all('SELECT v FROM t')).toEqual([{ v: 'b' }]);
  });

  it('rejects nested transactions clearly', async () => {
    const { db } = await setup();
    await expect(
      db.transaction(async (tx) => {
        await tx.transaction(async () => undefined);
      }),
    ).rejects.toThrow(/nested/i);
    await db.run('INSERT INTO t (id) VALUES (1)');
  });

  it('queues outer statements until an open transaction finishes', async () => {
    const { db } = await setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tx = db.transaction(async (inner) => {
      await inner.run('INSERT INTO t (id, v) VALUES (1, ?)', ['in-tx']);
      await gate;
      order.push('tx-end');
    });
    const outside = db.all<{ v: string }>('SELECT v FROM t').then((rows) => {
      order.push('outside');
      return rows;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    release();
    await tx;
    expect(await outside).toEqual([{ v: 'in-tx' }]);
    expect(order).toEqual(['tx-end', 'outside']);
  });

  it('keeps the queue alive after a failing statement', async () => {
    const { db } = await setup();
    await expect(db.run('INSERT INTO missing VALUES (1)')).rejects.toThrow();
    expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

describe('test helpers', () => {
  it('memorySecrets stores, dumps and deletes', async () => {
    const s = memorySecrets();
    await s.set('a', '1');
    expect(await s.get('a')).toBe('1');
    expect(s.dump()).toEqual({ a: '1' });
    await s.delete('a');
    expect(await s.get('a')).toBeUndefined();
  });

  it('countingScheduler counts yields', async () => {
    const s = countingScheduler();
    await s.yieldNow();
    await s.yieldNow();
    expect(s.count).toBe(2);
  });
});
