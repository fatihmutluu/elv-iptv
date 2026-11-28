import type { CatalogService } from '@elv/data';
import {
  type CatalogWaveR3OpsRpcCall,
  WAVE_R3_RPC_METHODS,
} from '../shared/catalog-ipc-wave-r3-guards.ts';

/** Type guard distinguishing Wave R3 recommendation dismissal RPC calls inside the catalog worker runtime. */
export function isWaveR3RpcCall(call: {
  readonly method: string;
}): call is CatalogWaveR3OpsRpcCall {
  return WAVE_R3_RPC_METHODS.has(call.method);
}

/** Dispatches Wave R3 recommendation dismissal RPC calls to {@link CatalogService}. */
export function executeWaveR3OpsRpcCall(
  service: CatalogService,
  call: CatalogWaveR3OpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'dismissRecommendation':
      return service.dismissRecommendation
        ? service.dismissRecommendation(call.itemKey, call.kind, call.profileId)
        : Promise.resolve();
    case 'restoreRecommendation':
      return service.restoreRecommendation
        ? service.restoreRecommendation(call.itemKey, call.profileId)
        : Promise.resolve();
    case 'listDismissedRecommendationKeys':
      return service.listDismissedRecommendationKeys
        ? service.listDismissedRecommendationKeys(call.profileId)
        : Promise.resolve([]);
  }
}
