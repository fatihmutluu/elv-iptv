import type { CatalogService } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { wrapCatalogForSyncDirty } from './app-shell-sync-hooks';

describe('wrapCatalogForSyncDirty Live Favorite Folder mutations (BLOCKER-4)', () => {
  it('invokes onSyncDirty after successful create/rename/delete/assign Live Favorite Folder calls and ignores failed Results', async () => {
    const onSyncDirty = vi.fn();
    const folder = {
      id: 'lff_1',
      profileId: 'default',
      name: 'Sports',
      sortOrder: 0,
      itemCount: 0,
      createdAt: 100,
      updatedAt: 100,
    };
    const base = {
      createLiveFavoriteFolder: vi
        .fn()
        .mockResolvedValueOnce(ok(folder))
        .mockResolvedValueOnce(err(elvError('storage', 'folder-already-exists'))),
      renameLiveFavoriteFolder: vi.fn().mockResolvedValue(ok({ ...folder, name: 'Live Sports' })),
      deleteLiveFavoriteFolder: vi.fn().mockResolvedValue(ok(undefined)),
      assignLiveFavoriteFolder: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as CatalogService;

    const wrapped = wrapCatalogForSyncDirty(base, onSyncDirty);

    await wrapped.createLiveFavoriteFolder?.({ name: 'Sports' });
    expect(onSyncDirty).toHaveBeenCalledTimes(1);

    // Failed Result must not mark sync dirty
    await wrapped.createLiveFavoriteFolder?.({ name: 'Sports' });
    expect(onSyncDirty).toHaveBeenCalledTimes(1);

    await wrapped.renameLiveFavoriteFolder?.('lff_1', 'Live Sports');
    expect(onSyncDirty).toHaveBeenCalledTimes(2);

    await wrapped.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: 'lff_1',
    });
    expect(onSyncDirty).toHaveBeenCalledTimes(3);

    await wrapped.deleteLiveFavoriteFolder?.('lff_1');
    expect(onSyncDirty).toHaveBeenCalledTimes(4);
  });
});
