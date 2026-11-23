import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CategoryRow,
  DiscoveredCategory,
  ImportSummary,
  ItemRow,
  LiveVariantOption,
  SourceRow,
  VodVersionOption,
} from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      if (!this.closed && this.started) workerEmitter.emit('message', { data: msg });
    });
  }
}

const tempDirs: string[] = [];

function createTestRuntime(opts: { fetchImpl: FetchLike; legacyFetchImpl: FetchLike }) {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-c3-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');
  const secrets = new Map<string, string>();
  const parentEmitter = new EventEmitter();
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
          secrets.set(msg.key, msg.value);
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

  const dispose = createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (p) => new Database(p),
    fetchImpl: opts.fetchImpl,
    legacyFetchImpl: opts.legacyFetchImpl,
    clock: () => 1_700_000_000_000,
    yieldNow: async () => undefined,
    log: () => undefined,
  });

  const pair = new FakePortPair();
  parentEmitter.emit('message', { data: { type: 'init', dbPath } satisfies MainToWorkerMessage });
  parentEmitter.emit('message', {
    data: { type: 'client-port', clientId: 1 } satisfies MainToWorkerMessage,
    ports: [pair.workerSide],
  });

  let reqId = 0;
  const call = <T>(
    rpc: CatalogClientMessage & { type: 'call' } extends never ? never : unknown,
  ) => {
    const id = ++reqId;
    return new Promise<T>((resolve, reject) => {
      const onMsg = (ev: { data: CatalogWorkerMessage }) => {
        if (ev.data.reqId !== id) return;
        if (ev.data.type === 'progress') return;
        pair.mainSide.off('message', onMsg);
        if (ev.data.type === 'result') resolve(ev.data.value as T);
        else reject(new Error(`${ev.data.error.category}/${ev.data.error.code}`));
      };
      pair.mainSide.on('message', onMsg);
      pair.mainSide.emit('send', { type: 'call', reqId: id, call: rpc });
    });
  };

  return {
    dir,
    ready,
    call,
    async shutdown() {
      parentEmitter.emit('message', { data: { type: 'shutdown' } satisfies MainToWorkerMessage });
      await new Promise((r) => setTimeout(r, 20));
      dispose();
    },
  };
}

function m3uFetch(text: string): FetchLike {
  return vi.fn(async (url) => ({
    status: 200,
    url,
    headers: { forEach: () => {}, get: () => null, getSetCookie: () => [] },
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  }));
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('catalog-worker Wave C3 end-to-end (#51, #39, #182, #218, #404)', () => {
  it('stores local M3U bytes in sandbox, discovers categories, queries variants/versions, and cleans up on remove', async () => {
    const modernFetch = m3uFetch('');
    const legacyFetch = m3uFetch('');
    const rt = createTestRuntime({ fetchImpl: modernFetch, legacyFetchImpl: legacyFetch });
    try {
      await rt.ready;
      const playlist = [
        '#EXTM3U',
        '#EXTINF:-1 group-title="Sports",Arena Sports 4K',
        'http://local.test/live/1.ts',
        '#EXTINF:-1 group-title="Sports",Arena Sports HD',
        'http://local.test/live/2.ts',
        '#EXTINF:-1 group-title="Movies",Solaris (1972) [4K]',
        'http://local.test/movie/1.mp4',
        '#EXTINF:-1 group-title="Movies",Solaris (1972) [1080p]',
        'http://local.test/movie/2.mp4',
      ].join('\n');

      const added = await rt.call<Result<SourceRow>>({
        method: 'addLocalM3uSource',
        input: { name: 'Local Test', bytes: new TextEncoder().encode(playlist) },
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const sourceId = added.value.id;
      const storedPath = join(rt.dir, 'playlists', `${sourceId}.m3u`);
      expect(existsSync(storedPath)).toBe(true);

      const discovered = await rt.call<Result<readonly DiscoveredCategory[]>>({
        method: 'discoverSourceCategories',
        sourceId,
      });
      expect(discovered.ok).toBe(true);
      if (discovered.ok) {
        expect(discovered.value.length).toBeGreaterThanOrEqual(2);
      }

      const imported = await rt.call<Result<ImportSummary>>({
        method: 'importSource',
        id: sourceId,
      });
      expect(imported.ok).toBe(true);
      expect(modernFetch).not.toHaveBeenCalled();
      expect(legacyFetch).not.toHaveBeenCalled();

      const liveCats = await rt.call<CategoryRow[]>({
        method: 'categories',
        sourceId,
        kind: 'live',
        opts: { collapseVariants: true },
      });
      expect(liveCats[0]?.itemCount).toBe(1);

      const collapsedLive = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: liveCats[0]?.id,
        offset: 0,
        limit: 20,
        opts: { collapseVariants: true },
      });
      expect(collapsedLive).toHaveLength(1);
      expect(collapsedLive[0]?.variantCount).toBe(2);

      const variants = await rt.call<LiveVariantOption[]>({
        method: 'liveVariants',
        itemKey: collapsedLive[0]?.key,
        categoryId: liveCats[0]?.id,
      });
      expect(variants).toHaveLength(2);

      const movieCats = await rt.call<CategoryRow[]>({
        method: 'categories',
        sourceId,
        kind: 'movie',
        opts: { groupVersions: true },
      });
      expect(movieCats[0]?.itemCount).toBe(1);

      const groupedMovies = await rt.call<ItemRow[]>({
        method: 'items',
        categoryId: movieCats[0]?.id,
        offset: 0,
        limit: 20,
        opts: { groupVersions: true },
      });
      expect(groupedMovies).toHaveLength(1);
      expect(groupedMovies[0]?.versionCount).toBe(2);

      const versions = await rt.call<VodVersionOption[]>({
        method: 'itemVersions',
        itemKey: groupedMovies[0]?.key,
      });
      expect(versions).toHaveLength(2);

      const removed = await rt.call<Result<void>>({ method: 'removeSource', id: sourceId });
      expect(removed.ok).toBe(true);
      expect(existsSync(storedPath)).toBe(false);
    } finally {
      await rt.shutdown();
    }
  });

  it('routes allowLegacyTls: true source imports exclusively through the isolated legacy TLS fetch (#182)', async () => {
    const modernFetch = m3uFetch('#EXTM3U\n#EXTINF:-1,Modern\nhttp://a/m.ts\n');
    const legacyFetch = m3uFetch('#EXTM3U\n#EXTINF:-1,Legacy\nhttp://a/l.ts\n');
    const rt = createTestRuntime({ fetchImpl: modernFetch, legacyFetchImpl: legacyFetch });
    try {
      await rt.ready;
      const added = await rt.call<Result<SourceRow>>({
        method: 'addSource',
        input: {
          kind: 'm3u',
          name: 'Old Tuner',
          playlistUrl: 'https://legacy-tuner.local/list.m3u',
          transport: { allowLegacyTls: true },
        },
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const imported = await rt.call<Result<ImportSummary>>({
        method: 'importSource',
        id: added.value.id,
      });
      expect(imported.ok).toBe(true);
      expect(legacyFetch).toHaveBeenCalledTimes(1);
      expect(modernFetch).not.toHaveBeenCalled();
    } finally {
      await rt.shutdown();
    }
  });
});
