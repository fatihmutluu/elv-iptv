/** A value that can be bound to or read from a SQL statement. */
export type SqlValue = string | number | null | Uint8Array;

/** Outcome of a write statement. */
export interface SqlRunResult {
  changes: number;
}

/**
 * Asynchronous SQL access. Implementations serialize calls, so statements issued through one driver never
 * interleave with an open transaction. Every value is bound as a parameter; callers never build SQL from data.
 */
export interface SqlDriver {
  /** Runs DDL or several statements separated by semicolons. */
  exec(sql: string): Promise<void>;
  /** Runs one write statement. */
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  /** Runs one query and returns every row. */
  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /**
   * One prepared statement executed for every parameter row inside one transaction; called on the `tx` of an
   * open transaction it joins that transaction instead.
   */
  batch(sql: string, rows: readonly (readonly SqlValue[])[]): Promise<void>;
  /**
   * Runs fn in a transaction; commits when it resolves, rolls back when it throws. Not re-entrant. Inside `fn` use
   * only the `tx` it receives: calls on the outer driver wait for the transaction to end, so awaiting one there
   * never resolves.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
}

/**
 * Platform secret storage (Keychain, Keystore, safeStorage); values are strings. Keys use only letters, digits,
 * `.`, `-` and `_`, the set the strictest platform store accepts.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Lets the host run UI work between batches of a long job. */
export interface Scheduler {
  /**
   * Resolves after the host had a turn: it must yield a macrotask (a timer, `setImmediate`, a frame), because a
   * resolved promise lets no rendering or input in.
   */
  yieldNow(): Promise<void>;
}
