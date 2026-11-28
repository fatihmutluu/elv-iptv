import path from 'node:path';
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
import { isHttpDownloadSourceUrl, MAX_DOWNLOAD_RECORDS } from '../../shared/downloads-ipc.ts';
import {
  defaultCheckFreeSpace,
  INDEX_FILE_NAME,
  inferExtensionFromUrl,
  normalizeProfileId,
  normalizeSeriesKey,
  readPartFileSize,
  reconcileDownloadsIndex,
  recordKey,
  safeUnlink,
  writeIndexAtomically,
} from './download-io.ts';
import {
  type ActiveDownloadJob,
  type DownloadAbortReason,
  type DownloadSourceSpec,
  type ResolvedDownloadStream,
  runDownloadTransfer,
} from './download-runner.ts';
import { sanitizeDownloadFileName, validateManagedDownloadPath } from './managed-path.ts';

export type { ResolvedDownloadStream };

const DEFAULT_PROGRESS_THROTTLE_MS = 250;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Collaborators and options for {@link createDesktopDownloadManager}. */
export interface DesktopDownloadManagerOptions {
  readonly downloadsDir: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly fetchForSource?: (sourceId: string, url: string, init: RequestInit) => Promise<Response>;
  readonly resolveStream?: (
    itemKey: string,
    sourceId: string,
    signal?: AbortSignal,
  ) => Promise<Result<ResolvedDownloadStream>>;
  readonly acquireConnection?: (
    sourceId: string,
    signal?: AbortSignal,
  ) => Promise<{ release(): void } | null> | { release(): void } | null;
  readonly checkFreeSpace?: (dirPath: string) => Promise<number | null>;
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
  readonly progressThrottleMs?: number;
  readonly log?: (line: string) => void;
  readonly validatePath?: typeof validateManagedDownloadPath;
}

