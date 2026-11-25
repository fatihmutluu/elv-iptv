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
  getDbPath(location?: string): string;
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

const COPY_STAGED_PROGRAMMES_SQL =
  'INSERT OR REPLACE INTO programmes_next ' +
  '(source_id, guide_id, start, stop, title, sub_title, description, categories_json, ' +
  'episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold) ' +
  'SELECT source_id, guide_id, start, stop, title, sub_title, description, categories_json, ' +
  'episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold ' +
  'FROM xmltv_stage.programmes_next';

const OPEN_MAX_ATTEMPTS = 3;
const OPEN_BACKOFF_MS: readonly number[] = [100, 250];
const TRANSIENT_SQLITE_LOCK_RE = /sqlite_busy|sqlite_locked|database(?:\s+table)?\s+is\s+locked/i;

/** Options for {@link createOpSqliteDriver} open-retry behavior (`#138`). */
export interface OpSqliteOpenOptions {
  /** Maximum open attempts on transient busy/locked errors (default `3`). */
  maxAttempts?: number;
  /** Backoff delays in milliseconds between retries (default `[100, 250]`). */
  backoffMs?: readonly number[];
  /** Injectable delay function for deterministic unit tests. */
  sleep?: (ms: number) => Promise<void>;
}

function isTransientSqliteOpenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_SQLITE_LOCK_RE.test(code)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return TRANSIENT_SQLITE_LOCK_RE.test(msg);
}

function closeQuietly(conn: OpConnection | undefined): void {
  if (conn === undefined) return;
  try {
    conn.close();
  } catch {
    // Closing an already-broken handle during retry/cleanup must not mask the original error.
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;
/** Stay below SQLite's legacy 999 bind-parameter ceiling while amortizing statement prep (`#25`). */
const MAX_MULTI_INSERT_PARAMS = 900;
const MAX_MULTI_INSERT_ROWS = 100;
const SIMPLE_INSERT_VALUES_RE =
  /^(\s*INSERT(?:\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+[\s\S]+?\bVALUES\s*)\((\s*\?(?:\s*,\s*\?)*\s*)\)([\s\S]*)$/i;

/**
 * Packs uniform single-row `INSERT ... VALUES (?, ...)` batches into multi-row `INSERT` statements
 * (capped at {@link MAX_MULTI_INSERT_PARAMS} parameters and {@link MAX_MULTI_INSERT_ROWS} rows per
 * statement) to slash `sqlite3_prepare_v2` and JSI marshalling overhead during bulk imports (`#25`).
 * Returns `undefined` for non-INSERT statements, 1-row batches, or mismatched placeholder counts.
 */
export function packInsertBatch(
  sql: string,
  rows: readonly (readonly SqlValue[])[],
): [string, SqlValue[]][] | undefined {
  if (rows.length <= 1) return undefined;
  const match = SIMPLE_INSERT_VALUES_RE.exec(sql);
  if (match === null) return undefined;
  const prefix = match[1] as string;
  const tupleInner = match[2] as string;
  const suffix = match[3] as string;
  if (prefix.includes('?') || suffix.includes('?')) return undefined;
  const cols = tupleInner.split(',').length;
  if (cols <= 0 || cols > MAX_MULTI_INSERT_PARAMS) return undefined;
  for (const row of rows) {
    if (row.length !== cols) return undefined;
  }
  const perStmt = Math.max(
    1,
    Math.min(MAX_MULTI_INSERT_ROWS, Math.floor(MAX_MULTI_INSERT_PARAMS / cols)),
  );
  if (perStmt <= 1) return undefined;
  const tuple = `(${tupleInner})`;
  const commands: [string, SqlValue[]][] = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const end = Math.min(rows.length, i + perStmt);
    const count = end - i;
    const tuples: string[] = [];
    const params: SqlValue[] = [];
    for (let j = i; j < end; j += 1) {
      tuples.push(tuple);
      const row = rows[j] as readonly SqlValue[];
      for (let k = 0; k < cols; k += 1) params.push(row[k] as SqlValue);
    }
    commands.push([count === 1 ? sql : `${prefix}${tuples.join(', ')}${suffix}`, params]);
  }
  return commands;
}

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
  /** Returns the resolved on-disk SQLite file path for native off-thread helpers (`#478`). */
  getDbPath(): string;
  /**
   * Attaches a temporary XMLTV stage SQLite file on `op-sqlite`'s own writer connection, copies
   * its `programmes_next` rows into the main catalog database, and always detaches it (`#478`).
   * Runs directly on the serialized writer connection (outside a SQLite transaction, since SQLite
   * forbids `ATTACH DATABASE` inside a transaction).
   */
  attachAndCopyProgrammes(stageDbPath: string): Promise<void>;
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
 * connections receive connection-scoped pragmas (`busy_timeout`, `temp_store`, `foreign_keys`) on open. Partial
 * handles are always closed on failure, and transient `SQLITE_BUSY`/`SQLITE_LOCKED` open errors retry up to 3 times.
 */
export async function createOpSqliteDriver(
  name: string,
  location?: string,
  openOptions?: OpSqliteOpenOptions,
): Promise<OpSqliteDriver> {
  const options = location === undefined ? { name } : { name, location };
  const maxAttempts = Math.max(1, openOptions?.maxAttempts ?? OPEN_MAX_ATTEMPTS);
  const backoffMs = openOptions?.backoffMs ?? OPEN_BACKOFF_MS;
  const sleep = openOptions?.sleep ?? defaultSleep;

  let writer!: OpConnection;
  let reader!: OpConnection;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let w: OpConnection | undefined;
    let r: OpConnection | undefined;
    try {
      w = open(options) as unknown as OpConnection;
      r = open(options) as unknown as OpConnection;
      for (const pragma of CONNECTION_PRAGMAS) {
        await w.execute(pragma);
        await r.execute(pragma);
      }
      writer = w;
      reader = r;
      break;
    } catch (error) {
      closeQuietly(r);
      closeQuietly(w);
      if (attempt + 1 < maxAttempts && isTransientSqliteOpenError(error)) {
        const delay = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 250;
        await sleep(delay);
        continue;
      }
      throw error;
    }
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
        const packed = packInsertBatch(sql, rows);
        if (packed !== undefined) {
          for (const [cmdSql, params] of packed) {
            await tx.execute(cmdSql, params);
          }
          return;
        }
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
    getDbPath() {
      return location === undefined ? writer.getDbPath() : writer.getDbPath(location);
    },
    attachAndCopyProgrammes: (stageDbPath: string) =>
      writes(() =>
        writeGuard(async () => {
          await writer.execute('ATTACH DATABASE ? AS xmltv_stage', [stageDbPath]);
          let copyError: unknown;
          let failed = false;
          try {
            await writer.execute(COPY_STAGED_PROGRAMMES_SQL);
          } catch (error) {
            failed = true;
            copyError = error;
          }
          try {
            await writer.execute('DETACH DATABASE xmltv_stage');
          } catch (detachError) {
            if (!failed) throw detachError;
          }
          if (failed) throw copyError;
        }),
      ),
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
          const packed = packInsertBatch(sql, rows);
          await writer.executeBatch(packed ?? rows.map((row) => [sql, [...row]]));
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
