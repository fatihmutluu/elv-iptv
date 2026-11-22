import { elvError, err, ok, type Result } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogService } from './catalog';
import type { WatchProgressRow } from './user-state';
import {
  createCoalescedCatalog,
  createWriteCoalescer,
  DEFAULT_WRITE_COALESCE_MS,
} from './write-coalescer';

function createFakeTimers() {
  let nextId = 1;
  const active = new Map<number, { fn: () => void; ms: number }>();
  return {
    active,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      active.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      active.delete(handle as unknown as number);
    },
    runAll: () => {
      const callbacks = [...active.values()];
      active.clear();
      for (const cb of callbacks) cb.fn();
    },
  };
}

function makeStubCatalog(overrides?: Partial<CatalogService>): CatalogService {
  return {
    addSource: async () => err(elvError('storage', 'unsupported')),
    addSourceFromLink: async () => err(elvError('storage', 'unsupported')),
    removeSource: vi.fn(async () => ok(undefined)),
    importSource: async () => err(elvError('storage', 'unsupported')),
    listSources: async () => [],
    categories: async () => [],
    items: async () => [],
    seasons: async () => ok([]),
    episodes: async () => [],
    resolveStream: async () => err(elvError('storage', 'unsupported')),
    saveProgress: vi.fn(async (input) =>
      ok({
        profileId: input.profileId ?? 'default',
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        subtitle: input.subtitle ?? null,
        logo: input.logo ?? null,
        seriesKey: input.seriesKey ?? null,
        season: input.season ?? null,
        episode: input.episode ?? null,
        positionMs: input.positionMs,
        durationMs: input.durationMs,
        watched: input.watched ?? false,
        updatedAt: 100,
      } satisfies WatchProgressRow),
    ),
    setWatched: vi.fn(async () => ok(undefined)),
    clearProgress: vi.fn(async () => ok(undefined)),
    setFavorite: vi.fn(async (_input, active) => ok(active)),
    toggleFavorite: vi.fn(async () => ok(true)),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createWriteCoalescer', () => {
  it('exposes DEFAULT_WRITE_COALESCE_MS = 500 and collapses rapid writes per key to the latest job', async () => {
    expect(DEFAULT_WRITE_COALESCE_MS).toBe(500);
    const timers = createFakeTimers();
    const coalescer = createWriteCoalescer({
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const executed: string[] = [];
    const p1 = coalescer.schedule('k1', async () => {
      executed.push('first');
      return 'v1';
    });
    const p2 = coalescer.schedule('k1', async () => {
      executed.push('second');
      return 'v2';
    });
    const p3 = coalescer.schedule('k1', async () => {
      executed.push('third');
      return 'v3';
    });
    const other = coalescer.schedule('k2', async () => {
      executed.push('other');
      return 'o1';
    });

    expect(coalescer.pendingCount()).toBe(2);
    expect(timers.active.size).toBe(2);
    expect(executed).toEqual([]);

    timers.runAll();
    expect(await Promise.all([p1, p2, p3, other])).toEqual(['v3', 'v3', 'v3', 'o1']);
    expect(executed).toEqual(['third', 'other']);
    expect(coalescer.pendingCount()).toBe(0);
  });

  it('rejects all superseded waiters when the final coalesced job rejects', async () => {
    const timers = createFakeTimers();
    const coalescer = createWriteCoalescer({
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const p1 = coalescer.schedule('k1', async () => 'ok');
    const p2 = coalescer.schedule('k1', async () => {
      throw new Error('boom');
    });

    timers.runAll();
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
  });

  it('flush() cancels timers immediately, awaits in-flight + re-entrant writes, and is safe concurrently', async () => {
    const timers = createFakeTimers();
    const coalescer = createWriteCoalescer({
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    let reentrantPromise: Promise<string> | undefined;
    const p1 = coalescer.schedule('k1', async () => {
      order.push('start-1');
      // Schedule a re-entrant write while k1 is in-flight
      reentrantPromise = coalescer.schedule('k1', async () => {
        order.push('run-2');
        return 'second';
      });
      await firstGate;
      order.push('end-1');
      return 'first';
    });

    const f1 = coalescer.flush();
    const f2 = coalescer.flush();
    expect(timers.active.size).toBe(0);
    releaseFirst();

    await Promise.all([f1, f2]);
    expect(await p1).toBe('first');
    expect(await reentrantPromise).toBe('second');
    expect(order).toEqual(['start-1', 'end-1', 'run-2']);
    expect(coalescer.pendingCount()).toBe(0);
  });

  it('executes immediately when windowMs <= 0 and dispose() clears timers', async () => {
    const timers = createFakeTimers();
    const immediate = createWriteCoalescer({
      windowMs: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    expect(await immediate.schedule('k', async () => 42)).toBe(42);
    expect(timers.active.size).toBe(0);

    const delayed = createWriteCoalescer({
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const job = vi.fn(async () => 'never');
    const disposedPromise = delayed.schedule('k', job);
    expect(delayed.pendingCount()).toBe(1);
    delayed.dispose();
    expect(delayed.pendingCount()).toBe(0);
    expect(timers.active.size).toBe(0);
    timers.runAll();
    expect(job).not.toHaveBeenCalled();
    await expect(disposedPromise).rejects.toThrow('disposed');
  });
});

describe('createCoalescedCatalog', () => {
  it('coalesces rapid setFavorite, setWatched, and saveProgress per (profileId, itemKey)', async () => {
    const timers = createFakeTimers();
    const base = makeStubCatalog();
    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const favInput = { sourceId: 's1', itemKey: 'm:s1:1', kind: 'movie' as const, title: 'Film' };
    const f1 = catalog.setFavorite?.(favInput, true);
    const f2 = catalog.setFavorite?.(favInput, false);
    const f3 = catalog.setFavorite?.(favInput, true);

    const w1 = catalog.setWatched?.('m:s1:1', true);
    const w2 = catalog.setWatched?.('m:s1:1', false);

    const progBase = {
      sourceId: 's1',
      itemKey: 'm:s1:2',
      kind: 'movie' as const,
      title: 'Film 2',
      durationMs: 100_000,
    };
    const pr1 = catalog.saveProgress?.({ ...progBase, positionMs: 15_000 });
    const pr2 = catalog.saveProgress?.({ ...progBase, positionMs: 35_000 });

    expect(base.setFavorite).not.toHaveBeenCalled();
    expect(base.setWatched).not.toHaveBeenCalled();
    expect(base.saveProgress).not.toHaveBeenCalled();

    timers.runAll();
    expect(await Promise.all([f1, f2, f3])).toEqual([ok(true), ok(true), ok(true)]);
    expect(await Promise.all([w1, w2])).toEqual([ok(undefined), ok(undefined)]);
    const saved = await Promise.all([pr1, pr2]);
    expect(saved[0]?.ok && saved[0].value.positionMs).toBe(35_000);
    expect(saved[1]?.ok && saved[1].value.positionMs).toBe(35_000);

    expect(base.setFavorite).toHaveBeenCalledTimes(1);
    expect(base.setFavorite).toHaveBeenCalledWith(favInput, true);
    expect(base.setWatched).toHaveBeenCalledTimes(1);
    expect(base.setWatched).toHaveBeenCalledWith('m:s1:1', false, undefined);
    expect(base.saveProgress).toHaveBeenCalledTimes(1);
  });

  it('flushes pending saveProgress/setWatched before clearProgress so clearProgress cannot be overwritten', async () => {
    const timers = createFakeTimers();
    const events: string[] = [];
    const base = makeStubCatalog({
      saveProgress: vi.fn(async (input) => {
        events.push(`save:${input.positionMs}`);
        return ok({
          profileId: input.profileId ?? 'default',
          sourceId: input.sourceId,
          itemKey: input.itemKey,
          kind: input.kind,
          title: input.title,
          subtitle: null,
          logo: null,
          seriesKey: null,
          season: null,
          episode: null,
          positionMs: input.positionMs,
          durationMs: input.durationMs,
          watched: false,
          updatedAt: 1,
        });
      }),
      setWatched: vi.fn(async (_k, watched) => {
        events.push(`watched:${watched}`);
        return ok(undefined);
      }),
      clearProgress: vi.fn(async () => {
        events.push('clear');
        return ok(undefined);
      }),
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const pSave = catalog.saveProgress?.({
      sourceId: 's1',
      itemKey: 'm:s1:1',
      kind: 'movie',
      title: 'Film',
      positionMs: 20_000,
      durationMs: 100_000,
    });
    const pWatch = catalog.setWatched?.('m:s1:1', true);
    const pClear = catalog.clearProgress?.('m:s1:1');

    const [saveRes, watchRes, clearRes] = await Promise.all([pSave, pWatch, pClear]);
    expect(saveRes?.ok).toBe(true);
    expect(watchRes?.ok).toBe(true);
    expect(clearRes?.ok).toBe(true);
    expect(events[events.length - 1]).toBe('clear');
    expect(timers.active.size).toBe(0);
  });

  it('flushes pending writes automatically before removeSource and close', async () => {
    const timers = createFakeTimers();
    const events: string[] = [];
    const base = makeStubCatalog({
      setFavorite: vi.fn(async (_input, active): Promise<Result<boolean>> => {
        events.push(`fav:${active}`);
        return ok(active);
      }),
      removeSource: vi.fn(async (id) => {
        events.push(`remove:${id}`);
        return ok(undefined);
      }),
      close: vi.fn(async () => {
        events.push('close');
      }),
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const fav1 = catalog.setFavorite?.(
      { sourceId: 's1', itemKey: 'm:s1:1', kind: 'movie', title: 'A' },
      true,
    );
    await catalog.removeSource('s1');
    expect(await fav1).toEqual(ok(true));

    const fav2 = catalog.setFavorite?.(
      { sourceId: 's2', itemKey: 'm:s2:1', kind: 'movie', title: 'B' },
      false,
    );
    await catalog.close();
    expect(await fav2).toEqual(ok(false));

    expect(events).toEqual(['fav:true', 'remove:s1', 'fav:false', 'close']);
  });

  it('preserves read-your-own-writes across getProgress, listProgressByKeys, listContinueWatching, listFavorites, listFavoriteKeys, and toggleFavorite', async () => {
    const timers = createFakeTimers();
    const events: string[] = [];
    let storedPos = 0;
    let storedFav = false;
    const base = makeStubCatalog({
      saveProgress: vi.fn(async (input) => {
        storedPos = input.positionMs;
        events.push(`save:${input.positionMs}`);
        return ok({
          profileId: input.profileId ?? 'default',
          sourceId: input.sourceId,
          itemKey: input.itemKey,
          kind: input.kind,
          title: input.title,
          subtitle: null,
          logo: null,
          seriesKey: null,
          season: null,
          episode: null,
          positionMs: input.positionMs,
          durationMs: input.durationMs,
          watched: input.watched ?? false,
          updatedAt: 1,
        });
      }),
      getProgress: vi.fn(async () => {
        events.push(`getProgress:${storedPos}`);
        return null;
      }),
      listProgressByKeys: vi.fn(async () => {
        events.push(`listProgressByKeys:${storedPos}`);
        return [];
      }),
      listContinueWatching: vi.fn(async () => {
        events.push(`listContinueWatching:${storedPos}`);
        return [];
      }),
      setFavorite: vi.fn(async (_input, active) => {
        storedFav = active;
        events.push(`setFav:${active}`);
        return ok(active);
      }),
      toggleFavorite: vi.fn(async () => {
        storedFav = !storedFav;
        events.push(`toggleFav:${storedFav}`);
        return ok(storedFav);
      }),
      listFavorites: vi.fn(async () => {
        events.push(`listFavorites:${storedFav}`);
        return [];
      }),
      listFavoriteKeys: vi.fn(async () => {
        events.push(`listFavoriteKeys:${storedFav}`);
        return storedFav ? ['m:s1:1'] : [];
      }),
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const favInput = { sourceId: 's1', itemKey: 'm:s1:1', kind: 'movie' as const, title: 'Film' };
    const progInput = {
      sourceId: 's1',
      itemKey: 'm:s1:1',
      kind: 'movie' as const,
      title: 'Film',
      durationMs: 100_000,
    };

    // Pending saveProgress flushed before getProgress, listProgressByKeys, and listContinueWatching
    const p1 = catalog.saveProgress?.({ ...progInput, positionMs: 15_000 });
    await catalog.getProgress?.('m:s1:1');
    await p1;

    const p2 = catalog.saveProgress?.({ ...progInput, positionMs: 25_000 });
    await catalog.listProgressByKeys?.(['m:s1:1']);
    await p2;

    const p3 = catalog.saveProgress?.({ ...progInput, positionMs: 35_000 });
    await catalog.listContinueWatching?.(10);
    await p3;

    // Pending setFavorite flushed before listFavorites, listFavoriteKeys, and toggleFavorite
    const f1 = catalog.setFavorite?.(favInput, true);
    await catalog.listFavorites?.(10);
    await f1;

    const f2 = catalog.setFavorite?.(favInput, false);
    expect(await catalog.listFavoriteKeys?.()).toEqual([]);
    await f2;

    const f3 = catalog.setFavorite?.(favInput, true);
    const toggled = await catalog.toggleFavorite?.(favInput);
    await f3;
    expect(toggled).toEqual(ok(false));

    expect(events).toEqual([
      'save:15000',
      'getProgress:15000',
      'save:25000',
      'listProgressByKeys:25000',
      'save:35000',
      'listContinueWatching:35000',
      'setFav:true',
      'listFavorites:true',
      'setFav:false',
      'listFavoriteKeys:false',
      'setFav:true',
      'toggleFav:false',
    ]);
  });

  it('preserves causal ordering when setWatched(true) is followed by saveProgress(watched: false) within the window', async () => {
    const timers = createFakeTimers();
    let persistedWatched: boolean | undefined;
    const order: string[] = [];
    const base = makeStubCatalog({
      setWatched: vi.fn(async (_key, watched) => {
        persistedWatched = watched;
        order.push(`setWatched:${watched}`);
        return ok(undefined);
      }),
      saveProgress: vi.fn(async (input) => {
        const watched = input.watched ?? false;
        persistedWatched = watched;
        order.push(`saveProgress:${watched}`);
        return ok({
          profileId: input.profileId ?? 'default',
          sourceId: input.sourceId,
          itemKey: input.itemKey,
          kind: input.kind,
          title: input.title,
          subtitle: null,
          logo: null,
          seriesKey: null,
          season: null,
          episode: null,
          positionMs: input.positionMs,
          durationMs: input.durationMs,
          watched,
          updatedAt: 1,
        });
      }),
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // t=0: setWatched(k, true)
    const pWatch = catalog.setWatched?.('m:s1:1', true);
    // t=100: saveProgress(k, watched: false) — must NOT be overwritten by earlier setWatched(true)
    const pSave = catalog.saveProgress?.({
      sourceId: 's1',
      itemKey: 'm:s1:1',
      kind: 'movie',
      title: 'Film',
      positionMs: 20_000,
      durationMs: 100_000,
      watched: false,
    });

    timers.runAll();
    await Promise.all([pWatch, pSave]);
    expect(order).toEqual(['setWatched:true', 'saveProgress:false']);
    expect(persistedWatched).toBe(false);
  });

  it('flushes pending progress and watched writes before listSeriesUnplayedCounts (#409)', async () => {
    const timers = createFakeTimers();
    const events: string[] = [];
    const base = makeStubCatalog({
      saveProgress: vi.fn(async (input) => {
        events.push(`save:${input.itemKey}`);
        return ok({
          profileId: input.profileId ?? 'default',
          sourceId: input.sourceId,
          itemKey: input.itemKey,
          kind: input.kind,
          title: input.title,
          subtitle: null,
          logo: null,
          seriesKey: input.seriesKey ?? null,
          season: input.season ?? null,
          episode: input.episode ?? null,
          positionMs: input.positionMs,
          durationMs: input.durationMs,
          watched: input.watched ?? true,
          updatedAt: 1,
        });
      }),
      setWatched: vi.fn(async (itemKey, watched) => {
        events.push(`watched:${itemKey}:${watched}`);
        return ok(undefined);
      }),
      listSeriesUnplayedCounts: vi.fn(async (seriesKeys) => {
        events.push(`unplayed:${seriesKeys.join(',')}`);
        return [{ seriesKey: 'x:s1:series:1', total: 3, unplayed: 1, watched: false }];
      }),
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const pSave = catalog.saveProgress?.({
      sourceId: 's1',
      itemKey: 'x:s1:ep:1',
      kind: 'episode',
      title: 'Ep 1',
      seriesKey: 'x:s1:series:1',
      positionMs: 95_000,
      durationMs: 100_000,
      watched: true,
    });
    const pWatch = catalog.setWatched?.('x:s1:ep:2', true);

    const summaries = await catalog.listSeriesUnplayedCounts?.(['x:s1:series:1']);
    await Promise.all([pSave, pWatch]);

    expect(summaries).toEqual([
      { seriesKey: 'x:s1:series:1', total: 3, unplayed: 1, watched: false },
    ]);
    expect(events).toEqual(['save:x:s1:ep:1', 'watched:x:s1:ep:2:true', 'unplayed:x:s1:series:1']);
  });
});
