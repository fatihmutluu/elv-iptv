import { describe, expect, it, vi } from 'vitest';
import { noopAppLifecycle } from '../ports/app-lifecycle';
import { createPagedListSource } from './paged-list-source';

function makePageItems(offset: number, limit: number, total: number): string[] {
  const end = Math.min(total, offset + limit);
  const out: string[] = [];
  for (let i = offset; i < end; i++) {
    out.push(`Ch ${i}`);
  }
  return out;
}

describe('createPagedListSource', () => {
  it('loads visible pages lazily, deduplicates concurrent prefetches, and evicts LRU pages', async () => {
    const total = 25_000;
    const calls: Array<[number, number]> = [];
    const pendingResolvers: Array<() => void> = [];

    const loadPage = vi.fn((offset: number, limit: number) => {
      calls.push([offset, limit]);
      return new Promise<readonly string[]>((resolve) => {
        pendingResolvers.push(() => resolve(makePageItems(offset, limit, total)));
      });
    });

    const source = createPagedListSource({
      count: total,
      pageSize: 200,
      maxPages: 3,
      loadPage,
    });

    const onChange = vi.fn();
    const off = source.onChange(onChange);

    expect(source.count()).toBe(25_000);
    expect(source.get(0)).toBeUndefined();
    expect(source.get(-1)).toBeUndefined();
    expect(source.get(25_000)).toBeUndefined();

    // Concurrent prefetches in page 0 deduplicate to a single loadPage(0, 200)
    source.prefetch(0, 24);
    source.prefetch(10, 50);
    expect(calls).toEqual([[0, 200]]);

    // Flush page 0
    for (const r of pendingResolvers.splice(0)) r();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(source.get(0)).toBe('Ch 0');
    expect(source.get(199)).toBe('Ch 199');
    expect(source.get(200)).toBeUndefined();

    // Jump to middle (12,500 -> page 62, offset 12,400)
    source.prefetch(12_480, 12_540);
    expect(calls).toEqual([
      [0, 200],
      [12_400, 200],
    ]);
    for (const r of pendingResolvers.splice(0)) r();
    await Promise.resolve();
    expect(source.get(12_500)).toBe('Ch 12500');

    // Load page 1 (offset 200); cache now holds [0, 62, 1] (maxPages = 3)
    source.prefetch(200, 220);
    for (const r of pendingResolvers.splice(0)) r();
    await Promise.resolve();

    // Touch page 0 via get(5) so page 62 becomes the oldest LRU entry
    expect(source.get(5)).toBe('Ch 5');

    // Load page 2 (offset 400) -> evicts page 62, keeps [1, 0, 2]
    source.prefetch(400, 410);
    for (const r of pendingResolvers.splice(0)) r();
    await Promise.resolve();

    expect(source.get(5)).toBe('Ch 5');
    expect(source.get(205)).toBe('Ch 205');
    expect(source.get(405)).toBe('Ch 405');
    expect(source.get(12_500)).toBeUndefined();

    off();
  });

  it('resolves loadItem on demand (reusing in-flight page requests) and suppresses late resolves after dispose', async () => {
    let resolveLast!: (rows: readonly string[]) => void;
    const loadPage = vi.fn(
      (offset: number, limit: number) =>
        new Promise<readonly string[]>((resolve) => {
          if (offset === 24_800) {
            resolveLast = resolve;
          } else {
            resolve(makePageItems(offset, limit, 25_000));
          }
        }),
    );

    const source = createPagedListSource({
      count: 25_000,
      pageSize: 200,
      maxPages: 4,
      loadPage,
    });
    const onChange = vi.fn();
    source.onChange(onChange);

    // Start prefetch on last page (offset 24,800) and concurrently loadItem(24,999)
    source.prefetch(24_990, 25_000);
    const pendingItem = source.loadItem(24_999);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith(24_800, 200);

    resolveLast(makePageItems(24_800, 200, 25_000));
    expect(await pendingItem).toBe('Ch 24999');
    expect(await source.loadItem(24_999)).toBe('Ch 24999');
    expect(await source.loadItem(-5)).toBeUndefined();
    expect(await source.loadItem(25_000)).toBeUndefined();

    // Dispose before another in-flight request resolves
    onChange.mockClear();
    let resolveDisposed!: (rows: readonly string[]) => void;
    loadPage.mockImplementationOnce(
      () =>
        new Promise<readonly string[]>((resolve) => {
          resolveDisposed = resolve;
        }),
    );
    source.prefetch(1_000, 1_020);
    source.dispose();
    resolveDisposed(['late']);
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(source.get(24_999)).toBeUndefined();
    expect(await source.loadItem(0)).toBeUndefined();
  });

  it('recovers cleanly when loadPage rejects and provides a safe noopAppLifecycle', async () => {
    let failFirst = true;
    const source = createPagedListSource({
      count: 10,
      pageSize: 10,
      loadPage: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error('transient');
        }
        return ['A', 'B'];
      },
    });

    expect(await source.loadItem(0)).toBeUndefined();
    expect(await source.loadItem(1)).toBe('B');

    const off = noopAppLifecycle.subscribe(() => undefined);
    expect(typeof off).toBe('function');
    off();
  });
});
