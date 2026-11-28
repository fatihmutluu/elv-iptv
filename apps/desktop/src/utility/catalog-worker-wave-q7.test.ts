import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../main/catalog/worker-protocol.ts';
import {
  type CatalogIpcRendererLike,
  createCatalogBridge,
  type PreloadClientPortLike,
} from '../preload/catalog-bridge.ts';
import { CATALOG_CHANNELS, type CatalogWorkerMessage } from '../shared/catalog-ipc.ts';
import {
  createCatalogWorkerRuntime,
  type WorkerClientPortLike,
  type WorkerParentPortLike,
} from './catalog-worker-runtime.ts';

class FakePortPair {
  readonly preloadPort: PreloadClientPortLike;
  readonly workerPort: WorkerClientPortLike;
  private preloadStarted = false;
  private workerStarted = false;
  private closed = false;
  private readonly preloadListeners = new Set<(ev: { readonly data: unknown }) => void>();
  private readonly workerEmitter = new EventEmitter();

  constructor() {
    this.workerPort = {
      start: () => {
        this.workerStarted = true;
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        this.workerEmitter.emit('close');
      },
      postMessage: (msg: CatalogWorkerMessage) => {
        if (this.closed || !this.preloadStarted) return;
        for (const fn of [...this.preloadListeners]) fn({ data: msg });
      },
      on: this.workerEmitter.on.bind(this.workerEmitter),
      once: this.workerEmitter.once.bind(this.workerEmitter),
    };
    this.preloadPort = {
      addEventListener: (_type, listener) => void this.preloadListeners.add(listener),
      removeEventListener: (_type, listener) => void this.preloadListeners.delete(listener),
      postMessage: (msg) => {
        if (this.closed || !this.workerStarted) return;
        this.workerEmitter.emit('message', { data: msg });
      },
      start: () => {
        this.preloadStarted = true;
      },
      close: () => {
        this.workerPort.close();
      },
    };
  }
}

const tempDirs: string[] = [];

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-q7-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');
  const secrets = new Map<string, string>();
  const parentEmitter = new EventEmitter();
  const ipcEmitter = new EventEmitter();
  const ready = new Promise<void>((resolve) => {
    parentEmitter.on('worker-msg', (msg: WorkerToMainMessage) => {
      if (msg.type === 'ready') resolve();
    });
  });

  const parentPort: WorkerParentPortLike = {
    on: parentEmitter.on.bind(parentEmitter),
    off: parentEmitter.off.bind(parentEmitter),
    postMessage: (msg: WorkerToMainMessage) => {
      if (msg.type === 'secret-request') {
        if (msg.op === 'get') {
          parentEmitter.emit('message', {
            data: {
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: secrets.get(msg.key) ?? null,
            } satisfies MainToWorkerMessage,
          });
        } else if (msg.op === 'set') {
          secrets.set(msg.key, msg.value ?? '');
          parentEmitter.emit('message', {
            data: {
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: null,
            } satisfies MainToWorkerMessage,
          });
        } else {
          secrets.delete(msg.key);
          parentEmitter.emit('message', {
            data: {
              type: 'secret-reply',
              reqId: msg.reqId,
              ok: true,
              value: null,
            } satisfies MainToWorkerMessage,
          });
        }
        return;
      }
      parentEmitter.emit('worker-msg', msg);
    },
  };

  let nextClientId = 0;
  const ipc: CatalogIpcRendererLike = {
    send: (channel, payload) => {
      if (channel !== CATALOG_CHANNELS.connect) return;
      const connectId = (payload as { connectId: number }).connectId;
      const pair = new FakePortPair();
      parentEmitter.emit('message', {
        data: { type: 'client-port', clientId: ++nextClientId } satisfies MainToWorkerMessage,
        ports: [pair.workerPort],
      });
      ipcEmitter.emit(CATALOG_CHANNELS.port, { ports: [pair.preloadPort] }, { connectId });
    },
    on: (channel, listener) => ipcEmitter.on(channel, listener),
    removeListener: (channel, listener) => ipcEmitter.removeListener(channel, listener),
  };

  const fetchImpl: FetchLike = async () => ({
    status: 200,
    headers: new Headers(),
    body: null,
  });

  const dispose = createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (path) => new Database(path),
    fetchImpl,
  });
  parentEmitter.emit('message', {
    data: { type: 'init', dbPath } satisfies MainToWorkerMessage,
  });

  const shutdown = () =>
    new Promise<void>((resolve) => {
      parentEmitter.once('worker-msg', (msg: WorkerToMainMessage) => {
        if (msg.type === 'shutdown-complete') resolve();
      });
      parentEmitter.emit('message', {
        data: { type: 'shutdown' } satisfies MainToWorkerMessage,
      });
    });

  const bridge = createCatalogBridge(ipc);
  return { bridge, dbPath, ready, dispose, shutdown };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup on Windows
      }
    }
  }
});

