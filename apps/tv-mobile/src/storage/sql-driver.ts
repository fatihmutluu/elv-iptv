import type { SqlDriver, SqlRunResult, SqlValue } from '@elv/domain';
import { IOS_LIBRARY_PATH, open } from '@op-engineering/op-sqlite';

/** The result of one op-sqlite statement. */
interface OpResult {
  rows: unknown[];
  rowsAffected: number;
}

/** The op-sqlite transaction object. */
interface OpTx {
  execute(sql: string, params?: SqlValue[]): Promise<OpResult>;
}

/** The subset of an op-sqlite connection this driver uses. */
interface OpConnection {
  execute(sql: string, params?: SqlValue[]): Promise<OpResult>;
  executeBatch(commands: [string, SqlValue[]][]): Promise<unknown>;
  transaction(fn: (tx: OpTx) => Promise<void>): Promise<void>;
  prepareStatement(sql: string): {
    bind(params: SqlValue[]): Promise<void>;
    execute(): Promise<OpResult>;
  };
  interrupt(): void;
  close(): void;
}

/** A SQL failure: `category` 'storage', `code` 'sql-failed', the SQLite message in `detail`. */
export class SqlFailedError extends Error {
  readonly category = 'storage';
  readonly code = 'sql-failed';
  readonly detail: string;
  constructor(cause: unknown) {
    super('storage/sql-failed');
    this.name = 'SqlFailedError';
    this.detail = cause instanceof Error ? cause.message : String(cause);
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

const NESTED =
  'Nested transactions are not supported; run the work inside the open transaction instead.';

const CONNECTION_PRAGMAS = [
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA foreign_keys = ON',
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;

/**
 * Splits a script into statements at semicolons outside single- and double-quoted literals, `--` and
 * block comments, and `CREATE [TEMP|TEMPORARY] TRIGGER ... BEGIN ... END` bodies (accounting for
 * nested `CASE ... END`). Comments are dropped and empty statements skipped.
 */
export function splitSqlStatements(script: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  let seenCreate = false;
  let isTrigger = false;
  let inTriggerBody = false;
  let caseDepth = 0;

  const flush = () => {
    const sql = current.trim();
    if (sql !== '') out.push(sql);
    current = '';
    seenCreate = false;
    isTrigger = false;
    inTriggerBody = false;
    caseDepth = 0;
  };

  while (i < script.length) {
    const c = script.charAt(i);
    const next = script.charAt(i + 1);
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < script.length) {
        if (script.charAt(j) === c) {
          if (script.charAt(j + 1) === c) j += 2;
          else break;
        } else j += 1;
      }
      current += script.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && next === '-') {
      const end = script.indexOf('\n', i);
      i = end === -1 ? script.length : end;
      current += ' ';
    } else if (c === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      i = end === -1 ? script.length : end + 2;
      current += ' ';
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < script.length && IDENT_CONT.test(script.charAt(j))) j += 1;
      const word = script.slice(i, j);
      const upper = word.toUpperCase();
      if (!inTriggerBody) {
        if (!seenCreate && current.trim() === '' && upper === 'CREATE') {
          seenCreate = true;
        } else if (seenCreate && !isTrigger) {
          if (upper === 'TRIGGER') isTrigger = true;
          else if (upper !== 'TEMP' && upper !== 'TEMPORARY') seenCreate = false;
        } else if (isTrigger && upper === 'BEGIN') {
          inTriggerBody = true;
        }
      } else if (upper === 'CASE') {
        caseDepth += 1;
      } else if (upper === 'END') {
        if (caseDepth > 0) caseDepth -= 1;
        else inTriggerBody = false;
      }
      current += word;
      i = j;
    } else if (c === ';' && !inTriggerBody) {
      flush();
      i += 1;
    } else {
      current += c;
      i += 1;
    }
  }
  flush();
  return out;
}

/** A {@link SqlDriver} whose writer statements can be interrupted when a run's signal aborts. */
export interface OpSqliteDriver extends SqlDriver {
  /**
   * Binds the signal of the current import run: when it aborts, `interrupt()` is called on the writer connection
   * (rolling back an open transaction), and a writer statement failing while it is aborted rejects with an
   * `AbortError`. Reader queries are never interrupted. Pass `undefined` to detach.
   */
  setAbortSignal(signal: AbortSignal | undefined): void;
  close(): Promise<void>;
}

