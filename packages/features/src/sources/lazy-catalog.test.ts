import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createLazyCatalog } from './lazy-catalog';

describe('createLazyCatalog', () => {
  it('delegates CatalogService calls once opened', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          const bytes = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Ch\nhttp://127.0.0.1/1.ts\n');
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
      clock: () => 100,
    });

    const lazy = createLazyCatalog(async () => underlying);
    expect(await lazy.listSources()).toEqual([]);

    const added = await lazy.addSourceFromLink({
      name: 'Demo',
      url: 'http://127.0.0.1/demo.m3u8',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const imported = await lazy.importSource(added.value.id);
    expect(imported.ok).toBe(true);

    const cats = await lazy.categories(added.value.id, 'live');
    expect(cats.length).toBe(1);
    const items = await lazy.items(cats[0]?.id ?? '', 0, 10);
    expect(items.length).toBe(1);
    const detail = await lazy.itemDetail?.(items[0]?.key ?? '');
    expect(detail).toMatchObject({ key: items[0]?.key, kind: 'live', name: 'Ch', plot: null });
    expect(await lazy.itemDetail?.('unknown-key')).toBeNull();
    const hits = await lazy.search?.('ch', { scope: 'live' });
    expect(hits?.live.map((r) => r.name)).toEqual(['Ch']);
    const stream = await lazy.resolveStream(items[0]?.key ?? '');
    expect(stream.ok).toBe(true);
    expect((await lazy.seasons(999)).ok).toBe(false);
    expect(await lazy.episodes(999, 1)).toEqual([]);
    expect(await lazy.queryNextEpisode?.('x:s1:series:1', 'x:s1:episode:1')).toBeNull();
    expect(await lazy.nowNext?.([items[0]?.key ?? ''], 1_000)).toEqual([]);
    expect(await lazy.epgWindow?.([items[0]?.key ?? ''], 1_000, 10_000)).toEqual({});
    expect(await lazy.channelByNumber?.(999)).toBeNull();
    expect((await lazy.importGuide?.(added.value.id))?.ok).toBe(false);
    expect((await lazy.removeSource(added.value.id)).ok).toBe(true);

    await lazy.close();
    handle.close();
  });

  it('converts opener rejections into typed storage Result errors', async () => {
    const typedErr = Object.assign(new Error('open failed'), {
      error: elvError('storage', 'bridge-unavailable'),
    });
    const lazyTyped = createLazyCatalog(async () => {
      throw typedErr;
    });
    expect(
      await lazyTyped.addSource({
        kind: 'm3u',
        name: 'Fail',
        playlistUrl: 'http://127.0.0.1/a.m3u8',
      }),
    ).toEqual({
      ok: false,
      error: { category: 'storage', code: 'bridge-unavailable' },
    });
    await lazyTyped.close();

    const lazyPlain = createLazyCatalog(async () => {
      throw new Error('boom');
    });
    expect(await lazyPlain.removeSource('x')).toEqual({
      ok: false,
      error: { category: 'storage', code: 'open-failed' },
    });
  });

  it('returns null from itemDetail when the underlying CatalogService omits itemDetail', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          return ok({
            status: 200,
            headers: {},
            body: { async *[Symbol.asyncIterator]() {} },
          });
        },
      },
      clock: () => 100,
    });
    const {
      itemDetail: _omitted,
      search: _omittedSearch,
      importGuide: _omittedGuide,
      nowNext: _omittedNowNext,
      epgWindow: _omittedEpg,
      channelByNumber: _omittedChNum,
      queryNextEpisode: _omittedNextEp,
      ...withoutDetail
    } = underlying;
    const lazy = createLazyCatalog(async () => withoutDetail);
    expect(await lazy.itemDetail?.('x:s1:movie:1')).toBeNull();
    expect(await lazy.search?.('horizon')).toEqual({ live: [], movies: [], series: [] });
    expect(await lazy.importGuide?.('s1')).toEqual({
      ok: false,
      error: { category: 'storage', code: 'unsupported' },
    });
    expect(await lazy.nowNext?.(['x:s1:live:1'], 1000)).toEqual([]);
    expect(await lazy.epgWindow?.(['x:s1:live:1'], 1000, 2000)).toEqual({});
    expect(await lazy.channelByNumber?.(101)).toBeNull();
    expect(await lazy.queryNextEpisode?.('x:s1:series:1', 'x:s1:episode:1')).toBeNull();
    await lazy.close();
    handle.close();
  });

  it('memoizes load across sequential and concurrent calls so mutations persist', async () => {
    let loadCount = 0;
    const handles: Array<ReturnType<typeof testDb>> = [];
    const lazy = createLazyCatalog(async () => {
      loadCount += 1;
      const handle = testDb();
      handles.push(handle);
      await openCatalog(handle.db);
      return createCatalogService({
        db: handle.db,
        secrets: memorySecrets(),
        scheduler: countingScheduler(),
        http: {
          async get() {
            return ok({
              status: 200,
              headers: {},
              body: { async *[Symbol.asyncIterator]() {} },
            });
          },
        },
        clock: () => 100,
      });
    });

    const [a, b, c] = await Promise.all([
      lazy.listSources(),
      lazy.listSources(),
      lazy.addSourceFromLink({ name: 'Persisted', url: 'http://127.0.0.1/live.m3u8' }),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(c.ok).toBe(true);
    expect(loadCount).toBe(1);

    const sources = await lazy.listSources();
    expect(sources.map((s) => s.name)).toEqual(['Persisted']);
    expect(loadCount).toBe(1);

    await lazy.close();
    for (const h of handles) h.close();
  });

  it('clears the cached promise when load rejects so a subsequent retry succeeds', async () => {
    let attempts = 0;
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          return ok({
            status: 200,
            headers: {},
            body: { async *[Symbol.asyncIterator]() {} },
          });
        },
      },
      clock: () => 100,
    });

    const lazy = createLazyCatalog(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('transient open failure'), {
          error: elvError('storage', 'bridge-unavailable'),
        });
      }
      return underlying;
    });

    const first = await lazy.addSourceFromLink({
      name: 'Retry Me',
      url: 'http://127.0.0.1/retry.m3u8',
    });
    expect(first).toEqual({
      ok: false,
      error: { category: 'storage', code: 'bridge-unavailable' },
    });
    expect(attempts).toBe(1);

    const second = await lazy.addSourceFromLink({
      name: 'Retry Me',
      url: 'http://127.0.0.1/retry.m3u8',
    });
    expect(second.ok).toBe(true);
    expect(attempts).toBe(2);
    expect((await lazy.listSources()).map((s) => s.name)).toEqual(['Retry Me']);
    expect(attempts).toBe(2);

    await lazy.close();
    handle.close();
  });

  it('clears the cache on close and avoids opening when never used', async () => {
    let loadCount = 0;
    let closeCount = 0;
    const handles: Array<ReturnType<typeof testDb>> = [];

    const lazy = createLazyCatalog(async () => {
      loadCount += 1;
      const handle = testDb();
      handles.push(handle);
      await openCatalog(handle.db);
      const svc = createCatalogService({
        db: handle.db,
        secrets: memorySecrets(),
        scheduler: countingScheduler(),
        http: {
          async get() {
            return ok({
              status: 200,
              headers: {},
              body: { async *[Symbol.asyncIterator]() {} },
            });
          },
        },
        clock: () => 100,
      });
      return {
        ...svc,
        async close() {
          closeCount += 1;
          await svc.close();
        },
      };
    });

    await lazy.close();
    expect(loadCount).toBe(0);
    expect(closeCount).toBe(0);

    await lazy.listSources();
    expect(loadCount).toBe(1);

    await lazy.close();
    expect(closeCount).toBe(1);

    await lazy.listSources();
    expect(loadCount).toBe(2);

    await lazy.close();
    expect(closeCount).toBe(2);
    for (const h of handles) h.close();
  });

  it('forwards setFavorite and flushPendingWrites without opening an unused catalog on flush', async () => {
    let loadCount = 0;
    let flushCount = 0;
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          return ok({
            status: 200,
            headers: {},
            body: { async *[Symbol.asyncIterator]() {} },
          });
        },
      },
      clock: () => 100,
    });

    const lazy = createLazyCatalog(async () => {
      loadCount += 1;
      return {
        ...underlying,
        async flushPendingWrites() {
          flushCount += 1;
        },
      };
    });

    // Flushing before open must NOT open the catalog
    await lazy.flushPendingWrites?.();
    expect(loadCount).toBe(0);
    expect(flushCount).toBe(0);

    const setRes = await lazy.setFavorite?.(
      {
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Test Movie',
      },
      true,
    );
    expect(setRes).toEqual(ok(true));
    expect(loadCount).toBe(1);

    await lazy.flushPendingWrites?.();
    expect(flushCount).toBe(1);

    await lazy.close();
    handle.close();
  });

  it('forwards ListItemsOptions on items and allSourcesItems (#125)', async () => {
    const itemsCalls: unknown[][] = [];
    const allSourcesCalls: unknown[][] = [];
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          return ok({
            status: 200,
            headers: {},
            body: { async *[Symbol.asyncIterator]() {} },
          });
        },
      },
      clock: () => 100,
    });

    const lazy = createLazyCatalog(async () => ({
      ...underlying,
      items: async (...args) => {
        itemsCalls.push(args);
        return underlying.items(...args);
      },
      allSourcesItems: async (...args) => {
        allSourcesCalls.push(args);
        return underlying.allSourcesItems?.(...args) ?? [];
      },
    }));

    const opts = { sortBy: 'alpha' as const, excludeWatched: true, profileId: 'p1' };
    await lazy.items('src-1|movie|10', 0, 20, opts);
    await lazy.allSourcesItems?.('movie', 0, 15, ['src-1'], opts);

    expect(itemsCalls).toEqual([['src-1|movie|10', 0, 20, opts]]);
    expect(allSourcesCalls).toEqual([['movie', 0, 15, ['src-1'], opts]]);

    await lazy.close();
    handle.close();
  });
});
