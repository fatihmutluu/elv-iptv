import type {
  AddSourceInput,
  BrowseKind,
  CategoryQueryOptions,
  CategoryRow,
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
  NextEpisodeRow,
  NowNextEntry,
  PersistedTrackPreference,
  ProgrammeRow,
  SaveProgressInput,
  SaveTrackPreferenceInput,
  SearchOptions,
  SearchResults,
  SeasonRow,
  SeriesUnplayedSummary,
  SourceRow,
  SourceSettings,
  StreamRequest,
  ToggleFavoriteInput,
  VodVersionOption,
  WatchProgressRow,
} from '@elv/data';
import type { ElvError, Result } from '@elv/domain';
import {
  isAddSourceInput,
  isBoundedString,
  isCategoryQueryOptions,
  isCleanKey,
  isElvError,
  isEpgWindowKeyList,
  isFiniteNumber,
  isImportProgress,
  isItemKeyList,
  isLinkSourceInput,
  isListItemsOptions,
  isLocalM3uSourceInput,
  isNonNegativeFinite,
  isNowNextKeyList,
  isOptionalProfileId,
  isOptionalSourceId,
  isOptionalUserLimit,
  isPositiveId,
  isRecord,
  isSafeInt,
  isSafeRecentChannelKey,
  isSaveProgressInput,
  isSaveTrackPreferenceInput,
  isSearchOptions,
  isSearchQuery,
  isSeriesKeyList,
  isSourceIdList,
  isSourceSettingsPatch,
  isToggleFavoriteInput,
  MAX_ID_CHARS,
  MAX_ITEM_KEY_CHARS,
} from './catalog-ipc-guards.ts';

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
  | { method: 'liveVariants'; itemKey: string; categoryId?: string }
  | { method: 'itemVersions'; itemKey: string }
  | {
      method: 'allSourcesItems';
      kind: BrowseKind;
      offset: number;
      limit: number;
      sourceIds?: readonly string[];
      opts?: ListItemsOptions;
    }
  | { method: 'itemDetail'; itemKey: string }
  | { method: 'search'; query: string; opts?: SearchOptions }
  | { method: 'nowNext'; channelKeys: readonly string[]; nowMs: number }
  | { method: 'epgWindow'; channelKeys: readonly string[]; fromMs: number; toMs: number }
  | { method: 'channelByNumber'; num: number; sourceId?: string }
  | { method: 'seasons'; seriesId: number }
  | { method: 'episodes'; seriesId: number; season: number }
  | { method: 'queryNextEpisode'; seriesKey: string; currentItemKey: string; profileId?: string }
  | { method: 'resolveStream'; itemKey: string }
  | { method: 'saveProgress'; input: SaveProgressInput }
  | { method: 'setWatched'; itemKey: string; watched: boolean; profileId?: string }
  | { method: 'getProgress'; itemKey: string; profileId?: string }
  | { method: 'listContinueWatching'; limit?: number; profileId?: string }
  | { method: 'listProgressByKeys'; itemKeys: readonly string[]; profileId?: string }
  | { method: 'listSeriesUnplayedCounts'; seriesKeys: readonly string[]; profileId?: string }
  | { method: 'clearProgress'; itemKey: string; profileId?: string }
  | { method: 'toggleFavorite'; input: ToggleFavoriteInput }
  | { method: 'setFavorite'; input: ToggleFavoriteInput; active: boolean }
  | { method: 'listFavorites'; limit?: number; profileId?: string }
  | { method: 'listFavoriteKeys'; profileId?: string }
  | { method: 'getTrackPreference'; scopeKey: string; profileId?: string }
  | { method: 'saveTrackPreference'; input: SaveTrackPreferenceInput }
  | { method: 'clearTrackPreference'; scopeKey: string; profileId?: string }
  | { method: 'recordRecentChannel'; itemKey: string; sourceId: string; profileId?: string }
  | { method: 'listRecentChannels'; limit?: number; profileId?: string };

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
export interface CatalogBridge {
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
  liveVariants?(itemKey: string, categoryId?: string): Promise<readonly LiveVariantOption[]>;
  itemVersions?(itemKey: string): Promise<readonly VodVersionOption[]>;
  allSourcesItems?(
    kind: BrowseKind,
    offset: number,
    limit: number,
    sourceIds?: readonly string[],
    opts?: ListItemsOptions,
  ): Promise<ItemRow[]>;
  itemDetail(itemKey: string): Promise<ItemDetailRow | null>;
  search(query: string, opts?: SearchOptions): Promise<SearchResults>;
  nowNext(channelKeys: readonly string[], nowMs: number): Promise<NowNextEntry[]>;
  epgWindow(
    channelKeys: readonly string[],
    fromMs: number,
    toMs: number,
  ): Promise<Record<string, ProgrammeRow[]>>;
  channelByNumber(num: number, sourceId?: string): Promise<ItemRow | null>;
  seasons(seriesId: number): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number): Promise<EpisodeRow[]>;
  queryNextEpisode(
    seriesKey: string,
    currentItemKey: string,
    profileId?: string,
  ): Promise<NextEpisodeRow | null>;
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
  saveProgress(input: SaveProgressInput): Promise<Result<WatchProgressRow>>;
  setWatched(itemKey: string, watched: boolean, profileId?: string): Promise<Result<void>>;
  getProgress(itemKey: string, profileId?: string): Promise<WatchProgressRow | null>;
  listContinueWatching(limit?: number, profileId?: string): Promise<WatchProgressRow[]>;
  listProgressByKeys(itemKeys: readonly string[], profileId?: string): Promise<WatchProgressRow[]>;
  listSeriesUnplayedCounts?(
    seriesKeys: readonly string[],
    profileId?: string,
  ): Promise<SeriesUnplayedSummary[]>;
  clearProgress(itemKey: string, profileId?: string): Promise<Result<void>>;
  toggleFavorite(input: ToggleFavoriteInput): Promise<Result<boolean>>;
  setFavorite(input: ToggleFavoriteInput, active: boolean): Promise<Result<boolean>>;
  listFavorites(limit?: number, profileId?: string): Promise<FavoriteRow[]>;
  listFavoriteKeys(profileId?: string): Promise<string[]>;
  getTrackPreference?(
    scopeKey: string,
    profileId?: string,
  ): Promise<PersistedTrackPreference | null>;
  saveTrackPreference?(input: SaveTrackPreferenceInput): Promise<void>;
  clearTrackPreference?(scopeKey: string, profileId?: string): Promise<void>;
  recordRecentChannel?(itemKey: string, sourceId: string, profileId?: string): Promise<void>;
  listRecentChannels?(limit?: number, profileId?: string): Promise<ItemRow[]>;
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
        (x['categoryId'] === undefined || isCleanKey(x['categoryId'], 512))
      );
    case 'itemVersions':
      return isCleanKey(x['itemKey']);
    case 'allSourcesItems':
      return (
        (x['kind'] === 'live' || x['kind'] === 'movie' || x['kind'] === 'series') &&
        isFiniteNumber(x['offset']) &&
        isFiniteNumber(x['limit']) &&
        (x['sourceIds'] === undefined || isSourceIdList(x['sourceIds'])) &&
        (x['opts'] === undefined || isListItemsOptions(x['opts']))
      );
    case 'itemDetail':
      return isCleanKey(x['itemKey']);
    case 'search':
      return isSearchQuery(x['query']) && (x['opts'] === undefined || isSearchOptions(x['opts']));
    case 'nowNext':
      return isNowNextKeyList(x['channelKeys']) && isNonNegativeFinite(x['nowMs']);
    case 'epgWindow':
      return (
        isEpgWindowKeyList(x['channelKeys']) &&
        isNonNegativeFinite(x['fromMs']) &&
        isNonNegativeFinite(x['toMs'])
      );
    case 'channelByNumber':
      return isNonNegativeFinite(x['num']) && isOptionalSourceId(x['sourceId']);
    case 'seasons':
      return isSafeInt(x['seriesId']);
    case 'episodes':
      return isSafeInt(x['seriesId']) && isSafeInt(x['season']);
    case 'queryNextEpisode':
      return (
        isCleanKey(x['seriesKey']) &&
        isCleanKey(x['currentItemKey']) &&
        isOptionalProfileId(x['profileId'])
      );
    case 'resolveStream':
      return isBoundedString(x['itemKey'], 0, MAX_ITEM_KEY_CHARS);
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
    case 'listFavorites':
      return isOptionalUserLimit(x['limit']) && isOptionalProfileId(x['profileId']);
    case 'listProgressByKeys':
      return isItemKeyList(x['itemKeys']) && isOptionalProfileId(x['profileId']);
    case 'listSeriesUnplayedCounts':
      return isSeriesKeyList(x['seriesKeys']) && isOptionalProfileId(x['profileId']);
    case 'toggleFavorite':
      return isToggleFavoriteInput(x['input']);
    case 'setFavorite':
      return isToggleFavoriteInput(x['input']) && typeof x['active'] === 'boolean';
    case 'listFavoriteKeys':
      return isOptionalProfileId(x['profileId']);
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
      return isOptionalUserLimit(x['limit']) && isOptionalProfileId(x['profileId']);
    default:
      return false;
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
