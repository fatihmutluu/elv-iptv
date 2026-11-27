import { MIGRATIONS } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import { createFakeOpSqlite } from './op-sqlite-fake';

const fake = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@op-engineering/op-sqlite', () => ({
  IOS_LIBRARY_PATH: '/app/Library',
  open: (o: { name: string }) => (fake.current as { open(o: unknown): unknown }).open(o),
}));

import {
  createOpSqliteDriver,
  databaseLocation,
  packInsertBatch,
  splitSqlStatements,
} from './sql-driver';

async function setup() {
  const f = createFakeOpSqlite();
  fake.current = f;
  const db = await createOpSqliteDriver('catalog.db');
  const [writer, reader] = f.conns;
  if (!writer || !reader) throw new Error('expected two connections');
  const openWriterLog = [...writer.log];
  const openReaderLog = [...reader.log];
  writer.log.length = 0;
  reader.log.length = 0;
  return { f, db, writer, reader, openWriterLog, openReaderLog };
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

  it('keeps CREATE TRIGGER BEGIN ... END bodies intact including Migration v3', () => {
    const stmts = splitSqlStatements(MIGRATIONS[2] ?? '');
    expect(stmts).toHaveLength(15);
    expect(stmts.filter((s) => s.startsWith('CREATE VIRTUAL TABLE'))).toHaveLength(3);
    expect(stmts.filter((s) => s.startsWith('CREATE TRIGGER'))).toHaveLength(9);
    expect(stmts.filter((s) => s.includes("VALUES ('rebuild')"))).toHaveLength(3);
    for (const trigger of stmts.filter((s) => s.startsWith('CREATE TRIGGER'))) {
      expect(trigger.endsWith('END')).toBe(true);
    }
  });
});

describe('databaseLocation', () => {
  it('puts databases in Library/Caches on Apple platforms and in the default directory elsewhere', () => {
    expect(databaseLocation('ios')).toBe('/app/Library/Caches');
    expect(databaseLocation('android')).toBeUndefined();
  });
});

