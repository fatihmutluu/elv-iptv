import {
  type CreateFailoverGroupInput,
  FAILOVER_GROUP_ID_RE,
  type FailoverGroupRecord,
  isSafeChannelKey,
  MAX_FAILOVER_GROUP_NAME_LENGTH,
  SOURCE_ID,
  type SuggestedFailoverCluster,
  type SuggestedFailoverClusterMember,
} from '@elv/data';
import { originOf, type Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isNonNegativeFinite,
  isRecord,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_FAILOVER_GROUP_MEMBERS = 128;
const MAX_SUGGESTED_CLUSTERS = 2_000;
const MAX_CLUSTER_KEY_CHARS = 256;
const MAX_CLUSTER_TEXT_CHARS = 512;
const MAX_SERVER_URL_CHARS = 4_096;

/** Discriminated union of all 11 Wave F5A multi-source failover group and stream outcome RPC calls (`#157`, `#317`). */
export type CatalogFailoverOpsRpcCall =
  | { method: 'listFailoverGroups' }
  | { method: 'getFailoverGroupByChannel'; channelKey: string }
  | { method: 'createFailoverGroup'; input: CreateFailoverGroupInput }
  | { method: 'renameFailoverGroup'; groupId: string; name: string }
  | { method: 'deleteFailoverGroup'; groupId: string }
  | { method: 'addFailoverGroupMember'; groupId: string; channelKey: string }
  | { method: 'removeFailoverGroupMember'; groupId: string; channelKey: string }
  | {
      method: 'reorderFailoverGroupMembers';
      groupId: string;
      orderedChannelKeys: readonly string[];
    }
  | { method: 'suggestFailoverGroups' }
  | {
      method: 'applySuggestedFailoverGroups';
      clusters: readonly SuggestedFailoverCluster[];
    }
  | {
      method: 'reportStreamOutcome';
      sourceId: string;
      serverUrl: string;
      succeeded: boolean;
    };

/** Preload bridge methods for Wave F5A multi-source failover groups and split Xtream stream outcomes (`#157`, `#317`). */
export interface CatalogBridgeFailoverOps {
  listFailoverGroups?(): Promise<FailoverGroupRecord[]>;
  getFailoverGroupByChannel?(channelKey: string): Promise<FailoverGroupRecord | undefined>;
  createFailoverGroup?(input: CreateFailoverGroupInput): Promise<Result<FailoverGroupRecord>>;
  renameFailoverGroup?(groupId: string, name: string): Promise<Result<FailoverGroupRecord>>;
  deleteFailoverGroup?(groupId: string): Promise<Result<void>>;
  addFailoverGroupMember?(
    groupId: string,
    channelKey: string,
  ): Promise<Result<FailoverGroupRecord>>;
  removeFailoverGroupMember?(
    groupId: string,
    channelKey: string,
  ): Promise<Result<FailoverGroupRecord>>;
  reorderFailoverGroupMembers?(
    groupId: string,
    orderedChannelKeys: readonly string[],
  ): Promise<Result<FailoverGroupRecord>>;
  suggestFailoverGroups?(): Promise<SuggestedFailoverCluster[]>;
  applySuggestedFailoverGroups?(
    clusters: readonly SuggestedFailoverCluster[],
  ): Promise<Result<FailoverGroupRecord[]>>;
  reportStreamOutcome?(sourceId: string, serverUrl: string, succeeded: boolean): Promise<void>;
}

const CREATE_FAILOVER_GROUP_KEYS = new Set(['id', 'name', 'autoMatched', 'channelKeys', 'nowMs']);
const SUGGESTED_CLUSTER_KEYS = new Set([
  'normalizedKey',
  'suggestedName',
  'matchReason',
  'members',
]);
const SUGGESTED_MEMBER_KEYS = new Set(['sourceId', 'channelKey', 'channelName', 'sourceName']);

const METHOD_ONLY_CALL_KEYS = new Set(['method']);
const CHANNEL_KEY_CALL_KEYS = new Set(['method', 'channelKey']);
const CREATE_CALL_KEYS = new Set(['method', 'input']);
const RENAME_CALL_KEYS = new Set(['method', 'groupId', 'name']);
const GROUP_ID_CALL_KEYS = new Set(['method', 'groupId']);
const GROUP_MEMBER_CALL_KEYS = new Set(['method', 'groupId', 'channelKey']);
const REORDER_CALL_KEYS = new Set(['method', 'groupId', 'orderedChannelKeys']);
const APPLY_CLUSTERS_CALL_KEYS = new Set(['method', 'clusters']);
const STREAM_OUTCOME_CALL_KEYS = new Set(['method', 'sourceId', 'serverUrl', 'succeeded']);

const isSafeSourceId = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ID_CHARS) && SOURCE_ID.test(x);

const isSafeFailoverGroupId = (x: unknown): x is string =>
  typeof x === 'string' && FAILOVER_GROUP_ID_RE.test(x);

const isSafeFailoverGroupName = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_FAILOVER_GROUP_NAME_LENGTH) &&
  x.trim().length > 0 &&
  !hasControlChar(x);

