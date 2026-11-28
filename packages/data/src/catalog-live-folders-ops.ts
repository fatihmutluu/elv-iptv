import type { Result, SqlDriver } from '@elv/domain';
import {
  type AssignLiveFavoriteFolderInput,
  assignLiveFavoriteFolder,
  type CreateLiveFavoriteFolderInput,
  createLiveFavoriteFolder,
  deleteLiveFavoriteFolder,
  type LiveFavoriteFolderAssignment,
  type LiveFavoriteFolderRecord,
  listLiveFavoriteFolderAssignments,
  listLiveFavoriteFolders,
  renameLiveFavoriteFolder,
} from './live-favorite-folders-repo';
import { clearRecentChannels, removeRecentChannel } from './recent-channels-repo';

/** Wave Q7-B Live TV favorite folders & recent-channel removal/clear subset of `CatalogService`. */
export interface CatalogLiveFoldersOpsMethods {
  removeRecentChannel(itemKey: string, profileId?: string): Promise<boolean>;
  clearRecentChannels(profileId?: string): Promise<number>;
  listLiveFavoriteFolders(
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<LiveFavoriteFolderRecord[]>;
  createLiveFavoriteFolder(
    input: CreateLiveFavoriteFolderInput,
  ): Promise<Result<LiveFavoriteFolderRecord>>;
  renameLiveFavoriteFolder(
    id: string,
    name: string,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<Result<LiveFavoriteFolderRecord>>;
  deleteLiveFavoriteFolder(id: string, profileId?: string): Promise<Result<void>>;
  assignLiveFavoriteFolder(input: AssignLiveFavoriteFolderInput): Promise<Result<void>>;
  listLiveFavoriteFolderAssignments(profileId?: string): Promise<LiveFavoriteFolderAssignment[]>;
}

/** @internal Creates Wave Q7-B Live TV favorite folder and recent-channel cleanup methods for `CatalogService`. */
export function createCatalogLiveFoldersOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  syncUserData: () => Promise<void> | undefined;
}): CatalogLiveFoldersOpsMethods {
  const { db, clock, syncUserData } = deps;

  return {
    async removeRecentChannel(itemKey, profileId) {
      const removed = await removeRecentChannel(db, itemKey, profileId);
      if (removed) await syncUserData();
      return removed;
    },
    async clearRecentChannels(profileId) {
      const count = await clearRecentChannels(db, profileId);
      if (count > 0) await syncUserData();
      return count;
    },
    listLiveFavoriteFolders: (profileId, opts) => listLiveFavoriteFolders(db, profileId, opts),
    async createLiveFavoriteFolder(input) {
      const created = await createLiveFavoriteFolder(db, input, clock());
      if (created.ok) await syncUserData();
      return created;
    },
    async renameLiveFavoriteFolder(id, name, profileId, opts) {
      const renamed = await renameLiveFavoriteFolder(db, id, name, profileId, clock(), opts);
      if (renamed.ok) await syncUserData();
      return renamed;
    },
    async deleteLiveFavoriteFolder(id, profileId) {
      const deleted = await deleteLiveFavoriteFolder(db, id, profileId);
      if (deleted.ok) await syncUserData();
      return deleted;
    },
    async assignLiveFavoriteFolder(input) {
      const assigned = await assignLiveFavoriteFolder(db, input, clock());
      if (assigned.ok) await syncUserData();
      return assigned;
    },
    listLiveFavoriteFolderAssignments: (profileId) =>
      listLiveFavoriteFolderAssignments(db, profileId),
  };
}
