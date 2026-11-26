import type {
  AddSourceInput,
  AlphabetBucket,
  AlphabetIndexInput,
  BrowseKind,
  CategoryQueryOptions,
  CategoryRow,
  ChannelOverrideRecord,
  CreateCustomGroupInput,
  CreateProfileInput,
  CrossChannelProgrammeRow,
  CustomGroupItemInput,
  CustomGroupRecord,
  DiscoveredCategory,
  EpisodeRow,
  FavoriteRow,
  ImportProgress,
  ImportSummary,
  ItemDetailRow,
  ItemRow,
  LinkSourceInput,
  ListItemsOptions,
  LiveVariantOption,
  LocalM3uSourceInput,
  MyListNewEpisodeRow,
  NextEpisodeRow,
  NowNextEntry,
  ParentalLockFilter,
  ParentalLockRecord,
  ParentalQueryOptions,
  ParentalSettings,
  PersistedTrackPreference,
  PinVerifyResult,
  ProfileRecord,
  ProgrammeRow,
  RefreshMyListNewEpisodesOptions,
  RefreshMyListNewEpisodesResult,
  SaveProgressInput,
  SaveTrackPreferenceInput,
  SearchOptions,
  SearchResults,
  SearchSuggestion,
  SearchSuggestionsOptions,
  SeasonRow,
  SeriesUnplayedSummary,
  SetChannelOverrideInput,
  SetParentalLockInput,
  SourceRow,
  SourceSettings,
  StreamRequest,
  ToggleFavoriteInput,
  UpdateCustomGroupPatch,
  UpdateParentalSettingsPatch,
  UpdateProfilePatch,
  VodVersionOption,
  WatchProgressRow,
} from '@elv/data';
import type { ElvError, Result } from '@elv/domain';
import {
  isChannelOpsRpcCall,
  isIncludeHiddenParentalOptions,
} from './catalog-ipc-channel-guards.ts';
import {
  type CatalogBridgeEpgOps,
  type CatalogEpgOpsRpcCall,
  isEpgOpsRpcCall,
} from './catalog-ipc-epg-guards.ts';
import {
  type CatalogBridgeFailoverOps,
  type CatalogFailoverOpsRpcCall,
  isFailoverOpsRpcCall,
} from './catalog-ipc-failover-guards.ts';
import {
  isAddSourceInput,
  isAlphabetIndexInput,
  isBoundedString,
  isCategoryQueryOptions,
  isCleanKey,
  isCreateProfileInput,
  isElvError,
  isEpgWindowKeyList,
  isFiniteNumber,
  isImportProgress,
  isItemKeyList,
  isLinkSourceInput,
  isListItemsOptions,
  isListWatchedOptions,
  isLocalM3uSourceInput,
  isNonNegativeFinite,
  isNowNextKeyList,
  isOptionalNewEpisodesLimit,
  isOptionalProfileId,
  isOptionalSourceId,
  isOptionalStrictProfileId,
  isOptionalUserLimit,
  isOrderedFavoriteKeys,
  isParentalLockFilter,
  isParentalQueryOptions,
  isParentalUnlockedOption,
  isPinString,
  isPositiveId,
  isRecord,
  isRefreshMyListNewEpisodesOptions,
  isSafeInt,
  isSafeRecentChannelKey,
  isSaveProgressInput,
  isSaveTrackPreferenceInput,
  isSearchOptions,
  isSearchQuery,
  isSearchSuggestionsOptions,
  isSeriesKeyList,
  isSetParentalLockInput,
  isSourceIdList,
  isSourceSettingsPatch,
  isStrictProfileId,
  isToggleFavoriteInput,
  isUpdateParentalSettingsPatch,
  isUpdateProfilePatch,
  MAX_ID_CHARS,
  MAX_ITEM_KEY_CHARS,
} from './catalog-ipc-guards.ts';
import {
  type CatalogBridgeWaveF5bOps,
  type CatalogWaveF5bOpsRpcCall,
  isWaveF5bOpsRpcCall,
} from './catalog-ipc-wave-f5b-guards.ts';

