import type { CatalogService } from '@elv/data';
import { elvError, err } from '@elv/domain';
import type { CatalogRpcMethodCall } from '../shared/catalog-ipc.ts';

/** Subset of {@link CatalogRpcMethodCall} for Wave F2 channel override and custom group RPCs (`#60`). */
export type CatalogChannelOpsRpcCall = Extract<
  CatalogRpcMethodCall,
  {
    method:
      | 'listChannelOverrides'
      | 'setChannelOverride'
      | 'clearChannelOverride'
      | 'reorderChannels'
      | 'listCustomGroups'
      | 'createCustomGroup'
      | 'updateCustomGroup'
      | 'deleteCustomGroup'
      | 'setCustomGroupItems'
      | 'addChannelToCustomGroup'
      | 'removeChannelFromCustomGroup';
  }
>;

/** Dispatches Wave F2 channel override and custom group RPC calls to {@link CatalogService} (`#60`). */
export function executeChannelOpsRpcCall(
  service: CatalogService,
  call: CatalogChannelOpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'listChannelOverrides':
      return service.listChannelOverrides
        ? service.listChannelOverrides(call.profileId)
        : Promise.resolve([]);
    case 'setChannelOverride':
      return service.setChannelOverride
        ? service.setChannelOverride(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'clearChannelOverride':
      return service.clearChannelOverride
        ? service.clearChannelOverride(call.itemKey, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'reorderChannels':
      return service.reorderChannels
        ? service.reorderChannels(call.itemKeys, call.sourceId, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listCustomGroups':
      return service.listCustomGroups
        ? service.listCustomGroups(call.profileId, call.opts)
        : Promise.resolve([]);
    case 'createCustomGroup':
      return service.createCustomGroup
        ? service.createCustomGroup(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'updateCustomGroup':
      return service.updateCustomGroup
        ? service.updateCustomGroup(call.groupId, call.patch)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'deleteCustomGroup':
      return service.deleteCustomGroup
        ? service.deleteCustomGroup(call.groupId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'setCustomGroupItems':
      return service.setCustomGroupItems
        ? service.setCustomGroupItems(call.groupId, call.items)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'addChannelToCustomGroup':
      return service.addChannelToCustomGroup
        ? service.addChannelToCustomGroup(call.groupId, call.itemKey, call.sourceId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'removeChannelFromCustomGroup':
      return service.removeChannelFromCustomGroup
        ? service.removeChannelFromCustomGroup(call.groupId, call.itemKey)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
  }
}