describe('Wave Q7-B Desktop catalog worker + preload bridge end-to-end', () => {
  it('supports removeRecentChannel, clearRecentChannels, and Live Favorite Folders CRUD over MessagePort', async () => {
    const h = createHarness();
    await h.ready;
    expect((await h.bridge.open()).ok).toBe(true);

    // Seed source & 2 live channels directly into the worker SQLite DB
    const db = new Database(h.dbPath);
    db.exec(`
      INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 100, '{}');
      INSERT INTO live (source_id, key, provider_id, name, name_fold, sort_title, num, is_hidden, run_id)
        VALUES ('s1', 'x:s1:live:1', '1', 'Sports HD', 'sports hd', 'sports hd', 1, 0, 1),
               ('s1', 'x:s1:live:2', '2', 'News HD', 'news hd', 'news hd', 2, 0, 1);
    `);
    db.close();

    // Recent channels record, per-item remove, and clear
    await h.bridge.recordRecentChannel?.('x:s1:live:1', 's1');
    await h.bridge.recordRecentChannel?.('x:s1:live:2', 's1');
    const recentBefore = ((await h.bridge.listRecentChannels?.(10)) ?? []).map((c) => c.key);
    expect(recentBefore).toHaveLength(2);
    expect(recentBefore).toEqual(expect.arrayContaining(['x:s1:live:1', 'x:s1:live:2']));
    expect(await h.bridge.removeRecentChannel?.('x:s1:live:2')).toBe(true);
    expect(((await h.bridge.listRecentChannels?.(10)) ?? []).map((c) => c.key)).toEqual([
      'x:s1:live:1',
    ]);
    expect(await h.bridge.clearRecentChannels?.()).toBe(1);
    expect(await h.bridge.listRecentChannels?.(10)).toEqual([]);

    // Live favorite folders CRUD + assign + unfile + delete
    const created = await h.bridge.createLiveFavoriteFolder?.({ name: 'Sports' });
    expect(created?.ok).toBe(true);
    if (!created || !created.ok) return;

    const assigned = await h.bridge.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: created.value.id,
      title: 'Sports HD',
    });
    expect(assigned?.ok).toBe(true);
    expect((await h.bridge.listLiveFavoriteFolders?.())?.map((f) => [f.name, f.itemCount])).toEqual(
      [['Sports', 1]],
    );
    expect(await h.bridge.listLiveFavoriteFolderAssignments?.()).toEqual([
      { itemKey: 'x:s1:live:1', folderId: created.value.id },
    ]);

    const renamed = await h.bridge.renameLiveFavoriteFolder?.(created.value.id, 'Live Sports');
    expect(renamed?.ok).toBe(true);
    if (renamed?.ok) expect(renamed.value.name).toBe('Live Sports');

    const unfiled = await h.bridge.assignLiveFavoriteFolder?.({
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      folderId: null,
    });
    expect(unfiled?.ok).toBe(true);
    expect(await h.bridge.listLiveFavoriteFolderAssignments?.()).toEqual([]);
    expect(await h.bridge.listFavoriteKeys()).toContain('x:s1:live:1');

    const deleted = await h.bridge.deleteLiveFavoriteFolder?.(created.value.id);
    expect(deleted?.ok).toBe(true);
    expect(await h.bridge.listLiveFavoriteFolders?.()).toEqual([]);

    await h.bridge.close();
    await h.shutdown();
    h.dispose();
  });
});
