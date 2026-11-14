/** Recording in-memory stand-in for the op-sqlite surface the driver uses. Test helper. */
export interface FakeResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
}

export interface FakeConn {
  readonly log: string[];
  /** Makes the next execute/executeBatch wait until `release()` or `interrupt()` (which rejects it). */
  hold(): { release(): void };
  rowsFor: (sql: string) => Record<string, unknown>[];
  execute(sql: string, params?: unknown[]): Promise<FakeResult>;
  executeBatch(commands: [string, unknown[]?][]): Promise<{ rowsAffected: number }>;
  transaction(fn: (tx: FakeTx) => Promise<void>): Promise<void>;
  prepareStatement(sql: string): {
    bind(p: unknown[]): Promise<void>;
    execute(): Promise<FakeResult>;
  };
  interrupt(): void;
  close(): void;
}

interface FakeTx {
  execute(sql: string, params?: unknown[]): Promise<FakeResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Builds a fake `open` that records every connection it hands out, writer first. */
export function createFakeOpSqlite() {
  const conns: FakeConn[] = [];
  const opened: { name: string; location?: string }[] = [];
  function make(): FakeConn {
    let gate: { promise: Promise<void>; release(): void; fail(e: Error): void } | undefined;
    let pending: ((e: Error) => void) | undefined;
    const log: string[] = [];
    const wait = async (): Promise<void> => {
      if (!gate) return;
      const g = gate;
      gate = undefined;
      pending = g.fail;
      try {
        await g.promise;
      } finally {
        pending = undefined;
      }
    };
    const run = async (label: string, sql: string, params?: unknown[]): Promise<FakeResult> => {
      log.push(`${label}:${sql}${params && params.length > 0 ? `|${JSON.stringify(params)}` : ''}`);
      await wait();
      if (sql.includes('FAIL')) throw new Error('near FAIL: syntax error');
      return { rows: conn.rowsFor(sql), rowsAffected: 1 };
    };
    const conn: FakeConn = {
      log,
      rowsFor: () => [],
      hold() {
        let release!: () => void;
        let fail!: (e: Error) => void;
        const promise = new Promise<void>((res, rej) => {
          release = res;
          fail = rej;
        });
        gate = { promise, release, fail };
        return { release };
      },
      execute: (sql, params) => run('execute', sql, params),
      async executeBatch(commands) {
        log.push(`executeBatch:${commands.length}:${commands[0]?.[0] ?? ''}`);
        await wait();
        return { rowsAffected: commands.length };
      },
      async transaction(fn) {
        log.push('transaction:begin');
        const tx: FakeTx = {
          execute: (sql, params) => run('tx.execute', sql, params),
          commit: async () => {
            log.push('transaction:commit');
          },
          rollback: async () => {
            log.push('transaction:rollback');
          },
        };
        try {
          await fn(tx);
          log.push('transaction:end');
        } catch (e) {
          log.push('transaction:rollback');
          throw e;
        }
      },
      prepareStatement(sql) {
        let bound: unknown[] = [];
        return {
          bind: async (p) => {
            bound = p;
          },
          execute: () => run('stmt', sql, bound),
        };
      },
      interrupt() {
        log.push('interrupt');
        pending?.(new Error('interrupted'));
      },
      close() {
        log.push('close');
      },
    };
    conns.push(conn);
    return conn;
  }
  return {
    conns,
    opened,
    open(options: { name: string; location?: string }): FakeConn {
      opened.push(options);
      return make();
    },
  };
}
