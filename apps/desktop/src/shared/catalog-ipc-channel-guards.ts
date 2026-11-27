import {
  type ChannelOverrideRecord,
  type CreateCustomGroupInput,
  type CustomGroupItemInput,
  type CustomGroupRecord,
  isSafeChannelKey,
  isValidCustomGroupId,
  MAX_CHANNEL_SORT_ORDER,
  MAX_CUSTOM_CHANNEL_NAME_LENGTH,
  MAX_CUSTOM_GROUP_NAME_LENGTH,
  type SetChannelOverrideInput,
  type UpdateCustomGroupPatch,
} from '@elv/data';
import type { Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isCleanKey,
  isOptionalStrictProfileId,
  isRecord,
  isSafeInt,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_REORDER_CHANNEL_KEYS = 10_000;
const MAX_CUSTOM_GROUP_ITEMS = 10_000;

/** Discriminated union of Wave F2 channel override and custom group RPC calls (`#60`). */
export type CatalogChannelOpsRpcCall =
  | { method: 'listChannelOverrides'; profileId?: string }
  | { method: 'setChannelOverride'; input: SetChannelOverrideInput }
  | { method: 'clearChannelOverride'; itemKey: string; profileId?: string }
  | {
      method: 'reorderChannels';
      itemKeys: readonly string[];
      sourceId: string;
      profileId?: string;
    }
  | {
      method: 'listCustomGroups';
      profileId?: string;
      opts?: { readonly includeHidden?: boolean; readonly parentalUnlocked?: boolean };
    }
  | { method: 'createCustomGroup'; input: CreateCustomGroupInput }
  | { method: 'updateCustomGroup'; groupId: string; patch: UpdateCustomGroupPatch }
  | { method: 'deleteCustomGroup'; groupId: string }
  | {
      method: 'setCustomGroupItems';
      groupId: string;
      items: readonly CustomGroupItemInput[];
    }
  | { method: 'addChannelToCustomGroup'; groupId: string; itemKey: string; sourceId: string }
  | { method: 'removeChannelFromCustomGroup'; groupId: string; itemKey: string };

/** Preload bridge methods for Wave F2 channel overrides and custom groups (`#60`). */
export interface CatalogBridgeChannelOps {
  listChannelOverrides?(profileId?: string): Promise<ChannelOverrideRecord[]>;
  setChannelOverride?(input: SetChannelOverrideInput): Promise<Result<ChannelOverrideRecord>>;
  clearChannelOverride?(itemKey: string, profileId?: string): Promise<Result<void>>;
  reorderChannels?(
    itemKeys: readonly string[],
    sourceId: string,
    profileId?: string,
  ): Promise<Result<void>>;
  listCustomGroups?(
    profileId?: string,
    opts?: { readonly includeHidden?: boolean; readonly parentalUnlocked?: boolean },
  ): Promise<CustomGroupRecord[]>;
  createCustomGroup?(input: CreateCustomGroupInput): Promise<Result<CustomGroupRecord>>;
  updateCustomGroup?(
    groupId: string,
    patch: UpdateCustomGroupPatch,
  ): Promise<Result<CustomGroupRecord>>;
  deleteCustomGroup?(groupId: string): Promise<Result<void>>;
  setCustomGroupItems?(
    groupId: string,
    items: readonly CustomGroupItemInput[],
  ): Promise<Result<void>>;
  addChannelToCustomGroup?(
    groupId: string,
    itemKey: string,
    sourceId: string,
  ): Promise<Result<void>>;
  removeChannelFromCustomGroup?(groupId: string, itemKey: string): Promise<Result<void>>;
}

const INCLUDE_HIDDEN_PARENTAL_OPT_KEYS = new Set(['includeHidden', 'parentalUnlocked']);
const SET_CHANNEL_OVERRIDE_KEYS = new Set([
  'profileId',
  'itemKey',
  'sourceId',
  'customName',
  'isHidden',
  'sortOrder',
]);
const CREATE_CUSTOM_GROUP_KEYS = new Set(['id', 'profileId', 'name', 'sortOrder', 'isHidden']);
const UPDATE_CUSTOM_GROUP_KEYS = new Set(['name', 'sortOrder', 'isHidden']);
const CUSTOM_GROUP_ITEM_KEYS = new Set(['itemKey', 'sourceId']);

const LIST_OVERRIDES_CALL_KEYS = new Set(['method', 'profileId']);
const SET_OVERRIDE_CALL_KEYS = new Set(['method', 'input']);
const CLEAR_OVERRIDE_CALL_KEYS = new Set(['method', 'itemKey', 'profileId']);
const REORDER_CHANNELS_CALL_KEYS = new Set(['method', 'itemKeys', 'sourceId', 'profileId']);
const LIST_GROUPS_CALL_KEYS = new Set(['method', 'profileId', 'opts']);
const CREATE_GROUP_CALL_KEYS = new Set(['method', 'input']);
const UPDATE_GROUP_CALL_KEYS = new Set(['method', 'groupId', 'patch']);
const DELETE_GROUP_CALL_KEYS = new Set(['method', 'groupId']);
const SET_GROUP_ITEMS_CALL_KEYS = new Set(['method', 'groupId', 'items']);
const ADD_GROUP_ITEM_CALL_KEYS = new Set(['method', 'groupId', 'itemKey', 'sourceId']);
const REMOVE_GROUP_ITEM_CALL_KEYS = new Set(['method', 'groupId', 'itemKey']);

/** Validates `{ includeHidden?: boolean; parentalUnlocked?: boolean }` query option records (`#60`). */
export function isIncludeHiddenParentalOptions(
  x: unknown,
): x is { readonly includeHidden?: boolean; readonly parentalUnlocked?: boolean } {
  if (!isRecord(x) || !hasOnlyKeys(x, INCLUDE_HIDDEN_PARENTAL_OPT_KEYS)) return false;
  if (x['includeHidden'] !== undefined && typeof x['includeHidden'] !== 'boolean') return false;
  return x['parentalUnlocked'] === undefined || typeof x['parentalUnlocked'] === 'boolean';
}

/** Validates a {@link SetChannelOverrideInput} IPC payload (`#60`). */
function isSetChannelOverrideInput(x: unknown): x is SetChannelOverrideInput {
  if (!isRecord(x) || !hasOnlyKeys(x, SET_CHANNEL_OVERRIDE_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (!isSafeChannelKey(x['itemKey']) || !isCleanKey(x['sourceId'], MAX_ID_CHARS)) return false;
  const customName = x['customName'];
  if (
    customName !== undefined &&
    customName !== null &&
    (!isBoundedString(customName, 0, MAX_CUSTOM_CHANNEL_NAME_LENGTH) || hasControlChar(customName))
  ) {
    return false;
  }
  if (x['isHidden'] !== undefined && typeof x['isHidden'] !== 'boolean') return false;
  const sortOrder = x['sortOrder'];
  if (
    sortOrder !== undefined &&
    sortOrder !== null &&
    (!isSafeInt(sortOrder) || sortOrder < 0 || sortOrder > MAX_CHANNEL_SORT_ORDER)
  ) {
    return false;
  }
  return true;
}

/** Validates a bounded list of safe channel keys for `reorderChannels` (`#60`). */
function isReorderChannelKeyList(x: unknown): x is readonly string[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_REORDER_CHANNEL_KEYS &&
    x.every((key) => isSafeChannelKey(key))
  );
}

/** Validates a {@link CreateCustomGroupInput} IPC payload (`#60`). */
function isCreateCustomGroupInput(x: unknown): x is CreateCustomGroupInput {
  if (!isRecord(x) || !hasOnlyKeys(x, CREATE_CUSTOM_GROUP_KEYS)) return false;
  if (x['id'] !== undefined) {
    if (typeof x['id'] !== 'string' || !isValidCustomGroupId(x['id'].trim())) return false;
  }
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  const name = x['name'];
  if (
    !isBoundedString(name, 1, MAX_CUSTOM_GROUP_NAME_LENGTH) ||
    name.trim().length === 0 ||
    hasControlChar(name)
  ) {
    return false;
  }
  const sortOrder = x['sortOrder'];
  if (
    sortOrder !== undefined &&
    (!isSafeInt(sortOrder) || Math.abs(sortOrder) > MAX_CHANNEL_SORT_ORDER)
  ) {
    return false;
  }
  return x['isHidden'] === undefined || typeof x['isHidden'] === 'boolean';
}

/** Validates an {@link UpdateCustomGroupPatch} IPC payload (`#60`). */
function isUpdateCustomGroupPatch(x: unknown): x is UpdateCustomGroupPatch {
  if (!isRecord(x) || !hasOnlyKeys(x, UPDATE_CUSTOM_GROUP_KEYS)) return false;
  const name = x['name'];
  if (
    name !== undefined &&
    (!isBoundedString(name, 1, MAX_CUSTOM_GROUP_NAME_LENGTH) ||
      name.trim().length === 0 ||
      hasControlChar(name))
  ) {
    return false;
  }
  const sortOrder = x['sortOrder'];
  if (
    sortOrder !== undefined &&
    (!isSafeInt(sortOrder) || Math.abs(sortOrder) > MAX_CHANNEL_SORT_ORDER)
  ) {
    return false;
  }
  return x['isHidden'] === undefined || typeof x['isHidden'] === 'boolean';
}

function isCustomGroupItemInput(x: unknown): x is CustomGroupItemInput {
  return (
    isRecord(x) &&
    hasOnlyKeys(x, CUSTOM_GROUP_ITEM_KEYS) &&
    isSafeChannelKey(x['itemKey']) &&
    isCleanKey(x['sourceId'], MAX_ID_CHARS)
  );
}

/** Validates a bounded list of {@link CustomGroupItemInput} entries for `setCustomGroupItems` (`#60`). */
function isCustomGroupItemInputList(x: unknown): x is readonly CustomGroupItemInput[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_CUSTOM_GROUP_ITEMS &&
    x.every((entry) => isCustomGroupItemInput(entry))
  );
}

/** Validates all 11 Wave F2 channel override and custom group RPC method call payloads (`#60`). */
export function isChannelOpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'listChannelOverrides':
      return hasOnlyKeys(x, LIST_OVERRIDES_CALL_KEYS) && isOptionalStrictProfileId(x['profileId']);
    case 'setChannelOverride':
      return hasOnlyKeys(x, SET_OVERRIDE_CALL_KEYS) && isSetChannelOverrideInput(x['input']);
    case 'clearChannelOverride':
      return (
        hasOnlyKeys(x, CLEAR_OVERRIDE_CALL_KEYS) &&
        isSafeChannelKey(x['itemKey']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'reorderChannels':
      return (
        hasOnlyKeys(x, REORDER_CHANNELS_CALL_KEYS) &&
        isReorderChannelKeyList(x['itemKeys']) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'listCustomGroups':
      return (
        hasOnlyKeys(x, LIST_GROUPS_CALL_KEYS) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['opts'] === undefined || isIncludeHiddenParentalOptions(x['opts']))
      );
    case 'createCustomGroup':
      return hasOnlyKeys(x, CREATE_GROUP_CALL_KEYS) && isCreateCustomGroupInput(x['input']);
    case 'updateCustomGroup':
      return (
        hasOnlyKeys(x, UPDATE_GROUP_CALL_KEYS) &&
        isValidCustomGroupId(x['groupId']) &&
        isUpdateCustomGroupPatch(x['patch'])
      );
    case 'deleteCustomGroup':
      return hasOnlyKeys(x, DELETE_GROUP_CALL_KEYS) && isValidCustomGroupId(x['groupId']);
    case 'setCustomGroupItems':
      return (
        hasOnlyKeys(x, SET_GROUP_ITEMS_CALL_KEYS) &&
        isValidCustomGroupId(x['groupId']) &&
        isCustomGroupItemInputList(x['items'])
      );
    case 'addChannelToCustomGroup':
      return (
        hasOnlyKeys(x, ADD_GROUP_ITEM_CALL_KEYS) &&
        isValidCustomGroupId(x['groupId']) &&
        isSafeChannelKey(x['itemKey']) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS)
      );
    case 'removeChannelFromCustomGroup':
      return (
        hasOnlyKeys(x, REMOVE_GROUP_ITEM_CALL_KEYS) &&
        isValidCustomGroupId(x['groupId']) &&
        isSafeChannelKey(x['itemKey'])
      );
    default:
      return false;
  }
}
