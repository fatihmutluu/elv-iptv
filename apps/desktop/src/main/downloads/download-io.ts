import type { WriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type DownloadRecord,
  isDownloadMediaKind,
  isValidManagedDownloadFileName,
} from '@elv/domain';
import { validateManagedDownloadPath } from './managed-path.ts';

const DEFAULT_PROFILE_ID = 'default';
export const INDEX_FILE_NAME = 'index.json';

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
      stream.end(finish);
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

/** Reads the current byte size of a `.part` temp file, or `0` if absent. */
export async function readPartFileSize(partPath: string): Promise<number> {
  try {
    const info = await stat(partPath);
    return info.isFile() && info.size > 0 ? info.size : 0;
  } catch {
    return 0;
  }
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
      bytesDownloaded = await readPartFileSize(partPath);
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
