import type { Result, SqlDriver } from '@elv/domain';
import type { ParentalQueryOptions } from './parental-policy';
import type { ItemRow } from './queries-shared';
import type { PlaytimeResolverCache } from './stream-resolver-types';
import {
  addItemToCollection,
  type CreateVodCollectionInput,
  createCollection,
  deleteCollection,
  listCollectionItems,
  listCollections,
  listCollectionsForItem,
  removeItemFromCollection,
  renameCollection,
  reorderCollectionItems,
  reorderCollections,
  type VodCollectionRecord,
} from './vod-collections-repo';
import {
  type EnrichVodItemOptions,
  enrichVodItem,
  getVodEnrichment,
  type VodEnrichmentRecord,
} from './vod-enrichment-repo';

/** Custom user VOD collections (`#403`) and key-free VOD enrichment (`#215`) methods on `CatalogService`. */
export interface CatalogCollectionsOpsMethods {
  getVodEnrichment(itemKey: string, nowMs?: number): Promise<VodEnrichmentRecord | null>;
  enrichVodItem(itemKey: string, opts?: EnrichVodItemOptions): Promise<VodEnrichmentRecord | null>;
  listCollections(profileId?: string): Promise<VodCollectionRecord[]>;
  createCollection(input: CreateVodCollectionInput): Promise<Result<VodCollectionRecord>>;
  renameCollection(
    id: string,
    name: string,
    profileId?: string,
  ): Promise<Result<VodCollectionRecord>>;
  reorderCollections(
    orderedIds: readonly string[],
    profileId?: string,
  ): Promise<Result<VodCollectionRecord[]>>;
  deleteCollection(id: string, profileId?: string): Promise<Result<void>>;
  listCollectionItems(collectionId: string, opts?: ParentalQueryOptions): Promise<ItemRow[]>;
  listCollectionsForItem(itemKey: string, profileId?: string): Promise<string[]>;
  addItemToCollection(
    collectionId: string,
    itemKey: string,
    kind: 'movie' | 'series',
    profileId?: string,
  ): Promise<Result<void>>;
  removeItemFromCollection(
    collectionId: string,
    itemKey: string,
    profileId?: string,
  ): Promise<Result<void>>;
  reorderCollectionItems(
    collectionId: string,
    orderedItemKeys: readonly string[],
    profileId?: string,
  ): Promise<Result<void>>;
}

/** @internal Creates VOD enrichment and custom collections methods for `CatalogService`. */
export function createCatalogCollectionsOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  playtime: PlaytimeResolverCache;
}): CatalogCollectionsOpsMethods {
  const { db, clock, playtime } = deps;

  return {
    getVodEnrichment: (itemKey, nowMs) => getVodEnrichment(db, itemKey, nowMs ?? clock()),
    enrichVodItem: (itemKey, opts) =>
      enrichVodItem(db, itemKey, {
        ...opts,
        ...(opts?.nowMs === undefined ? { nowMs: clock() } : {}),
      }),
    listCollections: (profileId) => listCollections(db, profileId),
    createCollection: (input) => createCollection(db, input, clock()),
    renameCollection: (id, name, profileId) => renameCollection(db, id, name, profileId, clock()),
    reorderCollections: (orderedIds, profileId) =>
      reorderCollections(db, orderedIds, profileId, clock()),
    deleteCollection: (id, profileId) => deleteCollection(db, id, profileId),
    listCollectionItems: async (collectionId, opts) =>
      playtime.resolveRowLogos(await listCollectionItems(db, collectionId, opts)),
    listCollectionsForItem: (itemKey, profileId) => listCollectionsForItem(db, itemKey, profileId),
    addItemToCollection: (collectionId, itemKey, kind, profileId) =>
      addItemToCollection(db, collectionId, itemKey, kind, profileId, clock()),
    removeItemFromCollection: (collectionId, itemKey, profileId) =>
      removeItemFromCollection(db, collectionId, itemKey, profileId, clock()),
    reorderCollectionItems: (collectionId, orderedItemKeys, profileId) =>
      reorderCollectionItems(db, collectionId, orderedItemKeys, profileId, clock()),
  };
}
