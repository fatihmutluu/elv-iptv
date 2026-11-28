import { constants as fsConstants, type WriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type DownloadRecord,
  isDownloadMediaKind,
  isValidManagedDownloadFileName,
} from '@elv/domain';
import { validateManagedDownloadPath } from './managed-path.ts';

const DEFAULT_PROFILE_ID = 'default';
const MAX_SERIES_KEY_CHARS = 512;
export const INDEX_FILE_NAME = 'index.json';

/** Sanitizes an optional `seriesKey` (bounded <= 512 chars, zero control chars), returning `null` if invalid/empty. */
export function normalizeSeriesKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SERIES_KEY_CHARS) return null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}

/**
 * Queries available free disk bytes for `dirPath` via `fs/promises.statfs`, returning `null`
 * gracefully when `statfs` is unsupported or fails on the current OS/filesystem.
 */
export async function defaultCheckFreeSpace(dirPath: string): Promise<number | null> {
  if (typeof statfs !== 'function') return null;
  try {
    await mkdir(dirPath, { recursive: true });
    const stats = await statfs(dirPath);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * Runs an async network step (`fetch`, `resolveStream`, or `reader.read`) under a resettable stall
 * timeout. Invokes `onTimeout` and rejects with `AbortError` if silence exceeds `timeoutMs` or
 * `signal` aborts. If `op` resolves AFTER timeout/abort, `onLateResolve` is invoked for cleanup.
 */
export async function runWithStallTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout: () => void,
  op: () => Promise<T>,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  let settled = false;
  let timedOutOrAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const opPromise = op().then(
    (value) => {
      if (timedOutOrAborted) {
        onLateResolve?.(value);
      }
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  opPromise.catch(() => undefined);

  const racePromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      if (!settled) timedOutOrAborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      if (!settled) timedOutOrAborted = true;
      onTimeout();
      reject(new DOMException('Stall timeout', 'AbortError'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([opPromise, racePromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Builds the composite `(profileId, itemKey)` map key for a download record. */
export function recordKey(profileId: string, itemKey: string): string {
  return `${profileId}::${itemKey}`;
}

/** Normalizes an optional profile ID to a non-empty string (`'default'` fallback). */
export function normalizeProfileId(profileId?: string): string {
  const trimmed = profileId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_ID;
}

/** Extracts a lowercase extension suffix from a stream URL pathname if present. */
export function inferExtensionFromUrl(streamUrl: string): string | null {
  try {
    const parsed = new URL(streamUrl);
    const base = path.posix.basename(parsed.pathname);
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot + 1 >= base.length) return null;
    return base.slice(dot).toLowerCase();
  } catch {
    return null;
  }
}

/** Parsed byte range fields from an HTTP `Content-Range: bytes <start>-<end>/<total|*>` header. */
export interface ParsedContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number | null;
}

/** Parses an HTTP `Content-Range: bytes <start>-<end>/<total|*>` header. */
export function parseContentRange(header: string | null): ParsedContentRange | null {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  if (match[3] === '*') {
    return { start, end, total: null };
  }
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || total <= 0 || end >= total) {
    return null;
  }
  return { start, end, total };
}

/** Parses a positive integer HTTP `Content-Length` header value. */
export function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const value = Number(header.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Copies sanitized source headers and appends `Range: bytes=<offset>-` when resuming. */
export function buildRequestHeaders(
  headers: Readonly<Record<string, string>>,
  rangeStart: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'range') continue;
    out[name] = value;
  }
  if (rangeStart > 0) {
    out.Range = `bytes=${rangeStart}-`;
  }
  return out;
}

/** Closes or destroys a Node `WriteStream` and waits until the underlying OS handle is closed. */
export function closeWriteStream(stream: WriteStream, destroy = false): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once('close', finish);
    stream.once('error', finish);
    if (destroy) {
      stream.destroy();
    } else {
      stream.end();
    }
  });
}

/** Writes one chunk to a Node `WriteStream`, honoring backpressure via `drain`. */
export function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
    };
    stream.once('error', onError);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
    } else {
      stream.once('drain', onDrain);
    }
  });
}

/** Unlinks a file path if present, ignoring ENOENT/removal races. */
export async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore ENOENT or already-removed files.
  }
}

/** Thrown when a `.part` download file path is a symbolic link or non-regular filesystem entry. */
export class PartFileUnsafeError extends Error {
  readonly code = 'download-path-invalid' as const;

  constructor(message = 'download part path is not a regular file') {
    super(message);
    this.name = 'PartFileUnsafeError';
  }
}

