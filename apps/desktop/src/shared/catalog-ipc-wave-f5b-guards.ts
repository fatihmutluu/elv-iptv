import {
  type CreateVodCollectionInput,
  type ItemRow,
  MAX_VOD_COLLECTION_NAME_LENGTH,
  type ParentalQueryOptions,
  VOD_COLLECTION_ID_RE,
  type VodCollectionRecord,
  type VodEnrichmentRecord,
} from '@elv/data';
import type { Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isFiniteNumber,
  isOptionalStrictProfileId,
  isParentalQueryOptions,
  isParentalUnlockedOption,
  isRecord,
  MAX_ITEM_KEY_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_COLLECTIONS_REORDER = 256;
const MAX_COLLECTION_ITEMS_REORDER = 500;
const MAX_VOD_ENRICHMENT_TTL_MS = 365 * 86_400_000;

/** Serializable IPC options for `enrichVodItem` (`#215`); non-serializable `remoteFetcher` is excluded. */
interface EnrichVodItemIpcOptions {
  readonly enabled?: boolean;
  readonly ttlMs?: number;
}

/** Discriminated union of all 12 Wave F5B VOD enrichment & custom collection RPC calls (`#215`, `#403`). */
export type CatalogWaveF5bOpsRpcCall =
  | { method: 'getVodEnrichment'; itemKey: string }
  | { method: 'enrichVodItem'; itemKey: string; opts?: EnrichVodItemIpcOptions }
  | {
      method: 'listCollections';
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | { method: 'createCollection'; input: CreateVodCollectionInput }
  | { method: 'renameCollection'; id: string; name: string; profileId?: string }
  | { method: 'reorderCollections'; orderedIds: readonly string[]; profileId?: string }
  | { method: 'deleteCollection'; id: string; profileId?: string }
  | { method: 'listCollectionItems'; collectionId: string; opts?: ParentalQueryOptions }
  | { method: 'listCollectionsForItem'; itemKey: string; profileId?: string }
  | {
      method: 'addItemToCollection';
      collectionId: string;
      itemKey: string;
      kind: 'movie' | 'series';
      profileId?: string;
    }
  | {
      method: 'removeItemFromCollection';
      collectionId: string;
      itemKey: string;
      profileId?: string;
    }
  | {
      method: 'reorderCollectionItems';
      collectionId: string;
      orderedItemKeys: readonly string[];
      profileId?: string;
    };

/** Preload bridge methods for Wave F5B VOD enrichment and custom collections (`#215`, `#403`). */
export interface CatalogBridgeWaveF5bOps {
  getVodEnrichment?(itemKey: string): Promise<VodEnrichmentRecord | null>;
  enrichVodItem?(
    itemKey: string,
    opts?: EnrichVodItemIpcOptions,
  ): Promise<VodEnrichmentRecord | null>;
  listCollections?(
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<VodCollectionRecord[]>;
  createCollection?(input: CreateVodCollectionInput): Promise<Result<VodCollectionRecord>>;
  renameCollection?(
    id: string,
    name: string,
    profileId?: string,
  ): Promise<Result<VodCollectionRecord>>;
  reorderCollections?(
    orderedIds: readonly string[],
    profileId?: string,
  ): Promise<Result<VodCollectionRecord[]>>;
  deleteCollection?(id: string, profileId?: string): Promise<Result<void>>;
  listCollectionItems?(collectionId: string, opts?: ParentalQueryOptions): Promise<ItemRow[]>;
  listCollectionsForItem?(itemKey: string, profileId?: string): Promise<string[]>;
  addItemToCollection?(
    collectionId: string,
    itemKey: string,
    kind: 'movie' | 'series',
    profileId?: string,
  ): Promise<Result<void>>;
  removeItemFromCollection?(
    collectionId: string,
    itemKey: string,
    profileId?: string,
  ): Promise<Result<void>>;
  reorderCollectionItems?(
    collectionId: string,
    orderedItemKeys: readonly string[],
    profileId?: string,
  ): Promise<Result<void>>;
}

/** Set of Wave F5B RPC method names for worker runtime dispatch narrowing. */
export const WAVE_F5B_RPC_METHODS: ReadonlySet<string> = new Set<
  CatalogWaveF5bOpsRpcCall['method']
>([
  'getVodEnrichment',
  'enrichVodItem',
  'listCollections',
  'createCollection',
  'renameCollection',
  'reorderCollections',
  'deleteCollection',
  'listCollectionItems',
  'listCollectionsForItem',
  'addItemToCollection',
  'removeItemFromCollection',
  'reorderCollectionItems',
]);

const ENRICH_VOD_OPT_KEYS = new Set(['enabled', 'ttlMs']);
const CREATE_COLLECTION_INPUT_KEYS = new Set(['id', 'profileId', 'name']);

const GET_VOD_ENRICHMENT_KEYS = new Set(['method', 'itemKey']);
const ENRICH_VOD_CALL_KEYS = new Set(['method', 'itemKey', 'opts']);
const LIST_COLLECTIONS_KEYS = new Set(['method', 'profileId', 'opts']);
const CREATE_COLLECTION_CALL_KEYS = new Set(['method', 'input']);
const RENAME_COLLECTION_KEYS = new Set(['method', 'id', 'name', 'profileId']);
const REORDER_COLLECTIONS_KEYS = new Set(['method', 'orderedIds', 'profileId']);
const DELETE_COLLECTION_KEYS = new Set(['method', 'id', 'profileId']);
const LIST_COLLECTION_ITEMS_KEYS = new Set(['method', 'collectionId', 'opts']);
const LIST_COLLECTIONS_FOR_ITEM_KEYS = new Set(['method', 'itemKey', 'profileId']);
const ADD_ITEM_TO_COLLECTION_KEYS = new Set([
  'method',
  'collectionId',
  'itemKey',
  'kind',
  'profileId',
]);
const REMOVE_ITEM_FROM_COLLECTION_KEYS = new Set([
  'method',
  'collectionId',
  'itemKey',
  'profileId',
]);
const REORDER_COLLECTION_ITEMS_KEYS = new Set([
  'method',
  'collectionId',
  'orderedItemKeys',
  'profileId',
]);

const isSafeCollectionId = (x: unknown): x is string =>
  typeof x === 'string' && VOD_COLLECTION_ID_RE.test(x);

const isSafeCollectionName = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_VOD_COLLECTION_NAME_LENGTH) &&
  x.trim().length > 0 &&
  !hasControlChar(x);

const isSafeVodItemKey = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ITEM_KEY_CHARS) &&
  x.trim().length > 0 &&
  !hasControlChar(x) &&
  !x.includes('://') &&
  !x.includes('{{') &&
  !x.includes('@') &&
  !x.includes('?');

function isEnrichVodItemIpcOptions(x: unknown): x is EnrichVodItemIpcOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, ENRICH_VOD_OPT_KEYS)) return false;
  if (x['enabled'] !== undefined && typeof x['enabled'] !== 'boolean') return false;
  const ttlMs = x['ttlMs'];
  return (
    ttlMs === undefined ||
    (isFiniteNumber(ttlMs) && ttlMs > 0 && ttlMs <= MAX_VOD_ENRICHMENT_TTL_MS)
  );
}

