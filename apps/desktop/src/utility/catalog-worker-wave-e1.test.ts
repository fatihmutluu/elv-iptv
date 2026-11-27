import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CleanNameGuideMatch,
  ElvItemEnrichment,
  ElvMatchingSummary,
  ElvQualityMemoryRecord,
  ElvTitleRecord,
  LiveVariantOption,
  MergedVodVariant,
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
import { openWorkerElvContext } from './catalog-worker-wave-e1-ops.ts';

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

function createElvWorkerHarness(opts?: {
  fetchImpl?: FetchLike;
  failElvDbOpen?: boolean;
  logs?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), 'elv-worker-e1-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'catalog.db');
  const elvDbPath = join(dir, 'elv-enrichment.db');

  const openedDbs: Array<{ filePath: string; db: Database.Database }> = [];
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
        return;
      }
      if (msg.type === 'shutdown-complete') {
        parentEmitter.emit('worker-shutdown');
        return;
      }
      if (msg.type === 'secret-request') {
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
        throw new Error('SQLITE_CORRUPT: database disk image is malformed');
      }
      mkdirSync(dirname(filePath), { recursive: true });
      const db = new Database(filePath);
      openedDbs.push({ filePath, db });
      return db;
    },
    fetchImpl: opts?.fetchImpl ?? (fetch as unknown as FetchLike),
    clock: () => 1_700_000_000_000,
    log: (line) => {
      opts?.logs?.push(line);
    },
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

  return { dir, dbPath, elvDbPath, openedDbs, init, sendToWorker, connectClient, shutdown };
}

