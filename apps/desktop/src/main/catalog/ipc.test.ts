import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_CHANNELS } from '../../shared/catalog-ipc.ts';
import type { CatalogCoordinator } from './coordinator.ts';
import {
  type CatalogIpcMainLike,
  type CatalogWebContentsLike,
  registerCatalogIpc,
  registerCatalogQuitHandler,
} from './ipc.ts';

class FakeWebContents implements CatalogWebContentsLike<FakePort> {
  readonly id: number;
  private readonly emitter = new EventEmitter();
  destroyed = false;
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];
  readonly posted: Array<{ channel: string; message: unknown; transfer: FakePort[] }> = [];

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }

  postMessage(channel: string, message: unknown, transfer: FakePort[] = []): void {
    this.posted.push({ channel, message, transfer });
  }

  readonly once = this.emitter.once.bind(this.emitter);
  readonly on = this.emitter.on.bind(this.emitter);

  navigate(isMainFrame: boolean, isSameDocument: boolean): void {
    this.emitter.emit('did-start-navigation', { isMainFrame, isSameDocument });
  }

  crash(): void {
    this.emitter.emit('render-process-gone');
  }

  destroy(): void {
    this.destroyed = true;
    this.emitter.emit('destroyed');
  }
}

interface FakePort {
  id: number;
  closed: boolean;
  close(): void;
}

