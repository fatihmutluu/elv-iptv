import type { Result } from '@elv/domain';
import type { CatalogRpcMethodCall } from '../shared/catalog-ipc.ts';
import type { CatalogBridgeWaveQ7Ops } from '../shared/catalog-ipc-guards-q7.ts';

/** Builds preload bridge delegates for Wave Q7-B recent-channel cleanup and Live TV favorite folders. */
export function createCatalogBridgeWaveQ7Ops(
  callResult: <T>(call: CatalogRpcMethodCall) => Promise<Result<T>>,
  callValue: <T>(call: CatalogRpcMethodCall) => Promise<T>,
  notifyOnOk: <T>(promise: Promise<Result<T>>) => Promise<Result<T>>,
  emitChanged: () => void,
): Required<CatalogBridgeWaveQ7Ops> {
  return {
    removeRecentChannel: (itemKey, profileId) =>
      callValue<boolean>({
        method: 'removeRecentChannel',
        itemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }).then((removed) => {
        if (removed) emitChanged();
        return removed;
      }),
    clearRecentChannels: (profileId) =>
      callValue<number>({
        method: 'clearRecentChannels',
        ...(profileId === undefined ? {} : { profileId }),
      }).then((count) => {
        if (count > 0) emitChanged();
        return count;
      }),
    listLiveFavoriteFolders: (profileId, opts) =>
      callValue({
        method: 'listLiveFavoriteFolders',
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    createLiveFavoriteFolder: (input) =>
      notifyOnOk(callResult({ method: 'createLiveFavoriteFolder', input })),
    renameLiveFavoriteFolder: (id, name, profileId, opts) =>
      notifyOnOk(
        callResult({
          method: 'renameLiveFavoriteFolder',
          id,
          name,
          ...(profileId === undefined ? {} : { profileId }),
          ...(opts === undefined ? {} : { opts }),
        }),
      ),
    deleteLiveFavoriteFolder: (id, profileId) =>
      notifyOnOk(
        callResult({
          method: 'deleteLiveFavoriteFolder',
          id,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
    assignLiveFavoriteFolder: (input) =>
      notifyOnOk(callResult({ method: 'assignLiveFavoriteFolder', input })),
    listLiveFavoriteFolderAssignments: (profileId) =>
      callValue({
        method: 'listLiveFavoriteFolderAssignments',
        ...(profileId === undefined ? {} : { profileId }),
      }),
  };
}
