import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createSerializedImportQueue } from './import-queue';
import type { ImportSummary } from './import-types';
import { openCatalog } from './migrate';
import { testDb } from './test-db';

const EMPTY_SUMMARY: ImportSummary = {
  runId: 1,
  counts: { categories: 0, live: 0, movies: 0, series: 0, episodes: 0, programmes: 0 },
  warnings: 0,
  warningCodes: [],
  durationMs: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SerializedImportQueue (#432 series-episodes lane)', () => {
  it('serializes series-episodes strictly against catalog and guide imports', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const queue = createSerializedImportQueue(db);
      const events: string[] = [];
      const catalogStarted = deferred<void>();
      const epStarted = deferred<void>();
      const gate1 = deferred<void>();
      const gate2 = deferred<void>();

      const catalogRun = queue.run('s1', 'catalog', undefined, async () => {
        events.push('catalog:start');
        catalogStarted.resolve();
        await gate1.promise;
        events.push('catalog:end');
        return ok(EMPTY_SUMMARY);
      });

      const epRun = queue.run('s1', 'series-episodes', undefined, async () => {
        events.push('episodes:start');
        epStarted.resolve();
        await gate2.promise;
        events.push('episodes:end');
        return ok(12);
      });

      const guideRun = queue.run('s1', 'guide', undefined, async () => {
        events.push('guide:start');
        events.push('guide:end');
        return ok(EMPTY_SUMMARY);
      });

      await catalogStarted.promise;
      expect(events).toEqual(['catalog:start']);

      gate1.resolve();
      expect((await catalogRun).ok).toBe(true);
      await epStarted.promise;
      expect(events).toEqual(['catalog:start', 'catalog:end', 'episodes:start']);

      gate2.resolve();
      const epRes = await epRun;
      const guideRes = await guideRun;
      expect(epRes).toEqual({ ok: true, value: 12 });
      expect(guideRes.ok).toBe(true);
      expect(events).toEqual([
        'catalog:start',
        'catalog:end',
        'episodes:start',
        'episodes:end',
        'guide:start',
        'guide:end',
      ]);
      await queue.close();
    } finally {
      close();
    }
  });

  it('queues concurrent series-episodes for the same source and rejects duplicate taskKey', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const queue = createSerializedImportQueue(db);
      const gate = deferred<void>();
      const order: string[] = [];

      const first = queue.run(
        's1',
        'series-episodes',
        undefined,
        async () => {
          order.push('epA:start');
          await gate.promise;
          order.push('epA:end');
          return ok(5);
        },
        { taskKey: 'x:s1:series:A' },
      );

      const dup = await queue.run('s1', 'series-episodes', undefined, async () => ok(5), {
        taskKey: 'x:s1:series:A',
      });
      expect(dup).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'import-in-progress' },
      });

      const second = queue.run(
        's1',
        'series-episodes',
        undefined,
        async () => {
          order.push('epB:start');
          order.push('epB:end');
          return ok(8);
        },
        { taskKey: 'x:s1:series:B' },
      );

      gate.resolve();
      expect(await first).toEqual({ ok: true, value: 5 });
      expect(await second).toEqual({ ok: true, value: 8 });
      expect(order).toEqual(['epA:start', 'epA:end', 'epB:start', 'epB:end']);
      await queue.close();
    } finally {
      close();
    }
  });

  it('aborts running and queued series-episodes on abortForSource and blocks them while removing', async () => {
    const { db, close } = testDb();
    try {
      await openCatalog(db);
      const queue = createSerializedImportQueue(db);
      let s1SignalAborted = false;
      let queuedInvoked = false;
      const started = deferred<void>();

      const runningS1 = queue.run('s1', 'series-episodes', undefined, async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        s1SignalAborted = signal.aborted;
        return ok(0);
      });

      const queuedS1 = queue.run('s1', 'series-episodes', undefined, async () => {
        queuedInvoked = true;
        return ok(1);
      });

      const queuedS2 = queue.run('s2', 'series-episodes', undefined, async () => ok(9));

      await started.promise;
      queue.markRemoving('s1');

      const rejected = await queue.run('s1', 'series-episodes', undefined, async () => ok(3));
      expect(rejected).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'source-not-found' },
      });

      await queue.abortForSource('s1');
      await runningS1;
      const queuedRes = await queuedS1;
      const s2Res = await queuedS2;

      expect(s1SignalAborted).toBe(true);
      expect(queuedInvoked).toBe(false);
      expect(queuedRes).toMatchObject({
        ok: false,
        error: { category: 'network', code: 'aborted' },
      });
      expect(s2Res).toEqual({ ok: true, value: 9 });

      queue.unmarkRemoving('s1');
      expect(await queue.run('s1', 'series-episodes', undefined, async () => ok(4))).toEqual({
        ok: true,
        value: 4,
      });

      await queue.close();
      expect(await queue.run('s1', 'series-episodes', undefined, async () => ok(1))).toMatchObject({
        ok: false,
        error: { category: 'network', code: 'aborted' },
      });
    } finally {
      close();
    }
  });
});
