import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import {
  assignLiveFavoriteFolder,
  createLiveFavoriteFolder,
  deleteLiveFavoriteFolder,
  listLiveFavoriteFolderAssignments,
  listLiveFavoriteFolders,
  renameLiveFavoriteFolder,
} from './live-favorite-folders-repo';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { updateParentalSettings } from './parental-repo';
import { createProfile, deleteProfile } from './profiles-repo';
import {
  clearRecentChannels,
  listRecentChannels,
  recordRecentChannel,
  removeRecentChannel,
} from './recent-channels-repo';
import { MIGRATIONS } from './schema';
import { removeSource } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { listFavoriteKeys, listFavorites, setFavorite, toggleFavorite } from './user-state';
import { createCoalescedCatalog } from './write-coalescer';

async function seedLiveSource(
  db: ReturnType<typeof testDb>['db'],
  sourceId: string,
  channels: ReadonlyArray<{ key: string; name: string; num: number; isHidden?: number }>,
) {
  await db.run(
    `INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, 'xtream', ?, 100, '{}')`,
    [sourceId, `Source ${sourceId}`],
  );
  for (const ch of channels) {
    await db.run(
      `INSERT INTO live (source_id, key, provider_id, name, name_fold, sort_title, num, is_hidden, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        sourceId,
        ch.key,
        String(ch.num),
        ch.name,
        ch.name.toLowerCase(),
        ch.name.toLowerCase(),
        ch.num,
        ch.isHidden ?? 0,
      ],
    );
  }
}

describe('Schema v26 Live TV Favorite Folders & Recent Channels Clear/Remove (Wave Q7-B)', () => {
  it('upgrades a v25 database to v26 creating live_favorite_folders and live_favorite_folder_items tables and indexes', async () => {
    const { db } = testDb();
    for (let i = 0; i < 25; i += 1) {
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec('PRAGMA user_version = 25');

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(26);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);

    const tables = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('live_favorite_folders', 'live_favorite_folder_items') ORDER BY name",
      )
    ).map((r) => r.name);
    expect(tables).toEqual(['live_favorite_folder_items', 'live_favorite_folders']);

    const indexes = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_live_fav_%' ORDER BY name",
      )
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_live_fav_folders_profile',
        'idx_live_fav_folder_items_folder',
        'idx_live_fav_folder_items_source',
      ]),
    );
  });

  it('supports CRUD, cross-source 1-folder move semantics, auto-star on assign, unfile, and folder delete preserving favorites', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await seedLiveSource(db, 's1', [
      { key: 'x:s1:live:1', name: 'Sports One', num: 1 },
      { key: 'x:s1:live:2', name: 'News One', num: 2 },
      { key: 'x:s1:live:3', name: 'Hidden Ch', num: 3, isHidden: 1 },
    ]);
    await seedLiveSource(db, 's2', [{ key: 'x:s2:live:10', name: 'Sports Two', num: 10 }]);

    const fSports = await createLiveFavoriteFolder(db, { name: 'Sports' }, 1_000);
    const fNews = await createLiveFavoriteFolder(db, { name: 'News' }, 1_100);
    expect(fSports.ok && fNews.ok).toBe(true);
    if (!fSports.ok || !fNews.ok) return;

    // Assign un-starred cross-source channels -> auto-stars them in favorites!
    const a1 = await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: fSports.value.id, title: 'Sports One' },
      2_000,
    );
    const a2 = await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s2:live:10', sourceId: 's2', folderId: fSports.value.id, title: 'Sports Two' },
      2_100,
    );
    expect(a1).toEqual({ ok: true, value: undefined });
    expect(a2).toEqual({ ok: true, value: undefined });
    expect(await listFavoriteKeys(db)).toEqual(['x:s1:live:1', 'x:s2:live:10']);

    let folders = await listLiveFavoriteFolders(db);
    expect(folders.map((f) => [f.name, f.itemCount])).toEqual([
      ['Sports', 2],
      ['News', 0],
    ]);

    // Hidden live channel does not inflate visible itemCount
    await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:3', sourceId: 's1', folderId: fSports.value.id, title: 'Hidden Ch' },
      2_200,
    );
    folders = await listLiveFavoriteFolders(db);
    expect(folders.find((f) => f.id === fSports.value.id)?.itemCount).toBe(2);

    // Move channel atomically from Sports -> News (1-folder-per-channel semantics)
    const moved = await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: fNews.value.id },
      2_300,
    );
    expect(moved).toEqual({ ok: true, value: undefined });
    expect(await listLiveFavoriteFolderAssignments(db)).toEqual(
      expect.arrayContaining([
        { itemKey: 'x:s1:live:1', folderId: fNews.value.id },
        { itemKey: 'x:s2:live:10', folderId: fSports.value.id },
      ]),
    );
    folders = await listLiveFavoriteFolders(db);
    expect(folders.map((f) => [f.name, f.itemCount])).toEqual([
      ['Sports', 1],
      ['News', 1],
    ]);

    // Move to Unfiled (folderId = null) keeps favorite active
    const unfiled = await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: null },
      2_400,
    );
    expect(unfiled).toEqual({ ok: true, value: undefined });
    expect(await listFavoriteKeys(db)).toContain('x:s1:live:1');
    expect(
      (await listLiveFavoriteFolderAssignments(db)).find((a) => a.itemKey === 'x:s1:live:1'),
    ).toBeUndefined();

    // Rename folder
    const renamed = await renameLiveFavoriteFolder(
      db,
      fSports.value.id,
      'Live Sports',
      undefined,
      2_500,
    );
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.value.name).toBe('Live Sports');
      expect(renamed.value.itemCount).toBe(1);
    }

    // Reject unsafe keys (URLs/credentials/control chars)
    const badKey = await assignLiveFavoriteFolder(
      db,
      { itemKey: 'http://user:pass@host/live.ts', sourceId: 's1', folderId: fSports.value.id },
      2_600,
    );
    expect(badKey.ok).toBe(false);

    // Deleting a folder unfiles its channels while preserving their favorites
    const del = await deleteLiveFavoriteFolder(db, fSports.value.id);
    expect(del).toEqual({ ok: true, value: undefined });
    expect(await listFavoriteKeys(db)).toContain('x:s2:live:10');
    expect(await listLiveFavoriteFolderAssignments(db)).toEqual([]);
  });

  it('automatically removes live_favorite_folder_items when unfavoriting via setFavorite or toggleFavorite', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await seedLiveSource(db, 's1', [
      { key: 'x:s1:live:1', name: 'Ch 1', num: 1 },
      { key: 'x:s1:live:2', name: 'Ch 2', num: 2 },
    ]);

    const f = await createLiveFavoriteFolder(db, { name: 'Main' }, 1_000);
    expect(f.ok).toBe(true);
    if (!f.ok) return;

    await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: f.value.id, title: 'Ch 1' },
      1_100,
    );
    await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:2', sourceId: 's1', folderId: f.value.id, title: 'Ch 2' },
      1_200,
    );
    expect(await listLiveFavoriteFolderAssignments(db)).toHaveLength(2);

    // Unfavorite via setFavorite(..., false)
    await setFavorite(
      db,
      { sourceId: 's1', itemKey: 'x:s1:live:1', kind: 'live', title: 'Ch 1' },
      false,
    );
    expect(await listLiveFavoriteFolderAssignments(db)).toEqual([
      { itemKey: 'x:s1:live:2', folderId: f.value.id },
    ]);

    // Unfavorite via toggleFavorite
    const toggled = await toggleFavorite(db, {
      sourceId: 's1',
      itemKey: 'x:s1:live:2',
      kind: 'live',
      title: 'Ch 2',
    });
    expect(toggled).toEqual({ ok: true, value: false });
    expect(await listLiveFavoriteFolderAssignments(db)).toEqual([]);
    expect((await listLiveFavoriteFolders(db))[0]?.itemCount).toBe(0);
  });

  it('isolates profiles and cascades deletes on removeSource and deleteProfile', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    await seedLiveSource(db, 's1', [{ key: 'x:s1:live:1', name: 'Ch 1', num: 1 }]);
    const kids = await createProfile(db, { name: 'Kids', avatarToken: 'amber', isKids: false });
    expect(kids.ok).toBe(true);
    if (!kids.ok) return;

    const fDefault = await createLiveFavoriteFolder(db, { name: 'Default Sports' }, 1_000);
    const fKids = await createLiveFavoriteFolder(
      db,
      { name: 'Kids Cartoons', profileId: kids.value.id },
      1_000,
    );
    expect(fDefault.ok && fKids.ok).toBe(true);
    if (!fDefault.ok || !fKids.ok) return;

    // Cross-profile assignment must fail
    const cross = await assignLiveFavoriteFolder(
      db,
      {
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        folderId: fKids.value.id,
        profileId: 'default',
      },
      1_100,
    );
    expect(cross.ok).toBe(false);

    await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: fDefault.value.id },
      1_100,
    );
    await assignLiveFavoriteFolder(
      db,
      {
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        folderId: fKids.value.id,
        profileId: kids.value.id,
      },
      1_100,
    );

    // Deleting kids profile removes its folders & assignments without touching default
    expect((await deleteProfile(db, secrets, kids.value.id)).ok).toBe(true);
    expect(await listLiveFavoriteFolders(db, kids.value.id)).toEqual([]);
    expect(await listLiveFavoriteFolderAssignments(db, kids.value.id)).toEqual([]);
    expect(await listLiveFavoriteFolderAssignments(db, 'default')).toHaveLength(1);

    // Removing source cleans up live_favorite_folder_items for that source
    expect((await removeSource('s1', { db, secrets, scheduler: countingScheduler() })).ok).toBe(
      true,
    );
    expect(await listLiveFavoriteFolderAssignments(db, 'default')).toEqual([]);
  });

  it('supports removeRecentChannel and clearRecentChannels with key validation and profile isolation', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await seedLiveSource(db, 's1', [
      { key: 'x:s1:live:1', name: 'Ch 1', num: 1 },
      { key: 'x:s1:live:2', name: 'Ch 2', num: 2 },
      { key: 'x:s1:live:3', name: 'Ch 3', num: 3 },
    ]);

    await recordRecentChannel(db, 'x:s1:live:1', 's1', 'default', 1_000);
    await recordRecentChannel(db, 'x:s1:live:2', 's1', 'default', 2_000);
    await recordRecentChannel(db, 'x:s1:live:3', 's1', 'default', 3_000);
    await recordRecentChannel(db, 'x:s1:live:1', 's1', 'kids', 4_000);

    // Invalid key returns false safely
    expect(await removeRecentChannel(db, 'http://secret@host/live', 'default')).toBe(false);
    expect(await removeRecentChannel(db, 'x:s1:live:999', 'default')).toBe(false);

    // Remove single recent channel from default profile
    expect(await removeRecentChannel(db, 'x:s1:live:2', 'default')).toBe(true);
    expect((await listRecentChannels(db, 10, 'default')).map((c) => c.key)).toEqual([
      'x:s1:live:3',
      'x:s1:live:1',
    ]);
    // Kids untouched
    expect((await listRecentChannels(db, 10, 'kids')).map((c) => c.key)).toEqual(['x:s1:live:1']);

    // Clear all recent channels for default profile
    expect(await clearRecentChannels(db, 'default')).toBe(2);
    expect(await clearRecentChannels(db, 'default')).toBe(0);
    expect(await listRecentChannels(db, 10, 'default')).toEqual([]);
    // Kids still untouched
    expect((await listRecentChannels(db, 10, 'kids')).map((c) => c.key)).toEqual(['x:s1:live:1']);
  });

  it('exposes recent-channel remove/clear and live favorite folder ops through CatalogService and createCoalescedCatalog', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await seedLiveSource(db, 's1', [{ key: 'x:s1:live:1', name: 'Ch 1', num: 1 }]);

    const raw = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: { get: async () => ({ ok: false, error: { category: 'network', code: 'offline' } }) },
      clock: () => 5_000,
    });
    const service = createCoalescedCatalog(raw, { windowMs: 25 });

    await service.recordRecentChannel?.('x:s1:live:1', 's1');
    expect(await service.removeRecentChannel?.('x:s1:live:1')).toBe(true);
    await service.recordRecentChannel?.('x:s1:live:1', 's1');
    expect(await service.clearRecentChannels?.()).toBe(1);

    const created = await service.createLiveFavoriteFolder?.({ name: 'Favorites A' });
    expect(created?.ok).toBe(true);
    if (!created?.ok) return;

    // Schedule a coalesced unfavorite after assigning -> coalescer must flush fav prefix properly!
    await service.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: created.value.id,
      title: 'Ch 1',
    });
    expect((await service.listLiveFavoriteFolders?.())?.[0]?.itemCount).toBe(1);
    expect(await service.listLiveFavoriteFolderAssignments?.()).toEqual([
      { itemKey: 'x:s1:live:1', folderId: created.value.id },
    ]);

    void service.setFavorite?.(
      { sourceId: 's1', itemKey: 'x:s1:live:1', kind: 'live', title: 'Ch 1' },
      false,
    );
    // Reading folders flushes pending favorite writes before querying
    expect((await service.listLiveFavoriteFolders?.())?.[0]?.itemCount).toBe(0);
    expect(await service.listLiveFavoriteFolderAssignments?.()).toEqual([]);
    expect(await listFavorites(db, 10)).toEqual([]);

    await service.close();
  });

  it('MINOR-13: renameLiveFavoriteFolder applies active parental filter to returned itemCount and respects parentalUnlocked', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await seedLiveSource(db, 's1', [
      { key: 'x:s1:live:1', name: 'Family News', num: 1 },
      { key: 'x:s1:live:2', name: 'Adult Late Night XXX', num: 2 },
    ]);

    const created = await createLiveFavoriteFolder(db, { name: 'Mix' }, 1_000);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: created.value.id },
      1_100,
    );
    await assignLiveFavoriteFolder(
      db,
      { itemKey: 'x:s1:live:2', sourceId: 's1', folderId: created.value.id },
      1_200,
    );

    await updateParentalSettings(
      db,
      'default',
      { enabled: true, blockAdultKeywords: true },
      () => 1_300,
    );

    const lockedRename = await renameLiveFavoriteFolder(
      db,
      created.value.id,
      'Mix Locked',
      'default',
      1_400,
    );
    expect(lockedRename.ok).toBe(true);
    if (lockedRename.ok) {
      expect(lockedRename.value.itemCount).toBe(1);
    }

    const unlockedRename = await renameLiveFavoriteFolder(
      db,
      created.value.id,
      'Mix Unlocked',
      'default',
      1_500,
      { parentalUnlocked: true },
    );
    expect(unlockedRename.ok).toBe(true);
    if (unlockedRename.ok) {
      expect(unlockedRename.value.itemCount).toBe(2);
    }
  });
});
