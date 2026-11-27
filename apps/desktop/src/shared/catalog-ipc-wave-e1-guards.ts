import type {
  CleanNameGuideMatch,
  ElvItemEnrichment,
  ElvMatchingSummary,
  ElvMediaType,
  ElvQualityMemoryRecord,
  ElvTitleRecord,
  FindGuideChannelByCleanNameOptions,
  LiveVariantOption,
  MergedVodVariant,
  ParentalQueryOptions,
  RecordPlaybackQualityInput,
  SearchElvItemKeysByAliasOptions,
} from '@elv/data';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isCleanKey,
  isFiniteNumber,
  isNonNegativeFinite,
  isOptionalStrictProfileId,
  isParentalQueryOptions,
  isRecord,
  isSafeInt,
  isSearchQuery,
  isSourceIdList,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_ELV_ITEM_KEY_CHARS = 256;
const MAX_ELV_ENRICHMENT_KEYS = 500;
const MAX_ELV_PRIORITY_KEYS_IPC = 200;
const MAX_ELV_BATCH_SIZE = 500;
const MAX_ELV_ALIAS_SEARCH_LIMIT = 100;
const MAX_ELV_CHANNEL_NAME_CHARS = 256;
const MAX_CODEC_LABEL_CHARS = 64;
const MAX_CLAIMED_LABEL_CHARS = 128;
const MAX_AUDIO_CHANNELS = 64;
const IMDB_ID_RE = /^tt\d{5,10}$/i;
const SAFE_LANG_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const WHITESPACE_RE = /\s/;

/** Serializable IPC options for `liveVariants` / `listLiveVariants` (`#218`, `#511`). */
export interface LiveVariantsIpcOptions extends ParentalQueryOptions {
  readonly crossCategory?: boolean;
  readonly crossSource?: boolean;
}

/** Serializable IPC options for `getElvTitleDetail` (`#511`; excludes non-serializable `signal`). */
interface GetElvTitleDetailIpcOptions {
  readonly lang?: string;
  readonly forceRefresh?: boolean;
}

/** Serializable IPC options for `enrichElvPriorityKeys` (`#511`; excludes non-serializable `signal`). */
interface ElvPriorityMatchIpcOptions {
  readonly lang?: string;
}

/** Serializable IPC options for `runElvBackgroundMatching` (`#511`; excludes callbacks and `signal`). */
interface ElvBackgroundMatchIpcOptions {
  readonly lang?: string;
  readonly batchSize?: number;
}

/** Discriminated union of Wave E1 ELV Mode RPC calls (`#511`). */
export type CatalogWaveE1OpsRpcCall =
  | { method: 'getElvEnrichmentForKeys'; itemKeys: readonly string[] }
  | { method: 'getElvTitleDetail'; imdbId: string; opts?: GetElvTitleDetailIpcOptions }
  | { method: 'listMergedVodVersions'; itemKey: string; opts?: ParentalQueryOptions }
  | {
      method: 'enrichElvPriorityKeys';
      itemKeys: readonly string[];
      opts?: ElvPriorityMatchIpcOptions;
    }
  | { method: 'runElvBackgroundMatching'; opts?: ElvBackgroundMatchIpcOptions }
  | { method: 'recordPlaybackQuality'; input: RecordPlaybackQualityInput }
  | { method: 'recordPlaybackVariantFailure'; itemKey: string }
  | {
      method: 'setElvManualMatch';
      itemKey: string;
      sourceId: string;
      mediaType: ElvMediaType;
      imdbId: string;
    }
  | { method: 'wipeElvEnrichment' }
  | {
      method: 'searchElvItemKeysByAlias';
      query: string;
      opts?: SearchElvItemKeysByAliasOptions;
    }
  | {
      method: 'listLiveVariants';
      itemKey: string;
      categoryId?: string;
      opts?: LiveVariantsIpcOptions;
    }
  | {
      method: 'findGuideChannelByCleanName';
      sourceId: string;
      channelName: string;
      opts?: FindGuideChannelByCleanNameOptions;
    };

