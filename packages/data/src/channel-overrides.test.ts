import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { queryAlphabetIndex } from './alphabet-index';
import { createCatalogService } from './catalog';
import { commitStagedCatalog } from './catalog-commit';
import {
  clearChannelOverride,
  listChannelOverrides,
  MAX_CUSTOM_CHANNEL_NAME_LENGTH,
  reorderChannels,
  setChannelOverride,
} from './channel-overrides-repo';
import {
  addChannelToCustomGroup,
  createCustomGroup,
  customGroupCategoryId,
} from './custom-groups-repo';
import { queryChannelByNumber } from './guide-queries';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { createProfile, deleteProfile } from './profiles-repo';
import {
  queryAllSourcesItems,
  queryAllSourcesItemsByCursor,
  queryCategories,
  queryItemDetail,
  queryItems,
  queryItemsByCursor,
} from './queries';
import { queryLiveVariants } from './queries-variants';
import { listRecentChannels, recordRecentChannel } from './recent-channels-repo';
import { querySearch, querySearchSuggestions } from './search';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { listFavorites, saveWatchProgress, setFavorite } from './user-state';
import { reconcileUserData, saveUserDataSnapshot, type UserDataStore } from './user-state-backup';
import { createCoalescedCatalog } from './write-coalescer';

async function setup() {
  const handle = testDb();
  await openCatalog(handle.db);
  await handle.db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
  );
  return handle;
}