/** IPC channels used to establish and fence a renderer's catalog `MessagePort`. */
export const CATALOG_CHANNELS = Object.freeze({
  connect: 'catalog:connect',
  port: 'catalog:port',
  disconnected: 'catalog:disconnected',
  changed: 'catalog:changed',
} as const);

/** Preload to main (`catalog:connect`): requests a dedicated `MessagePort` to the catalog worker. */
export interface CatalogConnectMessage {
  connectId: number;
}

/** Main to preload (`catalog:port`, with `[port]` transferred): delivers the requested `MessagePort`. */
export interface CatalogPortMessage {
  connectId: number;
}

/** Main to preload (`catalog:disconnected`): signals that the catalog utility process exited. */
export interface CatalogDisconnectedMessage {
  reason: 'worker-exited';
}

/** Discriminated RPC call payload sent over a client `MessagePort` to the catalog utility process. */
export type CatalogRpcMethodCall =
  | { method: 'ping' }
  | { method: 'addSource'; input: AddSourceInput }
  | { method: 'addSourceFromLink'; input: LinkSourceInput }
  | { method: 'addLocalM3uSource'; input: LocalM3uSourceInput }
  | { method: 'discoverSourceCategories'; sourceId: string }
  | { method: 'updateSourceSettings'; sourceId: string; patch: Partial<SourceSettings> }
  | { method: 'removeSource'; id: string }
  | {
      method: 'importSource';
      id: string;
      batchSize?: number;
      maxBodyBytes?: number;
      progress?: boolean;
    }
  | { method: 'importGuide'; id: string }
  | { method: 'listSources' }
  | { method: 'categories'; sourceId: string; kind: BrowseKind; opts?: CategoryQueryOptions }
  | {
      method: 'items';
      categoryId: string;
      offset: number;
      limit: number;
      opts?: ListItemsOptions;
    }
  | { method: 'liveVariants'; itemKey: string; categoryId?: string; opts?: ParentalQueryOptions }
  | { method: 'itemVersions'; itemKey: string; opts?: ParentalQueryOptions }
  | {
      method: 'allSourcesItems';
      kind: BrowseKind;
      offset: number;
      limit: number;
      sourceIds?: readonly string[];
      opts?: ListItemsOptions;
    }
  | { method: 'itemDetail'; itemKey: string; opts?: ParentalQueryOptions }
  | { method: 'search'; query: string; opts?: SearchOptions }
  | { method: 'searchSuggestions'; options?: SearchSuggestionsOptions }
  | { method: 'alphabetIndex'; input: AlphabetIndexInput }
  | {
      method: 'nowNext';
      channelKeys: readonly string[];
      nowMs: number;
      opts?: ParentalQueryOptions;
    }
  | {
      method: 'epgWindow';
      channelKeys: readonly string[];
      fromMs: number;
      toMs: number;
      opts?: ParentalQueryOptions;
    }
  | {
      method: 'epgSlice';
      sourceId: string;
      fromMs: number;
      toMs: number;
      limit?: number;
      opts?: ParentalQueryOptions;
    }
  | { method: 'channelByNumber'; num: number; sourceId?: string; opts?: ParentalQueryOptions }
  | { method: 'seasons'; seriesId: number; opts?: ParentalQueryOptions }
  | { method: 'episodes'; seriesId: number; season: number; opts?: ParentalQueryOptions }
  | {
      method: 'queryNextEpisode';
      seriesKey: string;
      currentItemKey: string;
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | { method: 'resolveStream'; itemKey: string; opts?: ParentalQueryOptions }
  | { method: 'saveProgress'; input: SaveProgressInput }
  | { method: 'setWatched'; itemKey: string; watched: boolean; profileId?: string }
  | { method: 'getProgress'; itemKey: string; profileId?: string }
  | {
      method: 'listContinueWatching';
      limit?: number;
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | {
      method: 'listWatched';
      limit?: number;
      profileId?: string;
      opts?: { readonly kind?: 'movie' | 'series'; readonly parentalUnlocked?: boolean };
    }
  | { method: 'listProgressByKeys'; itemKeys: readonly string[]; profileId?: string }
  | { method: 'listSeriesUnplayedCounts'; seriesKeys: readonly string[]; profileId?: string }
  | { method: 'clearProgress'; itemKey: string; profileId?: string }
  | { method: 'toggleFavorite'; input: ToggleFavoriteInput }
  | { method: 'setFavorite'; input: ToggleFavoriteInput; active: boolean }
  | { method: 'reorderFavorites'; orderedItemKeys: readonly string[]; profileId?: string }
  | {
      method: 'listFavorites';
      limit?: number;
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean; readonly includeHidden?: boolean };
    }
  | { method: 'listFavoriteKeys'; profileId?: string }
  | {
      method: 'listMyListNewEpisodes';
      limit?: number;
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | { method: 'dismissMyListNewEpisode'; episodeKey: string; profileId?: string }
  | {
      method: 'refreshMyListNewEpisodes';
      profileId?: string;
      opts?: RefreshMyListNewEpisodesOptions;
    }
  | { method: 'getTrackPreference'; scopeKey: string; profileId?: string }
  | { method: 'saveTrackPreference'; input: SaveTrackPreferenceInput }
  | { method: 'clearTrackPreference'; scopeKey: string; profileId?: string }
  | { method: 'recordRecentChannel'; itemKey: string; sourceId: string; profileId?: string }
  | {
      method: 'listRecentChannels';
      limit?: number;
      profileId?: string;
      opts?: { readonly parentalUnlocked?: boolean };
    }
  | { method: 'listProfiles' }
  | { method: 'createProfile'; input: CreateProfileInput }
  | { method: 'updateProfile'; id: string; patch: UpdateProfilePatch }
  | { method: 'deleteProfile'; id: string }
  | { method: 'getParentalSettings'; profileId?: string }
  | { method: 'updateParentalSettings'; patch: UpdateParentalSettingsPatch; profileId?: string }
  | { method: 'listParentalLocks'; profileId?: string; filter?: ParentalLockFilter }
  | { method: 'setParentalLock'; input: SetParentalLockInput; locked: boolean }
  | { method: 'hasParentalPin'; profileId?: string }
  | { method: 'setParentalPin'; pin: string; profileId?: string; currentPin?: string }
  | { method: 'verifyParentalPin'; pin: string; profileId?: string }
  | { method: 'clearParentalPin'; currentPin: string; profileId?: string }
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
  | { method: 'removeChannelFromCustomGroup'; groupId: string; itemKey: string }
  | { method: 'flushPendingWrites' }
  | CatalogEpgOpsRpcCall
  | CatalogFailoverOpsRpcCall
  | CatalogWaveF5bOpsRpcCall;

/** Preload to utility process over `MessagePort`. */
export type CatalogClientMessage =
  | { type: 'call'; reqId: number; call: CatalogRpcMethodCall }
  | { type: 'cancel'; reqId: number };

/** Utility process to preload over `MessagePort`. */
export type CatalogWorkerMessage =
  | { type: 'result'; reqId: number; value: unknown }
  | { type: 'fault'; reqId: number; error: ElvError }
  | { type: 'progress'; reqId: number; progress: ImportProgress };

/** Import options accepted across `contextBridge` (plain values and callback only; no `AbortSignal`). */
export interface CatalogBridgeImportOptions {
  batchSize?: number;
  maxBodyBytes?: number;
  onProgress?: (progress: ImportProgress) => void;
}

/** Handle returned by {@link CatalogBridge.startImport} so the renderer can cancel by `reqId`. */
export interface CatalogImportHandle {
  readonly reqId: number;
  readonly result: Promise<Result<ImportSummary>>;
}

/** Frozen `window.elv.catalog` surface exposed by the preload; raw `MessagePort` never crosses `contextBridge`. */
export interface CatalogBridge
  extends CatalogBridgeEpgOps,
    CatalogBridgeFailoverOps,
    CatalogBridgeWaveF5bOps {
  open(): Promise<Result<void>>;
  addSource(input: AddSourceInput): Promise<Result<SourceRow>>;
  addSourceFromLink(input: LinkSourceInput): Promise<Result<SourceRow>>;
  addLocalM3uSource?(input: LocalM3uSourceInput): Promise<Result<SourceRow>>;
  discoverSourceCategories?(sourceId: string): Promise<Result<readonly DiscoveredCategory[]>>;
  updateSourceSettings?(sourceId: string, patch: Partial<SourceSettings>): Promise<void>;
  removeSource(id: string): Promise<Result<void>>;
  startImport(id: string, opts?: CatalogBridgeImportOptions): CatalogImportHandle;
  cancelImport(reqId: number): void;
  importGuide(id: string): Promise<Result<ImportSummary>>;
  listSources(): Promise<SourceRow[]>;
  categories(
    sourceId: string,
    kind: BrowseKind,
    opts?: CategoryQueryOptions,
  ): Promise<CategoryRow[]>;
  items(
    categoryId: string,
    offset: number,
    limit: number,
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  liveVariants?(
    itemKey: string,
    categoryId?: string,
    opts?: ParentalQueryOptions,
  ): Promise<readonly LiveVariantOption[]>;
  itemVersions?(itemKey: string, opts?: ParentalQueryOptions): Promise<readonly VodVersionOption[]>;
  allSourcesItems?(
    kind: BrowseKind,
    offset: number,
    limit: number,
    sourceIds?: readonly string[],
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  itemDetail(itemKey: string, opts?: ParentalQueryOptions): Promise<ItemDetailRow | null>;
  search(query: string, opts?: SearchOptions): Promise<SearchResults>;
  searchSuggestions?(options?: SearchSuggestionsOptions): Promise<readonly SearchSuggestion[]>;
  alphabetIndex?(input: AlphabetIndexInput): Promise<readonly AlphabetBucket[]>;
  nowNext(
    channelKeys: readonly string[],
    nowMs: number,
    opts?: ParentalQueryOptions,
  ): Promise<NowNextEntry[]>;
  epgWindow(
    channelKeys: readonly string[],
    fromMs: number,
    toMs: number,
    opts?: ParentalQueryOptions,
  ): Promise<Record<string, ProgrammeRow[]>>;
  epgSlice?(
    sourceId: string,
    fromMs: number,
    toMs: number,
    limit?: number,
    opts?: ParentalQueryOptions,
  ): Promise<CrossChannelProgrammeRow[]>;
  channelByNumber(
    num: number,
    sourceId?: string,
    opts?: ParentalQueryOptions,
  ): Promise<ItemRow | null>;
  seasons(seriesId: number, opts?: ParentalQueryOptions): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number, opts?: ParentalQueryOptions): Promise<EpisodeRow[]>;
  queryNextEpisode(
    seriesKey: string,
    currentItemKey: string,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<NextEpisodeRow | null>;
  resolveStream(itemKey: string, opts?: ParentalQueryOptions): Promise<Result<StreamRequest>>;
  saveProgress(input: SaveProgressInput): Promise<Result<WatchProgressRow>>;
  setWatched(itemKey: string, watched: boolean, profileId?: string): Promise<Result<void>>;
  getProgress(itemKey: string, profileId?: string): Promise<WatchProgressRow | null>;
  listContinueWatching(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<WatchProgressRow[]>;
  listWatched?(
    limit?: number,
    profileId?: string,
    opts?: { readonly kind?: 'movie' | 'series'; readonly parentalUnlocked?: boolean },
  ): Promise<WatchProgressRow[]>;
  listProgressByKeys(itemKeys: readonly string[], profileId?: string): Promise<WatchProgressRow[]>;
  listSeriesUnplayedCounts?(
    seriesKeys: readonly string[],
    profileId?: string,
  ): Promise<SeriesUnplayedSummary[]>;
  clearProgress(itemKey: string, profileId?: string): Promise<Result<void>>;
  toggleFavorite(input: ToggleFavoriteInput): Promise<Result<boolean>>;
  setFavorite(input: ToggleFavoriteInput, active: boolean): Promise<Result<boolean>>;
  reorderFavorites?(orderedItemKeys: readonly string[], profileId?: string): Promise<Result<void>>;
  listFavorites(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean; readonly includeHidden?: boolean },
  ): Promise<FavoriteRow[]>;
  listFavoriteKeys(profileId?: string): Promise<string[]>;
  listMyListNewEpisodes?(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<MyListNewEpisodeRow[]>;
  dismissMyListNewEpisode?(episodeKey: string, profileId?: string): Promise<Result<void>>;
  refreshMyListNewEpisodes?(
    profileId?: string,
    opts?: RefreshMyListNewEpisodesOptions,
  ): Promise<Result<RefreshMyListNewEpisodesResult>>;
  getTrackPreference?(
    scopeKey: string,
    profileId?: string,
  ): Promise<PersistedTrackPreference | null>;
  saveTrackPreference?(input: SaveTrackPreferenceInput): Promise<void>;
  clearTrackPreference?(scopeKey: string, profileId?: string): Promise<void>;
  recordRecentChannel?(itemKey: string, sourceId: string, profileId?: string): Promise<void>;
  listRecentChannels?(
    limit?: number,
    profileId?: string,
    opts?: { readonly parentalUnlocked?: boolean },
  ): Promise<ItemRow[]>;
  listProfiles?(): Promise<ProfileRecord[]>;
  createProfile?(input: CreateProfileInput): Promise<Result<ProfileRecord>>;
  updateProfile?(id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>>;
  deleteProfile?(id: string): Promise<Result<void>>;
  getParentalSettings?(profileId?: string): Promise<ParentalSettings>;
  updateParentalSettings?(
    patch: UpdateParentalSettingsPatch,
    profileId?: string,
  ): Promise<Result<ParentalSettings>>;
  listParentalLocks?(
    profileId?: string,
    filter?: ParentalLockFilter,
  ): Promise<ParentalLockRecord[]>;
  setParentalLock?(input: SetParentalLockInput, locked: boolean): Promise<Result<void>>;
  hasParentalPin?(profileId?: string): Promise<boolean>;
  setParentalPin?(pin: string, profileId?: string, currentPin?: string): Promise<Result<void>>;
  verifyParentalPin?(pin: string, profileId?: string): Promise<PinVerifyResult>;
  clearParentalPin?(currentPin: string, profileId?: string): Promise<Result<void>>;
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
  flushPendingWrites?(): Promise<void>;
  onChanged(listener: () => void): () => void;
  /** Subscribes to unexpected `catalog-worker` disconnect notifications (`#435`). */
  onDisconnected(listener: (message: CatalogDisconnectedMessage) => void): () => void;
  close(): Promise<void>;
}

function isRpcCall(x: unknown): x is CatalogRpcMethodCall {
  if (!isRecord(x)) return false;
  switch (x['method']) {
    case 'ping':
    case 'listSources':
    case 'listProfiles':
    case 'flushPendingWrites':
      return true;
    case 'addSource':
      return isAddSourceInput(x['input']);
    case 'addSourceFromLink':
      return isLinkSourceInput(x['input']);
    case 'addLocalM3uSource':
      return isLocalM3uSourceInput(x['input']);
    case 'discoverSourceCategories':
      return isCleanKey(x['sourceId'], MAX_ID_CHARS);
    case 'updateSourceSettings':
      return isCleanKey(x['sourceId'], MAX_ID_CHARS) && isSourceSettingsPatch(x['patch']);
    case 'removeSource':
      return isBoundedString(x['id'], 0, MAX_ID_CHARS);
    case 'importSource':
      return (
        isBoundedString(x['id'], 0, MAX_ID_CHARS) &&
        (x['batchSize'] === undefined || isPositiveId(x['batchSize'])) &&
        (x['maxBodyBytes'] === undefined || isPositiveId(x['maxBodyBytes'])) &&
        (x['progress'] === undefined || typeof x['progress'] === 'boolean')
      );
    case 'importGuide':
      return isCleanKey(x['id'], MAX_ID_CHARS);
    case 'categories':
      return (
        isBoundedString(x['sourceId'], 0, MAX_ID_CHARS) &&
        (x['kind'] === 'live' || x['kind'] === 'movie' || x['kind'] === 'series') &&
        (x['opts'] === undefined || isCategoryQueryOptions(x['opts']))
      );
    case 'items':
      return (
        isBoundedString(x['categoryId'], 0, 512) &&
        isFiniteNumber(x['offset']) &&
        isFiniteNumber(x['limit']) &&
        (x['opts'] === undefined || isListItemsOptions(x['opts']))
      );
    case 'liveVariants':
      return (
        isCleanKey(x['itemKey']) &&
        (x['categoryId'] === undefined || isCleanKey(x['categoryId'], 512)) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'itemVersions':
      return (
        isCleanKey(x['itemKey']) && (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'allSourcesItems':
      return (
        (x['kind'] === 'live' || x['kind'] === 'movie' || x['kind'] === 'series') &&
        isFiniteNumber(x['offset']) &&
        isFiniteNumber(x['limit']) &&
        (x['sourceIds'] === undefined || isSourceIdList(x['sourceIds'])) &&
        (x['opts'] === undefined || isListItemsOptions(x['opts']))
      );
    case 'itemDetail':
      return (
        isCleanKey(x['itemKey']) && (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'search':
      return isSearchQuery(x['query']) && (x['opts'] === undefined || isSearchOptions(x['opts']));
    case 'searchSuggestions':
      return x['options'] === undefined || isSearchSuggestionsOptions(x['options']);
    case 'alphabetIndex':
      return isAlphabetIndexInput(x['input']);
    case 'nowNext':
      return (
        isNowNextKeyList(x['channelKeys']) &&
        isNonNegativeFinite(x['nowMs']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'epgWindow':
      return (
        isEpgWindowKeyList(x['channelKeys']) &&
        isNonNegativeFinite(x['fromMs']) &&
        isNonNegativeFinite(x['toMs']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'epgSlice':
      return (
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        isNonNegativeFinite(x['fromMs']) &&
        isNonNegativeFinite(x['toMs']) &&
        (x['limit'] === undefined ||
          (isSafeInt(x['limit']) && x['limit'] >= 0 && x['limit'] <= 500)) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'channelByNumber':
      return (
        isNonNegativeFinite(x['num']) &&
        isOptionalSourceId(x['sourceId']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'seasons':
      return (
        isSafeInt(x['seriesId']) && (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'episodes':
      return (
        isSafeInt(x['seriesId']) &&
        isSafeInt(x['season']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'queryNextEpisode':
      return (
        isCleanKey(x['seriesKey']) &&
        isCleanKey(x['currentItemKey']) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'resolveStream':
      return (
        isBoundedString(x['itemKey'], 0, MAX_ITEM_KEY_CHARS) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'saveProgress':
      return isSaveProgressInput(x['input']);
    case 'setWatched':
      return (
        isCleanKey(x['itemKey']) &&
        typeof x['watched'] === 'boolean' &&
        isOptionalProfileId(x['profileId'])
      );
    case 'getProgress':
    case 'clearProgress':
      return isCleanKey(x['itemKey']) && isOptionalProfileId(x['profileId']);
    case 'listContinueWatching':
      return (
        isOptionalUserLimit(x['limit']) &&
        isOptionalProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'listWatched':
      return (
        isOptionalUserLimit(x['limit']) &&
        isOptionalProfileId(x['profileId']) &&
        (x['opts'] === undefined || isListWatchedOptions(x['opts']))
      );
    case 'listFavorites':
      return (
        isOptionalUserLimit(x['limit']) &&
        isOptionalProfileId(x['profileId']) &&
        (x['opts'] === undefined || isIncludeHiddenParentalOptions(x['opts']))
      );
    case 'listProgressByKeys':
      return isItemKeyList(x['itemKeys']) && isOptionalProfileId(x['profileId']);
    case 'listSeriesUnplayedCounts':
      return isSeriesKeyList(x['seriesKeys']) && isOptionalProfileId(x['profileId']);
    case 'toggleFavorite':
      return isToggleFavoriteInput(x['input']);
    case 'setFavorite':
      return isToggleFavoriteInput(x['input']) && typeof x['active'] === 'boolean';
    case 'reorderFavorites':
      return isOrderedFavoriteKeys(x['orderedItemKeys']) && isOptionalProfileId(x['profileId']);
    case 'listFavoriteKeys':
      return isOptionalProfileId(x['profileId']);
    case 'listMyListNewEpisodes':
      return (
        isOptionalNewEpisodesLimit(x['limit']) &&
        isOptionalProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'dismissMyListNewEpisode':
      return isCleanKey(x['episodeKey']) && isOptionalProfileId(x['profileId']);
    case 'refreshMyListNewEpisodes':
      return (
        isOptionalProfileId(x['profileId']) &&
        (x['opts'] === undefined || isRefreshMyListNewEpisodesOptions(x['opts']))
      );
    case 'getTrackPreference':
    case 'clearTrackPreference':
      return isCleanKey(x['scopeKey']) && isOptionalProfileId(x['profileId']);
    case 'saveTrackPreference':
      return isSaveTrackPreferenceInput(x['input']);
    case 'recordRecentChannel':
      return (
        isSafeRecentChannelKey(x['itemKey']) &&
        isCleanKey(x['sourceId'], MAX_ID_CHARS) &&
        isOptionalProfileId(x['profileId'])
      );
    case 'listRecentChannels':
      return (
        isOptionalUserLimit(x['limit']) &&
        isOptionalProfileId(x['profileId']) &&
        (x['opts'] === undefined || isParentalUnlockedOption(x['opts']))
      );
    case 'createProfile':
      return isCreateProfileInput(x['input']);
    case 'updateProfile':
      return isStrictProfileId(x['id']) && isUpdateProfilePatch(x['patch']);
    case 'deleteProfile':
      return isStrictProfileId(x['id']);
    case 'getParentalSettings':
    case 'hasParentalPin':
      return isOptionalStrictProfileId(x['profileId']);
    case 'updateParentalSettings':
      return isUpdateParentalSettingsPatch(x['patch']) && isOptionalStrictProfileId(x['profileId']);
    case 'listParentalLocks':
      return (
        isOptionalStrictProfileId(x['profileId']) &&
        (x['filter'] === undefined || isParentalLockFilter(x['filter']))
      );
    case 'setParentalLock':
      return isSetParentalLockInput(x['input']) && typeof x['locked'] === 'boolean';
    case 'setParentalPin':
      return (
        isPinString(x['pin'], 1) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['currentPin'] === undefined || isPinString(x['currentPin'], 0))
      );
    case 'verifyParentalPin':
      return isPinString(x['pin'], 0) && isOptionalStrictProfileId(x['profileId']);
    case 'clearParentalPin':
      return isPinString(x['currentPin'], 0) && isOptionalStrictProfileId(x['profileId']);
    default:
      return (
        isChannelOpsRpcCall(x) ||
        isEpgOpsRpcCall(x) ||
        isFailoverOpsRpcCall(x) ||
        isWaveF5bOpsRpcCall(x)
      );
  }
}

/** Validates a `catalog:connect` payload arriving on `ipcMain`. */
export function isCatalogConnectMessage(x: unknown): x is CatalogConnectMessage {
  return isRecord(x) && isPositiveId(x['connectId']);
}

/** Validates a `catalog:port` payload arriving on `ipcRenderer`. */
export function isCatalogPortMessage(x: unknown): x is CatalogPortMessage {
  return isRecord(x) && isPositiveId(x['connectId']);
}

/** Validates a message arriving on the catalog utility process's client `MessagePort`. */
export function isCatalogClientMessage(x: unknown): x is CatalogClientMessage {
  if (!isRecord(x) || !isPositiveId(x['reqId'])) return false;
  if (x['type'] === 'cancel') return true;
  if (x['type'] === 'call') return isRpcCall(x['call']);
  return false;
}

/** Validates a message arriving in the preload from the catalog utility process. */
export function isCatalogWorkerMessage(x: unknown): x is CatalogWorkerMessage {
  if (!isRecord(x) || !isPositiveId(x['reqId'])) return false;
  switch (x['type']) {
    case 'result':
      return 'value' in x;
    case 'fault':
      return isElvError(x['error']);
    case 'progress':
      return isImportProgress(x['progress']);
    default:
      return false;
  }
}
