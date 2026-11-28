import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceRow, StreamRequest } from '@elv/data';
import type { ElvError, FetchLike, Result } from '@elv/domain';
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
  for (const shutdown of activeShutdowns.splice(0)) await shutdown();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('catalog-worker-runtime secret-key-rotated propagation', () => {
  it('maps storage/secret-key-rotated from main to storage/secret-key-rotated on importSource, resolveStream, and parental PIN checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-worker-rot-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'catalog.db');

    const parentEmitter = new EventEmitter();
    const secrets = new Map<string, string>();
    let rotateGet = false;

    const sendToWorker = (msg: MainToWorkerMessage, ports: WorkerClientPortLike[] = []): void => {
      parentEmitter.emit('message', { data: msg, ports });
    };

    const parentPort: WorkerParentPortLike = {
      on: (event, listener) => parentEmitter.on(event, listener),
      off: (event, listener) => parentEmitter.off(event, listener),
      postMessage: (msg: WorkerToMainMessage) => {
        if (msg.type === 'ready') {
          parentEmitter.emit('worker-ready');
          return;
        }
        if (msg.type === 'shutdown-complete') {
          parentEmitter.emit('worker-shutdown');
          return;
        }
        if (msg.type === 'secret-request') {
          setImmediate(() => {
            if (msg.op === 'get') {
              if (rotateGet && secrets.has(msg.key)) {
                sendToWorker({
                  type: 'secret-reply',
                  reqId: msg.reqId,
                  ok: false,
                  message: 'storage/secret-key-rotated',
                });
                return;
              }
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

    const fetchStub: FetchLike = async (url) => {
      let bodyText = '#EXTM3U\n#EXTINF:-1,One\nhttp://cdn.example/tok1/1.ts\n';
      if (url.includes('player_api.php')) {
        if (url.includes('action=get_live_categories')) {
          bodyText = JSON.stringify([{ category_id: '1', category_name: 'News' }]);
        } else if (url.includes('action=get_live_streams')) {
          bodyText = JSON.stringify([
            { num: 1, name: 'Xt Channel', stream_type: 'live', stream_id: 10, category_id: '1' },
          ]);
        } else if (url.includes('action=')) {
          bodyText = '[]';
        } else {
          bodyText = JSON.stringify({
            user_info: { status: 'Active', auth: 1, allowed_output_formats: ['ts'] },
            server_info: { url: 'panel.example', port: '8080', server_protocol: 'http' },
          });
        }
      }
      return {
        status: 200,
        headers: { forEach: () => undefined, get: () => null },
        body: (async function* () {
          yield new TextEncoder().encode(bodyText);
        })(),
      };
    };

    createCatalogWorkerRuntime({
      parentPort,
      openDatabase: (filePath) => {
        mkdirSync(dirname(filePath), { recursive: true });
        return new Database(filePath);
      },
      fetchImpl: fetchStub,
      log: () => undefined,
    });

    let shutDownDone = false;
    const shutdown = async (): Promise<void> => {
      if (shutDownDone) return;
      shutDownDone = true;
      const done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
      sendToWorker({ type: 'shutdown' });
      await done;
    };
    activeShutdowns.push(shutdown);

    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({ type: 'init', dbPath });
    await ready;

    const pair = new FakePortPair();
    sendToWorker({ type: 'client-port', clientId: 1 }, [pair.workerSide]);
    let seq = 0;
    const call = <T>(rpc: Extract<CatalogClientMessage, { type: 'call' }>['call']): Promise<T> => {
      const reqId = ++seq;
      return new Promise<T>((resolve, reject) => {
        const onMsg = (ev: { data: CatalogWorkerMessage }) => {
          if (ev.data.reqId !== reqId || ev.data.type === 'progress') return;
          pair.mainSide.off('message', onMsg);
          if (ev.data.type === 'result') resolve(ev.data.value as T);
          else reject(Object.assign(new Error(ev.data.error.code), { error: ev.data.error }));
        };
        pair.mainSide.on('message', onMsg);
        pair.sendFromClient({ type: 'call', reqId, call: rpc });
      });
    };

    // Seed an M3U source and a parental PIN while key is healthy
    const added = await call<Result<SourceRow>>({
      method: 'addSource',
      input: { kind: 'm3u', name: 'Demo', playlistUrl: 'http://cdn.example/list.m3u' },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceId = added.value.id;

    const imported = await call<Result<unknown>>({ method: 'importSource', id: sourceId });
    expect(imported.ok).toBe(true);
    const cats = await call<Array<{ id: string }>>({
      method: 'categories',
      sourceId,
      kind: 'live',
    });
    const items = await call<Array<{ key: string }>>({
      method: 'items',
      categoryId: cats[0]?.id ?? '',
      offset: 0,
      limit: 5,
    });
    const itemKey = items[0]?.key ?? '';
    expect(itemKey).toBeTruthy();

    const pinSet = await call<Result<void>>({ method: 'setParentalPin', pin: '1234' });
    expect(pinSet.ok).toBe(true);

    // Simulate OS key rotation (e.g., Windows safeStorage Local State key loss)
    rotateGet = true;

    // 1. importSource surfaces storage/secret-key-rotated instead of secret-missing
    const reImport = await call<Result<unknown>>({ method: 'importSource', id: sourceId });
    expect(reImport).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-key-rotated' },
    });

    // 2. Direct secret-reading calls (hasParentalPin) emit structured storage/secret-key-rotated fault
    await expect(call<boolean>({ method: 'hasParentalPin' })).rejects.toMatchObject({
      error: { category: 'storage', code: 'secret-key-rotated' } satisfies Partial<ElvError>,
    });

    // 3. Seed an Xtream source while healthy, then simulate rotation and check both importSource and resolveStream
    rotateGet = false;
    const xtreamAdded = await call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'xtream',
        name: 'Xt',
        server: 'http://panel.example:8080',
        username: 'u',
        password: 'p',
      },
    });
    expect(xtreamAdded.ok).toBe(true);
    if (!xtreamAdded.ok) return;
    const xtreamSeeded = await call<Result<unknown>>({
      method: 'importSource',
      id: xtreamAdded.value.id,
    });
    expect(xtreamSeeded.ok).toBe(true);
    const xtCats = await call<Array<{ id: string }>>({
      method: 'categories',
      sourceId: xtreamAdded.value.id,
      kind: 'live',
    });
    const xtItems = await call<Array<{ key: string }>>({
      method: 'items',
      categoryId: xtCats[0]?.id ?? '',
      offset: 0,
      limit: 5,
    });
    const xtItemKey = xtItems[0]?.key ?? '';
    expect(xtItemKey).toBeTruthy();

    rotateGet = true;
    const xtreamImport = await call<Result<unknown>>({
      method: 'importSource',
      id: xtreamAdded.value.id,
    });
    expect(xtreamImport).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-key-rotated' },
    });

    const resolved = await call<Result<StreamRequest>>({
      method: 'resolveStream',
      itemKey: xtItemKey,
    });
    expect(resolved).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-key-rotated' },
    });

    // 4. Genuine missing secret (key deleted, not rotated) still returns storage/secret-missing
    rotateGet = false;
    secrets.delete(`source.${sourceId}.playlist`);
    const missingImport = await call<Result<unknown>>({ method: 'importSource', id: sourceId });
    expect(missingImport).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-missing' },
    });

    await shutdown();
  });
});