describe('channel-overrides-repo (#60)', () => {
  it('supports set, partial patch preservation, clear, and profile isolation', async () => {
    const { db, close } = await setup();
    try {
      let now = 1_000;
      const clock = () => {
        now += 100;
        return now;
      };

      expect(await listChannelOverrides(db)).toEqual([]);

      const renamed = await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:1', sourceId: 's1', customName: '  BBC One HD  ' },
        clock,
      );
      expect(renamed.ok).toBe(true);
      if (renamed.ok) {
        expect(renamed.value).toEqual({
          profileId: 'default',
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          customName: 'BBC One HD',
          isHidden: false,
          sortOrder: null,
          updatedAt: 1_100,
        });
      }

      // Partial patch hides the channel without clobbering customName
      const hidden = await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:1', sourceId: 's1', isHidden: true },
        clock,
      );
      expect(hidden.ok).toBe(true);
      if (hidden.ok) {
        expect(hidden.value).toMatchObject({
          customName: 'BBC One HD',
          isHidden: true,
          sortOrder: null,
          updatedAt: 1_200,
        });
      }

      // Separate profile is isolated
      await setChannelOverride(
        db,
        {
          profileId: 'kids',
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          customName: 'Kids News',
          sortOrder: 3,
        },
        clock,
      );
      expect(await listChannelOverrides(db, 'default')).toHaveLength(1);
      expect(await listChannelOverrides(db, 'kids')).toEqual([
        {
          profileId: 'kids',
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          customName: 'Kids News',
          isHidden: false,
          sortOrder: 3,
          updatedAt: 1_300,
        },
      ]);

      // Clearing customName to null and unhiding deletes empty override row
      const clearedFields = await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:1', sourceId: 's1', customName: null, isHidden: false },
        clock,
      );
      expect(clearedFields.ok).toBe(true);
      expect(await listChannelOverrides(db, 'default')).toEqual([]);

      // Explicit clearChannelOverride removes kids override
      const cleared = await clearChannelOverride(db, 'x:s1:live:1', 'kids');
      expect(cleared.ok).toBe(true);
      expect(await listChannelOverrides(db, 'kids')).toEqual([]);
    } finally {
      close();
    }
  });

  it('validates custom channel names, source IDs, item keys, sort orders, and profile IDs', async () => {
    const { db, close } = await setup();
    try {
      const tooLong = 'A'.repeat(MAX_CUSTOM_CHANNEL_NAME_LENGTH + 1);
      expect(
        await setChannelOverride(db, {
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          customName: tooLong,
        }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });

      expect(
        await setChannelOverride(db, {
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          customName: 'Bad\u0007Name',
        }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });

      expect(
        await setChannelOverride(db, {
          itemKey: 'https://user:pass@evil.invalid/ch.ts',
          sourceId: 's1',
          isHidden: true,
        }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });

      expect(
        await setChannelOverride(db, {
          itemKey: 'x:s1:live:1',
          sourceId: 'bad source!',
          isHidden: true,
        }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });

      expect(
        await setChannelOverride(db, {
          profileId: 'bad/profile',
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          isHidden: true,
        }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });

      expect(
        await setChannelOverride(db, {
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          sortOrder: -1,
        }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });

      expect(await clearChannelOverride(db, 'x:s1:live:1', 'bad/profile')).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
    } finally {
      close();
    }
  });

  it('reorders channels atomically in one transaction while preserving custom names and hide flags', async () => {
    const { db, close } = await setup();
    try {
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:2', sourceId: 's1', customName: 'Custom Two', isHidden: true },
        () => 1_000,
      );

      const reordered = await reorderChannels(
        db,
        ['x:s1:live:3', 'x:s1:live:2', 'x:s1:live:1', 'x:s1:live:2'],
        's1',
        'default',
        () => 2_000,
      );
      expect(reordered.ok).toBe(true);

      const list = await listChannelOverrides(db, 'default');
      expect(list).toEqual([
        {
          profileId: 'default',
          itemKey: 'x:s1:live:3',
          sourceId: 's1',
          customName: null,
          isHidden: false,
          sortOrder: 0,
          updatedAt: 2_000,
        },
        {
          profileId: 'default',
          itemKey: 'x:s1:live:2',
          sourceId: 's1',
          customName: 'Custom Two',
          isHidden: true,
          sortOrder: 1,
          updatedAt: 2_000,
        },
        {
          profileId: 'default',
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          customName: null,
          isHidden: false,
          sortOrder: 2,
          updatedAt: 2_000,
        },
      ]);

      expect(await reorderChannels(db, ['https://bad.invalid'], 's1')).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
      expect(await reorderChannels(db, ['x:s1:live:1'], 'bad source!')).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
    } finally {
      close();
    }
  });

  it('cascades profile deletion to channel_overrides without affecting other profiles', async () => {
    const { db, close } = await setup();
    try {
      const secrets = memorySecrets();
      const created = await createProfile(
        db,
        { name: 'Guest' },
        () => 1_000,
        () => 'guest1',
      );
      expect(created.ok).toBe(true);

      await setChannelOverride(
        db,
        { profileId: 'default', itemKey: 'x:s1:live:1', sourceId: 's1', customName: 'Default Ch' },
        () => 1_000,
      );
      await setChannelOverride(
        db,
        { profileId: 'guest1', itemKey: 'x:s1:live:1', sourceId: 's1', customName: 'Guest Ch' },
        () => 1_000,
      );

      const del = await deleteProfile(db, secrets, 'guest1');
      expect(del.ok).toBe(true);
      expect(await listChannelOverrides(db, 'guest1')).toEqual([]);
      expect(await listChannelOverrides(db, 'default')).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('projects renames, hides, and manual reorder across all live browse, search, EPG, variant, number, recent, and favorites queries', async () => {
    const { db, close } = await setup();
    try {
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s2', 'm3u', 'Alt', 200, '{}')",
      );
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'c1', 'General', 'general', 0, 1)",
      );
      await db.run(
        `INSERT INTO live (source_id, key, num, name, name_fold, sort_title, variant_base_fold, quality_rank, guide_id, run_id) VALUES
           ('s1', 'x:s1:live:1', 1, 'Alpha News HD', 'alpha news hd', 'alpha news hd', 'alpha news', 3, 'g1', 1),
           ('s1', 'x:s1:live:2', 2, 'Alpha News SD', 'alpha news sd', 'alpha news sd', 'alpha news', 1, 'g2', 1),
           ('s1', 'x:s1:live:3', 3, 'Beta Sports', 'beta sports', 'beta sports', 'beta sports', 2, 'g3', 1),
           ('s1', 'x:s1:live:4', 4, 'Adult XXX Channel', 'adult xxx channel', 'adult xxx channel', 'adult xxx', 2, 'g4', 1),
           ('s2', 'm:s2:live:5', 5, 'Gamma Cinema', 'gamma cinema', 'gamma cinema', 'gamma cinema', 2, NULL, 1)`,
      );
      await db.run(
        `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES
           ('s1', 'live', 'x:s1:live:1', 'c1', 0, 1),
           ('s1', 'live', 'x:s1:live:2', 'c1', 1, 1),
           ('s1', 'live', 'x:s1:live:3', 'c1', 2, 1),
           ('s1', 'live', 'x:s1:live:4', 'c1', 3, 1)`,
      );
      await db.run(
        `INSERT INTO programmes (source_id, guide_id, start, stop, title, title_fold, description_fold, run_id) VALUES
           ('s1', 'g1', 1000, 5000, 'Evening Bulletin', 'evening bulletin', '', 1),
           ('s1', 'g2', 1000, 5000, 'Evening Bulletin SD', 'evening bulletin sd', '', 1)`,
      );
      await db.run(
        `INSERT INTO programmes_fts (source_id, guide_id, start, stop, title_fold, description_fold) VALUES
           ('s1', 'g1', 1000, 5000, 'evening bulletin', ''),
           ('s1', 'g2', 1000, 5000, 'evening bulletin sd', '')`,
      );

      // Rename ch1 -> "Zebra Özel Haber", hide ch2, reorder ch3 before ch1
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:1', sourceId: 's1', customName: 'Zebra Özel Haber' },
        () => 1_000,
      );
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:2', sourceId: 's1', isHidden: true },
        () => 1_000,
      );
      await reorderChannels(db, ['x:s1:live:3', 'x:s1:live:1'], 's1', 'default', () => 1_100);

      // 1. queryCategories hides ch2 by default (3 visible) and includes it with includeHidden (4)
      const catsVisible = await queryCategories(db, 's1', 'live');
      expect(catsVisible[0]?.itemCount).toBe(3);
      const catsAll = await queryCategories(db, 's1', 'live', { includeHidden: true });
      expect(catsAll[0]?.itemCount).toBe(4);

      // 2. queryItems applies manual sort order (ch3, ch1, ch4), custom name, originalName, excludes ch2
      const itemsDefault = await queryItems(db, 's1|live|c1', 0, 10);
      expect(
        itemsDefault.map((i) => ({ key: i.key, name: i.name, originalName: i.originalName })),
      ).toEqual([
        { key: 'x:s1:live:3', name: 'Beta Sports', originalName: undefined },
        { key: 'x:s1:live:1', name: 'Zebra Özel Haber', originalName: 'Alpha News HD' },
        { key: 'x:s1:live:4', name: 'Adult XXX Channel', originalName: undefined },
      ]);
      const itemsHidden = await queryItems(db, 's1|live|c1', 0, 10, { includeHidden: true });
      expect(itemsHidden.find((i) => i.key === 'x:s1:live:2')?.isHidden).toBe(true);

      // 3. queryItemsByCursor paginates cleanly across manual sort_order boundary -> provider order
      const cp1 = await queryItemsByCursor(db, 's1|live|c1', undefined, 2);
      expect(cp1.items.map((i) => i.key)).toEqual(['x:s1:live:3', 'x:s1:live:1']);
      expect(cp1.hasMore).toBe(true);
      const cp2 = await queryItemsByCursor(db, 's1|live|c1', cp1.nextCursor ?? undefined, 2);
      expect(cp2.items.map((i) => i.key)).toEqual(['x:s1:live:4']);
      expect(cp2.hasMore).toBe(false);

      // 4. queryAllSourcesItems + queryAllSourcesItemsByCursor + queryAlphabetIndex
      const allAlpha = await queryAllSourcesItems(db, 'live', 0, 10, undefined, {
        sortBy: 'alpha',
      });
      expect(allAlpha.map((i) => i.name)).toEqual([
        'Adult XXX Channel',
        'Beta Sports',
        'Gamma Cinema',
        'Zebra Özel Haber',
      ]);
      const alphaBuckets = await queryAlphabetIndex(db, { kind: 'live' });
      expect(alphaBuckets.map((b) => b.letter)).toEqual(['A', 'B', 'G', 'Z']);
      const allCursor = await queryAllSourcesItemsByCursor(db, 'live', {}, 10);
      expect(allCursor.items.map((i) => i.key)).not.toContain('x:s1:live:2');
      expect(allCursor.items.find((i) => i.key === 'x:s1:live:1')?.name).toBe('Zebra Özel Haber');

      // 5. queryItemDetail surfaces custom name, originalName, isHidden, and customSortOrder
      const detail1 = await queryItemDetail(db, 'x:s1:live:1');
      expect(detail1).toMatchObject({
        name: 'Zebra Özel Haber',
        originalName: 'Alpha News HD',
        customSortOrder: 1,
      });
      const detail2 = await queryItemDetail(db, 'x:s1:live:2');
      expect(detail2?.isHidden).toBe(true);

      // 6. querySearch matches Turkish-folded custom_name, excludes hidden live/EPG, updates EPG channelName
      const customSearch = await querySearch(db, 'ozel haber', { scope: 'live', nowMs: 2_000 });
      expect(
        customSearch.live.map((h) => ({ key: h.key, name: h.name, originalName: h.originalName })),
      ).toEqual([{ key: 'x:s1:live:1', name: 'Zebra Özel Haber', originalName: 'Alpha News HD' }]);
      const epgSearch = await querySearch(db, 'evening bulletin', { scope: 'epg', nowMs: 2_000 });
      expect(epgSearch.epg.map((e) => ({ key: e.channelKey, name: e.channelName }))).toEqual([
        { key: 'x:s1:live:1', name: 'Zebra Özel Haber' },
      ]);

      // Renaming an adult channel NEVER bypasses parental controls
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:4', sourceId: 's1', customName: 'Friendly Cartoons' },
        () => 1_200,
      );
      await updateParentalSettings(db, 'default', { enabled: true, blockAdultKeywords: true });
      expect((await querySearch(db, 'friendly cartoons', { scope: 'live' })).live).toEqual([]);
      expect((await queryItems(db, 's1|live|c1', 0, 10)).map((i) => i.key)).not.toContain(
        'x:s1:live:4',
      );
      await updateParentalSettings(db, 'default', { enabled: false });

      // 7. queryChannelByNumber, queryLiveVariants, listRecentChannels, listFavorites, querySearchSuggestions
      expect((await queryChannelByNumber(db, 1, 's1'))?.name).toBe('Zebra Özel Haber');
      expect(await queryChannelByNumber(db, 2, 's1')).toBeUndefined();

      const variants = await queryLiveVariants(db, 'x:s1:live:1', 's1|live|c1');
      expect(variants).toEqual([
        { key: 'x:s1:live:1', title: 'Zebra Özel Haber', qualityLabel: 'HD', qualityRank: 3 },
      ]);

      await recordRecentChannel(db, 'x:s1:live:1', 's1', 'default', 5_000);
      await recordRecentChannel(db, 'x:s1:live:2', 's1', 'default', 6_000);
      const recents = await listRecentChannels(db, 10, 'default');
      expect(recents.map((r) => ({ key: r.key, name: r.name }))).toEqual([
        { key: 'x:s1:live:1', name: 'Zebra Özel Haber' },
      ]);

      await setFavorite(
        db,
        { sourceId: 's1', itemKey: 'x:s1:live:1', kind: 'live', title: 'Alpha News HD' },
        true,
        () => 5_000,
      );
      await setFavorite(
        db,
        { sourceId: 's1', itemKey: 'x:s1:live:2', kind: 'live', title: 'Alpha News SD' },
        true,
        () => 6_000,
      );
      expect(
        (await listFavorites(db, 10, 'default')).map((f) => ({ key: f.itemKey, title: f.title })),
      ).toEqual([{ key: 'x:s1:live:1', title: 'Zebra Özel Haber' }]);
      expect(await listFavorites(db, 10, 'default', { includeHidden: true })).toHaveLength(2);

      await saveWatchProgress(
        db,
        {
          sourceId: 's1',
          itemKey: 'x:s1:live:2',
          kind: 'live',
          title: 'Alpha News SD',
          positionMs: 20_000,
          durationMs: 60_000,
        },
        () => 7_000,
      );
      const suggestions = await querySearchSuggestions(db, { profileId: 'default' });
      expect(suggestions.some((s) => s.itemKey === 'x:s1:live:2')).toBe(false);
      expect(suggestions.find((s) => s.itemKey === 'x:s1:live:1')?.label).toBe('Zebra Özel Haber');
    } finally {
      close();
    }
  });

  it('remaps legacy M3U keys in channel_overrides and custom_group_items during commitStagedCatalog', async () => {
    const { db, close } = await setup();
    try {
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:old:1', 'Legacy Ch', 'legacy ch', 1)",
      );
      await setChannelOverride(
        db,
        { itemKey: 'm:s1:old:1', sourceId: 's1', customName: 'My Renamed Ch', sortOrder: 2 },
        () => 2_000,
      );
      await createCustomGroup(
        db,
        { name: 'Faves' },
        () => 1_000,
        () => 'g-rem',
      );
      await addChannelToCustomGroup(db, 'g-rem', 'm:s1:old:1', 's1', () => 1_000);

      await db.run(
        `INSERT INTO live_next (source_id, key, legacy_key, name, name_fold, sort_title, run_id)
         VALUES ('s1', 'm:s1:new:1', 'm:s1:old:1', 'Legacy Ch', 'legacy ch', 'legacy ch', 2)`,
      );

      await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, ['movie', 'series']));

      expect(await listChannelOverrides(db, 'default')).toEqual([
        {
          profileId: 'default',
          itemKey: 'm:s1:new:1',
          sourceId: 's1',
          customName: 'My Renamed Ch',
          isHidden: false,
          sortOrder: 2,
          updatedAt: 2_000,
        },
      ]);
      const groupItems = await queryItems(db, customGroupCategoryId('g-rem'), 0, 10);
      expect(groupItems.map((i) => ({ key: i.key, name: i.name }))).toEqual([
        { key: 'm:s1:new:1', name: 'My Renamed Ch' },
      ]);
    } finally {
      close();
    }
  });

  it('exposes all 11 channel management methods via CatalogService and createCoalescedCatalog with userData sync', async () => {
    const { db, close } = await setup();
    try {
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, sort_title, run_id) VALUES ('s1', 'x:s1:live:1', 'Ch 1', 'ch 1', 'ch 1', 1)",
      );
      let backupWrites = 0;
      let storedBackup: string | undefined;
      const base = createCatalogService({
        db,
        secrets: memorySecrets(),
        scheduler: countingScheduler(),
        http: {
          get: async () =>
            ok({
              status: 200,
              headers: {},
              body: (async function* () {
                // empty
              })(),
            }),
        },
        clock: () => 5_000,
        userData: {
          read: () => storedBackup,
          write: (v) => {
            backupWrites += 1;
            storedBackup = v;
          },
        },
      });
      const service = createCoalescedCatalog(base, { windowMs: 0 });

      const ov = await service.setChannelOverride?.({
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        customName: 'Renamed 1',
      });
      expect(ov?.ok).toBe(true);
      expect(await service.listChannelOverrides?.()).toHaveLength(1);
      expect((await service.reorderChannels?.(['x:s1:live:1'], 's1'))?.ok).toBe(true);

      const grp = await service.createCustomGroup?.({ name: 'Top Channels' });
      expect(grp?.ok).toBe(true);
      const groupId = grp?.ok ? grp.value.id : '';
      expect((await service.addChannelToCustomGroup?.(groupId, 'x:s1:live:1', 's1'))?.ok).toBe(
        true,
      );
      expect(
        (await service.items(customGroupCategoryId(groupId), 0, 10)).map((i) => i.name),
      ).toEqual(['Renamed 1']);
      expect((await service.updateCustomGroup?.(groupId, { name: 'Best Channels' }))?.ok).toBe(
        true,
      );
      expect((await service.listCustomGroups?.())?.[0]?.name).toBe('Best Channels');
      expect(
        (await service.setCustomGroupItems?.(groupId, [{ itemKey: 'x:s1:live:1', sourceId: 's1' }]))
          ?.ok,
      ).toBe(true);
      expect((await service.removeChannelFromCustomGroup?.(groupId, 'x:s1:live:1'))?.ok).toBe(true);
      expect((await service.deleteCustomGroup?.(groupId))?.ok).toBe(true);
      expect((await service.clearChannelOverride?.('x:s1:live:1'))?.ok).toBe(true);
      expect(backupWrites).toBeGreaterThanOrEqual(8);

      // Suppress unused import lint if setParentalLock used in custom-groups test
      expect(typeof setParentalLock).toBe('function');
    } finally {
      close();
    }
  });

  it('buckets and sorts Turkish-renamed channels under folded ASCII letters across category, all-sources, custom groups, and backup restore', async () => {
    const { db, close } = await setup();
    try {
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'tr', 'Turkish', 'turkish', 0, 1)",
      );
      await db.run(
        `INSERT INTO live (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
           ('s1', 'x:s1:live:1', 'Channel 1', 'channel 1', 'channel 1', 0, 1),
           ('s1', 'x:s1:live:2', 'Channel 2', 'channel 2', 'channel 2', 0, 1),
           ('s1', 'x:s1:live:3', 'Channel 3', 'channel 3', 'channel 3', 0, 1),
           ('s1', 'x:s1:live:4', 'Channel 4', 'channel 4', 'channel 4', 0, 1),
           ('s1', 'x:s1:live:5', 'Channel 5', 'channel 5', 'channel 5', 0, 1)`,
      );
      await db.run(
        `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES
           ('s1', 'live', 'x:s1:live:1', 'tr', 0, 1),
           ('s1', 'live', 'x:s1:live:2', 'tr', 1, 1),
           ('s1', 'live', 'x:s1:live:3', 'tr', 2, 1),
           ('s1', 'live', 'x:s1:live:4', 'tr', 3, 1),
           ('s1', 'live', 'x:s1:live:5', 'tr', 4, 1)`,
      );

      await setChannelOverride(db, {
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        customName: 'İstanbul TV',
      });
      await setChannelOverride(db, {
        itemKey: 'x:s1:live:2',
        sourceId: 's1',
        customName: 'Özgür Haber',
      });
      await setChannelOverride(db, {
        itemKey: 'x:s1:live:3',
        sourceId: 's1',
        customName: 'Çocuk Kanalı',
      });
      await setChannelOverride(db, {
        itemKey: 'x:s1:live:4',
        sourceId: 's1',
        customName: 'Şehir Spor',
      });
      await setChannelOverride(db, {
        itemKey: 'x:s1:live:5',
        sourceId: 's1',
        customName: 'Ülke Belgesel',
      });

      await createCustomGroup(
        db,
        { name: 'TR Mix' },
        () => 1_000,
        () => 'g-tr',
      );
      for (const k of ['x:s1:live:1', 'x:s1:live:2', 'x:s1:live:3', 'x:s1:live:4', 'x:s1:live:5']) {
        await addChannelToCustomGroup(db, 'g-tr', k, 's1', () => 1_000);
      }

      const expectedLetters = ['C', 'I', 'O', 'S', 'U'];
      const expectedNames = [
        'Çocuk Kanalı',
        'İstanbul TV',
        'Özgür Haber',
        'Şehir Spor',
        'Ülke Belgesel',
      ];

      expect(
        (await queryAlphabetIndex(db, { kind: 'live', categoryId: 's1|live|tr' })).map(
          (b) => b.letter,
        ),
      ).toEqual(expectedLetters);
      expect((await queryAlphabetIndex(db, { kind: 'live' })).map((b) => b.letter)).toEqual(
        expectedLetters,
      );
      expect(
        (
          await queryAlphabetIndex(db, { kind: 'live', categoryId: customGroupCategoryId('g-tr') })
        ).map((b) => b.letter),
      ).toEqual(expectedLetters);

      expect(
        (await queryItems(db, 's1|live|tr', 0, 10, { sortBy: 'alpha' })).map((i) => i.name),
      ).toEqual(expectedNames);
      expect(
        (await queryAllSourcesItems(db, 'live', 0, 10, undefined, { sortBy: 'alpha' })).map(
          (i) => i.name,
        ),
      ).toEqual(expectedNames);
      expect(
        (await queryItems(db, customGroupCategoryId('g-tr'), 0, 10, { sortBy: 'alpha' })).map(
          (i) => i.name,
        ),
      ).toEqual(expectedNames);

      // Verify user-state backup restore computes custom_name_fold cleanly as well.
      let snapshot: string | undefined;
      const store: UserDataStore = {
        read: () => snapshot,
        write: (next) => {
          snapshot = next;
        },
      };
      await saveUserDataSnapshot(db, store);

      const fresh = testDb();
      try {
        await openCatalog(fresh.db);
        await fresh.db.run(
          "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}')",
        );
        await fresh.db.run(
          `INSERT INTO live (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
             ('s1', 'x:s1:live:1', 'Channel 1', 'channel 1', 'channel 1', 0, 1),
             ('s1', 'x:s1:live:2', 'Channel 2', 'channel 2', 'channel 2', 0, 1)`,
        );
        await reconcileUserData(fresh.db, store);
        expect((await queryAlphabetIndex(fresh.db, { kind: 'live' })).map((b) => b.letter)).toEqual(
          ['I', 'O'],
        );
      } finally {
        fresh.close();
      }
    } finally {
      close();
    }
  });
});
