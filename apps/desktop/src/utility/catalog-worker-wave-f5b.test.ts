import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CategoryRow,
  ItemRow,
  SourceRow,
  StreamRequest,
  VodCollectionRecord,
} from '@elv/data';
import type { FetchLike, Result } from '@elv/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function createEndToEndHarness(fetchImpl: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-f5b-'));
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
    fetchImpl,
    clock: () => 1_700_000_000_000,
    yieldNow: async () => undefined,
    log: () => undefined,
  });

  parentEmitter.emit('message', { data: { type: 'init', dbPath } satisfies MainToWorkerMessage });

  let clientSeq = 0;
  let lastPair: FakePortPair | undefined;
  const ipcRenderer: CatalogIpcRendererLike = {
    send(channel, ...args) {
      if (channel !== CATALOG_CHANNELS.connect) return;
      const { connectId } = args[0] as { connectId: number };
      const pair = new FakePortPair();
      lastPair = pair;
      parentEmitter.emit('message', {
        data: { type: 'client-port', clientId: ++clientSeq } satisfies MainToWorkerMessage,
        ports: [pair.workerPort],
      });
      ipcEmitter.emit(CATALOG_CHANNELS.port, { ports: [pair.preloadPort] }, { connectId });
    },
    on: ipcEmitter.on.bind(ipcEmitter),
    removeListener: ipcEmitter.removeListener.bind(ipcEmitter),
  };

  const bridge = createCatalogBridge(ipcRenderer);

  return {
    ready,
    bridge,
    dbPath,
    secrets,
    sendRawToWorker(raw: unknown): Promise<CatalogWorkerMessage> {
      return new Promise((resolve) => {
        const pair = lastPair;
        if (!pair) throw new Error('port not opened yet');
        const onMsg = (ev: { readonly data: unknown }) => {
          pair.preloadPort.removeEventListener('message', onMsg);
          resolve(ev.data as CatalogWorkerMessage);
        };
        pair.preloadPort.addEventListener('message', onMsg);
        pair.preloadPort.postMessage(raw as never);
      });
    },
    async shutdown() {
      await bridge.close();
      parentEmitter.emit('message', { data: { type: 'shutdown' } satisfies MainToWorkerMessage });
      await new Promise((r) => setTimeout(r, 20));
      dispose();
    },
  };
}

