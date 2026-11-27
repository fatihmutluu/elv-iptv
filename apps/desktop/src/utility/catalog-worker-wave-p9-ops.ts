import type { CatalogService } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import {
  type CatalogWaveP9OpsRpcCall,
  WAVE_P9_RPC_METHODS,
} from '../shared/catalog-ipc-wave-p9-guards.ts';

/** Narrowing type guard for Wave P9 sync-state RPC calls inside the catalog worker runtime. */
export function isWaveP9RpcCall(call: { method: string }): call is CatalogWaveP9OpsRpcCall {
  return WAVE_P9_RPC_METHODS.has(call.method);
}

/** Dispatches Wave P9 sync-state RPC calls to {@link CatalogService} (`#510`). */
export function executeWaveP9OpsRpcCall(
  service: CatalogService,
  call: CatalogWaveP9OpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'listAllWatchProgress':
      return service.listAllWatchProgress
        ? service.listAllWatchProgress(call.profileId, call.limit)
        : Promise.resolve([]);
    case 'listContinueWatchingDismissals':
      return service.listContinueWatchingDismissals
        ? service.listContinueWatchingDismissals(call.profileId)
        : Promise.resolve([]);
    case 'setContinueWatchingDismissal':
      return service.setContinueWatchingDismissal
        ? service.setContinueWatchingDismissal(call.input, call.deleted)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listCollectionRawItemKeys':
      return service.listCollectionRawItemKeys
        ? service.listCollectionRawItemKeys(call.collectionId, call.profileId)
        : Promise.resolve([]);
    case 'listSourceRecords':
      return service.listSourceRecords ? service.listSourceRecords() : Promise.resolve([]);
    case 'applyWatchedEpisodeBitfield':
      return service.applyWatchedEpisodeBitfield
        ? service.applyWatchedEpisodeBitfield(call.input)
        : Promise.resolve(ok(0));
  }
}
