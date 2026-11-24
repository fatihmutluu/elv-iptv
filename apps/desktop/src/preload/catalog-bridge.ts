import type { ImportProgress, ImportSummary } from '@elv/data';
import { type ElvError, elvError, err, type Result } from '@elv/domain';
import {
  CATALOG_CHANNELS,
  type CatalogBridge,
  type CatalogBridgeImportOptions,
  type CatalogClientMessage,
  type CatalogDisconnectedMessage,
  type CatalogImportHandle,
  type CatalogRpcMethodCall,
  isCatalogClientMessage,
  isCatalogPortMessage,
  isCatalogWorkerMessage,
} from '../shared/catalog-ipc.ts';

/** Subset of the preload's `MessagePort` transferred from main; never crosses `contextBridge`. */
export interface PreloadClientPortLike {
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  postMessage(message: CatalogClientMessage): void;
  start(): void;
  close(): void;
}

/** Subset of Electron's `ipcRenderer` used to bootstrap and fence the catalog `MessagePort`. */
export interface CatalogIpcRendererLike {
  send(channel: string, ...args: unknown[]): void;
  on(
    channel: string,
    listener: (event: { ports?: readonly PreloadClientPortLike[] }, ...args: unknown[]) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: { ports?: readonly PreloadClientPortLike[] }, ...args: unknown[]) => void,
  ): unknown;
}

