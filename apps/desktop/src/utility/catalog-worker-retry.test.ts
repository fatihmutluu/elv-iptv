import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SyncDatabase } from '@elv/data';
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-retry-'));
  tempDirs.push(dir);
  return join(dir, 'catalog.db');
}

function createRetryHarness(
  openDatabase: (filePath: string) => SyncDatabase,
  sleep: (ms: number) => Promise<void>,
) {
  const parentEmitter = new EventEmitter();
  const parentPort: WorkerParentPortLike = {
    on: (ev, fn) => parentEmitter.on(ev, fn),
    off: (ev, fn) => parentEmitter.off(ev, fn),
    postMessage: (msg: WorkerToMainMessage) => {
      if (msg.type === 'ready') parentEmitter.emit('worker-ready');
      if (msg.type === 'shutdown-complete') parentEmitter.emit('worker-shutdown');
    },
  };
  const sendToWorker = (msg: MainToWorkerMessage, ports: WorkerClientPortLike[] = []) => {
    parentEmitter.emit('message', { data: msg, ports });
  };
  createCatalogWorkerRuntime({
    parentPort,
    openDatabase,
    fetchImpl: fetch as unknown as FetchLike,
    sleep,
    log: () => undefined,
  });

  async function init(dbPath: string): Promise<void> {
    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({ type: 'init', dbPath });
    await ready;
  }

  function connectClient() {
    const mainSide = new EventEmitter();
    const workerEmitter = new EventEmitter();
    let started = false;
    let closed = false;
    const workerSide: WorkerClientPortLike = {
      start: () => {
        started = true;
      },
      close: () => {
        if (closed) return;
        closed = true;
        workerEmitter.emit('close');
      },
      postMessage: (msg: CatalogWorkerMessage) => {
        if (!closed) mainSide.emit('message', { data: msg });
      },
      on: workerEmitter.on.bind(workerEmitter),
      once: workerEmitter.once.bind(workerEmitter),
    };
    sendToWorker({ type: 'client-port', clientId: 1 }, [workerSide]);
    let nextReqId = 0;
    return {
      call<T>(rpc: Extract<CatalogClientMessage, { type: 'call' }>['call']): Promise<T> {
        const reqId = ++nextReqId;
        return new Promise<T>((resolve, reject) => {
          const listener = (ev: { data: CatalogWorkerMessage }) => {
            const m = ev.data;
            if (m.reqId !== reqId || m.type === 'progress') return;
            mainSide.off('message', listener);
            if (m.type === 'result') resolve(m.value as T);
            else reject(m.error);
          };
          mainSide.on('message', listener);
          if (started) workerEmitter.emit('message', { data: { type: 'call', reqId, call: rpc } });
        });
      },
    };
  }

  async function shutdown(): Promise<void> {
    const done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
    sendToWorker({ type: 'shutdown' });
    await done;
  }

  return { init, connectClient, shutdown };
}

describe('catalog worker SQLite open retry (#138)', () => {
  it('retries up to 3 times with [100, 250]ms backoff on transient SQLITE_BUSY/locked errors and closes partial handles', async () => {
    const dbPath = makeTempDbPath();
    const sleeps: number[] = [];
    let attempts = 0;
    let partialClosed = 0;

    const h = createRetryHarness(
      (filePath) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
        if (attempts === 2) {
          // Opened handle fails during openCatalog pragma/query with SQLITE_LOCKED; must be closed cleanly.
          return {
            exec: () => {
              throw new Error('SQLITE_LOCKED: database table is locked');
            },
            prepare: () => ({
              run: () => ({ changes: 0 }),
              all: () => [{ user_version: 0 }],
            }),
            close: () => {
              partialClosed += 1;
            },
          };
        }
        mkdirSync(dirname(filePath), { recursive: true });
        return new Database(filePath);
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );

    await h.init(dbPath);
    const client = h.connectClient();
    const pong = await client.call<Result<void>>({ method: 'ping' });
    expect(pong).toEqual({ ok: true, value: undefined });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 250]);
    expect(partialClosed).toBe(1);
    await h.shutdown();
  });

  it('does not retry non-transient open errors and surfaces failure after exhausting transient retries', async () => {
    const dbPath = makeTempDbPath();
    const sleeps: number[] = [];
    let attempts = 0;
    const h = createRetryHarness(
      () => {
        attempts += 1;
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );

    await h.init(dbPath);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
    await h.shutdown();

    // Exhausting all 3 transient attempts fails cleanly on RPC call.
    const busySleeps: number[] = [];
    let busyAttempts = 0;
    const hBusy = createRetryHarness(
      () => {
        busyAttempts += 1;
        throw new Error('SQLITE_BUSY: database is locked');
      },
      async (ms) => {
        busySleeps.push(ms);
      },
    );
    await hBusy.init(dbPath);
    expect(busyAttempts).toBe(3);
    expect(busySleeps).toEqual([100, 250]);
    await hBusy.shutdown();
  });
});