/** Preload bridge methods for Wave E1 ELV Mode enrichment, matching, merging & Live TV (`#511`). */
export interface CatalogBridgeWaveE1Ops {
  getElvEnrichmentForKeys?(itemKeys: readonly string[]): Promise<Record<string, ElvItemEnrichment>>;
  getElvTitleDetail?(
    imdbId: string,
    opts?: GetElvTitleDetailIpcOptions,
  ): Promise<ElvTitleRecord | null>;
  listMergedVodVersions?(itemKey: string, opts?: ParentalQueryOptions): Promise<MergedVodVariant[]>;
  enrichElvPriorityKeys?(
    itemKeys: readonly string[],
    opts?: ElvPriorityMatchIpcOptions,
  ): Promise<ElvMatchingSummary>;
  runElvBackgroundMatching?(opts?: ElvBackgroundMatchIpcOptions): Promise<ElvMatchingSummary>;
  recordPlaybackQuality?(input: RecordPlaybackQualityInput): Promise<ElvQualityMemoryRecord | null>;
  recordPlaybackVariantFailure?(itemKey: string): Promise<ElvQualityMemoryRecord | null>;
  setElvManualMatch?(
    itemKey: string,
    sourceId: string,
    mediaType: ElvMediaType,
    imdbId: string,
  ): Promise<void>;
  wipeElvEnrichment?(): Promise<void>;
  searchElvItemKeysByAlias?(
    query: string,
    opts?: SearchElvItemKeysByAliasOptions,
  ): Promise<readonly string[]>;
  listLiveVariants?(
    itemKey: string,
    categoryId?: string,
    opts?: LiveVariantsIpcOptions,
  ): Promise<readonly LiveVariantOption[]>;
  findGuideChannelByCleanName?(
    sourceId: string,
    channelName: string,
    opts?: FindGuideChannelByCleanNameOptions,
  ): Promise<CleanNameGuideMatch | null>;
}

/** Set of Wave E1 ELV Mode RPC method names for worker runtime dispatch narrowing. */
export const WAVE_E1_RPC_METHODS: ReadonlySet<string> = new Set<CatalogWaveE1OpsRpcCall['method']>([
  'getElvEnrichmentForKeys',
  'getElvTitleDetail',
  'listMergedVodVersions',
  'enrichElvPriorityKeys',
  'runElvBackgroundMatching',
  'recordPlaybackQuality',
  'recordPlaybackVariantFailure',
  'setElvManualMatch',
  'wipeElvEnrichment',
  'searchElvItemKeysByAlias',
  'listLiveVariants',
  'findGuideChannelByCleanName',
]);

const LIVE_VARIANTS_OPT_KEYS = new Set([
  'profileId',
  'parentalUnlocked',
  'crossCategory',
  'crossSource',
]);
const GET_TITLE_DETAIL_OPT_KEYS = new Set(['lang', 'forceRefresh']);
const PRIORITY_MATCH_OPT_KEYS = new Set(['lang']);
const BG_MATCH_OPT_KEYS = new Set(['lang', 'batchSize']);
const SEARCH_ALIAS_OPT_KEYS = new Set(['kind', 'limit', 'excludedSourceIds']);
const FIND_GUIDE_CLEAN_NAME_OPT_KEYS = new Set(['crossSource', 'excludedSourceIds']);
const RECORD_QUALITY_INPUT_KEYS = new Set([
  'itemKey',
  'actualWidth',
  'actualHeight',
  'actualVideoCodec',
  'actualAudioCodec',
  'actualAudioChannels',
  'actualHdr',
  'claimedLabel',
  'nowMs',
]);

const GET_ENRICHMENT_KEYS = new Set(['method', 'itemKeys']);
const GET_TITLE_DETAIL_KEYS = new Set(['method', 'imdbId', 'opts']);
const LIST_MERGED_VOD_KEYS = new Set(['method', 'itemKey', 'opts']);
const ENRICH_PRIORITY_KEYS = new Set(['method', 'itemKeys', 'opts']);
const RUN_BG_MATCH_KEYS = new Set(['method', 'opts']);
const RECORD_QUALITY_KEYS = new Set(['method', 'input']);
const RECORD_FAILURE_KEYS = new Set(['method', 'itemKey']);
const SET_MANUAL_MATCH_KEYS = new Set(['method', 'itemKey', 'sourceId', 'mediaType', 'imdbId']);
const WIPE_ELV_KEYS = new Set(['method']);
const SEARCH_ALIAS_KEYS = new Set(['method', 'query', 'opts']);
const LIST_LIVE_VARIANTS_KEYS = new Set(['method', 'itemKey', 'categoryId', 'opts']);
const FIND_GUIDE_CLEAN_NAME_KEYS = new Set(['method', 'sourceId', 'channelName', 'opts']);

