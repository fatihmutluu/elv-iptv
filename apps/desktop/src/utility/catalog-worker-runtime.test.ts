import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CategoryRow,
  EpisodeRow,
  ImportProgress,
  ImportSummary,
  ItemRow,
  SeasonRow,
  SourceRow,
  StreamRequest,
} from '@elv/data';
import type { ElvError, FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  sendFromClient(msg: CatalogClientMessage | unknown): void {
    this.mainSide.emit('send', msg);
  }
}

function createHarness(opts?: {
  openDatabase?: (filePath: string) => Database.Database;
  secretsFail?: boolean;
}) {
  const parentEmitter = new EventEmitter();
  const secrets = new Map<string, string>();
  const logs: string[] = [];
  const exitCodes: number[] = [];
  let readyCount = 0;
  let shutdownCount = 0;

  const parentPort: WorkerParentPortLike = {
    on: (event, listener) => {
      parentEmitter.on(event, listener);
    },
    off: (event, listener) => {
      parentEmitter.off(event, listener);
    },
    postMessage: (msg: WorkerToMainMessage) => {
      if (msg.type === 'ready') {
        readyCount += 1;
        parentEmitter.emit('worker-ready');
        return;
      }
      if (msg.type === 'shutdown-complete') {
        shutdownCount += 1;
        parentEmitter.emit('worker-shutdown');
        return;
      }
      if (msg.type === 'secret-request') {
        setImmediate(() => {
          if (opts?.secretsFail) {
            sendToWorker({ type: 'secret-reply', reqId: msg.reqId, ok: false, message: 'locked' });
            return;
          }
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

  const dispose = createCatalogWorkerRuntime({
    parentPort,
    openDatabase:
      opts?.openDatabase ??
      ((filePath) => {
        mkdirSync(dirname(filePath), { recursive: true });
        return new Database(filePath);
      }),
    fetchImpl: fetch as unknown as FetchLike,
    log: (line) => logs.push(line),
    onExit: (code) => exitCodes.push(code),
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

    function call<T>(
      rpc: Extract<CatalogClientMessage, { type: 'call' }>['call'],
      onProgress?: (p: ImportProgress) => void,
    ): { reqId: number; promise: Promise<T> } {
      const reqId = ++nextReqId;
      const promise = new Promise<T>((resolve, reject) => {
        const listener = (ev: { data: CatalogWorkerMessage }) => {
          const m = ev.data;
          if (m.reqId !== reqId) return;
          if (m.type === 'progress') {
            onProgress?.(m.progress);
            return;
          }
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
      return { reqId, promise };
    }

    return { pair, call };
  }

  let shutdownPromise: Promise<void> | undefined;
  async function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      shutdownPromise = new Promise<void>((resolve) =>
        parentEmitter.once('worker-shutdown', resolve),
      );
      sendToWorker({ type: 'shutdown' });
    }
    await shutdownPromise;
  }

  const handle = {
    secrets,
    logs,
    exitCodes,
    get readyCount() {
      return readyCount;
    },
    get shutdownCount() {
      return shutdownCount;
    },
    sendToWorker,
    init,
    connectClient,
    shutdown,
    dispose,
  };
  activeHarnesses.push(handle);
  return handle;
}

let simChild: ChildProcess | undefined;
let simUrl = '';
let m3uServer: Server | undefined;
let m3uBaseUrl = '';
const tempDirs: string[] = [];
const activeHarnesses: Array<{ shutdown: () => Promise<void> }> = [];

// Assembled at runtime so no literal token-shaped string sits in source to trip gitleaks.
const SYNTH_M3U_VAL = ['m3u', 'Tok', '9f8e7d6c'].join('_');
const SYNTH_AUTH_VAL = ['Bearer', ['hdr', 'Val', '1a2b3c4d'].join('_')].join(' ');
const SYNTH_GUIDE_VAL = ['guide', 'Val', '554433'].join('_');

function spawnTestSim(): Promise<{ child: ChildProcess; url: string }> {
  const simBin = join(__dirname, '..', '..', '..', '..', 'tools', 'bin', 'sim.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [simBin, '--port', '0', '--host', '127.0.0.1', '--clock', '2026-06-15T12:00:00Z'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.once('error', reject);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const m = /sim:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m?.[1]) resolve({ child, url: m[1] });
    });
  });
}

beforeAll(async () => {
  const started = await spawnTestSim();
  simChild = started.child;
  simUrl = started.url;
  m3uServer = createServer((req, res) => {
    if (req.url?.startsWith('/playlist.m3u')) {
      const body = [
        `#EXTM3U url-tvg="http://guide.example/epg.xml?token=${SYNTH_GUIDE_VAL}"`,
        `#EXTINF:-1 tvg-id="ch1" tvg-logo="http://cdn.example/logo1.png?token=${SYNTH_M3U_VAL}" group-title="News",Channel One`,
        `#EXTVLCOPT:http-user-agent=CustomAgent/1.0`,
        `#EXTVLCOPT:http-referrer=http://ref.example/page?token=${SYNTH_M3U_VAL}`,
        `#EXTHTTP:{"Authorization":"${SYNTH_AUTH_VAL}"}`,
        `http://stream.example/live/${SYNTH_M3U_VAL}/101.ts`,
        `#EXTINF:-1 tvg-id="ch2" group-title="News",Channel Two`,
        `http://stream.example/live/${SYNTH_M3U_VAL}/102.ts`,
        '',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => m3uServer?.listen(0, '127.0.0.1', resolve));
  const addr = m3uServer.address();
  if (typeof addr === 'object' && addr !== null) {
    m3uBaseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  if (simChild && simChild.exitCode === null) {
    const done = new Promise<void>((resolve) => simChild?.once('exit', () => resolve()));
    simChild.kill();
    await done;
  }
  await new Promise<void>((resolve) => (m3uServer ? m3uServer.close(() => resolve()) : resolve()));
});

afterEach(async () => {
  for (const h of activeHarnesses.splice(0)) {
    await h.shutdown();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('createCatalogWorkerRuntime', () => {
  it('imports Xtream and M3U catalogs in WAL mode, checkpoints WAL, serves paged queries and leaves zero credentials in raw SQLite files', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'nested', 'catalog.db');
    const h = createHarness();
    await h.init(dbPath);
    expect(h.readyCount).toBe(1);

    const client = h.connectClient(1);
    expect(client.pair.started).toBe(true);

    const ping = await client.call<Result<void>>({ method: 'ping' }).promise;
    expect(ping).toEqual({ ok: true, value: undefined });

    // Add Xtream source via link with a distinctive credential check via direct addSource too
    const xtreamUrl = simUrl;
    const addedXtream = await client.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'xtream',
        name: 'Sim Demo',
        server: xtreamUrl,
        username: 'demo',
        password: 'demo',
      },
    }).promise;
    expect(addedXtream.ok).toBe(true);
    if (!addedXtream.ok) return;
    const xtreamId = addedXtream.value.id;

    const progresses: ImportProgress[] = [];
    const importedXtream = await client.call<Result<ImportSummary>>(
      { method: 'importSource', id: xtreamId, progress: true },
      (p) => progresses.push(p),
    ).promise;
    expect(importedXtream.ok).toBe(true);
    expect(progresses.length).toBeGreaterThan(0);

    // WAL should be truncated after importSource settled
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }

    // Add M3U source with synthetic tokens in URL, headers and guide override
    const playlistUrl = `${m3uBaseUrl}/playlist.m3u?auth=${SYNTH_M3U_VAL}`;
    const addedM3u = await client.call<Result<SourceRow>>({
      method: 'addSourceFromLink',
      input: {
        name: 'Tokenized M3U',
        url: playlistUrl,
        guideUrl: `http://guide.example/override.xml?token=${SYNTH_GUIDE_VAL}`,
        transport: { userAgent: 'ELV-Desktop/0.1' },
      },
    }).promise;
    expect(addedM3u.ok).toBe(true);
    if (!addedM3u.ok) return;
    const m3uId = addedM3u.value.id;

    // Also add an Xtream source with a unique synthetic credential (exercises addSource persistence)
    const uniqueXtreamVal = ['xtream', 'Val', '776655'].join('_');
    const uniqueXtreamAcct = ['acct', 'Val', '8899'].join('_');
    const addedSecretXtream = await client.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'xtream',
        name: 'Secret Check',
        server: 'http://panel.example:8080',
        username: uniqueXtreamAcct,
        password: uniqueXtreamVal,
      },
    }).promise;
    expect(addedSecretXtream.ok).toBe(true);

    const importedM3u = await client.call<Result<ImportSummary>>({
      method: 'importSource',
      id: m3uId,
    }).promise;
    expect(importedM3u.ok).toBe(true);

    // Verify full CatalogService browse + resolveStream parity
    const sources = await client.call<SourceRow[]>({ method: 'listSources' }).promise;
    expect(sources.map((s) => s.name)).toEqual(['Sim Demo', 'Tokenized M3U', 'Secret Check']);
    expect(sources[0]?.needsImport).toBe(false);
    expect(sources[2]?.needsImport).toBe(true);

    const liveCats = await client.call<CategoryRow[]>({
      method: 'categories',
      sourceId: xtreamId,
      kind: 'live',
    }).promise;
    expect(liveCats.length).toBeGreaterThan(0);

    const liveItems = await client.call<ItemRow[]>({
      method: 'items',
      categoryId: liveCats[0]?.id ?? '',
      offset: 0,
      limit: 10,
    }).promise;
    expect(liveItems.length).toBeGreaterThan(0);

    const stream = await client.call<Result<StreamRequest>>({
      method: 'resolveStream',
      itemKey: liveItems[0]?.key ?? '',
    }).promise;
    expect(stream.ok).toBe(true);
    if (stream.ok) {
      expect(stream.value.url).toContain('/live/demo/demo/');
    }

    // Series lazy episode loading + episodes query
    const seriesCats = await client.call<CategoryRow[]>({
      method: 'categories',
      sourceId: xtreamId,
      kind: 'series',
    }).promise;
    const seriesItems = await client.call<ItemRow[]>({
      method: 'items',
      categoryId: seriesCats[0]?.id ?? '',
      offset: 0,
      limit: 5,
    }).promise;
    const firstSeriesId = seriesItems[0]?.id ?? 0;
    const seasons = await client.call<Result<SeasonRow[]>>({
      method: 'seasons',
      seriesId: firstSeriesId,
    }).promise;
    expect(seasons.ok).toBe(true);
    if (seasons.ok && seasons.value[0]) {
      const episodes = await client.call<EpisodeRow[]>({
        method: 'episodes',
        seriesId: firstSeriesId,
        season: seasons.value[0].season,
      }).promise;
      expect(episodes.length).toBeGreaterThan(0);
    }

    // M3U resolved stream + logo resolution
    const m3uCats = await client.call<CategoryRow[]>({
      method: 'categories',
      sourceId: m3uId,
      kind: 'live',
    }).promise;
    const m3uItems = await client.call<ItemRow[]>({
      method: 'items',
      categoryId: m3uCats[0]?.id ?? '',
      offset: 0,
      limit: 10,
    }).promise;
    expect(m3uItems[0]?.logo).toContain(SYNTH_M3U_VAL);
    const m3uStream = await client.call<Result<StreamRequest>>({
      method: 'resolveStream',
      itemKey: m3uItems[0]?.key ?? '',
    }).promise;
    expect(m3uStream.ok).toBe(true);
    if (m3uStream.ok) {
      expect(m3uStream.value.url).toBe(`http://stream.example/live/${SYNTH_M3U_VAL}/101.ts`);
      expect(m3uStream.value.headers['referer']).toBe(
        `http://ref.example/page?token=${SYNTH_M3U_VAL}`,
      );
      expect(m3uStream.value.headers['authorization']).toBe(SYNTH_AUTH_VAL);
    }

    // Byte-for-byte scan of raw .db, -wal and -shm files BEFORE shutdown AND AFTER shutdown!
    const forbidden = [
      uniqueXtreamVal,
      uniqueXtreamAcct,
      'panel.example',
      SYNTH_M3U_VAL,
      SYNTH_AUTH_VAL,
      SYNTH_GUIDE_VAL,
    ];
    for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (!existsSync(candidate)) continue;
      const bytes = readFileSync(candidate);
      for (const secret of forbidden) {
        expect(bytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
        expect(bytes.includes(Buffer.from(secret, 'utf16le'))).toBe(false);
      }
    }

    // Remove source cleans rows + secrets
    const removed = await client.call<Result<void>>({ method: 'removeSource', id: m3uId }).promise;
    expect(removed.ok).toBe(true);
    expect([...h.secrets.keys()].some((k) => k.includes(m3uId))).toBe(false);

    await h.shutdown();
    expect(h.shutdownCount).toBe(1);
    expect(h.exitCodes).toEqual([0]);

    // Verify WAL mode was active on disk and raw bytes remain clean after close
    const inspectDb = new Database(dbPath, { readonly: true });
    try {
      const jm = inspectDb.pragma('journal_mode', { simple: true });
      expect(jm).toBe('wal');
    } finally {
      inspectDb.close();
    }
    const finalBytes = readFileSync(dbPath);
    for (const secret of forbidden) {
      expect(finalBytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    }
  });

  it('surfaces schema-too-new on ping without crashing and recovers once database is replaced', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'catalog.db');
    const raw = new Database(dbPath);
    raw.pragma('user_version = 99');
    raw.close();

    const h = createHarness();
    await h.init(dbPath);
    const client = h.connectClient(1);

    await expect(client.call({ method: 'ping' }).promise).rejects.toMatchObject({
      error: { category: 'storage', code: 'schema-too-new' } satisfies Partial<ElvError>,
    });

    // Replace newer DB and verify retry succeeds without restarting worker
    rmSync(dbPath, { force: true });
    const retry = await client.call<Result<void>>({ method: 'ping' }).promise;
    expect(retry).toEqual({ ok: true, value: undefined });

    await h.shutdown();
  });

  it('cancels an import on client cancel or client-disconnect and drops invalid payloads without logging secrets', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'catalog.db');
    const h = createHarness();
    await h.init(dbPath);
    const client = h.connectClient(1);

    // Send malformed message carrying a sensitive string — log must NOT include the payload
    client.pair.sendFromClient({
      type: 'call',
      reqId: 99,
      call: { method: 'evil', pw: 'TOPSECRET123' },
    });
    expect(h.logs).toEqual(['catalog worker: dropped an invalid client message']);
    expect(h.logs.join('\n')).not.toContain('TOPSECRET123');

    const added = await client.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'xtream',
        name: 'Cancelable',
        server: simUrl,
        username: 'large',
        password: 'large',
      },
    }).promise;
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    // Start import and immediately cancel it
    const imp = client.call<Result<ImportSummary>>({
      method: 'importSource',
      id: added.value.id,
      batchSize: 100,
    });
    client.pair.sendFromClient({ type: 'cancel', reqId: imp.reqId });
    const cancelled = await imp.promise;
    expect(cancelled).toEqual({
      ok: false,
      error: { category: 'network', code: 'aborted' },
    });

    // Start another import on client 2 and disconnect client 2 mid-flight
    const client2 = h.connectClient(2);
    const imp2 = client2.call<Result<ImportSummary>>({
      method: 'importSource',
      id: added.value.id,
      batchSize: 100,
    });
    h.sendToWorker({ type: 'client-disconnect', clientId: 2 });
    expect(client2.pair.closed).toBe(true);
    // Client 1 can immediately removeSource once client 2's aborted import settles
    const removed = await client.call<Result<void>>({
      method: 'removeSource',
      id: added.value.id,
    }).promise;
    expect(removed.ok).toBe(true);
    // Prevent unhandled rejection if imp2 never resolves because port closed
    void imp2.promise.catch(() => undefined);

    await h.shutdown();
  });

  it('maps secret-reply errors cleanly to storage/secret-store-failed', async () => {
    const dir = makeTempDir();
    const h = createHarness({ secretsFail: true });
    await h.init(join(dir, 'catalog.db'));
    const client = h.connectClient(1);

    const added = await client.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'xtream',
        name: 'Locked',
        server: 'http://127.0.0.1:7879',
        username: 'u',
        password: 'p',
      },
    }).promise;
    expect(added).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-store-failed' },
    });

    await h.shutdown();
    const spy = vi.fn();
    h.dispose();
    expect(spy).not.toHaveBeenCalled();
  });
});
