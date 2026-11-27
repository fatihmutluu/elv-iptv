import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ElvFranchiseLibraryItem,
  ElvGenreBucket,
  ElvItemEnrichment,
  ElvPersonLibraryItem,
  ElvRecommendedItem,
  ElvSearchCandidate,
  ItemRow,
} from '@elv/data';
import type { FetchLike } from '@elv/domain';
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
  for (const stop of activeShutdowns.splice(0)) {
    await stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createWaveE2WorkerHarness(opts?: { fetchImpl?: FetchLike; failElvDbOpen?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-e2-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');

  const openedDbs: Array<{ filePath: string; db: Database.Database }> = [];
  const parentEmitter = new EventEmitter();
  const secrets = new Map<string, string>();
  let now = 1_700_000_000_000;

  const parentPort: WorkerParentPortLike = {
    on: (event, listener) => {
      parentEmitter.on(event, listener);
    },
    off: (event, listener) => {
      parentEmitter.off(event, listener);
    },
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

  function sendToWorker(msg: MainToWorkerMessage, ports: WorkerClientPortLike[] = []): void {
    parentEmitter.emit('message', { data: msg, ports });
  }

  createCatalogWorkerRuntime({
    parentPort,
    openDatabase: (filePath) => {
      if (opts?.failElvDbOpen && filePath.endsWith('elv-enrichment.db')) {
        throw new Error('SQLITE_CORRUPT');
      }
      mkdirSync(dirname(filePath), { recursive: true });
      const db = new Database(filePath);
      openedDbs.push({ filePath, db });
      return db;
    },
    fetchImpl: opts?.fetchImpl ?? (fetch as unknown as FetchLike),
    clock: () => now,
    log: () => undefined,
  });

  async function init(elvServerUrl?: string): Promise<void> {
    const ready = new Promise<void>((resolve) => parentEmitter.once('worker-ready', resolve));
    sendToWorker({
      type: 'init',
      dbPath,
      ...(elvServerUrl !== undefined ? { elvServerUrl } : {}),
    });
    await ready;
  }

  function connectClient() {
    const pair = new FakePortPair();
    sendToWorker({ type: 'client-port', clientId: 1 }, [pair.workerSide]);
    let nextReqId = 0;
    return {
      call<T>(rpc: Extract<CatalogClientMessage, { type: 'call' }>['call']): Promise<T> {
        const reqId = ++nextReqId;
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
      },
    };
  }

  let closed = false;
  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    const done = new Promise<void>((resolve) => parentEmitter.once('worker-shutdown', resolve));
    sendToWorker({ type: 'shutdown' });
    await done;
  }
  activeShutdowns.push(shutdown);

  return {
    openedDbs,
    init,
    connectClient,
    shutdown,
    advanceClock(ms: number) {
      now += ms;
    },
  };
}

describe('catalog worker Wave E2 discovery & recommendations RPC ops (#512)', () => {
  it('bridges all 8 Wave E2 methods end-to-end across catalog.db, elv-enrichment.db, and /v1/elv/*', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes('/v1/elv/feeds')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            topPicks: [{ imdbId: 'tt0133093', title: 'The Matrix', mediaType: 'movie', rank: 1 }],
            movieMeter: [
              { imdbId: 'tt0234215', title: 'The Matrix Reloaded', mediaType: 'movie', rank: 1 },
            ],
            tvMeter: [],
            currentUpcomingTv: [],
            updatedAt: 1_700_000_000_000,
          }),
        };
      }
      if (input.includes('/v1/elv/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                imdbId: 'tt1375666',
                title: 'Inception',
                year: 2010,
                mediaType: 'movie',
                posterUrl: 'https://cdn.example/tt1375666.jpg',
                stars: 'Leonardo DiCaprio',
              },
            ],
          }),
        };
      }
      if (input.includes('/v1/elv/title/tt1375666')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            imdbId: 'tt1375666',
            mediaType: 'movie',
            originalTitle: 'Inception',
            year: 2010,
            rating: 8.8,
            votes: 2_400_000,
            genres: ['Action', 'Sci-Fi'],
            director: 'Christopher Nolan',
            synopsis: 'Dream heist.',
            synopsisLang: 'en',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const h = createWaveE2WorkerHarness({ fetchImpl: fetchMock as unknown as FetchLike });
    await h.init('https://elv-meta.example.test');

    const catalogRaw = h.openedDbs[0]?.db;
    const elvRaw = h.openedDbs[1]?.db;
    expect(catalogRaw).toBeDefined();
    expect(elvRaw).toBeDefined();

    catalogRaw?.exec(`
      INSERT INTO sources (id, kind, name, created_at, settings_json, deleting)
        VALUES ('s1', 'xtream', 'Main', 1, '{}', 0);
      INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, year, is_hidden, run_id)
        VALUES
          ('s1', 'x:s1:movie:1', '1', 'The Matrix (1999)', 'the matrix 1999', 'matrix', 1999, 0, 1),
          ('s1', 'x:s1:movie:2', '2', 'The Matrix Reloaded (2003)', 'the matrix reloaded 2003', 'matrix reloaded', 2003, 0, 1);
    `);
    elvRaw?.exec(`
      INSERT INTO elv_titles (
        imdb_id, media_type, original_title, year, rating, votes, genres_json,
        director, cast_json, mlt_imdb_ids_json, franchise_key, franchise_name, franchise_order, updated_at
      ) VALUES
        ('tt0133093', 'movie', 'The Matrix', 1999, 8.7, 2000000, '["Action","Sci-Fi"]',
         'Lana Wachowski', '[{"personId":"nm0000206","name":"Keanu Reeves","character":"Neo"}]',
         '["tt0234215"]', 'matrix', 'The Matrix Collection', 1, 1000),
        ('tt0234215', 'movie', 'The Matrix Reloaded', 2003, 7.2, 600000, '["Action","Sci-Fi"]',
         'Lana Wachowski', '[{"personId":"nm0000206","name":"Keanu Reeves","character":"Neo"}]',
         '[]', 'matrix', 'The Matrix Collection', 2, 1000);
      INSERT INTO elv_item_matches (item_key, source_id, media_type, imdb_id, confidence, manual_lock, updated_at)
        VALUES
          ('x:s1:movie:1', 's1', 'movie', 'tt0133093', 0.99, 0, 1000),
          ('x:s1:movie:2', 's1', 'movie', 'tt0234215', 0.98, 0, 1000);
    `);

    const client = h.connectClient();

    // 1. listElvImdbGenres (including profileId / parentalUnlocked forwarding)
    const genres = await client.call<ElvGenreBucket[]>({
      method: 'listElvImdbGenres',
      kind: 'movie',
      opts: { profileId: 'default', parentalUnlocked: false },
    });
    expect(genres.map((g) => `${g.id}:${g.count}`)).toEqual([
      'imdb-genre:Action:2',
      'imdb-genre:Sci-Fi:2',
    ]);

    // 2. listElvItemsByImdbGenre (including sortBy: 'alpha')
    const sciFi = await client.call<ItemRow[]>({
      method: 'listElvItemsByImdbGenre',
      kind: 'movie',
      genre: 'imdb-genre:Sci-Fi',
      opts: { offset: 0, limit: 10, sortBy: 'alpha' },
    });
    expect(sciFi.map((i) => i.key)).toEqual(['x:s1:movie:1', 'x:s1:movie:2']);

    // 3. refreshElvFeeds (first true, second cached false)
    expect(await client.call<boolean>({ method: 'refreshElvFeeds' })).toBe(true);
    expect(await client.call<boolean>({ method: 'refreshElvFeeds' })).toBe(false);
    expect(await client.call<boolean>({ method: 'refreshElvFeeds', opts: { force: true } })).toBe(
      true,
    );

    // 4. getElvRecommendations
    const recs = await client.call<ElvRecommendedItem[]>({
      method: 'getElvRecommendations',
      opts: { profile: 'home', limit: 10 },
    });
    expect(recs.length).toBe(2);
    expect(recs[0]?.enrichment.imdbId).toBe('tt0133093');

    // 5. listElvFranchiseItems
    const franchise = await client.call<ElvFranchiseLibraryItem[]>({
      method: 'listElvFranchiseItems',
      imdbId: 'tt0234215',
    });
    expect(franchise.map((f) => f.enrichment.imdbId)).toEqual(['tt0133093', 'tt0234215']);

    // 6. listElvPersonLibraryItems
    const personItems = await client.call<ElvPersonLibraryItem[]>({
      method: 'listElvPersonLibraryItems',
      person: { personId: 'nm0000206', name: 'Keanu Reeves' },
    });
    expect(personItems).toHaveLength(2);
    expect(personItems[0]?.role).toBe('cast');

    // 7. searchElvMatchCandidates
    const candidates = await client.call<ElvSearchCandidate[]>({
      method: 'searchElvMatchCandidates',
      query: 'Inception',
      mediaType: 'movie',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.imdbId).toBe('tt1375666');

    // 8. applyElvFixMatch
    const fixed = await client.call<ElvItemEnrichment | null>({
      method: 'applyElvFixMatch',
      input: {
        itemKey: 'x:s1:movie:2',
        sourceId: 's1',
        mediaType: 'movie',
        imdbId: 'tt1375666',
        lang: 'en',
      },
    });
    expect(fixed?.imdbId).toBe('tt1375666');
    expect(fixed?.manualLock).toBe(true);
    expect(fixed?.title?.originalTitle).toBe('Inception');

    await h.shutdown();
  });

  it('degrades gracefully on all Wave E2 RPC calls when elv-enrichment.db is unavailable', async () => {
    const h = createWaveE2WorkerHarness({ failElvDbOpen: true });
    await h.init('https://elv-meta.example.test');
    const client = h.connectClient();

    expect(await client.call({ method: 'listElvImdbGenres', kind: 'movie' })).toEqual([]);
    expect(
      await client.call({ method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'Action' }),
    ).toEqual([]);
    expect(
      await client.call({ method: 'getElvRecommendations', opts: { profile: 'home' } }),
    ).toEqual([]);
    expect(await client.call({ method: 'refreshElvFeeds' })).toBe(false);
    expect(await client.call({ method: 'listElvFranchiseItems', imdbId: 'tt0133093' })).toEqual([]);
    expect(
      await client.call({ method: 'listElvPersonLibraryItems', person: { name: 'Keanu Reeves' } }),
    ).toEqual([]);
    expect(
      await client.call({
        method: 'applyElvFixMatch',
        input: { itemKey: 'x:s1:movie:1', sourceId: 's1', mediaType: 'movie', imdbId: 'tt1375666' },
      }),
    ).toBeNull();

    await h.shutdown();
  });
});
