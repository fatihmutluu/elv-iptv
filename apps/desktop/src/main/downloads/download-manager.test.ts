import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DownloadRecord } from '@elv/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopDownloadManager, type DesktopDownloadManager } from './download-manager.ts';

const tempDirs: string[] = [];
const servers: Server[] = [];
const managers: DesktopDownloadManager[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'elv-dl-mgr-'));
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

describe('createDesktopDownloadManager', () => {
  it('downloads a movie to completion via atomic .part rename without persisting stream credentials', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x5a);
    const logs: string[] = [];
    const { url } = await startServer((req, res) => {
      expect(req.headers['x-auth-token']).toBe('super-secret-token');
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      log: (line) => logs.push(line),
    });
    managers.push(manager);

    const syntheticCredential = 'fixture-redacted-pass';
    const syntheticPath = ['movie', 'fixture-user', syntheticCredential, '100.mp4'].join('/');
    const enqueued = await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:100',
      kind: 'movie',
      title: 'Test Movie',
      streamUrl: `${url}/${syntheticPath}`,
      headers: { 'X-Auth-Token': 'super-secret-token' },
    });
    expect(enqueued.ok).toBe(true);

    const done = await waitForRecord(manager, 'movie:100', (r) => r?.status === 'completed');
    expect(done).not.toBeNull();
    expect(done?.bytesDownloaded).toBe(payload.length);
    expect(done?.totalBytes).toBe(payload.length);
    expect(done?.localUri?.startsWith('file://')).toBe(true);

    const filePath = fileURLToPath(done?.localUri ?? '');
    const written = await readFile(filePath);
    expect(written.equals(payload)).toBe(true);

    // .part temp file is gone after atomic rename.
    await expect(access(`${filePath}.part`)).rejects.toThrow();

    // index.json must NEVER contain credentials or stream URLs.
    const indexRaw = await readFile(path.join(downloadsDir, 'index.json'), 'utf8');
    expect(indexRaw).not.toContain('super-secret-token');
    expect(indexRaw).not.toContain(syntheticCredential);
    expect(logs.join('\n')).not.toContain(syntheticCredential);
  });

  it('pauses mid-stream and resumes cleanly via HTTP 206 Range request', async () => {
    const totalSize = 96 * 1024;
    const payload = Buffer.alloc(totalSize);
    for (let i = 0; i < totalSize; i += 1) payload[i] = i % 251;

    const seenRanges: Array<string | undefined> = [];
    let releaseFirstChunk: (() => void) | undefined;
    const firstChunkSent = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });

    const { url } = await startServer((req, res) => {
      const range = req.headers.range;
      seenRanges.push(range);
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const slice = payload.subarray(start);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${totalSize - 1}/${totalSize}`,
          'Content-Length': String(slice.length),
        });
        res.end(slice);
        return;
      }

      res.writeHead(200, { 'Content-Length': String(totalSize) });
      res.write(payload.subarray(0, 16 * 1024), () => {
        releaseFirstChunk?.();
      });
      // Keep the connection open so pause aborts mid-stream.
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'ep:201',
      kind: 'episode',
      title: 'Episode 1',
      seriesTitle: 'Demo Series',
      season: 1,
      episodeNum: 1,
      streamUrl: `${url}/series/ep1.mkv`,
    });

    await firstChunkSent;
    await waitForRecord(manager, 'ep:201', (r) => (r?.bytesDownloaded ?? 0) >= 16 * 1024);

    const paused = await manager.pause('ep:201');
    expect(paused.ok).toBe(true);
    const pausedRec = await manager.get('ep:201');
    expect(pausedRec?.status).toBe('paused');
    expect(pausedRec?.bytesDownloaded).toBeGreaterThanOrEqual(16 * 1024);

    const resumed = await manager.resume('ep:201');
    expect(resumed.ok).toBe(true);

    const done = await waitForRecord(manager, 'ep:201', (r) => r?.status === 'completed');
    expect(done?.bytesDownloaded).toBe(totalSize);
    expect(seenRanges.some((r) => typeof r === 'string' && r.startsWith('bytes='))).toBe(true);

    const diskBytes = await readFile(fileURLToPath(done?.localUri ?? ''));
    expect(diskBytes.equals(payload)).toBe(true);
  });

  it('auto-pauses active download on notifyOnlinePlaybackActive(true) and auto-resumes on false', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x33);
    let firstSent!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    let requestCount = 0;

    const { url } = await startServer((req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(200, { 'Content-Length': String(payload.length) });
        res.write(payload.subarray(0, 8 * 1024), () => firstSent());
        return;
      }
      const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const start = match?.[1] ? Number(match[1]) : 0;
      const slice = payload.subarray(start);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        'Content-Length': String(slice.length),
      });
      res.end(slice);
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:auto-pause',
      kind: 'movie',
      title: 'Auto Pause Movie',
      streamUrl: `${url}/movie.mp4`,
    });

    await firstReady;
    await waitForRecord(manager, 'movie:auto-pause', (r) => (r?.bytesDownloaded ?? 0) >= 8 * 1024);

    await manager.notifyOnlinePlaybackActive(true);
    const pausedRec = await manager.get('movie:auto-pause');
    expect(pausedRec?.status).toBe('paused');
    expect(pausedRec?.pausedForPlayback).toBe(true);

    await manager.notifyOnlinePlaybackActive(false);
    const done = await waitForRecord(manager, 'movie:auto-pause', (r) => r?.status === 'completed');
    expect(done?.pausedForPlayback).toBe(false);
    const diskBytes = await readFile(fileURLToPath(done?.localUri ?? ''));
    expect(diskBytes.equals(payload)).toBe(true);
  });

  it('cancels and deletes .part file, and remove deletes completed file and index entry', async () => {
    const payload = Buffer.alloc(32 * 1024, 0x77);
    let stallSent!: () => void;
    const stallReady = new Promise<void>((resolve) => {
      stallSent = resolve;
    });

    const { url } = await startServer((req, res) => {
      if (req.url === '/stall.mp4') {
        res.writeHead(200, { 'Content-Length': String(payload.length) });
        res.write(payload.subarray(0, 4096), () => stallSent());
        return;
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:cancel-me',
      kind: 'movie',
      title: 'Cancel Me',
      streamUrl: `${url}/stall.mp4`,
    });
    await stallReady;
    await waitForRecord(manager, 'movie:cancel-me', (r) => (r?.bytesDownloaded ?? 0) >= 4096);

    const beforeCancel = await manager.get('movie:cancel-me');
    const partPath = path.join(downloadsDir, `${beforeCancel?.localFileName}.part`);
    await manager.cancel('movie:cancel-me');

    const canceled = await manager.get('movie:cancel-me');
    expect(canceled?.status).toBe('canceled');
    await expect(access(partPath)).rejects.toThrow();

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:remove-me',
      kind: 'movie',
      title: 'Remove Me',
      streamUrl: `${url}/fast.mp4`,
    });
    const completed = await waitForRecord(
      manager,
      'movie:remove-me',
      (r) => r?.status === 'completed',
    );
    const finalPath = fileURLToPath(completed?.localUri ?? '');
    await access(finalPath);

    await manager.remove('movie:remove-me');
    expect(await manager.get('movie:remove-me')).toBeNull();
    await expect(access(finalPath)).rejects.toThrow();
  });

  it('rejects live channels and non-HTTP(S) URLs, and enforces sequential downloads (max 1 active)', async () => {
    let activeRequests = 0;
    let maxConcurrent = 0;
    const { url } = await startServer((_req, res) => {
      activeRequests += 1;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      res.writeHead(200, { 'Content-Length': '8' });
      setTimeout(() => {
        activeRequests -= 1;
        res.end(Buffer.from('12345678'));
      }, 40);
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    const liveReject = await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'live:1',
      kind: 'live' as unknown as 'movie',
      title: 'Live Channel',
      streamUrl: `${url}/live.ts`,
    });
    expect(liveReject.ok).toBe(false);

    const fileReject = await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:local',
      kind: 'movie',
      title: 'Local Copy Attempt',
      streamUrl: 'file:///etc/passwd',
    });
    expect(fileReject.ok).toBe(false);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:seq-1',
      kind: 'movie',
      title: 'Seq 1',
      streamUrl: `${url}/1.mp4`,
    });
    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:seq-2',
      kind: 'movie',
      title: 'Seq 2',
      streamUrl: `${url}/2.mp4`,
    });

    await waitForRecord(manager, 'movie:seq-1', (r) => r?.status === 'completed');
    await waitForRecord(manager, 'movie:seq-2', (r) => r?.status === 'completed');
    expect(maxConcurrent).toBe(1);
  });

  it('reconciles stale downloading/queued records to paused and verifies completed files on startup', async () => {
    const downloadsDir = await makeTempDir();
    const partBytes = Buffer.alloc(1024, 0x11);
    await writeFile(path.join(downloadsDir, 'stale-1234.mp4.part'), partBytes);

    const seed: DownloadRecord[] = [
      {
        id: 'default::movie:stale',
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'movie:stale',
        kind: 'movie',
        title: 'Stale Active',
        localFileName: 'stale-1234.mp4',
        localUri: null,
        bytesDownloaded: 10,
        totalBytes: 2048,
        status: 'downloading',
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 'default::movie:missing',
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'movie:missing',
        kind: 'movie',
        title: 'Deleted From Disk',
        localFileName: 'missing-5678.mp4',
        localUri: 'file:///nonexistent/missing-5678.mp4',
        bytesDownloaded: 500,
        totalBytes: 500,
        status: 'completed',
        createdAt: 90,
        updatedAt: 90,
        completedAt: 90,
      },
    ];
    await writeFile(path.join(downloadsDir, 'index.json'), JSON.stringify(seed), 'utf8');

    const manager = createDesktopDownloadManager({ downloadsDir });
    managers.push(manager);
    await manager.hydrate();

    const stale = await manager.get('movie:stale');
    expect(stale?.status).toBe('paused');
    expect(stale?.bytesDownloaded).toBe(partBytes.length);

    const missing = await manager.get('movie:missing');
    expect(missing?.status).toBe('failed');
    expect(missing?.localUri).toBeNull();
    expect(missing?.errorCode).toBe('file-missing');
  });

  it('fails closed on truncated EOF, empty body, mismatched 206 Content-Range, and failed post-rename path validation (P0-3)', async () => {
    const downloadsDir = await makeTempDir();
    const { url } = await startServer((req, res) => {
      if (req.url === '/truncated.mp4') {
        res.writeHead(200, { 'Content-Length': '4096' });
        res.write(Buffer.alloc(1024, 0xaa), () => {
          res.socket?.destroy();
        });
        return;
      }
      if (req.url === '/empty.mp4') {
        res.writeHead(200, { 'Content-Length': '0' });
        res.end();
        return;
      }
      if (req.url === '/bad-range.mp4') {
        // Pretends to return 206 starting at byte 0 even though caller requested Range from offset 1024.
        res.writeHead(206, {
          'Content-Range': 'bytes 0-2047/2048',
          'Content-Length': '2048',
        });
        res.end(Buffer.alloc(2048, 0xbb));
        return;
      }
      res.writeHead(200, { 'Content-Length': '128' });
      res.end(Buffer.alloc(128, 0xcc));
    });

    // 1. Truncated EOF (streaming mock that closes cleanly with fewer bytes than Content-Length).
    const truncatedFetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024).fill(0xaa));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-length': '4096' } },
      );
    const truncDir = await makeTempDir();
    const truncMgr = createDesktopDownloadManager({
      downloadsDir: truncDir,
      fetch: truncatedFetch,
      progressThrottleMs: 0,
    });
    managers.push(truncMgr);

    await truncMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:trunc',
      kind: 'movie',
      title: 'Truncated Movie',
      streamUrl: `${url}/truncated.mp4`,
    });
    const truncRec = await waitForRecord(truncMgr, 'movie:trunc', (r) => r?.status === 'failed');
    expect(truncRec?.errorCode).toBe('download-truncated');
    expect(truncRec?.localUri).toBeNull();
    const truncFinal = path.join(truncDir, truncRec?.localFileName ?? '');
    await expect(access(truncFinal)).rejects.toThrow();
    await access(`${truncFinal}.part`);

    // 2. Empty response body -> fails with 'download-empty' and never creates final file.
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);
    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:empty',
      kind: 'movie',
      title: 'Empty Movie',
      streamUrl: `${url}/empty.mp4`,
    });
    const emptyRec = await waitForRecord(manager, 'movie:empty', (r) => r?.status === 'failed');
    expect(emptyRec?.errorCode).toBe('download-empty');
    expect(emptyRec?.localUri).toBeNull();
    await expect(access(path.join(downloadsDir, emptyRec?.localFileName ?? ''))).rejects.toThrow();

    // 3. HTTP 206 with Content-Range start !== existingOffset fails cleanly without corrupting .part.
    const badRangeDir = await makeTempDir();
    const initialPart = Buffer.alloc(1024, 0x42);
    const seed: DownloadRecord[] = [
      {
        id: 'default::movie:bad-range',
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'movie:bad-range',
        kind: 'movie',
        title: 'Bad Range Movie',
        localFileName: 'bad-range-1111.mp4',
        localUri: null,
        bytesDownloaded: initialPart.length,
        totalBytes: 2048,
        status: 'paused',
        createdAt: 100,
        updatedAt: 100,
      },
    ];
    await writeFile(path.join(badRangeDir, 'bad-range-1111.mp4.part'), initialPart);
    await writeFile(path.join(badRangeDir, 'index.json'), JSON.stringify(seed), 'utf8');

    const badRangeMgr = createDesktopDownloadManager({
      downloadsDir: badRangeDir,
      progressThrottleMs: 0,
    });
    managers.push(badRangeMgr);
    await badRangeMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:bad-range',
      kind: 'movie',
      title: 'Bad Range Movie',
      streamUrl: `${url}/bad-range.mp4`,
    });
    const badRangeRec = await waitForRecord(
      badRangeMgr,
      'movie:bad-range',
      (r) => r?.status === 'failed',
    );
    expect(badRangeRec?.errorCode).toBe('download-range-mismatch');
    const preservedPart = await readFile(path.join(badRangeDir, 'bad-range-1111.mp4.part'));
    expect(preservedPart.equals(initialPart)).toBe(true);
    await expect(access(path.join(badRangeDir, 'bad-range-1111.mp4'))).rejects.toThrow();

    // 4. Failed post-rename path validation fails closed, unlinks finalPath, and never falls back.
    const invalidPathDir = await makeTempDir();
    const invalidPathMgr = createDesktopDownloadManager({
      downloadsDir: invalidPathDir,
      progressThrottleMs: 0,
      validatePath: async () => null,
    });
    managers.push(invalidPathMgr);
    await invalidPathMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:invalid-path',
      kind: 'movie',
      title: 'Invalid Path Movie',
      streamUrl: `${url}/ok.mp4`,
    });
    const invalidRec = await waitForRecord(
      invalidPathMgr,
      'movie:invalid-path',
      (r) => r?.status === 'failed',
    );
    expect(invalidRec?.errorCode).toBe('download-path-invalid');
    expect(invalidRec?.localUri).toBeNull();
    await expect(
      access(path.join(invalidPathDir, invalidRec?.localFileName ?? '')),
    ).rejects.toThrow();
  });

  it('keeps active/queued enqueue idempotent and preserves paused .part on post-restart re-enqueue (P0-4)', async () => {
    const totalSize = 32 * 1024;
    const payload = Buffer.alloc(totalSize);
    for (let i = 0; i < totalSize; i += 1) payload[i] = (i * 7) % 251;

    let firstChunkSent!: () => void;
    const firstChunkReady = new Promise<void>((resolve) => {
      firstChunkSent = resolve;
    });
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    const seenRanges: Array<string | undefined> = [];

    const { url } = await startServer((req, res) => {
      seenRanges.push(req.headers.range);
      if (req.url === '/slow.mp4') {
        res.writeHead(200, { 'Content-Length': String(totalSize) });
        res.write(payload.subarray(0, 8 * 1024), () => {
          firstChunkSent();
        });
        void restGate.then(() => {
          res.end(payload.subarray(8 * 1024));
        });
        return;
      }
      const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const start = match?.[1] ? Number(match[1]) : 0;
      const slice = payload.subarray(start);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${totalSize - 1}/${totalSize}`,
        'Content-Length': String(slice.length),
      });
      res.end(slice);
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:idempotent',
      kind: 'movie',
      title: 'Idempotent Movie',
      streamUrl: `${url}/slow.mp4`,
    });
    await firstChunkReady;
    await waitForRecord(manager, 'movie:idempotent', (r) => (r?.bytesDownloaded ?? 0) >= 8 * 1024);

    // Re-enqueuing while downloading must be idempotent and preserve bytesDownloaded.
    const dup = await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:idempotent',
      kind: 'movie',
      title: 'Idempotent Movie',
      streamUrl: `${url}/slow.mp4`,
    });
    expect(dup.ok).toBe(true);
    if (dup.ok) {
      expect(dup.value.status).toBe('downloading');
      expect(dup.value.bytesDownloaded).toBeGreaterThanOrEqual(8 * 1024);
    }

    // Queue a second item and verify duplicate enqueue while queued is also idempotent.
    const queuedFirst = await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:queued-dup',
      kind: 'movie',
      title: 'Queued Dup',
      streamUrl: `${url}/resume.mp4`,
    });
    expect(queuedFirst.ok).toBe(true);
    const queuedSecond = await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:queued-dup',
      kind: 'movie',
      title: 'Queued Dup Changed',
      streamUrl: `${url}/resume.mp4`,
    });
    expect(queuedSecond.ok).toBe(true);
    if (queuedSecond.ok) {
      expect(queuedSecond.value.status).toBe('queued');
      expect(queuedSecond.value.title).toBe('Queued Dup');
    }

    releaseRest();
    const done1 = await waitForRecord(
      manager,
      'movie:idempotent',
      (r) => r?.status === 'completed',
    );
    expect((await readFile(fileURLToPath(done1?.localUri ?? ''))).equals(payload)).toBe(true);
    await waitForRecord(manager, 'movie:queued-dup', (r) => r?.status === 'completed');

    // Post-restart re-enqueue of a paused record preserves localFileName and .part offset.
    const restartDir = await makeTempDir();
    const partialPrefix = payload.subarray(0, 12 * 1024);
    const preservedName = 'preserved-ep-9999.mp4';
    await writeFile(path.join(restartDir, `${preservedName}.part`), partialPrefix);
    const pausedSeed: DownloadRecord[] = [
      {
        id: 'default::ep:restart',
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'ep:restart',
        kind: 'episode',
        title: 'Restart Episode',
        localFileName: preservedName,
        localUri: null,
        bytesDownloaded: partialPrefix.length,
        totalBytes: totalSize,
        status: 'paused',
        createdAt: 200,
        updatedAt: 200,
      },
    ];
    await writeFile(path.join(restartDir, 'index.json'), JSON.stringify(pausedSeed), 'utf8');

    const restartMgr = createDesktopDownloadManager({
      downloadsDir: restartDir,
      progressThrottleMs: 0,
    });
    managers.push(restartMgr);
    await restartMgr.hydrate();

    const reEnqueued = await restartMgr.enqueue({
      sourceId: 'src-1',
      itemKey: 'ep:restart',
      kind: 'episode',
      title: 'Restart Episode',
      streamUrl: `${url}/resume.mp4`,
      containerExtension: '.mkv',
    });
    expect(reEnqueued.ok).toBe(true);
    if (reEnqueued.ok) {
      expect(reEnqueued.value.localFileName).toBe(preservedName);
      expect(reEnqueued.value.bytesDownloaded).toBe(partialPrefix.length);
    }

    const doneRestart = await waitForRecord(
      restartMgr,
      'ep:restart',
      (r) => r?.status === 'completed',
    );
    expect(doneRestart?.localFileName).toBe(preservedName);
    expect(seenRanges).toContain(`bytes=${partialPrefix.length}-`);
    expect((await readFile(fileURLToPath(doneRestart?.localUri ?? ''))).equals(payload)).toBe(true);
  });

  it('does not stall when notifyOnlinePlaybackActive toggles true -> false rapidly during abort (P1-1)', async () => {
    const payload = Buffer.alloc(32 * 1024, 0x55);
    let firstSent!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    let requests = 0;

    const { url } = await startServer((req, res) => {
      requests += 1;
      if (requests === 1) {
        res.writeHead(200, { 'Content-Length': String(payload.length) });
        res.write(payload.subarray(0, 8 * 1024), () => firstSent());
        return;
      }
      const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const start = match?.[1] ? Number(match[1]) : 0;
      const slice = payload.subarray(start);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        'Content-Length': String(slice.length),
      });
      res.end(slice);
    });

    const downloadsDir = await makeTempDir();
    const manager = createDesktopDownloadManager({ downloadsDir, progressThrottleMs: 0 });
    managers.push(manager);

    await manager.enqueue({
      sourceId: 'src-1',
      itemKey: 'movie:rapid-toggle',
      kind: 'movie',
      title: 'Rapid Toggle Movie',
      streamUrl: `${url}/rapid.mp4`,
    });
    await firstReady;
    await waitForRecord(
      manager,
      'movie:rapid-toggle',
      (r) => (r?.bytesDownloaded ?? 0) >= 8 * 1024,
    );

    // Fire true -> false without awaiting the first call so false arrives while abort is in flight.
    const pausePromise = manager.notifyOnlinePlaybackActive(true);
    const resumePromise = manager.notifyOnlinePlaybackActive(false);
    await Promise.all([pausePromise, resumePromise]);

    const done = await waitForRecord(
      manager,
      'movie:rapid-toggle',
      (r) => r?.status === 'completed',
    );
    expect(done?.pausedForPlayback).toBe(false);
    expect((await readFile(fileURLToPath(done?.localUri ?? ''))).equals(payload)).toBe(true);
  });
});
