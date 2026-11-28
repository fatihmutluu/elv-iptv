import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createProfileScopedCatalog, type ProfileCatalogScope } from './profile-scoped-catalog';

function createSpyCatalog() {
  return {
    addSource: vi.fn(),
    addSourceFromLink: vi.fn(),
    removeSource: vi.fn(),
    importSource: vi.fn(),
    listSources: vi.fn(async () => [
      { id: 's1', kind: 'm3u' as const, name: 'Demo', createdAt: 1, needsImport: false },
    ]),
    categories: vi.fn(async () => [{ id: 's1|live|1', name: 'General', count: 5 }]),
    items: vi.fn(async () => [{ key: 'm:s1:live:1', sourceId: 's1', name: 'Ch 1' }]),
    allSourcesItems: vi.fn(async () => [{ key: 'm:s1:live:1', sourceId: 's1', name: 'Ch 1' }]),
    itemDetail: vi.fn(async () => ({ id: 1, key: 'm:s1:live:1', sourceId: 's1', name: 'Ch 1' })),
    search: vi.fn(async () => ({
      live: [{ key: 'm:s1:live:1', sourceId: 's1', name: 'Ch 1' }],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    })),
    searchSuggestions: vi.fn(async () => [{ kind: 'recent', label: 'Ch 1', sourceId: 's1' }]),
    alphabetIndex: vi.fn(async () => [{ letter: 'C', offset: 0, count: 1 }]),
    nowNext: vi.fn(async () => [{ channelKey: 'm:s1:live:1', now: null, next: null }]),
    epgWindow: vi.fn(async () => ({ 'm:s1:live:1': [] })),
    epgSlice: vi.fn(async () => [{ channelKey: 'm:s1:live:1' }]),
    channelByNumber: vi.fn(async () => ({ key: 'm:s1:live:1', sourceId: 's1', name: 'Ch 1' })),
    seasons: vi.fn(async () => ok([{ season: 1, count: 2 }])),
    episodes: vi.fn(async () => [{ key: 'm:s1:ep:1', season: 1, episode: 1 }]),
    queryNextEpisode: vi.fn(async () => ({ key: 'm:s1:ep:2' })),
    resolveStream: vi.fn(async () => ok({ url: 'http://127.0.0.1/live.ts', headers: {} })),
    resolveCatchupStream: vi.fn(async () =>
      ok({ url: 'http://127.0.0.1/catchup.ts', headers: {} }),
    ),
    fetchChannelArchiveEpg: vi.fn(async () => ok([])),
    listContinueWatching: vi.fn(async () => [{ itemKey: 'm:s1:movie:1', sourceId: 's1' }]),
    listWatched: vi.fn(async () => [{ itemKey: 'm:s1:movie:1', sourceId: 's1' }]),
    listFavorites: vi.fn(async () => [{ itemKey: 'm:s1:live:1', sourceId: 's1' }]),
    listFavoriteKeys: vi.fn(async () => ['m:s1:live:1']),
    listMyListNewEpisodes: vi.fn(async () => [{ itemKey: 'm:s1:ep:1', sourceId: 's1' }]),
    listRecentChannels: vi.fn(async () => [{ key: 'm:s1:live:1', sourceId: 's1' }]),
    listReminders: vi.fn(async () => [{ channelKey: 'm:s1:live:1', sourceId: 's1' }]),
    listCollections: vi.fn(async () => [{ id: 'c1', name: 'Favs', itemCount: 1 }]),
    listCollectionItems: vi.fn(async () => [{ key: 'm:s1:movie:1', sourceId: 's1' }]),
    listRatings: vi.fn(async () => [{ itemKey: 'm:s1:movie:1', value: 'like' }]),
    listRatingMap: vi.fn(async () => ({ 'm:s1:movie:1': 'like' })),
    listDownloads: vi.fn(async () => [
      { id: 'd1', profileId: 'default', sourceId: 's1', itemKey: 'm:s1:movie:1', title: 'Safe' },
      { id: 'd2', profileId: 'default', sourceId: 's2', itemKey: 'm:s2:movie:2', title: 'Adult' },
    ]),
    getDownload: vi.fn(async (itemKey: string) =>
      itemKey === 'm:s2:movie:2'
        ? { id: 'd2', profileId: 'default', sourceId: 's2', itemKey, title: 'Adult' }
        : { id: 'd1', profileId: 'default', sourceId: 's1', itemKey, title: 'Safe' },
    ),
    close: vi.fn(async () => undefined),
  };
}

