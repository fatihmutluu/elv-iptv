import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogService } from './catalog';
import type { WatchProgressRow } from './user-state';
import { createCoalescedCatalog } from './write-coalescer';

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
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createCoalescedCatalog listWatched flush regression', () => {
  it('flushes queued saveProgress and setWatched writes for the target profile before listWatched returns', async () => {
    const timers = createFakeTimers();
    const events: string[] = [];
    const watchedRow: WatchProgressRow = {
      profileId: 'kids',
      sourceId: 's1',
      itemKey: 'x:s1:movie:1',
      kind: 'movie',
      title: 'Dune',
      subtitle: null,
      logo: null,
      seriesKey: null,
      season: null,
      episode: null,
      positionMs: 100_000,
      durationMs: 100_000,
      watched: true,
      updatedAt: 500,
    };

    const listWatched = vi.fn(async (limit?: number, profileId?: string, opts?: unknown) => {
      events.push(`listWatched:${limit}:${profileId ?? 'default'}:${JSON.stringify(opts ?? {})}`);
      return [watchedRow];
    });

    const base = makeStubCatalog({
      saveProgress: vi.fn(async (input) => {
        events.push(`saveProgress:${input.profileId ?? 'default'}:${input.itemKey}`);
        return ok({
          ...watchedRow,
          profileId: input.profileId ?? 'default',
          itemKey: input.itemKey,
          positionMs: input.positionMs,
          durationMs: input.durationMs,
          watched: input.watched ?? false,
        });
      }),
      setWatched: vi.fn(async (itemKey, watched, profileId) => {
        events.push(`setWatched:${profileId ?? 'default'}:${itemKey}:${watched}`);
        return ok(undefined);
      }),
      listWatched,
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const pSave = catalog.saveProgress?.({
      profileId: 'kids',
      sourceId: 's1',
      itemKey: 'x:s1:movie:1',
      kind: 'movie',
      title: 'Dune',
      positionMs: 100_000,
      durationMs: 100_000,
      watched: true,
    });
    const pWatch = catalog.setWatched?.('x:s1:movie:2', true, 'kids');

    expect(catalog.listWatched).toBeDefined();
    const rows = await catalog.listWatched?.(50, 'kids', {
      kind: 'movie',
      parentalUnlocked: true,
    });
    await Promise.all([pSave, pWatch]);

    expect(rows).toEqual([watchedRow]);
    expect(listWatched).toHaveBeenCalledWith(50, 'kids', {
      kind: 'movie',
      parentalUnlocked: true,
    });
    expect(events).toEqual([
      'saveProgress:kids:x:s1:movie:1',
      'setWatched:kids:x:s1:movie:2:true',
      'listWatched:50:kids:{"kind":"movie","parentalUnlocked":true}',
    ]);
  });
});
