import { describe, expect, it, vi } from 'vitest';
import { createFakeOpSqlite } from './op-sqlite-fake';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@op-engineering/op-sqlite', () => ({
  IOS_LIBRARY_PATH: '/app/Library',
  open: (o: { name: string }) => (fake.current as { open(o: unknown): unknown }).open(o),
}));

import { createOpSqliteDriver, databaseLocation, splitSqlStatements } from './sql-driver';

async function setup() {
  const f = createFakeOpSqlite();
  fake.current = f;
  const db = await createOpSqliteDriver('catalog.db');
  const [writer, reader] = f.conns;
  if (!writer || !reader) throw new Error('expected two connections');
  return { f, db, writer, reader };
}

describe('splitSqlStatements', () => {
  it('splits outside string literals and comments', () => {
    const script =
      "CREATE TABLE a (x TEXT DEFAULT 'a;b'); -- note; here\n/* c; */ INSERT INTO a VALUES ('it''s;'); SELECT 1";
    expect(splitSqlStatements(script)).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT 'a;b')",
      "INSERT INTO a VALUES ('it''s;')",
      'SELECT 1',
    ]);
  });
});

describe('databaseLocation', () => {
  it('puts databases in Library/Caches on Apple platforms and in the default directory elsewhere', () => {
    expect(databaseLocation('ios')).toBe('/app/Library/Caches');
    expect(databaseLocation('android')).toBeUndefined();
  });
});

