import type { ImportProgress, ImportSummary, VodEnrichmentRecord } from '@elv/data';
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

  const emitChanged = (): void => {
    for (const listener of [...changedListeners]) {
      try {
        listener();
      } catch {
        // isolate renderer change callbacks
      }
    }
  };

  ipc.on(CATALOG_CHANNELS.changed, emitChanged);

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

  const notifyOnOk = <T>(promise: Promise<Result<T>>): Promise<Result<T>> =>
    promise.then((res) => {
      if (res.ok) emitChanged();
      return res;
    });

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
    liveVariants: (itemKey, categoryId, opts) =>
      callValue({
        method: 'liveVariants',
        itemKey,
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    itemVersions: (itemKey, opts) =>
      callValue({ method: 'itemVersions', itemKey, ...(opts === undefined ? {} : { opts }) }),
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
    seasons: (seriesId, opts) =>
      callResult({ method: 'seasons', seriesId, ...(opts === undefined ? {} : { opts }) }),
    episodes: (seriesId, season, opts) =>
      callValue({ method: 'episodes', seriesId, season, ...(opts === undefined ? {} : { opts }) }),
    queryNextEpisode: (seriesKey, currentItemKey, profileId, opts) =>
      callValue({
        method: 'queryNextEpisode',
        seriesKey,
        currentItemKey,
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
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
    listWatched: (limit, profileId, opts) =>
      callValue({
        method: 'listWatched',
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
    reorderFavorites: (orderedItemKeys, profileId) =>
      callResult({
        method: 'reorderFavorites',
        orderedItemKeys,
        ...(profileId === undefined ? {} : { profileId }),
      }),
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
    listChannelOverrides: (profileId) =>
      callValue({
        method: 'listChannelOverrides',
        ...(profileId === undefined ? {} : { profileId }),
      }),
    setChannelOverride: (input) => callResult({ method: 'setChannelOverride', input }),
    clearChannelOverride: (itemKey, profileId) =>
      callResult({
        method: 'clearChannelOverride',
        itemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    reorderChannels: (itemKeys, sourceId, profileId) =>
      callResult({
        method: 'reorderChannels',
        itemKeys,
        sourceId,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    listCustomGroups: (profileId, opts) =>
      callValue({
        method: 'listCustomGroups',
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    createCustomGroup: (input) => callResult({ method: 'createCustomGroup', input }),
    updateCustomGroup: (groupId, patch) =>
      callResult({ method: 'updateCustomGroup', groupId, patch }),
    deleteCustomGroup: (groupId) => callResult({ method: 'deleteCustomGroup', groupId }),
    setCustomGroupItems: (groupId, items) =>
      callResult({ method: 'setCustomGroupItems', groupId, items }),
    addChannelToCustomGroup: (groupId, itemKey, sourceId) =>
      callResult({ method: 'addChannelToCustomGroup', groupId, itemKey, sourceId }),
    removeChannelFromCustomGroup: (groupId, itemKey) =>
      callResult({ method: 'removeChannelFromCustomGroup', groupId, itemKey }),
    resolveCatchupStream: (itemKey, programme, opts) =>
      callResult({
        method: 'resolveCatchupStream',
        itemKey,
        programme,
        ...(opts === undefined ? {} : { opts }),
      }),
    fetchChannelArchiveEpg: (itemKey, opts) =>
      callResult({
        method: 'fetchChannelArchiveEpg',
        itemKey,
        ...(opts === undefined ? {} : { opts }),
      }),
    listGuideSources: (sourceId) => callValue({ method: 'listGuideSources', sourceId }),
    addGuideSource: (input) => callResult({ method: 'addGuideSource', input }),
    updateGuideSource: (id, patch) => callResult({ method: 'updateGuideSource', id, patch }),
    removeGuideSource: (id) => callResult({ method: 'removeGuideSource', id }),
    reorderGuideSources: (sourceId, orderedIds) =>
      callResult({ method: 'reorderGuideSources', sourceId, orderedIds }),
    listGuideChannels: (sourceId, query, limit) =>
      callValue({
        method: 'listGuideChannels',
        sourceId,
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
      }),
    listChannelGuideOverrides: (sourceId) =>
      callValue({ method: 'listChannelGuideOverrides', sourceId }),
    setChannelGuideOverride: (input) => callResult({ method: 'setChannelGuideOverride', input }),
    clearChannelGuideOverride: (sourceId, channelKey) =>
      callResult({ method: 'clearChannelGuideOverride', sourceId, channelKey }),
    listReminders: (profileId, opts) =>
      callValue({
        method: 'listReminders',
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    upsertReminder: (input) => callResult({ method: 'upsertReminder', input }),
    removeReminder: (channelKey, programmeStart, profileId) =>
      callResult({
        method: 'removeReminder',
        channelKey,
        programmeStart,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    markReminderFired: (channelKey, programmeStart, profileId) =>
      callResult({
        method: 'markReminderFired',
        channelKey,
        programmeStart,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    pruneExpiredReminders: (nowMs) =>
      callValue({
        method: 'pruneExpiredReminders',
        ...(nowMs === undefined ? {} : { nowMs }),
      }),
    listFailoverGroups: () => callValue({ method: 'listFailoverGroups' }),
    getFailoverGroupByChannel: (channelKey) =>
      callValue({ method: 'getFailoverGroupByChannel', channelKey }),
    createFailoverGroup: (input) => callResult({ method: 'createFailoverGroup', input }),
    renameFailoverGroup: (groupId, name) =>
      callResult({ method: 'renameFailoverGroup', groupId, name }),
    deleteFailoverGroup: (groupId) => callResult({ method: 'deleteFailoverGroup', groupId }),
    addFailoverGroupMember: (groupId, channelKey) =>
      callResult({ method: 'addFailoverGroupMember', groupId, channelKey }),
    removeFailoverGroupMember: (groupId, channelKey) =>
      callResult({ method: 'removeFailoverGroupMember', groupId, channelKey }),
    reorderFailoverGroupMembers: (groupId, orderedChannelKeys) =>
      callResult({ method: 'reorderFailoverGroupMembers', groupId, orderedChannelKeys }),
    suggestFailoverGroups: () => callValue({ method: 'suggestFailoverGroups' }),
    applySuggestedFailoverGroups: (clusters) =>
      callResult({ method: 'applySuggestedFailoverGroups', clusters }),
    reportStreamOutcome: (sourceId, serverUrl, succeeded) =>
      callValue({ method: 'reportStreamOutcome', sourceId, serverUrl, succeeded }),
    getVodEnrichment: (itemKey) => callValue({ method: 'getVodEnrichment', itemKey }),
    enrichVodItem: (itemKey, opts) =>
      callValue<VodEnrichmentRecord | null>({
        method: 'enrichVodItem',
        itemKey,
        ...(opts === undefined ? {} : { opts }),
      }),
    listCollections: (profileId, opts) =>
      callValue({
        method: 'listCollections',
        ...(profileId === undefined ? {} : { profileId }),
        ...(opts === undefined ? {} : { opts }),
      }),
    createCollection: (input) => notifyOnOk(callResult({ method: 'createCollection', input })),
    renameCollection: (id, name, profileId) =>
      notifyOnOk(
        callResult({
          method: 'renameCollection',
          id,
          name,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
    reorderCollections: (orderedIds, profileId) =>
      notifyOnOk(
        callResult({
          method: 'reorderCollections',
          orderedIds,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
    deleteCollection: (id, profileId) =>
      notifyOnOk(
        callResult({
          method: 'deleteCollection',
          id,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
    listCollectionItems: (collectionId, opts) =>
      callValue({
        method: 'listCollectionItems',
        collectionId,
        ...(opts === undefined ? {} : { opts }),
      }),
    listCollectionsForItem: (itemKey, profileId) =>
      callValue({
        method: 'listCollectionsForItem',
        itemKey,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    addItemToCollection: (collectionId, itemKey, kind, profileId) =>
      notifyOnOk(
        callResult({
          method: 'addItemToCollection',
          collectionId,
          itemKey,
          kind,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
    removeItemFromCollection: (collectionId, itemKey, profileId) =>
      notifyOnOk(
        callResult({
          method: 'removeItemFromCollection',
          collectionId,
          itemKey,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
    reorderCollectionItems: (collectionId, orderedItemKeys, profileId) =>
      notifyOnOk(
        callResult({
          method: 'reorderCollectionItems',
          collectionId,
          orderedItemKeys,
          ...(profileId === undefined ? {} : { profileId }),
        }),
      ),
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
