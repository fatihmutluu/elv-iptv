import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportSummary, SourceRow } from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkerToMainMessage,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from '../main/catalog/worker-protocol.ts';
import type { CatalogClientMessage, CatalogWorkerMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';

const tempDirs: string[] = [];
const activeShutdowns: Array<() => Promise<void>> = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-sec-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const stop of activeShutdowns.splice(0)) {
    await stop().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      postMessage: (msg: CatalogWorkerMessage) => {
        if (!this.closed) this.mainSide.emit('message', { data: msg });
      },
      on: workerEmitter.on.bind(workerEmitter),
      once: workerEmitter.once.bind(workerEmitter),
    };
    this.mainSide.on('send', (msg: unknown) => {
      if (!this.closed && this.started) workerEmitter.emit('message', { data: msg });
    });
  }

  send(msg: CatalogClientMessage | unknown): void {
    this.mainSide.emit('send', msg);
  }
}

function createRuntimeHarness(
  fetchImpl: FetchLike,
  onSecretSet?: (key: string, value: string, sendShutdown: () => void) => void,
  maxSecretValueChars?: number,
) {
  const dir = makeTempDir();
  const dbPath = join(dir, 'catalog.db');
  const parentEmitter = new EventEmitter();
  const secrets = new Map<string, string>();
  const secretOps: Array<{ op: string; key: string; valueLen?: number }> = [];
  let shutdownComplete = false;

  const sendToWorker = (
    msg: MainToWorkerMessage,
    ports?: readonly WorkerClientPortLike[],
  ): void => {
    parentEmitter.emit('message', { data: msg, ...(ports ? { ports } : {}) });
  };

  const parentPort: WorkerParentPortLike = {
    on: parentEmitter.on.bind(parentEmitter),
    off: parentEmitter.off.bind(parentEmitter),
    postMessage: (msg: WorkerToMainMessage) => {
      if (!isWorkerToMainMessage(msg)) return;
      if (msg.type === 'shutdown-complete') {
        shutdownComplete = true;
        parentEmitter.emit('shutdown-complete');
        return;
      }
      if (msg.type === 'secret-request') {
        secretOps.push({
          op: msg.op,
          key: msg.key,
          ...(msg.op === 'set' ? { valueLen: msg.value.length } : {}),
        });
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
            onSecretSet?.(msg.key, msg.value, () => sendToWorker({ type: 'shutdown' }));
          } else {
            secrets.delete(msg.key);
            sendToWorker({ type: 'secret-reply', reqId: msg.reqId, ok: true, value: null });
          }
        });
      }
    },
  };

  const dispose = createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (path) => new Database(path),
    fetchImpl,
    log: () => undefined,
    ...(maxSecretValueChars !== undefined ? { maxSecretValueChars } : {}),
  });

  sendToWorker({ type: 'init', dbPath });
  const pair = new FakePortPair();
  sendToWorker({ type: 'client-port', clientId: 1 }, [pair.workerSide]);

  activeShutdowns.push(async () => {
    if (!shutdownComplete) {
      sendToWorker({ type: 'shutdown' });
      await new Promise<void>((resolve) => {
        if (shutdownComplete) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 500);
        parentEmitter.once('shutdown-complete', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    dispose();
  });

  let nextReq = 0;
  const call = <T>(rpcCall: unknown): Promise<T> => {
    const reqId = ++nextReq;
    return new Promise<T>((resolve, reject) => {
      const onClose = () => {
        pair.mainSide.off('message', onMsg);
        reject(new Error('port closed'));
      };
      const onMsg = (ev: { data: CatalogWorkerMessage }) => {
        if (ev.data.reqId !== reqId || ev.data.type === 'progress') return;
        pair.mainSide.off('message', onMsg);
        pair.mainSide.off('close', onClose);
        if (ev.data.type === 'result') resolve(ev.data.value as T);
        else reject(Object.assign(new Error(ev.data.error.code), { error: ev.data.error }));
      };
      pair.mainSide.on('message', onMsg);
      pair.mainSide.once('close', onClose);
      pair.send({ type: 'call', reqId, call: rpcCall });
    });
  };

  return {
    dbPath,
    pair,
    secrets,
    secretOps,
    sendToWorker,
    call,
    dispose,
    isShutdownComplete: () => shutdownComplete,
  };
}

describe('catalog-worker-runtime security, parity, and shutdown guarantees', () => {
  it('rejects non-HTTP(S) URLs at source registration while allowing bare Xtream host:port and trimmed clipboard URLs', async () => {
    const h = createRuntimeHarness(async () => {
      throw new Error('unexpected fetch');
    });

    for (const badUrl of [
      'data:text/plain,#EXTM3U',
      'file:///etc/passwd',
      'file:/etc/passwd',
      'ftp://files.example/list.m3u',
      'javascript:alert(1)',
    ]) {
      expect(
        await h.call<Result<SourceRow>>({
          method: 'addSource',
          input: { kind: 'm3u', name: 'Bad M3U', playlistUrl: badUrl },
        }),
      ).toEqual({ ok: false, error: { category: 'source-format', code: 'invalid-source' } });

      expect(
        await h.call<Result<SourceRow>>({
          method: 'addSourceFromLink',
          input: { name: 'Bad Link', url: badUrl },
        }),
      ).toEqual({ ok: false, error: { category: 'source-format', code: 'invalid-source' } });

      expect(
        await h.call<Result<SourceRow>>({
          method: 'addSource',
          input: {
            kind: 'xtream',
            name: 'Bad Xtream',
            server: badUrl,
            username: 'u',
            password: 'p',
          },
        }),
      ).toEqual({ ok: false, error: { category: 'source-format', code: 'invalid-source' } });
    }

    expect(
      await h.call<Result<SourceRow>>({
        method: 'addSource',
        input: {
          kind: 'm3u',
          name: 'Bad Guide',
          playlistUrl: 'https://ok.example/list.m3u',
          guideUrl: 'file:///etc/passwd',
        },
      }),
    ).toEqual({ ok: false, error: { category: 'source-format', code: 'invalid-source' } });

    const bareHost = await h.call<Result<SourceRow>>({
      method: 'addSource',
      input: {
        kind: 'xtream',
        name: 'Bare Host',
        server: 'panel.example:8080',
        username: 'u',
        password: 'p',
      },
    });
    expect(bareHost.ok).toBe(true);

    const pasted = await h.call<Result<SourceRow>>({
      method: 'addSourceFromLink',
      input: { name: 'Pasted Link', url: '  https://ok.example/list.m3u\r\n' },
    });
    expect(pasted.ok).toBe(true);
  });

  it('blocks non-HTTP(S) discovered url-tvg and cross-scheme redirects inside worker fetch', async () => {
    const fetchedUrls: string[] = [];
    let bodyCancelled = false;

    const h = createRuntimeHarness(async (url) => {
      fetchedUrls.push(url);
      if (url === 'http://ok.example/evil-guide.m3u') {
        const body = [
          '#EXTM3U url-tvg="data:text/xml,<tv></tv>"',
          '#EXTINF:-1,Ch 1',
          'http://ok.example/live/1.ts',
          '',
        ].join('\n');
        return {
          status: 200,
          headers: new Headers(),
          body: (async function* () {
            yield Buffer.from(body, 'utf8');
          })(),
        };
      }
      if (url === 'http://ok.example/redirect.m3u') {
        return {
          status: 200,
          url: 'file:///etc/passwd',
          headers: new Headers(),
          body: {
            getReader() {
              return {
                read: async () => ({ done: true as const }),
                cancel: async () => {
                  bodyCancelled = true;
                },
                releaseLock() {},
              };
            },
          },
        };
      }
      throw new TypeError('unreachable');
    });

    const s1 = await h.call<Result<SourceRow>>({
      method: 'addSource',
      input: { kind: 'm3u', name: 'Evil Guide', playlistUrl: 'http://ok.example/evil-guide.m3u' },
    });
    expect(s1.ok).toBe(true);
    if (!s1.ok) throw new Error('expected ok');
    await h.call<Result<ImportSummary>>({ method: 'importSource', id: s1.value.id });
    expect(fetchedUrls.some((u) => u.startsWith('data:'))).toBe(false);

    const s2 = await h.call<Result<SourceRow>>({
      method: 'addSource',
      input: { kind: 'm3u', name: 'Redirect', playlistUrl: 'http://ok.example/redirect.m3u' },
    });
    expect(s2.ok).toBe(true);
    if (!s2.ok) throw new Error('expected ok');
    const imp2 = await h.call<Result<ImportSummary>>({ method: 'importSource', id: s2.value.id });
    expect(imp2).toEqual({ ok: false, error: { category: 'network', code: 'fetch-failed' } });
    expect(bodyCancelled).toBe(true);
  });

  it('matches @elv/data CatalogService on empty/zero arguments and replies with fault on invalid call messages', async () => {
    const h = createRuntimeHarness(async () => {
      throw new TypeError('offline');
    });

    expect(await h.call({ method: 'categories', sourceId: '', kind: 'live' })).toEqual([]);
    expect(await h.call({ method: 'items', categoryId: '', offset: 0, limit: 25 })).toEqual([]);
    expect(await h.call({ method: 'seasons', seriesId: 0 })).toEqual({
      ok: false,
      error: { category: 'storage', code: 'item-not-found' },
    });
    expect(await h.call({ method: 'episodes', seriesId: 0, season: 1 })).toEqual([]);
    expect(await h.call({ method: 'resolveStream', itemKey: '' })).toEqual({
      ok: false,
      error: { category: 'storage', code: 'item-not-found' },
    });
    expect(await h.call({ method: 'removeSource', id: '' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await h.call({ method: 'removeSource', id: '../bad' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await h.call({ method: 'importSource', id: '' })).toEqual({
      ok: false,
      error: { category: 'storage', code: 'source-not-found' },
    });
    expect(h.secretOps).toEqual([]);

    await expect(h.call({ method: 'dropTable' })).rejects.toMatchObject({
      error: { category: 'source-format', code: 'invalid-request' },
    });
  });

  it('keeps SecretStore active during graceful shutdown so an in-flight addSource rollback deletes staged secrets', async () => {
    let triggeredShutdown = false;

    const h = createRuntimeHarness(
      async () => {
        throw new TypeError('offline');
      },
      (key, _value, sendShutdown) => {
        if (!triggeredShutdown && key.endsWith('.urlvars')) {
          triggeredShutdown = true;
          sendShutdown();
        }
      },
    );

    expect(await h.call({ method: 'ping' })).toEqual({ ok: true, value: undefined });

    // Force the next INSERT INTO sources to fail so addSource executes its SecretStore rollback
    const auxDb = new Database(h.dbPath);
    auxDb.exec(
      "CREATE TRIGGER fail_next_source BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    auxDb.close();

    const addPromise = h
      .call<Result<SourceRow>>({
        method: 'addSource',
        input: {
          kind: 'm3u',
          name: 'Rollback During Shutdown',
          playlistUrl: 'http://s.example/a.m3u',
          guideUrl: 'http://s.example/epg.xml',
        },
      })
      .catch(() => undefined);

    await vi.waitFor(() => expect(h.isShutdownComplete()).toBe(true));
    await addPromise;

    expect(triggeredShutdown).toBe(true);
    // Both staged secrets (.playlist and .urlvars) must be rolled back before shutdown closes SecretStore!
    expect([...h.secrets.keys()]).toEqual([]);
  });

  it('fails closed without hanging when a secret write exceeds MAX_SECRET_VALUE_CHARS', async () => {
    const h = createRuntimeHarness(
      async () => ({
        status: 200,
        headers: new Headers(),
        body: (async function* () {
          yield Buffer.from(
            `#EXTM3U\n#EXTINF:-1,Ch\nhttp://s.example/1.ts?token=${'b'.repeat(800)}\n`,
            'utf8',
          );
        })(),
      }),
      undefined,
      256,
    );

    const src = await h.call<Result<SourceRow>>({
      method: 'addSource',
      input: { kind: 'm3u', name: 'Oversized Secret', playlistUrl: 'http://s.example/a.m3u' },
    });
    expect(src.ok).toBe(true);
    if (!src.ok) throw new Error('expected ok');

    const imp = await h.call<Result<ImportSummary>>({ method: 'importSource', id: src.value.id });
    expect(imp).toEqual({
      ok: false,
      error: { category: 'storage', code: 'secret-write-failed' },
    });
  });
});
