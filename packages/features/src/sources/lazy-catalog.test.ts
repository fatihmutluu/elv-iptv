import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
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
    expect(await lazy.listSeriesUnplayedCounts?.(['x:s1:series:1'])).toEqual([]);
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
      searchSuggestions: _omittedSuggestions,
      alphabetIndex: _omittedAlphabet,
      importGuide: _omittedGuide,
      nowNext: _omittedNowNext,
      epgWindow: _omittedEpg,
      channelByNumber: _omittedChNum,
      queryNextEpisode: _omittedNextEp,
      listSeriesUnplayedCounts: _omittedUnplayed,
      ...withoutDetail
    } = underlying;
    const lazy = createLazyCatalog(async () => withoutDetail);
    expect(await lazy.itemDetail?.('x:s1:movie:1')).toBeNull();
    expect(await lazy.search?.('horizon')).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });
    expect(await lazy.searchSuggestions?.({ limit: 8 })).toEqual([]);
    expect(await lazy.alphabetIndex?.({ kind: 'movie' })).toEqual([]);
    expect(await lazy.importGuide?.('s1')).toEqual({
      ok: false,
      error: { category: 'storage', code: 'unsupported' },
    });
    expect(await lazy.nowNext?.(['x:s1:live:1'], 1000)).toEqual([]);
    expect(await lazy.epgWindow?.(['x:s1:live:1'], 1000, 2000)).toEqual({});
    expect(await lazy.channelByNumber?.(101)).toBeNull();
    expect(await lazy.queryNextEpisode?.('x:s1:series:1', 'x:s1:episode:1')).toBeNull();
    expect(await lazy.listSeriesUnplayedCounts?.(['x:s1:series:1'])).toEqual([]);
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

  it('forwards all 12 profile & parental methods and ParentalQueryOptions (#15, #31)', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          const bytes = new TextEncoder().encode(
            '#EXTM3U\n#EXTINF:-1 group-title="18+ Adult",Late Channel\nhttp://127.0.0.1/1.ts\n',
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
      clock: () => 1_000,
    });

    const lazy = createLazyCatalog(async () => underlying);
    const initialProfiles = await lazy.listProfiles?.();
    expect(initialProfiles?.map((p) => p.id)).toEqual(['default']);

    const created = await lazy.createProfile?.({
      name: 'Kids',
      avatarToken: 'emerald',
      isKids: true,
    });
    expect(created?.ok).toBe(true);
    if (!created?.ok) return;
    const kidsId = created.value.id;

    const updated = await lazy.updateProfile?.(kidsId, { name: 'Juniors' });
    expect(updated?.ok).toBe(true);

    const settings = await lazy.getParentalSettings?.(kidsId);
    expect(settings?.enabled).toBe(true);

    const patched = await lazy.updateParentalSettings?.({ unlockTimeoutMin: 15 }, kidsId);
    expect(patched?.ok).toBe(true);

    expect(await lazy.hasParentalPin?.(kidsId)).toBe(false);
    expect((await lazy.setParentalPin?.('1234', kidsId))?.ok).toBe(true);
    expect(await lazy.hasParentalPin?.(kidsId)).toBe(true);
    expect(await lazy.verifyParentalPin?.('1234', kidsId)).toEqual({ ok: true });

    const lockRes = await lazy.setParentalLock?.(
      {
        profileId: kidsId,
        sourceId: 's1',
        targetKind: 'category',
        itemKind: 'live',
        targetKey: '18+ Adult',
      },
      true,
    );
    expect(lockRes?.ok).toBe(true);
    expect((await lazy.listParentalLocks?.(kidsId))?.length).toBe(1);

    const added = await lazy.addSourceFromLink({
      name: 'AdultDemo',
      url: 'http://127.0.0.1/demo.m3u',
    });
    expect(added.ok).toBe(true);
    if (added.ok) {
      await lazy.importSource(added.value.id);
      const catsLocked = await lazy.categories(added.value.id, 'live', {
        profileId: kidsId,
        parentalUnlocked: false,
      });
      const catsUnlocked = await lazy.categories(added.value.id, 'live', {
        profileId: kidsId,
        parentalUnlocked: true,
      });
      expect(catsLocked.length).toBe(0);
      expect(catsUnlocked.length).toBe(1);
      const items = await lazy.items(catsUnlocked[0]?.id ?? '', 0, 10, {
        profileId: kidsId,
        parentalUnlocked: true,
      });
      const lockedStream = await lazy.resolveStream(items[0]?.key ?? '', {
        profileId: kidsId,
        parentalUnlocked: false,
      });
      expect(lockedStream.ok).toBe(false);
      const unlockedStream = await lazy.resolveStream(items[0]?.key ?? '', {
        profileId: kidsId,
        parentalUnlocked: true,
      });
      expect(unlockedStream.ok).toBe(true);
    }

    expect((await lazy.clearParentalPin?.('1234', kidsId))?.ok).toBe(true);
    expect(await lazy.hasParentalPin?.(kidsId)).toBe(false);
    expect((await lazy.deleteProfile?.(kidsId))?.ok).toBe(true);

    await lazy.close();
    handle.close();
  });

  it('forwards parental query options for liveVariants, itemVersions, seasons, episodes, and queryNextEpisode', async () => {
    const liveVariants = vi.fn(async () => []);
    const itemVersions = vi.fn(async () => []);
    const seasons = vi.fn(async () => ok([]));
    const episodes = vi.fn(async () => []);
    const queryNextEpisode = vi.fn(async () => null);
    const base = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => []),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      liveVariants,
      itemVersions,
      seasons,
      episodes,
      queryNextEpisode,
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const lazy = createLazyCatalog(async () => base);
    const opts = { profileId: 'kids-1', parentalUnlocked: false };
    await lazy.liveVariants?.('ch:1', 'cat:1', opts);
    await lazy.itemVersions?.('mov:1', opts);
    await lazy.seasons(42, opts);
    await lazy.episodes(42, 1, opts);
    await lazy.queryNextEpisode?.('ser:42', 'ep:1', 'kids-1', { parentalUnlocked: false });

    expect(liveVariants).toHaveBeenCalledWith('ch:1', 'cat:1', opts);
    expect(itemVersions).toHaveBeenCalledWith('mov:1', opts);
    expect(seasons).toHaveBeenCalledWith(42, opts);
    expect(episodes).toHaveBeenCalledWith(42, 1, opts);
    expect(queryNextEpisode).toHaveBeenCalledWith('ser:42', 'ep:1', 'kids-1', {
      parentalUnlocked: false,
    });
  });

  it('delegates all 11 channel override and custom group methods (#60) and returns unsupported when omitted', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          const bytes = new TextEncoder().encode(
            '#EXTM3U\n#EXTINF:-1,Ch 1\nhttp://127.0.0.1/1.ts\n',
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
      clock: () => 500,
    });
    const lazy = createLazyCatalog(async () => underlying);
    const added = await lazy.addSourceFromLink({ name: 'Demo', url: 'http://127.0.0.1/demo.m3u' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await lazy.importSource(added.value.id);
    const cats = await lazy.categories(added.value.id, 'live');
    const items = await lazy.items(cats[0]?.id ?? '', 0, 10);
    const chKey = items[0]?.key ?? '';

    const setRes = await lazy.setChannelOverride?.({
      itemKey: chKey,
      sourceId: added.value.id,
      customName: 'Custom Ch 1',
    });
    expect(setRes?.ok).toBe(true);
    expect((await lazy.listChannelOverrides?.())?.length).toBe(1);
    expect((await lazy.reorderChannels?.([chKey], added.value.id))?.ok).toBe(true);
    expect((await lazy.clearChannelOverride?.(chKey))?.ok).toBe(true);

    const created = await lazy.createCustomGroup?.({ name: 'Sports' });
    expect(created?.ok).toBe(true);
    if (created?.ok) {
      expect((await lazy.listCustomGroups?.())?.length).toBe(1);
      expect((await lazy.updateCustomGroup?.(created.value.id, { name: 'Top Sports' }))?.ok).toBe(
        true,
      );
      expect(
        (await lazy.addChannelToCustomGroup?.(created.value.id, chKey, added.value.id))?.ok,
      ).toBe(true);
      expect(
        (
          await lazy.setCustomGroupItems?.(created.value.id, [
            { itemKey: chKey, sourceId: added.value.id },
          ])
        )?.ok,
      ).toBe(true);
      expect((await lazy.removeChannelFromCustomGroup?.(created.value.id, chKey))?.ok).toBe(true);
      expect((await lazy.deleteCustomGroup?.(created.value.id))?.ok).toBe(true);
    }

    await lazy.close();
    handle.close();

    const minimal = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => []),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;
    const lazyMin = createLazyCatalog(async () => minimal);
    expect(await lazyMin.listChannelOverrides?.()).toEqual([]);
    expect((await lazyMin.setChannelOverride?.({ itemKey: 'k', sourceId: 's1' }))?.ok).toBe(false);
    expect((await lazyMin.clearChannelOverride?.('k'))?.ok).toBe(false);
    expect((await lazyMin.reorderChannels?.(['k'], 's1'))?.ok).toBe(false);
    expect(await lazyMin.listCustomGroups?.()).toEqual([]);
    expect((await lazyMin.createCustomGroup?.({ name: 'G' }))?.ok).toBe(false);
    expect((await lazyMin.updateCustomGroup?.('g1', { name: 'G2' }))?.ok).toBe(false);
    expect((await lazyMin.deleteCustomGroup?.('g1'))?.ok).toBe(false);
    expect((await lazyMin.setCustomGroupItems?.('g1', []))?.ok).toBe(false);
    expect((await lazyMin.addChannelToCustomGroup?.('g1', 'k', 's1'))?.ok).toBe(false);
    expect((await lazyMin.removeChannelFromCustomGroup?.('g1', 'k'))?.ok).toBe(false);
  });

  it('delegates all 16 Wave F3 catch-up, guide source, override, and reminder methods and falls back cleanly when omitted', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          const bytes = new TextEncoder().encode(
            '#EXTM3U\n#EXTINF:-1 catchup="shift" catchup-days="3",News HD\nhttp://127.0.0.1/live/1.ts\n',
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
      clock: () => 10_000_000,
    });
    const lazy = createLazyCatalog(async () => underlying);
    const added = await lazy.addSourceFromLink({ name: 'Demo', url: 'http://127.0.0.1/demo.m3u' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await lazy.importSource(added.value.id);
    const cats = await lazy.categories(added.value.id, 'live');
    const items = await lazy.items(cats[0]?.id ?? '', 0, 10);
    const chKey = items[0]?.key ?? '';

    const catchupRes = await lazy.resolveCatchupStream?.(chKey, {
      startMs: 9_000_000,
      stopMs: 9_600_000,
    });
    expect(catchupRes?.ok).toBe(true);
    const archiveRes = await lazy.fetchChannelArchiveEpg?.(chKey);
    expect(archiveRes?.ok).toBe(true);

    const g1 = await lazy.addGuideSource?.({
      sourceId: added.value.id,
      name: 'Backup XMLTV',
      url: 'http://127.0.0.1/epg.xml',
    });
    expect(g1?.ok).toBe(true);
    if (g1?.ok) {
      expect((await lazy.listGuideSources?.(added.value.id))?.length).toBe(1);
      expect((await lazy.updateGuideSource?.(g1.value.id, { epgShiftMs: 3_600_000 }))?.ok).toBe(
        true,
      );
      expect((await lazy.reorderGuideSources?.(added.value.id, [g1.value.id]))?.ok).toBe(true);
      expect((await lazy.removeGuideSource?.(g1.value.id))?.ok).toBe(true);
    }

    expect(await lazy.listGuideChannels?.(added.value.id)).toEqual([]);
    expect(
      (
        await lazy.setChannelGuideOverride?.({
          sourceId: added.value.id,
          channelKey: chKey,
          guideId: 'news.hd',
        })
      )?.ok,
    ).toBe(true);
    expect((await lazy.listChannelGuideOverrides?.(added.value.id))?.length).toBe(1);
    expect((await lazy.clearChannelGuideOverride?.(added.value.id, chKey))?.ok).toBe(true);

    const rem = await lazy.upsertReminder?.({
      sourceId: added.value.id,
      channelKey: chKey,
      channelName: 'News HD',
      programmeTitle: 'Late News',
      programmeStart: 20_000_000,
      programmeStop: 23_600_000,
    });
    expect(rem?.ok).toBe(true);
    expect((await lazy.listReminders?.())?.length).toBe(1);
    expect((await lazy.markReminderFired?.(chKey, 20_000_000))?.ok).toBe(true);
    expect((await lazy.removeReminder?.(chKey, 20_000_000))?.ok).toBe(true);
    expect(await lazy.pruneExpiredReminders?.(30_000_000)).toBe(0);

    await lazy.close();
    handle.close();

    const minimal = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => []),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;
    const lazyMin = createLazyCatalog(async () => minimal);
    expect((await lazyMin.resolveCatchupStream?.('k', { startMs: 1, stopMs: 2 }))?.ok).toBe(false);
    expect((await lazyMin.fetchChannelArchiveEpg?.('k'))?.ok).toBe(false);
    expect(await lazyMin.listGuideSources?.('s1')).toEqual([]);
    expect(
      (await lazyMin.addGuideSource?.({ sourceId: 's1', name: 'G', url: 'http://a.invalid/e.xml' }))
        ?.ok,
    ).toBe(false);
    expect((await lazyMin.updateGuideSource?.('g1', { enabled: false }))?.ok).toBe(false);
    expect((await lazyMin.removeGuideSource?.('g1'))?.ok).toBe(false);
    expect((await lazyMin.reorderGuideSources?.('s1', ['g1']))?.ok).toBe(false);
    expect(await lazyMin.listGuideChannels?.('s1')).toEqual([]);
    expect(await lazyMin.listChannelGuideOverrides?.('s1')).toEqual([]);
    expect(
      (await lazyMin.setChannelGuideOverride?.({ sourceId: 's1', channelKey: 'k', guideId: 'g' }))
        ?.ok,
    ).toBe(false);
    expect((await lazyMin.clearChannelGuideOverride?.('s1', 'k'))?.ok).toBe(false);
    expect(await lazyMin.listReminders?.()).toEqual([]);
    expect(
      (
        await lazyMin.upsertReminder?.({
          sourceId: 's1',
          channelKey: 'k',
          channelName: 'Ch',
          programmeTitle: 'Show',
          programmeStart: 100,
          programmeStop: 200,
        })
      )?.ok,
    ).toBe(false);
    expect((await lazyMin.removeReminder?.('k', 100))?.ok).toBe(false);
    expect((await lazyMin.markReminderFired?.('k', 100))?.ok).toBe(false);
    expect(await lazyMin.pruneExpiredReminders?.(999)).toBe(0);
  });
});
