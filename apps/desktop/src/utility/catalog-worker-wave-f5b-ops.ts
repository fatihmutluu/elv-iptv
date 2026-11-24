import type { AddSourceInput, CatalogService, StalkerSourceInput } from '@elv/data';
import { elvError, err, normalizeMacAddress, ok, type Result } from '@elv/domain';
import type { CatalogEpgOpsRpcCall } from '../shared/catalog-ipc-epg-guards.ts';
import { hasControlChar, isStalkerPortalUrl } from '../shared/catalog-ipc-guards.ts';
import {
  type CatalogWaveF5bOpsRpcCall,
  WAVE_F5B_RPC_METHODS,
} from '../shared/catalog-ipc-wave-f5b-guards.ts';

const MAX_STALKER_SERIAL_CHARS = 128;

/** Sanitizes a `'stalker'` {@link AddSourceInput} before passing to `CatalogService.addSource` (`#29`). */
export function sanitizeStalkerSourceInput(
  input: { kind: 'stalker' } & StalkerSourceInput,
  guideUrl: string | undefined,
): Result<AddSourceInput> {
  const portalUrl = input.portalUrl.trim();
  if (!isStalkerPortalUrl(portalUrl)) {
    return err(elvError('source-format', 'invalid-portal-url'));
  }
  const macRes = normalizeMacAddress(input.mac);
  if (!macRes.ok) return macRes;
  const serialNumber = input.serialNumber?.trim();
  if (
    serialNumber !== undefined &&
    (serialNumber.length > MAX_STALKER_SERIAL_CHARS || hasControlChar(serialNumber))
  ) {
    return err(elvError('source-format', 'invalid-source'));
  }
  const { guideUrl: _prevGuide, serialNumber: _prevSerial, ...rest } = input;
  return ok({
    ...rest,
    portalUrl,
    mac: macRes.value,
    ...(serialNumber !== undefined && serialNumber !== '' ? { serialNumber } : {}),
    ...(guideUrl === undefined ? {} : { guideUrl }),
  });
}

/** Type guard distinguishing Wave F5B RPC calls from EPG ops inside the catalog worker runtime. */
export function isWaveF5bRpcCall(
  call: CatalogEpgOpsRpcCall | CatalogWaveF5bOpsRpcCall,
): call is CatalogWaveF5bOpsRpcCall {
  return WAVE_F5B_RPC_METHODS.has(call.method);
}

/** Dispatches all 12 Wave F5B VOD enrichment & custom collection RPC calls to {@link CatalogService} (`#215`, `#403`). */
export function executeWaveF5bOpsRpcCall(
  service: CatalogService,
  call: CatalogWaveF5bOpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'getVodEnrichment':
      return service.getVodEnrichment
        ? service.getVodEnrichment(call.itemKey)
        : Promise.resolve(null);
    case 'enrichVodItem':
      return service.enrichVodItem
        ? service.enrichVodItem(
            call.itemKey,
            call.opts === undefined
              ? undefined
              : {
                  ...(call.opts.enabled === undefined ? {} : { enabled: call.opts.enabled }),
                  ...(call.opts.ttlMs === undefined ? {} : { ttlMs: call.opts.ttlMs }),
                },
          )
        : Promise.resolve(null);
    case 'listCollections':
      return service.listCollections
        ? service.listCollections(call.profileId, call.opts)
        : Promise.resolve([]);
    case 'createCollection':
      return service.createCollection
        ? service.createCollection(call.input)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'renameCollection':
      return service.renameCollection
        ? service.renameCollection(call.id, call.name, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'reorderCollections':
      return service.reorderCollections
        ? service.reorderCollections(call.orderedIds, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'deleteCollection':
      return service.deleteCollection
        ? service.deleteCollection(call.id, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'listCollectionItems':
      return service.listCollectionItems
        ? service.listCollectionItems(call.collectionId, call.opts)
        : Promise.resolve([]);
    case 'listCollectionsForItem':
      return service.listCollectionsForItem
        ? service.listCollectionsForItem(call.itemKey, call.profileId)
        : Promise.resolve([]);
    case 'addItemToCollection':
      return service.addItemToCollection
        ? service.addItemToCollection(call.collectionId, call.itemKey, call.kind, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'removeItemFromCollection':
      return service.removeItemFromCollection
        ? service.removeItemFromCollection(call.collectionId, call.itemKey, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
    case 'reorderCollectionItems':
      return service.reorderCollectionItems
        ? service.reorderCollectionItems(call.collectionId, call.orderedItemKeys, call.profileId)
        : Promise.resolve(err(elvError('storage', 'unsupported')));
  }
}