describe('createProfileScopedCatalog fail-closed withholding (Wave Q5-A)', () => {
  it('withholds all catalog reads and blocks stream resolution when parentalLoadError is true, even with parentalUnlocked override', async () => {
    const base = createSpyCatalog();
    let scope: ProfileCatalogScope = {
      profileId: 'default',
      parentalUnlocked: true,
      parentalLoadError: true,
    };
    const scoped = createProfileScopedCatalog(base as unknown as CatalogService, () => scope);

    expect(await scoped.categories('s1', 'live', { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.items('s1|live|1', 0, 20, { parentalUnlocked: true })).toEqual([]);
    expect(
      await scoped.allSourcesItems?.('live', 0, 20, ['s1'], { parentalUnlocked: true }),
    ).toEqual([]);
    expect(await scoped.itemDetail?.('m:s1:live:1', { parentalUnlocked: true })).toBeNull();
    expect(await scoped.search?.('ch', { parentalUnlocked: true })).toEqual({
      live: [],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    });
    expect(await scoped.searchSuggestions?.({ parentalUnlocked: true })).toEqual([]);
    expect(await scoped.alphabetIndex?.({ kind: 'live', parentalUnlocked: true })).toEqual([]);
    expect(await scoped.nowNext?.(['m:s1:live:1'], 1000, { parentalUnlocked: true })).toEqual([]);
    expect(
      await scoped.epgWindow?.(['m:s1:live:1'], 1000, 2000, { parentalUnlocked: true }),
    ).toEqual({});
    expect(await scoped.epgSlice?.('s1', 1000, 2000, 10, { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.channelByNumber?.(1, 's1', { parentalUnlocked: true })).toBeNull();
    expect(await scoped.seasons(1, { parentalUnlocked: true })).toEqual(ok([]));
    expect(await scoped.episodes(1, 1, { parentalUnlocked: true })).toEqual([]);
    expect(
      await scoped.queryNextEpisode?.('m:s1:series:1', 'm:s1:ep:1', undefined, {
        parentalUnlocked: true,
      }),
    ).toBeNull();

    const streamRes = await scoped.resolveStream('m:s1:live:1', { parentalUnlocked: true });
    expect(streamRes.ok).toBe(false);
    if (!streamRes.ok) {
      expect(streamRes.error.category).toBe('auth');
      expect(streamRes.error.code).toBe('parental-locked');
    }

    const catchupRes = await scoped.resolveCatchupStream?.(
      'm:s1:live:1',
      { startMs: 1000, stopMs: 2000, title: 'Show' },
      { parentalUnlocked: true },
    );
    expect(catchupRes?.ok).toBe(false);
    if (catchupRes && !catchupRes.ok) {
      expect(catchupRes.error.code).toBe('parental-locked');
    }

    expect(await scoped.listContinueWatching?.(10, undefined, { parentalUnlocked: true })).toEqual(
      [],
    );
    expect(await scoped.listWatched?.(10, undefined, { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.listFavorites?.(10, undefined, { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.listFavoriteKeys?.()).toEqual([]);
    expect(await scoped.listMyListNewEpisodes?.(10, undefined, { parentalUnlocked: true })).toEqual(
      [],
    );
    expect(await scoped.listRecentChannels?.(10, undefined, { parentalUnlocked: true })).toEqual(
      [],
    );
    expect(await scoped.listReminders?.(undefined, { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.listCollections?.(undefined, { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.listCollectionItems?.('c1', { parentalUnlocked: true })).toEqual([]);
    expect(await scoped.listRatings?.({ parentalUnlocked: true })).toEqual([]);
    expect(await scoped.listRatingMap?.()).toEqual({});
    expect(await scoped.listDownloads?.()).toEqual([]);
    expect(await scoped.getDownload?.('m:s1:movie:1')).toBeNull();

    // Underlying catalog methods must NOT have been called while fail-closed
    expect(base.categories).not.toHaveBeenCalled();
    expect(base.items).not.toHaveBeenCalled();
    expect(base.resolveStream).not.toHaveBeenCalled();
    expect(base.resolveCatchupStream).not.toHaveBeenCalled();
    expect(base.listFavorites).not.toHaveBeenCalled();
    expect(base.listDownloads).not.toHaveBeenCalled();
    expect(base.getDownload).not.toHaveBeenCalled();

    // Once parentalLoadError clears, queries resume normally and filter excluded sources on downloads
    scope = {
      profileId: 'default',
      parentalUnlocked: false,
      parentalLoadError: false,
      excludedSourceIds: new Set(['s2']),
    };
    expect(await scoped.categories('s1', 'live')).toHaveLength(1);
    const recoveredStream = await scoped.resolveStream('m:s1:live:1');
    expect(recoveredStream.ok).toBe(true);
    const downloads = await scoped.listDownloads?.();
    expect(downloads?.map((d) => d.sourceId)).toEqual(['s1']);
    expect(await scoped.getDownload?.('m:s2:movie:2')).toBeNull();
    expect(await scoped.getDownload?.('m:s1:movie:1')).not.toBeNull();
  });

  it('propagates listSources failure (fails closed) instead of falling open to empty excluded set', async () => {
    const base = createSpyCatalog();
    base.listSources.mockRejectedValue(new Error('sqlite unavailable'));
    const scope: ProfileCatalogScope = {
      profileId: 'kids-1',
      parentalUnlocked: false,
      parentalLoadError: false,
    };
    const scoped = createProfileScopedCatalog(base as unknown as CatalogService, () => scope);

    await expect(scoped.items('s1|live|1', 0, 20)).rejects.toThrow('sqlite unavailable');
    await expect(scoped.resolveStream('m:s1:live:1')).rejects.toThrow('sqlite unavailable');
    await expect(scoped.listDownloads?.()).rejects.toThrow('sqlite unavailable');
  });
});