function makeStalkerFetch(): FetchLike {
  const token = 'STALKER_TOKEN_SYNTH_1';
  const jsonResponse = (url: string, payload: unknown, status = 200) => ({
    status,
    url,
    headers: {
      forEach: (cb: (v: string, k: string) => void) => cb('application/json', 'content-type'),
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      getSetCookie: () => [],
    },
    body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(payload));
    })(),
  });

  return vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type') ?? '';
    const action = parsed.searchParams.get('action') ?? '';
    const headers = init?.headers ?? {};

    if (type === 'stb' && action === 'handshake') {
      return jsonResponse(url, { js: { token } });
    }
    const auth = headers.Authorization ?? headers.authorization;
    if (auth !== `Bearer ${token}`) {
      return jsonResponse(url, { js: 'Authorization failed.' }, 401);
    }
    if (type === 'stb' && action === 'get_profile') {
      return jsonResponse(url, {
        js: { status: '1', blocked: '0', max_connections: '2', default_timezone: 'UTC' },
      });
    }
    if (type === 'itv' && action === 'get_genres') {
      return jsonResponse(url, { js: [{ id: '10', title: 'News' }] });
    }
    if (type === 'itv' && action === 'get_all_channels') {
      return jsonResponse(url, {
        js: {
          data: [
            {
              id: '101',
              number: '1',
              name: 'World News HD',
              tv_genre_id: '10',
              cmd: 'ffmpeg http://portal.example.test/ch/101',
            },
          ],
        },
      });
    }
    if (type === 'vod' && action === 'get_categories') {
      return jsonResponse(url, { js: [{ id: '30', title: 'Cinema' }] });
    }
    if (type === 'vod' && action === 'get_ordered_list') {
      return jsonResponse(url, {
        js: {
          total_items: 2,
          max_page_items: 14,
          data: [
            {
              id: '201',
              name: '[4K] Metropolis (1927) HEVC',
              category_id: '30',
              cmd: 'ffmpeg http://portal.example.test/vod/201',
              year: '1927',
            },
            {
              id: '202',
              name: 'Charade (1963)',
              category_id: '30',
              cmd: 'ffmpeg http://portal.example.test/vod/202',
              year: '1963',
            },
          ],
        },
      });
    }
    if (type === 'series' && action === 'get_categories') {
      return jsonResponse(url, { js: [{ id: '40', title: 'Drama' }] });
    }
    if (type === 'series' && action === 'get_ordered_list') {
      return jsonResponse(url, {
        js: {
          total_items: 1,
          max_page_items: 14,
          data: [
            {
              id: '301',
              name: 'Signal Tower',
              category_id: '40',
              year: '2024',
            },
          ],
        },
      });
    }
    if (action === 'create_link') {
      if (type === 'itv') {
        return jsonResponse(url, {
          js: { cmd: 'ffrt http://portal.example.test/live/101.ts?play=1' },
        });
      }
      return jsonResponse(url, {
        js: { cmd: 'ffmpeg http://portal.example.test/vod/201.mp4?play=1' },
      });
    }
    return jsonResponse(url, { js: [] });
  });
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('catalog-worker + preload Wave F5B Stalker, VOD enrichment & collections (#29, #215, #403)', () => {
  it('round-trips Stalker add/import/resolve, VOD enrichment cache, and full collection CRUD with onChanged notifications', async () => {
    const h = createEndToEndHarness(makeStalkerFetch());
    let changedCount = 0;
    const offChanged = h.bridge.onChanged(() => {
      changedCount += 1;
    });
    try {
      await h.ready;
      expect((await h.bridge.open()).ok).toBe(true);

      // 1. Add Stalker source (hyphenated lowercase MAC normalized; credentials strictly in SecretStore)
      const added: Result<SourceRow> = await h.bridge.addSource({
        kind: 'stalker',
        name: 'Portal Synth',
        portalUrl: '  http://portal.example.test/c/  ',
        mac: '00-1a-79-00-00-01',
        serialNumber: ' SN-99 ',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(added.value.kind).toBe('stalker');

      const storedSecret = h.secrets.get(`source.${added.value.id}.stalker`);
      expect(storedSecret).toBeDefined();
      expect(storedSecret).toContain('00:1A:79:00:00:01');
      expect(storedSecret).toContain('SN-99');

      // Import Stalker catalog and resolve live stream via play-time create_link
      const imported = await h.bridge.startImport(added.value.id).result;
      expect(imported.ok).toBe(true);

      const liveCats: CategoryRow[] = await h.bridge.categories(added.value.id, 'live');
      const liveItems: ItemRow[] = await h.bridge.items(liveCats[0]?.id ?? '', 0, 10);
      expect(liveItems).toHaveLength(1);
      const resolvedLive: Result<StreamRequest> = await h.bridge.resolveStream(
        liveItems[0]?.key ?? '',
      );
      expect(resolvedLive.ok).toBe(true);
      if (resolvedLive.ok) {
        expect(resolvedLive.value.url).toBe('http://portal.example.test/live/101.ts?play=1');
      }

      // Verify zero MAC, portalUrl, or token strings persisted in SQLite
      const rawDb = new Database(h.dbPath, { readonly: true });
      try {
        const dump = JSON.stringify([
          rawDb.prepare('SELECT * FROM sources').all(),
          rawDb.prepare('SELECT * FROM live').all(),
          rawDb.prepare('SELECT * FROM movies').all(),
        ]);
        expect(dump).not.toContain('00:1A:79:00:00:01');
        expect(dump).not.toContain('portal.example.test');
        expect(dump).not.toContain('STALKER_TOKEN_SYNTH_1');
      } finally {
        rawDb.close();
      }

      // 2. VOD enrichment (#215): disabled is a no-op; enabled resolves local index & caches
      const movieCats = await h.bridge.categories(added.value.id, 'movie');
      const movies = await h.bridge.items(movieCats[0]?.id ?? '', 0, 10);
      const seriesCats = await h.bridge.categories(added.value.id, 'series');
      const seriesItems = await h.bridge.items(seriesCats[0]?.id ?? '', 0, 10);
      const metropolisKey = movies.find((m) => m.name.includes('Metropolis'))?.key ?? '';
      const charadeKey = movies.find((m) => m.name.includes('Charade'))?.key ?? '';
      const seriesKey = seriesItems[0]?.key ?? '';
      expect(metropolisKey).not.toBe('');
      expect(charadeKey).not.toBe('');
      expect(seriesKey).not.toBe('');

      const beforeCount = changedCount;
      expect(await h.bridge.getVodEnrichment?.(metropolisKey)).toBeNull();
      expect(await h.bridge.enrichVodItem?.(metropolisKey, { enabled: false })).toBeNull();
      expect(changedCount).toBe(beforeCount);

      const enriched = await h.bridge.enrichVodItem?.(metropolisKey, {
        enabled: true,
        ttlMs: 86_400_000,
      });
      expect(enriched).not.toBeNull();
      expect(enriched?.cleanTitle).toBe('Metropolis');
      expect(enriched?.releaseYear).toBe(1927);
      expect(enriched?.rating).toBe(8.3);
      expect(enriched?.genres).toEqual(['Sci-Fi', 'Drama']);
      expect(changedCount).toBe(beforeCount + 1);

      const cached = await h.bridge.getVodEnrichment?.(metropolisKey);
      expect(cached).toEqual(enriched);
      expect(changedCount).toBe(beforeCount + 1);

      // 3. Custom VOD Collections (#403): CRUD, reorder, parental filtering, onChanged bumps
      const c1 = await h.bridge.createCollection?.({ name: 'Classics' });
      const c2 = await h.bridge.createCollection?.({ name: 'Watchlist' });
      expect(c1?.ok).toBe(true);
      expect(c2?.ok).toBe(true);
      if (!c1?.ok || !c2?.ok) return;
      expect(changedCount).toBe(beforeCount + 3);

      const list1: VodCollectionRecord[] = (await h.bridge.listCollections?.()) ?? [];
      expect(list1.map((c) => c.name)).toEqual(['Classics', 'Watchlist']);

      const renamed = await h.bridge.renameCollection?.(c1.value.id, 'Silent Classics');
      expect(renamed?.ok).toBe(true);
      if (renamed?.ok) expect(renamed.value.name).toBe('Silent Classics');

      const reorderedCols = await h.bridge.reorderCollections?.([c2.value.id, c1.value.id]);
      expect(reorderedCols?.ok).toBe(true);
      if (reorderedCols?.ok) {
        expect(reorderedCols.value.map((c) => c.id)).toEqual([c2.value.id, c1.value.id]);
      }

      expect((await h.bridge.addItemToCollection?.(c1.value.id, metropolisKey, 'movie'))?.ok).toBe(
        true,
      );
      expect((await h.bridge.addItemToCollection?.(c1.value.id, seriesKey, 'series'))?.ok).toBe(
        true,
      );
      expect(await h.bridge.listCollectionsForItem?.(metropolisKey)).toEqual([c1.value.id]);

      const itemsBeforeReorder = (await h.bridge.listCollectionItems?.(c1.value.id)) ?? [];
      expect(itemsBeforeReorder.map((i) => i.key)).toEqual([metropolisKey, seriesKey]);

      expect(
        (await h.bridge.reorderCollectionItems?.(c1.value.id, [seriesKey, metropolisKey]))?.ok,
      ).toBe(true);
      const itemsAfterReorder = (await h.bridge.listCollectionItems?.(c1.value.id)) ?? [];
      expect(itemsAfterReorder.map((i) => i.key)).toEqual([seriesKey, metropolisKey]);

      // Parental lock filters locked items out of listCollectionItems unless unlocked
      await h.bridge.updateParentalSettings?.({ enabled: true });
      await h.bridge.setParentalLock?.(
        {
          sourceId: added.value.id,
          targetKind: 'item',
          itemKind: 'movie',
          targetKey: metropolisKey,
        },
        true,
      );
      const filteredItems =
        (await h.bridge.listCollectionItems?.(c1.value.id, { parentalUnlocked: false })) ?? [];
      expect(filteredItems.map((i) => i.key)).toEqual([seriesKey]);
      const unlockedItems =
        (await h.bridge.listCollectionItems?.(c1.value.id, { parentalUnlocked: true })) ?? [];
      expect(unlockedItems.map((i) => i.key)).toEqual([seriesKey, metropolisKey]);

      expect((await h.bridge.removeItemFromCollection?.(c1.value.id, seriesKey))?.ok).toBe(true);
      expect(await h.bridge.listCollectionsForItem?.(seriesKey)).toEqual([]);

      expect((await h.bridge.deleteCollection?.(c2.value.id))?.ok).toBe(true);
      const remaining = (await h.bridge.listCollections?.()) ?? [];
      expect(remaining.map((c) => c.id)).toEqual([c1.value.id]);
    } finally {
      offChanged();
      await h.shutdown();
    }
  });

  it('rejects malicious Wave F5B payloads in preload and directly on worker MessagePort', async () => {
    const h = createEndToEndHarness(makeStalkerFetch());
    try {
      await h.ready;
      await h.bridge.open();

      const badCreate = await h.bridge.createCollection?.({ name: 'Bad\nName' });
      expect(badCreate?.ok).toBe(false);

      const badStalker = await h.bridge.addSource({
        kind: 'stalker',
        name: 'Bad MAC',
        portalUrl: 'http://portal.example.test/c/',
        mac: 'not-a-mac',
      });
      expect(badStalker.ok).toBe(false);

      const fault1 = await h.sendRawToWorker({
        type: 'call',
        reqId: 951,
        call: {
          method: 'enrichVodItem',
          itemKey: 'x:s1:movie:1',
          opts: { enabled: true, nowMs: 1_700_000_000_000 },
        },
      });
      expect(fault1).toMatchObject({
        type: 'fault',
        reqId: 951,
        error: { category: 'source-format', code: 'invalid-request' },
      });

      const fault2 = await h.sendRawToWorker({
        type: 'call',
        reqId: 952,
        call: {
          method: 'addItemToCollection',
          collectionId: 'vc_1',
          itemKey: 'x:s1:live:1',
          kind: 'live',
        },
      });
      expect(fault2).toMatchObject({
        type: 'fault',
        reqId: 952,
        error: { category: 'source-format', code: 'invalid-request' },
      });

      const fault3 = await h.sendRawToWorker({
        type: 'call',
        reqId: 953,
        call: {
          method: 'addSource',
          input: {
            kind: 'stalker',
            name: 'File Portal',
            portalUrl: 'file:///etc/passwd',
            mac: '00:1A:79:00:00:01',
          },
        },
      });
      expect(fault3).toMatchObject({
        type: 'fault',
        reqId: 953,
        error: { category: 'source-format', code: 'invalid-request' },
      });
    } finally {
      await h.shutdown();
    }
  });
});
