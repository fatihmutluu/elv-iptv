import {
  DEFAULT_PROFILE_ID,
  type LiveFavoriteFolderAssignment,
  type LiveFavoriteFolderRecord,
  sourceOfKey,
} from '@elv/data';
import type { Result } from '@elv/domain';
import type { SyncLiveFavoriteFolder, VaultSnapshot } from '@elv/sync';
import type { CatalogRpcMethodCall } from '../../shared/catalog-ipc.ts';

type SnapshotRpcCaller = <R>(rpc: CatalogRpcMethodCall) => Promise<R>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function groupFoldersByProfile(
  items: readonly SyncLiveFavoriteFolder[],
): Map<string, SyncLiveFavoriteFolder[]> {
  const byProfile = new Map<string, SyncLiveFavoriteFolder[]>();
  for (const item of items) {
    const pid =
      item.profileId !== undefined && item.profileId.length > 0
        ? item.profileId
        : DEFAULT_PROFILE_ID;
    const list = byProfile.get(pid);
    if (list === undefined) byProfile.set(pid, [item]);
    else list.push(item);
  }
  return byProfile;
}

function buildDeletedFavoriteKeysByProfile(
  favorites: VaultSnapshot['favorites'],
): Map<string, Set<string>> {
  const byProfile = new Map<string, Set<string>>();
  for (const fav of favorites) {
    if (fav.deleted !== true) continue;
    const pid =
      fav.profileId !== undefined && fav.profileId.length > 0 ? fav.profileId : DEFAULT_PROFILE_ID;
    let set = byProfile.get(pid);
    if (set === undefined) {
      set = new Set<string>();
      byProfile.set(pid, set);
    }
    set.add(fav.key);
  }
  return byProfile;
}

/**
 * Applies synced `liveFavoriteFolders` onto the Desktop catalog worker via RPC:
 * processes tombstones strictly by ID, sorts active folders by `(sortOrder ASC, id ASC)`,
 * keeps local ID/name maps synchronized across mutations, and skips channels deleted in
 * `snapshot.favorites` so concurrent folder edits never resurrect unfavorited channels.
 */
