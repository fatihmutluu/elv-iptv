import type {
  AddSourceInput,
  BrowseKind,
  CategoryRow,
  EpisodeRow,
  ImportProgress,
  ImportSummary,
  ItemRow,
  LinkSourceInput,
  SeasonRow,
  SourceRow,
  StreamRequest,
} from '@elv/data';
import type { ElvError, ErrorCategory, Result, TransportSettings } from '@elv/domain';

/** IPC channels used to establish and fence a renderer's catalog `MessagePort`. */
export const CATALOG_CHANNELS = Object.freeze({
  connect: 'catalog:connect',
  port: 'catalog:port',
  disconnected: 'catalog:disconnected',
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
  | { method: 'removeSource'; id: string }
  | {
      method: 'importSource';
      id: string;
      batchSize?: number;
      maxBodyBytes?: number;
      progress?: boolean;
    }
  | { method: 'listSources' }
  | { method: 'categories'; sourceId: string; kind: BrowseKind }
  | { method: 'items'; categoryId: string; offset: number; limit: number }
  | { method: 'seasons'; seriesId: number }
  | { method: 'episodes'; seriesId: number; season: number }
  | { method: 'resolveStream'; itemKey: string };

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
  removeSource(id: string): Promise<Result<void>>;
  startImport(id: string, opts?: CatalogBridgeImportOptions): CatalogImportHandle;
  cancelImport(reqId: number): void;
  listSources(): Promise<SourceRow[]>;
  categories(sourceId: string, kind: BrowseKind): Promise<CategoryRow[]>;
  items(categoryId: string, offset: number, limit: number): Promise<ItemRow[]>;
  seasons(seriesId: number): Promise<Result<SeasonRow[]>>;
  episodes(seriesId: number, season: number): Promise<EpisodeRow[]>;
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
  close(): Promise<void>;
}

const MAX_STRING_CHARS = 8_192;
const MAX_ID_CHARS = 256;
const ERROR_CATEGORIES = new Set<ErrorCategory>([
  'network',
  'auth',
  'source-format',
  'playback',
  'storage',
]);
const IMPORT_PHASES = new Set<ImportProgress['phase']>([
  'categories',
  'live',
  'movies',
  'series',
  'episodes',
  'guide-channels',
  'programmes',
  'cleanup',
]);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isPositiveId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const isSafeInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBoundedString = (x: unknown, min = 0, max = MAX_STRING_CHARS): x is string =>
  typeof x === 'string' && x.length >= min && x.length <= max;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

function isTrimmedCleanString(x: unknown): x is string {
  return isBoundedString(x) && !hasControlChar(x.trim());
}

function isOptionalCleanString(x: unknown): boolean {
  return x === undefined || (isBoundedString(x) && !hasControlChar(x));
}

function isOptionalTrimmedCleanString(x: unknown): boolean {
  return x === undefined || isTrimmedCleanString(x);
}

function isTransportSettings(x: unknown): x is TransportSettings {
  if (!isRecord(x)) return false;
  if (!isOptionalCleanString(x['userAgent']) || !isOptionalCleanString(x['referer'])) return false;
  const fmt = x['xtreamFormat'];
  return fmt === undefined || fmt === 'ts' || fmt === 'm3u8';
}

function isAddSourceInput(x: unknown): x is AddSourceInput {
  if (!isRecord(x) || !isBoundedString(x['name'])) return false;
  if (x['transport'] !== undefined && !isTransportSettings(x['transport'])) return false;
  if (!isOptionalTrimmedCleanString(x['guideUrl'])) return false;
  if (x['kind'] === 'xtream') {
    return (
      isTrimmedCleanString(x['server']) &&
      isBoundedString(x['username']) &&
      isBoundedString(x['password'])
    );
  }
  if (x['kind'] === 'm3u') {
    return (
      isTrimmedCleanString(x['playlistUrl']) &&
      (x['vodPlaylist'] === undefined || typeof x['vodPlaylist'] === 'boolean')
    );
  }
  return false;
}

function isLinkSourceInput(x: unknown): x is LinkSourceInput {
  if (!isRecord(x)) return false;
  if (!isBoundedString(x['name']) || !isTrimmedCleanString(x['url'])) {
    return false;
  }
  if (x['keepAsM3u'] !== undefined && typeof x['keepAsM3u'] !== 'boolean') return false;
  if (!isOptionalTrimmedCleanString(x['guideUrl'])) return false;
  if (x['vodPlaylist'] !== undefined && typeof x['vodPlaylist'] !== 'boolean') return false;
  return x['transport'] === undefined || isTransportSettings(x['transport']);
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
    case 'removeSource':
      return isBoundedString(x['id'], 0, MAX_ID_CHARS);
    case 'importSource':
      return (
        isBoundedString(x['id'], 0, MAX_ID_CHARS) &&
        (x['batchSize'] === undefined || isPositiveId(x['batchSize'])) &&
        (x['maxBodyBytes'] === undefined || isPositiveId(x['maxBodyBytes'])) &&
        (x['progress'] === undefined || typeof x['progress'] === 'boolean')
      );
    case 'categories':
      return (
        isBoundedString(x['sourceId'], 0, MAX_ID_CHARS) &&
        (x['kind'] === 'live' || x['kind'] === 'movie' || x['kind'] === 'series')
      );
    case 'items':
      return (
        isBoundedString(x['categoryId'], 0, 512) &&
        isFiniteNumber(x['offset']) &&
        isFiniteNumber(x['limit'])
      );
    case 'seasons':
      return isSafeInt(x['seriesId']);
    case 'episodes':
      return isSafeInt(x['seriesId']) && isSafeInt(x['season']);
    case 'resolveStream':
      return isBoundedString(x['itemKey'], 0, 1024);
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

function isElvError(x: unknown): x is ElvError {
  return (
    isRecord(x) &&
    typeof x['category'] === 'string' &&
    ERROR_CATEGORIES.has(x['category'] as ErrorCategory) &&
    isBoundedString(x['code'], 1, 128) &&
    (x['detail'] === undefined || isBoundedString(x['detail'], 0, 1024))
  );
}

function isImportProgress(x: unknown): x is ImportProgress {
  return (
    isRecord(x) &&
    typeof x['phase'] === 'string' &&
    IMPORT_PHASES.has(x['phase'] as ImportProgress['phase']) &&
    isFiniteNumber(x['done']) &&
    x['done'] >= 0 &&
    (x['total'] === undefined || (isFiniteNumber(x['total']) && x['total'] >= 0))
  );
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
