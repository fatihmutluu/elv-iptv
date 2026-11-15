import {
  CATALOG_CHANNELS,
  type CatalogDisconnectedMessage,
  type CatalogPortMessage,
  isCatalogConnectMessage,
} from '../../shared/catalog-ipc.ts';
import type { CatalogCoordinator } from './coordinator.ts';

/** Subset of Electron's `WebContents` used by {@link registerCatalogIpc}. */
export interface CatalogWebContentsLike<TPort = unknown> {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  postMessage(channel: string, message: unknown, transfer?: TPort[]): void;
  once(event: 'destroyed', listener: () => void): unknown;
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
}

type CatalogIpcListener<TPort> = (
  event: { sender: CatalogWebContentsLike<TPort> },
  ...args: unknown[]
) => unknown;

/** Subset of Electron's `ipcMain` used by {@link registerCatalogIpc}. */
export interface CatalogIpcMainLike<TPort = unknown> {
  on(channel: string, listener: CatalogIpcListener<TPort>): unknown;
  removeListener(channel: string, listener: CatalogIpcListener<TPort>): unknown;
}

/** Dependencies for {@link registerCatalogIpc}. */
export interface CatalogIpcDeps<TPort = unknown> {
  ipcMain: CatalogIpcMainLike<TPort>;
  coordinator: CatalogCoordinator<TPort>;
  log: (line: string) => void;
}

function closePortIfPossible(port: unknown): void {
  if (
    typeof port === 'object' &&
    port !== null &&
    'close' in port &&
    typeof (port as { close?: unknown }).close === 'function'
  ) {
    (port as { close(): void }).close();
  }
}

/**
 * Registers the `catalog:connect` bootstrap handler, transfers a dedicated `MessagePort` to each
 * calling `webContents`, fences ports on reload/navigation/crash/close, and broadcasts unexpected
 * utility-process exits over `catalog:disconnected`.
 */
export function registerCatalogIpc<TPort = unknown>(deps: CatalogIpcDeps<TPort>): () => void {
  const { ipcMain, coordinator, log } = deps;
  const owners = new Map<number, CatalogWebContentsLike<TPort>>();
  const activeClients = new Map<number, number>();
  const generations = new Map<number, number>();
  let disposed = false;

  const bumpGeneration = (ownerId: number): number => {
    const next = (generations.get(ownerId) ?? 0) + 1;
    generations.set(ownerId, next);
    return next;
  };

  const releaseOwnerClient = (ownerId: number): void => {
    const prev = activeClients.get(ownerId);
    if (prev !== undefined) {
      activeClients.delete(ownerId);
      coordinator.disconnectClient(prev);
    }
  };

  const invalidateOwner = (ownerId: number): void => {
    bumpGeneration(ownerId);
    releaseOwnerClient(ownerId);
  };

  const watch = (owner: CatalogWebContentsLike<TPort>): void => {
    if (owners.has(owner.id)) return;
    owners.set(owner.id, owner);
    owner.once('destroyed', () => {
      owners.delete(owner.id);
      invalidateOwner(owner.id);
      generations.delete(owner.id);
    });
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) invalidateOwner(owner.id);
    });
    owner.on('render-process-gone', () => invalidateOwner(owner.id));
  };

  const notifyDisconnected = (owner: CatalogWebContentsLike<TPort>): void => {
    if (owner.isDestroyed()) return;
    const msg: CatalogDisconnectedMessage = { reason: 'worker-exited' };
    owner.send(CATALOG_CHANNELS.disconnected, msg);
  };

  const unsubExit = coordinator.onUnexpectedExit(() => {
    activeClients.clear();
    for (const owner of owners.values()) {
      notifyDisconnected(owner);
    }
  });

  const onConnect: CatalogIpcListener<TPort> = ({ sender }, message) => {
    if (!isCatalogConnectMessage(message)) {
      log(`catalog ipc: dropped an invalid ${CATALOG_CHANNELS.connect} message`);
      return;
    }
    if (disposed || sender.isDestroyed()) return;

    watch(sender);
    const gen = bumpGeneration(sender.id);
    releaseOwnerClient(sender.id);
    const { connectId } = message;

    void coordinator.connectClient().then(
      ({ clientId, rendererPort }) => {
        if (disposed || sender.isDestroyed() || generations.get(sender.id) !== gen) {
          coordinator.disconnectClient(clientId);
          closePortIfPossible(rendererPort);
          return;
        }
        activeClients.set(sender.id, clientId);
        const reply: CatalogPortMessage = { connectId };
        sender.postMessage(CATALOG_CHANNELS.port, reply, [rendererPort]);
      },
      () => {
        log('catalog ipc: failed to connect catalog utility process');
        if (!disposed && !sender.isDestroyed() && generations.get(sender.id) === gen) {
          notifyDisconnected(sender);
        }
      },
    );
  };

  ipcMain.on(CATALOG_CHANNELS.connect, onConnect);

  return () => {
    disposed = true;
    unsubExit();
    ipcMain.removeListener(CATALOG_CHANNELS.connect, onConnect);
    for (const clientId of activeClients.values()) {
      coordinator.disconnectClient(clientId);
    }
    activeClients.clear();
    owners.clear();
  };
}

/** Subset of Electron's `app` lifecycle needed to flush SQLite cleanly before process exit. */
export interface QuitAppLike {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
}

/**
 * Registers an idempotent `before-quit` hook that blocks re-entrant `app.quit()` calls while the
 * catalog `utilityProcess` flushes in-flight rollbacks and closes SQLite, then triggers the final quit.
 */
export function registerCatalogQuitHandler(deps: {
  app: QuitAppLike;
  getCoordinator: () => CatalogCoordinator<unknown> | undefined;
  quit: () => void;
}): void {
  const { app, getCoordinator, quit } = deps;
  let shuttingDown = false;
  let shutDownComplete = false;

  app.on('before-quit', (event) => {
    if (shutDownComplete) return;
    const coordinator = getCoordinator();
    if (!shuttingDown && !coordinator?.isRunning) {
      shutDownComplete = true;
      return;
    }
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void (coordinator?.shutdown() ?? Promise.resolve()).finally(() => {
      shutDownComplete = true;
      quit();
    });
  });
}