function isCreateVodCollectionInput(x: unknown): x is CreateVodCollectionInput {
  if (!isRecord(x) || !hasOnlyKeys(x, CREATE_COLLECTION_INPUT_KEYS)) return false;
  if (x['id'] !== undefined && !isSafeCollectionId(x['id'])) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return isSafeCollectionName(x['name']);
}

function isBoundedCollectionIdList(x: unknown): x is readonly string[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_COLLECTIONS_REORDER &&
    x.every((id) => isSafeCollectionId(id))
  );
}

function isBoundedVodItemKeyList(x: unknown): x is readonly string[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_COLLECTION_ITEMS_REORDER &&
    x.every((k) => isSafeVodItemKey(k))
  );
}

/** Validates all 12 Wave F5B VOD enrichment and custom collection RPC calls (`#215`, `#403`). */
export function isWaveF5bOpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'getVodEnrichment':
      return hasOnlyKeys(x, GET_VOD_ENRICHMENT_KEYS) && isSafeVodItemKey(x['itemKey']);
    case 'enrichVodItem':
      return (
        hasOnlyKeys(x, ENRICH_VOD_CALL_KEYS) &&
        isSafeVodItemKey(x['itemKey']) &&
        (x['opts'] === undefined || isEnrichVodItemIpcOptions(x['opts']))
      );
    case 'listCollections':
      return (
        hasOnlyKeys(x, LIST_COLLECTIONS_KEYS) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'createCollection':
      return hasOnlyKeys(x, CREATE_COLLECTION_CALL_KEYS) && isCreateVodCollectionInput(x['input']);
    case 'renameCollection':
      return (
        hasOnlyKeys(x, RENAME_COLLECTION_KEYS) &&
        isSafeCollectionId(x['id']) &&
        isSafeCollectionName(x['name']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'reorderCollections':
      return (
        hasOnlyKeys(x, REORDER_COLLECTIONS_KEYS) &&
        isBoundedCollectionIdList(x['orderedIds']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'deleteCollection':
      return (
        hasOnlyKeys(x, DELETE_COLLECTION_KEYS) &&
        isSafeCollectionId(x['id']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'listCollectionItems':
      return (
        hasOnlyKeys(x, LIST_COLLECTION_ITEMS_KEYS) &&
        isSafeCollectionId(x['collectionId']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'listCollectionsForItem':
      return (
        hasOnlyKeys(x, LIST_COLLECTIONS_FOR_ITEM_KEYS) &&
        isSafeVodItemKey(x['itemKey']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'addItemToCollection':
      return (
        hasOnlyKeys(x, ADD_ITEM_TO_COLLECTION_KEYS) &&
        isSafeCollectionId(x['collectionId']) &&
        isSafeVodItemKey(x['itemKey']) &&
        (x['kind'] === 'movie' || x['kind'] === 'series') &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'removeItemFromCollection':
      return (
        hasOnlyKeys(x, REMOVE_ITEM_FROM_COLLECTION_KEYS) &&
        isSafeCollectionId(x['collectionId']) &&
        isSafeVodItemKey(x['itemKey']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'reorderCollectionItems':
      return (
        hasOnlyKeys(x, REORDER_COLLECTION_ITEMS_KEYS) &&
        isSafeCollectionId(x['collectionId']) &&
        isBoundedVodItemKeyList(x['orderedItemKeys']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    default:
      return false;
  }
}
