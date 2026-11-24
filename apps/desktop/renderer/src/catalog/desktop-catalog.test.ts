import type { ImportProgress, ImportSummary, SourceRow } from '@elv/data';
import { elvError, err, ok, type Result } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogBridge, CatalogBridgeImportOptions } from '../../../src/shared/catalog-ipc.ts';
import { CatalogOpenError, createDesktopCatalog, createDesktopCatalogFromBridge } from './index.ts';

function makeFakeBridge(overrides?: Partial<CatalogBridge>): {
  bridge: CatalogBridge;
  cancelledIds: number[];
} {
  const cancelledIds: number[] = [];
  let nextReq = 0;

  const base: CatalogBridge = {
    open: async () => ok(undefined),
    addSource: async () =>
      ok({
        id: 's1',
        kind: 'm3u',
        name: 'Demo',
        createdAt: 1,
        needsImport: true,
      } satisfies SourceRow),
    addSourceFromLink: async () =>
      ok({
        id: 's2',
        kind: 'xtream',
        name: 'Link',
        createdAt: 2,
        needsImport: true,
      } satisfies SourceRow),
    removeSource: async () => ok(undefined),
    startImport: (_id: string, opts?: CatalogBridgeImportOptions) => {
      const reqId = ++nextReq;
      opts?.onProgress?.({ phase: 'live', done: 5, total: 10 });
      const summary: ImportSummary = {
        runId: 1,
        counts: {
          categories: 1,
          live: 10,
          movies: 0,
          series: 0,
          episodes: 0,
          guideChannels: 0,
          programmes: 0,
        },
        warnings: 0,
        warningCodes: [],
        durationMs: 12,
      };
      return { reqId, result: Promise.resolve(ok(summary)) };
    },
    cancelImport: (reqId: number) => {
      cancelledIds.push(reqId);
    },
    listSources: async () => [],
    categories: async () => [],
    items: async () => [],
    itemDetail: async () => null,
    search: async () => ({ live: [], epg: [], movies: [], series: [], episodes: [] }),
    seasons: async () => ok([]),
    episodes: async () => [],
    resolveStream: async () =>
      ok({ url: 'http://127.0.0.1:7879/live/demo/demo/1.ts', headers: {} }),
    saveProgress: async (input) =>
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
      }),
    setWatched: async () => ok(undefined),
    getProgress: async () => null,
    listContinueWatching: async () => [],
    listProgressByKeys: async () => [],
    clearProgress: async () => ok(undefined),
    toggleFavorite: async () => ok(true),
    setFavorite: async (_input, active) => ok(active),
    listFavorites: async () => [],
    listFavoriteKeys: async () => [],
    importGuide: async () =>
      ok({
        runId: 2,
        counts: { guideChannels: 2, programmes: 20 },
        warnings: 0,
        warningCodes: [],
        durationMs: 5,
      }),
    nowNext: async () => [],
    epgWindow: async () => ({}),
    channelByNumber: async () => null,
    queryNextEpisode: async () => null,
    onChanged: () => () => undefined,
    onDisconnected: () => () => undefined,
    close: async () => undefined,
  };

  return { bridge: { ...base, ...overrides }, cancelledIds };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop CatalogService', () => {
  it('opens singleton over window.elv.catalog, retries after a failed open, and delegates every CatalogService method', async () => {
    let shouldFailOpen = true;
    const { bridge } = makeFakeBridge({
      open: async () =>
        shouldFailOpen ? err(elvError('storage', 'schema-too-new')) : ok(undefined),
    });
    vi.stubGlobal('window', { elv: { catalog: bridge } });

    await expect(createDesktopCatalog()).rejects.toBeInstanceOf(CatalogOpenError);
    await expect(createDesktopCatalog()).rejects.toMatchObject({
      error: { category: 'storage', code: 'schema-too-new' },
    });

    // Retry succeeds after failure (failed open was not cached)
    shouldFailOpen = false;
    const c1 = await createDesktopCatalog();
    const c2 = await createDesktopCatalog();
    expect(c1).toBe(c2);

    expect(
      (await c1.addSource({ kind: 'm3u', name: 'A', playlistUrl: 'http://a.example/list.m3u' })).ok,
    ).toBe(true);
    expect((await c1.addSourceFromLink({ name: 'B', url: 'http://b.example/list.m3u' })).ok).toBe(
      true,
    );
    expect((await c1.removeSource('s1')).ok).toBe(true);
    expect(await c1.listSources()).toEqual([]);
    expect(await c1.categories('s1', 'live')).toEqual([]);
    expect(await c1.items('cat1', 0, 25)).toEqual([]);
    expect(await c1.itemDetail?.('x:s1:series:1')).toBeNull();
    expect(await c1.search?.('horizon', { scope: 'movie', limit: 10 })).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });
    expect(await c1.searchSuggestions?.({ limit: 8 })).toEqual([]);
    expect(await c1.alphabetIndex?.({ kind: 'movie' })).toEqual([]);
    expect((await c1.seasons(1)).ok).toBe(true);
    expect(await c1.episodes(1, 1)).toEqual([]);
    expect((await c1.resolveStream('x:s1:live:1')).ok).toBe(true);
    expect(
      (
        await c1.saveProgress?.({
          sourceId: 's1',
          itemKey: 'x:s1:movie:1',
          kind: 'movie',
          title: 'Film',
          positionMs: 30_000,
          durationMs: 100_000,
        })
      )?.ok,
    ).toBe(true);
    expect((await c1.setWatched?.('x:s1:movie:1', true))?.ok).toBe(true);
    expect(await c1.getProgress?.('x:s1:movie:1')).toBeNull();
    expect(await c1.listContinueWatching?.(10)).toEqual([]);
    expect(await c1.listProgressByKeys?.(['x:s1:movie:1'])).toEqual([]);
    expect((await c1.clearProgress?.('x:s1:movie:1'))?.ok).toBe(true);
    expect(
      await c1.toggleFavorite?.({
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Film',
      }),
    ).toEqual({ ok: true, value: true });
    expect(await c1.listFavorites?.(10)).toEqual([]);
    expect(await c1.listFavoriteKeys?.()).toEqual([]);
    expect((await c1.importGuide?.('s1'))?.ok).toBe(true);
    expect(await c1.nowNext?.(['x:s1:live:1'], 1_700_000_000_000)).toEqual([]);
    expect(await c1.epgWindow?.(['x:s1:live:1'], 1_700_000_000_000, 1_700_010_800_000)).toEqual({});
    expect(await c1.channelByNumber?.(101, 's1')).toBeNull();
    expect(await c1.queryNextEpisode?.('x:s1:series:1', 'x:s1:episode:1', 'default')).toBeNull();

    await c1.close();
  });

  it('rejects with CatalogOpenError when window.elv.catalog is absent', async () => {
    vi.stubGlobal('window', {});
    await expect(createDesktopCatalog()).rejects.toMatchObject({
      error: { category: 'storage', code: 'bridge-unavailable' },
    });
  });

  it('maps pre-aborted and mid-flight AbortSignal onto cancelImport and isolates throwing onProgress', async () => {
    let finishImport!: (res: Result<ImportSummary>) => void;
    const { bridge, cancelledIds } = makeFakeBridge({
      startImport: (_id, opts) => {
        opts?.onProgress?.({ phase: 'live', done: 1 });
        return {
          reqId: 77,
          result: new Promise((resolve) => {
            finishImport = resolve;
          }),
        };
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);

    // Pre-aborted signal returns network/aborted without calling startImport
    const preAborted = new AbortController();
    preAborted.abort();
    const preRes = await service.importSource('s1', { signal: preAborted.signal });
    expect(preRes).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(cancelledIds).toEqual([]);

    // Mid-flight abort forwards cancelImport(77), and throwing onProgress does not break importSource
    const ctl = new AbortController();
    const seen: ImportProgress[] = [];
    const running = service.importSource('s1', {
      signal: ctl.signal,
      batchSize: 500,
      maxBodyBytes: 1_000_000,
      onProgress: (p) => {
        seen.push(p);
        throw new Error('ui boom');
      },
    });
    expect(seen).toEqual([{ phase: 'live', done: 1 }]);

    ctl.abort();
    expect(cancelledIds).toEqual([77]);
    finishImport(err(elvError('network', 'aborted')));
    expect(await running).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
  });

  it('sanitizes control characters out of title and subtitle before sending user-state RPCs', async () => {
    const savedInputs: unknown[] = [];
    const favInputs: unknown[] = [];
    const { bridge } = makeFakeBridge({
      saveProgress: async (input) => {
        savedInputs.push(input);
        return ok({
          profileId: 'default',
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
          watched: false,
          updatedAt: 1,
        });
      },
      toggleFavorite: async (input) => {
        favInputs.push(input);
        return ok(true);
      },
      setFavorite: async (input, active) => {
        favInputs.push(input);
        return ok(active);
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);

    await service.saveProgress?.({
      sourceId: 's1',
      itemKey: 'k1',
      kind: 'episode',
      title: 'Dirty\tShow\r\nName',
      subtitle: 'S1\tE2\r',
      positionMs: 20_000,
      durationMs: 60_000,
    });
    await service.toggleFavorite?.({
      sourceId: 's1',
      itemKey: 'k1',
      kind: 'movie',
      title: 'Tab\tFilm\u0007',
    });
    await service.setFavorite?.(
      {
        sourceId: 's1',
        itemKey: 'k2',
        kind: 'movie',
        title: 'Set\tFav\r\nTitle',
      },
      true,
    );

    expect(savedInputs[0]).toMatchObject({ title: 'Dirty Show Name', subtitle: 'S1 E2' });
    expect(favInputs[0]).toMatchObject({ title: 'Tab Film' });
    expect(favInputs[1]).toMatchObject({ title: 'Set Fav Title' });
  });

  it('sanitizes control characters and >256-char queries before calling bridge.search', async () => {
    const seenQueries: string[] = [];
    const { bridge } = makeFakeBridge({
      search: async (query) => {
        seenQueries.push(query);
        return { live: [], epg: [], movies: [], series: [], episodes: [] };
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);

    await service.search?.('foo\t\nbar');
    await service.search?.(`  ${'a'.repeat(300)}  `);

    expect(seenQueries).toEqual(['foo bar', 'a'.repeat(256)]);
  });

  it('forwards searchSuggestions and alphabetIndex and falls back to [] when bridge omits them (#397, #407)', async () => {
    const suggestions = [
      { kind: 'favorite' as const, label: 'Orbital Nine', query: 'Orbital Nine' },
    ];
    const buckets = [{ letter: 'O', offset: 0, count: 1 }];
    const suggestionCalls: unknown[] = [];
    const alphabetCalls: unknown[] = [];
    const { bridge } = makeFakeBridge({
      searchSuggestions: async (options) => {
        suggestionCalls.push(options);
        return suggestions;
      },
      alphabetIndex: async (input) => {
        alphabetCalls.push(input);
        return buckets;
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);
    expect(await service.searchSuggestions?.({ limit: 6, sourceId: 's1' })).toEqual(suggestions);
    expect(await service.alphabetIndex?.({ kind: 'movie', sourceId: 's1' })).toEqual(buckets);
    expect(suggestionCalls).toEqual([{ limit: 6, sourceId: 's1' }]);
    expect(alphabetCalls).toEqual([{ kind: 'movie', sourceId: 's1' }]);

    const { bridge: legacyBridge } = makeFakeBridge();
    const legacyService = createDesktopCatalogFromBridge(legacyBridge);
    expect(await legacyService.searchSuggestions?.()).toEqual([]);
    expect(await legacyService.alphabetIndex?.({ kind: 'movie' })).toEqual([]);
  });

  it('forwards ListItemsOptions on items and allSourcesItems (#125)', async () => {
    const itemsCalls: unknown[][] = [];
    const allCalls: unknown[][] = [];
    const { bridge } = makeFakeBridge({
      items: async (...args) => {
        itemsCalls.push(args);
        return [];
      },
      allSourcesItems: async (...args) => {
        allCalls.push(args);
        return [];
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);
    const opts = { sortBy: 'alpha' as const, excludeWatched: true };

    await service.items('src-1|movie|10', 0, 18, opts);
    await service.allSourcesItems?.('movie', 0, 12, ['src-1'], opts);

    expect(itemsCalls).toEqual([['src-1|movie|10', 0, 18, opts]]);
    expect(allCalls).toEqual([['movie', 0, 12, ['src-1'], opts]]);
  });

  it('forwards listSeriesUnplayedCounts and falls back to [] when bridge omits it (#409)', async () => {
    const summary = [{ seriesKey: 'src-1|series|1', total: 4, unplayed: 2, watched: false }];
    const calls: unknown[][] = [];
    const { bridge } = makeFakeBridge({
      listSeriesUnplayedCounts: async (...args) => {
        calls.push(args);
        return summary;
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);
    expect(await service.listSeriesUnplayedCounts?.(['src-1|series|1'], 'p1')).toEqual(summary);
    expect(calls).toEqual([[['src-1|series|1'], 'p1']]);

    const { bridge: legacyBridge } = makeFakeBridge();
    const legacyService = createDesktopCatalogFromBridge(legacyBridge);
    expect(await legacyService.listSeriesUnplayedCounts?.(['src-1|series|1'])).toEqual([]);
  });

  it('forwards track_preferences methods and falls back safely when bridge omits them (#208)', async () => {
    const saved = {
      profileId: 'default',
      scopeKey: 'series:s1:10',
      sourceId: 's1',
      audioLang: 'tr',
      audioLabel: 'Turkish',
      subLang: 'en',
      subLabel: 'English',
      subDisabled: false,
      audioDelayMs: 0,
      subDelayMs: 250,
      resizeMode: 'fill' as const,
      updatedAt: 100,
    };
    const saveCalls: unknown[] = [];
    const clearCalls: unknown[][] = [];
    const { bridge } = makeFakeBridge({
      getTrackPreference: async (scopeKey) => (scopeKey === saved.scopeKey ? saved : null),
      saveTrackPreference: async (input) => {
        saveCalls.push(input);
      },
      clearTrackPreference: async (...args) => {
        clearCalls.push(args);
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);
    expect(await service.getTrackPreference?.(saved.scopeKey, 'default')).toEqual(saved);
    await service.saveTrackPreference?.({
      scopeKey: saved.scopeKey,
      sourceId: 's1',
      resizeMode: 'fill',
    });
    await service.clearTrackPreference?.(saved.scopeKey, 'default');
    expect(saveCalls).toEqual([{ scopeKey: saved.scopeKey, sourceId: 's1', resizeMode: 'fill' }]);
    expect(clearCalls).toEqual([[saved.scopeKey, 'default']]);

    const { bridge: legacyBridge } = makeFakeBridge();
    const legacyService = createDesktopCatalogFromBridge(legacyBridge);
    expect(await legacyService.getTrackPreference?.('series:s1:10')).toBeNull();
    await expect(
      legacyService.saveTrackPreference?.({ scopeKey: 'series:s1:10', sourceId: 's1' }),
    ).resolves.toBeUndefined();
    await expect(legacyService.clearTrackPreference?.('series:s1:10')).resolves.toBeUndefined();
  });

  it('forwards Wave F1 profile/parental methods, opts, epgSlice, and flushPendingWrites with safe fallbacks (#15, #31)', async () => {
    const profile = {
      id: 'p_kids',
      name: 'Kids',
      avatarToken: 'emerald' as const,
      isKids: true,
      isDefault: false,
      createdAt: 100,
      updatedAt: 100,
    };
    const settings = {
      profileId: 'p_kids',
      enabled: true,
      blockAdultKeywords: true,
      maxRatingAge: 12,
      unlockTimeoutMin: 30,
      updatedAt: 100,
    };
    const seen: Record<string, unknown[][]> = {};
    const record =
      <T>(name: string, value: T) =>
      async (...args: unknown[]): Promise<T> => {
        const list = seen[name] ?? [];
        list.push(args);
        seen[name] = list;
        return value;
      };

    const { bridge } = makeFakeBridge({
      liveVariants: record('liveVariants', []),
      itemVersions: record('itemVersions', []),
      seasons: record('seasons', ok([])),
      episodes: record('episodes', []),
      queryNextEpisode: record('queryNextEpisode', null),
      itemDetail: record('itemDetail', null),
      nowNext: record('nowNext', []),
      epgWindow: record('epgWindow', {}),
      epgSlice: record('epgSlice', []),
      channelByNumber: record('channelByNumber', null),
      resolveStream: record('resolveStream', err(elvError('auth', 'parental-locked'))),
      listContinueWatching: record('listContinueWatching', []),
      listFavorites: record('listFavorites', []),
      listRecentChannels: record('listRecentChannels', []),
      listProfiles: record('listProfiles', [profile]),
      createProfile: record('createProfile', ok(profile)),
      updateProfile: record('updateProfile', ok(profile)),
      deleteProfile: record('deleteProfile', ok(undefined)),
      getParentalSettings: record('getParentalSettings', settings),
      updateParentalSettings: record('updateParentalSettings', ok(settings)),
      listParentalLocks: record('listParentalLocks', []),
      setParentalLock: record('setParentalLock', ok(undefined)),
      hasParentalPin: record('hasParentalPin', true),
      setParentalPin: record('setParentalPin', ok(undefined)),
      verifyParentalPin: record('verifyParentalPin', { ok: true as const }),
      clearParentalPin: record('clearParentalPin', ok(undefined)),
      flushPendingWrites: record('flushPendingWrites', undefined),
    });

    const service = createDesktopCatalogFromBridge(bridge);
    const pOpts = { profileId: 'p_kids', parentalUnlocked: false };

    await service.liveVariants?.('s1:live:1', 's1|live|1', pOpts);
    await service.itemVersions?.('s1:movie:1', pOpts);
    await service.seasons(42, pOpts);
    await service.episodes(42, 1, pOpts);
    await service.queryNextEpisode?.('s1:series:42', 's1:episode:1', 'p_kids', {
      parentalUnlocked: true,
    });
    await service.itemDetail?.('s1:movie:1', pOpts);
    await service.nowNext?.(['s1:live:1'], 1_000, pOpts);
    await service.epgWindow?.(['s1:live:1'], 1_000, 2_000, pOpts);
    await service.epgSlice?.('s1', 1_000, 2_000, 50, pOpts);
    await service.channelByNumber?.(10, 's1', pOpts);
    expect(await service.resolveStream('s1:live:1', pOpts)).toEqual({
      ok: false,
      error: { category: 'auth', code: 'parental-locked' },
    });
    await service.listContinueWatching?.(10, 'p_kids', { parentalUnlocked: false });
    await service.listFavorites?.(10, 'p_kids', { parentalUnlocked: true });
    await service.listRecentChannels?.(10, 'p_kids', { parentalUnlocked: false });

    expect(await service.listProfiles?.()).toEqual([profile]);
    expect(await service.createProfile?.({ name: 'Kids\tOne', isKids: true })).toEqual(ok(profile));
    expect(await service.updateProfile?.('p_kids', { name: 'Kids\nTwo' })).toEqual(ok(profile));
    expect(await service.deleteProfile?.('p_kids')).toEqual(ok(undefined));
    expect(await service.getParentalSettings?.('p_kids')).toEqual(settings);
    expect(await service.updateParentalSettings?.({ enabled: false }, 'p_kids')).toEqual(
      ok(settings),
    );
    expect(await service.listParentalLocks?.('p_kids', { sourceId: 's1' })).toEqual([]);
    expect(
      await service.setParentalLock?.(
        {
          profileId: 'p_kids',
          sourceId: 's1',
          targetKind: 'item',
          itemKind: 'movie',
          targetKey: 's1:movie:1',
        },
        true,
      ),
    ).toEqual(ok(undefined));
    expect(await service.hasParentalPin?.('p_kids')).toBe(true);
    expect(await service.setParentalPin?.('1234', 'p_kids', '0000')).toEqual(ok(undefined));
    expect(await service.verifyParentalPin?.('1234', 'p_kids')).toEqual({ ok: true });
    expect(await service.clearParentalPin?.('1234', 'p_kids')).toEqual(ok(undefined));
    await service.flushPendingWrites?.();

    expect(seen['liveVariants']).toEqual([['s1:live:1', 's1|live|1', pOpts]]);
    expect(seen['itemVersions']).toEqual([['s1:movie:1', pOpts]]);
    expect(seen['seasons']).toEqual([[42, pOpts]]);
    expect(seen['episodes']).toEqual([[42, 1, pOpts]]);
    expect(seen['queryNextEpisode']).toEqual([
      ['s1:series:42', 's1:episode:1', 'p_kids', { parentalUnlocked: true }],
    ]);
    expect(seen['itemDetail']).toEqual([['s1:movie:1', pOpts]]);
    expect(seen['nowNext']).toEqual([[['s1:live:1'], 1_000, pOpts]]);
    expect(seen['epgWindow']).toEqual([[['s1:live:1'], 1_000, 2_000, pOpts]]);
    expect(seen['epgSlice']).toEqual([['s1', 1_000, 2_000, 50, pOpts]]);
    expect(seen['channelByNumber']).toEqual([[10, 's1', pOpts]]);
    expect(seen['resolveStream']).toEqual([['s1:live:1', pOpts]]);
    expect(seen['listContinueWatching']).toEqual([[10, 'p_kids', { parentalUnlocked: false }]]);
    expect(seen['listFavorites']).toEqual([[10, 'p_kids', { parentalUnlocked: true }]]);
    expect(seen['listRecentChannels']).toEqual([[10, 'p_kids', { parentalUnlocked: false }]]);
    expect(seen['createProfile']).toEqual([[{ name: 'Kids One', isKids: true }]]);
    expect(seen['updateProfile']).toEqual([['p_kids', { name: 'Kids Two' }]]);

    // Legacy bridge without optional Wave F1 methods falls back safely
    const { bridge: legacyBridge } = makeFakeBridge();
    const legacy = createDesktopCatalogFromBridge(legacyBridge);
    expect(await legacy.listProfiles?.()).toEqual([]);
    expect((await legacy.createProfile?.({ name: 'X' }))?.ok).toBe(false);
    expect((await legacy.deleteProfile?.('p_kids'))?.ok).toBe(false);
    expect((await legacy.getParentalSettings?.('p_kids'))?.enabled).toBe(false);
    expect(await legacy.listParentalLocks?.('p_kids')).toEqual([]);
    expect(await legacy.hasParentalPin?.('p_kids')).toBe(false);
    expect(await legacy.verifyParentalPin?.('1234', 'p_kids')).toEqual({
      ok: false,
      remainingAttempts: 0,
    });
    expect(await legacy.epgSlice?.('s1', 0, 1000)).toEqual([]);
    await expect(legacy.flushPendingWrites?.()).resolves.toBeUndefined();
  });
});
