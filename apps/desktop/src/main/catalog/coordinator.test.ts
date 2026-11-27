import { EventEmitter } from 'node:events';
import type { SecretStore } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogCoordinator, type UtilityChildLike } from './coordinator.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from './worker-protocol.ts';

class FakeChild implements UtilityChildLike {
  private readonly emitter = new EventEmitter();
  readonly received: Array<{ message: MainToWorkerMessage; transfer: readonly unknown[] }> = [];
  killed = false;

  readonly on = this.emitter.on.bind(this.emitter);

  postMessage(message: MainToWorkerMessage, transfer: unknown[] = []): void {
    this.received.push({ message, transfer });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emitExit(0);
    return true;
  }

  emitWorkerMessage(msg: WorkerToMainMessage | unknown): void {
    this.emitter.emit('message', msg);
  }

  emitExit(code: number): void {
    this.emitter.emit('exit', code);
  }
}

function createMemorySecrets(fail = false): { store: SecretStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const store: SecretStore = {
    async get(key) {
      if (fail) throw new Error('cipher unavailable');
      return map.get(key);
    },
    async set(key, value) {
      if (fail) throw new Error('cipher unavailable');
      map.set(key, value);
    },
    async delete(key) {
      if (fail) throw new Error('cipher unavailable');
      map.delete(key);
    },
  };
  return { store, map };
}

