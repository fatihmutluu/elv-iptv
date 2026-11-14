import type { SqlDriver } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { addAccount, env, must, useSim } from './catalog-test-env';

const sim = useSim();

/**
 * Wraps a driver the way the op-sqlite one behaves: one abort slot for the whole driver, and every statement fails
 * with an `AbortError` while the bound signal is aborted.
 */
function oneSlot(db: SqlDriver): SqlDriver {
  let bound: AbortSignal | undefined;
  const check = () => {
    if (bound?.aborted) {
      const error = new Error('interrupted');
      error.name = 'AbortError';
      throw error;
    }
  };
  const wrap = (inner: SqlDriver): SqlDriver => ({
    exec: async (sql) => {
      check();
      return inner.exec(sql);
    },
    run: async (sql, params) => {
      check();
      return inner.run(sql, params);
    },
    all: async (sql, params) => {
      check();
      return inner.all(sql, params);
    },
    batch: async (sql, rows) => {
      check();
      return inner.batch(sql, rows);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
  });
  const setAbortSignal = (db as SqlDriver & { setAbortSignal(s?: AbortSignal): void })
    .setAbortSignal;
  return Object.assign(wrap(db), {
    setAbortSignal(signal: AbortSignal | undefined) {
      bound = signal;
      setAbortSignal(signal);
    },
  });
}

async function twoSources() {
  const e = await env({}, oneSlot);
  const a = await addAccount(e, sim.url(), 'demo', 'A');
  const b = await addAccount(e, sim.url(), 'demo', 'B');
  return { e, a, b };
}

describe('one import at a time', () => {
  it('runs a second import after the first and binds each signal only during its own run', async () => {
    const { e, a, b } = await twoSources();
    const sa = new AbortController();
    const sb = new AbortController();
    const order: string[] = [];
    const first = e.service.importSource(a, {
      signal: sa.signal,
      onProgress: () => order.push('a'),
    });
    const second = e.service.importSource(b, {
      signal: sb.signal,
      onProgress: () => order.push('b'),
    });
    must(await first);
    must(await second);
    expect(order.indexOf('b')).toBeGreaterThan(order.lastIndexOf('a'));
    expect(e.setAbortSignal.mock.calls).toEqual([
      [sa.signal],
      [undefined],
      [sb.signal],
      [undefined],
    ]);
  });

  it('cancelling a waiting import ends it at once and leaves the running one alone', async () => {
    const { e, a, b } = await twoSources();
    const sb = new AbortController();
    let second: ReturnType<typeof e.service.importSource> | undefined;
    let cancelledEarly = false;
    const first = e.service.importSource(a, {
      onProgress: () => {
        if (second !== undefined) return;
        second = e.service.importSource(b, { signal: sb.signal });
        sb.abort();
        void second.then(() => {
          cancelledEarly = true;
        });
      },
    });
    const r = await first;
    expect(r.ok).toBe(true);
    expect(cancelledEarly).toBe(true);
    expect(await second).toMatchObject({
      ok: false,
      error: { category: 'network', code: 'aborted' },
    });
    expect(e.setAbortSignal.mock.calls).toEqual([[undefined], [undefined]]);
    expect(
      e.raw.prepare('SELECT COUNT(*) AS n FROM import_runs WHERE source_id = ?').get(b),
    ).toEqual({ n: 0 });
  });

  it('cancelling the running import lets the waiting one run', async () => {
    const { e, a, b } = await twoSources();
    const sa = new AbortController();
    const first = e.service.importSource(a, { signal: sa.signal, onProgress: () => sa.abort() });
    const second = e.service.importSource(b);
    expect(await first).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(must(await second).counts.live).toBeGreaterThan(0);
  });

  it('refuses a second call for a source that is importing or waiting without touching the signal', async () => {
    const { e, a, b } = await twoSources();
    const sa = new AbortController();
    const refused: ReturnType<typeof e.service.importSource>[] = [];
    let waiting: ReturnType<typeof e.service.importSource> | undefined;
    const first = e.service.importSource(a, {
      signal: sa.signal,
      onProgress: () => {
        if (waiting !== undefined) return;
        waiting = e.service.importSource(b);
        refused.push(e.service.importSource(a), e.service.importSource(b));
      },
    });
    must(await first);
    for (const r of refused) {
      expect(await r).toMatchObject({ ok: false, error: { code: 'import-in-progress' } });
    }
    must(await (waiting as ReturnType<typeof e.service.importSource>));
    expect(e.setAbortSignal.mock.calls).toEqual([
      [sa.signal],
      [undefined],
      [undefined],
      [undefined],
    ]);
  });

  it('cancelling the running import after a refused call still stops it', async () => {
    const { e, a } = await twoSources();
    const sa = new AbortController();
    let refused: ReturnType<typeof e.service.importSource> | undefined;
    const r = await e.service.importSource(a, {
      signal: sa.signal,
      onProgress: (p) => {
        if (refused === undefined) {
          refused = e.service.importSource(a);
          return;
        }
        if (p.phase === 'live') sa.abort();
      },
    });
    expect(await refused).toMatchObject({ ok: false, error: { code: 'import-in-progress' } });
    expect(r).toMatchObject({ ok: false, error: { code: 'aborted' } });
  });
});
