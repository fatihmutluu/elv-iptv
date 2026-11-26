import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FavoriteRow, SourceRow, WatchProgressRow } from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../main/catalog/worker-protocol.ts';
import type { CatalogClientMessage, CatalogWorkerMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';

class FakePortPair {
  readonly mainSide = new EventEmitter();
  readonly workerSide: WorkerClientPortLike;
  started = false;
  closed = false;

  constructor() {
    const workerEmitter = new EventEmitter();
    this.workerSide = {
      start: () => {
        this.started = true;
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        workerEmitter.emit('close');
        this.mainSide.emit('close');
      },
      postMessage: (msg: unknown) => {
        if (!this.closed) this.mainSide.emit('message', { data: msg });
      },
      on: workerEmitter.on.bind(workerEmitter),
      once: workerEmitter.once.bind(workerEmitter),
    };
    this.mainSide.on('send', (msg: unknown) => {
      if (!this.closed && this.started) {
        workerEmitter.emit('message', { data: msg });
      }
    });
  }

  sendFromClient(msg: CatalogClientMessage): void {
    this.mainSide.emit('send', msg);
  }
}

const tempDirs: string[] = [];
const activeShutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of activeShutdowns.splice(0)) await fn();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createHarness() {
  const parentEmitter = new EventEmitter();
  const secrets = new Map<string, string>();
  const parentPort: WorkerParentPortLike = {
    on: (event, listener) => {
      parentEmitter.on(event, listener);
    },
    off: (event, listener) => {
      parentEmitter.off(event, listener);
    },
    postMessage: (msg: WorkerToMainMessage) => {
      if (msg.type === 'ready') {
        parentEmitter.emit('worker-ready');
      } else if (msg.type === 'shutdown-complete') {
        parentEmitter.emit('worker-shutdown');
      } else if (msg.type === 'secret-request') {
        setImmediate(() => {
          if (msg.op === 'get') {
            sendToWorker({
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: secrets.get(msg.key) ?? null,
            });
          } else if (msg.op === 'set') {
            secrets.set(msg.key, msg.value);
            sendToWorker({ type: 'secret-reply', reqId: msg.reqId, ok: true, value: null });
          } else {
            secrets.delete(msg.key);
            sendToWorker({ type: 'secret-reply', reqId: msg.reqId, ok: true, value: null });
          }
        });
      }
    },
  };

  function sendToWorker(msg: MainToWorkerMessage, ports: WorkerClientPortLike[] = []): void {
    parentEmitter.emit('message', { data: msg, ports });
  }

  createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (filePath) => {
      mkdirSync(dirname(filePath), { recursive: true });
      return new Database(filePath);
    },
    fetchImpl: fetch as unknown as FetchLike,
    log: () => undefined,
  });

  async function init(dbPath: string): Promise<void> {
    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({ type: 'init', dbPath });
    await ready;
  }

  function connectClient(clientId: number) {
    const pair = new FakePortPair();
    sendToWorker({ type: 'client-port', clientId }, [pair.workerSide]);
    let nextReqId = 0;

    function call<T>(rpc: Extract<CatalogClientMessage, { type: 'call' }>['call']): Promise<T> {
      const reqId = ++nextReqId;
      return new Promise<T>((resolve, reject) => {
        const listener = (ev: { data: CatalogWorkerMessage }) => {
          const m = ev.data;
          if (m.reqId !== reqId || m.type === 'progress') return;
          pair.mainSide.off('message', listener);
          if (m.type === 'result') resolve(m.value as T);
          else
            reject(
              Object.assign(new Error(`${m.error.category}/${m.error.code}`), { error: m.error }),
            );
        };
        pair.mainSide.on('message', listener);
        pair.sendFromClient({ type: 'call', reqId, call: rpc });
      });
    }

    return { call };
  }

  let done: Promise<void> | undefined;
  async function shutdown(): Promise<void> {
    if (!done) {
      done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
      sendToWorker({ type: 'shutdown' });
    }
    await done;
  }

  activeShutdowns.push(shutdown);
  return { init, connectClient, shutdown };
}