async function assertRegularOrAbsentPartFile(partPath: string): Promise<number> {
  try {
    const info = await lstat(partPath);
    if (info.isSymbolicLink()) {
      throw new PartFileUnsafeError('download part path cannot be a symbolic link');
    }
    if (!info.isFile()) {
      throw new PartFileUnsafeError('download part path is not a regular file');
    }
    return Math.max(info.size, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Reads the current byte size of a `.part` temp file via `lstat`, returning `0` if absent and
 * throwing {@link PartFileUnsafeError} if the path is a symbolic link or non-regular file.
 */
export async function readPartFileSize(partPath: string): Promise<number> {
  return assertRegularOrAbsentPartFile(partPath);
}

/**
 * Opens a `.part` file for writing/appending without following symbolic links (`lstat` + `O_NOFOLLOW`
 * + post-open `fstat` regular-file verification, deferring truncation until after verification).
 */
export async function openSafePartWriteStream(
  partPath: string,
  appendMode: boolean,
): Promise<WriteStream> {
  await assertRegularOrAbsentPartFile(partPath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const flags = appendMode
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | noFollow;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(partPath, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP' || code === 'EISDIR') {
      throw new PartFileUnsafeError('download part path cannot be opened safely');
    }
    throw error;
  }

  try {
    const fdStat = await handle.stat({ bigint: true });
    const linkStat = await lstat(partPath, { bigint: true });
    if (
      linkStat.isSymbolicLink() ||
      !linkStat.isFile() ||
      !fdStat.isFile() ||
      fdStat.dev !== linkStat.dev ||
      fdStat.ino !== linkStat.ino
    ) {
      throw new PartFileUnsafeError('download part path changed or is not a regular file');
    }
    if (!appendMode) {
      await handle.truncate(0);
    }
    return handle.createWriteStream({ autoClose: true });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Verifies via `lstat` immediately before `rename(partPath, finalPath)` that `partPath` is a
 * regular non-symlink file and `finalPath` is either absent or a regular non-symlink file.
 */
export async function assertSafeBeforeDownloadRename(
  partPath: string,
  finalPath: string,
): Promise<void> {
  const partInfo = await lstat(partPath);
  if (partInfo.isSymbolicLink() || !partInfo.isFile()) {
    throw new PartFileUnsafeError('download part path is not a regular file before rename');
  }
  await assertRegularOrAbsentPartFile(finalPath);
}

/** Atomically writes `records` to `<downloadsDir>/index.json` via a temp file + rename. */
export async function writeIndexAtomically(
  downloadsDir: string,
  indexPath: string,
  records: readonly DownloadRecord[],
  seq: number,
): Promise<void> {
  const data = JSON.stringify(records, null, 2);
  const tmpPath = path.join(downloadsDir, `.index.${process.pid}.${seq}.tmp`);
  try {
    await mkdir(downloadsDir, { recursive: true });
    await writeFile(tmpPath, data, 'utf8');
    await rename(tmpPath, indexPath);
  } catch {
    await safeUnlink(tmpPath);
  }
}

/**
 * Loads `<downloadsDir>/index.json` on startup, reconciling stale `'downloading'`/`'queued'` entries
 * to `'paused'` and verifying every `'completed'` file still exists inside `downloadsDir`.
 */
export async function reconcileDownloadsIndex(
  downloadsDir: string,
  indexPath: string,
  now: () => number,
  log?: (line: string) => void,
): Promise<{ records: Map<string, DownloadRecord>; dirty: boolean }> {
  const out = new Map<string, DownloadRecord>();
  await mkdir(downloadsDir, { recursive: true });

  let rawText: string;
  try {
    rawText = await readFile(indexPath, 'utf8');
  } catch {
    return { records: out, dirty: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    log?.('downloads: index.json unreadable on startup, starting empty');
    return { records: out, dirty: false };
  }
  if (!Array.isArray(parsed)) return { records: out, dirty: false };

  let dirty = false;
  const ts = now();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      dirty = true;
      continue;
    }
    const candidate = item as Partial<DownloadRecord>;
    if (
      typeof candidate.itemKey !== 'string' ||
      candidate.itemKey.trim().length === 0 ||
      typeof candidate.sourceId !== 'string' ||
      typeof candidate.title !== 'string' ||
      !isDownloadMediaKind(candidate.kind) ||
      typeof candidate.localFileName !== 'string' ||
      !isValidManagedDownloadFileName(candidate.localFileName)
    ) {
      dirty = true;
      continue;
    }

    const profileId = normalizeProfileId(candidate.profileId);
    const key = recordKey(profileId, candidate.itemKey);
    const finalPath = path.join(downloadsDir, candidate.localFileName);
    const partPath = `${finalPath}.part`;

    let status = candidate.status ?? 'paused';
    let localUri = candidate.localUri ?? null;
    let bytesDownloaded =
      typeof candidate.bytesDownloaded === 'number' && Number.isFinite(candidate.bytesDownloaded)
        ? Math.max(0, candidate.bytesDownloaded)
        : 0;
    let totalBytes =
      typeof candidate.totalBytes === 'number' && Number.isFinite(candidate.totalBytes)
        ? Math.max(0, candidate.totalBytes)
        : null;
    let errorCode = candidate.errorCode ?? null;
    let completedAt = candidate.completedAt ?? null;

    if (status === 'downloading' || status === 'queued') {
      status = 'paused';
      bytesDownloaded = await readPartFileSize(partPath).catch(() => 0);
      dirty = true;
    } else if (status === 'completed') {
      const verified = await validateManagedDownloadPath(downloadsDir, finalPath);
      if (verified !== null) {
        localUri = pathToFileURL(verified).toString();
        const fileInfo = await stat(verified).catch(() => null);
        if (fileInfo?.isFile()) {
          bytesDownloaded = fileInfo.size;
          totalBytes = fileInfo.size;
        }
      } else {
        status = 'failed';
        localUri = null;
        errorCode = 'file-missing';
        completedAt = null;
        dirty = true;
      }
    }

    out.set(key, {
      id: typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : key,
      profileId,
      sourceId: candidate.sourceId,
      itemKey: candidate.itemKey,
      kind: candidate.kind,
      title: candidate.title,
      seriesKey: normalizeSeriesKey(candidate.seriesKey),
      seriesTitle: candidate.seriesTitle ?? null,
      season: candidate.season ?? null,
      episodeNum: candidate.episodeNum ?? null,
      poster: candidate.poster ?? null,
      localFileName: candidate.localFileName,
      localUri,
      bytesDownloaded,
      totalBytes,
      status,
      pausedForPlayback: false,
      errorCode,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : ts,
      updatedAt: dirty ? ts : typeof candidate.updatedAt === 'number' ? candidate.updatedAt : ts,
      completedAt,
    });
  }

  return { records: out, dirty };
}
