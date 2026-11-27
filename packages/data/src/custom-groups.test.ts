import { describe, expect, it } from 'vitest';
import { queryAlphabetIndex } from './alphabet-index';
import { listChannelOverrides, setChannelOverride } from './channel-overrides-repo';
import {
  addChannelToCustomGroup,
  CUSTOM_GROUP_CATEGORY_PREFIX,
  createCustomGroup,
  customGroupCategoryId,
  deleteCustomGroup,
  listCustomGroups,
  MAX_CUSTOM_GROUP_NAME_LENGTH,
  parseCustomGroupCategoryId,
  removeChannelFromCustomGroup,
  setCustomGroupItems,
  updateCustomGroup,
} from './custom-groups-repo';
import { openCatalog } from './migrate';
import { setParentalLock, updateParentalSettings } from './parental-repo';
import { createProfile, deleteProfile } from './profiles-repo';
import { queryItems, queryItemsByCursor } from './queries';
import { queryLiveVariants } from './queries-variants';
import { querySearch } from './search';
import { memorySecrets, testDb } from './test-db';
import {
  decodeUserDataSnapshot,
  encodeUserDataSnapshot,
  reconcileUserData,
  saveUserDataSnapshot,
  type UserDataStore,
} from './user-state-backup';

async function setup() {
  const handle = testDb();
  await openCatalog(handle.db);
  await handle.db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}'), ('s2', 'm3u', 'Alt', 200, '{}')",
  );
  await handle.db.run(
    `INSERT INTO live (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
       ('s1', 'x:s1:live:1', 'Sports One', 'sports one', 'sports one', 0, 1),
       ('s1', 'x:s1:live:2', 'News Two', 'news two', 'news two', 0, 1),
       ('s2', 'm:s2:live:3', 'Cinema Three', 'cinema three', 'cinema three', 0, 1)`,
  );
  return handle;
}