interface PendingCall {
  readonly mode: 'result' | 'throw';
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

function makeRpcError(error: ElvError): Error {
  return Object.assign(new Error(`catalog rpc failed: ${error.category}/${error.code}`), { error });
}

/**
 * Builds `window.elv.catalog` inside the Electron preload: negotiates a dedicated `MessagePort`
 * with main on demand, holds the port privately inside the preload closure, validates worker
 * messages, and settles in-flight calls cleanly if the utility process exits.
 */
export function createCatalogBridge(ipc: CatalogIpcRendererLike): CatalogBridge {
  let activePort: PreloadClientPortLike | undefined;
  let activeMessageListener: ((ev: { readonly data: unknown }) => void) | undefined;
  let portPromise: Promise<PreloadClientPortLike> | undefined;
  let pendingConnect:
    | {
        connectId: number;
        resolve: (port: PreloadClientPortLike) => void;
        reject: (reason: Error) => void;
      }
    | undefined;
  let nextConnectId = 0;
  let nextReqId = 0;

  const pendingCalls = new Map<number, PendingCall>();
  const cancelledBeforeSend = new Set<number>();
  const changedListeners = new Set<() => void>();
  const disconnectedListeners = new Set<(message: CatalogDisconnectedMessage) => void>();

  ipc.on(CATALOG_CHANNELS.changed, () => {
    for (const listener of [...changedListeners]) {
      try {
        listener();
      } catch {
        // isolate renderer change callbacks
      }
    }
  });

  const settlePendingWithError = (error: ElvError): void => {
    for (const call of pendingCalls.values()) {
      if (call.mode === 'result') call.resolve(err(error));
      else call.reject(makeRpcError(error));
    }
    pendingCalls.clear();
  };

  const dropActivePort = (error: ElvError): void => {
    const port = activePort;
    const listener = activeMessageListener;
    activePort = undefined;
    activeMessageListener = undefined;
    portPromise = undefined;
    if (port) {
      if (listener) port.removeEventListener('message', listener);
      port.close();
    }
    if (pendingConnect) {
      const connect = pendingConnect;
      pendingConnect = undefined;
      connect.reject(makeRpcError(error));
    }
    settlePendingWithError(error);
  };

  ipc.on(CATALOG_CHANNELS.port, (event, message) => {
    if (!isCatalogPortMessage(message)) return;
    const port = event.ports?.[0];
    if (!port) return;
    if (!pendingConnect || pendingConnect.connectId !== message.connectId) {
      port.close();
      return;
    }
    const connect = pendingConnect;
    pendingConnect = undefined;
    const onMessage = (ev: { readonly data: unknown }): void => {
      const raw = ev.data;
      if (!isCatalogWorkerMessage(raw)) return;
      const entry = pendingCalls.get(raw.reqId);
      if (!entry) return;
      if (raw.type === 'progress') {
        try {
          entry.onProgress?.(raw.progress);
        } catch {
          // isolate renderer progress callbacks
        }
        return;
      }
      pendingCalls.delete(raw.reqId);
      if (raw.type === 'result') {
        entry.resolve(raw.value);
      } else if (entry.mode === 'result') {
        entry.resolve(err(raw.error));
      } else {
        entry.reject(makeRpcError(raw.error));
      }
    };
    activePort = port;
    activeMessageListener = onMessage;
    port.addEventListener('message', onMessage);
    port.start();
    connect.resolve(port);
  });

  ipc.on(CATALOG_CHANNELS.disconnected, () => {
    dropActivePort(elvError('storage', 'worker-exited'));
    const message: CatalogDisconnectedMessage = { reason: 'worker-exited' };
    for (const listener of [...disconnectedListeners]) {
      try {
        listener(message);
      } catch {
        // isolate renderer disconnect callbacks
      }
    }
  });

  const ensurePort = (): Promise<PreloadClientPortLike> => {
    if (activePort) return Promise.resolve(activePort);
    if (portPromise) return portPromise;
    const connectId = ++nextConnectId;
    portPromise = new Promise<PreloadClientPortLike>((resolve, reject) => {
      pendingConnect = { connectId, resolve, reject };
      ipc.send(CATALOG_CHANNELS.connect, { connectId });
    });
    return portPromise;
  };

  const callResult = <T>(call: CatalogRpcMethodCall): Promise<Result<T>> => {
    const reqId = ++nextReqId;
    const message: CatalogClientMessage = { type: 'call', reqId, call };
    if (!isCatalogClientMessage(message)) {
      return Promise.resolve(err(elvError('source-format', 'invalid-request')));
    }
    return new Promise<Result<T>>((resolve, reject) => {
      pendingCalls.set(reqId, {
        mode: 'result',
        resolve: (val) => resolve(val as Result<T>),
        reject,
      });
      void ensurePort().then(
        (port) => {
          if (!pendingCalls.has(reqId)) return;
          port.postMessage(message);
        },
        () => {
          if (pendingCalls.delete(reqId)) {
            resolve(err(elvError('storage', 'worker-exited')));
          }
        },
      );
    });
  };

  const callValue = <T>(call: CatalogRpcMethodCall): Promise<T> => {
    const reqId = ++nextReqId;
    const message: CatalogClientMessage = { type: 'call', reqId, call };
    if (!isCatalogClientMessage(message)) {
      return Promise.reject(makeRpcError(elvError('source-format', 'invalid-request')));
    }
    return new Promise<T>((resolve, reject) => {
      pendingCalls.set(reqId, {
        mode: 'throw',
        resolve: (val) => resolve(val as T),
        reject,
      });
      void ensurePort().then(
        (port) => {
          if (!pendingCalls.has(reqId)) return;
          port.postMessage(message);
        },
        (reason: unknown) => {
          if (pendingCalls.delete(reqId)) {
            reject(
              reason instanceof Error ? reason : makeRpcError(elvError('storage', 'worker-exited')),
            );
          }
        },
      );
    });
  };

  const bridge: CatalogBridge = {
    open: () => callResult<void>({ method: 'ping' }),
    addSource: (input) => callResult({ method: 'addSource', input }),
    addSourceFromLink: (input) => callResult({ method: 'addSourceFromLink', input }),
    addLocalM3uSource: (input) => callResult({ method: 'addLocalM3uSource', input }),
    discoverSourceCategories: (sourceId) =>
      callResult({ method: 'discoverSourceCategories', sourceId }),
    updateSourceSettings: (sourceId, patch) =>
      callValue({ method: 'updateSourceSettings', sourceId, patch }),
    removeSource: (id) => callResult({ method: 'removeSource', id }),
    startImport(id: string, opts?: CatalogBridgeImportOptions): CatalogImportHandle {
      const reqId = ++nextReqId;
      const message: CatalogClientMessage = {
        type: 'call',
        reqId,
        call: {
          method: 'importSource',
          id,
          ...(opts?.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
          ...(opts?.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
          ...(opts?.onProgress === undefined ? {} : { progress: true }),
        },
      };
      if (!isCatalogClientMessage(message)) {
        return Object.freeze({
          reqId,
          result: Promise.resolve(err(elvError('source-format', 'invalid-request'))),
        });
      }
      const result = new Promise<Result<ImportSummary>>((resolve, reject) => {
        pendingCalls.set(reqId, {
          mode: 'result',
          ...(opts?.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
          resolve: (val) => resolve(val as Result<ImportSummary>),
          reject,
        });
        void ensurePort().then(
          (port) => {
            if (cancelledBeforeSend.delete(reqId) || !pendingCalls.has(reqId)) return;
            port.postMessage(message);
          },
          () => {
            cancelledBeforeSend.delete(reqId);
            if (pendingCalls.delete(reqId)) {
              resolve(err(elvError('storage', 'worker-exited')));
            }
          },
        );
      });
      return Object.freeze({ reqId, result });
    },
    cancelImport(reqId: number): void {
      if (activePort) {
        activePort.postMessage({ type: 'cancel', reqId });
        return;
      }
      const entry = pendingCalls.get(reqId);
      if (entry) {
        pendingCalls.delete(reqId);
        cancelledBeforeSend.add(reqId);
        entry.resolve(err(elvError('network', 'aborted')));
      }
    },
    listSources: () => callValue({ method: 'listSources' }),
    importGuide: (id) => callResult({ method: 'importGuide', id }),
    categories: (sourceId, kind, opts) =>
      callValue({
        method: 'categories',
        sourceId,
        kind,
        ...(opts === undefined ? {} : { opts }),
      }),
    items: (categoryId, offset, limit, opts) =>
      callValue({
        method: 'items',
        categoryId,
        offset,
        limit,
        ...(opts === undefined ? {} : { opts }),
      }),
    liveVariants: (itemKey, categoryId) =>
      callValue({
        method: 'liveVariants',
        itemKey,
        ...(categoryId === undefined ? {} : { categoryId }),
      }),
    itemVersions: (itemKey) => callValue({ method: 'itemVersions', itemKey }),
    allSourcesItems: (kind, offset, limit, sourceIds, opts) =>
      callValue({
        method: 'allSourcesItems',
        kind,
        offset,
        limit,
        ...(sourceIds === undefined ? {} : { sourceIds }),
        ...(opts === undefined ? {} : { opts }),
      }),
    itemDetail: (itemKey, opts) =>
      callValue({ method: 'itemDetail', itemKey, ...(opts === undefined ? {} : { opts }) }),
    search: (query, opts) =>
      callValue({ method: 'search', query, ...(opts === undefined ? {} : { opts }) }),
    searchSuggestions: (options) =>
      callValue({
        method: 'searchSuggestions',
        ...(options === undefined ? {} : { options }),
      }),
    alphabetIndex: (input) => callValue({ method: 'alphabetIndex', input }),
    nowNext: (channelKeys, nowMs, opts) =>
      callValue({
        method: 'nowNext',
        channelKeys,
        nowMs,
        ...(opts === undefined ? {} : { opts }),
      }),
    epgWindow: (channelKeys, fromMs, toMs, opts) =>
      callValue({
        method: 'epgWindow',
        channelKeys,
        fromMs,
        toMs,
        ...(opts === undefined ? {} : { opts }),
      }),
    epgSlice: (sourceId, fromMs, toMs, limit, opts) =>
      callValue({
        method: 'epgSlice',
        sourceId,
        fromMs,
        toMs,
        ...(limit === undefined ? {} : { limit }),
        ...(opts === undefined ? {} : { opts }),
      }),
    channelByNumber: (num, sourceId, opts) =>
      callValue({
        method: 'channelByNumber',
        num,
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    seasons: (seriesId) => callResult({ method: 'seasons', seriesId }),
    episodes: (seriesId, season) => callValue({ method: 'episodes', seriesId, season }),
    queryNextEpisode: (seriesKey, currentItemKey, profileId) =>
      callValue({
        method: 'queryNextEpisode',
        seriesKey,
        currentItemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    resolveStream: (itemKey, opts) =>
      callResult({ method: 'resolveStream', itemKey, ...(opts === undefined ? {} : { opts }) }),
    saveProgress: (input) => callResult({ method: 'saveProgress', input }),
    setWatched: (itemKey, watched, profileId) =>
      callResult({
        method: 'setWatched',
        itemKey,
        watched,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    getProgress: (itemKey, profileId) =>
      callValue({
        method: 'getProgress',
        itemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    listContinueWatching: (limit, profileId, opts) =>
      callValue({
        method: 'listContinueWatching',
        ...(limit === undefined ? {} : { limit }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    listProgressByKeys: (itemKeys, profileId) =>
      callValue({
        method: 'listProgressByKeys',
        itemKeys,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    listSeriesUnplayedCounts: (seriesKeys, profileId) =>
      callValue({
        method: 'listSeriesUnplayedCounts',
        seriesKeys,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    clearProgress: (itemKey, profileId) =>
      callResult({
        method: 'clearProgress',
        itemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    toggleFavorite: (input) => callResult({ method: 'toggleFavorite', input }),
    setFavorite: (input, active) => callResult({ method: 'setFavorite', input, active }),
    listFavorites: (limit, profileId, opts) =>
      callValue({
        method: 'listFavorites',
        ...(limit === undefined ? {} : { limit }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    listFavoriteKeys: (profileId) =>
      callValue({
        method: 'listFavoriteKeys',
        ...(profileId === undefined ? {} : { profileId }),
      }),
    getTrackPreference: (scopeKey, profileId) =>
      callValue({
        method: 'getTrackPreference',
        scopeKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    saveTrackPreference: (input) => callValue({ method: 'saveTrackPreference', input }),
    clearTrackPreference: (scopeKey, profileId) =>
      callValue({
        method: 'clearTrackPreference',
        scopeKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    recordRecentChannel: (itemKey, sourceId, profileId) =>
      callValue({
        method: 'recordRecentChannel',
        itemKey,
        sourceId,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    listRecentChannels: (limit, profileId, opts) =>
      callValue({
        method: 'listRecentChannels',
        ...(limit === undefined ? {} : { limit }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    listProfiles: () => callValue({ method: 'listProfiles' }),
    createProfile: (input) => callResult({ method: 'createProfile', input }),
    updateProfile: (id, patch) => callResult({ method: 'updateProfile', id, patch }),
    deleteProfile: (id) => callResult({ method: 'deleteProfile', id }),
    getParentalSettings: (profileId) =>
      callValue({
        method: 'getParentalSettings',
        ...(profileId === undefined ? {} : { profileId }),
      }),
    updateParentalSettings: (patch, profileId) =>
      callResult({
        method: 'updateParentalSettings',
        patch,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    listParentalLocks: (profileId, filter) =>
      callValue({
        method: 'listParentalLocks',
        ...(profileId === undefined ? {} : { profileId }),
        ...(filter === undefined ? {} : { filter }),
      }),
    setParentalLock: (input, locked) => callResult({ method: 'setParentalLock', input, locked }),
    hasParentalPin: (profileId) =>
      callValue({
        method: 'hasParentalPin',
        ...(profileId === undefined ? {} : { profileId }),
      }),
    setParentalPin: (pin, profileId, currentPin) =>
      callResult({
        method: 'setParentalPin',
        pin,
        ...(profileId === undefined ? {} : { profileId }),
        ...(currentPin === undefined ? {} : { currentPin }),
      }),
    verifyParentalPin: (pin, profileId) =>
      callValue({
        method: 'verifyParentalPin',
        pin,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    clearParentalPin: (currentPin, profileId) =>
      callResult({
        method: 'clearParentalPin',
        currentPin,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    flushPendingWrites: () => callValue({ method: 'flushPendingWrites' }),
    onChanged(listener: () => void): () => void {
      changedListeners.add(listener);
      return () => {
        changedListeners.delete(listener);
      };
    },
    onDisconnected(listener: (message: CatalogDisconnectedMessage) => void): () => void {
      disconnectedListeners.add(listener);
      return () => {
        disconnectedListeners.delete(listener);
      };
    },
    async close(): Promise<void> {
      dropActivePort(elvError('storage', 'closed'));
    },
  };

  return Object.freeze(bridge);
}
