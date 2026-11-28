import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DownloadRecord, Result } from '@elv/domain';
import { isHttpDownloadSourceUrl } from '../../shared/downloads-ipc.ts';
import {
  buildRequestHeaders,
  closeWriteStream,
  parseContentLength,
  parseContentRange,
  readPartFileSize,
  runWithStallTimeout,
  safeUnlink,
  writeChunk,
} from './download-io.ts';
import type { validateManagedDownloadPath } from './managed-path.ts';

const MIN_FREE_BYTES = 256 * 1024 * 1024;
const SAFETY_HEADROOM_BYTES = 128 * 1024 * 1024;

/** Abort reason tracked on an active download job to determine cleanup and final record status. */
export type DownloadAbortReason =
  | 'pause'
  | 'playback-pause'
  | 'cancel'
  | 'remove'
  | 'dispose'
  | 'stall-timeout';

/** In-memory resolved stream URL and headers for one queued/active download. */
export interface DownloadSourceSpec {
  readonly streamUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Resolved download stream URL and optional request headers returned by lazy resolution. */
export interface ResolvedDownloadStream {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Runtime handle for the single active download job in {@link createDesktopDownloadManager}. */
export interface ActiveDownloadJob {
  readonly key: string;
  readonly controller: AbortController;
  reason?: DownloadAbortReason;
  done: Promise<void>;
}

/** Internal context shared between `download-manager.ts` and {@link runDownloadTransfer}. */
export interface DownloadRunnerContext {
  readonly downloadsDir: string;
  readonly records: Map<string, DownloadRecord>;
  readonly sources: Map<string, DownloadSourceSpec>;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly fetchForSource?:
    | ((sourceId: string, url: string, init: RequestInit) => Promise<Response>)
    | undefined;
  readonly resolveStream?:
    | ((
        itemKey: string,
        sourceId: string,
        signal?: AbortSignal,
      ) => Promise<Result<ResolvedDownloadStream>>)
    | undefined;
  readonly acquireConnection?:
    | ((
        sourceId: string,
        signal?: AbortSignal,
      ) => Promise<{ release(): void } | null> | { release(): void } | null)
    | undefined;
  readonly checkFreeSpace: (dirPath: string) => Promise<number | null>;
  readonly validatePath: typeof validateManagedDownloadPath;
  readonly idleTimeoutMs: number;
  readonly progressThrottleMs: number;
  readonly now: () => number;
  readonly isDisposed: () => boolean;
  readonly isOnlinePlaybackActive: () => boolean;
  readonly persistIndex: () => Promise<void>;
  readonly emitChange: () => void;
  readonly markFailed: (
    key: string,
    errorCode: string,
    patch?: Partial<DownloadRecord>,
  ) => Promise<void>;
  readonly failForInsufficientDiskSpace: (key: string) => Promise<void>;
}

/**
 * Executes one streaming offline VOD download job: pre-flight & post-headers disk-space checks,
 * lazy stream resolution, connection lease acquisition/release, per-chunk HTTP stall timeout,
 * HTTP 206 Range resume, `.part` atomic rename, and deterministic abort cleanup.
 */
export async function runDownloadTransfer(
  ctx: DownloadRunnerContext,
  job: ActiveDownloadJob,
  initialSource: DownloadSourceSpec | undefined,
): Promise<void> {
  const current = ctx.records.get(job.key);
  if (!current) return;

  const finalPath = path.join(ctx.downloadsDir, current.localFileName);
  const partPath = `${finalPath}.part`;
  let writeStream: WriteStream | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let connectionLease: { release(): void } | null = null;
  const triggerStall = (): void => {
    if (job.reason === undefined) job.reason = 'stall-timeout';
    job.controller.abort();
  };
  const checkAborted = (): void => {
    if (job.controller.signal.aborted || job.reason !== undefined) {
      throw new DOMException('Aborted', 'AbortError');
    }
  };

  try {
    const preFree = await ctx.checkFreeSpace(ctx.downloadsDir).catch(() => null);
    checkAborted();
    if (preFree !== null && preFree < MIN_FREE_BYTES) {
      await ctx.failForInsufficientDiskSpace(job.key);
      return;
    }

    let source = initialSource;
    if (source === undefined) {
      const resolveFn = ctx.resolveStream;
      if (resolveFn === undefined) {
        await ctx.markFailed(job.key, 'download-source-unavailable');
        return;
      }
      let resolved: Result<ResolvedDownloadStream>;
      try {
        resolved = await runWithStallTimeout(
          job.controller.signal,
          ctx.idleTimeoutMs,
          triggerStall,
          () => resolveFn(current.itemKey, current.sourceId, job.controller.signal),
        );
      } catch {
        checkAborted();
        await ctx.markFailed(job.key, 'download-resolve-failed');
        return;
      }
      checkAborted();
      if (!resolved.ok) {
        await ctx.markFailed(job.key, resolved.error.code);
        return;
      }
      if (!isHttpDownloadSourceUrl(resolved.value.url)) {
        await ctx.markFailed(job.key, 'invalid-download-url');
        return;
      }
      source = {
        streamUrl: resolved.value.url,
        headers: resolved.value.headers ? { ...resolved.value.headers } : {},
      };
      ctx.sources.set(job.key, source);
    }

    if (ctx.acquireConnection !== undefined) {
      const acquireFn = ctx.acquireConnection;
      connectionLease =
        (await runWithStallTimeout(
          job.controller.signal,
          ctx.idleTimeoutMs,
          triggerStall,
          () => Promise.resolve(acquireFn(current.sourceId, job.controller.signal)),
          (lateLease) => {
            try {
              lateLease?.release();
            } catch {
              // Isolate late lease release errors.
            }
          },
        )) ?? null;
      checkAborted();
    }

    await mkdir(ctx.downloadsDir, { recursive: true });
    const existingOffset = await readPartFileSize(partPath);
    const requestInit: RequestInit = {
      method: 'GET',
      headers: buildRequestHeaders(source.headers, existingOffset),
      signal: job.controller.signal,
      redirect: 'follow',
    };
    const resolvedSource = source;
    const response = await runWithStallTimeout(
      job.controller.signal,
      ctx.idleTimeoutMs,
      triggerStall,
      () =>
        ctx.fetchForSource !== undefined
          ? ctx.fetchForSource(current.sourceId, resolvedSource.streamUrl, requestInit)
          : ctx.fetchImpl(resolvedSource.streamUrl, requestInit),
      (lateResponse) => {
        void lateResponse.body?.cancel().catch(() => undefined);
      },
    );
    responseBody = response.body;

    if (response.url && !isHttpDownloadSourceUrl(response.url)) {
      await responseBody?.cancel().catch(() => undefined);
      responseBody = null;
      throw new Error('disallowed-redirect-scheme');
    }

    const appendMode = existingOffset > 0 && response.status === 206;
    if (response.status !== 200 && response.status !== 206) {
      await responseBody?.cancel().catch(() => undefined);
      responseBody = null;
      if (job.reason === undefined) await ctx.markFailed(job.key, `http-${response.status}`);
      return;
    }

    const contentRange =
      response.status === 206 ? parseContentRange(response.headers.get('content-range')) : null;
    if (
      response.status === 206 &&
      (contentRange === null || contentRange.start !== existingOffset)
    ) {
      await responseBody?.cancel().catch(() => undefined);
      responseBody = null;
      if (job.reason === undefined) await ctx.markFailed(job.key, 'download-range-mismatch');
      return;
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    const totalFromRange = contentRange?.total ?? null;
    const totalBytes =
      totalFromRange ??
      (contentLength !== null
        ? appendMode
          ? existingOffset + contentLength
          : contentLength
        : null);

    if (totalBytes !== null) {
      const remainingBytes = Math.max(0, totalBytes - (appendMode ? existingOffset : 0));
      const postFree = await ctx.checkFreeSpace(ctx.downloadsDir).catch(() => null);
      checkAborted();
      if (postFree !== null && postFree < remainingBytes + SAFETY_HEADROOM_BYTES) {
        await responseBody?.cancel().catch(() => undefined);
        responseBody = null;
        await ctx.failForInsufficientDiskSpace(job.key);
        return;
      }
    }

    let bytesDownloaded = appendMode ? existingOffset : 0;
    const startRecord = ctx.records.get(job.key);
    if (startRecord) {
      ctx.records.set(job.key, {
        ...startRecord,
        bytesDownloaded,
        totalBytes: totalBytes ?? startRecord.totalBytes,
        updatedAt: ctx.now(),
      });
      ctx.emitChange();
    }

    writeStream = createWriteStream(partPath, { flags: appendMode ? 'a' : 'w' });
    let lastBroadcastMs = ctx.now();

    if (response.body && typeof response.body.getReader === 'function') {
      reader = response.body.getReader();
      responseBody = null;
      const activeReader = reader;
      for (;;) {
        checkAborted();
        const step = await runWithStallTimeout(
          job.controller.signal,
          ctx.idleTimeoutMs,
          triggerStall,
          () => activeReader.read(),
        );
        if (step.done) break;
        if (step.value && step.value.byteLength > 0) {
          await writeChunk(writeStream, step.value);
          bytesDownloaded += step.value.byteLength;
          const currentTs = ctx.now();
          const liveRec = ctx.records.get(job.key);
          if (liveRec) {
            ctx.records.set(job.key, {
              ...liveRec,
              bytesDownloaded,
              totalBytes: totalBytes ?? liveRec.totalBytes,
              updatedAt: currentTs,
            });
          }
          if (currentTs - lastBroadcastMs >= ctx.progressThrottleMs) {
            lastBroadcastMs = currentTs;
            ctx.emitChange();
          }
        }
      }
    } else {
      responseBody = null;
      const buf = new Uint8Array(
        await runWithStallTimeout(job.controller.signal, ctx.idleTimeoutMs, triggerStall, () =>
          response.arrayBuffer(),
        ),
      );
      checkAborted();
      if (buf.byteLength > 0) {
        await writeChunk(writeStream, buf);
        bytesDownloaded += buf.byteLength;
      }
    }

    checkAborted();

    await closeWriteStream(writeStream, false);
    writeStream = null;
    reader = null;

    if (bytesDownloaded <= 0 || (totalBytes !== null && bytesDownloaded !== totalBytes)) {
      const errorCode = bytesDownloaded <= 0 ? 'download-empty' : 'download-truncated';
      await ctx.markFailed(job.key, errorCode, {
        localUri: null,
        bytesDownloaded,
        totalBytes: totalBytes ?? ctx.records.get(job.key)?.totalBytes ?? null,
        completedAt: null,
      });
      return;
    }

    await rename(partPath, finalPath);
    const verified = await ctx.validatePath(ctx.downloadsDir, finalPath);
    if (verified === null) {
      await safeUnlink(finalPath);
      await ctx.markFailed(job.key, 'download-path-invalid', {
        localUri: null,
        bytesDownloaded,
        totalBytes: totalBytes ?? ctx.records.get(job.key)?.totalBytes ?? null,
        completedAt: null,
      });
      return;
    }
    const completedAt = ctx.now();
    const completedRec = ctx.records.get(job.key);
    if (completedRec) {
      ctx.records.set(job.key, {
        ...completedRec,
        status: 'completed',
        localUri: pathToFileURL(verified).toString(),
        bytesDownloaded,
        totalBytes: bytesDownloaded,
        pausedForPlayback: false,
        errorCode: null,
        updatedAt: completedAt,
        completedAt,
      });
      await ctx.persistIndex();
      ctx.emitChange();
    }
  } catch (error) {
    if (reader !== null) {
      await reader.cancel().catch(() => undefined);
      reader = null;
    } else if (responseBody !== null) {
      await responseBody.cancel().catch(() => undefined);
      responseBody = null;
    }
    const reason = job.reason;
    if (writeStream !== null) {
      const discard = reason === 'cancel' || reason === 'remove';
      await closeWriteStream(writeStream, discard);
      writeStream = null;
    }

    if (reason === 'remove') {
      await safeUnlink(partPath);
      await safeUnlink(finalPath);
      ctx.records.delete(job.key);
      ctx.sources.delete(job.key);
      await ctx.persistIndex();
      ctx.emitChange();
      return;
    }
    if (reason === 'cancel') {
      await safeUnlink(partPath);
      const rec = ctx.records.get(job.key);
      if (rec) {
        ctx.records.set(job.key, {
          ...rec,
          status: 'canceled',
          bytesDownloaded: 0,
          pausedForPlayback: false,
          errorCode: null,
          updatedAt: ctx.now(),
        });
        await ctx.persistIndex();
        ctx.emitChange();
      }
      return;
    }
    if (reason === 'pause' || reason === 'playback-pause' || reason === 'dispose') {
      const partBytes = await readPartFileSize(partPath);
      const rec = ctx.records.get(job.key);
      if (rec) {
        const resumeImmediately =
          reason === 'playback-pause' && !ctx.isOnlinePlaybackActive() && !ctx.isDisposed();
        ctx.records.set(job.key, {
          ...rec,
          status: resumeImmediately ? 'queued' : 'paused',
          bytesDownloaded: partBytes,
          pausedForPlayback: reason === 'playback-pause' && !resumeImmediately,
          errorCode: null,
          updatedAt: ctx.now(),
        });
        await ctx.persistIndex();
        if (reason !== 'dispose') ctx.emitChange();
      }
      return;
    }
    if (reason === 'stall-timeout') {
      const partBytes = await readPartFileSize(partPath);
      const rec = ctx.records.get(job.key);
      if (rec) {
        await ctx.markFailed(job.key, 'download-stall-timeout', {
          bytesDownloaded: Math.max(rec.bytesDownloaded, partBytes),
        });
      }
      return;
    }

    const errorCode =
      error instanceof Error && error.message === 'disallowed-redirect-scheme'
        ? 'invalid-download-url'
        : 'download-network-error';
    await ctx.markFailed(job.key, errorCode);
  } finally {
    if (connectionLease !== null) {
      try {
        connectionLease.release();
      } catch {
        // Isolate lease release errors.
      }
      connectionLease = null;
    }
  }
}
