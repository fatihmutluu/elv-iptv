import type { CatalogService, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createProfileScopedCatalog } from './profile-scoped-catalog';

describe('createProfileScopedCatalog Wave Q7-B recent cleanup & live favorite folders', () => {
  const sources: readonly SourceRow[] = [
    { id: 's1', kind: 'xtream', name: 'A', createdAt: 1, needsImport: false },
    {
      id: 's2',
      kind: 'xtream',
      name: 'Excluded',
      createdAt: 2,
      needsImport: false,
      excludedProfileIds: ['kids'],
    },
  ];

  it('scopes profileId, enforces fail-closed on parentalLoadError, and filters excluded sources from folder assignments', async () => {
    const removeRecentChannel = vi.fn(async () => true);
    const clearRecentChannels = vi.fn(async () => 3);
    const listLiveFavoriteFolders = vi.fn(async () => [
      {
        id: 'lff_1',
        profileId: 'kids',
        name: 'Cartoons',
        sortOrder: 0,
        itemCount: 1,
        createdAt: 100,
        updatedAt: 100,
      },
    ]);
    const createLiveFavoriteFolder = vi.fn(async () =>
      ok({
        id: 'lff_2',
        profileId: 'kids',
        name: 'New',
        sortOrder: 1,
        itemCount: 0,
        createdAt: 200,
        updatedAt: 200,
      }),
    );
    const renameLiveFavoriteFolder = vi.fn(async () =>
      ok({
        id: 'lff_1',
        profileId: 'kids',
        name: 'Kids',
        sortOrder: 0,
        itemCount: 1,
        createdAt: 100,
        updatedAt: 300,
      }),
    );
    const deleteLiveFavoriteFolder = vi.fn(async () => ok(undefined));
    const assignLiveFavoriteFolder = vi.fn(async () => ok(undefined));
    const listLiveFavoriteFolderAssignments = vi.fn(async () => [
      { itemKey: 'x:s1:live:1', folderId: 'lff_1' },
      { itemKey: 'x:s2:live:2', folderId: 'lff_1' },
    ]);

    const base = {
      listSources: vi.fn(async () => [...sources]),
      removeRecentChannel,
      clearRecentChannels,
      listLiveFavoriteFolders,
      createLiveFavoriteFolder,
      renameLiveFavoriteFolder,
      deleteLiveFavoriteFolder,
      assignLiveFavoriteFolder,
      listLiveFavoriteFolderAssignments,
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    let parentalLoadError = false;
    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'kids',
      parentalUnlocked: false,
      parentalLoadError,
      sources,
    }));

    expect(await scoped.removeRecentChannel?.('x:s1:live:1')).toBe(true);
    expect(removeRecentChannel).toHaveBeenCalledWith('x:s1:live:1', 'kids');

    expect(await scoped.clearRecentChannels?.()).toBe(3);
    expect(clearRecentChannels).toHaveBeenCalledWith('kids');

    expect(await scoped.listLiveFavoriteFolders?.()).toHaveLength(1);
    expect(listLiveFavoriteFolders).toHaveBeenCalledWith('kids', { parentalUnlocked: false });

    await scoped.createLiveFavoriteFolder?.({ name: 'New' });
    expect(createLiveFavoriteFolder).toHaveBeenCalledWith({ name: 'New', profileId: 'kids' });

    await scoped.renameLiveFavoriteFolder?.('lff_1', 'Kids');
    expect(renameLiveFavoriteFolder).toHaveBeenCalledWith('lff_1', 'Kids', 'kids', {
      parentalUnlocked: false,
    });

    await scoped.deleteLiveFavoriteFolder?.('lff_1');
    expect(deleteLiveFavoriteFolder).toHaveBeenCalledWith('lff_1', 'kids');

    await scoped.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: 'lff_1',
    });
    expect(assignLiveFavoriteFolder).toHaveBeenCalledWith({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: 'lff_1',
      profileId: 'kids',
    });

    // Excluded source s2 is filtered out of assignments AND folder itemCount!
    expect(await scoped.listLiveFavoriteFolderAssignments?.()).toEqual([
      { itemKey: 'x:s1:live:1', folderId: 'lff_1' },
    ]);

    // MINOR-13: listLiveFavoriteFolders recomputes itemCount using excluded-source-filtered assignments
    listLiveFavoriteFolders.mockResolvedValueOnce([
      {
        id: 'lff_1',
        profileId: 'kids',
        name: 'Cartoons',
        sortOrder: 0,
        itemCount: 2,
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 'lff_only_excluded',
        profileId: 'kids',
        name: 'Only Excluded',
        sortOrder: 1,
        itemCount: 1,
        createdAt: 150,
        updatedAt: 150,
      },
    ]);
    listLiveFavoriteFolderAssignments.mockResolvedValueOnce([
      { itemKey: 'x:s1:live:1', folderId: 'lff_1' },
      { itemKey: 'x:s2:live:2', folderId: 'lff_1' },
      { itemKey: 'x:s2:live:3', folderId: 'lff_only_excluded' },
    ]);
    const filteredFolders = await scoped.listLiveFavoriteFolders?.();
    expect(filteredFolders?.map((f) => [f.id, f.itemCount])).toEqual([
      ['lff_1', 1],
      ['lff_only_excluded', 0],
    ]);

    // Fail-closed when parentalLoadError is true
    parentalLoadError = true;
    expect(await scoped.listLiveFavoriteFolders?.()).toEqual([]);
    expect(await scoped.listLiveFavoriteFolderAssignments?.()).toEqual([]);
  });
});
