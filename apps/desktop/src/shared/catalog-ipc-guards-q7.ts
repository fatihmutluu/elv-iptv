import {
  type AssignLiveFavoriteFolderInput,
  type CreateLiveFavoriteFolderInput,
  LIVE_FAVORITE_FOLDER_ID_RE,
  type LiveFavoriteFolderAssignment,
  type LiveFavoriteFolderRecord,
  MAX_LIVE_FAVORITE_FOLDER_NAME_LENGTH,
  SOURCE_ID,
} from '@elv/data';
import type { Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isOptionalStrictProfileId,
  isParentalUnlockedOption,
  isRecord,
  isSafeRecentChannelKey,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_TITLE_CHARS = 512;
const MAX_LOGO_CHARS = 2_048;

/** Discriminated union of all 8 Wave Q7-B recent-channel cleanup and Live TV favorite folder RPC calls. */
export type CatalogWaveQ7OpsRpcCall =
  | { method: 'removeRecentChannel'; itemKey: string; profileId?: string }
  | { method: 'clearRecentChannels'; profileId?: string }
  | {
      method: 'listLiveFavoriteFolders';
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | { method: 'createLiveFavoriteFolder'; input: CreateLiveFavoriteFolderInput }
  | {
      method: 'renameLiveFavoriteFolder';
      id: string;
      name: string;
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | { method: 'deleteLiveFavoriteFolder'; id: string; profileId?: string }
  | { method: 'assignLiveFavoriteFolder'; input: AssignLiveFavoriteFolderInput }
  | { method: 'listLiveFavoriteFolderAssignments'; profileId?: string };

/** Preload bridge methods for Wave Q7-B recent-channel cleanup and Live TV favorite folders. */
export interface CatalogBridgeWaveQ7Ops {
  removeRecentChannel?(itemKey: string, profileId?: string): Promise<boolean>;
  clearRecentChannels?(profileId?: string): Promise<number>;
  listLiveFavoriteFolders?(
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<LiveFavoriteFolderRecord[]>;
  createLiveFavoriteFolder?(
    input: CreateLiveFavoriteFolderInput,
  ): Promise<Result<LiveFavoriteFolderRecord>>;
  renameLiveFavoriteFolder?(
    id: string,
    name: string,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<Result<LiveFavoriteFolderRecord>>;
  deleteLiveFavoriteFolder?(id: string, profileId?: string): Promise<Result<void>>;
  assignLiveFavoriteFolder?(input: AssignLiveFavoriteFolderInput): Promise<Result<void>>;
  listLiveFavoriteFolderAssignments?(profileId?: string): Promise<LiveFavoriteFolderAssignment[]>;
}

/** Set of Wave Q7-B RPC method names for worker runtime dispatch narrowing. */
export const WAVE_Q7_RPC_METHODS: ReadonlySet<string> = new Set<CatalogWaveQ7OpsRpcCall['method']>([
  'removeRecentChannel',
  'clearRecentChannels',
  'listLiveFavoriteFolders',
  'createLiveFavoriteFolder',
  'renameLiveFavoriteFolder',
  'deleteLiveFavoriteFolder',
  'assignLiveFavoriteFolder',
  'listLiveFavoriteFolderAssignments',
]);

const REMOVE_RECENT_KEYS = new Set(['method', 'itemKey', 'profileId']);
const CLEAR_RECENT_KEYS = new Set(['method', 'profileId']);
const LIST_FOLDERS_KEYS = new Set(['method', 'profileId', 'opts']);
const CREATE_FOLDER_CALL_KEYS = new Set(['method', 'input']);
const CREATE_FOLDER_INPUT_KEYS = new Set(['id', 'name', 'profileId']);
const RENAME_FOLDER_KEYS = new Set(['method', 'id', 'name', 'profileId', 'opts']);
const DELETE_FOLDER_KEYS = new Set(['method', 'id', 'profileId']);
const ASSIGN_FOLDER_CALL_KEYS = new Set(['method', 'input']);
const ASSIGN_FOLDER_INPUT_KEYS = new Set([
  'itemKey',
  'sourceId',
  'folderId',
  'title',
  'logo',
  'profileId',
]);
const LIST_ASSIGNMENTS_KEYS = new Set(['method', 'profileId']);

const isSafeSourceId = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ID_CHARS) && SOURCE_ID.test(x);

const isSafeFolderId = (x: unknown): x is string =>
  typeof x === 'string' && LIVE_FAVORITE_FOLDER_ID_RE.test(x);

const isSafeFolderName = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_LIVE_FAVORITE_FOLDER_NAME_LENGTH) &&
  x.trim().length > 0 &&
  !hasControlChar(x);

function isCreateLiveFavoriteFolderInput(x: unknown): x is CreateLiveFavoriteFolderInput {
  if (!isRecord(x) || !hasOnlyKeys(x, CREATE_FOLDER_INPUT_KEYS)) return false;
  if (x['id'] !== undefined && !isSafeFolderId(x['id'])) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  return isSafeFolderName(x['name']);
}

function isAssignLiveFavoriteFolderInput(x: unknown): x is AssignLiveFavoriteFolderInput {
  if (!isRecord(x) || !hasOnlyKeys(x, ASSIGN_FOLDER_INPUT_KEYS)) return false;
  if (!isSafeRecentChannelKey(x['itemKey'])) return false;
  if (!isSafeSourceId(x['sourceId'])) return false;
  if (x['folderId'] !== null && !isSafeFolderId(x['folderId'])) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (
    x['title'] !== undefined &&
    (!isBoundedString(x['title'], 0, MAX_TITLE_CHARS) || hasControlChar(x['title']))
  ) {
    return false;
  }
  if (
    x['logo'] !== undefined &&
    x['logo'] !== null &&
    (!isBoundedString(x['logo'], 0, MAX_LOGO_CHARS) || hasControlChar(x['logo']))
  ) {
    return false;
  }
  return true;
}

/** Validates all 8 Wave Q7-B recent-channel cleanup and Live TV favorite folder RPC calls. */
export function isWaveQ7OpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'removeRecentChannel':
      return (
        hasOnlyKeys(x, REMOVE_RECENT_KEYS) &&
        isSafeRecentChannelKey(x['itemKey']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'clearRecentChannels':
      return hasOnlyKeys(x, CLEAR_RECENT_KEYS) && isOptionalStrictProfileId(x['profileId']);
    case 'listLiveFavoriteFolders':
      return (
        hasOnlyKeys(x, LIST_FOLDERS_KEYS) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'createLiveFavoriteFolder':
      return hasOnlyKeys(x, CREATE_FOLDER_CALL_KEYS) && isCreateLiveFavoriteFolderInput(x['input']);
    case 'renameLiveFavoriteFolder':
      return (
        hasOnlyKeys(x, RENAME_FOLDER_KEYS) &&
        isSafeFolderId(x['id']) &&
        isSafeFolderName(x['name']) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'deleteLiveFavoriteFolder':
      return (
        hasOnlyKeys(x, DELETE_FOLDER_KEYS) &&
        isSafeFolderId(x['id']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'assignLiveFavoriteFolder':
      return hasOnlyKeys(x, ASSIGN_FOLDER_CALL_KEYS) && isAssignLiveFavoriteFolderInput(x['input']);
    case 'listLiveFavoriteFolderAssignments':
      return hasOnlyKeys(x, LIST_ASSIGNMENTS_KEYS) && isOptionalStrictProfileId(x['profileId']);
    default:
      return false;
  }
}
