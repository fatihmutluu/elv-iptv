import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PICKED_PLAYLIST_BYTES, type PickedPlaylistFile } from '../shared/sources-ipc.ts';

/** Maximum accepted file path length for OS-launched playlist arguments (`#259`). */
export const MAX_PLAYLIST_PATH_CHARS = 4096;

/** Maximum local playlist size accepted from OS file-open / second-instance launches (64 MiB, `#259`). */
const MAX_PLAYLIST_FILE_BYTES = MAX_PICKED_PLAYLIST_BYTES;

const PLAYLIST_EXT_RE = /\.(?:m3u\.gz|m3u8?)$/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_FILE_URI_PATH_RE = /^\/[a-zA-Z]:\//;
const ENCODED_PATH_SEPARATOR_RE = /%(?:2f|5c)/i;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\/)/;
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

function isUncOrDevicePath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function resolveLocalFileUri(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  if (ENCODED_PATH_SEPARATOR_RE.test(uri)) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== '' && host !== 'localhost') return null;
  if (parsed.pathname.startsWith('//')) return null;

  try {
    const isWindowsUri = WINDOWS_FILE_URI_PATH_RE.test(parsed.pathname);
    const converted = fileURLToPath(parsed, { windows: isWindowsUri });
    if (
      converted.length === 0 ||
      converted.length > MAX_PLAYLIST_PATH_CHARS ||
      hasControlChars(converted) ||
      isUncOrDevicePath(converted)
    ) {
      return null;
    }
    return PLAYLIST_EXT_RE.test(converted) ? converted : null;
  } catch {
    return null;
  }
}

function normalizePlaylistPathInput(value: string): string | null {
  if (value.length === 0 || value.length > MAX_PLAYLIST_PATH_CHARS) return null;
  if (hasControlChars(value)) return null;
  if (isUncOrDevicePath(value)) return null;
  if (/^file:/i.test(value)) {
    return resolveLocalFileUri(value);
  }
  if (isUrlOrScheme(value)) return null;
  return PLAYLIST_EXT_RE.test(value) ? value : null;
}

/**
 * Extracts validated local `.m3u`, `.m3u8`, and `.m3u.gz` file paths and hostless/localhost
 * `file://` URIs from an OS launch or `second-instance` argv list (`#259`, Wave Q7). Rejects
 * flags (`--*`), remote UNC `file://` hosts, non-file URLs, control characters, and overlong paths.
 */
export function extractPlaylistPathsFromArgv(argv: readonly string[], cwd?: string): string[] {
  const resolvedPaths: string[] = [];
  const seen = new Set<string>();
  const trimmedCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined;

  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('--')) continue;
    const normalized = normalizePlaylistPathInput(trimmed);
    if (normalized === null) continue;

    const candidate =
      trimmedCwd !== undefined && !ABSOLUTE_PATH_RE.test(normalized)
        ? resolve(trimmedCwd, normalized)
        : normalized;
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
  /** Optional `lstat` override for deterministic unit testing of pre-FS path guards. */
  readonly lstatFn?: typeof fsPromises.lstat;
}

/**
 * Validates and reads an OS-launched or dropped local playlist file strictly in the main process
 * (`#259`, Wave Q7). Accepts local paths and hostless/localhost `file://` URIs while rejecting
 * symlinks, TOCTOU swaps (`dev`/`ino`), non-regular files, unsupported extensions, remote URLs,
 * empty files, and files larger than 64 MiB. Returns `{ name, bytes }` (basename only).
 */
