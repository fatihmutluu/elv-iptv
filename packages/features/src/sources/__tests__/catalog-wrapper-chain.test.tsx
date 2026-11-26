import {
  type CatalogService,
  createCatalogService,
  createCoalescedCatalog,
  openCatalog,
} from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { ok } from '@elv/domain';
import { createObservedCatalog } from '../../app-shell-state';
import { createPlaybackGuard } from '../../ports/playback-guard';
import { createProfileScopedCatalog } from '../../shared/profile-scoped-catalog';
import { createLazyCatalog } from '../lazy-catalog';

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

describe('production CatalogService wrapper chain (listWatched & VOD collections)', () => {
  it('preserves listWatched (with coalesced flush) and all VOD collection methods with onUserStateMutated across the full stack', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          const bytes = new TextEncoder().encode(
            '#EXTM3U\n#EXTINF:-1 group-title="Movies",Dune (2021)\nhttp://127.0.0.1/movie/1.mp4\n',
          );
          return ok({
            status: 200,
            headers: {},
            body: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          });
        },
      },
      clock: () => 10_000,
    });

    const timers = createFakeTimers();
    const playbackGuard = createPlaybackGuard(() => undefined);
    const syncSourcesAndBump = jest.fn(async () => undefined);
    const onUserStateMutated = jest.fn();

    const stacked = createProfileScopedCatalog(
      createObservedCatalog(
        createCoalescedCatalog(
          createLazyCatalog(async () => underlying),
          {
            windowMs: 500,
            setTimeoutFn: timers.setTimeoutFn,
            clearTimeoutFn: timers.clearTimeoutFn,
          },
        ),
        playbackGuard,
        syncSourcesAndBump,
        onUserStateMutated,
      ),
      () => ({ profileId: 'p1', parentalUnlocked: false }),
    );

    const added = await stacked.addSource({
      kind: 'm3u',
      name: 'VOD',
      playlistUrl: 'http://127.0.0.1/vod.m3u',
      vodPlaylist: true,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await stacked.importSource(added.value.id);
    const cats = await stacked.categories(added.value.id, 'movie');
    const items = await stacked.items(cats[0]?.id ?? '', 0, 10);
    const movie = items[0];
    expect(movie).toBeDefined();
    if (!movie) return;

    // 1) Coalesced saveProgress + setWatched must flush before listWatched through full stack
    const pSave = stacked.saveProgress?.({
      sourceId: movie.sourceId,
      itemKey: movie.key,
      kind: 'movie',
      title: movie.name,
      positionMs: 60_000,
      durationMs: 120_000,
      watched: false,
    });
    const pWatch = stacked.setWatched?.(movie.key, true);

    expect(stacked.listWatched).toBeDefined();
    const watched = await stacked.listWatched?.(50, undefined, { kind: 'movie' });
    await Promise.all([pSave, pWatch]);
    expect(watched?.map((r) => r.itemKey)).toEqual([movie.key]);
    expect(watched?.[0]?.profileId).toBe('p1');

    // 2) Full VOD collection lifecycle preserved across lazy -> coalesced -> observed -> profile-scoped
    expect(stacked.createCollection).toBeDefined();
    expect(stacked.listCollections).toBeDefined();
    expect(stacked.listCollectionItems).toBeDefined();
    expect(stacked.listCollectionsForItem).toBeDefined();
    expect(stacked.addItemToCollection).toBeDefined();
    expect(stacked.removeItemFromCollection).toBeDefined();
    expect(stacked.renameCollection).toBeDefined();
    expect(stacked.reorderCollections).toBeDefined();
    expect(stacked.reorderCollectionItems).toBeDefined();
    expect(stacked.deleteCollection).toBeDefined();

    const created = await stacked.createCollection?.({ name: 'Sci-Fi' });
    expect(created?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(1);
    if (!created?.ok) return;
    expect(created.value.profileId).toBe('p1');

    const addedToCol = await stacked.addItemToCollection?.(created.value.id, movie.key, 'movie');
    expect(addedToCol?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(2);

    const cols = await stacked.listCollections?.();
    expect(cols?.map((c) => c.name)).toEqual(['Sci-Fi']);
    expect(await stacked.listCollectionsForItem?.(movie.key)).toEqual([created.value.id]);

    const colItems = await stacked.listCollectionItems?.(created.value.id);
    expect(colItems?.map((i) => i.key)).toEqual([movie.key]);

    const renamed = await stacked.renameCollection?.(created.value.id, 'Sci-Fi Classics');
    expect(renamed?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(3);

    const reorderedItems = await stacked.reorderCollectionItems?.(created.value.id, [movie.key]);
    expect(reorderedItems?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(4);

    const reorderedCols = await stacked.reorderCollections?.([created.value.id]);
    expect(reorderedCols?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(5);

    const removedItem = await stacked.removeItemFromCollection?.(created.value.id, movie.key);
    expect(removedItem?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(6);

    const deleted = await stacked.deleteCollection?.(created.value.id);
    expect(deleted?.ok).toBe(true);
    expect(onUserStateMutated).toHaveBeenCalledTimes(7);

    expect(await stacked.listCollections?.()).toEqual([]);

    await stacked.close();
    handle.close();
  });

  it('falls back cleanly in createLazyCatalog when underlying service omits listWatched and collection methods', async () => {
    const minimal = {
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      seasons: jest.fn(async () => ok([])),
      episodes: jest.fn(async () => []),
      resolveStream: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const lazy = createLazyCatalog(async () => minimal);
    expect(await lazy.listWatched?.(10)).toEqual([]);
    expect(await lazy.listCollections?.()).toEqual([]);
    expect(await lazy.listCollectionItems?.('c1')).toEqual([]);
    expect(await lazy.listCollectionsForItem?.('m:1')).toEqual([]);
    expect((await lazy.createCollection?.({ name: 'A' }))?.ok).toBe(false);
    expect((await lazy.renameCollection?.('c1', 'B'))?.ok).toBe(false);
    expect((await lazy.reorderCollections?.(['c1']))?.ok).toBe(false);
    expect((await lazy.deleteCollection?.('c1'))?.ok).toBe(false);
    expect((await lazy.addItemToCollection?.('c1', 'm:1', 'movie'))?.ok).toBe(false);
    expect((await lazy.removeItemFromCollection?.('c1', 'm:1'))?.ok).toBe(false);
    expect((await lazy.reorderCollectionItems?.('c1', ['m:1']))?.ok).toBe(false);
  });
});
