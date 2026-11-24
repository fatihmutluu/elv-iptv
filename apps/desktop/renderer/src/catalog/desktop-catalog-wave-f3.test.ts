import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './desktop-catalog.ts';

function minimalBridge(overrides: Partial<CatalogBridge> = {}): CatalogBridge {
  return {
    open: vi.fn(async () => ok(undefined)),
    addSource: vi.fn(),
    addSourceFromLink: vi.fn(),
    removeSource: vi.fn(),
    startImport: vi.fn(),
    cancelImport: vi.fn(),
    importGuide: vi.fn(),
    listSources: vi.fn(async () => []),
    categories: vi.fn(async () => []),
    items: vi.fn(async () => []),
    itemDetail: vi.fn(async () => null),
    search: vi.fn(),
    nowNext: vi.fn(async () => []),
    epgWindow: vi.fn(async () => ({})),
    channelByNumber: vi.fn(async () => null),
    seasons: vi.fn(),
    episodes: vi.fn(async () => []),
    queryNextEpisode: vi.fn(async () => null),
    resolveStream: vi.fn(),
    saveProgress: vi.fn(),
    setWatched: vi.fn(),
    getProgress: vi.fn(async () => null),
    listContinueWatching: vi.fn(async () => []),
    listProgressByKeys: vi.fn(async () => []),
    clearProgress: vi.fn(),
    toggleFavorite: vi.fn(),
    setFavorite: vi.fn(),
    listFavorites: vi.fn(async () => []),
    listFavoriteKeys: vi.fn(async () => []),
    onChanged: vi.fn(() => () => undefined),
    onDisconnected: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createDesktopCatalogFromBridge Wave F3 EPG ops (#220, #306, #30, #35)', () => {
  it('forwards all 16 Wave F3 methods and sanitizes display text inputs', async () => {
    const resolveCatchupStream = vi.fn(async () =>
      ok({ url: 'http://sim.test/catchup.m3u8', headers: {} }),
    );
    const fetchChannelArchiveEpg = vi.fn(async () => ok([]));
    const listGuideSources = vi.fn(async () => []);
    const addGuideSource = vi.fn(async () =>
      ok({
        id: 'gs_1',
        sourceId: 's1',
        priority: 0,
        name: 'Primary Guide',
        urlTemplate: '{{g:gs_1}}',
        epgShiftMs: 0,
        enabled: true,
        lastSyncAt: null,
      }),
    );
    const updateGuideSource = vi.fn(async () =>
      ok({
        id: 'gs_1',
        sourceId: 's1',
        priority: 1,
        name: 'Renamed',
        urlTemplate: '{{g:gs_1}}',
        epgShiftMs: 0,
        enabled: true,
        lastSyncAt: null,
      }),
    );
    const removeGuideSource = vi.fn(async () => ok(undefined));
    const reorderGuideSources = vi.fn(async () => ok(undefined));
    const listGuideChannels = vi.fn(async () => []);
    const listChannelGuideOverrides = vi.fn(async () => []);
    const setChannelGuideOverride = vi.fn(async () =>
      ok({
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        guideSourceId: 'gs_1',
        guideId: 'news.1',
        epgShiftMs: 0,
        isManual: true,
        updatedAt: 1,
      }),
    );
    const clearChannelGuideOverride = vi.fn(async () => ok(undefined));
    const listReminders = vi.fn(async () => []);
    const upsertReminder = vi.fn(async () =>
      ok({
        profileId: 'default',
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News One',
        programmeTitle: 'Evening News',
        programmeStart: 1000,
        programmeStop: 2000,
        leadTimeMs: 300_000,
        fired: false,
        createdAt: 500,
      }),
    );
    const removeReminder = vi.fn(async () => ok(undefined));
    const markReminderFired = vi.fn(async () => ok(undefined));
    const pruneExpiredReminders = vi.fn(async () => 2);

    const catalog = createDesktopCatalogFromBridge(
      minimalBridge({
        resolveCatchupStream,
        fetchChannelArchiveEpg,
        listGuideSources,
        addGuideSource,
        updateGuideSource,
        removeGuideSource,
        reorderGuideSources,
        listGuideChannels,
        listChannelGuideOverrides,
        setChannelGuideOverride,
        clearChannelGuideOverride,
        listReminders,
        upsertReminder,
        removeReminder,
        markReminderFired,
        pruneExpiredReminders,
      }),
    );

    await catalog.resolveCatchupStream?.('m:s1:ch1', { startMs: 1000, stopMs: 2000 });
    await catalog.fetchChannelArchiveEpg?.('m:s1:ch1');
    await catalog.listGuideSources?.('s1');
    await catalog.addGuideSource?.({
      sourceId: 's1',
      name: 'Primary\nGuide',
      url: 'https://epg.test/a.xml',
    });
    await catalog.updateGuideSource?.('gs_1', { name: 'Renamed\tGuide' });
    await catalog.removeGuideSource?.('gs_1');
    await catalog.reorderGuideSources?.('s1', ['gs_1']);
    await catalog.listGuideChannels?.('s1', 'News\nHD', 20);
    await catalog.listChannelGuideOverrides?.('s1');
    await catalog.setChannelGuideOverride?.({
      sourceId: 's1',
      channelKey: 'm:s1:ch1',
      guideId: 'news.1',
    });
    await catalog.clearChannelGuideOverride?.('s1', 'm:s1:ch1');
    await catalog.listReminders?.('default', { includeFired: false });
    await catalog.upsertReminder?.({
      sourceId: 's1',
      channelKey: 'm:s1:ch1',
      channelName: 'News\rOne',
      programmeTitle: 'Evening\nNews',
      programmeStart: 1000,
      programmeStop: 2000,
    });
    await catalog.removeReminder?.('m:s1:ch1', 1000, 'default');
    await catalog.markReminderFired?.('m:s1:ch1', 1000, 'default');
    expect(await catalog.pruneExpiredReminders?.(3000)).toBe(2);

    expect(addGuideSource).toHaveBeenCalledWith({
      sourceId: 's1',
      name: 'Primary Guide',
      url: 'https://epg.test/a.xml',
    });
    expect(updateGuideSource).toHaveBeenCalledWith('gs_1', { name: 'Renamed Guide' });
    expect(listGuideChannels).toHaveBeenCalledWith('s1', 'News HD', 20);
    expect(upsertReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: 'News One',
        programmeTitle: 'Evening News',
      }),
    );
    expect(resolveCatchupStream).toHaveBeenCalledTimes(1);
    expect(fetchChannelArchiveEpg).toHaveBeenCalledTimes(1);
    expect(listGuideSources).toHaveBeenCalledTimes(1);
    expect(removeGuideSource).toHaveBeenCalledTimes(1);
    expect(reorderGuideSources).toHaveBeenCalledTimes(1);
    expect(listChannelGuideOverrides).toHaveBeenCalledTimes(1);
    expect(setChannelGuideOverride).toHaveBeenCalledTimes(1);
    expect(clearChannelGuideOverride).toHaveBeenCalledTimes(1);
    expect(listReminders).toHaveBeenCalledTimes(1);
    expect(removeReminder).toHaveBeenCalledTimes(1);
    expect(markReminderFired).toHaveBeenCalledTimes(1);
    expect(pruneExpiredReminders).toHaveBeenCalledWith(3000);
  });

  it('truncates >256-char reminder and catch-up titles safely before sending over IPC', async () => {
    const resolveCatchupStream = vi.fn<NonNullable<CatalogBridge['resolveCatchupStream']>>(
      async () => ok({ url: 'http://sim.test/catchup.m3u8', headers: {} }),
    );
    const upsertReminder = vi.fn<NonNullable<CatalogBridge['upsertReminder']>>(async () =>
      ok({
        profileId: 'default',
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'A'.repeat(256),
        programmeTitle: 'B'.repeat(256),
        programmeStart: 1000,
        programmeStop: 2000,
        leadTimeMs: 300_000,
        fired: false,
        createdAt: 500,
      }),
    );

    const catalog = createDesktopCatalogFromBridge(
      minimalBridge({ resolveCatchupStream, upsertReminder }),
    );

    const longChannel = `  ${'C'.repeat(300)}\nHD  `;
    const longTitle = `${'P'.repeat(255)}🎬Extra`;
    await catalog.upsertReminder?.({
      sourceId: 's1',
      channelKey: 'm:s1:ch1',
      channelName: longChannel,
      programmeTitle: longTitle,
      programmeStart: 1000,
      programmeStop: 2000,
      parentalUnlocked: false,
    });

    const sentReminder = upsertReminder.mock.calls[0]?.[0];
    expect(sentReminder?.channelName).toBe('C'.repeat(256));
    expect(sentReminder?.programmeTitle).toBe('P'.repeat(255));
    expect(sentReminder?.programmeTitle.length).toBeLessThanOrEqual(256);
    expect(sentReminder?.parentalUnlocked).toBe(false);

    await catalog.resolveCatchupStream?.(
      'm:s1:ch1',
      { startMs: 1000, stopMs: 2000, title: `  ${'T'.repeat(300)}\r\nLive  ` },
      { profileId: 'default', parentalUnlocked: false },
    );
    const sentCatchup = resolveCatchupStream.mock.calls[0]?.[1];
    expect(sentCatchup?.title).toBe('T'.repeat(256));
  });

  it('degrades cleanly when optional Wave F3 bridge methods are absent', async () => {
    const catalog = createDesktopCatalogFromBridge(minimalBridge());
    expect((await catalog.resolveCatchupStream?.('k', { startMs: 1, stopMs: 2 }))?.ok).toBe(false);
    expect((await catalog.fetchChannelArchiveEpg?.('k'))?.ok).toBe(false);
    expect(await catalog.listGuideSources?.('s1')).toEqual([]);
    expect(await catalog.listGuideChannels?.('s1')).toEqual([]);
    expect(await catalog.listChannelGuideOverrides?.('s1')).toEqual([]);
    expect(await catalog.listReminders?.()).toEqual([]);
    expect(await catalog.pruneExpiredReminders?.()).toBe(0);
  });
});