describe('catalog worker runtime setFavorite IPC', () => {
  it('round-trips idempotent setFavorite upserts and deletes with title sanitization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-worker-fav-'));
    tempDirs.push(dir);
    const h = createHarness();
    await h.init(join(dir, 'catalog.db'));
    const client = h.connectClient(1);

    const added = await client.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'm3u',
        name: 'Favorites Demo',
        playlistUrl: 'http://127.0.0.1:7879/playlist.m3u',
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceId = added.value.id;

    const itemKey = `m:${sourceId}:movie:2`;
    expect(
      await client.call<Result<boolean>>({
        method: 'setFavorite',
        input: { sourceId, itemKey, kind: 'movie', title: 'Second\tFilm\r\n' },
        active: true,
      }),
    ).toEqual({ ok: true, value: true });

    expect(
      await client.call<Result<boolean>>({
        method: 'setFavorite',
        input: { sourceId, itemKey, kind: 'movie', title: 'Second\tFilm\r\n' },
        active: true,
      }),
    ).toEqual({ ok: true, value: true });

    const favs = await client.call<FavoriteRow[]>({ method: 'listFavorites', limit: 10 });
    expect(favs).toHaveLength(1);
    expect(favs[0]?.title).toBe('Second Film');

    expect(
      await client.call<Result<boolean>>({
        method: 'setFavorite',
        input: { sourceId, itemKey, kind: 'movie', title: 'Second Film' },
        active: false,
      }),
    ).toEqual({ ok: true, value: false });
    expect(
      await client.call<Result<boolean>>({
        method: 'setFavorite',
        input: { sourceId, itemKey, kind: 'movie', title: 'Second Film' },
        active: false,
      }),
    ).toEqual({ ok: true, value: false });

    expect(await client.call<string[]>({ method: 'listFavoriteKeys' })).toEqual([]);
    expect(
      await client.call({
        method: 'listSeriesUnplayedCounts',
        seriesKeys: [`m:${sourceId}:series:1`],
      }),
    ).toEqual([]);

    // Reorder favorites round-trip
    for (const [n, title] of [
      [1, 'Ch A'],
      [2, 'Ch B'],
      [3, 'Ch C'],
    ] as const) {
      await client.call<Result<boolean>>({
        method: 'setFavorite',
        input: { sourceId, itemKey: `m:${sourceId}:live:${n}`, kind: 'live', title },
        active: true,
      });
    }
    expect(
      await client.call<Result<void>>({
        method: 'reorderFavorites',
        orderedItemKeys: [`m:${sourceId}:live:3`, `m:${sourceId}:live:1`],
      }),
    ).toEqual({ ok: true, value: undefined });
    const reorderedFavs = await client.call<FavoriteRow[]>({ method: 'listFavorites', limit: 10 });
    expect(reorderedFavs.map((f) => [f.itemKey, f.sortOrder])).toEqual([
      [`m:${sourceId}:live:3`, 1],
      [`m:${sourceId}:live:1`, 2],
      [`m:${sourceId}:live:2`, 3],
    ]);

    // listWatched round-trip (movies & series)
    await client.call({
      method: 'saveProgress',
      input: {
        sourceId,
        itemKey: `m:${sourceId}:movie:w1`,
        kind: 'movie',
        title: 'Watched Film',
        positionMs: 95_000,
        durationMs: 100_000,
      },
    });
    await client.call({
      method: 'saveProgress',
      input: {
        sourceId,
        itemKey: `m:${sourceId}:series:w2`,
        kind: 'series',
        title: 'Watched Show',
        positionMs: 100_000,
        durationMs: 100_000,
        watched: true,
      },
    });
    const watchedMovies = await client.call<WatchProgressRow[]>({
      method: 'listWatched',
      limit: 10,
      opts: { kind: 'movie' },
    });
    expect(watchedMovies.map((r) => r.itemKey)).toEqual([`m:${sourceId}:movie:w1`]);
    const watchedAll = await client.call<WatchProgressRow[]>({
      method: 'listWatched',
      limit: 10,
    });
    expect(watchedAll.map((r) => r.itemKey).sort()).toEqual(
      [`m:${sourceId}:movie:w1`, `m:${sourceId}:series:w2`].sort(),
    );

    await h.shutdown();
  });
});