function isBoundedChannelKeyList(x: unknown): x is readonly string[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_FAILOVER_GROUP_MEMBERS &&
    x.every((k) => isSafeChannelKey(k))
  );
}

function isHttpServerUrl(x: unknown): x is string {
  if (!isBoundedString(x, 1, MAX_SERVER_URL_CHARS) || hasControlChar(x)) return false;
  const trimmed = x.trim();
  if (trimmed.length === 0 || !/^https?:\/\//i.test(trimmed)) return false;
  if (trimmed.includes('@') || trimmed.includes('?') || trimmed.includes('#')) return false;
  if (originOf(trimmed) === undefined) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.pathname === '' || parsed.pathname === '/') &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function isCreateFailoverGroupInput(x: unknown): x is CreateFailoverGroupInput {
  if (!isRecord(x) || !hasOnlyKeys(x, CREATE_FAILOVER_GROUP_KEYS)) return false;
  if (x['id'] !== undefined && !isSafeFailoverGroupId(x['id'])) return false;
  if (!isSafeFailoverGroupName(x['name'])) return false;
  if (x['autoMatched'] !== undefined && typeof x['autoMatched'] !== 'boolean') return false;
  if (x['channelKeys'] !== undefined && !isBoundedChannelKeyList(x['channelKeys'])) return false;
  return x['nowMs'] === undefined || isNonNegativeFinite(x['nowMs']);
}

function isSuggestedClusterMember(x: unknown): x is SuggestedFailoverClusterMember {
  return (
    isRecord(x) &&
    hasOnlyKeys(x, SUGGESTED_MEMBER_KEYS) &&
    isSafeSourceId(x['sourceId']) &&
    isSafeChannelKey(x['channelKey']) &&
    isBoundedString(x['channelName'], 0, MAX_CLUSTER_TEXT_CHARS) &&
    !hasControlChar(x['channelName']) &&
    isBoundedString(x['sourceName'], 0, MAX_CLUSTER_TEXT_CHARS) &&
    !hasControlChar(x['sourceName'])
  );
}

function isSuggestedFailoverCluster(x: unknown): x is SuggestedFailoverCluster {
  if (!isRecord(x) || !hasOnlyKeys(x, SUGGESTED_CLUSTER_KEYS)) return false;
  const normalizedKey = x['normalizedKey'];
  if (!isBoundedString(normalizedKey, 1, MAX_CLUSTER_KEY_CHARS) || hasControlChar(normalizedKey)) {
    return false;
  }
  if (!isSafeFailoverGroupName(x['suggestedName'])) return false;
  if (x['matchReason'] !== 'guide-id' && x['matchReason'] !== 'name') return false;
  const members = x['members'];
  return (
    Array.isArray(members) &&
    members.length <= MAX_FAILOVER_GROUP_MEMBERS &&
    members.every((m) => isSuggestedClusterMember(m))
  );
}

function isSuggestedClusterList(x: unknown): x is readonly SuggestedFailoverCluster[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_SUGGESTED_CLUSTERS &&
    x.every((cluster) => isSuggestedFailoverCluster(cluster))
  );
}

/** Validates all 11 Wave F5A failover group and stream outcome RPC calls (`#157`, `#317`). */
export function isFailoverOpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'listFailoverGroups':
    case 'suggestFailoverGroups':
      return hasOnlyKeys(x, METHOD_ONLY_CALL_KEYS);
    case 'getFailoverGroupByChannel':
      return hasOnlyKeys(x, CHANNEL_KEY_CALL_KEYS) && isSafeChannelKey(x['channelKey']);
    case 'createFailoverGroup':
      return hasOnlyKeys(x, CREATE_CALL_KEYS) && isCreateFailoverGroupInput(x['input']);
    case 'renameFailoverGroup':
      return (
        hasOnlyKeys(x, RENAME_CALL_KEYS) &&
        isSafeFailoverGroupId(x['groupId']) &&
        isSafeFailoverGroupName(x['name'])
      );
    case 'deleteFailoverGroup':
      return hasOnlyKeys(x, GROUP_ID_CALL_KEYS) && isSafeFailoverGroupId(x['groupId']);
    case 'addFailoverGroupMember':
    case 'removeFailoverGroupMember':
      return (
        hasOnlyKeys(x, GROUP_MEMBER_CALL_KEYS) &&
        isSafeFailoverGroupId(x['groupId']) &&
        isSafeChannelKey(x['channelKey'])
      );
    case 'reorderFailoverGroupMembers':
      return (
        hasOnlyKeys(x, REORDER_CALL_KEYS) &&
        isSafeFailoverGroupId(x['groupId']) &&
        isBoundedChannelKeyList(x['orderedChannelKeys'])
      );
    case 'applySuggestedFailoverGroups':
      return hasOnlyKeys(x, APPLY_CLUSTERS_CALL_KEYS) && isSuggestedClusterList(x['clusters']);
    case 'reportStreamOutcome':
      return (
        hasOnlyKeys(x, STREAM_OUTCOME_CALL_KEYS) &&
        isSafeSourceId(x['sourceId']) &&
        isHttpServerUrl(x['serverUrl']) &&
        typeof x['succeeded'] === 'boolean'
      );
    default:
      return false;
  }
}
