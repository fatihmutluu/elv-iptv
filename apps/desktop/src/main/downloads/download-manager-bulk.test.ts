import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DownloadEnqueueInput, type DownloadRecord, elvError, err, ok } from '@elv/domain';
import { createConnectionTracker } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogClientMessage } from '../../shared/catalog-ipc.ts';
import { MAX_DOWNLOAD_RECORDS } from '../../shared/downloads-ipc.ts';
import { createDesktopDownloadDeps } from './desktop-download-deps.ts';
import { createDesktopDownloadManager, type DesktopDownloadManager } from './download-manager.ts';

const tempDirs: string[] = [];
const servers: Server[] = [];
const managers: DesktopDownloadManager[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'elv-dl-bulk-'));
  tempDirs.push(dir);
  return dir;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind local test server');
  }
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

function waitForRecord(
  manager: DesktopDownloadManager,
  itemKey: string,
  predicate: (rec: DownloadRecord | null) => boolean,
  timeoutMs = 5_000,
): Promise<DownloadRecord | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${itemKey}`));
    }, timeoutMs);

    const check = async (): Promise<void> => {
      const rec = await manager.get(itemKey);
      if (predicate(rec)) {
        clearTimeout(timer);
        off();
        resolve(rec);
      }
    };

    const off = manager.subscribe(() => {
      void check();
    });
    void check();
  });
}

afterEach(async () => {
  for (const mgr of managers.splice(0)) {
    await mgr.dispose();
  }
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('createDesktopDownloadManager bulk hardening (Wave Q3-B)', () => {
  it('persists and restores seriesKey across hydrate and coalesces enqueueBatch emit/persist', async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': '8' });
      res.end(Buffer.from('12345678'));
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    // Pause online playback so pumpQueue does not start immediately — lets us verify exactly ONE batch emit!
    await manager.notifyOnlinePlaybackActive(true);

    const emitSnapshots: Array<readonly DownloadRecord[]> = [];
    const off = manager.subscribe((recs) => emitSnapshots.push(recs));

    const ep1Input: DownloadEnqueueInput = {
      sourceId: 'src-1',
      itemKey: 'x:src-1:episode:1',
      kind: 'episode',
      title: 'Episode 1',
      seriesKey: 'x:src-1:series:42',
      seriesTitle: 'Sample Show',
      season: 1,
      episodeNum: 1,
      streamUrl: `${url}/1.mp4`,
    };
    const batchInputs: DownloadEnqueueInput[] = [
      ep1Input,
      {
        sourceId: 'src-1',
        itemKey: 'x:src-1:episode:2',
        kind: 'episode',
        title: 'Episode 2',
        seriesKey: 'x:src-1:series:42',
        seriesTitle: 'Sample Show',
        season: 1,
        episodeNum: 2,
        streamUrl: `${url}/2.mp4`,
      },
      // Duplicate inside the same batch should be deduplicated cleanly.
      {
        sourceId: 'src-1',
        itemKey: 'x:src-1:episode:2',
        kind: 'episode',
        title: 'Episode 2 Dup',
        seriesKey: 'x:src-1:series:42',
        seriesTitle: 'Sample Show',
        season: 1,
        episodeNum: 2,
        streamUrl: `${url}/2.mp4`,
      },
    ];

    const res = await manager.enqueueBatch(batchInputs);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(2);
      expect(res.value.map((r) => r.seriesKey)).toEqual(['x:src-1:series:42', 'x:src-1:series:42']);
    }
    expect(emitSnapshots).toHaveLength(1);
    expect(emitSnapshots[0]).toHaveLength(2);

    // Second batch containing already-queued items skips them cleanly and adds only the new episode.
    const res2 = await manager.enqueueBatch([
      ep1Input,
      {
        sourceId: 'src-1',
        itemKey: 'x:src-1:episode:3',
        kind: 'episode',
        title: 'Episode 3',
        seriesKey: 'x:src-1:series:42',
        seriesTitle: 'Sample Show',
        season: 1,
        episodeNum: 3,
        streamUrl: `${url}/3.mp4`,
      },
    ]);
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.value).toHaveLength(1);
      expect(res2.value[0]?.itemKey).toBe('x:src-1:episode:3');
    }

    off();
    await manager.notifyOnlinePlaybackActive(false);
    await waitForRecord(manager, 'x:src-1:episode:1', (r) => r?.status === 'completed');
    await waitForRecord(manager, 'x:src-1:episode:2', (r) => r?.status === 'completed');
    await waitForRecord(manager, 'x:src-1:episode:3', (r) => r?.status === 'completed');

    // Re-enqueueing already-completed episodes skips all of them with 0 emits.
    const extraEmits: number[] = [];
    const off2 = manager.subscribe((recs) => extraEmits.push(recs.length));
    const skippedRes = await manager.enqueueBatch([ep1Input]);
    expect(skippedRes.ok).toBe(true);
    if (skippedRes.ok) expect(skippedRes.value).toEqual([]);
    expect(extraEmits).toHaveLength(0);
    off2();

    // Restart manager from persisted index.json and verify seriesKey is restored.
    await manager.dispose();
    const restarted = createDesktopDownloadManager({ downloadsDir });
    managers.push(restarted);
    await restarted.hydrate();
    const restored = await restarted.get('x:src-1:episode:1');
    expect(restored?.status).toBe('completed');
    expect(restored?.seriesKey).toBe('x:src-1:series:42');
  });

  it('enforces MAX_DOWNLOAD_RECORDS before mutating so queue never exceeds IPC cap', async () => {
    const downloadsDir = await makeTempDir();
    const seed: DownloadRecord[] = Array.from({ length: MAX_DOWNLOAD_RECORDS - 1 }, (_, i) => ({
      id: `default::m:${i}`,
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: `m:${i}`,
      kind: 'movie',
      title: `Movie ${i}`,
      localFileName: `m-${i}.mp4`,
      localUri: null,
      bytesDownloaded: 0,
      totalBytes: null,
      status: 'paused',
      createdAt: i + 1,
      updatedAt: i + 1,
    }));
    await writeFile(path.join(downloadsDir, 'index.json'), JSON.stringify(seed), 'utf8');

    const manager = createDesktopDownloadManager({ downloadsDir });
    managers.push(manager);
    await manager.hydrate();

    // Trying to add 2 new records when only 1 slot remains must fail atomically with download-queue-full.
    const overflow = await manager.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'm:new-1',
        kind: 'movie',
        title: 'New 1',
        streamUrl: 'https://example.test/1.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'm:new-2',
        kind: 'movie',
        title: 'New 2',
        streamUrl: 'https://example.test/2.mp4',
      },
    ]);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.category).toBe('storage');
      expect(overflow.error.code).toBe('download-queue-full');
    }
    expect(await manager.get('m:new-1')).toBeNull();
    expect(await manager.get('m:new-2')).toBeNull();
    expect((await manager.list()).length).toBe(MAX_DOWNLOAD_RECORDS - 1);
  });

  it('resolves streams lazily right before each download and supports seamless post-restart resume', async () => {
    const payload = Buffer.alloc(32 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 241;

    const { url } = await startServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const slice = payload.subarray(start);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const resolvedOrder: string[] = [];
    const resolveStream = vi.fn(async (itemKey: string, sourceId: string) => {
      resolvedOrder.push(`${sourceId}:${itemKey}`);
      if (itemKey === 'ep:bad') {
        return err(elvError('network', 'provider-link-failed', 'link unavailable'));
      }
      if (itemKey === 'ep:evil-scheme') {
        return ok({ url: 'file:///etc/passwd' });
      }
      return ok({
        url: `${url}/${encodeURIComponent(itemKey)}.mp4`,
        headers: { 'X-Lazy-Token': 'ok' },
      });
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      resolveStream,
    });
    managers.push(manager);

    await manager.notifyOnlinePlaybackActive(true);
    const batch = await manager.enqueueBatch([
      { sourceId: 'src-1', itemKey: 'ep:1', kind: 'episode', title: 'Ep 1' },
      { sourceId: 'src-1', itemKey: 'ep:bad', kind: 'episode', title: 'Ep Bad' },
      { sourceId: 'src-1', itemKey: 'ep:evil-scheme', kind: 'episode', title: 'Ep Evil' },
      { sourceId: 'src-1', itemKey: 'ep:2', kind: 'episode', title: 'Ep 2' },
    ]);
    expect(batch.ok).toBe(true);
    // Zero upfront resolveStream burst while queued!
    expect(resolveStream).not.toHaveBeenCalled();

    await manager.notifyOnlinePlaybackActive(false);
    const ep1 = await waitForRecord(manager, 'ep:1', (r) => r?.status === 'completed');
    const epBad = await waitForRecord(manager, 'ep:bad', (r) => r?.status === 'failed');
    const epEvil = await waitForRecord(manager, 'ep:evil-scheme', (r) => r?.status === 'failed');
    const ep2 = await waitForRecord(manager, 'ep:2', (r) => r?.status === 'completed');

    expect(ep1?.status).toBe('completed');
    expect(epBad?.errorCode).toBe('provider-link-failed');
    expect(epEvil?.errorCode).toBe('invalid-download-url');
    expect(ep2?.status).toBe('completed');
    expect(resolvedOrder).toEqual([
      'src-1:ep:1',
      'src-1:ep:bad',
      'src-1:ep:evil-scheme',
      'src-1:ep:2',
    ]);

    // Post-restart resume of a paused .part download resolves stream lazily without re-enqueue.
    const restartDir = await makeTempDir();
    const prefix = payload.subarray(0, 8 * 1024);
    const fileName = 'resume-lazy-1234.mp4';
    await writeFile(path.join(restartDir, `${fileName}.part`), prefix);
    await writeFile(
      path.join(restartDir, 'index.json'),
      JSON.stringify([
        {
          id: 'default::ep:restart-lazy',
          profileId: 'default',
          sourceId: 'src-1',
          itemKey: 'ep:restart-lazy',
          kind: 'episode',
          title: 'Restart Lazy',
          seriesKey: 'x:src-1:series:9',
          localFileName: fileName,
          localUri: null,
          bytesDownloaded: prefix.length,
          totalBytes: payload.length,
          status: 'paused',
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      'utf8',
    );

    const restartMgr = createDesktopDownloadManager({
      downloadsDir: restartDir,
      progressThrottleMs: 0,
      resolveStream,
    });
    managers.push(restartMgr);
    await restartMgr.hydrate();

    const resumed = await restartMgr.resume('ep:restart-lazy');
    expect(resumed.ok).toBe(true);
    const completed = await waitForRecord(
      restartMgr,
      'ep:restart-lazy',
      (r) => r?.status === 'completed',
    );
    expect(completed?.seriesKey).toBe('x:src-1:series:9');
    expect((await readFile(fileURLToPath(completed?.localUri ?? ''))).equals(payload)).toBe(true);
  });

  it('guards against low disk space pre-flight and post-headers and pauses remaining queued episodes', async () => {
    // 1. Pre-flight check (< 256 MiB) fails current job and pauses remaining queued items without fetching.
    const preFetch = vi.fn();
    const preDir = await makeTempDir();
    const preMgr = createDesktopDownloadManager({
      downloadsDir: preDir,
      fetch: preFetch as unknown as typeof globalThis.fetch,
      checkFreeSpace: async () => 100 * 1024 * 1024, // 100 MiB < 256 MiB
      progressThrottleMs: 0,
    });
    managers.push(preMgr);

    await preMgr.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'ep:disk-1',
        kind: 'episode',
        title: 'Ep 1',
        streamUrl: 'https://example.test/1.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'ep:disk-2',
        kind: 'episode',
        title: 'Ep 2',
        streamUrl: 'https://example.test/2.mp4',
      },
    ]);

    const failedPre = await waitForRecord(preMgr, 'ep:disk-1', (r) => r?.status === 'failed');
    expect(failedPre?.errorCode).toBe('insufficient-disk-space');
    const pausedPre = await preMgr.get('ep:disk-2');
    expect(pausedPre?.status).toBe('paused');
    expect(preFetch).not.toHaveBeenCalled();

    // 2. Post-headers check: 300 MiB free passes pre-flight (>= 256 MiB), but 250 MiB file + 128 MiB headroom exceeds 300 MiB.
    let bodyCanceled = false;
    const postFetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCanceled = true;
          },
        }),
        { status: 200, headers: { 'content-length': String(250 * 1024 * 1024) } },
      );
    const postDir = await makeTempDir();
    const postMgr = createDesktopDownloadManager({
      downloadsDir: postDir,
      fetch: postFetch,
      lookup: async () => ['93.184.216.34'],
      checkFreeSpace: async () => 300 * 1024 * 1024,
      progressThrottleMs: 0,
    });
    managers.push(postMgr);

    await postMgr.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'ep:big-1',
        kind: 'episode',
        title: 'Big 1',
        streamUrl: 'https://example.test/big1.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'ep:big-2',
        kind: 'episode',
        title: 'Big 2',
        streamUrl: 'https://example.test/big2.mp4',
      },
    ]);

    const failedPost = await waitForRecord(postMgr, 'ep:big-1', (r) => r?.status === 'failed');
    expect(failedPost?.errorCode).toBe('insufficient-disk-space');
    expect(bodyCanceled).toBe(true);
    expect((await postMgr.get('ep:big-2'))?.status).toBe('paused');
  });

  it('fails stalled HTTP header wait or chunk read with download-stall-timeout and advances queue', async () => {
    let calls = 0;
    const mixedFetch: typeof globalThis.fetch = async (input) => {
      calls += 1;
      const urlStr = String(input);
      if (urlStr.includes('stall-headers')) {
        return new Promise<Response>(() => {
          // Never resolves headers.
        });
      }
      if (urlStr.includes('stall-body')) {
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new Uint8Array(1024).fill(0x41));
                return;
              }
              return new Promise<void>(() => {
                // Stalls forever before second chunk.
              });
            },
          }),
          { status: 200, headers: { 'content-length': '4096' } },
        );
      }
      return new Response(new Uint8Array(16).fill(0x7a), {
        status: 200,
        headers: { 'content-length': '16' },
      });
    };

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({
      downloadsDir,
      fetch: mixedFetch,
      lookup: async () => ['93.184.216.34'],
      idleTimeoutMs: 60,
      progressThrottleMs: 0,
    });
    managers.push(manager);

    await manager.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'ep:stall-hdr',
        kind: 'episode',
        title: 'Stall Headers',
        streamUrl: 'https://example.test/stall-headers.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'ep:stall-chunk',
        kind: 'episode',
        title: 'Stall Chunk',
        streamUrl: 'https://example.test/stall-body.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'ep:healthy',
        kind: 'episode',
        title: 'Healthy Ep',
        streamUrl: 'https://example.test/healthy.mp4',
      },
    ]);

    const hdrRec = await waitForRecord(manager, 'ep:stall-hdr', (r) => r?.status === 'failed');
    const chunkRec = await waitForRecord(manager, 'ep:stall-chunk', (r) => r?.status === 'failed');
    const healthyRec = await waitForRecord(manager, 'ep:healthy', (r) => r?.status === 'completed');

    expect(hdrRec?.errorCode).toBe('download-stall-timeout');
    expect(hdrRec?.status).toBe('failed');
    expect(chunkRec?.errorCode).toBe('download-stall-timeout');
    expect(chunkRec?.status).toBe('failed');
    expect(chunkRec?.bytesDownloaded).toBe(1024);
    expect(healthyRec?.status).toBe('completed');
    expect(calls).toBe(3);
  });

  it('routes HTTP through fetchForSource and always releases acquireConnection leases in finally', async () => {
    const events: string[] = [];
    const fetchForSource = vi.fn(async (sourceId: string, url: string) => {
      events.push(`fetch:${sourceId}:${url}`);
      if (url.includes('fail')) {
        return new Response(null, { status: 500 });
      }
      return new Response(new Uint8Array(8).fill(0x22), {
        status: 200,
        headers: { 'content-length': '8' },
      });
    });
    const acquireConnection = vi.fn(async (sourceId: string) => {
      events.push(`acquire:${sourceId}`);
      return {
        release() {
          events.push(`release:${sourceId}`);
        },
      };
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({
      downloadsDir,
      fetchForSource,
      lookup: async () => ['93.184.216.34'],
      acquireConnection,
      progressThrottleMs: 0,
    });
    managers.push(manager);

    await manager.enqueueBatch([
      {
        sourceId: 'src-a',
        itemKey: 'ep:ok',
        kind: 'episode',
        title: 'OK',
        streamUrl: 'https://example.test/ok.mp4',
      },
      {
        sourceId: 'src-b',
        itemKey: 'ep:fail',
        kind: 'episode',
        title: 'Fail',
        streamUrl: 'https://example.test/fail.mp4',
      },
    ]);

    await waitForRecord(manager, 'ep:ok', (r) => r?.status === 'completed');
    await waitForRecord(manager, 'ep:fail', (r) => r?.status === 'failed');

    expect(events).toEqual([
      'acquire:src-a',
      'fetch:src-a:https://example.test/ok.mp4',
      'release:src-a',
      'acquire:src-b',
      'fetch:src-b:https://example.test/fail.mp4',
      'release:src-b',
    ]);
  });

  it('wires resolveStream, per-source transport, and ConnectionTracker in createDesktopDownloadDeps', async () => {
    const tracker = createConnectionTracker();
    const defaultFetch = vi.fn(
      async () =>
        new Response(new Uint8Array(4).fill(1), {
          status: 200,
          headers: { 'content-length': '4' },
        }),
    );
    const legacyFetch = vi.fn(async (url: string) => ({
      status: 200,
      url,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb('5', 'content-length'),
        get: (name: string) => (name.toLowerCase() === 'content-length' ? '5' : null),
        getSetCookie: () => [],
      },
      body: (async function* () {
        yield new Uint8Array([1, 2, 3, 4, 5]);
      })(),
    }));

    const rpcHandler = vi.fn((msg: CatalogClientMessage) => {
      if (msg.type !== 'call') return undefined;
      if (msg.call.method === 'resolveStream') {
        if (msg.call.itemKey === 'ep:legacy') {
          return ok({
            url: 'https://legacy.example.test/ep.mp4',
            headers: { 'user-agent': 'ELV/1.0' },
            accountKey: 'acct-legacy',
            allowLegacyTls: true,
          });
        }
        return ok({
          url: 'https://modern.example.test/ep.mp4',
          headers: {},
          accountKey: 'acct-modern',
        });
      }
      if (msg.call.method === 'listSources') {
        return [
          {
            id: 'src-legacy',
            kind: 'xtream',
            name: 'Legacy',
            createdAt: 1,
            needsImport: false,
            allowLegacyTls: true,
          },
          {
            id: 'src-modern',
            kind: 'xtream',
            name: 'Modern',
            createdAt: 1,
            needsImport: false,
          },
        ];
      }
      return undefined;
    });

    const coordinator = {
      connectClient: async () => {
        const listeners = new Set<(ev: { readonly data: unknown }) => void>();
        return {
          clientId: 1,
          rendererPort: {
            on: (event: 'message' | 'close', listener: unknown) => {
              if (event === 'message') {
                listeners.add(listener as (ev: { readonly data: unknown }) => void);
              }
            },
            off: (event: 'message' | 'close', listener: unknown) => {
              if (event === 'message') {
                listeners.delete(listener as (ev: { readonly data: unknown }) => void);
              }
            },
            postMessage: (msg: CatalogClientMessage) => {
              if (msg.type !== 'call') return;
              const value = rpcHandler(msg);
              queueMicrotask(() => {
                for (const l of listeners) {
                  l({ data: { type: 'result', reqId: msg.reqId, value } });
                }
              });
            },
            start: () => undefined,
            close: () => listeners.clear(),
          },
        };
      },
      disconnectClient: vi.fn(),
    };

    const deps = createDesktopDownloadDeps({
      getCoordinator: () => coordinator,
      connectionTracker: tracker,
      fetch: defaultFetch as unknown as typeof globalThis.fetch,
      httpClientOptions: { legacyFetchImpl: legacyFetch },
    });

    const resolvedLegacy = await deps.resolveStream('ep:legacy', 'src-legacy');
    expect(resolvedLegacy.ok).toBe(true);
    if (resolvedLegacy.ok) {
      expect(resolvedLegacy.value.url).toBe('https://legacy.example.test/ep.mp4');
    }

    const lease = await deps.acquireConnection('src-legacy');
    expect(tracker.activeCount('acct-legacy')).toBe(1);
    lease.release();
    expect(tracker.activeCount('acct-legacy')).toBe(0);

    const legacyRes = await deps.fetchForSource(
      'src-legacy',
      'https://legacy.example.test/ep.mp4',
      { method: 'GET' },
    );
    expect(legacyRes.status).toBe(200);
    expect(legacyRes.url).toBe('https://legacy.example.test/ep.mp4');
    expect(new Uint8Array(await legacyRes.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect(defaultFetch).not.toHaveBeenCalled();

    const modernRes = await deps.fetchForSource(
      'src-modern',
      'https://modern.example.test/ep.mp4',
      { method: 'GET' },
    );
    expect(modernRes.status).toBe(200);
    expect(defaultFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid batches atomically, allows null statfs, and handles custom-transport errors cleanly', async () => {
    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({
      downloadsDir,
      checkFreeSpace: async () => null,
      lookup: async () => ['93.184.216.34'],
      fetch: async () =>
        new Response(new Uint8Array(6).fill(0x11), {
          status: 200,
          headers: { 'content-length': '6' },
        }),
      progressThrottleMs: 0,
    });
    managers.push(manager);

    // Invalid second entry must reject atomically without adding the first entry.
    const badBatch = await manager.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'ep:good',
        kind: 'episode',
        title: 'Good',
        streamUrl: 'https://example.test/good.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'ep:missing-url',
        kind: 'episode',
        title: 'Missing URL Without Resolver',
      },
    ]);
    expect(badBatch.ok).toBe(false);
    expect(await manager.get('ep:good')).toBeNull();

    // Null statfs (unsupported OS/FS) still allows normal download completion.
    const okRes = await manager.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'ep:null-statfs',
        kind: 'episode',
        title: 'Null Statfs',
        streamUrl: 'https://example.test/ok.mp4',
      },
    ]);
    expect(okRes.ok).toBe(true);
    const done = await waitForRecord(manager, 'ep:null-statfs', (r) => r?.status === 'completed');
    expect(done?.bytesDownloaded).toBe(6);

    // Custom transport HTTP 404 maps cleanly back to Response(status: 404) & unavailable coordinator fails cleanly.
    const depsNoCoord = createDesktopDownloadDeps({
      getCoordinator: () => undefined,
      fetch: async () => new Response('ok', { status: 200 }),
    });
    const noCoordRes = await depsNoCoord.resolveStream('ep:1', 'src-1');
    expect(noCoordRes.ok).toBe(false);
    if (!noCoordRes.ok) expect(noCoordRes.error.code).toBe('catalog-unavailable');
    const fallbackFetchRes = await depsNoCoord.fetchForSource(
      'src-1',
      'https://example.test/a.mp4',
      { method: 'GET' },
    );
    expect(fallbackFetchRes.status).toBe(200);
  });
});
