import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type DownloadEnqueueInput,
  type DownloadManagerPort,
  type DownloadRecord,
  elvError,
  err,
  isDownloadMediaKind,
  ok,
  type Result,
} from '@elv/domain';
import { isHttpDownloadSourceUrl } from '../../shared/downloads-ipc.ts';
import {
  buildRequestHeaders,
  closeWriteStream,
  INDEX_FILE_NAME,
  inferExtensionFromUrl,
  normalizeProfileId,
  parseContentLength,
  parseContentRange,
  readPartFileSize,
  reconcileDownloadsIndex,
  recordKey,
  safeUnlink,
  writeChunk,
  writeIndexAtomically,
} from './download-io.ts';
import { sanitizeDownloadFileName, validateManagedDownloadPath } from './managed-path.ts';

const DEFAULT_PROGRESS_THROTTLE_MS = 250;

type AbortReason = 'pause' | 'playback-pause' | 'cancel' | 'remove' | 'dispose';

interface DownloadSourceSpec {
  readonly streamUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface ActiveJob {
  readonly key: string;
  readonly controller: AbortController;
  reason?: AbortReason;
  done: Promise<void>;
}

/** Collaborators and options for {@link createDesktopDownloadManager}. */
export interface DesktopDownloadManagerOptions {
  readonly downloadsDir: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly progressThrottleMs?: number;
  readonly log?: (line: string) => void;
  readonly validatePath?: typeof validateManagedDownloadPath;
}

/** Desktop main-process offline VOD download runner implementing {@link DownloadManagerPort}. */
export interface DesktopDownloadManager extends DownloadManagerPort {
  hydrate(): Promise<void>;
  notifyOnlinePlaybackActive(active: boolean): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Creates the Electron main-process streaming offline VOD download manager.
 * Strictly allows `'movie' | 'episode'` kinds over `http:`/`https:`, writes `.part` files with
 * atomic rename on completion, supports HTTP `206` Range resume, persists metadata atomically in
 * `<downloadsDir>/index.json` without credentials, and auto-pauses during online playback.
 */
export function createDesktopDownloadManager(
  options: DesktopDownloadManagerOptions,
): DesktopDownloadManager {
  const { downloadsDir, log } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const validatePath = options.validatePath ?? validateManagedDownloadPath;
  const progressThrottleMs = Math.max(
    0,
    options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS,
  );
  const indexPath = path.join(downloadsDir, INDEX_FILE_NAME);

  const records = new Map<string, DownloadRecord>();
  const sources = new Map<string, DownloadSourceSpec>();
  const listeners = new Set<(records: readonly DownloadRecord[]) => void>();

  let readyPromise: Promise<void> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let persistSeq = 0;
  let activeJob: ActiveJob | null = null;
  let onlinePlaybackActive = false;
  let disposed = false;

  const snapshot = (profileId?: string): readonly DownloadRecord[] => {
    const all = [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
    const filtered = profileId === undefined ? all : all.filter((r) => r.profileId === profileId);
    return filtered.map((r) => Object.freeze({ ...r }));
  };

  const emitChange = (): void => {
    const all = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(all);
      } catch {
        // Isolate subscriber exceptions.
      }
    }
  };

  const persistIndex = (): Promise<void> => {
    const currentRecords = [...records.values()];
    persistSeq += 1;
    const seq = persistSeq;
    persistChain = persistChain.then(() =>
      writeIndexAtomically(downloadsDir, indexPath, currentRecords, seq),
    );
    return persistChain;
  };

  const ensureReady = (): Promise<void> => {
    if (readyPromise === null) {
      readyPromise = reconcileDownloadsIndex(downloadsDir, indexPath, now, log).then(
        async ({ records: loaded, dirty }) => {
          for (const [k, v] of loaded) records.set(k, v);
          if (dirty) await persistIndex();
        },
      );
    }
    return readyPromise;
  };

  const abortActiveJob = async (reason: AbortReason): Promise<void> => {
    const job = activeJob;
    if (job === null) return;
    if (job.reason === undefined) job.reason = reason;
    job.controller.abort();
    await job.done.catch(() => undefined);
  };

