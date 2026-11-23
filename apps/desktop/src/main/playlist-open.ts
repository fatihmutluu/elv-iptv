import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { MAX_PICKED_PLAYLIST_BYTES, type PickedPlaylistFile } from '../shared/sources-ipc.ts';

/** Maximum accepted file path length for OS-launched playlist arguments (`#259`). */
export const MAX_PLAYLIST_PATH_CHARS = 4096;

/** Maximum local playlist size accepted from OS file-open / second-instance launches (64 MiB, `#259`). */
const MAX_PLAYLIST_FILE_BYTES = MAX_PICKED_PLAYLIST_BYTES;

const PLAYLIST_EXT_RE = /\.(?:m3u\.gz|m3u8?)$/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/;
const READ_CHUNK_BYTES = 64 * 1024;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isUrlOrScheme(value: string): boolean {
  if (WINDOWS_DRIVE_RE.test(value)) return false;
  return URI_SCHEME_RE.test(value);
}

function isSupportedPlaylistPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PLAYLIST_PATH_CHARS) return false;
  if (hasControlChars(value)) return false;
  if (isUrlOrScheme(value)) return false;
  return PLAYLIST_EXT_RE.test(value);
}

/**
 * Extracts validated local `.m3u`, `.m3u8`, and `.m3u.gz` file paths from an OS launch or
 * `second-instance` argv list (`#259`). Rejects flags (`--*`), URLs, control characters, and
 * overlong arguments, resolving relative paths against `cwd` when supplied.
 */
export function extractPlaylistPathsFromArgv(argv: readonly string[], cwd?: string): string[] {
  const resolvedPaths: string[] = [];
  const seen = new Set<string>();
  const trimmedCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined;

  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('--')) continue;
    if (!isSupportedPlaylistPath(trimmed)) continue;

    const candidate =
      trimmedCwd !== undefined && !ABSOLUTE_PATH_RE.test(trimmed)
        ? resolve(trimmedCwd, trimmed)
        : trimmed;
    if (candidate.length > MAX_PLAYLIST_PATH_CHARS || hasControlChars(candidate)) continue;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      resolvedPaths.push(candidate);
    }
  }

  return resolvedPaths;
}

/** Options accepted by {@link readValidatedPlaylistFile}. */
export interface ReadValidatedPlaylistOptions {
  readonly maxBytes?: number;
}

/**
 * Validates and reads an OS-launched local playlist file strictly in the main process (`#259`).
 * Rejects symlinks, non-regular files, unsupported extensions, URLs, empty files, and files
 * larger than 64 MiB. Returns `{ name, bytes }` (basename only — never exposes host paths).
 */
export async function readValidatedPlaylistFile(
  filePath: string,
  opts?: ReadValidatedPlaylistOptions,
): Promise<PickedPlaylistFile | null> {
  if (typeof filePath !== 'string') return null;
  const trimmed = filePath.trim();
  if (!isSupportedPlaylistPath(trimmed)) return null;

  const maxBytes = opts?.maxBytes ?? MAX_PLAYLIST_FILE_BYTES;
  if (maxBytes <= 0) return null;

  try {
    const info = await lstat(trimmed);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (info.size <= 0 || info.size > maxBytes) return null;

    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const flags = fsConstants.O_RDONLY | noFollow;
    const handle = await open(trimmed, flags);
    try {
      const fdStat = await handle.stat();
      if (!fdStat.isFile() || fdStat.size <= 0 || fdStat.size > maxBytes) return null;

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buf, 0, READ_CHUNK_BYTES, null);
        if (bytesRead <= 0) break;
        total += bytesRead;
        if (total > maxBytes) return null;
        chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
      }
      if (total <= 0) return null;

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const name = basename(trimmed).trim() || 'playlist.m3u';
      return { name, bytes };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Bounded queue buffering validated OS-opened local playlists until the renderer attaches (`#259`). */
export interface PendingPlaylistQueue {
  /** Pushes immediately to active subscribers, or buffers up to `maxItems` when unsubscribed. */
  enqueue(file: PickedPlaylistFile): void;
  /** Drains and returns all buffered playlist files in FIFO order. */
  consumePending(): PickedPlaylistFile[];
  /** Subscribes to live incoming playlist files; returns an unsubscribe callback. */
  subscribe(listener: (file: PickedPlaylistFile) => void): () => void;
  /** Number of currently buffered (unconsumed) playlist files. */
  readonly pendingCount: number;
}

/**
 * Creates a bounded pending playlist queue for OS `open-file` / `second-instance` launches (`#259`).
 * Buffers validated `{ name, bytes }` payloads until the renderer subscribes or pulls via
 * `consumePending()`, and delivers live payloads directly once subscribed.
 */
export function createPendingPlaylistQueue(maxItems = 8): PendingPlaylistQueue {
  const limit = Math.max(0, Math.floor(maxItems));
  const pending: PickedPlaylistFile[] = [];
  const listeners = new Set<(file: PickedPlaylistFile) => void>();

  return {
    enqueue(file: PickedPlaylistFile): void {
      if (listeners.size > 0) {
        for (const listener of [...listeners]) {
          try {
            listener(file);
          } catch {
            // Isolate failing subscriber from remaining listeners.
          }
        }
        return;
      }
      if (limit === 0) return;
      if (pending.length >= limit) {
        pending.shift();
      }
      pending.push(file);
    },
    consumePending(): PickedPlaylistFile[] {
      return pending.splice(0, pending.length);
    },
    subscribe(listener: (file: PickedPlaylistFile) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get pendingCount(): number {
      return pending.length;
    },
  };
}