describe('createCatalogCoordinator', () => {
  it('spawns lazily, deduplicates concurrent startups, transfers client ports and bridges SecretStore over parentPort', async () => {
    const children: FakeChild[] = [];
    const { store, map } = createMemorySecrets();
    const logs: string[] = [];
    let channelSeq = 0;

    const coordinator = createCatalogCoordinator({
      dbPath: '/tmp/user-data/catalog.db',
      workerPath: '/app/dist/utility/catalog-worker.js',
      secrets: store,
      fork: (path) => {
        expect(path).toBe('/app/dist/utility/catalog-worker.js');
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      createChannel: () => {
        channelSeq += 1;
        return { port1: `renderer-port-${channelSeq}`, port2: `worker-port-${channelSeq}` };
      },
      log: (line) => logs.push(line),
    });

    expect(coordinator.isRunning).toBe(false);
    expect(children).toHaveLength(0);

    // Concurrent connectClient calls share a single utilityProcess fork
    const p1 = coordinator.connectClient();
    const p2 = coordinator.connectClient();
    expect(children).toHaveLength(1);
    expect(coordinator.isRunning).toBe(true);

    const child = children[0];
    expect(child?.received).toEqual([
      { message: { type: 'init', dbPath: '/tmp/user-data/catalog.db' }, transfer: [] },
    ]);

    child?.emitWorkerMessage({ type: 'ready' });
    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toEqual({ clientId: 1, rendererPort: 'renderer-port-1' });
    expect(c2).toEqual({ clientId: 2, rendererPort: 'renderer-port-2' });
    expect(child?.received.slice(1)).toEqual([
      { message: { type: 'client-port', clientId: 1 }, transfer: ['worker-port-1'] },
      { message: { type: 'client-port', clientId: 2 }, transfer: ['worker-port-2'] },
    ]);

    // Bridge SecretStore set -> get -> delete over parentPort
    const sampleVal = ['tok', 'Sample', '42'].join('_');
    child?.emitWorkerMessage({
      type: 'secret-request',
      reqId: 10,
      op: 'set',
      key: 'source.s1.playlist',
      value: sampleVal,
    });
    await vi.waitFor(() => {
      expect(child?.received.at(-1)?.message).toEqual({
        type: 'secret-reply',
        reqId: 10,
        ok: true,
        value: null,
      });
    });
    expect(map.get('source.s1.playlist')).toBe(sampleVal);

    child?.emitWorkerMessage({
      type: 'secret-request',
      reqId: 11,
      op: 'get',
      key: 'source.s1.playlist',
    });
    await vi.waitFor(() => {
      expect(child?.received.at(-1)?.message).toEqual({
        type: 'secret-reply',
        reqId: 11,
        ok: true,
        value: sampleVal,
      });
    });

    child?.emitWorkerMessage({
      type: 'secret-request',
      reqId: 12,
      op: 'delete',
      key: 'source.s1.playlist',
    });
    await vi.waitFor(() => {
      expect(child?.received.at(-1)?.message).toEqual({
        type: 'secret-reply',
        reqId: 12,
        ok: true,
        value: null,
      });
    });
    expect(map.has('source.s1.playlist')).toBe(false);

    // Invalid worker message is dropped without logging payload
    child?.emitWorkerMessage({ type: 'bogus', leak: sampleVal });
    expect(logs).toEqual(['catalog coordinator: dropped an invalid worker message']);
    expect(logs.join('\n')).not.toContain(sampleVal);

    // disconnectClient forwards client-disconnect
    coordinator.disconnectClient(1);
    expect(child?.received.at(-1)?.message).toEqual({ type: 'client-disconnect', clientId: 1 });

    // Graceful shutdown sends shutdown and waits for shutdown-complete + exit
    const unexpected = vi.fn();
    coordinator.onUnexpectedExit(unexpected);
    const shuttingDown = coordinator.shutdown();
    expect(child?.received.at(-1)?.message).toEqual({ type: 'shutdown' });
    child?.emitWorkerMessage({ type: 'shutdown-complete' });
    child?.emitExit(0);
    await shuttingDown;
    expect(unexpected).not.toHaveBeenCalled();
    expect(coordinator.isRunning).toBe(false);
  });

  it('notifies unexpected-exit listeners on worker crash and respawns cleanly on the next connectClient', async () => {
    const children: FakeChild[] = [];
    const { store } = createMemorySecrets(true);
    const exits: number[] = [];

    const coordinator = createCatalogCoordinator({
      dbPath: '/tmp/catalog.db',
      workerPath: '/app/worker.js',
      secrets: store,
      fork: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      createChannel: () => ({ port1: 'p1', port2: 'p2' }),
      log: () => undefined,
    });

    const unsub = coordinator.onUnexpectedExit((code) => exits.push(code));

    const first = coordinator.connectClient();
    children[0]?.emitWorkerMessage({ type: 'ready' });
    await first;

    // SecretStore failure replies ok: false without crashing coordinator
    children[0]?.emitWorkerMessage({
      type: 'secret-request',
      reqId: 1,
      op: 'get',
      key: 'source.s1.password',
    });
    await vi.waitFor(() => {
      expect(children[0]?.received.at(-1)?.message).toEqual({
        type: 'secret-reply',
        reqId: 1,
        ok: false,
        message: 'secret store failed',
      });
    });

    // Simulate unexpected crash
    children[0]?.emitExit(139);
    expect(exits).toEqual([139]);
    expect(coordinator.isRunning).toBe(false);

    // Next connectClient respawns a fresh worker
    const second = coordinator.connectClient();
    expect(children).toHaveLength(2);
    children[1]?.emitWorkerMessage({ type: 'ready' });
    const reconnected = await second;
    expect(reconnected.clientId).toBe(2);

    unsub();
    children[1]?.emitExit(1);
    expect(exits).toEqual([139]);
  });

  it('rejects startup if worker exits before ready and kills hung worker on shutdown timeout', async () => {
    const children: FakeChild[] = [];
    const { store } = createMemorySecrets();

    const coordinator = createCatalogCoordinator({
      dbPath: '/tmp/catalog.db',
      workerPath: '/app/worker.js',
      secrets: store,
      fork: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      createChannel: () => ({ port1: 'p1', port2: 'p2' }),
      shutdownTimeoutMs: 20,
      log: () => undefined,
    });

    // Shutdown when never started is an immediate no-op
    await coordinator.shutdown();

    const failedStart = coordinator.connectClient();
    children[0]?.emitExit(1);
    await expect(failedStart).rejects.toThrow(/exited before ready/i);

    // Next attempt succeeds, then hangs during shutdown so timeout kills it
    const okStart = coordinator.connectClient();
    children[1]?.emitWorkerMessage({ type: 'ready' });
    await okStart;

    // Override kill so it does not auto-emit exit until checked
    let forceKilled = false;
    if (children[1]) {
      children[1].kill = () => {
        forceKilled = true;
        children[1]?.emitExit(0);
        return true;
      };
    }
    await coordinator.shutdown();
    expect(forceKilled).toBe(true);
  });

  it('forwards optional elvServerUrl in the worker init message when configured (#511)', async () => {
    const children: FakeChild[] = [];
    const { store } = createMemorySecrets();

    const coordinator = createCatalogCoordinator({
      dbPath: '/tmp/user-data/catalog.db',
      workerPath: '/app/worker.js',
      elvServerUrl: 'https://elv-meta.example.test',
      secrets: store,
      fork: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      createChannel: () => ({ port1: 'p1', port2: 'p2' }),
      log: () => undefined,
    });

    const p = coordinator.connectClient();
    expect(children[0]?.received).toEqual([
      {
        message: {
          type: 'init',
          dbPath: '/tmp/user-data/catalog.db',
          elvServerUrl: 'https://elv-meta.example.test',
        },
        transfer: [],
      },
    ]);
    children[0]?.emitWorkerMessage({ type: 'ready' });
    await p;
    await coordinator.shutdown();
  });
});
