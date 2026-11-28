import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import {
  type CatalogService,
  createCatalogService,
  createSyncSqlDriver,
  type ElvEnrichmentStore,
  type LocalPlaylistStore,
  openCatalog,
  type SyncDatabase,
} from '@elv/data';
import {
  type Decompressor,
  type ElvError,
  elvError,
  err,
  type FetchLike,
  ok,
  type Result,
  type SecretStore,
  type SqlDriver,
} from '@elv/domain';
import {
  isMainToWorkerMessage,
  MAX_SECRET_VALUE_CHARS,
  SECRET_KEY_RE,
  type WorkerToMainMessage,
} from '../main/catalog/worker-protocol.ts';
import {
  type CatalogRpcMethodCall,
  type CatalogWorkerMessage,
  isCatalogClientMessage,
} from '../shared/catalog-ipc.ts';
import { executeChannelOpsRpcCall } from './catalog-worker-channel-ops.ts';
import { executeEpgOpsRpcCall } from './catalog-worker-epg-ops.ts';
import { executeFailoverOpsRpcCall } from './catalog-worker-failover-ops.ts';
import {
  sanitizeAddSourceInput,
  sanitizeDisplayText,
  sanitizeLinkSourceInput,
  sanitizeLocalM3uInput,
} from './catalog-worker-sanitize.ts';
import {
  buildCatalogImportTelemetryEvent,
  sumImportCounts,
  wrapSqlDriverWithSlowOpTelemetry,
} from './catalog-worker-telemetry.ts';
import { executeUserStateRpcCall } from './catalog-worker-user-state.ts';
import {
  createWorkerElvClient,
  executeWaveE1OpsRpcCall,
  isWaveE1RpcCall,
  openWorkerElvContext,
} from './catalog-worker-wave-e1-ops.ts';
import { executeWaveE2OpsRpcCall, isWaveE2RpcCall } from './catalog-worker-wave-e2-ops.ts';
import { executeWaveF5bOpsRpcCall, isWaveF5bRpcCall } from './catalog-worker-wave-f5b-ops.ts';
import { executeWaveP9OpsRpcCall, isWaveP9RpcCall } from './catalog-worker-wave-p9-ops.ts';
import { createDesktopHttpClient } from './legacy-tls-http.ts';
import { createLocalPlaylistStore } from './local-playlist-store.ts';
import { formatSqliteOpenError, openSqliteWithRetry } from './sqlite-open-retry.ts';

const SAFE_SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_KEY_ROTATED_CODE = 'storage/secret-key-rotated';
/** Desktop streams Xtream JSON incrementally in `O(batchSize)` memory, matching `xtream.ts` `DEFAULT_MAX_BODY`. */
const DESKTOP_MAX_BODY_BYTES = 128 * 1024 * 1024;

const createSecretKeyRotatedError = (): Error =>
  Object.assign(new Error(SECRET_KEY_ROTATED_CODE), {
    name: 'SecretDecryptError',
    code: SECRET_KEY_ROTATED_CODE,
  });

const isSecretKeyRotatedError = (error: unknown): boolean =>
  error instanceof Error &&
  ((error as { code?: unknown }).code === SECRET_KEY_ROTATED_CODE ||
    error.message === SECRET_KEY_ROTATED_CODE);

const isSecretMissingResult = (value: unknown): boolean => {
  const rec = value as { ok?: unknown; error?: { category?: unknown; code?: unknown } } | null;
  return (
    typeof rec === 'object' &&
    rec !== null &&
    rec.ok === false &&
    rec.error?.category === 'storage' &&
    rec.error?.code === 'secret-missing'
  );
};

