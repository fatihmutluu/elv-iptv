import type { CatalogService } from '@elv/data';
import { elvError, err } from '@elv/domain';
import type { CatalogFailoverOpsRpcCall } from '../shared/catalog-ipc-failover-guards.ts';

/** Dispatches all 11 Wave F5A multi-source failover group and stream outcome RPC calls to {@link CatalogService} (`#157`, `#317`). */
export function executeFailoverOpsRpcCall(
  service: CatalogService,
  call: CatalogFailoverOpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'listFailoverGroups':
      return service.listFailoverGroups ? service.listFailoverGroups() : Promise.resolve([]);
    case 'getFailoverGroupByChannel':
      return service.getFailoverGroupByChannel
        ? service.getFailoverGroupByChannel(call.channelKey)
        : Promise.resolve(undefined);
    case 'createFailoverGroup':
      return service.createFailoverGroup
        ? service.createFailoverGroup(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'renameFailoverGroup':
      return service.renameFailoverGroup
        ? service.renameFailoverGroup(call.groupId, call.name)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'deleteFailoverGroup':
      return service.deleteFailoverGroup
        ? service.deleteFailoverGroup(call.groupId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'addFailoverGroupMember':
      return service.addFailoverGroupMember
        ? service.addFailoverGroupMember(call.groupId, call.channelKey)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'removeFailoverGroupMember':
      return service.removeFailoverGroupMember
        ? service.removeFailoverGroupMember(call.groupId, call.channelKey)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'reorderFailoverGroupMembers':
      return service.reorderFailoverGroupMembers
        ? service.reorderFailoverGroupMembers(call.groupId, call.orderedChannelKeys)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'suggestFailoverGroups':
      return service.suggestFailoverGroups ? service.suggestFailoverGroups() : Promise.resolve([]);
    case 'applySuggestedFailoverGroups':
      return service.applySuggestedFailoverGroups
        ? service.applySuggestedFailoverGroups(call.clusters)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'reportStreamOutcome':
      service.reportStreamOutcome?.(call.sourceId, call.serverUrl, call.succeeded);
      return Promise.resolve(undefined);
  }
}
