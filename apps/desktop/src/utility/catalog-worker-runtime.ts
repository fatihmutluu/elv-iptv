import {
  type CatalogService,
  createCatalogService,
  createSyncSqlDriver,
  openCatalog,
  type SyncDatabase,
} from '@elv/data';
import {
  createFetchHttpClient,
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
  type WorkerToMainMessage,
} from '../main/catalog/worker-protocol.ts';
import {
  type CatalogRpcMethodCall,
  type CatalogWorkerMessage,
  isCatalogClientMessage,
} from '../shared/catalog-ipc.ts';

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
  clock?: () => number;
  yieldNow?: () => Promise<void>;
  log?: (line: string) => void;
  onExit?: (code: number) => void;
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

/**
 * Wires `better-sqlite3` and `@elv/data`'s `CatalogService` inside an Electron `utilityProcess`.
 * Secrets cross only `parentPort`; client `MessagePort`s carry validated catalog calls, progress and cancellations.
 */
export function createCatalogWorkerRuntime(deps: CatalogWorkerRuntimeDeps): () => void {
  const { parentPort, openDatabase, fetchImpl } = deps;
  const clock = deps.clock ?? Date.now;
  const yieldNow = deps.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  let configuredDbPath: string | undefined;
  let openState: Promise<Result<OpenedCatalog>> | undefined;
  let shuttingDown = false;
  let nextSecretReqId = 0;

  const pendingSecrets = new Map<
    number,
    { resolve: (value: string | undefined) => void; reject: (reason: Error) => void }
  >();
  const clients = new Map<number, ClientSession>();

  const requestSecret = (
    msg: { op: 'get' | 'delete'; key: string } | { op: 'set'; key: string; value: string },
  ): Promise<string | undefined> => {
    if (shuttingDown) return Promise.reject(new Error('catalog worker shutting down'));
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
    let db: SqlDriver | undefined;
    try {
      db = createSyncSqlDriver(openDatabase(configuredDbPath));
      const opened = await openCatalog(db, clock);
      if (!opened.ok) {
        await db.close?.();
        return opened;
      }
      const service = createCatalogService({
        db,
        secrets,
        scheduler: { yieldNow },
        http: createFetchHttpClient(fetchImpl),
        clock,
      });
      return ok({ db, service });
    } catch (error) {
      await db?.close?.().catch(() => undefined);
      return err(
        elvError(
          'storage',
          'migration-failed',
          error instanceof Error ? error.message : 'open failed',
        ),
      );
    }
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
      case 'addSource':
        return service.addSource(call.input);
      case 'addSourceFromLink':
        return service.addSourceFromLink(call.input);
      case 'removeSource': {
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
      case 'listSources':
        return service.listSources();
      case 'categories':
        return service.categories(call.sourceId, call.kind);
      case 'items':
        return service.items(call.categoryId, call.offset, call.limit);
      case 'seasons':
        return service.seasons(call.seriesId);
      case 'episodes':
        return service.episodes(call.seriesId, call.season);
      case 'resolveStream':
        return service.resolveStream(call.itemKey);
    }
  };

  const attachClient = (clientId: number, port: WorkerClientPortLike): void => {
    disconnectClient(clientId);
    const session: ClientSession = { port, controllers: new Map(), closed: false };
    clients.set(clientId, session);
    port.once('close', () => disconnectClient(clientId));
    port.on('message', (ev) => {
      const raw = ev.data;
      if (!isCatalogClientMessage(raw)) {
        log('catalog worker: dropped an invalid client message');
        return;
      }
      if (raw.type === 'cancel') {
        session.controllers.get(raw.reqId)?.abort();
        return;
      }
      const { reqId, call } = raw;
      const ctl = call.method === 'importSource' ? new AbortController() : undefined;
      if (ctl !== undefined) session.controllers.set(reqId, ctl);

      void (async () => {
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
    });
    port.start();
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const id of [...clients.keys()]) disconnectClient(id);
    const current = openState;
    openState = undefined;
    if (current !== undefined) {
      const res = await current;
      if (res.ok) await res.value.service.close().catch(() => undefined);
    }
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