export async function readValidatedPlaylistFile(
  filePath: string,
  opts?: ReadValidatedPlaylistOptions,
): Promise<PickedPlaylistFile | null> {
  if (typeof filePath !== 'string') return null;
  const normalized = normalizePlaylistPathInput(filePath.trim());
  if (normalized === null) return null;

  const maxBytes = opts?.maxBytes ?? MAX_PLAYLIST_FILE_BYTES;
  if (maxBytes <= 0) return null;

  const lstatImpl = opts?.lstatFn ?? fsPromises.lstat;

  try {
    const info = await lstatImpl(normalized);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (info.size <= 0 || info.size > maxBytes) return null;

    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const flags = fsConstants.O_RDONLY | noFollow;
    const handle = await fsPromises.open(normalized, flags);
    try {
      const fdStat = await handle.stat({ bigint: true });
      const linkStat = await lstatImpl(normalized, { bigint: true });
      if (
        linkStat.isSymbolicLink() ||
        !linkStat.isFile() ||
        !fdStat.isFile() ||
        fdStat.dev !== linkStat.dev ||
        fdStat.ino !== linkStat.ino
      ) {
        return null;
      }
      if (fdStat.size <= 0n || fdStat.size > BigInt(maxBytes)) return null;

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
      const name = basename(normalized).trim() || 'playlist.m3u';
      return { name, bytes };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Envelope pairing a monotonic `deliveryId` with a validated playlist payload for explicit ACK. */
interface PendingPlaylistDelivery {
  readonly deliveryId: string;
  readonly file: PickedPlaylistFile;
}

/** Bounded queue buffering validated OS-opened local playlists with explicit delivery ACK (`#259`, Wave Q7). */
export interface PendingPlaylistQueue {
  /** Pushes immediately to active subscribers, or buffers up to `maxItems` when unsubscribed. */
  enqueue(file: PickedPlaylistFile): void;
  /** Drains and returns all buffered playlist files in FIFO order (legacy helper without delivery IDs). */
  consumePending(): PickedPlaylistFile[];
  /** Drains buffered playlists into `awaitingAck` and returns `{ deliveryId, file }[]` in FIFO order. */
  consumePendingEntries(): PendingPlaylistDelivery[];
  /** Subscribes to live incoming playlist files (legacy helper without delivery IDs). */
  subscribe(listener: (file: PickedPlaylistFile) => void): () => void;
  /** Subscribes to live incoming playlist deliveries with monotonic `deliveryId` tracked in `awaitingAck`. */
  subscribeDeliveries(listener: (delivery: PendingPlaylistDelivery) => void): () => void;
  /** Marks a delivered playlist as acknowledged by the renderer. Returns `true` if it was awaiting ACK. */
  ackDelivery(deliveryId: string): boolean;
  /** Moves unacknowledged deliveries (all, or the specified IDs) back to the pending queue in FIFO order. */
  requeueUnacked(deliveryIds?: readonly string[]): number;
  /** Number of currently buffered (unconsumed) playlist files. */
  readonly pendingCount: number;
  /** Number of delivered playlist files currently awaiting renderer acknowledgement. */
  readonly awaitingAckCount: number;
}

/**
 * Creates a bounded pending playlist queue for OS `open-file` / `second-instance` launches (`#259`).
 * Tracks delivered items in `awaitingAck` until acknowledged so renderer crashes or navigations
 * mid-delivery re-queue unacked playlists without data loss.
 */
export function createPendingPlaylistQueue(maxItems = 8): PendingPlaylistQueue {
  const limit = Math.max(0, Math.floor(maxItems));
  const maxAwaiting = Math.max(limit * 4, 32);
  let nextSeq = 0;
  const pending: PendingPlaylistDelivery[] = [];
  const awaitingAck = new Map<string, PendingPlaylistDelivery>();
  const legacyListeners = new Set<(file: PickedPlaylistFile) => void>();
  const deliveryListeners = new Set<(delivery: PendingPlaylistDelivery) => void>();

  const trackAwaiting = (entry: PendingPlaylistDelivery): void => {
    if (awaitingAck.size >= maxAwaiting) {
      const oldestKey = awaitingAck.keys().next().value;
      if (oldestKey !== undefined) awaitingAck.delete(oldestKey);
    }
    awaitingAck.set(entry.deliveryId, entry);
  };

  return {
    enqueue(file: PickedPlaylistFile): void {
      const entry: PendingPlaylistDelivery = {
        deliveryId: `pl-${++nextSeq}`,
        file,
      };
      if (deliveryListeners.size > 0 || legacyListeners.size > 0) {
        if (deliveryListeners.size > 0) {
          trackAwaiting(entry);
          for (const listener of [...deliveryListeners]) {
            try {
              listener(entry);
            } catch {
              // Isolate failing subscriber from remaining listeners.
            }
          }
        }
        for (const listener of [...legacyListeners]) {
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
      pending.push(entry);
    },
    consumePending(): PickedPlaylistFile[] {
      return pending.splice(0, pending.length).map((entry) => entry.file);
    },
    consumePendingEntries(): PendingPlaylistDelivery[] {
      const drained = pending.splice(0, pending.length);
      for (const entry of drained) {
        trackAwaiting(entry);
      }
      return drained;
    },
    subscribe(listener: (file: PickedPlaylistFile) => void): () => void {
      legacyListeners.add(listener);
      return () => {
        legacyListeners.delete(listener);
      };
    },
    subscribeDeliveries(listener: (delivery: PendingPlaylistDelivery) => void): () => void {
      deliveryListeners.add(listener);
      return () => {
        deliveryListeners.delete(listener);
      };
    },
    ackDelivery(deliveryId: string): boolean {
      return awaitingAck.delete(deliveryId);
    },
    requeueUnacked(deliveryIds?: readonly string[]): number {
      const toRestore: PendingPlaylistDelivery[] = [];
      if (deliveryIds === undefined) {
        for (const [id, entry] of awaitingAck) {
          toRestore.push(entry);
          awaitingAck.delete(id);
        }
      } else {
        for (const id of deliveryIds) {
          const entry = awaitingAck.get(id);
          if (entry !== undefined) {
            toRestore.push(entry);
            awaitingAck.delete(id);
          }
        }
      }
      if (toRestore.length === 0 || limit === 0) return 0;
      const combined = [...toRestore, ...pending];
      const trimmed = combined.length > limit ? combined.slice(combined.length - limit) : combined;
      pending.splice(0, pending.length, ...trimmed);
      return toRestore.length;
    },
    get pendingCount(): number {
      return pending.length;
    },
    get awaitingAckCount(): number {
      return awaitingAck.size;
    },
  };
}
