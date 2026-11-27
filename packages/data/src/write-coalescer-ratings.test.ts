import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogService } from './catalog';
import { createCoalescedCatalog } from './write-coalescer';

function createFakeTimers() {
  let nextId = 1;
  const active = new Map<number, { fn: () => void; ms: number }>();
  return {
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

describe('createCoalescedCatalog rating coalescing & deterministic read flushes (#512)', () => {
  it('coalesces rapid setRating writes and flushes pending ratings deterministically before getRating, listRatings, listRatingMap, getElvRecommendations, and deleteProfile', async () => {
    const timers = createFakeTimers();
    const events: string[] = [];
    let currentRating: 'like' | 'dislike' | null = null;
    const base = makeStubCatalog({
      setRating: vi.fn(async (_input, value) => {
        currentRating = value;
        events.push(`setRating:${String(value)}`);
        return ok(value);
      }),
      getRating: vi.fn(async () => {
        events.push(`getRating:${String(currentRating)}`);
        return currentRating;
      }),
      listRatings: vi.fn(async () => {
        events.push(`listRatings:${String(currentRating)}`);
        return [];
      }),
      listRatingMap: vi.fn(async () => {
        events.push(`listRatingMap:${String(currentRating)}`);
        return currentRating ? { 'm:s1:1': currentRating } : {};
      }),
      getElvRecommendations: vi.fn(async () => {
        events.push(`getElvRecs:${String(currentRating)}`);
        return [];
      }),
      deleteProfile: vi.fn(async (id) => {
        events.push(`deleteProfile:${id}`);
        return ok(undefined);
      }),
    });

    const catalog = createCoalescedCatalog(base, {
      windowMs: 500,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const ratingInput = {
      profileId: 'p1',
      sourceId: 's1',
      itemKey: 'm:s1:1',
      kind: 'movie' as const,
      title: 'Film',
    };

    const r1 = catalog.setRating?.(ratingInput, 'like');
    const r2 = catalog.setRating?.(ratingInput, 'dislike');
    await catalog.getElvRecommendations?.({ profile: 'elv_picks', profileId: 'p1' });
    expect(await Promise.all([r1, r2])).toEqual([ok('dislike'), ok('dislike')]);

    const r3 = catalog.setRating?.(ratingInput, 'like');
    expect(await catalog.getRating?.('m:s1:1', 'p1')).toBe('like');
    await r3;

    const r4 = catalog.setRating?.(ratingInput, null);
    await catalog.listRatings?.({ profileId: 'p1' });
    await r4;

    const r5 = catalog.setRating?.(ratingInput, 'like');
    expect(await catalog.listRatingMap?.('p1')).toEqual({ 'm:s1:1': 'like' });
    await r5;

    const r6 = catalog.setRating?.(ratingInput, 'dislike');
    await catalog.deleteProfile?.('p1');
    await r6;

    expect(events).toEqual([
      'setRating:dislike',
      'getElvRecs:dislike',
      'setRating:like',
      'getRating:like',
      'setRating:null',
      'listRatings:null',
      'setRating:like',
      'listRatingMap:like',
      'setRating:dislike',
      'deleteProfile:p1',
    ]);
  });
});
