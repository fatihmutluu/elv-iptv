import type { CatalogRpcMethodCall } from '../shared/catalog-ipc.ts';
import type { CatalogBridgeWaveR3Ops } from '../shared/catalog-ipc-wave-r3-guards.ts';

/** Builds preload bridge delegates for Wave R3 recommendation dismissals without emitting global cache wipes. */
export function createCatalogBridgeWaveR3Ops(
  callValue: <T>(call: CatalogRpcMethodCall) => Promise<T>,
): Required<CatalogBridgeWaveR3Ops> {
  return {
    dismissRecommendation: (itemKey, kind, profileId) =>
      callValue<void>({
        method: 'dismissRecommendation',
        itemKey,
        kind,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    restoreRecommendation: (itemKey, profileId) =>
      callValue<void>({
        method: 'restoreRecommendation',
        itemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    listDismissedRecommendationKeys: (profileId) =>
      callValue<readonly string[]>({
        method: 'listDismissedRecommendationKeys',
        ...(profileId === undefined ? {} : { profileId }),
      }),
  };
}