describe('custom-groups-repo (#60)', () => {
  it('encodes and parses synthetic __custom:<groupId> category IDs safely', () => {
    expect(CUSTOM_GROUP_CATEGORY_PREFIX).toBe('__custom:');
    expect(customGroupCategoryId('grp-1')).toBe('__custom:grp-1');
    expect(parseCustomGroupCategoryId('__custom:grp-1')).toBe('grp-1');
    expect(parseCustomGroupCategoryId('__custom:')).toBeUndefined();
    expect(parseCustomGroupCategoryId('__custom:bad/id')).toBeUndefined();
    expect(parseCustomGroupCategoryId('s1|live|c1')).toBeUndefined();
  });

  it('supports create, update, hide/unhide, delete, and item membership management across sources', async () => {
    const { db, close } = await setup();
    try {
      let now = 1_000;
      const clock = () => {
        now += 100;
        return now;
      };

      const g1 = await createCustomGroup(db, { name: '  Match Day  ' }, clock, () => 'g1');
      const g2 = await createCustomGroup(db, { name: 'Morning News' }, clock, () => 'g2');
      expect(g1.ok).toBe(true);
      expect(g2.ok).toBe(true);
      if (g1.ok && g2.ok) {
        expect(g1.value).toEqual({
          id: 'g1',
          profileId: 'default',
          name: 'Match Day',
          sortOrder: 0,
          isHidden: false,
          itemCount: 0,
          updatedAt: 1_100,
        });
        expect(g2.value.sortOrder).toBe(1);
      }

      // Add channels across two sources + idempotent duplicate add
      expect((await addChannelToCustomGroup(db, 'g1', 'x:s1:live:1', 's1', clock)).ok).toBe(true);
      expect((await addChannelToCustomGroup(db, 'g1', 'm:s2:live:3', 's2', clock)).ok).toBe(true);
      expect((await addChannelToCustomGroup(db, 'g1', 'x:s1:live:1', 's1', clock)).ok).toBe(true);

      const listed = await listCustomGroups(db, 'default');
      expect(listed.map((g) => ({ id: g.id, name: g.name, itemCount: g.itemCount }))).toEqual([
        { id: 'g1', name: 'Match Day', itemCount: 2 },
        { id: 'g2', name: 'Morning News', itemCount: 0 },
      ]);

      // Replace items in explicit order with dedupe
      const setRes = await setCustomGroupItems(
        db,
        'g1',
        [
          { itemKey: 'm:s2:live:3', sourceId: 's2' },
          { itemKey: 'x:s1:live:2', sourceId: 's1' },
          { itemKey: 'm:s2:live:3', sourceId: 's2' },
        ],
        clock,
      );
      expect(setRes.ok).toBe(true);

      const rawItems = await db.all<{ item_key: string; position: number }>(
        'SELECT item_key, position FROM custom_group_items WHERE group_id = ? ORDER BY position',
        ['g1'],
      );
      expect(rawItems).toEqual([
        { item_key: 'm:s2:live:3', position: 0 },
        { item_key: 'x:s1:live:2', position: 1 },
      ]);

      // Remove one channel
      expect((await removeChannelFromCustomGroup(db, 'g1', 'm:s2:live:3', clock)).ok).toBe(true);
      expect((await listCustomGroups(db, 'default'))[0]?.itemCount).toBe(1);

      // Update name, sortOrder, and hide g2
      await updateCustomGroup(db, 'g1', { sortOrder: 2 }, clock);
      const upd = await updateCustomGroup(
        db,
        'g2',
        { name: 'Hidden Group', isHidden: true, sortOrder: 0 },
        clock,
      );
      expect(upd.ok).toBe(true);
      expect((await listCustomGroups(db, 'default')).map((g) => g.id)).toEqual(['g1']);
      expect(
        (await listCustomGroups(db, 'default', { includeHidden: true })).map((g) => g.id),
      ).toEqual(['g2', 'g1']);

      // Delete g1 removes both group and its items
      expect((await deleteCustomGroup(db, 'g1')).ok).toBe(true);
      expect(await db.all('SELECT * FROM custom_group_items WHERE group_id = ?', ['g1'])).toEqual(
        [],
      );
      expect(await deleteCustomGroup(db, 'g1')).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'custom-group-not-found' },
      });
    } finally {
      close();
    }
  });

  it('validates group names, IDs, profile IDs, and item inputs', async () => {
    const { db, close } = await setup();
    try {
      expect(await createCustomGroup(db, { name: '   ' })).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
      expect(
        await createCustomGroup(db, { name: 'X'.repeat(MAX_CUSTOM_GROUP_NAME_LENGTH + 1) }),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });
      expect(await createCustomGroup(db, { name: 'Bad\nName' })).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
      expect(await createCustomGroup(db, { name: 'Ok', profileId: 'bad/profile' })).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
      expect(await updateCustomGroup(db, 'missing', { name: 'Valid' })).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'custom-group-not-found' },
      });
      const created = await createCustomGroup(
        db,
        { name: 'Test' },
        () => 100,
        () => 'g-val',
      );
      expect(created.ok).toBe(true);
      expect(await updateCustomGroup(db, 'g-val', { name: '' })).toMatchObject({
        ok: false,
        error: { category: 'source-format' },
      });
      expect(
        await setCustomGroupItems(db, 'g-val', [{ itemKey: 'https://evil', sourceId: 's1' }]),
      ).toMatchObject({ ok: false, error: { category: 'source-format' } });
      expect(await addChannelToCustomGroup(db, 'missing', 'x:s1:live:1', 's1')).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'custom-group-not-found' },
      });
      expect(await removeChannelFromCustomGroup(db, 'missing', 'x:s1:live:1')).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'custom-group-not-found' },
      });
    } finally {
      close();
    }
  });

  it('cascades profile deletion to custom_groups and custom_group_items', async () => {
    const { db, close } = await setup();
    try {
      const secrets = memorySecrets();
      await createProfile(
        db,
        { name: 'Family' },
        () => 1_000,
        () => 'fam1',
      );
      await createCustomGroup(
        db,
        { profileId: 'fam1', name: 'Fam Live' },
        () => 1_000,
        () => 'gfam',
      );
      await addChannelToCustomGroup(db, 'gfam', 'x:s1:live:1', 's1', () => 1_000);
      await createCustomGroup(
        db,
        { profileId: 'default', name: 'Def Live' },
        () => 1_000,
        () => 'gdef',
      );
      await addChannelToCustomGroup(db, 'gdef', 'x:s1:live:2', 's1', () => 1_000);

      expect((await deleteProfile(db, secrets, 'fam1')).ok).toBe(true);
      expect(await listCustomGroups(db, 'fam1', { includeHidden: true })).toEqual([]);
      expect(await db.all('SELECT * FROM custom_group_items WHERE group_id = ?', ['gfam'])).toEqual(
        [],
      );
      expect(await listCustomGroups(db, 'default')).toHaveLength(1);
      expect(
        await db.all('SELECT * FROM custom_group_items WHERE group_id = ?', ['gdef']),
      ).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('queries __custom:<groupId> across sources with cursor pagination, alphabet index, channel_overrides, and parental controls (#31 + #60)', async () => {
    const { db, close } = await setup();
    try {
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'locked-cat', 'Locked', 'locked', 0, 1)",
      );
      await db.run(
        `INSERT INTO live (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
           ('s1', 'x:s1:live:adult', 'Late Night XXX', 'late night xxx', 'late night xxx', 0, 1),
           ('s1', 'x:s1:live:locked', 'Locked Premium', 'locked premium', 'locked premium', 0, 1)`,
      );
      await db.run(
        "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', 'x:s1:live:locked', 'locked-cat', 0, 1)",
      );

      await createCustomGroup(
        db,
        { name: 'Cross Source Mix' },
        () => 1_000,
        () => 'mix1',
      );
      await setCustomGroupItems(
        db,
        'mix1',
        [
          { itemKey: 'm:s2:live:3', sourceId: 's2' },
          { itemKey: 'x:s1:live:1', sourceId: 's1' },
          { itemKey: 'x:s1:live:2', sourceId: 's1' },
          { itemKey: 'x:s1:live:adult', sourceId: 's1' },
          { itemKey: 'x:s1:live:locked', sourceId: 's1' },
        ],
        () => 1_000,
      );

      // Rename one channel and hide another
      await setChannelOverride(
        db,
        { itemKey: 'm:s2:live:3', sourceId: 's2', customName: 'Alpha Cinema' },
        () => 1_100,
      );
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:2', sourceId: 's1', isHidden: true },
        () => 1_100,
      );

      // Enable parental controls + lock category 'locked-cat'
      await updateParentalSettings(db, 'default', { enabled: true, blockAdultKeywords: true });
      await setParentalLock(
        db,
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'locked-cat' },
        true,
      );

      const catId = customGroupCategoryId('mix1');

      // Only m:s2:live:3 (renamed) and x:s1:live:1 survive hide + parental filtering
      const groupsLocked = await listCustomGroups(db, 'default');
      expect(groupsLocked[0]?.itemCount).toBe(2);

      const pageLocked = await queryItems(db, catId, 0, 10);
      expect(pageLocked.map((i) => ({ key: i.key, name: i.name, sourceId: i.sourceId }))).toEqual([
        { key: 'm:s2:live:3', name: 'Alpha Cinema', sourceId: 's2' },
        { key: 'x:s1:live:1', name: 'Sports One', sourceId: 's1' },
      ]);

      // Cursor pagination over __custom:<groupId>
      const cur1 = await queryItemsByCursor(db, catId, undefined, 1);
      expect(cur1.items.map((i) => i.key)).toEqual(['m:s2:live:3']);
      expect(cur1.hasMore).toBe(true);
      const cur2 = await queryItemsByCursor(db, catId, cur1.nextCursor ?? undefined, 2);
      expect(cur2.items.map((i) => i.key)).toEqual(['x:s1:live:1']);
      expect(cur2.hasMore).toBe(false);

      // Alphabet index over __custom:<groupId> reflects renamed title ("Alpha Cinema" -> A) and hides restricted/hidden
      const buckets = await queryAlphabetIndex(db, { kind: 'live', categoryId: catId });
      expect(buckets).toEqual([
        { letter: 'A', offset: 0, count: 1 },
        { letter: 'S', offset: 1, count: 1 },
      ]);
      expect(await queryAlphabetIndex(db, { kind: 'movie', categoryId: catId })).toEqual([]);

      // parentalUnlocked: true reveals adult & locked channels while still honoring co.is_hidden
      const unlocked = await queryItems(db, catId, 0, 10, { parentalUnlocked: true });
      expect(unlocked.map((i) => i.key)).toEqual([
        'm:s2:live:3',
        'x:s1:live:1',
        'x:s1:live:adult',
        'x:s1:live:locked',
      ]);

      // Profile isolation: another profile cannot read default's custom group
      expect(await queryItems(db, catId, 0, 10, { profileId: 'other' })).toEqual([]);
    } finally {
      close();
    }
  });

  it('resolves quality variants inside __custom:<groupId> honoring channel_overrides, source scope, and parental controls', async () => {
    const { db, close } = await setup();
    try {
      await db.run(
        "INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id) VALUES ('s1', 'live', 'locked-cat', 'Locked', 'locked', 0, 1)",
      );
      await db.run(
        `INSERT INTO live (source_id, key, name, name_fold, sort_title, variant_base_fold, quality_rank, is_hidden, run_id) VALUES
           ('s1', 'x:s1:live:v4k', 'Match TV 4K', 'match tv 4k', 'match tv 4k', 'match tv', 4, 0, 1),
           ('s1', 'x:s1:live:vhd', 'Match TV HD', 'match tv hd', 'match tv hd', 'match tv', 3, 0, 1),
           ('s1', 'x:s1:live:vsd', 'Match TV SD', 'match tv sd', 'match tv sd', 'match tv', 1, 0, 1),
           ('s1', 'x:s1:live:vhid', 'Match TV FHD', 'match tv fhd', 'match tv fhd', 'match tv', 3, 0, 1),
           ('s1', 'x:s1:live:vlock', 'Match TV UHD', 'match tv uhd', 'match tv uhd', 'match tv', 4, 0, 1),
           ('s2', 'm:s2:live:vother', 'Match TV HD', 'match tv hd', 'match tv hd', 'match tv', 3, 0, 1)`,
      );
      await db.run(
        "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES ('s1', 'live', 'x:s1:live:vlock', 'locked-cat', 0, 1)",
      );

      await createCustomGroup(
        db,
        { name: 'Match Group' },
        () => 1_000,
        () => 'vg1',
      );
      // Include HD, SD, FHD (will hide), UHD (parental locked), and s2's HD; omit 4K from group.
      await setCustomGroupItems(
        db,
        'vg1',
        [
          { itemKey: 'x:s1:live:vsd', sourceId: 's1' },
          { itemKey: 'x:s1:live:vhd', sourceId: 's1' },
          { itemKey: 'x:s1:live:vhid', sourceId: 's1' },
          { itemKey: 'x:s1:live:vlock', sourceId: 's1' },
          { itemKey: 'm:s2:live:vother', sourceId: 's2' },
        ],
        () => 1_000,
      );

      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:vhd', sourceId: 's1', customName: 'Match Main HD' },
        () => 1_100,
      );
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:vhid', sourceId: 's1', isHidden: true },
        () => 1_100,
      );
      await updateParentalSettings(db, 'default', { enabled: true, blockAdultKeywords: true });
      await setParentalLock(
        db,
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'locked-cat' },
        true,
      );

      const catId = customGroupCategoryId('vg1');
      const variants = await queryLiveVariants(db, 'x:s1:live:vhd', catId);
      expect(variants).toEqual([
        { key: 'x:s1:live:vhd', title: 'Match Main HD', qualityLabel: 'HD', qualityRank: 3 },
        { key: 'x:s1:live:vsd', title: 'Match TV SD', qualityLabel: 'SD', qualityRank: 1 },
      ]);

      // Parental unlock reveals locked variant inside the custom group while still excluding hidden & non-members.
      const unlocked = await queryLiveVariants(db, 'x:s1:live:vhd', catId, {
        parentalUnlocked: true,
      });
      expect(unlocked.map((v) => v.key)).toEqual([
        'x:s1:live:vlock',
        'x:s1:live:vhd',
        'x:s1:live:vsd',
      ]);

      // Profile isolation & malformed custom group IDs return empty cleanly.
      expect(await queryLiveVariants(db, 'x:s1:live:vhd', catId, { profileId: 'other' })).toEqual(
        [],
      );
      expect(await queryLiveVariants(db, 'x:s1:live:vhd', '__custom:bad/id')).toEqual([]);

      // Hidden custom group returns empty.
      await updateCustomGroup(db, 'vg1', { isHidden: true }, () => 1_200);
      expect(await queryLiveVariants(db, 'x:s1:live:vhd', catId)).toEqual([]);
    } finally {
      close();
    }
  });

  it('mirrors and restores channel_overrides, custom_groups, and custom_group_items via user-state-backup within size caps', async () => {
    const { db, close } = await setup();
    try {
      await setChannelOverride(
        db,
        { itemKey: 'x:s1:live:1', sourceId: 's1', customName: 'My Sports', sortOrder: 0 },
        () => 2_000,
      );
      await createCustomGroup(
        db,
        { name: 'Match Day' },
        () => 2_000,
        () => 'g-bak',
      );
      await addChannelToCustomGroup(db, 'g-bak', 'x:s1:live:1', 's1', () => 2_000);
      await addChannelToCustomGroup(db, 'g-bak', 'm:s2:live:3', 's2', () => 2_100);

      let raw: string | undefined;
      const store: UserDataStore = {
        read: () => raw,
        write: (next) => {
          raw = next;
        },
      };

      await saveUserDataSnapshot(db, store);
      expect(raw).toBeDefined();
      const decoded = decodeUserDataSnapshot(raw);
      expect(decoded.channelOverrides).toHaveLength(1);
      expect(decoded.customGroups).toHaveLength(1);
      expect(decoded.customGroupItems).toHaveLength(2);

      // Tight maxBytes budget still produces valid bounded JSON
      const tight = encodeUserDataSnapshot(
        {
          favorites: [],
          progress: [],
          channelOverrides: decoded.channelOverrides ?? [],
          customGroups: decoded.customGroups ?? [],
          customGroupItems: decoded.customGroupItems ?? [],
        },
        220,
      );
      expect(new TextEncoder().encode(tight).byteLength).toBeLessThanOrEqual(220);
      expect(() => JSON.parse(tight)).not.toThrow();

      // Simulate cache purge into a fresh database and restore
      const fresh = testDb();
      try {
        await openCatalog(fresh.db);
        await fresh.db.run(
          "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}'), ('s2', 'm3u', 'Alt', 200, '{}')",
        );
        await fresh.db.run(
          `INSERT INTO live (source_id, key, name, name_fold, sort_title, is_hidden, run_id) VALUES
             ('s1', 'x:s1:live:1', 'Sports One', 'sports one', 'sports one', 0, 1),
             ('s2', 'm:s2:live:3', 'Cinema Three', 'cinema three', 'cinema three', 0, 1)`,
        );

        const reconciled = await reconcileUserData(fresh.db, store);
        expect(reconciled).toMatchObject({
          channelOverridesRestored: 1,
          customGroupsRestored: 1,
          customGroupItemsRestored: 2,
        });
        expect(await listChannelOverrides(fresh.db, 'default')).toHaveLength(1);
        expect((await listCustomGroups(fresh.db, 'default'))[0]?.itemCount).toBe(2);

        // Restored custom channel name is immediately searchable (fast path dirtied on restore)
        const hits = await querySearch(fresh.db, 'my sports', { scope: 'live' });
        expect(hits.live.map((h) => ({ key: h.key, name: h.name }))).toEqual([
          { key: 'x:s1:live:1', name: 'My Sports' },
        ]);
      } finally {
        fresh.close();
      }
    } finally {
      close();
    }
  });

  it('preserves explicit cross-device custom group id (up to 128 chars, [A-Za-z0-9._:-]) and rejects invalid/duplicate ids', async () => {
    const { db, close } = await setup();
    try {
      const explicitId = `sync:grp_sports.1-${'x'.repeat(100)}`;
      expect(explicitId.length).toBe(118);

      const created = await createCustomGroup(
        db,
        { id: `  ${explicitId}  `, name: 'Synced Sports' },
        () => 5_000,
        () => 'should-not-be-used',
      );
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(created.value.id).toBe(explicitId);
        expect(parseCustomGroupCategoryId(customGroupCategoryId(created.value.id))).toBe(
          explicitId,
        );
      }

      // Duplicate explicit ID fails cleanly
      expect(
        await createCustomGroup(db, { id: explicitId, name: 'Duplicate' }, () => 5_100),
      ).toMatchObject({
        ok: false,
        error: { category: 'storage', code: 'custom-group-write-failed' },
      });

      // Invalid explicit IDs rejected
      for (const badId of ['', '   ', 'bad/id', 'bad id', 'g'.repeat(129)]) {
        expect(await createCustomGroup(db, { id: badId, name: 'Invalid ID' }, () => 5_200)).toEqual(
          {
            ok: false,
            error: { category: 'storage', code: 'invalid-custom-group-id' },
          },
        );
      }

      // Omitting id falls back to generated ID
      const fallback = await createCustomGroup(db, { name: 'Generated' }, () => 5_300);
      expect(fallback.ok).toBe(true);
      if (fallback.ok) {
        expect(fallback.value.id.startsWith('g_')).toBe(true);
      }
    } finally {
      close();
    }
  });
});