const isSafeElvItemKey = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ELV_ITEM_KEY_CHARS) &&
  !WHITESPACE_RE.test(x) &&
  !hasControlChar(x) &&
  !x.includes('://') &&
  !x.includes('{{');

const isValidImdbId = (x: unknown): x is string =>
  typeof x === 'string' && IMDB_ID_RE.test(x.trim());

const isOptionalSafeLang = (x: unknown): boolean =>
  x === undefined || (typeof x === 'string' && SAFE_LANG_RE.test(x.trim()));

const isOptionalNullableCleanLabel = (x: unknown, max: number): boolean =>
  x === undefined || x === null || (isBoundedString(x, 0, max) && !hasControlChar(x));

const isOptionalNullableNonNegFinite = (x: unknown): boolean =>
  x === undefined || x === null || (isFiniteNumber(x) && x >= 0);

/** Validates {@link LiveVariantsIpcOptions} (`profileId`, `parentalUnlocked`, `crossCategory`, `crossSource`). */
export function isLiveVariantsIpcOptions(x: unknown): x is LiveVariantsIpcOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIVE_VARIANTS_OPT_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (x['parentalUnlocked'] !== undefined && typeof x['parentalUnlocked'] !== 'boolean') {
    return false;
  }
  if (x['crossCategory'] !== undefined && typeof x['crossCategory'] !== 'boolean') return false;
  return x['crossSource'] === undefined || typeof x['crossSource'] === 'boolean';
}

function isGetElvTitleDetailIpcOptions(x: unknown): x is GetElvTitleDetailIpcOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, GET_TITLE_DETAIL_OPT_KEYS)) return false;
  if (!isOptionalSafeLang(x['lang'])) return false;
  return x['forceRefresh'] === undefined || typeof x['forceRefresh'] === 'boolean';
}

function isElvPriorityMatchIpcOptions(x: unknown): x is ElvPriorityMatchIpcOptions {
  return isRecord(x) && hasOnlyKeys(x, PRIORITY_MATCH_OPT_KEYS) && isOptionalSafeLang(x['lang']);
}

function isElvBackgroundMatchIpcOptions(x: unknown): x is ElvBackgroundMatchIpcOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, BG_MATCH_OPT_KEYS)) return false;
  if (!isOptionalSafeLang(x['lang'])) return false;
  const batchSize = x['batchSize'];
  return (
    batchSize === undefined ||
    (isSafeInt(batchSize) && batchSize >= 1 && batchSize <= MAX_ELV_BATCH_SIZE)
  );
}

function isRecordPlaybackQualityInput(x: unknown): x is RecordPlaybackQualityInput {
  if (!isRecord(x) || !hasOnlyKeys(x, RECORD_QUALITY_INPUT_KEYS)) return false;
  if (!isSafeElvItemKey(x['itemKey'])) return false;
  if (!isOptionalNullableNonNegFinite(x['actualWidth'])) return false;
  if (!isOptionalNullableNonNegFinite(x['actualHeight'])) return false;
  if (!isOptionalNullableCleanLabel(x['actualVideoCodec'], MAX_CODEC_LABEL_CHARS)) return false;
  if (!isOptionalNullableCleanLabel(x['actualAudioCodec'], MAX_CODEC_LABEL_CHARS)) return false;
  const ch = x['actualAudioChannels'];
  if (ch !== undefined && ch !== null && (!isSafeInt(ch) || ch < 0 || ch > MAX_AUDIO_CHANNELS)) {
    return false;
  }
  if (!isOptionalNullableCleanLabel(x['actualHdr'], MAX_CODEC_LABEL_CHARS)) return false;
  if (!isOptionalNullableCleanLabel(x['claimedLabel'], MAX_CLAIMED_LABEL_CHARS)) return false;
  return x['nowMs'] === undefined || isNonNegativeFinite(x['nowMs']);
}

function isBoundedElvKeyList(x: unknown, max: number): x is readonly string[] {
  return Array.isArray(x) && x.length <= max && x.every((k) => isSafeElvItemKey(k));
}

