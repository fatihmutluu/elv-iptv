import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShortEpgQueue } from './short-epg-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('createShortEpgQueue (#217)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps at 60 via head eviction, fetches in LIFO tail-first order, respects maxConcurrency, and batches onBatch by 150ms', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const fetchedOrder: string[] = [];
    const inflightByKey = new Map<string, ReturnType<typeof deferred<string>>>();
    let peakConcurrency = 0;
    let activeConcurrency = 0;
    const batches: ReadonlyMap<string, string>[] = [];

    const queue = createShortEpgQueue<string>({
      capacity: 60,
      ttlMs: 300_000,
      batchDelayMs: 150,
      maxConcurrency: 2,
      now: () => nowMs,
      fetchEntry: (key) => {
        fetchedOrder.push(key);
        activeConcurrency += 1;
        peakConcurrency = Math.max(peakConcurrency, activeConcurrency);
        const d = deferred<string>();
        inflightByKey.set(key, d);
        return d.promise.finally(() => {
          activeConcurrency -= 1;
        });
      },
      onBatch: (updates) => {
        batches.push(new Map(updates));
      },
    });

    // Simulate 150 rapid row enqueues during fast scroll
    for (let i = 1; i <= 150; i += 1) {
      queue.enqueue(`ch-${i}`);
    }
    expect(queue.pendingCount()).toBe(60);

    // Microtask starts up to maxConcurrency = 2 fetches from the tail (LIFO)
    await flushMicrotasks();
    expect(fetchedOrder).toEqual(['ch-150', 'ch-149']);
    expect(queue.inFlightCount()).toBe(2);
    expect(peakConcurrency).toBe(2);

    // Resolve first two fetches; onBatch must wait for 150ms coalescing window
    inflightByKey.get('ch-150')?.resolve('Show 150');
    inflightByKey.get('ch-149')?.resolve('Show 149');
    await flushMicrotasks();

    expect(batches).toHaveLength(0);
    expect(fetchedOrder).toEqual(['ch-150', 'ch-149', 'ch-148', 'ch-147']);

    // Resolve next two within the same 150ms batch window
    inflightByKey.get('ch-148')?.resolve('Show 148');
    inflightByKey.get('ch-147')?.resolve('Show 147');
    await flushMicrotasks();

    // Advance 149ms — still debounced/coalesced
    vi.advanceTimersByTime(149);
    expect(batches).toHaveLength(0);

    // Advance 1ms -> single batched callback with all 4 results
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.size).toBe(4);
    expect(batches[0]?.get('ch-150')).toBe('Show 150');
    expect(batches[0]?.get('ch-147')).toBe('Show 147');

    // Drain remaining queued items (ch-146 down to ch-91)
    while (inflightByKey.size > 0) {
      let resolvedAny = false;
      for (const [k, d] of [...inflightByKey.entries()]) {
        inflightByKey.delete(k);
        d.resolve(`Show ${k}`);
        resolvedAny = true;
      }
      if (!resolvedAny) break;
      await flushMicrotasks();
    }

    vi.advanceTimersByTime(150);

    // Exactly 60 most recent rows (ch-150 down to ch-91) fetched in LIFO order; ch-1..ch-90 evicted
    expect(fetchedOrder).toHaveLength(60);
    expect(fetchedOrder[0]).toBe('ch-150');
    expect(fetchedOrder[59]).toBe('ch-91');
    expect(fetchedOrder).not.toContain('ch-90');
    expect(fetchedOrder).not.toContain('ch-1');
    expect(peakConcurrency).toBe(2);

    // TTL cache hit skips refetch while unexpired
    expect(queue.getCached('ch-150')).toBe('Show 150');
    queue.enqueue('ch-150');
    await flushMicrotasks();
    expect(fetchedOrder).toHaveLength(60);

    // After TTL expires (300_000 ms), getCached returns undefined and enqueue refetches
    nowMs += 300_000;
    expect(queue.getCached('ch-150')).toBeUndefined();
    queue.enqueue('ch-150');
    await flushMicrotasks();
    expect(fetchedOrder).toHaveLength(61);
    expect(fetchedOrder[60]).toBe('ch-150');

    queue.dispose();
  });

  it('promotes an already-queued key to the tail (most recent) and deduplicates in-flight keys', async () => {
    const fetched: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<number>>>();
    const queue = createShortEpgQueue<number>({
      capacity: 10,
      maxConcurrency: 1,
      batchDelayMs: 0,
      fetchEntry: (key) => {
        fetched.push(key);
        const d = deferred<number>();
        gates.set(key, d);
        return d.promise;
      },
      onBatch: () => undefined,
    });

    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');
    // Re-enqueue 'a' -> moves 'a' to tail so 'a' is fetched first!
    queue.enqueue('a');
    expect(queue.pendingCount()).toBe(3);

    await flushMicrotasks();
    expect(fetched).toEqual(['a']);

    // Re-enqueueing in-flight 'a' does not duplicate
    queue.enqueue('a');
    expect(queue.pendingCount()).toBe(2);

    gates.get('a')?.resolve(1);
    await flushMicrotasks();
    expect(fetched).toEqual(['a', 'c']);

    gates.get('c')?.resolve(2);
    await flushMicrotasks();
    expect(fetched).toEqual(['a', 'c', 'b']);

    gates.get('b')?.resolve(3);
    await flushMicrotasks();
    expect(queue.getCached('a')).toBe(1);
    expect(queue.getCached('b')).toBe(3);
    expect(queue.getCached('c')).toBe(2);
    queue.dispose();
  });

  it('recovers from fetch failures without caching errors and cancels timers on dispose', async () => {
    vi.useFakeTimers();
    const batches: ReadonlyMap<string, string>[] = [];
    let failOnce = true;
    const queue = createShortEpgQueue<string>({
      batchDelayMs: 150,
      maxConcurrency: 1,
      fetchEntry: async (key) => {
        if (key === 'flaky' && failOnce) {
          failOnce = false;
          throw new Error('transient');
        }
        return `ok:${key}`;
      },
      onBatch: (updates) => batches.push(new Map(updates)),
    });

    queue.enqueue('good');
    queue.enqueue('flaky');
    await flushMicrotasks();

    // 'flaky' failed and is NOT cached; 'good' succeeded and is pending batch flush
    expect(queue.getCached('flaky')).toBeUndefined();
    expect(queue.getCached('good')).toBe('ok:good');

    // Dispose cancels the 150ms flush timer so onBatch is never invoked after dispose
    queue.dispose();
    vi.advanceTimersByTime(500);
    expect(batches).toHaveLength(0);

    // Enqueue after dispose is a no-op
    queue.enqueue('after-dispose');
    await flushMicrotasks();
    expect(queue.pendingCount()).toBe(0);
  });
});
