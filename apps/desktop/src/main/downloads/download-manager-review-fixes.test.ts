import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DownloadRecord, ok } from '@elv/domain';
import { createConnectionTracker } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogClientMessage } from '../../shared/catalog-ipc.ts';
import { MAX_DOWNLOAD_RECORDS } from '../../shared/downloads-ipc.ts';
import { createDesktopDownloadDeps } from './desktop-download-deps.ts';
import { createDesktopDownloadManager, type DesktopDownloadManager } from './download-manager.ts';

const tempDirs: string[] = [];
const managers: DesktopDownloadManager[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'elv-dl-rev-'));
  tempDirs.push(dir);
  return dir;
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
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Track Q3-B whole-branch review regression tests', () => {
  it('[Major #4] rejects pending port RPCs on port close, worker exit, rpcTimeoutMs, and AbortSignal without hanging', async () => {
    const disconnectClient = vi.fn();
    let emitClose: (() => void) | undefined;
    let emitWorkerExit: ((code: number) => void) | undefined;
    let closeCount = 0;

    const makeCoordinator = (mode: 'close' | 'exit' | 'hang') => ({
      connectClient: async () => {
        const messageListeners = new Set<(ev: { readonly data: unknown }) => void>();
        const closeListeners = new Set<() => void>();
        emitClose = () => {
          for (const l of [...closeListeners]) l();
        };
        return {
          clientId: 1,
          rendererPort: {
            on: (
              event: 'message' | 'close',
              listener: ((ev: { readonly data: unknown }) => void) | (() => void),
            ) => {
              if (event === 'close') closeListeners.add(listener as () => void);
              else messageListeners.add(listener as (ev: { readonly data: unknown }) => void);
            },
            off: (
              event: 'message' | 'close',
              listener: ((ev: { readonly data: unknown }) => void) | (() => void),
            ) => {
              if (event === 'close') closeListeners.delete(listener as () => void);
              else messageListeners.delete(listener as (ev: { readonly data: unknown }) => void);
            },
            postMessage: (_msg: CatalogClientMessage) => {
              if (mode === 'close') {
                queueMicrotask(() => emitClose?.());
              } else if (mode === 'exit') {
                queueMicrotask(() => emitWorkerExit?.(1));
              }
            },
            start: () => undefined,
            close: () => {
              closeCount += 1;
              messageListeners.clear();
              closeListeners.clear();
            },
          },
        };
      },
      disconnectClient,
      onUnexpectedExit: (listener: (code: number) => void) => {
        emitWorkerExit = listener;
        return () => {
          if (emitWorkerExit === listener) emitWorkerExit = undefined;
        };
      },
    });

    // 1. Port 'close' event rejects immediately.
    const depsClose = createDesktopDownloadDeps({
      getCoordinator: () => makeCoordinator('close'),
      rpcTimeoutMs: 5_000,
    });
    const resClose = await depsClose.resolveStream('ep:1', 'src-1');
    expect(resClose.ok).toBe(false);

    // 2. Worker unexpected exit rejects immediately.
    const depsExit = createDesktopDownloadDeps({
      getCoordinator: () => makeCoordinator('exit'),
      rpcTimeoutMs: 5_000,
    });
    const resExit = await depsExit.resolveStream('ep:2', 'src-1');
    expect(resExit.ok).toBe(false);

    // 3. Explicit rpcTimeoutMs rejects hung worker calls cleanly.
    const depsTimeout = createDesktopDownloadDeps({
      getCoordinator: () => makeCoordinator('hang'),
      rpcTimeoutMs: 40,
    });
    const resTimeout = await depsTimeout.resolveStream('ep:3', 'src-1');
    expect(resTimeout.ok).toBe(false);

    // 4. AbortSignal cancels in-flight resolveStream immediately.
    const depsAbort = createDesktopDownloadDeps({
      getCoordinator: () => makeCoordinator('hang'),
      rpcTimeoutMs: 5_000,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const resAbort = await depsAbort.resolveStream('ep:4', 'src-1', ac.signal);
    expect(resAbort.ok).toBe(false);
    expect(disconnectClient).toHaveBeenCalledTimes(4);
    expect(closeCount).toBe(4);
  });

  it('[Major #4] download-runner times out wedged resolveStream and unblocks cancel/dispose immediately', async () => {
    const downloadsDir = await makeTempDir();
    let seenSignalAborted = false;
    const manager = createDesktopDownloadManager({
      downloadsDir,
      idleTimeoutMs: 60,
      progressThrottleMs: 0,
      lookup: async () => ['93.184.216.34'],
      resolveStream: async (itemKey, _sourceId, signal) => {
        if (itemKey === 'ep:wedged') {
          return new Promise(() => {
            signal?.addEventListener('abort', () => {
              seenSignalAborted = true;
            });
          });
        }
        return ok({ url: 'https://example.test/ok.mp4' });
      },
      fetch: async () =>
        new Response(new Uint8Array(8).fill(0x55), {
          status: 200,
          headers: { 'content-length': '8' },
        }),
    });
    managers.push(manager);

    await manager.enqueueBatch([
      { sourceId: 'src-1', itemKey: 'ep:wedged', kind: 'episode', title: 'Wedged Resolve' },
      { sourceId: 'src-1', itemKey: 'ep:next', kind: 'episode', title: 'Next Episode' },
    ]);

    const wedgedRec = await waitForRecord(manager, 'ep:wedged', (r) => r?.status === 'failed');
    expect(wedgedRec?.errorCode).toBe('download-stall-timeout');
    expect(seenSignalAborted).toBe(true);

    const nextRec = await waitForRecord(manager, 'ep:next', (r) => r?.status === 'completed');
    expect(nextRec?.status).toBe('completed');

    // Cancel while resolveStream is wedged must settle immediately instead of waiting for idleTimeoutMs.
    const cancelDir = await makeTempDir();
    let resolveStarted!: () => void;
    const resolveStartedReady = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const cancelMgr = createDesktopDownloadManager({
      downloadsDir: cancelDir,
      idleTimeoutMs: 10_000,
      progressThrottleMs: 0,
      resolveStream: async () => {
        resolveStarted();
        return new Promise(() => {
          // Never resolves.
        });
      },
    });
    managers.push(cancelMgr);

    await cancelMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'ep:cancel-resolve',
      kind: 'episode',
      title: 'Cancel Resolve',
    });
    await resolveStartedReady;
    const startMs = Date.now();
    await cancelMgr.cancel('ep:cancel-resolve');
    expect(Date.now() - startMs).toBeLessThan(2_000);
    expect((await cancelMgr.get('ep:cancel-resolve'))?.status).toBe('canceled');
  });

  it('[Major #5] serializes concurrent enqueue and enqueueBatch calls so records.size never exceeds MAX_DOWNLOAD_RECORDS', async () => {
    const downloadsDir = await makeTempDir();
    const seed: DownloadRecord[] = Array.from({ length: MAX_DOWNLOAD_RECORDS - 2 }, (_, i) => ({
      id: `default::m:${i}`,
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: `m:${i}`,
      kind: 'movie',
      title: `Movie ${i}`,
      localFileName: `m-${i}.mp4`,
      localUri: i === 0 ? 'file:///tmp/m-0.mp4' : null,
      bytesDownloaded: i === 0 ? 10 : 0,
      totalBytes: i === 0 ? 10 : null,
      status: i === 0 ? 'completed' : 'paused',
      createdAt: i + 1,
      updatedAt: i + 1,
    }));
    await writeFile(path.join(downloadsDir, 'index.json'), JSON.stringify(seed), 'utf8');

    const manager = createDesktopDownloadManager({
      downloadsDir,
      validatePath: async (_root, target) => {
        await new Promise((r) => setTimeout(r, 20));
        return target.endsWith('m-0.mp4') ? target : null;
      },
    });
    managers.push(manager);
    await manager.hydrate();
    await manager.notifyOnlinePlaybackActive(true);

    // Each batch includes completed m:0 (forcing an async validatePath yield) + 2 new movies racing for the last 2 slots.
    const existingCompleted = {
      sourceId: 'src-1',
      itemKey: 'm:0',
      kind: 'movie' as const,
      title: 'Movie 0',
      streamUrl: 'https://example.test/0.mp4',
    };
    const [r1, r2, r3] = await Promise.all([
      manager.enqueueBatch([
        existingCompleted,
        {
          sourceId: 'src-1',
          itemKey: 'm:race-1',
          kind: 'movie',
          title: 'Race 1',
          streamUrl: 'https://example.test/1.mp4',
        },
        {
          sourceId: 'src-1',
          itemKey: 'm:race-2',
          kind: 'movie',
          title: 'Race 2',
          streamUrl: 'https://example.test/2.mp4',
        },
      ]),
      manager.enqueueBatch([
        existingCompleted,
        {
          sourceId: 'src-1',
          itemKey: 'm:race-3',
          kind: 'movie',
          title: 'Race 3',
          streamUrl: 'https://example.test/3.mp4',
        },
      ]),
      manager.enqueue({
        sourceId: 'src-1',
        itemKey: 'm:race-4',
        kind: 'movie',
        title: 'Race 4',
        streamUrl: 'https://example.test/4.mp4',
      }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('download-queue-full');
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('download-queue-full');
    expect((await manager.list()).length).toBe(MAX_DOWNLOAD_RECORDS);

    // Concurrent dispose() during an in-flight enqueueBatch must fail cleanly with downloads-disposed.
    const disposeDir = await makeTempDir();
    let enteredValidate!: () => void;
    const validateReady = new Promise<void>((resolve) => {
      enteredValidate = resolve;
    });
    let releaseValidate!: () => void;
    const validateGate = new Promise<void>((resolve) => {
      releaseValidate = resolve;
    });
    await writeFile(
      path.join(disposeDir, 'index.json'),
      JSON.stringify([
        {
          id: 'default::m:keep',
          profileId: 'default',
          sourceId: 'src-1',
          itemKey: 'm:keep',
          kind: 'movie',
          title: 'Keep',
          localFileName: 'keep.mp4',
          localUri: 'file:///tmp/keep.mp4',
          bytesDownloaded: 10,
          totalBytes: 10,
          status: 'completed',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      'utf8',
    );
    await writeFile(path.join(disposeDir, 'keep.mp4'), Buffer.alloc(10, 1));
    const disposeMgr = createDesktopDownloadManager({
      downloadsDir: disposeDir,
      validatePath: async (_root, target) => {
        enteredValidate();
        await validateGate;
        return target;
      },
    });
    managers.push(disposeMgr);
    await disposeMgr.hydrate();

    const pendingBatch = disposeMgr.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'm:keep',
        kind: 'movie',
        title: 'Keep',
        streamUrl: 'https://example.test/keep.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'm:after-dispose',
        kind: 'movie',
        title: 'After Dispose',
        streamUrl: 'https://example.test/after.mp4',
      },
    ]);
    await validateReady;
    const disposePromise = disposeMgr.dispose();
    releaseValidate();
    const [batchAfterDispose] = await Promise.all([pendingBatch, disposePromise]);
    expect(batchAfterDispose.ok).toBe(false);
    if (!batchAfterDispose.ok) expect(batchAfterDispose.error.code).toBe('downloads-disposed');
    expect(await disposeMgr.get('m:after-dispose')).toBeNull();
  });

  it('[Major #7] clears stale resolved URL on insufficient disk space and cancels late-resolving Response.body', async () => {
    // 1. Insufficient disk space must drop cached resolved stream URL so resume re-resolves a fresh token.
    let freeBytes = 300 * 1024 * 1024;
    let resolveCalls = 0;
    const downloadsDir = await makeTempDir();
    const diskMgr = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      lookup: async () => ['93.184.216.34'],
      checkFreeSpace: async () => freeBytes,
      resolveStream: async () => {
        resolveCalls += 1;
        return ok({ url: `https://example.test/token-${resolveCalls}/ep.mp4` });
      },
      fetch: async (input) => {
        if (String(input).includes('token-1')) {
          return new Response(new ReadableStream<Uint8Array>(), {
            status: 200,
            headers: { 'content-length': String(250 * 1024 * 1024) },
          });
        }
        return new Response(new Uint8Array(12).fill(0x2a), {
          status: 200,
          headers: { 'content-length': '12' },
        });
      },
    });
    managers.push(diskMgr);

    await diskMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'ep:disk-retry',
      kind: 'episode',
      title: 'Disk Retry',
    });
    const failed = await waitForRecord(diskMgr, 'ep:disk-retry', (r) => r?.status === 'failed');
    expect(failed?.errorCode).toBe('insufficient-disk-space');
    expect(resolveCalls).toBe(1);

    // Free up disk space and resume -> must call resolveStream a second time for a fresh token!
    freeBytes = 2 * 1024 * 1024 * 1024;
    const resumed = await diskMgr.resume('ep:disk-retry');
    expect(resumed.ok).toBe(true);
    const done = await waitForRecord(diskMgr, 'ep:disk-retry', (r) => r?.status === 'completed');
    expect(done?.status).toBe('completed');
    expect(resolveCalls).toBe(2);

    // 2. Late-resolving fetch after stall-timeout must cancel its Response.body so sockets never leak.
    let resolveLateFetch!: (res: Response) => void;
    let lateBodyCanceled = false;
    const lateDir = await makeTempDir();
    const lateMgr = createDesktopDownloadManager({
      downloadsDir: lateDir,
      idleTimeoutMs: 40,
      progressThrottleMs: 0,
      lookup: async () => ['93.184.216.34'],
      fetch: async () =>
        new Promise<Response>((resolve) => {
          resolveLateFetch = resolve;
        }),
    });
    managers.push(lateMgr);

    await lateMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'ep:late-res',
      kind: 'episode',
      title: 'Late Response',
      streamUrl: 'https://example.test/late.mp4',
    });
    const timedOut = await waitForRecord(lateMgr, 'ep:late-res', (r) => r?.status === 'failed');
    expect(timedOut?.errorCode).toBe('download-stall-timeout');

    // Now the wedged fetch finally resolves AFTER timeout -> body MUST be canceled automatically!
    resolveLateFetch(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            lateBodyCanceled = true;
          },
        }),
        { status: 200, headers: { 'content-length': '100' } },
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(lateBodyCanceled).toBe(true);
  });

  it('[Minor #12] resolves accountKey from catalog source metadata for pre-resolved single enqueues', async () => {
    const tracker = createConnectionTracker();
    const fingerprint = `fp:${'a'.repeat(64)}`;
    const coordinator = {
      connectClient: async () => {
        const messageListeners = new Set<(ev: { readonly data: unknown }) => void>();
        return {
          clientId: 1,
          rendererPort: {
            on: (event: 'message' | 'close', listener: unknown) => {
              if (event === 'message') {
                messageListeners.add(listener as (ev: { readonly data: unknown }) => void);
              }
            },
            off: (event: 'message' | 'close', listener: unknown) => {
              if (event === 'message') {
                messageListeners.delete(listener as (ev: { readonly data: unknown }) => void);
              }
            },
            postMessage: (msg: CatalogClientMessage) => {
              if (msg.type !== 'call' || msg.call.method !== 'listSources') return;
              queueMicrotask(() => {
                for (const l of messageListeners) {
                  l({
                    data: {
                      type: 'result',
                      reqId: msg.reqId,
                      value: [
                        {
                          id: 'src-preresolved',
                          kind: 'xtream',
                          name: 'Pre-Resolved Source',
                          createdAt: 1,
                          needsImport: false,
                          credentialFingerprint: fingerprint,
                        },
                      ],
                    },
                  });
                }
              });
            },
            start: () => undefined,
            close: () => messageListeners.clear(),
          },
        };
      },
      disconnectClient: vi.fn(),
    };

    const deps = createDesktopDownloadDeps({
      getCoordinator: () => coordinator,
      connectionTracker: tracker,
    });

    // Note: resolveStream was NEVER called (simulating a pre-resolved single enqueue!).
    const lease = await deps.acquireConnection('src-preresolved');
    expect(tracker.activeCount(fingerprint)).toBe(1);
    expect(tracker.activeCount('src-preresolved')).toBe(0);
    lease.release();
    expect(tracker.activeCount(fingerprint)).toBe(0);
  });
});
