import type { CatalogService } from '@elv/data';
import { elvError, err } from '@elv/domain';
import {
  type CatalogWaveQ7OpsRpcCall,
  WAVE_Q7_RPC_METHODS,
} from '../shared/catalog-ipc-guards-q7.ts';

/** Type guard distinguishing Wave Q7-B RPC calls inside the catalog worker runtime. */
export function isWaveQ7RpcCall(call: {
  readonly method: string;
}): call is CatalogWaveQ7OpsRpcCall {
  return WAVE_Q7_RPC_METHODS.has(call.method);
}

/** Dispatches all 8 Wave Q7-B recent-channel cleanup and Live TV favorite folder RPC calls to {@link CatalogService}. */
export function executeWaveQ7OpsRpcCall(
  service: CatalogService,
  call: CatalogWaveQ7OpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'removeRecentChannel':
      return service.removeRecentChannel
        ? service.removeRecentChannel(call.itemKey, call.profileId)
        : Promise.resolve(false);
    case 'clearRecentChannels':
      return service.clearRecentChannels
        ? service.clearRecentChannels(call.profileId)
        : Promise.resolve(0);
    case 'listLiveFavoriteFolders':
      return service.listLiveFavoriteFolders
        ? service.listLiveFavoriteFolders(call.profileId, call.opts)
        : Promise.resolve([]);
    case 'createLiveFavoriteFolder':
      return service.createLiveFavoriteFolder
        ? service.createLiveFavoriteFolder(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'renameLiveFavoriteFolder':
      return service.renameLiveFavoriteFolder
        ? service.renameLiveFavoriteFolder(call.id, call.name, call.profileId, call.opts)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'deleteLiveFavoriteFolder':
      return service.deleteLiveFavoriteFolder
        ? service.deleteLiveFavoriteFolder(call.id, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'assignLiveFavoriteFolder':
      return service.assignLiveFavoriteFolder
        ? service.assignLiveFavoriteFolder(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listLiveFavoriteFolderAssignments':
      return service.listLiveFavoriteFolderAssignments
        ? service.listLiveFavoriteFolderAssignments(call.profileId)
        : Promise.resolve([]);
  }
}