/** Desktop main-process offline VOD download runner implementing {@link DownloadManagerPort}. */
export interface DesktopDownloadManager extends DownloadManagerPort {
  enqueueBatch(inputs: readonly DownloadEnqueueInput[]): Promise<Result<readonly DownloadRecord[]>>;
  hydrate(): Promise<void>;
  notifyOnlinePlaybackActive(active: boolean): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Creates the Electron main-process streaming offline VOD download manager.
 * Strictly allows `'movie' | 'episode'` kinds over `http:`/`https:`, writes `.part` files with
 * atomic rename on completion, supports HTTP `206` Range resume, lazy play-time stream resolution,
 * disk-space and stall-timeout guards, per-source transport/connection hooks, and atomic index
 * persistence in `<downloadsDir>/index.json` without credentials.
 */
export function createDesktopDownloadManager(
  options: DesktopDownloadManagerOptions,
): DesktopDownloadManager {
  const { downloadsDir, log, resolveStream, fetchForSource, acquireConnection } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const checkFreeSpace = options.checkFreeSpace ?? defaultCheckFreeSpace;
  const now = options.now ?? (() => Date.now());
  const validatePath = options.validatePath ?? validateManagedDownloadPath;
  const progressThrottleMs = Math.max(
    0,
    options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS,
  );
  const idleTimeoutMs =
    typeof options.idleTimeoutMs === 'number' &&
    Number.isFinite(options.idleTimeoutMs) &&
    options.idleTimeoutMs > 0
      ? options.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS;
  const indexPath = path.join(downloadsDir, INDEX_FILE_NAME);

  const records = new Map<string, DownloadRecord>();
  const sources = new Map<string, DownloadSourceSpec>();
  const listeners = new Set<(records: readonly DownloadRecord[]) => void>();

  let readyPromise: Promise<void> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let enqueueChain: Promise<void> = Promise.resolve();
  let persistSeq = 0;
  let activeJob: ActiveDownloadJob | null = null;
  let onlinePlaybackActive = false;
  let disposed = false;

  const withEnqueueLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = enqueueChain.then(fn, fn);
    enqueueChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

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

  const abortActiveJob = async (reason: DownloadAbortReason): Promise<void> => {
    const job = activeJob;
    if (job === null) return;
    if (job.reason === undefined) job.reason = reason;
    job.controller.abort();
    await job.done.catch(() => undefined);
  };

  const markFailed = async (
    key: string,
    errorCode: string,
    patch?: Partial<DownloadRecord>,
  ): Promise<void> => {
    const rec = records.get(key);
    if (!rec) return;
    if (resolveStream !== undefined) sources.delete(key);
    records.set(key, {
      ...rec,
      ...patch,
      status: 'failed',
      pausedForPlayback: false,
      errorCode,
      updatedAt: now(),
    });
    log?.(`downloads: download failed (${errorCode})`);
    await persistIndex();
    emitChange();
  };

  const failForInsufficientDiskSpace = async (key: string): Promise<void> => {
    const ts = now();
    const rec = records.get(key);
    if (resolveStream !== undefined) sources.delete(key);
    if (rec) {
      records.set(key, {
        ...rec,
        status: 'failed',
        pausedForPlayback: false,
        errorCode: 'insufficient-disk-space',
        updatedAt: ts,
      });
    }
    for (const [otherKey, other] of records) {
      if (otherKey !== key && other.status === 'queued') {
        records.set(otherKey, {
          ...other,
          status: 'paused',
          pausedForPlayback: false,
          updatedAt: ts,
        });
      }
    }
    log?.('downloads: insufficient disk space, pausing remaining queued items');
    await persistIndex();
    emitChange();
  };

  const validateEnqueueInput = (input: DownloadEnqueueInput): Result<void> => {
    if (!isDownloadMediaKind(input.kind)) {
      return err(
        elvError(
          'playback',
          'download-kind-not-allowed',
          'only movie and episode items can be downloaded offline',
        ),
      );
    }
    if (input.streamUrl !== undefined) {
      if (!isHttpDownloadSourceUrl(input.streamUrl)) {
        return err(
          elvError('playback', 'invalid-download-url', 'only http and https URLs are allowed'),
        );
      }
    } else if (resolveStream === undefined) {
      return err(
        elvError('playback', 'invalid-download-url', 'only http and https URLs are allowed'),
      );
    }
    return ok(undefined);
  };

  const runnerContext = {
    downloadsDir,
    records,
    sources,
    fetchImpl,
    fetchForSource,
    resolveStream,
    acquireConnection,
    checkFreeSpace,
    validatePath,
    idleTimeoutMs,
    progressThrottleMs,
    now,
    isDisposed: () => disposed,
    isOnlinePlaybackActive: () => onlinePlaybackActive,
    persistIndex,
    emitChange,
    markFailed,
    failForInsufficientDiskSpace,
  };

  const pumpQueue = (): void => {
    if (disposed || activeJob !== null || onlinePlaybackActive) return;
    const queued = [...records.entries()]
      .filter(([, rec]) => rec.status === 'queued')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    for (const [key, rec] of queued) {
      const source = sources.get(key);
      if (source === undefined && resolveStream === undefined) continue;
      records.set(key, {
        ...rec,
        status: 'downloading',
        pausedForPlayback: false,
        errorCode: null,
        updatedAt: now(),
      });
      void persistIndex();
      emitChange();

      const job: ActiveDownloadJob = {
        key,
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      activeJob = job;
      job.done = runDownloadTransfer(runnerContext, job, source).finally(() => {
        if (activeJob === job) activeJob = null;
        if (!disposed && !onlinePlaybackActive) pumpQueue();
      });
      return;
    }
  };

  const buildQueuedRecord = (
    input: DownloadEnqueueInput,
    profileId: string,
    key: string,
    existing: DownloadRecord | undefined,
    localFileName: string,
    preservedBytes: number,
    ts: number,
  ): DownloadRecord => ({
    id: existing?.id ?? key,
    profileId,
    sourceId: input.sourceId,
    itemKey: input.itemKey,
    kind: input.kind,
    title: input.title,
    seriesKey:
      input.seriesKey === undefined
        ? (existing?.seriesKey ?? null)
        : normalizeSeriesKey(input.seriesKey),
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
  });

  const applySourceSpec = (key: string, input: DownloadEnqueueInput): void => {
    if (input.streamUrl !== undefined) {
      sources.set(key, {
        streamUrl: input.streamUrl,
        headers: input.headers ? { ...input.headers } : {},
      });
    } else {
      sources.delete(key);
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

    enqueue(input: DownloadEnqueueInput): Promise<Result<DownloadRecord>> {
      return withEnqueueLock(async () => {
        await ensureReady();
        if (disposed) {
          return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
        }
        const valid = validateEnqueueInput(input);
        if (!valid.ok) return valid;

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
        if (disposed) {
          return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
        }
        if (!records.has(key) && records.size >= MAX_DOWNLOAD_RECORDS) {
          return err(elvError('storage', 'download-queue-full', 'download queue limit reached'));
        }

        const ext =
          input.containerExtension ??
          (input.streamUrl !== undefined ? inferExtensionFromUrl(input.streamUrl) : null);
        const localFileName =
          existing?.localFileName ?? sanitizeDownloadFileName(`${profileId}_${input.itemKey}`, ext);
        const partPath = path.join(downloadsDir, `${localFileName}.part`);
        if (existing && existing.status !== 'paused') {
          await safeUnlink(partPath);
        }

        const preservedBytes =
          existing && existing.status === 'paused' ? await readPartFileSize(partPath) : 0;
        if (disposed) {
          return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
        }
        const latest = records.get(key);
        if (latest && (latest.status === 'downloading' || latest.status === 'queued')) {
          return ok(Object.freeze({ ...latest }));
        }
        if (!records.has(key) && records.size >= MAX_DOWNLOAD_RECORDS) {
          return err(elvError('storage', 'download-queue-full', 'download queue limit reached'));
        }
        const nextRecord = buildQueuedRecord(
          input,
          profileId,
          key,
          latest ?? existing,
          localFileName,
          preservedBytes,
          now(),
        );

        applySourceSpec(key, input);
        records.set(key, nextRecord);
        await persistIndex();
        emitChange();
        pumpQueue();
        return ok(Object.freeze({ ...(records.get(key) ?? nextRecord) }));
      });
    },

    enqueueBatch(
      inputs: readonly DownloadEnqueueInput[],
    ): Promise<Result<readonly DownloadRecord[]>> {
      return withEnqueueLock(async () => {
        await ensureReady();
        if (disposed) {
          return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
        }
        if (inputs.length === 0) return ok([]);

        const deduped: Array<{
          readonly input: DownloadEnqueueInput;
          readonly profileId: string;
          readonly key: string;
        }> = [];
        const seenKeys = new Set<string>();
        for (const input of inputs) {
          const valid = validateEnqueueInput(input);
          if (!valid.ok) return valid;
          const profileId = normalizeProfileId(input.profileId);
          const key = recordKey(profileId, input.itemKey);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          deduped.push({ input, profileId, key });
        }

        const candidates: Array<{
          readonly input: DownloadEnqueueInput;
          readonly profileId: string;
          readonly key: string;
        }> = [];
        for (const item of deduped) {
          const existing = records.get(item.key);
          if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
            continue;
          }
          if (existing && existing.status === 'completed') {
            const verified = await validatePath(
              downloadsDir,
              path.join(downloadsDir, existing.localFileName),
            );
            if (verified !== null) continue;
          }
          candidates.push(item);
        }

        if (disposed) {
          return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
        }
        const eligible = candidates.filter(({ key }) => {
          const latest = records.get(key);
          return !(latest && (latest.status === 'downloading' || latest.status === 'queued'));
        });
        if (eligible.length === 0) return ok([]);

        const preNewlyAdded = eligible.reduce(
          (acc, { key }) => acc + (records.has(key) ? 0 : 1),
          0,
        );
        if (records.size + preNewlyAdded > MAX_DOWNLOAD_RECORDS) {
          return err(elvError('storage', 'download-queue-full', 'download queue limit reached'));
        }

        const prepared: Array<{
          readonly input: DownloadEnqueueInput;
          readonly profileId: string;
          readonly key: string;
          readonly localFileName: string;
          readonly preservedBytes: number;
        }> = [];
        for (const { input, profileId, key } of eligible) {
          const existing = records.get(key);
          const ext =
            input.containerExtension ??
            (input.streamUrl !== undefined ? inferExtensionFromUrl(input.streamUrl) : null);
          const localFileName =
            existing?.localFileName ??
            sanitizeDownloadFileName(`${profileId}_${input.itemKey}`, ext);
          const partPath = path.join(downloadsDir, `${localFileName}.part`);
          if (existing && existing.status !== 'paused') {
            await safeUnlink(partPath);
          }
          const preservedBytes =
            existing && existing.status === 'paused' ? await readPartFileSize(partPath) : 0;
          prepared.push({ input, profileId, key, localFileName, preservedBytes });
        }

        // Synchronous atomic gate: zero awaits between capacity check and records/sources commit.
        if (disposed) {
          return err(elvError('storage', 'downloads-disposed', 'download manager is disposed'));
        }
        const finalItems = prepared.filter(({ key }) => {
          const latest = records.get(key);
          return !(latest && (latest.status === 'downloading' || latest.status === 'queued'));
        });
        if (finalItems.length === 0) return ok([]);

        const finalNewlyAdded = finalItems.reduce(
          (acc, { key }) => acc + (records.has(key) ? 0 : 1),
          0,
        );
        if (records.size + finalNewlyAdded > MAX_DOWNLOAD_RECORDS) {
          return err(elvError('storage', 'download-queue-full', 'download queue limit reached'));
        }

        const ts = now();
        const created: Array<{ readonly key: string; readonly record: DownloadRecord }> = [];
        for (const { input, profileId, key, localFileName, preservedBytes } of finalItems) {
          const nextRecord = buildQueuedRecord(
            input,
            profileId,
            key,
            records.get(key),
            localFileName,
            preservedBytes,
            ts,
          );
          applySourceSpec(key, input);
          records.set(key, nextRecord);
          created.push({ key, record: nextRecord });
        }

        await persistIndex();
        emitChange();
        pumpQueue();
        return ok(
          created.map(({ key, record }) => Object.freeze({ ...(records.get(key) ?? record) })),
        );
      });
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
      if (!sources.has(key) && resolveStream === undefined) {
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
      await enqueueChain;
      await persistChain;
      listeners.clear();
      sources.clear();
    },
  };
}