describe('createOpSqliteDriver', () => {
  it('opens a writer and a reader on the same file', async () => {
    const { f } = await setup();
    expect(f.opened).toEqual([{ name: 'catalog.db' }, { name: 'catalog.db' }]);
  });

  it('opens both connections in the given location', async () => {
    const f = createFakeOpSqlite();
    fake.current = f;
    await createOpSqliteDriver('catalog.db', '/app/Library/Caches');
    const where = { name: 'catalog.db', location: '/app/Library/Caches' };
    expect(f.opened).toEqual([where, where]);
  });

  it('exec splits statements outside literals', async () => {
    const { db, writer } = await setup();
    await db.exec("CREATE TABLE a (x); INSERT INTO a VALUES ('a;b'); -- tail; comment\n");
    expect(writer.log).toEqual([
      'execute:CREATE TABLE a (x)',
      "execute:INSERT INTO a VALUES ('a;b')",
    ]);
  });

  it('run returns the changes of the write', async () => {
    const { db } = await setup();
    expect(await db.run('UPDATE t SET a = ?', [1])).toEqual({ changes: 1 });
  });

  it('batch outside a transaction uses one executeBatch', async () => {
    const { db, writer } = await setup();
    await db.batch('INSERT INTO t VALUES (?)', [[1], [2], [3]]);
    expect(writer.log).toEqual(['executeBatch:3:INSERT INTO t VALUES (?)']);
  });

  it('an empty batch does nothing', async () => {
    const { db, writer } = await setup();
    await db.batch('INSERT INTO t VALUES (?)', []);
    expect(writer.log).toEqual([]);
  });

  it('batch inside a transaction runs on the transaction connection', async () => {
    const { db, writer } = await setup();
    await db.transaction(async (tx) => {
      await tx.batch('INSERT INTO t VALUES (?)', [[1], [2]]);
    });
    expect(writer.log).toEqual([
      'transaction:begin',
      'stmt:INSERT INTO t VALUES (?)|[1]',
      'stmt:INSERT INTO t VALUES (?)|[2]',
      'transaction:end',
    ]);
  });

  it('transaction rolls back when the callback throws', async () => {
    const { db, writer } = await setup();
    await expect(
      db.transaction(async () => {
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(writer.log).toContain('transaction:rollback');
  });

  it('transaction rejects nesting', async () => {
    const { db } = await setup();
    await expect(db.transaction((tx) => tx.transaction(async () => undefined))).rejects.toThrow(
      /Nested transactions/,
    );
  });

  it('serializes writer calls in order', async () => {
    const { db, writer } = await setup();
    const gate = writer.hold();
    const first = db.run('UPDATE a SET x = 1');
    const second = db.run('UPDATE b SET x = 1');
    await Promise.resolve();
    expect(writer.log).toEqual(['execute:UPDATE a SET x = 1']);
    gate.release();
    await Promise.all([first, second]);
    expect(writer.log).toEqual(['execute:UPDATE a SET x = 1', 'execute:UPDATE b SET x = 1']);
  });

  it('reads are not queued behind a writer batch', async () => {
    const { db, writer, reader } = await setup();
    reader.rowsFor = () => [{ n: 7 }];
    const gate = writer.hold();
    const pending = db.batch('INSERT INTO t VALUES (?)', [[1]]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(await db.all('SELECT n FROM t')).toEqual([{ n: 7 }]);
    expect(settled).toBe(false);
    gate.release();
    await pending;
  });

  it('reads inside a transaction go through the transaction', async () => {
    const { db, writer, reader } = await setup();
    writer.rowsFor = () => [{ n: 1 }];
    const rows = await db.transaction((tx) => tx.all('SELECT n FROM t'));
    expect(rows).toEqual([{ n: 1 }]);
    expect(reader.log).toEqual([]);
  });

  it('abort during a batch rejects with AbortError', async () => {
    const { db, writer } = await setup();
    const controller = new AbortController();
    db.setAbortSignal(controller.signal);
    writer.hold();
    const pending = db.batch('INSERT INTO t VALUES (?)', [[1]]);
    const outcome = pending.catch((e: Error) => e);
    await Promise.resolve();
    controller.abort();
    const error = await outcome;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(writer.log).toContain('interrupt');
  });

  it('abort inside a transaction rejects with AbortError and rolls the transaction back', async () => {
    const { db, writer } = await setup();
    const controller = new AbortController();
    db.setAbortSignal(controller.signal);
    const outcome = db
      .transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
        writer.hold();
        const pending = tx.batch('INSERT INTO t VALUES (?)', [[2], [3]]);
        await Promise.resolve();
        controller.abort();
        await pending;
      })
      .catch((e: Error) => e);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(writer.log).toEqual([
      'transaction:begin',
      'tx.execute:INSERT INTO t VALUES (1)',
      'stmt:INSERT INTO t VALUES (?)|[2]',
      'interrupt',
      'transaction:rollback',
    ]);
  });

  it('setAbortSignal(undefined) detaches: a later abort interrupts nothing and failures stay sql-failed', async () => {
    const { db, writer, reader } = await setup();
    const controller = new AbortController();
    db.setAbortSignal(controller.signal);
    db.setAbortSignal(undefined);
    controller.abort();
    expect(writer.log).not.toContain('interrupt');
    expect(reader.log).not.toContain('interrupt');
    expect(await db.run('FAIL now').catch((e: unknown) => e)).toMatchObject({ code: 'sql-failed' });
  });

  it('binding a new signal detaches the previous one', async () => {
    const { db, writer } = await setup();
    const first = new AbortController();
    db.setAbortSignal(first.signal);
    db.setAbortSignal(new AbortController().signal);
    first.abort();
    expect(writer.log).not.toContain('interrupt');
  });

  it('interrupts an already running statement when the signal fires later', async () => {
    const { db, writer, reader } = await setup();
    const controller = new AbortController();
    db.setAbortSignal(controller.signal);
    controller.abort();
    expect(writer.log).toContain('interrupt');
    expect(reader.log).toContain('interrupt');
  });

  it('other SQL errors reject with storage/sql-failed', async () => {
    const { db } = await setup();
    const error = await db.run('FAIL now').catch((e: unknown) => e);
    expect(error).toMatchObject({
      category: 'storage',
      code: 'sql-failed',
      detail: 'near FAIL: syntax error',
    });
  });

  it('a failed statement does not block the queue', async () => {
    const { db } = await setup();
    await db.run('FAIL').catch(() => undefined);
    expect(await db.run('UPDATE t SET a = 1')).toEqual({ changes: 1 });
  });
});