function isSearchElvItemKeysByAliasOptions(x: unknown): x is SearchElvItemKeysByAliasOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, SEARCH_ALIAS_OPT_KEYS)) return false;
  const kind = x['kind'];
  if (kind !== undefined && kind !== 'movie' && kind !== 'series') return false;
  const limit = x['limit'];
  if (
    limit !== undefined &&
    (!isSafeInt(limit) || limit < 0 || limit > MAX_ELV_ALIAS_SEARCH_LIMIT)
  ) {
    return false;
  }
  return x['excludedSourceIds'] === undefined || isSourceIdList(x['excludedSourceIds']);
}

function isFindGuideChannelByCleanNameOptions(x: unknown): x is FindGuideChannelByCleanNameOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, FIND_GUIDE_CLEAN_NAME_OPT_KEYS)) return false;
  if (x['crossSource'] !== undefined && typeof x['crossSource'] !== 'boolean') return false;
  return x['excludedSourceIds'] === undefined || isSourceIdList(x['excludedSourceIds']);
}

/** Validates all Wave E1 ELV Mode RPC method call payloads (`#511`). */
export function isWaveE1OpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'getElvEnrichmentForKeys':
      return (
        hasOnlyKeys(x, GET_ENRICHMENT_KEYS) &&
        isBoundedElvKeyList(x['itemKeys'], MAX_ELV_ENRICHMENT_KEYS)
      );
    case 'getElvTitleDetail':
      return (
        hasOnlyKeys(x, GET_TITLE_DETAIL_KEYS) &&
        isValidImdbId(x['imdbId']) &&
        (x['opts'] === undefined || isGetElvTitleDetailIpcOptions(x['opts']))
      );
    case 'listMergedVodVersions':
      return (
        hasOnlyKeys(x, LIST_MERGED_VOD_KEYS) &&
        isSafeElvItemKey(x['itemKey']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'enrichElvPriorityKeys':
      return (
        hasOnlyKeys(x, ENRICH_PRIORITY_KEYS) &&
        isBoundedElvKeyList(x['itemKeys'], MAX_ELV_PRIORITY_KEYS_IPC) &&
        (x['opts'] === undefined || isElvPriorityMatchIpcOptions(x['opts']))
      );
    case 'runElvBackgroundMatching':
      return (
        hasOnlyKeys(x, RUN_BG_MATCH_KEYS) &&
        (x['opts'] === undefined || isElvBackgroundMatchIpcOptions(x['opts']))
      );
    case 'recordPlaybackQuality':
      return hasOnlyKeys(x, RECORD_QUALITY_KEYS) && isRecordPlaybackQualityInput(x['input']);
    case 'recordPlaybackVariantFailure':
      return hasOnlyKeys(x, RECORD_FAILURE_KEYS) && isSafeElvItemKey(x['itemKey']);
    case 'setElvManualMatch':
      return (
        hasOnlyKeys(x, SET_MANUAL_MATCH_KEYS) &&
        isSafeElvItemKey(x['itemKey']) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        (x['mediaType'] === 'movie' || x['mediaType'] === 'series') &&
        isValidImdbId(x['imdbId'])
      );
    case 'wipeElvEnrichment':
      return hasOnlyKeys(x, WIPE_ELV_KEYS);
    case 'searchElvItemKeysByAlias':
      return (
        hasOnlyKeys(x, SEARCH_ALIAS_KEYS) &&
        isSearchQuery(x['query']) &&
        (x['opts'] === undefined || isSearchElvItemKeysByAliasOptions(x['opts']))
      );
    case 'listLiveVariants':
      return (
        hasOnlyKeys(x, LIST_LIVE_VARIANTS_KEYS) &&
        isSafeElvItemKey(x['itemKey']) &&
        (x['categoryId'] === undefined || isCleanKey(x['categoryId'], 512)) &&
        (x['opts'] === undefined || isLiveVariantsIpcOptions(x['opts']))
      );
    case 'findGuideChannelByCleanName':
      return (
        hasOnlyKeys(x, FIND_GUIDE_CLEAN_NAME_KEYS) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        isBoundedString(x['channelName'], 1, MAX_ELV_CHANNEL_NAME_CHARS) &&
        x['channelName'].trim().length > 0 &&
        !hasControlChar(x['channelName']) &&
        (x['opts'] === undefined || isFindGuideChannelByCleanNameOptions(x['opts']))
      );
    default:
      return false;
  }
}