export async function applyDesktopLiveFavoriteFolders(
  snapshot: VaultSnapshot,
  call: SnapshotRpcCaller,
): Promise<boolean> {
  if (snapshot.liveFavoriteFolders === undefined || snapshot.liveFavoriteFolders.length === 0) {
    return false;
  }
  let mutated = false;
  const deletedFavoritesByProfile = buildDeletedFavoriteKeysByProfile(snapshot.favorites);

  for (const [pid, folderGroup] of groupFoldersByProfile(snapshot.liveFavoriteFolders)) {
    const pidOpt = pid === DEFAULT_PROFILE_ID ? {} : { profileId: pid };
    const deletedFavoriteKeys = deletedFavoritesByProfile.get(pid);
    const [existingFolders, existingAssignments] = await Promise.all([
      call<unknown>({
        method: 'listLiveFavoriteFolders',
        ...pidOpt,
        opts: { parentalUnlocked: true },
      })
        .then((r) => asArray<LiveFavoriteFolderRecord>(r))
        .catch(() => [] as LiveFavoriteFolderRecord[]),
      call<unknown>({
        method: 'listLiveFavoriteFolderAssignments',
        ...pidOpt,
      })
        .then((r) => asArray<LiveFavoriteFolderAssignment>(r))
        .catch(() => [] as LiveFavoriteFolderAssignment[]),
    ]);

    const folderById = new Map(existingFolders.map((f) => [f.id, f]));
    const folderByName = new Map(existingFolders.map((f) => [f.name.toLowerCase(), f]));
    const currentFolderByKey = new Map(existingAssignments.map((a) => [a.itemKey, a.folderId]));
    const desiredOwnerByKey = new Map<string, { folderId: string; updatedAt: number }>();

    const tombstones = folderGroup.filter((f) => f.deleted === true);
    const activeFolders = folderGroup
      .filter((f) => f.deleted !== true)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

    for (const folder of tombstones) {
      const existing = folderById.get(folder.id);
      if (existing === undefined || folder.updatedAt < existing.updatedAt) continue;
      const del = await call<Result<void>>({
        method: 'deleteLiveFavoriteFolder',
        id: existing.id,
        ...pidOpt,
      }).catch(() => null);
      if (del?.ok) {
        mutated = true;
        folderById.delete(existing.id);
        if (folderByName.get(existing.name.toLowerCase())?.id === existing.id) {
          folderByName.delete(existing.name.toLowerCase());
        }
        for (const [key, fid] of currentFolderByKey.entries()) {
          if (fid === existing.id) currentFolderByKey.delete(key);
        }
      }
    }

    for (const folder of activeFolders) {
      const existing = folderById.get(folder.id) ?? folderByName.get(folder.name.toLowerCase());
      let targetFolderId = existing?.id;
      if (existing === undefined) {
        const created = await call<Result<LiveFavoriteFolderRecord>>({
          method: 'createLiveFavoriteFolder',
          input: { id: folder.id, name: folder.name, ...pidOpt },
        }).catch(() => null);
        if (created?.ok) {
          targetFolderId = created.value.id;
          folderById.set(created.value.id, created.value);
          folderByName.set(created.value.name.toLowerCase(), created.value);
          mutated = true;
        }
      } else if (existing.name !== folder.name && folder.updatedAt > existing.updatedAt) {
        const renamed = await call<Result<LiveFavoriteFolderRecord>>({
          method: 'renameLiveFavoriteFolder',
          id: existing.id,
          name: folder.name,
          ...pidOpt,
        }).catch(() => null);
        if (renamed?.ok) {
          if (folderByName.get(existing.name.toLowerCase())?.id === existing.id) {
            folderByName.delete(existing.name.toLowerCase());
          }
          folderById.set(renamed.value.id, renamed.value);
          folderByName.set(renamed.value.name.toLowerCase(), renamed.value);
          mutated = true;
        }
      }

      if (
        targetFolderId !== undefined &&
        (existing === undefined || folder.updatedAt >= existing.updatedAt)
      ) {
        const desiredInThisFolder = new Set<string>();
        for (const key of folder.channelKeys) {
          if (deletedFavoriteKeys?.has(key)) continue;
          desiredInThisFolder.add(key);
          const prevDesired = desiredOwnerByKey.get(key);
          if (prevDesired === undefined || folder.updatedAt >= prevDesired.updatedAt) {
            desiredOwnerByKey.set(key, { folderId: targetFolderId, updatedAt: folder.updatedAt });
          }
        }
        for (const [key, curFolderId] of [...currentFolderByKey.entries()]) {
          if (curFolderId !== targetFolderId || desiredInThisFolder.has(key)) continue;
          const sid = sourceOfKey(key);
          if (sid === undefined) continue;
          const unfiled = await call<Result<void>>({
            method: 'assignLiveFavoriteFolder',
            input: { itemKey: key, sourceId: sid, folderId: null, ...pidOpt },
          }).catch(() => null);
          if (unfiled?.ok) {
            currentFolderByKey.delete(key);
            mutated = true;
          }
        }
      }
    }

    for (const [itemKey, desired] of desiredOwnerByKey.entries()) {
      if (deletedFavoriteKeys?.has(itemKey)) continue;
      if (currentFolderByKey.get(itemKey) === desired.folderId) continue;
      const sourceId = sourceOfKey(itemKey);
      if (sourceId === undefined) continue;
      const assigned = await call<Result<void>>({
        method: 'assignLiveFavoriteFolder',
        input: { itemKey, sourceId, folderId: desired.folderId, ...pidOpt },
      }).catch(() => null);
      if (assigned?.ok) {
        currentFolderByKey.set(itemKey, desired.folderId);
        mutated = true;
      }
    }
  }

  return mutated;
}
