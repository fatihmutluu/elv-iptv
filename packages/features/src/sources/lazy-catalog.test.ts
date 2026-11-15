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
    const stream = await lazy.resolveStream(items[0]?.key ?? '');
    expect(stream.ok).toBe(true);
    expect((await lazy.seasons(999)).ok).toBe(false);
    expect(await lazy.episodes(999, 1)).toEqual([]);
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
});
