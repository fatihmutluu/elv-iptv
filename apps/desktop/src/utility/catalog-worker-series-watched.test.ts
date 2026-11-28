import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SeriesUnplayedSummary, SourceRow, WatchProgressRow } from '@elv/data';
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

  let dbInstance: Database.Database | undefined;
  createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (filePath) => {
      mkdirSync(dirname(filePath), { recursive: true });
      const opened = new Database(filePath);
      if (filePath.endsWith('catalog.db')) dbInstance = opened;
      return opened;
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
  return {
    init,
    connectClient,
    shutdown,
    getDb: () => dbInstance,
  };
}

describe('catalog worker runtime setSeasonWatched & setSeriesWatched IPC', () => {
  it('round-trips transactional season and series watched mutations over MessagePort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-worker-series-watched-'));
    tempDirs.push(dir);
    const h = createHarness();
    await h.init(join(dir, 'catalog.db'));
    const client = h.connectClient(1);

    const added = await client.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'm3u',
        name: 'Series Demo',
        playlistUrl: 'http://127.0.0.1:7879/series.m3u',
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceId = added.value.id;
    const seriesKey = `m:${sourceId}:series:10`;

    const rawDb = h.getDb();
    expect(rawDb).toBeDefined();
    rawDb
      ?.prepare(
        `INSERT INTO series (source_id, key, name, name_fold, cover, run_id)
         VALUES (?, ?, 'Signal North', 'signal north', NULL, 1)`,
      )
      .run(sourceId, seriesKey);
    const insertEp = rawDb?.prepare(
      `INSERT INTO episodes (source_id, key, series_key, season, episode, title, duration_sec, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertEp?.run(sourceId, `m:${sourceId}:ep:1`, seriesKey, 1, 1, 'S1E1', 1800);
    insertEp?.run(sourceId, `m:${sourceId}:ep:2`, seriesKey, 1, 2, 'S1E2', 1800);
    insertEp?.run(sourceId, `m:${sourceId}:ep:3`, seriesKey, 2, 1, 'S2E1', 1900);

    // Mark Season 1 watched
    expect(
      await client.call<Result<number>>({
        method: 'setSeasonWatched',
        seriesKey,
        season: 1,
        watched: true,
        profileId: 'default',
      }),
    ).toEqual({ ok: true, value: 2 });

    expect(
      await client.call<SeriesUnplayedSummary[]>({
        method: 'listSeriesUnplayedCounts',
        seriesKeys: [seriesKey],
        profileId: 'default',
      }),
    ).toEqual([{ seriesKey, total: 3, unplayed: 1, watched: false }]);

    // Mark whole series watched
    expect(
      await client.call<Result<number>>({
        method: 'setSeriesWatched',
        seriesKey,
        watched: true,
        profileId: 'default',
      }),
    ).toEqual({ ok: true, value: 3 });

    expect(
      (
        await client.call<WatchProgressRow[]>({
          method: 'listWatched',
          limit: 10,
          profileId: 'default',
        })
      ).map((r) => r.itemKey),
    ).toEqual([seriesKey]);

    // Unmark Season 2 -> series no longer watched
    expect(
      await client.call<Result<number>>({
        method: 'setSeasonWatched',
        seriesKey,
        season: 2,
        watched: false,
        profileId: 'default',
      }),
    ).toEqual({ ok: true, value: 1 });

    expect(
      await client.call<WatchProgressRow[]>({
        method: 'listWatched',
        limit: 10,
        profileId: 'default',
      }),
    ).toEqual([]);

    // Unmark whole series
    expect(
      await client.call<Result<number>>({
        method: 'setSeriesWatched',
        seriesKey,
        watched: false,
        profileId: 'default',
      }),
    ).toEqual({ ok: true, value: 3 });

    expect(
      await client.call<SeriesUnplayedSummary[]>({
        method: 'listSeriesUnplayedCounts',
        seriesKeys: [seriesKey],
        profileId: 'default',
      }),
    ).toEqual([{ seriesKey, total: 3, unplayed: 3, watched: false }]);

    await h.shutdown();
  });
});
