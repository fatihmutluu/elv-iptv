import { dirname } from 'node:path';
import {
  type AddSourceInput,
  type CatalogService,
  createCatalogService,
  createSyncSqlDriver,
  type LinkSourceInput,
  type LocalM3uSourceInput,
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
import { createDesktopHttpClient } from './legacy-tls-http.ts';
import { createLocalPlaylistStore } from './local-playlist-store.ts';
import { formatSqliteOpenError, openSqliteWithRetry } from './sqlite-open-retry.ts';

const SAFE_SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NON_HOST_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(?!\/\/)(?!\d+(?:[/?#]|$))/;
/** Desktop streams Xtream JSON incrementally in `O(batchSize)` memory, matching `xtream.ts` `DEFAULT_MAX_BODY`. */
const DESKTOP_MAX_BODY_BYTES = 128 * 1024 * 1024;

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
}

interface OpenedCatalog {
  db: SqlDriver;
  service: CatalogService;
}

interface ClientSession {
  readonly port: WorkerClientPortLike;
  readonly controllers: Map<number, AbortController>;
  closed: boolean;
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function sanitizeDisplayText(text: string): string {
  if (!hasControlChar(text)) return text;
  let out = '';
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += text[i];
      lastSpace = code === 0x20;
    }
  }
  return out.trim();
}

function isHttpUrl(raw: string): boolean {
  if (raw === '' || hasControlChar(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isValidXtreamServer(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '' || hasControlChar(trimmed)) return false;
  if (!trimmed.startsWith('[') && NON_HOST_SCHEME_RE.test(trimmed)) return false;
  const normalized = (trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
  return isHttpUrl(normalized);
}

function sanitizeGuideUrl(guideUrl: string | undefined): Result<string | undefined> {
  if (guideUrl === undefined) return ok(undefined);
  const trimmed = guideUrl.trim();
  if (trimmed === '') return ok(undefined);
  if (!isHttpUrl(trimmed)) return err(elvError('source-format', 'invalid-source'));
  return ok(trimmed);
}

function sanitizeAddSourceInput(input: AddSourceInput): Result<AddSourceInput> {
  const guide = sanitizeGuideUrl(input.guideUrl);
  if (!guide.ok) return guide;
  if (input.kind === 'm3u') {
    const playlistUrl = input.playlistUrl.trim();
    if (!isHttpUrl(playlistUrl)) return err(elvError('source-format', 'invalid-source'));
    const { guideUrl: _prevGuide, ...rest } = input;
    return ok({
      ...rest,
      playlistUrl,
      ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
    });
  }
  const server = input.server.trim();
  if (!isValidXtreamServer(server)) return err(elvError('source-format', 'invalid-source'));
  const { guideUrl: _prevGuide, ...rest } = input;
  return ok({
    ...rest,
    server,
    ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
  });
}

function sanitizeLinkSourceInput(input: LinkSourceInput): Result<LinkSourceInput> {
  const url = input.url.trim();
  if (!isHttpUrl(url)) return err(elvError('source-format', 'invalid-source'));
  const guide = sanitizeGuideUrl(input.guideUrl);
  if (!guide.ok) return guide;
  const { guideUrl: _prevGuide, ...rest } = input;
  return ok({
    ...rest,
    url,
    ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
  });
}

function sanitizeLocalM3uInput(input: LocalM3uSourceInput): Result<LocalM3uSourceInput> {
  const guide = sanitizeGuideUrl(input.guideUrl);
  if (!guide.ok) return guide;
  const { guideUrl: _prevGuide, ...rest } = input;
  return ok({
    ...rest,
    ...(guide.value === undefined ? {} : { guideUrl: guide.value }),
  });
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
  let openState: Promise<Result<OpenedCatalog>> | undefined;
  let acceptingCalls = true;
  let secretsClosed = false;
  let nextSecretReqId = 0;

  const pendingSecrets = new Map<
    number,
    { resolve: (value: string | undefined) => void; reject: (reason: Error) => void }
  >();
  const clients = new Map<number, ClientSession>();
  const inFlightCalls = new Set<Promise<void>>();

  const maxSecretValueChars = deps.maxSecretValueChars ?? MAX_SECRET_VALUE_CHARS;
  const requestSecret = (
    msg: { op: 'get' | 'delete'; key: string } | { op: 'set'; key: string; value: string },
  ): Promise<string | undefined> => {
    if (secretsClosed) return Promise.reject(new Error('catalog worker secrets closed'));
    if (!SECRET_KEY_RE.test(msg.key)) {
      return Promise.reject(new Error('invalid secret key'));
    }
    if (msg.op === 'set' && msg.value.length > maxSecretValueChars) {
      return Promise.reject(new Error('secret value exceeds maximum length'));
    }
    const reqId = ++nextSecretReqId;
    return new Promise((resolve, reject) => {
      pendingSecrets.set(reqId, { resolve, reject });
      if (msg.op === 'set') {
        parentPort.postMessage({
          type: 'secret-request',
          reqId,
          op: 'set',
          key: msg.key,
          value: msg.value,
        });
      } else {
        parentPort.postMessage({ type: 'secret-request', reqId, op: msg.op, key: msg.key });
      }
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
        try {
          db = createSyncSqlDriver(openDatabase(dbPath));
          const opened = await openCatalog(db, clock);
          if (!opened.ok) {
            await db.close?.().catch(() => undefined);
            return opened;
          }
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
            ...(deps.decompressor === undefined ? {} : { decompressor: deps.decompressor }),
          });
          return ok({ db, service });
        } catch (error) {
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
      case 'removeSource': {
        if (!SAFE_SOURCE_ID_RE.test(call.id)) return ok(undefined);
        const res = await service.removeSource(call.id);
        await checkpointWal(db);
        return res;
      }
      case 'importSource': {
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
        await checkpointWal(db);
        return res;
      }
      case 'importGuide': {
        if (!service.importGuide) return err(elvError('storage', 'unsupported'));
        const res = await service.importGuide(
          call.id,
          ctl === undefined ? undefined : { signal: ctl.signal },
        );
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
        return service.liveVariants ? service.liveVariants(call.itemKey, call.categoryId) : [];
      case 'itemVersions':
        return service.itemVersions ? service.itemVersions(call.itemKey) : [];
      case 'allSourcesItems':
        return service.allSourcesItems
          ? service.allSourcesItems(call.kind, call.offset, call.limit, call.sourceIds, call.opts)
          : [];
      case 'itemDetail':
        return service.itemDetail ? service.itemDetail(call.itemKey) : null;
      case 'search':
        return service.search
          ? service.search(call.query, call.opts)
          : { live: [], movies: [], series: [] };
      case 'nowNext':
        return service.nowNext ? service.nowNext(call.channelKeys, call.nowMs) : [];
      case 'epgWindow':
        return service.epgWindow ? service.epgWindow(call.channelKeys, call.fromMs, call.toMs) : {};
      case 'channelByNumber':
        return service.channelByNumber ? service.channelByNumber(call.num, call.sourceId) : null;
      case 'seasons':
        return service.seasons(call.seriesId);
      case 'episodes':
        return service.episodes(call.seriesId, call.season);
      case 'queryNextEpisode':
        return service.queryNextEpisode
          ? service.queryNextEpisode(call.seriesKey, call.currentItemKey, call.profileId)
          : null;
      case 'resolveStream':
        return service.resolveStream(call.itemKey);
      case 'saveProgress':
        return service.saveProgress
          ? service.saveProgress({
              ...call.input,
              title: sanitizeDisplayText(call.input.title),
              ...(typeof call.input.subtitle === 'string'
                ? { subtitle: sanitizeDisplayText(call.input.subtitle) }
                : {}),
            })
          : err(elvError('storage', 'unsupported'));
      case 'setWatched':
        return service.setWatched
          ? service.setWatched(call.itemKey, call.watched, call.profileId)
          : err(elvError('storage', 'unsupported'));
      case 'getProgress':
        return service.getProgress ? service.getProgress(call.itemKey, call.profileId) : null;
      case 'listContinueWatching':
        return service.listContinueWatching
          ? service.listContinueWatching(call.limit, call.profileId)
          : [];
      case 'listProgressByKeys':
        return service.listProgressByKeys
          ? service.listProgressByKeys(call.itemKeys, call.profileId)
          : [];
      case 'listSeriesUnplayedCounts':
        return service.listSeriesUnplayedCounts
          ? service.listSeriesUnplayedCounts(call.seriesKeys, call.profileId)
          : [];
      case 'clearProgress':
        return service.clearProgress
          ? service.clearProgress(call.itemKey, call.profileId)
          : err(elvError('storage', 'unsupported'));
      case 'toggleFavorite':
        return service.toggleFavorite
          ? service.toggleFavorite({
              ...call.input,
              title: sanitizeDisplayText(call.input.title),
            })
          : err(elvError('storage', 'unsupported'));
      case 'setFavorite':
        return service.setFavorite
          ? service.setFavorite(
              {
                ...call.input,
                title: sanitizeDisplayText(call.input.title),
              },
              call.active,
            )
          : err(elvError('storage', 'unsupported'));
      case 'listFavorites':
        return service.listFavorites ? service.listFavorites(call.limit, call.profileId) : [];
      case 'listFavoriteKeys':
        return service.listFavoriteKeys ? service.listFavoriteKeys(call.profileId) : [];
      case 'getTrackPreference':
        return service.getTrackPreference
          ? service.getTrackPreference(call.scopeKey, call.profileId)
          : null;
      case 'saveTrackPreference':
        if (service.saveTrackPreference) await service.saveTrackPreference(call.input);
        return undefined;
      case 'clearTrackPreference':
        if (service.clearTrackPreference) {
          await service.clearTrackPreference(call.scopeKey, call.profileId);
        }
        return undefined;
      case 'recordRecentChannel':
        if (service.recordRecentChannel) {
          await service.recordRecentChannel(call.itemKey, call.sourceId, call.profileId);
        }
        return undefined;
      case 'listRecentChannels':
        return service.listRecentChannels
          ? service.listRecentChannels(call.limit, call.profileId)
          : [];
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
        try {
          const opened = await ensureService();
          if (!opened.ok) {
            safePost(session, { type: 'fault', reqId, error: opened.error });
            return;
          }
          const value = await executeCall(opened.value, session, reqId, call, ctl);
          safePost(session, { type: 'result', reqId, value });
        } catch {
          const fault: ElvError = elvError('storage', 'sql-failed');
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
      if (res.ok) await res.value.service.close().catch(() => undefined);
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
        void ensureService().then(() => {
          parentPort.postMessage({ type: 'ready' });
        });
        break;
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
        if (msg.ok) pending.resolve(msg.value ?? undefined);
        else pending.reject(new Error(msg.message));
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