/** Subset of Electron's `MessagePortMain` used inside the catalog utility process. */
export interface WorkerClientPortLike {
  start(): void;
  close(): void;
  postMessage(message: CatalogWorkerMessage): void;
  on(event: 'message', listener: (ev: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/** Subset of Electron's `process.parentPort` inside a `utilityProcess`. */
export interface WorkerParentPortLike {
  on(
    event: 'message',
    listener: (ev: { data: unknown; ports?: readonly WorkerClientPortLike[] }) => void,
  ): unknown;
  off(
    event: 'message',
    listener: (ev: { data: unknown; ports?: readonly WorkerClientPortLike[] }) => void,
  ): unknown;
  postMessage(message: WorkerToMainMessage): void;
}

/** Collaborators injected into {@link createCatalogWorkerRuntime}. */
export interface CatalogWorkerRuntimeDeps {
  parentPort: WorkerParentPortLike;
  openDatabase: (filePath: string) => SyncDatabase;
  fetchImpl: FetchLike;
  legacyFetchImpl?: FetchLike;
  localPlaylistStore?: LocalPlaylistStore;
  decompressor?: Decompressor;
  clock?: () => number;
  yieldNow?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  onExit?: (code: number) => void;
  maxSecretValueChars?: number;
  slowSqlThresholdMs?: number;
}

interface OpenedCatalog {
  db: SqlDriver;
  enrichmentStore?: ElvEnrichmentStore;
  service: CatalogService;
}

interface ClientSession {
  readonly port: WorkerClientPortLike;
  readonly controllers: Map<number, AbortController>;
  closed: boolean;
}

/**
 * Wires `better-sqlite3` and `@elv/data`'s `CatalogService` inside an Electron `utilityProcess`.
 * Secrets cross only `parentPort`; client `MessagePort`s carry validated catalog calls, progress and cancellations.
 */
export function createCatalogWorkerRuntime(deps: CatalogWorkerRuntimeDeps): () => void {
  const { parentPort, openDatabase, fetchImpl } = deps;
  const clock = deps.clock ?? Date.now;
  const yieldNow = deps.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const desktopHttp = createDesktopHttpClient(
    fetchImpl,
    deps.legacyFetchImpl === undefined ? undefined : { legacyFetchImpl: deps.legacyFetchImpl },
  );

  let configuredDbPath: string | undefined;
  let configuredElvServerUrl: string | undefined;
  let openState: Promise<Result<OpenedCatalog>> | undefined;
  let acceptingCalls = true;
  let secretsClosed = false;
  let nextSecretReqId = 0;

  const callSecretContext = new AsyncLocalStorage<{ keyRotated: boolean }>();
  const pendingSecrets = new Map<
    number,
    {
      resolve: (value: string | undefined) => void;
      reject: (reason: Error) => void;
      ctx: { keyRotated: boolean } | undefined;
    }
  >();
  const clients = new Map<number, ClientSession>();
  const inFlightCalls = new Set<Promise<void>>();

  const maxSecretValueChars = deps.maxSecretValueChars ?? MAX_SECRET_VALUE_CHARS;
  const requestSecret = (
    msg: { op: 'get' | 'delete'; key: string } | { op: 'set'; key: string; value: string },
  ): Promise<string | undefined> => {
    if (secretsClosed) return Promise.reject(new Error('catalog worker secrets closed'));
    if (!SECRET_KEY_RE.test(msg.key)) return Promise.reject(new Error('invalid secret key'));
    if (msg.op === 'set' && msg.value.length > maxSecretValueChars) {
      return Promise.reject(new Error('secret value exceeds maximum length'));
    }
    const reqId = ++nextSecretReqId;
    const ctx = callSecretContext.getStore();
    return new Promise((resolve, reject) => {
      pendingSecrets.set(reqId, { resolve, reject, ctx });
      parentPort.postMessage(
        msg.op === 'set'
          ? { type: 'secret-request', reqId, op: 'set', key: msg.key, value: msg.value }
          : { type: 'secret-request', reqId, op: msg.op, key: msg.key },
      );
    });
  };

  const secrets: SecretStore = {
    get: (key) => requestSecret({ op: 'get', key }),
    set: async (key, value) => {
      await requestSecret({ op: 'set', key, value });
    },
    delete: async (key) => {
      await requestSecret({ op: 'delete', key });
    },
  };

  const openOnce = async (): Promise<Result<OpenedCatalog>> => {
    if (configuredDbPath === undefined) {
      return err(elvError('storage', 'not-initialized'));
    }
    const dbPath = configuredDbPath;
    return openSqliteWithRetry(
      async (): Promise<Result<OpenedCatalog>> => {
        let db: SqlDriver | undefined;
        let enrichmentStore: ElvEnrichmentStore | undefined;
        try {
          db = wrapSqlDriverWithSlowOpTelemetry(
            createSyncSqlDriver(openDatabase(dbPath)),
            (op, durationMs) => {
              parentPort.postMessage({
                type: 'telemetry',
                event: { kind: 'sqlite_slow_op', op, durationMs },
              });
            },
            {
              now: clock,
              ...(deps.slowSqlThresholdMs !== undefined
                ? { thresholdMs: deps.slowSqlThresholdMs }
                : {}),
            },
          );
          const opened = await openCatalog(db, clock);
          if (!opened.ok) {
            await db.close?.().catch(() => undefined);
            return opened;
          }
          const elvContext = await openWorkerElvContext({
            dbPath,
            openDatabase,
            fetchImpl,
            clock,
            log,
            ...(configuredElvServerUrl === undefined
              ? {}
              : { elvServerUrl: configuredElvServerUrl }),
          });
          enrichmentStore = elvContext.enrichmentStore;
          const localPlaylistStore =
            deps.localPlaylistStore ?? createLocalPlaylistStore(dirname(dbPath));
          const service = createCatalogService({
            db,
            secrets,
            scheduler: { yieldNow },
            http: desktopHttp,
            localPlaylistStore,
            maxBodyBytes: DESKTOP_MAX_BODY_BYTES,
            clock,
            ...(enrichmentStore === undefined ? {} : { enrichmentStore }),
            ...(elvContext.elvClient === undefined ? {} : { elvClient: elvContext.elvClient }),
            ...(deps.decompressor === undefined ? {} : { decompressor: deps.decompressor }),
          });
          return ok({
            db,
            ...(enrichmentStore === undefined ? {} : { enrichmentStore }),
            service,
          });
        } catch (error) {
          await enrichmentStore?.close().catch(() => undefined);
          await db?.close?.().catch(() => undefined);
          return err(elvError('storage', 'migration-failed', formatSqliteOpenError(error)));
        }
      },
      deps.sleep === undefined ? undefined : { sleep: deps.sleep },
    );
  };

  const ensureService = (): Promise<Result<OpenedCatalog>> => {
    openState ??= openOnce().then((res) => {
      if (!res.ok) openState = undefined;
      return res;
    });
    return openState;
  };

  const safePost = (session: ClientSession, message: CatalogWorkerMessage): void => {
    if (session.closed) return;
    try {
      session.port.postMessage(message);
    } catch {
      // the remote end closed
    }
  };

  const checkpointWal = async (db: SqlDriver): Promise<void> => {
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
  };

  const disconnectClient = (clientId: number): void => {
    const session = clients.get(clientId);
    if (!session) return;
    clients.delete(clientId);
    session.closed = true;
    for (const ctl of session.controllers.values()) ctl.abort();
    session.controllers.clear();
    session.port.close();
  };

  const executeCall = async (
    opened: OpenedCatalog,
    session: ClientSession,
    reqId: number,
    call: CatalogRpcMethodCall,
    ctl: AbortController | undefined,
  ): Promise<unknown> => {
    const { service, db } = opened;
    switch (call.method) {
      case 'ping':
        return ok(undefined);
      case 'addSource': {
        const sanitized = sanitizeAddSourceInput(call.input);
        if (!sanitized.ok) return sanitized;
        return service.addSource(sanitized.value);
      }
      case 'addSourceFromLink': {
        const sanitized = sanitizeLinkSourceInput(call.input);
        if (!sanitized.ok) return sanitized;
        return service.addSourceFromLink(sanitized.value);
      }
      case 'addLocalM3uSource': {
        if (!service.addLocalM3uSource) return err(elvError('storage', 'unsupported'));
        const sanitized = sanitizeLocalM3uInput(call.input);
        if (!sanitized.ok) return sanitized;
        return service.addLocalM3uSource(sanitized.value);
      }
      case 'discoverSourceCategories': {
        if (!service.discoverSourceCategories) return err(elvError('storage', 'unsupported'));
        return service.discoverSourceCategories(
          call.sourceId,
          ctl === undefined ? undefined : { signal: ctl.signal },
        );
      }
      case 'updateSourceSettings': {
        if (!service.updateSourceSettings) return undefined;
        await service.updateSourceSettings(call.sourceId, call.patch);
        await checkpointWal(db);
        return undefined;
      }
      case 'renameSource': {
        if (!service.renameSource) return err(elvError('storage', 'unsupported'));
        const res = await service.renameSource(call.sourceId, sanitizeDisplayText(call.name));
        await checkpointWal(db);
        return res;
      }
      case 'setSourceExcludedProfiles': {
        if (!service.setSourceExcludedProfiles) return err(elvError('storage', 'unsupported'));
        const res = await service.setSourceExcludedProfiles(call.sourceId, call.excludedProfileIds);
        await checkpointWal(db);
        return res;
      }
      case 'removeSource': {
        if (!SAFE_SOURCE_ID_RE.test(call.id)) return ok(undefined);
        const res = await service.removeSource(call.id);
        await checkpointWal(db);
        return res;
      }
      case 'importSource': {
        const startedAt = clock();
        const sources = await service.listSources().catch(() => []);
        const sourceKind = sources.find((s) => s.id === call.id)?.kind;
        const res = await service.importSource(call.id, {
          ...(ctl === undefined ? {} : { signal: ctl.signal }),
          ...(call.batchSize === undefined ? {} : { batchSize: call.batchSize }),
          ...(call.maxBodyBytes === undefined ? {} : { maxBodyBytes: call.maxBodyBytes }),
          ...(call.progress
            ? {
                onProgress: (progress) => safePost(session, { type: 'progress', reqId, progress }),
              }
            : {}),
        });
        parentPort.postMessage({
          type: 'telemetry',
          event: buildCatalogImportTelemetryEvent({
            sourceKind,
            stage: 'catalog',
            durationMs: clock() - startedAt,
            itemCount: res.ok ? sumImportCounts(res.value.counts) : 0,
            success: res.ok,
            errorCode: res.ok ? undefined : res.error.code,
          }),
        });
        await checkpointWal(db);
        return res;
      }
      case 'importGuide': {
        if (!service.importGuide) return err(elvError('storage', 'unsupported'));
        const startedAt = clock();
        const sources = await service.listSources().catch(() => []);
        const sourceKind = sources.find((s) => s.id === call.id)?.kind;
        const res = await service.importGuide(
          call.id,
          ctl === undefined ? undefined : { signal: ctl.signal },
        );
        parentPort.postMessage({
          type: 'telemetry',
          event: buildCatalogImportTelemetryEvent({
            sourceKind,
            stage: 'guide',
            durationMs: clock() - startedAt,
            itemCount: res.ok ? sumImportCounts(res.value.counts) : 0,
            success: res.ok,
            errorCode: res.ok ? undefined : res.error.code,
          }),
        });
        await checkpointWal(db);
        return res;
      }
      case 'listSources':
        return service.listSources();
      case 'categories':
        return service.categories(call.sourceId, call.kind, call.opts);
      case 'items':
        return service.items(call.categoryId, call.offset, call.limit, call.opts);
      case 'liveVariants':
        return service.liveVariants
          ? service.liveVariants(call.itemKey, call.categoryId, call.opts)
          : [];
      case 'itemVersions':
        return service.itemVersions ? service.itemVersions(call.itemKey, call.opts) : [];
      case 'allSourcesItems':
        return service.allSourcesItems
          ? service.allSourcesItems(call.kind, call.offset, call.limit, call.sourceIds, call.opts)
          : [];
      case 'itemDetail':
        return service.itemDetail ? service.itemDetail(call.itemKey, call.opts) : null;
      case 'search':
        return service.search
          ? service.search(call.query, call.opts)
          : { live: [], epg: [], movies: [], series: [], episodes: [] };
      case 'searchSuggestions':
        return service.searchSuggestions ? service.searchSuggestions(call.options) : [];
      case 'alphabetIndex':
        return service.alphabetIndex ? service.alphabetIndex(call.input) : [];
      case 'nowNext':
        return service.nowNext ? service.nowNext(call.channelKeys, call.nowMs, call.opts) : [];
      case 'epgWindow':
        return service.epgWindow
          ? service.epgWindow(call.channelKeys, call.fromMs, call.toMs, call.opts)
          : {};
      case 'epgSlice':
        return service.epgSlice
          ? service.epgSlice(call.sourceId, call.fromMs, call.toMs, call.limit, call.opts)
          : [];
      case 'channelByNumber':
        return service.channelByNumber
          ? service.channelByNumber(call.num, call.sourceId, call.opts)
          : null;
      case 'seasons':
        return service.seasons(call.seriesId, call.opts);
      case 'episodes':
        return service.episodes(call.seriesId, call.season, call.opts);
      case 'queryNextEpisode':
        return service.queryNextEpisode
          ? service.queryNextEpisode(call.seriesKey, call.currentItemKey, call.profileId, call.opts)
          : null;
      case 'resolveStream':
        return service.resolveStream(call.itemKey, call.opts);
      case 'saveProgress':
      case 'setWatched':
      case 'setSeasonWatched':
      case 'setSeriesWatched':
      case 'getProgress':
      case 'listContinueWatching':
      case 'listWatched':
      case 'listProgressByKeys':
      case 'listSeriesUnplayedCounts':
      case 'clearProgress':
      case 'toggleFavorite':
      case 'setFavorite':
      case 'reorderFavorites':
      case 'listFavorites':
      case 'listFavoriteKeys':
      case 'listMyListNewEpisodes':
      case 'dismissMyListNewEpisode':
      case 'refreshMyListNewEpisodes':
      case 'getTrackPreference':
      case 'saveTrackPreference':
      case 'clearTrackPreference':
      case 'recordRecentChannel':
      case 'listRecentChannels':
      case 'setRating':
      case 'getRating':
      case 'listRatings':
      case 'listRatingMap':
        return executeUserStateRpcCall(service, call, sanitizeDisplayText);
      case 'listProfiles':
        return service.listProfiles ? service.listProfiles() : [];
      case 'createProfile':
        return service.createProfile
          ? service.createProfile({
              ...call.input,
              name: sanitizeDisplayText(call.input.name),
            })
          : err(elvError('storage', 'unsupported'));
      case 'updateProfile':
        return service.updateProfile
          ? service.updateProfile(call.id, {
              ...call.patch,
              ...(call.patch.name === undefined
                ? {}
                : { name: sanitizeDisplayText(call.patch.name) }),
            })
          : err(elvError('storage', 'unsupported'));
      case 'deleteProfile': {
        if (!service.deleteProfile) return err(elvError('storage', 'unsupported'));
        const res = await service.deleteProfile(call.id);
        await checkpointWal(db);
        return res;
      }
      case 'getParentalSettings':
        return service.getParentalSettings
          ? service.getParentalSettings(call.profileId)
          : {
              profileId: call.profileId ?? 'default',
              enabled: false,
              blockAdultKeywords: true,
              maxRatingAge: null,
              unlockTimeoutMin: 30,
              updatedAt: 0,
            };
      case 'updateParentalSettings':
        return service.updateParentalSettings
          ? service.updateParentalSettings(call.patch, call.profileId)
          : err(elvError('storage', 'unsupported'));
      case 'listParentalLocks':
        return service.listParentalLocks
          ? service.listParentalLocks(call.profileId, call.filter)
          : [];
      case 'setParentalLock':
        return service.setParentalLock
          ? service.setParentalLock(call.input, call.locked)
          : err(elvError('storage', 'unsupported'));
      case 'hasParentalPin':
        return service.hasParentalPin ? service.hasParentalPin(call.profileId) : false;
      case 'setParentalPin':
        return service.setParentalPin
          ? service.setParentalPin(call.pin, call.profileId, call.currentPin)
          : err(elvError('storage', 'unsupported'));
      case 'verifyParentalPin':
        return service.verifyParentalPin
          ? service.verifyParentalPin(call.pin, call.profileId)
          : { ok: false, remainingAttempts: 0 };
      case 'clearParentalPin':
        return service.clearParentalPin
          ? service.clearParentalPin(call.currentPin, call.profileId)
          : err(elvError('storage', 'unsupported'));
      case 'listChannelOverrides':
      case 'setChannelOverride':
      case 'clearChannelOverride':
      case 'reorderChannels':
      case 'listCustomGroups':
      case 'createCustomGroup':
      case 'updateCustomGroup':
      case 'deleteCustomGroup':
      case 'setCustomGroupItems':
      case 'addChannelToCustomGroup':
      case 'removeChannelFromCustomGroup':
        return executeChannelOpsRpcCall(service, call);
      case 'flushPendingWrites':
        if (service.flushPendingWrites) await service.flushPendingWrites();
        return undefined;
      case 'listFailoverGroups':
      case 'getFailoverGroupByChannel':
      case 'createFailoverGroup':
      case 'renameFailoverGroup':
      case 'deleteFailoverGroup':
      case 'addFailoverGroupMember':
      case 'removeFailoverGroupMember':
      case 'reorderFailoverGroupMembers':
      case 'suggestFailoverGroups':
      case 'applySuggestedFailoverGroups':
      case 'reportStreamOutcome':
        return executeFailoverOpsRpcCall(service, call);
      default:
        return isWaveE1RpcCall(call)
          ? executeWaveE1OpsRpcCall(service, call)
          : isWaveE2RpcCall(call)
            ? executeWaveE2OpsRpcCall(service, call)
            : isWaveP9RpcCall(call)
              ? executeWaveP9OpsRpcCall(service, call)
              : isWaveF5bRpcCall(call)
                ? executeWaveF5bOpsRpcCall(service, call)
                : executeEpgOpsRpcCall(service, call);
    }
  };

  const attachClient = (clientId: number, port: WorkerClientPortLike): void => {
    if (!acceptingCalls) {
      port.close();
      return;
    }
    disconnectClient(clientId);
    const session: ClientSession = { port, controllers: new Map(), closed: false };
    clients.set(clientId, session);
    port.once('close', () => disconnectClient(clientId));
    port.on('message', (ev) => {
      const raw = ev.data;
      if (!isCatalogClientMessage(raw)) {
        log('catalog worker: dropped an invalid client message');
        if (
          typeof raw === 'object' &&
          raw !== null &&
          (raw as Record<string, unknown>)['type'] === 'call'
        ) {
          const reqId = (raw as Record<string, unknown>)['reqId'];
          if (Number.isSafeInteger(reqId) && (reqId as number) > 0) {
            safePost(session, {
              type: 'fault',
              reqId: reqId as number,
              error: elvError('source-format', 'invalid-request'),
            });
          }
        }
        return;
      }
      if (raw.type === 'cancel') {
        session.controllers.get(raw.reqId)?.abort();
        return;
      }
      if (!acceptingCalls) {
        safePost(session, {
          type: 'fault',
          reqId: raw.reqId,
          error: elvError('storage', 'closed'),
        });
        return;
      }
      const { reqId, call } = raw;
      const ctl =
        call.method === 'importSource' ||
        call.method === 'importGuide' ||
        call.method === 'discoverSourceCategories'
          ? new AbortController()
          : undefined;
      if (ctl !== undefined) session.controllers.set(reqId, ctl);

      const task = (async () => {
        const secretCtx = { keyRotated: false };
        try {
          const opened = await ensureService();
          if (!opened.ok) {
            safePost(session, { type: 'fault', reqId, error: opened.error });
            return;
          }
          let value = await callSecretContext.run(secretCtx, () =>
            executeCall(opened.value, session, reqId, call, ctl),
          );
          if (secretCtx.keyRotated && isSecretMissingResult(value)) {
            value = err(elvError('storage', 'secret-key-rotated'));
          }
          safePost(session, { type: 'result', reqId, value });
        } catch (error) {
          const fault: ElvError =
            secretCtx.keyRotated || isSecretKeyRotatedError(error)
              ? elvError('storage', 'secret-key-rotated')
              : elvError('storage', 'sql-failed');
          safePost(session, { type: 'fault', reqId, error: fault });
        } finally {
          if (ctl !== undefined) session.controllers.delete(reqId);
        }
      })();
      inFlightCalls.add(task);
      void task.finally(() => {
        inFlightCalls.delete(task);
      });
    });
    port.start();
  };

  const shutdown = async (): Promise<void> => {
    if (!acceptingCalls) return;
    acceptingCalls = false;
    for (const id of [...clients.keys()]) disconnectClient(id);
    if (inFlightCalls.size > 0) {
      await Promise.allSettled([...inFlightCalls]);
    }
    const current = openState;
    openState = undefined;
    if (current !== undefined) {
      const res = await current;
      if (res.ok) {
        await res.value.service.close().catch(() => undefined);
        await res.value.enrichmentStore?.close().catch(() => undefined);
      }
    }
    secretsClosed = true;
    for (const pending of pendingSecrets.values()) {
      pending.reject(new Error('catalog worker shut down'));
    }
    pendingSecrets.clear();
    parentPort.off('message', onParentMessage);
    parentPort.postMessage({ type: 'shutdown-complete' });
    deps.onExit?.(0);
  };

  const onParentMessage = (ev: {
    data: unknown;
    ports?: readonly WorkerClientPortLike[];
  }): void => {
    const msg = ev.data;
    if (!isMainToWorkerMessage(msg)) {
      log('catalog worker: dropped an invalid parent message');
      return;
    }
    switch (msg.type) {
      case 'init':
        configuredDbPath = msg.dbPath;
        configuredElvServerUrl = msg.elvServerUrl;
        void ensureService().then(() => {
          parentPort.postMessage({ type: 'ready' });
        });
        break;
      case 'set-elv-server-url': {
        const trimmed = msg.elvServerUrl.trim();
        configuredElvServerUrl = trimmed === '' ? undefined : trimmed;
        const targetOpen = openState;
        if (targetOpen !== undefined) {
          void targetOpen.then((opened) => {
            if (opened.ok && acceptingCalls) {
              opened.value.service.setElvClient?.(
                createWorkerElvClient({
                  fetchImpl,
                  ...(configuredElvServerUrl === undefined
                    ? {}
                    : { elvServerUrl: configuredElvServerUrl }),
                }),
              );
            }
          });
        }
        break;
      }
      case 'client-port': {
        const port = ev.ports?.[0];
        if (port) attachClient(msg.clientId, port);
        break;
      }
      case 'client-disconnect':
        disconnectClient(msg.clientId);
        break;
      case 'secret-reply': {
        const pending = pendingSecrets.get(msg.reqId);
        if (!pending) break;
        pendingSecrets.delete(msg.reqId);
        if (msg.ok) {
          pending.resolve(msg.value ?? undefined);
        } else if (msg.message === SECRET_KEY_ROTATED_CODE) {
          if (pending.ctx !== undefined) pending.ctx.keyRotated = true;
          pending.reject(createSecretKeyRotatedError());
        } else {
          pending.reject(new Error(msg.message));
        }
        break;
      }
      case 'shutdown':
        void shutdown();
        break;
    }
  };

  parentPort.on('message', onParentMessage);

  return () => {
    parentPort.off('message', onParentMessage);
    for (const id of [...clients.keys()]) disconnectClient(id);
  };
}
