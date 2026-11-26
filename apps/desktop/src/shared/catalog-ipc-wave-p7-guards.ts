import type { SourceRow } from '@elv/data';
import type { Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isCleanKey,
  isStrictProfileId,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_SOURCE_NAME_CHARS = 80;
const MAX_EXCLUDED_PROFILE_IDS = 64;

/** Discriminated union of Wave P7 source management RPC calls (`#505`, `#506`). */
export type CatalogWaveP7OpsRpcCall =
  | { method: 'renameSource'; sourceId: string; name: string }
  | {
      method: 'setSourceExcludedProfiles';
      sourceId: string;
      excludedProfileIds: readonly string[];
    };

/** Preload bridge methods for Wave P7 source rename & per-profile source sharing (`#505`, `#506`). */
export interface CatalogBridgeWaveP7Ops {
  renameSource?(sourceId: string, name: string): Promise<Result<SourceRow>>;
  setSourceExcludedProfiles?(
    sourceId: string,
    excludedProfileIds: readonly string[],
  ): Promise<Result<SourceRow>>;
}

const RENAME_SOURCE_KEYS = new Set(['method', 'sourceId', 'name']);
const SET_SOURCE_EXCLUDED_PROFILES_KEYS = new Set(['method', 'sourceId', 'excludedProfileIds']);

const isSafeSourceName = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_SOURCE_NAME_CHARS) && x.trim().length > 0 && !hasControlChar(x);

const isExcludedProfileIdList = (x: unknown): x is readonly string[] =>
  Array.isArray(x) &&
  x.length <= MAX_EXCLUDED_PROFILE_IDS &&
  x.every((id) => isStrictProfileId(id));

/** Validates Wave P7 source rename and profile-exclusion RPC calls (`#505`, `#506`). */
export function isWaveP7OpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'renameSource':
      return (
        hasOnlyKeys(x, RENAME_SOURCE_KEYS) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        isSafeSourceName(x['name'])
      );
    case 'setSourceExcludedProfiles':
      return (
        hasOnlyKeys(x, SET_SOURCE_EXCLUDED_PROFILES_KEYS) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        isExcludedProfileIdList(x['excludedProfileIds'])
      );
    default:
      return false;
  }
}