describe('catalog worker Wave E1 isolated elv-enrichment.db & ELV RPC ops (#511)', () => {
  it('opens isolated elv-enrichment.db beside catalog.db, bridges all ELV RPCs, and closes both DBs on shutdown', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes('/v1/elv/match-batch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            matches: [
              {
                key: 'm:s1:movie:1',
                imdbId: 'tt1375666',
                confidence: 0.96,
                mediaType: 'movie',
                title: {
                  imdbId: 'tt1375666',
                  mediaType: 'movie',
                  originalTitle: 'Inception',
                  englishTitle: 'Inception',
                  localizedTitles: { tr: 'Başlangıç' },
                  year: 2010,
                  rating: 8.8,
                  genres: ['Action', 'Sci-Fi'],
                  posterUrl: 'https://cdn.example/tt1375666.jpg',
                },
              },
            ],
            unmatchedKeys: [],
            pendingKeys: [],
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
            englishTitle: 'Inception',
            year: 2010,
            rating: 8.8,
            synopsis: 'A thief who steals corporate secrets through dream-sharing.',
            synopsisLang: 'en',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const h = createElvWorkerHarness({ fetchImpl: fetchMock as unknown as FetchLike });
    await h.init('https://elv-meta.example.test');

    expect(existsSync(h.dbPath)).toBe(true);
    expect(existsSync(h.elvDbPath)).toBe(true);
    expect(h.openedDbs.map((entry) => entry.filePath)).toEqual([h.dbPath, h.elvDbPath]);

    // Seed catalog.db directly with a movie, two live variants across categories, and a guide channel
    const catalogRaw = h.openedDbs[0]?.db;
    expect(catalogRaw).toBeDefined();
    catalogRaw?.exec(`
      INSERT INTO sources (id, kind, name, created_at, settings_json, deleting) VALUES ('s1', 'm3u', 'Main Source', 1, '{}', 0);
      INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, version_group_key, year, is_hidden, run_id)
        VALUES ('s1', 'm:s1:movie:1', '1', 'TR: Inception 2010 4K', 'tr inception 2010 4k', 'inception', 'inception|2010', 2010, 0, 1);
      INSERT INTO live (source_id, key, provider_id, num, name, name_fold, sort_title, variant_base_fold, quality_rank, is_hidden, run_id)
        VALUES
          ('s1', 'm:s1:live:1', '1', 1, 'News One 4K', 'news one 4k', 'news one', 'news one', 40, 0, 1),
          ('s1', 'm:s1:live:2', '2', 2, 'News One HD', 'news one hd', 'news one', 'news one', 20, 0, 1);
      INSERT INTO guide_channels (source_id, guide_id, name, name_fold, run_id)
        VALUES ('s1', 'news.one.epg', 'News One', 'news one', 1);
    `);

    const client = h.connectClient();

    // 1. Priority matching via /v1/elv/match-batch
    const prioritySummary = await client.call<ElvMatchingSummary>({
      method: 'enrichElvPriorityKeys',
      itemKeys: ['m:s1:movie:1'],
      opts: { lang: 'en' },
    });
    expect(prioritySummary).toEqual({
      scanned: 1,
      layer1Matched: 0,
      remoteMatched: 1,
      skipped: 0,
      aborted: false,
    });

    // 2. Enrichment lookup returns plain Record over IPC
    const enrichmentMap = await client.call<Record<string, ElvItemEnrichment>>({
      method: 'getElvEnrichmentForKeys',
      itemKeys: ['m:s1:movie:1'],
    });
    expect(enrichmentMap['m:s1:movie:1']?.imdbId).toBe('tt1375666');
    expect(enrichmentMap['m:s1:movie:1']?.title?.originalTitle).toBe('Inception');

    // 3. Title detail fetches from /v1/elv/title/tt1375666 and caches in elv-enrichment.db
    const detail = await client.call<ElvTitleRecord | null>({
      method: 'getElvTitleDetail',
      imdbId: 'tt1375666',
      opts: { lang: 'en' },
    });
    expect(detail?.imdbId).toBe('tt1375666');
    expect(detail?.synopses['en']).toContain('dream-sharing');

    // 4. Quality memory: record fake 4K + variant failure
    const quality = await client.call<ElvQualityMemoryRecord | null>({
      method: 'recordPlaybackQuality',
      input: {
        itemKey: 'm:s1:movie:1',
        actualWidth: 1280,
        actualHeight: 720,
        actualVideoCodec: 'h264',
        claimedLabel: '4K',
      },
    });
    expect(quality?.isFake4k).toBe(true);

    const failure1 = await client.call<ElvQualityMemoryRecord | null>({
      method: 'recordPlaybackVariantFailure',
      itemKey: 'm:s1:live:1',
    });
    const failure2 = await client.call<ElvQualityMemoryRecord | null>({
      method: 'recordPlaybackVariantFailure',
      itemKey: 'm:s1:live:1',
    });
    expect(failure1?.failCount).toBe(1);
    expect(failure2?.failCount).toBe(2);

    // 5. Merged VOD versions & cross-category live variants (unreliable live:1 demoted behind live:2!)
    const merged = await client.call<MergedVodVariant[]>({
      method: 'listMergedVodVersions',
      itemKey: 'm:s1:movie:1',
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.isFake4k).toBe(true);

    const variants = await client.call<LiveVariantOption[]>({
      method: 'listLiveVariants',
      itemKey: 'm:s1:live:1',
      opts: { crossCategory: true },
    });
    expect(variants.map((v) => v.key)).toEqual(['m:s1:live:2', 'm:s1:live:1']);
    expect(variants[1]?.isUnreliable).toBe(true);

    // 6. Clean-name EPG fallback (including excludedSourceIds filtering)
    const guideMatch = await client.call<CleanNameGuideMatch | null>({
      method: 'findGuideChannelByCleanName',
      sourceId: 's1',
      channelName: 'TR: News One 4K HEVC',
    });
    expect(guideMatch?.guideId).toBe('news.one.epg');

    const excludedGuideMatch = await client.call<CleanNameGuideMatch | null>({
      method: 'findGuideChannelByCleanName',
      sourceId: 's1',
      channelName: 'TR: News One 4K HEVC',
      opts: { crossSource: true, excludedSourceIds: ['s1'] },
    });
    expect(excludedGuideMatch).toBeNull();

    // 6b. Alias search IPC round-trip (finds localized Turkish alias "Başlangıç" and respects excludedSourceIds)
    const aliasHits = await client.call<readonly string[]>({
      method: 'searchElvItemKeysByAlias',
      query: 'Başlangıç',
      opts: { kind: 'movie', limit: 20 },
    });
    expect(aliasHits).toEqual(['m:s1:movie:1']);

    const aliasExcluded = await client.call<readonly string[]>({
      method: 'searchElvItemKeysByAlias',
      query: 'Inception',
      opts: { kind: 'movie', excludedSourceIds: ['s1'] },
    });
    expect(aliasExcluded).toEqual([]);

    // 6c. Real-world M3U tvg-id key containing @ and ? passes IPC and persists quality memory
    const atKeyFailure = await client.call<ElvQualityMemoryRecord | null>({
      method: 'recordPlaybackVariantFailure',
      itemKey: 'm:s1:live:t:cnn.us@hd?backup=1',
    });
    expect(atKeyFailure?.itemKey).toBe('m:s1:live:t:cnn.us@hd?backup=1');
    expect(atKeyFailure?.failCount).toBe(1);

    // 7. Background matching skips already matched item
    const bgSummary = await client.call<ElvMatchingSummary>({
      method: 'runElvBackgroundMatching',
      opts: { lang: 'en', batchSize: 10 },
    });
    expect(bgSummary).toEqual({
      scanned: 1,
      layer1Matched: 0,
      remoteMatched: 0,
      skipped: 1,
      aborted: false,
    });

    // 8. Manual match override + wipe
    await client.call<void>({
      method: 'setElvManualMatch',
      itemKey: 'm:s1:movie:1',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt0133093',
    });
    const manualEnrich = await client.call<Record<string, ElvItemEnrichment>>({
      method: 'getElvEnrichmentForKeys',
      itemKeys: ['m:s1:movie:1'],
    });
    expect(manualEnrich['m:s1:movie:1']?.imdbId).toBe('tt0133093');
    expect(manualEnrich['m:s1:movie:1']?.manualLock).toBe(true);

    await client.call<void>({ method: 'wipeElvEnrichment' });
    const afterWipe = await client.call<Record<string, ElvItemEnrichment>>({
      method: 'getElvEnrichmentForKeys',
      itemKeys: ['m:s1:movie:1'],
    });
    expect(Object.keys(afterWipe)).toHaveLength(0);

    // 9. Shutdown closes BOTH catalog.db and elv-enrichment.db cleanly
    await h.shutdown();
    expect(h.openedDbs[0]?.db.open).toBe(false);
    expect(h.openedDbs[1]?.db.open).toBe(false);
  });

  it('degrades gracefully when elvServerUrl is omitted or invalid (local store still works, no network calls)', async () => {
    const fetchMock = vi.fn();
    const h = createElvWorkerHarness({ fetchImpl: fetchMock as unknown as FetchLike });
    await h.init('not-a-valid-url');

    const client = h.connectClient();
    await client.call<void>({
      method: 'setElvManualMatch',
      itemKey: 'm:s1:movie:1',
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt1375666',
    });
    const enrich = await client.call<Record<string, ElvItemEnrichment>>({
      method: 'getElvEnrichmentForKeys',
      itemKeys: ['m:s1:movie:1'],
    });
    expect(enrich['m:s1:movie:1']?.imdbId).toBe('tt1375666');
    expect(fetchMock).not.toHaveBeenCalled();

    await h.shutdown();
    expect(h.openedDbs.every((entry) => !entry.db.open)).toBe(true);
  });

  it('falls back gracefully without breaking catalog.db when elv-enrichment.db is corrupt or locked', async () => {
    const logs: string[] = [];
    const h = createElvWorkerHarness({ failElvDbOpen: true, logs });
    await h.init('https://elv-meta.example.test');

    expect(existsSync(h.dbPath)).toBe(true);
    expect(h.openedDbs.map((entry) => entry.filePath)).toEqual([h.dbPath]);
    expect(logs.some((line) => line.includes('elv-enrichment.db'))).toBe(true);

    const client = h.connectClient();
    const sources = await client.call<unknown[]>({ method: 'listSources' });
    expect(sources).toEqual([]);
    const enrich = await client.call<Record<string, ElvItemEnrichment>>({
      method: 'getElvEnrichmentForKeys',
      itemKeys: ['m:s1:movie:1'],
    });
    expect(enrich).toEqual({});
    const aliasHits = await client.call<readonly string[]>({
      method: 'searchElvItemKeysByAlias',
      query: 'Inception',
    });
    expect(aliasHits).toEqual([]);

    await h.shutdown();
    expect(h.openedDbs[0]?.db.open).toBe(false);
  });

  it('allows http://127.0.0.1:8787 in non-production dev mode and rejects it in production when VITEST is unset', async () => {
    const prevVitest = process.env['VITEST'];
    const prevNodeEnv = process.env['NODE_ENV'];
    try {
      delete process.env['VITEST'];
      process.env['NODE_ENV'] = 'development';
      const devCtx = await openWorkerElvContext({
        dbPath: ':memory:',
        elvServerUrl: 'http://127.0.0.1:8787',
        openDatabase: (filePath) => new Database(filePath),
        fetchImpl: vi.fn() as unknown as FetchLike,
        clock: () => 1_700_000_000_000,
        log: () => undefined,
      });
      expect(devCtx.elvClient).toBeDefined();
      await devCtx.enrichmentStore?.close();

      process.env['NODE_ENV'] = 'production';
      const prodCtx = await openWorkerElvContext({
        dbPath: ':memory:',
        elvServerUrl: 'http://127.0.0.1:8787',
        openDatabase: (filePath) => new Database(filePath),
        fetchImpl: vi.fn() as unknown as FetchLike,
        clock: () => 1_700_000_000_000,
        log: () => undefined,
      });
      expect(prodCtx.elvClient).toBeUndefined();
      await prodCtx.enrichmentStore?.close();
    } finally {
      if (prevVitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = prevVitest;
      if (prevNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = prevNodeEnv;
    }
  });

  it('activates and clears ELV client dynamically via set-elv-server-url without restart and preserves ItemRow.backdrop + tmdbId over IPC', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes('/v1/elv/match-batch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            matches: [
              {
                key: 'm:s1:movie:1',
                imdbId: 'tt1375666',
                confidence: 0.97,
                mediaType: 'movie',
                title: {
                  imdbId: 'tt1375666',
                  tmdbId: '27205',
                  mediaType: 'movie',
                  originalTitle: 'Inception',
                  year: 2010,
                },
              },
            ],
            unmatchedKeys: [],
            pendingKeys: [],
          }),
        };
      }
      if (input.includes('/v1/elv/title/tt1375666')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            imdbId: 'tt1375666',
            tmdbId: '27205',
            mediaType: 'movie',
            originalTitle: 'Inception',
            director: 'Christopher Nolan',
            synopsis: 'Dream heist.',
            synopsisLang: 'en',
          }),
        };
      }
      if (input.includes('/v1/elv/feeds')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            topPicks: [{ imdbId: 'tt1375666', title: 'Inception', mediaType: 'movie', rank: 1 }],
            movieMeter: [],
            tvMeter: [],
            currentUpcomingTv: [],
            updatedAt: 1_700_000_000_000,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const h = createElvWorkerHarness({ fetchImpl: fetchMock as unknown as FetchLike });
    await h.init(); // Boot with NO elvServerUrl configured!

    const catalogRaw = h.openedDbs[0]?.db;
    catalogRaw?.exec(`
      INSERT INTO sources (id, kind, name, created_at, settings_json, deleting) VALUES ('s1', 'm3u', 'Main', 1, '{}', 0);
      INSERT INTO categories (source_id, kind, provider_id, name, name_fold, position, run_id)
        VALUES ('s1', 'movie', 'cat1', 'Movies', 'movies', 0, 1);
      INSERT INTO movies (source_id, key, provider_id, name, name_fold, sort_title, version_group_key, logo, backdrop, year, is_hidden, run_id)
        VALUES ('s1', 'm:s1:movie:1', '1', 'Inception (2010)', 'inception 2010', 'inception', 'inception|2010', 'https://cdn.example/poster.jpg', 'https://cdn.example/backdrop.jpg', 2010, 0, 1);
      INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
        VALUES ('s1', 'movie', 'm:s1:movie:1', 'cat1', 0, 1);
    `);

    const client = h.connectClient();

    // Backdrop passes cleanly across IPC on browse & itemDetail even while offline
    const pageItems = await client.call<Array<{ key: string; backdrop?: string | null }>>({
      method: 'items',
      categoryId: 's1|movie|cat1',
      offset: 0,
      limit: 10,
    });
    expect(pageItems[0]?.backdrop).toBe('https://cdn.example/backdrop.jpg');

    const itemDetail = await client.call<{ key: string; backdrop?: string | null } | null>({
      method: 'itemDetail',
      itemKey: 'm:s1:movie:1',
    });
    expect(itemDetail?.backdrop).toBe('https://cdn.example/backdrop.jpg');

    // Before set-elv-server-url, remote feeds do nothing (0 network calls)
    expect(await client.call<boolean>({ method: 'refreshElvFeeds' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // Dynamically push set-elv-server-url -> ELV Mode activates immediately on live worker!
    h.sendToWorker({ type: 'set-elv-server-url', elvServerUrl: 'https://elv-meta.example.test' });

    const prio = await client.call<ElvMatchingSummary>({
      method: 'enrichElvPriorityKeys',
      itemKeys: ['m:s1:movie:1'],
      opts: { lang: 'en' },
    });
    expect(prio.remoteMatched).toBe(1);

    const detail = await client.call<ElvTitleRecord | null>({
      method: 'getElvTitleDetail',
      imdbId: 'tt1375666',
      opts: { lang: 'en' },
    });
    expect(detail?.tmdbId).toBe('27205');
    expect(detail?.director).toBe('Christopher Nolan');
    expect(await client.call<boolean>({ method: 'refreshElvFeeds', opts: { force: true } })).toBe(
      true,
    );

    // Clearing server URL dynamically disables remote ELV network calls again
    const callsBeforeClear = fetchMock.mock.calls.length;
    h.sendToWorker({ type: 'set-elv-server-url', elvServerUrl: '' });
    expect(await client.call<boolean>({ method: 'refreshElvFeeds', opts: { force: true } })).toBe(
      false,
    );
    expect(fetchMock.mock.calls.length).toBe(callsBeforeClear);

    await h.shutdown();
  });
});
