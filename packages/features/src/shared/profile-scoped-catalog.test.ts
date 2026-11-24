import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createProfileScopedCatalog } from './profile-scoped-catalog';

describe('createProfileScopedCatalog', () => {
  it('injects active profileId and parentalUnlocked across reads, writes, and stream resolution while preserving explicit overrides', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const base = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          const bytes = new TextEncoder().encode(
            '#EXTM3U\n#EXTINF:-1 group-title="General",Safe TV\nhttp://127.0.0.1/1.ts\n#EXTINF:-1 group-title="18+ Adult",Adult TV\nhttp://127.0.0.1/2.ts\n',
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
      clock: () => 5_000,
    });

    const added = await base.addSourceFromLink({ name: 'Demo', url: 'http://127.0.0.1/demo.m3u' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await base.importSource(added.value.id);

    const kids = await base.createProfile?.({ name: 'Kids', isKids: true, avatarToken: 'emerald' });
    expect(kids?.ok).toBe(true);
    if (!kids?.ok) return;
    const kidsId = kids.value.id;

    let scope = { profileId: kidsId, parentalUnlocked: false };
    const scoped = createProfileScopedCatalog(base, () => scope);

    // Locked Kids profile hides adult category and blocks adult stream
    const lockedCats = await scoped.categories(added.value.id, 'live');
    expect(lockedCats.map((c) => c.name)).toEqual(['General']);

    // Explicit parentalUnlocked: true override (e.g. Settings Category Locks) sees all categories
    const allCats = await scoped.categories(added.value.id, 'live', {
      includeHidden: true,
      parentalUnlocked: true,
    });
    expect(allCats.map((c) => c.name).sort()).toEqual(['18+ Adult', 'General']);

    const adultCat = allCats.find((c) => c.name === '18+ Adult');
    const adultItems = await scoped.items(adultCat?.id ?? '', 0, 10, { parentalUnlocked: true });
    const adultKey = adultItems[0]?.key ?? '';

    const blocked = await scoped.resolveStream(adultKey);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.category).toBe('auth');
      expect(blocked.error.code).toBe('parental-locked');
    }

    // Unlocking scope permits playback immediately
    scope = { profileId: kidsId, parentalUnlocked: true };
    const allowed = await scoped.resolveStream(adultKey);
    expect(allowed.ok).toBe(true);

    // Favorites written through scoped catalog stay isolated to active profile
    const safeCat = lockedCats[0];
    const safeItems = await scoped.items(safeCat?.id ?? '', 0, 10);
    const safeKey = safeItems[0]?.key ?? '';
    await scoped.setFavorite?.(
      { sourceId: added.value.id, itemKey: safeKey, kind: 'live', title: 'Safe TV' },
      true,
    );
    expect(await scoped.listFavoriteKeys?.()).toEqual([safeKey]);

    scope = { profileId: 'default', parentalUnlocked: false };
    expect(await scoped.listFavoriteKeys?.()).toEqual([]);

    await scoped.close();
    handle.close();
  });

  it('forwards profileId and parentalUnlocked through profile-scoped catalog for liveVariants, itemVersions, seasons, episodes, and queryNextEpisode', async () => {
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

    let scope = { profileId: 'kids-1', parentalUnlocked: false };
    const scoped = createProfileScopedCatalog(base, () => scope);

    await scoped.liveVariants?.('ch:1', 'cat:1');
    await scoped.itemVersions?.('mov:1');
    await scoped.seasons(42);
    await scoped.episodes(42, 1);
    await scoped.queryNextEpisode?.('ser:42', 'ep:1');

    expect(liveVariants).toHaveBeenLastCalledWith('ch:1', 'cat:1', {
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(itemVersions).toHaveBeenLastCalledWith('mov:1', {
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(seasons).toHaveBeenLastCalledWith(42, {
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(episodes).toHaveBeenLastCalledWith(42, 1, {
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(queryNextEpisode).toHaveBeenLastCalledWith('ser:42', 'ep:1', 'kids-1', {
      parentalUnlocked: false,
    });

    // Unlocked scope & explicit override are preserved
    scope = { profileId: 'kids-1', parentalUnlocked: true };
    await scoped.seasons(42, { profileId: 'custom', parentalUnlocked: false });
    expect(seasons).toHaveBeenLastCalledWith(42, {
      profileId: 'custom',
      parentalUnlocked: false,
    });
    await scoped.queryNextEpisode?.('ser:42', 'ep:1', undefined, { parentalUnlocked: false });
    expect(queryNextEpisode).toHaveBeenLastCalledWith('ser:42', 'ep:1', 'kids-1', {
      parentalUnlocked: false,
    });
  });

  it('injects profileId and parentalUnlocked across all 11 channel override and custom group methods (#60)', async () => {
    const listChannelOverrides = vi.fn(async () => []);
    const setChannelOverride = vi.fn(async () =>
      ok({
        profileId: 'kids-1',
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        customName: 'News',
        isHidden: false,
        sortOrder: null,
        updatedAt: 1,
      }),
    );
    const clearChannelOverride = vi.fn(async () => ok(undefined));
    const reorderChannels = vi.fn(async () => ok(undefined));
    const listCustomGroups = vi.fn(async () => []);
    const createCustomGroup = vi.fn(async () =>
      ok({
        id: 'g1',
        profileId: 'kids-1',
        name: 'Kids Favs',
        sortOrder: 0,
        isHidden: false,
        itemCount: 0,
        updatedAt: 1,
      }),
    );
    const updateCustomGroup = vi.fn(async () =>
      ok({
        id: 'g1',
        profileId: 'kids-1',
        name: 'Kids Top',
        sortOrder: 0,
        isHidden: false,
        itemCount: 0,
        updatedAt: 2,
      }),
    );
    const deleteCustomGroup = vi.fn(async () => ok(undefined));
    const setCustomGroupItems = vi.fn(async () => ok(undefined));
    const addChannelToCustomGroup = vi.fn(async () => ok(undefined));
    const removeChannelFromCustomGroup = vi.fn(async () => ok(undefined));

    const base = {
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
      listChannelOverrides,
      setChannelOverride,
      clearChannelOverride,
      reorderChannels,
      listCustomGroups,
      createCustomGroup,
      updateCustomGroup,
      deleteCustomGroup,
      setCustomGroupItems,
      addChannelToCustomGroup,
      removeChannelFromCustomGroup,
    } as unknown as CatalogService;

    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'kids-1',
      parentalUnlocked: false,
    }));

    await scoped.listChannelOverrides?.();
    await scoped.setChannelOverride?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      customName: 'News',
    });
    await scoped.clearChannelOverride?.('x:s1:live:1');
    await scoped.reorderChannels?.(['x:s1:live:1'], 's1');
    await scoped.listCustomGroups?.(undefined, { includeHidden: true });
    await scoped.createCustomGroup?.({ name: 'Kids Favs' });
    await scoped.updateCustomGroup?.('g1', { name: 'Kids Top' });
    await scoped.setCustomGroupItems?.('g1', [{ itemKey: 'x:s1:live:1', sourceId: 's1' }]);
    await scoped.addChannelToCustomGroup?.('g1', 'x:s1:live:1', 's1');
    await scoped.removeChannelFromCustomGroup?.('g1', 'x:s1:live:1');
    await scoped.deleteCustomGroup?.('g1');

    expect(listChannelOverrides).toHaveBeenCalledWith('kids-1');
    expect(setChannelOverride).toHaveBeenCalledWith({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      customName: 'News',
      profileId: 'kids-1',
    });
    expect(clearChannelOverride).toHaveBeenCalledWith('x:s1:live:1', 'kids-1');
    expect(reorderChannels).toHaveBeenCalledWith(['x:s1:live:1'], 's1', 'kids-1');
    expect(listCustomGroups).toHaveBeenCalledWith('kids-1', {
      includeHidden: true,
      parentalUnlocked: false,
    });
    expect(createCustomGroup).toHaveBeenCalledWith({
      name: 'Kids Favs',
      profileId: 'kids-1',
    });
    expect(updateCustomGroup).toHaveBeenCalledWith('g1', { name: 'Kids Top' });
    expect(setCustomGroupItems).toHaveBeenCalledWith('g1', [
      { itemKey: 'x:s1:live:1', sourceId: 's1' },
    ]);
    expect(addChannelToCustomGroup).toHaveBeenCalledWith('g1', 'x:s1:live:1', 's1');
    expect(removeChannelFromCustomGroup).toHaveBeenCalledWith('g1', 'x:s1:live:1');
    expect(deleteCustomGroup).toHaveBeenCalledWith('g1');
  });

  it('preserves opts.includeHidden and explicit parentalUnlocked: false in listFavorites and listContinueWatching', async () => {
    const listFavorites = vi.fn(async () => []);
    const listContinueWatching = vi.fn(async () => []);
    const base = {
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
      listFavorites,
      listContinueWatching,
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'adult-1',
      parentalUnlocked: true,
    }));

    await scoped.listFavorites?.(20, undefined, {
      includeHidden: true,
      parentalUnlocked: false,
    });
    expect(listFavorites).toHaveBeenLastCalledWith(20, 'adult-1', {
      includeHidden: true,
      parentalUnlocked: false,
    });

    await scoped.listContinueWatching?.(20, undefined, { parentalUnlocked: false });
    expect(listContinueWatching).toHaveBeenLastCalledWith(20, 'adult-1', {
      parentalUnlocked: false,
    });
  });

  it('injects profileId and parentalUnlocked across Wave F3 catch-up, archive EPG, guide ops, and reminders (#220, #306, #30, #35)', async () => {
    const resolveCatchupStream = vi.fn(async () =>
      ok({ url: 'http://127.0.0.1/c.ts', headers: {} }),
    );
    const fetchChannelArchiveEpg = vi.fn(async () => ok([]));
    const listGuideSources = vi.fn(async () => []);
    const addGuideSource = vi.fn(async () =>
      ok({
        id: 'g1',
        sourceId: 's1',
        priority: 0,
        name: 'Primary',
        urlTemplate: '{{g:g1}}',
        epgShiftMs: 0,
        enabled: true,
        lastSyncAt: null,
      }),
    );
    const updateGuideSource = vi.fn(async () =>
      ok({
        id: 'g1',
        sourceId: 's1',
        priority: 0,
        name: 'Primary',
        urlTemplate: '{{g:g1}}',
        epgShiftMs: 3_600_000,
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
        channelKey: 'm:s1:live:1',
        guideSourceId: null,
        guideId: 'bbc.uk',
        epgShiftMs: 0,
        isManual: true,
        updatedAt: 1,
      }),
    );
    const clearChannelGuideOverride = vi.fn(async () => ok(undefined));
    const listReminders = vi.fn(async () => []);
    const upsertReminder = vi.fn(async () =>
      ok({
        profileId: 'kids-1',
        sourceId: 's1',
        channelKey: 'm:s1:live:1',
        channelName: 'News',
        programmeTitle: 'Evening News',
        programmeStart: 10_000,
        programmeStop: 20_000,
        leadTimeMs: 300_000,
        fired: false,
        createdAt: 1,
      }),
    );
    const removeReminder = vi.fn(async () => ok(undefined));
    const markReminderFired = vi.fn(async () => ok(undefined));
    const pruneExpiredReminders = vi.fn(async () => 2);

    const base = {
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
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'kids-1',
      parentalUnlocked: false,
    }));

    await scoped.resolveCatchupStream?.('m:s1:live:1', {
      startMs: 1_000,
      stopMs: 2_000,
      title: 'Late Night Show',
    });
    await scoped.fetchChannelArchiveEpg?.('m:s1:live:1');
    await scoped.listGuideSources?.('s1');
    await scoped.addGuideSource?.({
      sourceId: 's1',
      name: 'Primary',
      url: 'http://example.invalid/epg.xml',
    });
    await scoped.updateGuideSource?.('g1', { epgShiftMs: 3_600_000 });
    await scoped.reorderGuideSources?.('s1', ['g1']);
    await scoped.removeGuideSource?.('g1');
    await scoped.listGuideChannels?.('s1', 'bbc', 20);
    await scoped.listChannelGuideOverrides?.('s1');
    await scoped.setChannelGuideOverride?.({
      sourceId: 's1',
      channelKey: 'm:s1:live:1',
      guideId: 'bbc.uk',
    });
    await scoped.clearChannelGuideOverride?.('s1', 'm:s1:live:1');
    await scoped.listReminders?.(undefined, { includeFired: false });
    await scoped.upsertReminder?.({
      sourceId: 's1',
      channelKey: 'm:s1:live:1',
      channelName: 'News',
      programmeTitle: 'Evening News',
      programmeStart: 10_000,
      programmeStop: 20_000,
    });
    await scoped.removeReminder?.('m:s1:live:1', 10_000);
    await scoped.markReminderFired?.('m:s1:live:1', 10_000);
    expect(await scoped.pruneExpiredReminders?.(99_000)).toBe(2);

    expect(resolveCatchupStream).toHaveBeenCalledWith(
      'm:s1:live:1',
      { startMs: 1_000, stopMs: 2_000, title: 'Late Night Show' },
      { profileId: 'kids-1', parentalUnlocked: false },
    );
    expect(fetchChannelArchiveEpg).toHaveBeenCalledWith('m:s1:live:1', {
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(listGuideSources).toHaveBeenCalledWith('s1');
    expect(addGuideSource).toHaveBeenCalled();
    expect(updateGuideSource).toHaveBeenCalledWith('g1', { epgShiftMs: 3_600_000 });
    expect(reorderGuideSources).toHaveBeenCalledWith('s1', ['g1']);
    expect(removeGuideSource).toHaveBeenCalledWith('g1');
    expect(listGuideChannels).toHaveBeenCalledWith('s1', 'bbc', 20);
    expect(listChannelGuideOverrides).toHaveBeenCalledWith('s1');
    expect(setChannelGuideOverride).toHaveBeenCalledWith({
      sourceId: 's1',
      channelKey: 'm:s1:live:1',
      guideId: 'bbc.uk',
    });
    expect(clearChannelGuideOverride).toHaveBeenCalledWith('s1', 'm:s1:live:1');
    expect(listReminders).toHaveBeenCalledWith('kids-1', {
      includeFired: false,
      parentalUnlocked: false,
    });
    expect(upsertReminder).toHaveBeenCalledWith({
      sourceId: 's1',
      channelKey: 'm:s1:live:1',
      channelName: 'News',
      programmeTitle: 'Evening News',
      programmeStart: 10_000,
      programmeStop: 20_000,
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(removeReminder).toHaveBeenCalledWith('m:s1:live:1', 10_000, 'kids-1');
    expect(markReminderFired).toHaveBeenCalledWith('m:s1:live:1', 10_000, 'kids-1');
    expect(pruneExpiredReminders).toHaveBeenCalledWith(99_000);
  });
});