function makePort(id: number): FakePort {
  return {
    id,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

function createFakeIpcMain() {
  const listeners = new Map<
    string,
    Set<(event: { sender: CatalogWebContentsLike<FakePort> }, ...args: unknown[]) => unknown>
  >();
  const ipcMain: CatalogIpcMainLike<FakePort> = {
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
  return {
    ipcMain,
    listenerCount(channel: string): number {
      return listeners.get(channel)?.size ?? 0;
    },
    emit(sender: FakeWebContents, channel: string, ...args: unknown[]): void {
      for (const fn of listeners.get(channel) ?? []) {
        fn({ sender }, ...args);
      }
    },
  };
}

describe('registerCatalogIpc', () => {
  it('transfers a MessagePort to the requesting webContents, fences stale ports on reload/navigation/crash/destroy and broadcasts worker crashes', async () => {
    const { ipcMain, emit, listenerCount } = createFakeIpcMain();
    const disconnectedClients: number[] = [];
    const exitListeners = new Set<(code: number) => void>();
    const logs: string[] = [];
    let nextClient = 0;

    const coordinator: CatalogCoordinator<FakePort> = {
      isRunning: true,
      async connectClient() {
        nextClient += 1;
        return { clientId: nextClient, rendererPort: makePort(nextClient) };
      },
      disconnectClient(clientId) {
        disconnectedClients.push(clientId);
      },
      onUnexpectedExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      async shutdown() {},
    };

    const dispose = registerCatalogIpc({
      ipcMain,
      coordinator,
      log: (line) => logs.push(line),
    });

    const wc1 = new FakeWebContents(10);
    const wc2 = new FakeWebContents(20);

    // Invalid connect payload is dropped without logging payload
    emit(wc1, CATALOG_CHANNELS.connect, { connectId: 'bad', secret: 'nope' });
    expect(logs).toEqual(['catalog ipc: dropped an invalid catalog:connect message']);
    expect(wc1.posted).toHaveLength(0);

    // Valid connect transfers port
    emit(wc1, CATALOG_CHANNELS.connect, { connectId: 1 });
    await vi.waitFor(() => {
      expect(wc1.posted).toHaveLength(1);
    });
    expect(wc1.posted[0]?.channel).toBe(CATALOG_CHANNELS.port);
    expect(wc1.posted[0]?.message).toEqual({ connectId: 1 });
    expect(wc1.posted[0]?.transfer[0]?.id).toBe(1);

    // Same-document or subframe navigation does NOT fence the port
    wc1.navigate(false, false);
    wc1.navigate(true, true);
    expect(disconnectedClients).toEqual([]);

    // Main-frame cross-document navigation fences client 1
    wc1.navigate(true, false);
    expect(disconnectedClients).toEqual([1]);

    // Reconnect on wc1 + connect on wc2, then simulate worker crash -> both receive catalog:disconnected
    emit(wc1, CATALOG_CHANNELS.connect, { connectId: 2 });
    emit(wc2, CATALOG_CHANNELS.connect, { connectId: 1 });
    await vi.waitFor(() => {
      expect(wc1.posted).toHaveLength(2);
      expect(wc2.posted).toHaveLength(1);
    });

    for (const fn of exitListeners) fn(1);
    expect(wc1.sent).toEqual([
      { channel: CATALOG_CHANNELS.disconnected, args: [{ reason: 'worker-exited' }] },
    ]);
    expect(wc2.sent).toEqual([
      { channel: CATALOG_CHANNELS.disconnected, args: [{ reason: 'worker-exited' }] },
    ]);

    // Crash and destroy fence any active client
    emit(wc1, CATALOG_CHANNELS.connect, { connectId: 3 });
    await vi.waitFor(() => expect(wc1.posted).toHaveLength(3));
    wc1.crash();
    expect(disconnectedClients).toContain(4);

    emit(wc2, CATALOG_CHANNELS.connect, { connectId: 2 });
    await vi.waitFor(() => expect(wc2.posted).toHaveLength(2));
    wc2.destroy();
    expect(disconnectedClients).toContain(5);

    dispose();
    expect(listenerCount(CATALOG_CHANNELS.connect)).toBe(0);
  });

  it('fences a port whose connectClient resolved after navigation and notifies sender when connectClient fails', async () => {
    const { ipcMain, emit } = createFakeIpcMain();
    const disconnectedClients: number[] = [];
    let resolveConnect: ((v: { clientId: number; rendererPort: FakePort }) => void) | undefined;
    let shouldReject = false;

    const coordinator: CatalogCoordinator<FakePort> = {
      isRunning: false,
      connectClient() {
        if (shouldReject) return Promise.reject(new Error('spawn failed'));
        return new Promise((resolve) => {
          resolveConnect = resolve;
        });
      },
      disconnectClient(clientId) {
        disconnectedClients.push(clientId);
      },
      onUnexpectedExit: () => () => undefined,
      async shutdown() {},
    };

    registerCatalogIpc({ ipcMain, coordinator, log: () => undefined });
    const wc = new FakeWebContents(1);

    emit(wc, CATALOG_CHANNELS.connect, { connectId: 1 });
    // Navigate while connectClient is still awaiting worker ready
    wc.navigate(true, false);
    const port = makePort(99);
    resolveConnect?.({ clientId: 99, rendererPort: port });

    await vi.waitFor(() => {
      expect(disconnectedClients).toEqual([99]);
    });
    expect(port.closed).toBe(true);
    expect(wc.posted).toHaveLength(0);

    // Connect failure notifies renderer so pending open settles instead of hanging
    shouldReject = true;
    emit(wc, CATALOG_CHANNELS.connect, { connectId: 2 });
    await vi.waitFor(() => {
      expect(wc.sent).toEqual([
        { channel: CATALOG_CHANNELS.disconnected, args: [{ reason: 'worker-exited' }] },
      ]);
    });
  });

  it('blocks re-entrant before-quit calls until SQLite shutdown finishes, then lets final quit pass', async () => {
    const appEmitter = new EventEmitter();
    let running = true;
    let shutdownCalls = 0;
    let resolveShutdown: (() => void) | undefined;

    const coordinator: CatalogCoordinator<FakePort> = {
      get isRunning() {
        return running;
      },
      async connectClient() {
        return { clientId: 1, rendererPort: makePort(1) };
      },
      disconnectClient() {},
      onUnexpectedExit: () => () => undefined,
      shutdown() {
        shutdownCalls += 1;
        running = false; // coordinator.shutdown marks closing immediately
        return new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        });
      },
    };

    const prevented: boolean[] = [];
    const fireBeforeQuit = (): void => {
      let defaultPrevented = false;
      appEmitter.emit('before-quit', {
        preventDefault() {
          defaultPrevented = true;
        },
      });
      prevented.push(defaultPrevented);
    };

    let quitCalls = 0;
    registerCatalogQuitHandler({
      app: { on: appEmitter.on.bind(appEmitter) },
      getCoordinator: () => coordinator,
      quit: () => {
        quitCalls += 1;
        fireBeforeQuit();
      },
    });

    // First before-quit prevents default and starts coordinator.shutdown()
    fireBeforeQuit();
    // Second before-quit while shutdown is still awaiting SQLite close MUST ALSO prevent default!
    fireBeforeQuit();

    expect(prevented).toEqual([true, true]);
    expect(shutdownCalls).toBe(1);
    expect(quitCalls).toBe(0);

    // Finish shutdown -> triggers quit(), whose before-quit passes through without preventDefault
    resolveShutdown?.();
    await vi.waitFor(() => {
      expect(quitCalls).toBe(1);
    });
    expect(prevented).toEqual([true, true, false]);
  });

  it('does not prevent before-quit when catalog worker was never spawned', () => {
    const appEmitter = new EventEmitter();
    registerCatalogQuitHandler({
      app: { on: appEmitter.on.bind(appEmitter) },
      getCoordinator: () => undefined,
      quit: () => undefined,
    });
    let defaultPrevented = false;
    appEmitter.emit('before-quit', {
      preventDefault() {
        defaultPrevented = true;
      },
    });
    expect(defaultPrevented).toBe(false);
  });
});