describe('createOpSqliteDriver', () => {
  it('opens a writer and a reader on the same file and applies connection-scoped pragmas to both', async () => {
    const { f, openWriterLog, openReaderLog } = await setup();
    expect(f.opened).toEqual([{ name: 'catalog.db' }, { name: 'catalog.db' }]);
    const expectedPragmas = [
      'execute:PRAGMA busy_timeout = 5000',
      'execute:PRAGMA temp_store = MEMORY',
      'execute:PRAGMA foreign_keys = ON',
    ];
    expect(openWriterLog).toEqual(expectedPragmas);
    expect(openReaderLog).toEqual(expectedPragmas);
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

  it('batch outside a transaction packs uniform INSERTs into multi-row executeBatch commands and falls back for UPDATE', async () => {
    const { db, writer } = await setup();
    await db.batch('INSERT INTO t VALUES (?)', [[1], [2], [3]]);
    expect(writer.log).toEqual(['executeBatch:1:INSERT INTO t VALUES (?), (?), (?)']);
    writer.log.length = 0;
    await db.batch('UPDATE t SET a = ? WHERE id = ?', [
      [1, 10],
      [2, 20],
    ]);
    expect(writer.log).toEqual(['executeBatch:2:UPDATE t SET a = ? WHERE id = ?']);
  });

  it('packInsertBatch preserves ON CONFLICT suffixes and chunks under SQLite bind-parameter limits (#25)', () => {
    const sql =
      'INSERT INTO programmes_next (a, b, c) VALUES (?, ?, ?) ON CONFLICT(a) DO UPDATE SET b = excluded.b';
    const rows = Array.from({ length: 105 }, (_, i) => [i, `t${i}`, i + 1]);
    const packed = packInsertBatch(sql, rows);
    expect(packed).toHaveLength(2);
    expect(packed?.[0]?.[1]).toHaveLength(300);
    expect(packed?.[0]?.[0]).toContain('ON CONFLICT(a) DO UPDATE SET b = excluded.b');
    expect(packed?.[1]?.[1]).toHaveLength(15);
    expect(
      packInsertBatch('UPDATE t SET a = ? WHERE id = ?', [
        [1, 2],
        [3, 4],
      ]),
    ).toBeUndefined();
    expect(packInsertBatch('INSERT INTO t VALUES (?)', [[1]])).toBeUndefined();
  });

  it('an empty batch does nothing', async () => {
    const { db, writer } = await setup();
    await db.batch('INSERT INTO t VALUES (?)', []);
    expect(writer.log).toEqual([]);
  });

  it('batch inside a transaction packs multi-row INSERTs on async execute and uses prepared statements for UPDATE (#478)', async () => {
    const { db, writer } = await setup();
    await db.transaction(async (tx) => {
      await tx.batch('INSERT INTO t VALUES (?)', [[1], [2]]);
      await tx.batch('UPDATE t SET a = ? WHERE id = ?', [
        [9, 1],
        [8, 2],
      ]);
    });
    expect(writer.log).toEqual([
      'execute:BEGIN IMMEDIATE;',
      'execute:INSERT INTO t VALUES (?), (?)|[1,2]',
      'stmt:UPDATE t SET a = ? WHERE id = ?|[9,1]',
      'stmt:UPDATE t SET a = ? WHERE id = ?|[8,2]',
      'execute:COMMIT;',
    ]);
  });

  it('transaction rolls back asynchronously when the callback throws (#478)', async () => {
    const { db, writer } = await setup();
    await expect(
      db.transaction(async () => {
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(writer.log).toEqual(['execute:BEGIN IMMEDIATE;', 'execute:ROLLBACK;']);
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
      'execute:BEGIN IMMEDIATE;',
      'execute:INSERT INTO t VALUES (1)',
      'execute:INSERT INTO t VALUES (?), (?)|[2,3]',
      'interrupt',
      'execute:ROLLBACK;',
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

  it('interrupts only the writer when the signal fires, leaving reader queries untouched', async () => {
    const { db, writer, reader } = await setup();
    reader.rowsFor = () => [{ n: 7 }];
    const controller = new AbortController();
    db.setAbortSignal(controller.signal);
    const readGate = reader.hold();
    const pendingRead = db.all('SELECT n FROM t');
    await Promise.resolve();
    controller.abort();
    expect(writer.log).toContain('interrupt');
    expect(reader.log).not.toContain('interrupt');
    readGate.release();
    expect(await pendingRead).toEqual([{ n: 7 }]);
    expect(await db.all('SELECT n FROM t')).toEqual([{ n: 7 }]);
    expect(await db.all('FAIL read').catch((e: unknown) => e)).toMatchObject({
      category: 'storage',
      code: 'sql-failed',
    });
  });

  it('closes both connections after queued work and detaches the abort signal', async () => {
    const { db, writer, reader } = await setup();
    const controller = new AbortController();
    db.setAbortSignal(controller.signal);
    const writeGate = writer.hold();
    const pending = db.run('UPDATE t SET a = 1');
    const closing = db.close?.();
    const closingAgain = db.close?.();
    writeGate.release();
    await Promise.all([pending, closing, closingAgain]);
    controller.abort();
    expect(writer.log).toEqual(['execute:UPDATE t SET a = 1', 'close']);
    expect(reader.log).toEqual(['close']);
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

  it('closes partial handles immediately on non-transient open or pragma failures without retrying (#138)', async () => {
    const f1 = createFakeOpSqlite();
    let opens = 0;
    fake.current = {
      open(o: { name: string; location?: string }) {
        opens += 1;
        if (opens === 2) throw new Error('SQLITE_CANTOPEN: permission denied');
        return f1.open(o);
      },
    };
    const sleeps: number[] = [];
    await expect(
      createOpSqliteDriver('catalog.db', undefined, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow('SQLITE_CANTOPEN');
    expect(opens).toBe(2);
    expect(sleeps).toEqual([]);
    expect(f1.conns[0]?.log).toContain('close');

    // Pragma failure on reader closes both writer and reader without retrying
    const f2 = createFakeOpSqlite();
    let pragmaOpens = 0;
    fake.current = {
      open(o: { name: string; location?: string }) {
        pragmaOpens += 1;
        const conn = f2.open(o);
        if (pragmaOpens === 2) {
          const origExec = conn.execute;
          conn.execute = async (sql, params) => {
            if (sql.includes('foreign_keys')) throw new Error('SQLITE_CORRUPT');
            return origExec(sql, params);
          };
        }
        return conn;
      },
    };
    await expect(
      createOpSqliteDriver('catalog.db', undefined, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow('SQLITE_CORRUPT');
    expect(sleeps).toEqual([]);
    expect(f2.conns[0]?.log).toContain('close');
    expect(f2.conns[1]?.log).toContain('close');
  });

  it('retries up to 3 times with [100, 250]ms backoff on transient SQLITE_BUSY/SQLITE_LOCKED open errors and closes partial handles (#138)', async () => {
    const f = createFakeOpSqlite();
    let attempt = 0;
    fake.current = {
      open(o: { name: string; location?: string }) {
        const conn = f.open(o);
        // Attempt 1 fails on reader pragma with SQLITE_BUSY; Attempt 2 fails on writer open with database is locked; Attempt 3 succeeds.
        if (f.conns.length === 2) {
          attempt = 1;
          conn.execute = async () => {
            throw new Error('SQLITE_BUSY: database is locked');
          };
        } else if (f.conns.length === 3 && attempt === 1) {
          attempt = 2;
          // Simulate open failing on reader after writer opened
        } else if (f.conns.length === 4 && attempt === 2) {
          throw new Error('SQLITE_LOCKED: database table is locked');
        }
        return conn;
      },
    };
    const sleeps: number[] = [];
    const driver = await createOpSqliteDriver('catalog.db', undefined, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([100, 250]);
    // Attempt 1 writer + reader closed; Attempt 2 writer closed (reader threw during open)
    expect(f.conns[0]?.log).toContain('close');
    expect(f.conns[1]?.log).toContain('close');
    expect(f.conns[2]?.log).toContain('close');
    await driver.close();

    // Exhausting all 3 attempts rejects and leaves every handle closed
    const fExhaust = createFakeOpSqlite();
    const exhaustSleeps: number[] = [];
    fake.current = {
      open(o: { name: string; location?: string }) {
        const conn = fExhaust.open(o);
        conn.execute = async () => {
          throw new Error('database is locked');
        };
        return conn;
      },
    };
    await expect(
      createOpSqliteDriver('catalog.db', undefined, {
        sleep: async (ms) => {
          exhaustSleeps.push(ms);
        },
      }),
    ).rejects.toThrow('database is locked');
    expect(exhaustSleeps).toEqual([100, 250]);
    expect(fExhaust.conns).toHaveLength(6);
    for (const c of fExhaust.conns) expect(c.log).toContain('close');
  });

  it('exposes getDbPath for default and custom locations without passing undefined (#478)', async () => {
    const { db } = await setup();
    expect(db.getDbPath()).toBe('/default/databases/catalog.db');

    const f2 = createFakeOpSqlite();
    fake.current = f2;
    const appleDb = await createOpSqliteDriver('catalog.db', '/app/Library/Caches');
    expect(appleDb.getDbPath()).toBe('/app/Library/Caches/catalog.db');
  });

  it('serializes attachAndCopyProgrammes through the writer queue and always detaches on failure (#478)', async () => {
    const { db, writer } = await setup();
    const stagePath = '/default/databases/catalog.db.xmltv-stage-job_1.db';
    const gate = writer.hold();

    const first = db.run('UPDATE a SET x = 1');
    const copy = db.attachAndCopyProgrammes(stagePath);
    const second = db.run('UPDATE b SET x = 1');

    await Promise.resolve();
    expect(writer.log).toEqual(['execute:UPDATE a SET x = 1']);
    gate.release();

    await Promise.all([first, copy, second]);
    expect(writer.log).toEqual([
      'execute:UPDATE a SET x = 1',
      `execute:ATTACH DATABASE ? AS xmltv_stage|${JSON.stringify([stagePath])}`,
      'execute:INSERT OR REPLACE INTO programmes_next (source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold) SELECT source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold FROM xmltv_stage.programmes_next',
      'execute:DETACH DATABASE xmltv_stage',
      'execute:UPDATE b SET x = 1',
    ]);

    // Failure during INSERT still executes DETACH and keeps the writer queue healthy
    writer.log.length = 0;
    const origExecute = writer.execute;
    writer.execute = async (sql, params) => {
      if (sql.startsWith('INSERT OR REPLACE INTO programmes_next')) {
        writer.log.push(`execute:${sql}`);
        throw new Error('disk full');
      }
      return origExecute(sql, params);
    };
    await expect(db.attachAndCopyProgrammes(stagePath)).rejects.toMatchObject({
      category: 'storage',
      code: 'sql-failed',
      detail: 'disk full',
    });
    expect(writer.log).toEqual([
      `execute:ATTACH DATABASE ? AS xmltv_stage|${JSON.stringify([stagePath])}`,
      'execute:INSERT OR REPLACE INTO programmes_next (source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold) SELECT source_id, guide_id, start, stop, title, sub_title, description, categories_json, episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold FROM xmltv_stage.programmes_next',
      'execute:DETACH DATABASE xmltv_stage',
    ]);

    writer.execute = origExecute;
    expect(await db.run('UPDATE c SET x = 1')).toEqual({ changes: 1 });
  });

  it('reports slow SQL operations (> 250ms) with safe uppercase SQL verb tokens only (#509)', async () => {
    let now = 10_000;
    const f = createFakeOpSqlite();
    fake.current = f;
    const slowOps: Array<{ op: string; durationMs: number }> = [];
    const db = await createOpSqliteDriver('catalog.db', undefined, {
      now: () => now,
      slowQueryThresholdMs: 250,
      onSlowQuery: (op, durationMs) => {
        slowOps.push({ op, durationMs });
      },
    });
    const [writer, reader] = f.conns;
    if (!writer || !reader) throw new Error('expected two connections');

    const origRead = reader.execute;
    reader.execute = async (sql, params) => {
      now += 320;
      return origRead(sql, params);
    };
    const origWrite = writer.execute;
    writer.execute = async (sql, params) => {
      now += sql.startsWith('DELETE') ? 410 : 80;
      return origWrite(sql, params);
    };

    await db.all('SELECT * FROM private_channels WHERE name = ?', ['Secret']);
    await db.run('UPDATE private_channels SET name = ?', ['Fast']);
    await db.run('DELETE FROM private_channels WHERE id = ?', [42]);

    expect(slowOps).toEqual([
      { op: 'SELECT', durationMs: 320 },
      { op: 'DELETE', durationMs: 410 },
    ]);
    await db.close();
  });

  it('attachReadOnly binds filePath via ? parameter on BOTH writer and reader, rejects invalid aliases, and detaches writer if reader fails (#511)', async () => {
    const { db, writer, reader } = await setup();
    const enrichmentPath = "/data/user's/elv-enrichment.db";
    await db.attachReadOnly?.(enrichmentPath, 'elv_enrich');
    const expectedSql = `execute:ATTACH DATABASE ? AS "elv_enrich"|${JSON.stringify([enrichmentPath])}`;
    expect(writer.log).toEqual([expectedSql]);
    expect(reader.log).toEqual([expectedSql]);

    await expect(db.attachReadOnly?.('/tmp/a.db', 'BadAlias')).rejects.toThrow(/alias/i);
    await expect(db.attachReadOnly?.('/tmp/a.db', '1bad')).rejects.toThrow(/alias/i);
    await expect(db.attachReadOnly?.('/tmp/a.db', 'a; DROP TABLE x')).rejects.toThrow(/alias/i);
    await expect(db.attachReadOnly?.('', 'elv_enrich')).rejects.toThrow(/filePath/i);
    await expect(db.attachReadOnly?.('/tmp/bad\0.db', 'elv_enrich')).rejects.toThrow(/filePath/i);

    // If reader ATTACH fails, writer is cleanly detached
    writer.log.length = 0;
    reader.log.length = 0;
    const origReaderExec = reader.execute;
    reader.execute = async () => {
      throw new Error('reader attach failed');
    };
    await expect(db.attachReadOnly?.('/tmp/elv.db', 'elv_enrich')).rejects.toMatchObject({
      category: 'storage',
      code: 'sql-failed',
      detail: 'reader attach failed',
    });
    expect(writer.log).toEqual([
      `execute:ATTACH DATABASE ? AS "elv_enrich"|${JSON.stringify(['/tmp/elv.db'])}`,
      'execute:DETACH DATABASE "elv_enrich"',
    ]);
    reader.execute = origReaderExec;
    await db.close();
  });
});
