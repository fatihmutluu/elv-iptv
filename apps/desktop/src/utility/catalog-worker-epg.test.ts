import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ImportSummary, ItemRow, NowNextEntry, ProgrammeRow, SourceRow } from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../main/catalog/worker-protocol.ts';
import type { CatalogClientMessage, CatalogWorkerMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';
import { createNodeGzipDecompressor } from './node-gzip-decompressor.ts';

const SYNTH_M3U_VAL = ['m3u', 'Epg', '7a6b5c4d'].join('_');

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

let server: Server | undefined;
let baseUrl = '';
const tempDirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/epg-playlist.m3u') {
      const body = [
        '#EXTM3U',
        `#EXTINF:-1 tvg-id="cinema.1" tvg-chno="101" tvg-logo="http://cdn.example/101.png?token=${SYNTH_M3U_VAL}" group-title="Cinema",Cinema 101`,
        `http://stream.example/live/${SYNTH_M3U_VAL}/101.ts`,
        '',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.url === '/guide.xml') {
      const body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<tv>',
        '  <channel id="cinema.1"><display-name>Cinema 101</display-name></channel>',
        '  <programme start="20260615113000 +0000" stop="20260615123000 +0000" channel="cinema.1">',
        '    <title>Midday Feature</title>',
        '    <desc>A synthetic midday film.</desc>',
        '  </programme>',
        '  <programme start="20260615123000 +0000" stop="20260615133000 +0000" channel="cinema.1">',
        '    <title>Afternoon Encore</title>',
        '  </programme>',
        '</tv>',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.url === '/guide.xml.gz') {
      const part1 = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<tv>',
        '  <channel id="cinema.1"><display-name>Cinema 101</display-name></channel>',
        '  <programme start="20260615113000 +0000" stop="20260615123000 +0000" channel="cinema.1">',
        '    <title>Gzip Member One</title>',
        '  </programme>',
      ].join('\n');
      const part2 = [
        '  <programme start="20260615123000 +0000" stop="20260615133000 +0000" channel="cinema.1">',
        '    <title>Gzip Member Two</title>',
        '  </programme>',
        '</tv>',
      ].join('\n');
      const combined = Buffer.concat([gzipSync(Buffer.from(part1)), gzipSync(Buffer.from(part2))]);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(combined);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FIXED_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

function createFakeParentPort(): {
  parentEmitter: EventEmitter;
  sendToWorker: (msg: MainToWorkerMessage, ports?: WorkerClientPortLike[]) => void;
  parentPort: WorkerParentPortLike;
} {
  const parentEmitter = new EventEmitter();
  const secrets = new Map<string, string>();
  const sendToWorker = (msg: MainToWorkerMessage, ports: WorkerClientPortLike[] = []): void => {
    parentEmitter.emit('message', { data: msg, ports });
  };
  const parentPort: WorkerParentPortLike = {
    on: (event, listener) => parentEmitter.on(event, listener),
    off: (event, listener) => parentEmitter.off(event, listener),
    postMessage: (msg: WorkerToMainMessage) => {
      if (msg.type === 'ready') parentEmitter.emit('worker-ready');
      else if (msg.type === 'shutdown-complete') parentEmitter.emit('worker-shutdown');
      else if (msg.type === 'secret-request') {
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
  return { parentEmitter, sendToWorker, parentPort };
}

describe('catalog worker EPG & channelByNumber RPCs', () => {
  it('handles importGuide (with WAL checkpoint), nowNext, epgWindow, and channelByNumber over MessagePort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-worker-epg-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'catalog.sqlite');
    const fixedNow = FIXED_NOW;
    const { parentEmitter, sendToWorker, parentPort } = createFakeParentPort();

    const dispose = createCatalogWorkerRuntime({
      parentPort,
      openDatabase: (filePath) => {
        mkdirSync(dirname(filePath), { recursive: true });
        return new Database(filePath);
      },
      fetchImpl: fetch as unknown as FetchLike,
      clock: () => fixedNow,
    });

    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({ type: 'init', dbPath });
    await ready;

    const pair = new FakePortPair();
    sendToWorker({ type: 'client-port', clientId: 1 }, [pair.workerSide]);

    let nextReq = 0;
    const call = <T>(rpc: Extract<CatalogClientMessage, { type: 'call' }>['call']): Promise<T> => {
      const reqId = ++nextReq;
      return new Promise<T>((resolve, reject) => {
        const listener = (ev: { data: CatalogWorkerMessage }) => {
          const m = ev.data;
          if (m.reqId !== reqId || m.type === 'progress') return;
          pair.mainSide.off('message', listener);
          if (m.type === 'result') resolve(m.value as T);
          else reject(new Error(`${m.error.category}/${m.error.code}`));
        };
        pair.mainSide.on('message', listener);
        pair.sendFromClient({ type: 'call', reqId, call: rpc });
      });
    };

    const added = await call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'm3u',
        name: 'EPG List',
        playlistUrl: `${baseUrl}/epg-playlist.m3u`,
        guideUrl: `${baseUrl}/guide.xml`,
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceId = added.value.id;

    expect((await call<Result<ImportSummary>>({ method: 'importSource', id: sourceId })).ok).toBe(
      true,
    );
    const guideRes = await call<Result<ImportSummary>>({ method: 'importGuide', id: sourceId });
    expect(guideRes.ok).toBe(true);

    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) expect(statSync(walPath).size).toBe(0);

    const ch = await call<ItemRow | null>({ method: 'channelByNumber', num: 101, sourceId });
    expect(ch).toMatchObject({ num: 101, name: 'Cinema 101' });
    expect(ch?.logo).toContain(SYNTH_M3U_VAL);

    const chKey = ch?.key ?? '';
    const nn = await call<NowNextEntry[]>({
      method: 'nowNext',
      channelKeys: [chKey],
      nowMs: fixedNow,
    });
    expect(nn).toHaveLength(1);
    expect(nn[0]?.now?.title).toBe('Midday Feature');
    expect(nn[0]?.next?.title).toBe('Afternoon Encore');

    const win = await call<Record<string, ProgrammeRow[]>>({
      method: 'epgWindow',
      channelKeys: [chKey],
      fromMs: fixedNow - 30 * 60_000,
      toMs: fixedNow + 90 * 60_000,
    });
    expect(win[chKey]?.map((p) => p.title)).toEqual(['Midday Feature', 'Afternoon Encore']);

    const done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
    sendToWorker({ type: 'shutdown' });
    await done;
    dispose();
  });

  it('aborts an in-flight importGuide immediately on worker shutdown instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-worker-epg-abort-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'catalog.db');

    let guideFetchStarted!: () => void;
    const guideStartedP = new Promise<void>((resolve) => {
      guideFetchStarted = resolve;
    });
    let guideAborted = false;

    const customFetch: FetchLike = async (url, init) => {
      if (url.endsWith('/slow-guide.xml')) {
        guideFetchStarted();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            guideAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return fetch(url, init as RequestInit) as ReturnType<FetchLike>;
    };

    const { parentPort, sendToWorker, parentEmitter } = createFakeParentPort();
    const dispose = createCatalogWorkerRuntime({
      parentPort,
      openDatabase: (filePath) => {
        mkdirSync(dirname(filePath), { recursive: true });
        return new Database(filePath);
      },
      fetchImpl: customFetch,
      clock: () => FIXED_NOW,
    });

    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({ type: 'init', dbPath });
    await ready;

    const pair = new FakePortPair();
    sendToWorker({ type: 'client-port', clientId: 1 }, [pair.workerSide]);

    const addPromise = new Promise<Result<SourceRow>>((resolve) => {
      const listener = (ev: { data: CatalogWorkerMessage }) => {
        if (ev.data.reqId === 1 && ev.data.type === 'result') {
          pair.mainSide.off('message', listener);
          resolve(ev.data.value as Result<SourceRow>);
        }
      };
      pair.mainSide.on('message', listener);
      pair.sendFromClient({
        type: 'call',
        reqId: 1,
        call: {
          method: 'addSource',
          input: {
            kind: 'm3u',
            name: 'Slow Guide',
            playlistUrl: `${baseUrl}/epg-playlist.m3u`,
            guideUrl: `${baseUrl}/slow-guide.xml`,
          },
        },
      });
    });
    const added = await addPromise;
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    pair.sendFromClient({
      type: 'call',
      reqId: 2,
      call: { method: 'importGuide', id: added.value.id },
    });
    await guideStartedP;

    const done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
    sendToWorker({ type: 'shutdown' });
    await done;
    expect(guideAborted).toBe(true);
    dispose();
  });

  it('imports a real 2-member concatenated .xml.gz guide via the Node zlib decompressor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-worker-epg-gz-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'catalog.sqlite');
    const fixedNow = FIXED_NOW;
    const { parentEmitter, sendToWorker, parentPort } = createFakeParentPort();

    const dispose = createCatalogWorkerRuntime({
      parentPort,
      openDatabase: (filePath) => {
        mkdirSync(dirname(filePath), { recursive: true });
        return new Database(filePath);
      },
      fetchImpl: fetch as unknown as FetchLike,
      decompressor: createNodeGzipDecompressor(),
      clock: () => fixedNow,
    });

    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({ type: 'init', dbPath });
    await ready;

    const pair = new FakePortPair();
    sendToWorker({ type: 'client-port', clientId: 1 }, [pair.workerSide]);

    let nextReq = 0;
    const call = <T>(rpc: Extract<CatalogClientMessage, { type: 'call' }>['call']): Promise<T> => {
      const reqId = ++nextReq;
      return new Promise<T>((resolve, reject) => {
        const listener = (ev: { data: CatalogWorkerMessage }) => {
          const m = ev.data;
          if (m.reqId !== reqId || m.type === 'progress') return;
          pair.mainSide.off('message', listener);
          if (m.type === 'result') resolve(m.value as T);
          else reject(new Error(`${m.error.category}/${m.error.code}`));
        };
        pair.mainSide.on('message', listener);
        pair.sendFromClient({ type: 'call', reqId, call: rpc });
      });
    };

    const added = await call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'm3u',
        name: 'Gzip EPG List',
        playlistUrl: `${baseUrl}/epg-playlist.m3u`,
        guideUrl: `${baseUrl}/guide.xml.gz`,
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sourceId = added.value.id;

    expect((await call<Result<ImportSummary>>({ method: 'importSource', id: sourceId })).ok).toBe(
      true,
    );
    const guideRes = await call<Result<ImportSummary>>({ method: 'importGuide', id: sourceId });
    expect(guideRes.ok).toBe(true);

    const ch = await call<ItemRow | null>({ method: 'channelByNumber', num: 101, sourceId });
    const chKey = ch?.key ?? '';
    const nn = await call<NowNextEntry[]>({
      method: 'nowNext',
      channelKeys: [chKey],
      nowMs: fixedNow,
    });
    expect(nn).toHaveLength(1);
    expect(nn[0]?.now?.title).toBe('Gzip Member One');
    expect(nn[0]?.next?.title).toBe('Gzip Member Two');

    const done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
    sendToWorker({ type: 'shutdown' });
    await done;
    dispose();
  });

  it('cancels upstream cleanly on early consumer return() from createNodeGzipDecompressor', async () => {
    const decompressor = createNodeGzipDecompressor();
    const bigPayload = gzipSync(Buffer.alloc(256 * 1024, 0x41));
    let upstreamClosed = false;
    let resolvePending: ((r: IteratorResult<Uint8Array>) => void) | undefined;
    let emitted = false;
    const pendingBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (!emitted) {
              emitted = true;
              return Promise.resolve({ done: false, value: bigPayload });
            }
            return new Promise<IteratorResult<Uint8Array>>((resolve) => {
              resolvePending = resolve;
            });
          },
          return() {
            upstreamClosed = true;
            resolvePending?.({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const it = decompressor.gunzip(pendingBody)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value.length).toBeGreaterThan(0);
    await it.return?.();
    expect(upstreamClosed).toBe(true);
  });

  it('handles backpressure and propagates upstream errors in createNodeGzipDecompressor', async () => {
    const decompressor = createNodeGzipDecompressor();
    const raw = Buffer.alloc(128 * 1024);
    let seed = 1;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[i] = (seed >>> 24) & 0xff;
    }
    const zipped = gzipSync(raw);
    async function* chunked(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < zipped.length; i += 32 * 1024) {
        yield zipped.subarray(i, i + 32 * 1024);
      }
    }
    let total = 0;
    for await (const out of decompressor.gunzip(chunked())) total += out.length;
    expect(total).toBe(raw.length);

    async function* failing(): AsyncGenerator<Uint8Array> {
      yield zipped.subarray(0, 16);
      throw new Error('upstream boom');
    }
    await expect(async () => {
      for await (const _ of decompressor.gunzip(failing())) {
        // drain until upstream fails
      }
    }).rejects.toThrow('upstream boom');
  });
});
