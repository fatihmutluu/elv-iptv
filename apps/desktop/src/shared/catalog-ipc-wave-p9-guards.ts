import type {
  ApplyWatchedEpisodeBitfieldInput,
  SetContinueWatchingDismissalInput,
} from '@elv/data';
import {
  hasOnlyKeys,
  isCleanKey,
  isNonNegativeFinite,
  isOptionalStrictProfileId,
  isRecord,
  isSafeInt,
  MAX_ID_CHARS,
  MAX_ITEM_KEY_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_SYNC_PROGRESS_LIMIT = 5_000;
const MAX_BITFIELD_INDICES = 500;

/** Discriminated union of Wave P9 VaultSnapshot v2 sync-state RPC calls (`#510`). */
export type CatalogWaveP9OpsRpcCall =
  | { method: 'listAllWatchProgress'; profileId?: string; limit?: number }
  | { method: 'listContinueWatchingDismissals'; profileId?: string }
  | {
      method: 'setContinueWatchingDismissal';
      input: SetContinueWatchingDismissalInput;
      deleted: boolean;
    }
  | { method: 'listCollectionRawItemKeys'; collectionId: string; profileId?: string }
  | { method: 'listSourceRecords' }
  | { method: 'applyWatchedEpisodeBitfield'; input: ApplyWatchedEpisodeBitfieldInput };

/** Set of Wave P9 sync-state RPC method names for worker runtime dispatch narrowing. */
export const WAVE_P9_RPC_METHODS: ReadonlySet<string> = new Set<CatalogWaveP9OpsRpcCall['method']>([
  'listAllWatchProgress',
  'listContinueWatchingDismissals',
  'setContinueWatchingDismissal',
  'listCollectionRawItemKeys',
  'listSourceRecords',
  'applyWatchedEpisodeBitfield',
]);

const LIST_ALL_PROGRESS_KEYS = new Set(['method', 'profileId', 'limit']);
const LIST_DISMISSALS_KEYS = new Set(['method', 'profileId']);
const SET_DISMISSAL_CALL_KEYS = new Set(['method', 'input', 'deleted']);
const SET_DISMISSAL_INPUT_KEYS = new Set(['profileId', 'seriesKey', 'sourceId', 'dismissedAt']);
const LIST_RAW_COL_KEYS = new Set(['method', 'collectionId', 'profileId']);
const LIST_SOURCE_RECORDS_KEYS = new Set(['method']);
const APPLY_BITFIELD_CALL_KEYS = new Set(['method', 'input']);
const APPLY_BITFIELD_INPUT_KEYS = new Set([
  'profileId',
  'seriesKey',
  'season',
  'episodeIndices',
  'updatedAt',
]);

function isSetDismissalInput(x: unknown): x is SetContinueWatchingDismissalInput {
  return (
    isRecord(x) &&
    hasOnlyKeys(x, SET_DISMISSAL_INPUT_KEYS) &&
    isOptionalStrictProfileId(x['profileId']) &&
    isCleanKey(x['seriesKey'], MAX_ITEM_KEY_CHARS) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
    isNonNegativeFinite(x['dismissedAt'])
  );
}

function isApplyBitfieldInput(x: unknown): x is ApplyWatchedEpisodeBitfieldInput {
  if (!isRecord(x) || !hasOnlyKeys(x, APPLY_BITFIELD_INPUT_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (!isCleanKey(x['seriesKey'], MAX_ITEM_KEY_CHARS)) return false;
  if (x['season'] !== undefined && (!isSafeInt(x['season']) || x['season'] < 0)) return false;
  if (!isNonNegativeFinite(x['updatedAt'])) return false;
  const indices = x['episodeIndices'];
  return (
    Array.isArray(indices) &&
    indices.length <= MAX_BITFIELD_INDICES &&
    indices.every((n) => isSafeInt(n) && n >= 0)
  );
}

/** Validates Wave P9 sync-state RPC calls (`#510`). */
export function isWaveP9OpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'listAllWatchProgress':
      return (
        hasOnlyKeys(x, LIST_ALL_PROGRESS_KEYS) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['limit'] === undefined ||
          (isSafeInt(x['limit']) && x['limit'] >= 0 && x['limit'] <= MAX_SYNC_PROGRESS_LIMIT))
      );
    case 'listContinueWatchingDismissals':
      return hasOnlyKeys(x, LIST_DISMISSALS_KEYS) && isOptionalStrictProfileId(x['profileId']);
    case 'setContinueWatchingDismissal':
      return (
        hasOnlyKeys(x, SET_DISMISSAL_CALL_KEYS) &&
        isSetDismissalInput(x['input']) &&
        typeof x['deleted'] === 'boolean'
      );
    case 'listCollectionRawItemKeys':
      return (
        hasOnlyKeys(x, LIST_RAW_COL_KEYS) &&
        isCleanKey(x['collectionId'], MAX_ID_CHARS) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'listSourceRecords':
      return hasOnlyKeys(x, LIST_SOURCE_RECORDS_KEYS);
    case 'applyWatchedEpisodeBitfield':
      return hasOnlyKeys(x, APPLY_BITFIELD_CALL_KEYS) && isApplyBitfieldInput(x['input']);
    default:
      return false;
  }
}