  const runDownload = async (job: ActiveJob, source: DownloadSourceSpec): Promise<void> => {
    const current = records.get(job.key);
    if (!current) return;

    const finalPath = path.join(downloadsDir, current.localFileName);
    const partPath = `${finalPath}.part`;
    let writeStream: WriteStream | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      await mkdir(downloadsDir, { recursive: true });
      const existingOffset = await readPartFileSize(partPath);
      const response = await fetchImpl(source.streamUrl, {
        method: 'GET',
        headers: buildRequestHeaders(source.headers, existingOffset),
        signal: job.controller.signal,
        redirect: 'follow',
      });

      if (response.url && !isHttpDownloadSourceUrl(response.url)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('disallowed-redirect-scheme');
      }

      const appendMode = existingOffset > 0 && response.status === 206;
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        const failRecord = records.get(job.key);
        if (failRecord && job.reason === undefined) {
          records.set(job.key, {
            ...failRecord,
            status: 'failed',
            pausedForPlayback: false,
            errorCode: `http-${response.status}`,
            updatedAt: now(),
          });
          log?.(`downloads: download failed with http-${response.status}`);
          await persistIndex();
          emitChange();
        }
        return;
      }

      const contentRange =
        response.status === 206 ? parseContentRange(response.headers.get('content-range')) : null;
      if (
        response.status === 206 &&
        (contentRange === null || contentRange.start !== existingOffset)
      ) {
        await response.body?.cancel().catch(() => undefined);
        const failRecord = records.get(job.key);
        if (failRecord && job.reason === undefined) {
          records.set(job.key, {
            ...failRecord,
            status: 'failed',
            pausedForPlayback: false,
            errorCode: 'download-range-mismatch',
            updatedAt: now(),
          });
          log?.('downloads: download failed (download-range-mismatch)');
          await persistIndex();
          emitChange();
        }
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

      let bytesDownloaded = appendMode ? existingOffset : 0;
      const startRecord = records.get(job.key);
      if (startRecord) {
        records.set(job.key, {
          ...startRecord,
          bytesDownloaded,
          totalBytes: totalBytes ?? startRecord.totalBytes,
          updatedAt: now(),
        });
        emitChange();
      }

      writeStream = createWriteStream(partPath, { flags: appendMode ? 'a' : 'w' });
      let lastBroadcastMs = now();

      if (response.body && typeof response.body.getReader === 'function') {
        reader = response.body.getReader();
        for (;;) {
          if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const step = await reader.read();
          if (step.done) break;
          if (step.value && step.value.byteLength > 0) {
            await writeChunk(writeStream, step.value);
            bytesDownloaded += step.value.byteLength;
            const currentTs = now();
            const liveRec = records.get(job.key);
            if (liveRec) {
              records.set(job.key, {
                ...liveRec,
                bytesDownloaded,
                totalBytes: totalBytes ?? liveRec.totalBytes,
                updatedAt: currentTs,
              });
            }
            if (currentTs - lastBroadcastMs >= progressThrottleMs) {
              lastBroadcastMs = currentTs;
              emitChange();
            }
          }
        }
      } else {
        const buf = new Uint8Array(await response.arrayBuffer());
        if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (buf.byteLength > 0) {
          await writeChunk(writeStream, buf);
          bytesDownloaded += buf.byteLength;
        }
      }

      if (job.controller.signal.aborted || job.reason !== undefined) {
        throw new DOMException('Aborted', 'AbortError');
      }

      await closeWriteStream(writeStream, false);
      writeStream = null;
      reader = null;

      if (bytesDownloaded <= 0 || (totalBytes !== null && bytesDownloaded !== totalBytes)) {
        const errorCode = bytesDownloaded <= 0 ? 'download-empty' : 'download-truncated';
        const failRec = records.get(job.key);
        if (failRec) {
          records.set(job.key, {
            ...failRec,
            status: 'failed',
            localUri: null,
            bytesDownloaded,
            totalBytes: totalBytes ?? failRec.totalBytes,
            pausedForPlayback: false,
            errorCode,
            updatedAt: now(),
            completedAt: null,
          });
          log?.(`downloads: download failed (${errorCode})`);
          await persistIndex();
          emitChange();
        }
        return;
      }

      await rename(partPath, finalPath);
      const verified = await validatePath(downloadsDir, finalPath);
      if (verified === null) {
        await safeUnlink(finalPath);
        const failRec = records.get(job.key);
        if (failRec) {
          records.set(job.key, {
            ...failRec,
            status: 'failed',
            localUri: null,
            bytesDownloaded,
            totalBytes: totalBytes ?? failRec.totalBytes,
            pausedForPlayback: false,
            errorCode: 'download-path-invalid',
            updatedAt: now(),
            completedAt: null,
          });
          log?.('downloads: download failed (download-path-invalid)');
          await persistIndex();
          emitChange();
        }
        return;
      }
      const completedAt = now();
      const completedRec = records.get(job.key);
      if (completedRec) {
        records.set(job.key, {
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
        await persistIndex();
        emitChange();
      }
    } catch (error) {
      if (reader !== null) {
        await reader.cancel().catch(() => undefined);
        reader = null;
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
        records.delete(job.key);
        sources.delete(job.key);
        await persistIndex();
        emitChange();
        return;
      }
      if (reason === 'cancel') {
        await safeUnlink(partPath);
        const rec = records.get(job.key);
        if (rec) {
          records.set(job.key, {
            ...rec,
            status: 'canceled',
            bytesDownloaded: 0,
            pausedForPlayback: false,
            errorCode: null,
            updatedAt: now(),
          });
          await persistIndex();
          emitChange();
        }
        return;
      }
      if (reason === 'pause' || reason === 'playback-pause' || reason === 'dispose') {
        const partBytes = await readPartFileSize(partPath);
        const rec = records.get(job.key);
        if (rec) {
          const resumeImmediately =
            reason === 'playback-pause' && !onlinePlaybackActive && !disposed;
          records.set(job.key, {
            ...rec,
            status: resumeImmediately ? 'queued' : 'paused',
            bytesDownloaded: partBytes,
            pausedForPlayback: reason === 'playback-pause' && !resumeImmediately,
            errorCode: null,
            updatedAt: now(),
          });
          await persistIndex();
          if (reason !== 'dispose') emitChange();
        }
        return;
      }

      const rec = records.get(job.key);
      if (rec) {
        const errorCode =
          error instanceof Error && error.message === 'disallowed-redirect-scheme'
            ? 'invalid-download-url'
            : 'download-network-error';
        records.set(job.key, {
          ...rec,
          status: 'failed',
          pausedForPlayback: false,
          errorCode,
          updatedAt: now(),
        });
        log?.(`downloads: download failed (${errorCode})`);
        await persistIndex();
        emitChange();
      }
    }
  };

  const pumpQueue = (): void => {
    if (disposed || activeJob !== null || onlinePlaybackActive) return;
    const queued = [...records.entries()]
      .filter(([, rec]) => rec.status === 'queued')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    for (const [key, rec] of queued) {
      const source = sources.get(key);
      if (!source) continue;
      records.set(key, {
        ...rec,
        status: 'downloading',
        pausedForPlayback: false,
        errorCode: null,
        updatedAt: now(),
      });
      void persistIndex();
      emitChange();

      const job: ActiveJob = {
        key,
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      activeJob = job;
      job.done = runDownload(job, source).finally(() => {
        if (activeJob === job) activeJob = null;
        if (!disposed && !onlinePlaybackActive) pumpQueue();
      });
      return;
    }
  };

  return {
    supported: true,

    async hydrate(): Promise<void> {
      await ensureReady();
    },

    async list(profileId?: string): Promise<readonly DownloadRecord[]> {
      await ensureReady();
      return snapshot(profileId === undefined ? undefined : normalizeProfileId(profileId));
    },

    async get(itemKey: string, profileId?: string): Promise<DownloadRecord | null> {
      await ensureReady();
      const found = records.get(recordKey(normalizeProfileId(profileId), itemKey));
      return found ? Object.freeze({ ...found }) : null;
    },

    async enqueue(input: DownloadEnqueueInput): Promise<Result<DownloadRecord>> {
      await ensureReady();
      if (disposed) {
        return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
      }
      if (!isDownloadMediaKind(input.kind)) {
        return err(
          elvError(
            'playback',
            'download-kind-not-allowed',
            'only movie and episode items can be downloaded offline',
          ),
        );
      }
      if (!isHttpDownloadSourceUrl(input.streamUrl)) {
        return err(
          elvError('playback', 'invalid-download-url', 'only http and https URLs are allowed'),
        );
      }

      const profileId = normalizeProfileId(input.profileId);
      const key = recordKey(profileId, input.itemKey);
      const existing = records.get(key);
      if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
        return ok(Object.freeze({ ...existing }));
      }
      if (existing && existing.status === 'completed') {
        const verified = await validatePath(
          downloadsDir,
          path.join(downloadsDir, existing.localFileName),
        );
        if (verified !== null) return ok(Object.freeze({ ...existing }));
      }

      const ext = input.containerExtension ?? inferExtensionFromUrl(input.streamUrl);
      const localFileName =
        existing?.localFileName ?? sanitizeDownloadFileName(`${profileId}_${input.itemKey}`, ext);
      const partPath = path.join(downloadsDir, `${localFileName}.part`);
      if (existing && existing.status !== 'paused') {
        await safeUnlink(partPath);
      }

      const preservedBytes =
        existing && existing.status === 'paused' ? await readPartFileSize(partPath) : 0;
      const latest = records.get(key);
      if (latest && (latest.status === 'downloading' || latest.status === 'queued')) {
        return ok(Object.freeze({ ...latest }));
      }
      const ts = now();

      const nextRecord: DownloadRecord = {
        id: existing?.id ?? key,
        profileId,
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        seriesTitle: input.seriesTitle ?? null,
        season: input.season ?? null,
        episodeNum: input.episodeNum ?? null,
        poster: input.poster ?? null,
        localFileName,
        localUri: null,
        bytesDownloaded: preservedBytes,
        totalBytes: existing?.status === 'paused' ? existing.totalBytes : null,
        status: 'queued',
        pausedForPlayback: false,
        errorCode: null,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        completedAt: null,
      };

      sources.set(key, {
        streamUrl: input.streamUrl,
        headers: input.headers ? { ...input.headers } : {},
      });
      records.set(key, nextRecord);
      await persistIndex();
      emitChange();
      pumpQueue();
      return ok(Object.freeze({ ...(records.get(key) ?? nextRecord) }));
    },

    async pause(itemKey: string, profileId?: string): Promise<Result<void>> {
      await ensureReady();
      const key = recordKey(normalizeProfileId(profileId), itemKey);
      const rec = records.get(key);
      if (!rec) return err(elvError('storage', 'download-not-found'));
      if (activeJob?.key === key) {
        await abortActiveJob('pause');
        return ok(undefined);
      }
      if (rec.status === 'queued') {
        records.set(key, { ...rec, status: 'paused', pausedForPlayback: false, updatedAt: now() });
        await persistIndex();
        emitChange();
      }
      return ok(undefined);
    },

    async resume(itemKey: string, profileId?: string): Promise<Result<void>> {
      await ensureReady();
      const key = recordKey(normalizeProfileId(profileId), itemKey);
      const rec = records.get(key);
      if (!rec) return err(elvError('storage', 'download-not-found'));
      if (rec.status === 'completed') return ok(undefined);
      if (!sources.has(key)) {
        return err(
          elvError(
            'playback',
            'download-source-unavailable',
            'download source must be re-enqueued after restart',
          ),
        );
      }
      if (rec.status === 'paused' || rec.status === 'failed' || rec.status === 'canceled') {
        records.set(key, {
          ...rec,
          status: 'queued',
          pausedForPlayback: false,
          errorCode: null,
          updatedAt: now(),
        });
        await persistIndex();
        emitChange();
        pumpQueue();
      }
      return ok(undefined);
    },

    async cancel(itemKey: string, profileId?: string): Promise<Result<void>> {
      await ensureReady();
      const key = recordKey(normalizeProfileId(profileId), itemKey);
      const rec = records.get(key);
      if (!rec) return err(elvError('storage', 'download-not-found'));
      if (activeJob?.key === key) {
        await abortActiveJob('cancel');
        return ok(undefined);
      }
      await safeUnlink(path.join(downloadsDir, `${rec.localFileName}.part`));
      records.set(key, {
        ...rec,
        status: 'canceled',
        bytesDownloaded: 0,
        pausedForPlayback: false,
        errorCode: null,
        updatedAt: now(),
      });
      await persistIndex();
      emitChange();
      return ok(undefined);
    },

    async remove(itemKey: string, profileId?: string): Promise<Result<void>> {
      await ensureReady();
      const key = recordKey(normalizeProfileId(profileId), itemKey);
      const rec = records.get(key);
      if (!rec) return ok(undefined);
      if (activeJob?.key === key) {
        await abortActiveJob('remove');
        return ok(undefined);
      }
      const finalPath = path.join(downloadsDir, rec.localFileName);
      await safeUnlink(`${finalPath}.part`);
      await safeUnlink(finalPath);
      records.delete(key);
      sources.delete(key);
      await persistIndex();
      emitChange();
      return ok(undefined);
    },

    async notifyOnlinePlaybackActive(active: boolean): Promise<void> {
      await ensureReady();
      const next = Boolean(active);
      if (next === onlinePlaybackActive) return;
      onlinePlaybackActive = next;
      if (next) {
        await abortActiveJob('playback-pause');
        return;
      }

      let resumedAny = false;
      const ts = now();
      for (const [key, rec] of records) {
        if (rec.status === 'paused' && rec.pausedForPlayback) {
          records.set(key, { ...rec, status: 'queued', pausedForPlayback: false, updatedAt: ts });
          resumedAny = true;
        }
      }
      if (resumedAny) {
        await persistIndex();
        emitChange();
      }
      pumpQueue();
    },

    subscribe(listener: (records: readonly DownloadRecord[]) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async dispose(): Promise<void> {
      disposed = true;
      await abortActiveJob('dispose');
      await persistChain;
      listeners.clear();
      sources.clear();
    },
  };
}
