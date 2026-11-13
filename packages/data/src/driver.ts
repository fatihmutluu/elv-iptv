import type { SqlDriver, SqlRunResult, SqlValue } from '@elv/domain';

/** A prepared statement of a synchronous, better-sqlite3-shaped database. */
export interface SyncStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
}

/** The subset of a synchronous database (better-sqlite3) the driver needs. */
export interface SyncDatabase {
  prepare(sql: string): SyncStatement;
  exec(sql: string): void;
}

const NESTED =
  'Nested transactions are not supported; run the work inside the open transaction instead.';

function direct(db: SyncDatabase, nested: () => never): SqlDriver {
  const run = (sql: string, params: readonly SqlValue[] = []): SqlRunResult => ({
    changes: db.prepare(sql).run(...params).changes,
  });
  return {
    exec: async (sql) => db.exec(sql),
    run: async (sql, params) => run(sql, params),
    all: async <T>(sql: string, params: readonly SqlValue[] = []) =>
      db.prepare(sql).all(...params) as T[],
    batch: async (sql, rows) => {
      const stmt = db.prepare(sql);
      for (const row of rows) stmt.run(...row);
    },
    transaction: async () => nested(),
  };
}

/**
 * Adapts a synchronous database to {@link SqlDriver}. Every call goes through one promise queue, so a
 * `transaction` never interleaves with other statements; the `tx` driver passed to its callback bypasses
 * the queue and rejects nested transactions.
 */
export function createSyncSqlDriver(db: SyncDatabase): SqlDriver {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };
  const rejectNested = (): never => {
    throw new Error(NESTED);
  };
  const plain = direct(db, rejectNested);

  const inTransaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = await fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    exec: (sql) => enqueue(() => plain.exec(sql)),
    run: (sql, params) => enqueue(() => plain.run(sql, params)),
    all: <T>(sql: string, params?: readonly SqlValue[]) => enqueue(() => plain.all<T>(sql, params)),
    batch: (sql, rows) => enqueue(() => inTransaction(() => plain.batch(sql, rows))),
    transaction: (fn) => enqueue(() => inTransaction(() => fn(plain))),
  };
}