/**
 * The op-sqlite `location` of the app's databases for `Platform.OS`: `Library/Caches` on Apple platforms (iOS, iPadOS,
 * tvOS), because tvOS hardware gives apps only purgeable storage and iOS backs `Library` up to iCloud; `undefined`
 * (op-sqlite's default databases directory) on Android.
 */
export function databaseLocation(os: string): string | undefined {
  return os === 'ios' ? `${IOS_LIBRARY_PATH}/Caches` : undefined;
}

/**
 * Opens `name` twice (WAL) in `location` (an absolute directory; op-sqlite's default when omitted): a writer for writes
 * and transactions and a reader for plain `all` calls, so list queries are not queued behind an import batch. Both
 * connections receive connection-scoped pragmas (`busy_timeout`, `temp_store`, `foreign_keys`) on open.
 */
export async function createOpSqliteDriver(
  name: string,
  location?: string,
): Promise<OpSqliteDriver> {
  const options = location === undefined ? { name } : { name, location };
  const writer = open(options) as unknown as OpConnection;
  const reader = open(options) as unknown as OpConnection;
  for (const pragma of CONNECTION_PRAGMAS) {
    await writer.execute(pragma);
    await reader.execute(pragma);
  }

  let signal: AbortSignal | undefined;
  let closePromise: Promise<void> | undefined;
  const onAbort = () => {
    writer.interrupt();
  };

  const writeGuard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw signal?.aborted ? abortError() : new SqlFailedError(error);
    }
  };

  const readGuard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new SqlFailedError(error);
    }
  };

  const queue = () => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(job: () => Promise<T>): Promise<T> => {
      const result = tail.then(job);
      tail = result.catch(() => undefined);
      return result;
    };
  };
  const writes = queue();
  const reads = queue();

  const statements = async (exec: OpConnection['execute'], sql: string): Promise<void> => {
    for (const statement of splitSqlStatements(sql)) await exec(statement);
  };
  const changes = (r: OpResult): SqlRunResult => ({ changes: r.rowsAffected });

  const inTransaction = (tx: OpTx): SqlDriver => ({
    exec: (sql) => writeGuard(() => statements((s) => tx.execute(s), sql)),
    run: (sql, params) =>
      writeGuard(async () => changes(await tx.execute(sql, [...(params ?? [])]))),
    all: <T>(sql: string, params?: readonly SqlValue[]) =>
      writeGuard(async () => (await tx.execute(sql, [...(params ?? [])])).rows as T[]),
    batch: (sql, rows) =>
      writeGuard(async () => {
        if (rows.length === 0) return;
        const statement = writer.prepareStatement(sql);
        for (const row of rows) {
          await statement.bind([...row]);
          await statement.execute();
        }
      }),
    transaction: async () => {
      throw new Error(NESTED);
    },
  });

  return {
    setAbortSignal(next) {
      signal?.removeEventListener('abort', onAbort);
      signal = next;
      if (next === undefined || closePromise !== undefined) return;
      if (next.aborted) onAbort();
      else next.addEventListener('abort', onAbort, { once: true });
    },
    exec: (sql) => writes(() => writeGuard(() => statements((s) => writer.execute(s), sql))),
    run: (sql, params) =>
      writes(() => writeGuard(async () => changes(await writer.execute(sql, [...(params ?? [])])))),
    all: <T>(sql: string, params?: readonly SqlValue[]) =>
      reads(() =>
        readGuard(async () => (await reader.execute(sql, [...(params ?? [])])).rows as T[]),
      ),
    batch: (sql, rows) =>
      writes(() =>
        writeGuard(async () => {
          if (rows.length === 0) return;
          await writer.executeBatch(rows.map((row) => [sql, [...row]]));
        }),
      ),
    transaction: <T>(fn: (tx: SqlDriver) => Promise<T>) =>
      writes(async () => {
        let value: T | undefined;
        let callbackError: { error: unknown } | undefined;
        try {
          await writeGuard(() =>
            writer.transaction(async (tx) => {
              try {
                value = await fn(inTransaction(tx));
              } catch (error) {
                callbackError = { error };
                throw error;
              }
            }),
          );
        } catch (error) {
          throw callbackError ? callbackError.error : error;
        }
        return value as T;
      }),
    close() {
      if (closePromise !== undefined) return closePromise;
      signal?.removeEventListener('abort', onAbort);
      signal = undefined;
      closePromise = Promise.all([
        writes(async () => {
          writer.close();
        }),
        reads(async () => {
          reader.close();
        }),
      ]).then(() => undefined);
      return closePromise;
    },
  };
}
