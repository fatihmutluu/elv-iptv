import { EventEmitter } from 'node:events';
import type { ImportProgress, ImportSummary, SourceRow } from '@elv/data';
import { elvError, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_CHANNELS,
  type CatalogClientMessage,
  type CatalogDisconnectedMessage,
  type CatalogWorkerMessage,
} from '../shared/catalog-ipc.ts';
import {
  type CatalogIpcRendererLike,
  createCatalogBridge,
  type PreloadClientPortLike,
} from './catalog-bridge.ts';

class FakeRendererPort implements PreloadClientPortLike {
  private readonly listeners = new Set<(ev: { readonly data: unknown }) => void>();
  started = false;
  closed = false;
  readonly sent: CatalogClientMessage[] = [];

  addEventListener(_type: 'message', listener: (ev: { readonly data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (ev: { readonly data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(message: CatalogClientMessage): void {
    this.sent.push(message);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  deliver(message: CatalogWorkerMessage | unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data: message });
    }
  }
}

function createFakeIpcRenderer() {
  const emitter = new EventEmitter();
  const outgoing: Array<{ channel: string; args: unknown[] }> = [];

  const ipc: CatalogIpcRendererLike = {
    send(channel, ...args) {
      outgoing.push({ channel, args });
    },
    on(channel, listener) {
      emitter.on(channel, listener);
    },
    removeListener(channel, listener) {
      emitter.off(channel, listener);
    },
  };

  return {
    ipc,
    outgoing,
    deliverPort(connectId: number, port: FakeRendererPort): void {
      emitter.emit(CATALOG_CHANNELS.port, { ports: [port] }, { connectId });
    },
    deliverDisconnected(): void {
      emitter.emit(CATALOG_CHANNELS.disconnected, {}, { reason: 'worker-exited' });
    },
    deliverChanged(): void {
      emitter.emit(CATALOG_CHANNELS.changed, {});
    },
  };
}

describe('createCatalogBridge', () => {
  it('lazily requests a MessagePort, routes RPC calls, progress and cancellations, and keeps raw port private', async () => {
    const h = createFakeIpcRenderer();
    const bridge = createCatalogBridge(h.ipc);

    expect(Object.isFrozen(bridge)).toBe(true);
    expect('port' in bridge).toBe(false);
    expect(h.outgoing).toHaveLength(0);

    // Concurrent calls share one catalog:connect handshake
    const openPromise = bridge.open();
    const listPromise = bridge.listSources();
    expect(h.outgoing).toEqual([{ channel: CATALOG_CHANNELS.connect, args: [{ connectId: 1 }] }]);

    // Stale connectId is ignored
    const stalePort = new FakeRendererPort();
    h.deliverPort(999, stalePort);
    expect(stalePort.closed).toBe(true);

    const port = new FakeRendererPort();
    h.deliverPort(1, port);
    expect(port.started).toBe(true);

    // Wait a microtask for queued RPC sends
    await Promise.resolve();
    expect(port.sent).toEqual([
      { type: 'call', reqId: 1, call: { method: 'ping' } },
      { type: 'call', reqId: 2, call: { method: 'listSources' } },
    ]);

    port.deliver({ type: 'result', reqId: 1, value: ok(undefined) });
    port.deliver({
      type: 'result',
      reqId: 2,
      value: [
        { id: 's1', kind: 'm3u', name: 'One', createdAt: 1, needsImport: true },
      ] satisfies SourceRow[],
    });

    expect(await openPromise).toEqual({ ok: true, value: undefined });
    expect(await listPromise).toEqual([
      { id: 's1', kind: 'm3u', name: 'One', createdAt: 1, needsImport: true },
    ]);

    // Import progress + throwing callback isolation + mid-flight cancelImport
    const progresses: ImportProgress[] = [];
    const imp = bridge.startImport('s1', {
      batchSize: 250,
      onProgress: (p) => {
        progresses.push(p);
        if (p.done === 10) throw new Error('ui callback bug');
      },
    });
    await Promise.resolve();
    expect(port.sent.at(-1)).toEqual({
      type: 'call',
      reqId: imp.reqId,
      call: { method: 'importSource', id: 's1', batchSize: 250, progress: true },
    });

    port.deliver({ type: 'progress', reqId: imp.reqId, progress: { phase: 'live', done: 10 } });
    port.deliver({
      type: 'progress',
      reqId: imp.reqId,
      progress: { phase: 'live', done: 20, total: 50 },
    });
    expect(progresses).toEqual([
      { phase: 'live', done: 10 },
      { phase: 'live', done: 20, total: 50 },
    ]);

    bridge.cancelImport(imp.reqId);
    expect(port.sent.at(-1)).toEqual({ type: 'cancel', reqId: imp.reqId });

    const summary: Result<ImportSummary> = {
      ok: false,
      error: elvError('network', 'aborted'),
    };
    port.deliver({ type: 'result', reqId: imp.reqId, value: summary });
    expect(await imp.result).toEqual(summary);

    // Exercise remaining CatalogBridge methods
    const catsP = bridge.categories('s1', 'live');
    const itemsP = bridge.items('c1', 0, 20);
    const detailP = bridge.itemDetail('m:s1:1');
    const searchP = bridge.search('horizon', { scope: 'movie', limit: 10 });
    const seasonsP = bridge.seasons(10);
    const episodesP = bridge.episodes(10, 1);
    const streamP = bridge.resolveStream('m:s1:key');
    const addP = bridge.addSource({
      kind: 'm3u',
      name: 'M',
      playlistUrl: 'http://list.example/a.m3u',
    });
    const linkP = bridge.addSourceFromLink({ name: 'L', url: 'http://list.example/b.m3u' });
    const rmP = bridge.removeSource('s1');
    const saveProgP = bridge.saveProgress({
      sourceId: 's1',
      itemKey: 'm:s1:1',
      kind: 'movie',
      title: 'Silent Horizon',
      positionMs: 25_000,
      durationMs: 100_000,
    });
    const setWatP = bridge.setWatched('m:s1:1', true);
    const getProgP = bridge.getProgress('m:s1:1');
    const cwP = bridge.listContinueWatching(12);
    const byKeysP = bridge.listProgressByKeys(['m:s1:1']);
    const clearProgP = bridge.clearProgress('m:s1:1');
    const togFavP = bridge.toggleFavorite({
      sourceId: 's1',
      itemKey: 'm:s1:1',
      kind: 'movie',
      title: 'Silent Horizon',
    });
    const setFavP = bridge.setFavorite(
      {
        sourceId: 's1',
        itemKey: 'm:s1:1',
        kind: 'movie',
        title: 'Silent Horizon',
      },
      true,
    );
    const favsP = bridge.listFavorites(20);
    const favKeysP = bridge.listFavoriteKeys();
    const guideP = bridge.importGuide('s1');
    const nowNextP = bridge.nowNext(['x:s1:live:1'], 1_700_000_000_000);
    const epgWinP = bridge.epgWindow(['x:s1:live:1'], 1_700_000_000_000, 1_700_010_800_000);
    const chNumP = bridge.channelByNumber(101, 's1');
    await Promise.resolve();

    for (const msg of port.sent.slice(4)) {
      if (msg.type === 'call') {
        const val =
          msg.call.method === 'categories' ||
          msg.call.method === 'items' ||
          msg.call.method === 'episodes' ||
          msg.call.method === 'listContinueWatching' ||
          msg.call.method === 'listProgressByKeys' ||
          msg.call.method === 'listFavorites' ||
          msg.call.method === 'listFavoriteKeys' ||
          msg.call.method === 'nowNext'
            ? []
            : msg.call.method === 'getProgress' ||
                msg.call.method === 'itemDetail' ||
                msg.call.method === 'channelByNumber'
              ? null
              : msg.call.method === 'search'
                ? { live: [], movies: [], series: [] }
                : msg.call.method === 'epgWindow'
                  ? {}
                  : ok(undefined);
        port.deliver({ type: 'result', reqId: msg.reqId, value: val });
      }
    }
    expect(await catsP).toEqual([]);
    expect(await itemsP).toEqual([]);
    expect(await detailP).toBeNull();
    expect(await searchP).toEqual({ live: [], movies: [], series: [] });
    expect((await seasonsP).ok).toBe(true);
    expect(await episodesP).toEqual([]);
    expect((await streamP).ok).toBe(true);
    expect((await addP).ok).toBe(true);
    expect((await linkP).ok).toBe(true);
    expect((await rmP).ok).toBe(true);
    expect((await saveProgP).ok).toBe(true);
    expect((await setWatP).ok).toBe(true);
    expect(await getProgP).toBeNull();
    expect(await cwP).toEqual([]);
    expect(await byKeysP).toEqual([]);
    expect((await clearProgP).ok).toBe(true);
    expect((await togFavP).ok).toBe(true);
    expect((await setFavP).ok).toBe(true);
    expect(await favsP).toEqual([]);
    expect(await favKeysP).toEqual([]);
    expect((await guideP).ok).toBe(true);
    expect(await nowNextP).toEqual([]);
    expect(await epgWinP).toEqual({});
    expect(await chNumP).toBeNull();

    await bridge.close();
    expect(port.closed).toBe(true);

    let changedCount = 0;
    const offChanged = bridge.onChanged(() => {
      changedCount += 1;
    });
    h.deliverChanged();
    expect(changedCount).toBe(1);
    offChanged();
    h.deliverChanged();
    expect(changedCount).toBe(1);
  });

  it('settles in-flight calls on worker crash or fault and reconnects on the next call', async () => {
    const h = createFakeIpcRenderer();
    const bridge = createCatalogBridge(h.ipc);

    // Pre-connect cancelImport settles immediately without sending importSource
    const preCancelled = bridge.startImport('s1');
    bridge.cancelImport(preCancelled.reqId);
    expect(await preCancelled.result).toEqual({
      ok: false,
      error: { category: 'network', code: 'aborted' },
    });

    const port1 = new FakeRendererPort();
    h.deliverPort(1, port1);
    await Promise.resolve();
    expect(port1.sent).toEqual([]);

    // Fault on Result-returning open() resolves to err(error); fault on listSources() rejects
    const openFault = bridge.open();
    const listFault = bridge.listSources();
    await Promise.resolve();
    port1.deliver({
      type: 'fault',
      reqId: port1.sent[0]?.reqId,
      error: elvError('storage', 'schema-too-new'),
    });
    port1.deliver({
      type: 'fault',
      reqId: port1.sent[1]?.reqId,
      error: elvError('storage', 'sql-failed'),
    });

    expect(await openFault).toEqual({
      ok: false,
      error: { category: 'storage', code: 'schema-too-new' },
    });
    await expect(listFault).rejects.toThrow(/storage\/sql-failed/);

    // Simulate worker crash while calls are in flight
    const crashedImport = bridge.startImport('s1');
    const crashedList = bridge.listSources();
    await Promise.resolve();

    h.deliverDisconnected();
    expect(await crashedImport.result).toEqual({
      ok: false,
      error: { category: 'storage', code: 'worker-exited' },
    });
    await expect(crashedList).rejects.toThrow(/storage\/worker-exited/);

    // Subsequent call requests a fresh port (connectId: 2)
    const reopen = bridge.open();
    expect(h.outgoing.at(-1)).toEqual({
      channel: CATALOG_CHANNELS.connect,
      args: [{ connectId: 2 }],
    });
    const port2 = new FakeRendererPort();
    h.deliverPort(2, port2);
    await Promise.resolve();
    port2.deliver({ type: 'result', reqId: port2.sent[0]?.reqId, value: ok(undefined) });
    expect(await reopen).toEqual({ ok: true, value: undefined });
  });

  it('rejects or settles invalid outbound RPC arguments immediately without opening a port or hanging', async () => {
    const h = createFakeIpcRenderer();
    const bridge = createCatalogBridge(h.ipc);

    expect(await bridge.seasons(1.5)).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-request' },
    });
    expect(await bridge.startImport('s1', { batchSize: 0 }).result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-request' },
    });
    await expect(bridge.items('cat', Number.NaN, 10)).rejects.toThrow(
      /source-format\/invalid-request/,
    );
    await expect(bridge.itemDetail('')).rejects.toThrow(/source-format\/invalid-request/);
    await expect(bridge.itemDetail('bad\nkey')).rejects.toThrow(/source-format\/invalid-request/);
    await expect(bridge.search('bad\nquery')).rejects.toThrow(/source-format\/invalid-request/);
    await expect(bridge.search('ok', { limit: 61 })).rejects.toThrow(
      /source-format\/invalid-request/,
    );
    await expect(bridge.listContinueWatching(101)).rejects.toThrow(
      /source-format\/invalid-request/,
    );
    expect(
      await bridge.saveProgress({
        sourceId: 's1',
        itemKey: 'k1',
        kind: 'movie',
        title: 'Bad',
        positionMs: -10,
        durationMs: 100,
      }),
    ).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-request' },
    });
    expect(await bridge.importGuide('')).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-request' },
    });
    await expect(bridge.nowNext(['x:s1:live:1'], -1)).rejects.toThrow(
      /source-format\/invalid-request/,
    );
    await expect(
      bridge.epgWindow(
        Array.from({ length: 41 }, (_, i) => `x:s1:live:${i}`),
        1000,
        2000,
      ),
    ).rejects.toThrow(/source-format\/invalid-request/);
    await expect(bridge.channelByNumber(-5)).rejects.toThrow(/source-format\/invalid-request/);
    expect(h.outgoing).toHaveLength(0);
  });

  it('notifies onDisconnected listeners only on unexpected worker exits, isolates throwing listeners, and supports idempotent unsubscribe (#435)', async () => {
    const h = createFakeIpcRenderer();
    const bridge = createCatalogBridge(h.ipc);

    const openP = bridge.open();
    const port = new FakeRendererPort();
    h.deliverPort(1, port);
    await Promise.resolve();
    port.deliver({ type: 'result', reqId: 1, value: ok(undefined) });
    expect(await openP).toEqual({ ok: true, value: undefined });

    const seenA: CatalogDisconnectedMessage[] = [];
    const seenB: CatalogDisconnectedMessage[] = [];
    const offA = bridge.onDisconnected((msg) => {
      seenA.push(msg);
      throw new Error('renderer disconnect handler failure');
    });
    const offB = bridge.onDisconnected((msg) => {
      seenB.push(msg);
    });

    // Intentional close must NOT notify onDisconnected
    await bridge.close();
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);

    // Reopen and simulate unexpected worker exit
    const open2 = bridge.open();
    const port2 = new FakeRendererPort();
    h.deliverPort(2, port2);
    await Promise.resolve();
    port2.deliver({ type: 'result', reqId: 2, value: ok(undefined) });
    expect(await open2).toEqual({ ok: true, value: undefined });

    h.deliverDisconnected();
    expect(port2.closed).toBe(true);
    expect(seenA).toEqual([{ reason: 'worker-exited' }]);
    expect(seenB).toEqual([{ reason: 'worker-exited' }]);

    // Unsubscribe is idempotent and stops further delivery for removed listener only
    offA();
    offA();
    h.deliverDisconnected();
    expect(seenA).toHaveLength(1);
    expect(seenB).toEqual([{ reason: 'worker-exited' }, { reason: 'worker-exited' }]);

    offB();
    h.deliverDisconnected();
    expect(seenB).toHaveLength(2);
  });
});
