import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARTWORK_CACHE_MAX_BYTES,
  ARTWORK_CACHE_MIN_BYTES,
  ARTWORK_CHANNELS,
  clampArtworkCacheLimitBytes,
  DEFAULT_ARTWORK_CACHE_BYTES,
  type DesktopArtworkCacheStats,
  isArtworkSetLimitBytes,
  isSafeArtworkUrl,
} from '../shared/artwork-ipc.ts';

const DEFAULT_MAX_ARTWORK_ENTRY_BYTES = 4 * 1024 * 1024;
const DEFAULT_ARTWORK_FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const INDEX_FILENAME = 'index.json';
const SHA256_HEX = /^[a-f0-9]{64}$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeFileAtomic(
  dir: string,
  targetPath: string,
  data: Uint8Array | string,
): Promise<void> {
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, targetPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const lenHeader = response.headers.get('content-length');
  if (lenHeader !== null) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) return null;
  }
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.byteLength > 0 && buf.byteLength <= maxBytes ? buf : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Configuration for {@link createDesktopArtworkCache}. */
export interface DesktopArtworkCacheOptions {
  readonly userDataDir: string;
  readonly maxBytes?: number;
  readonly minLimitBytes?: number;
  readonly maxLimitBytes?: number;
  readonly maxEntryBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowPrivateHosts?: boolean;
  readonly onClear?: () => Promise<void> | void;
}

/** Bounded LRU disk cache stored under `userData/artwork-cache` (`#405`). */
export interface DesktopArtworkCache {
  readonly dir: string;
  get(uri: string): Promise<string | null>;
  put(uri: string, data: Uint8Array): Promise<string | null>;
  fetchAndCache(uri: string): Promise<string | null>;
  setLimitBytes(nextMaxBytes: number): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<DesktopArtworkCacheStats>;
}

/**
 * Creates a bounded LRU artwork disk cache under `join(userDataDir, 'artwork-cache')` using
 * SHA-256 keys, atomic temp+rename writes, startup disk reconciliation, and SSRF-safe fetches.
 */
export function createDesktopArtworkCache(
  options: DesktopArtworkCacheOptions,
): DesktopArtworkCache {
  const dir = join(options.userDataDir, 'artwork-cache');
  const indexPath = join(dir, INDEX_FILENAME);
  const minLimit = Math.max(1, Math.floor(options.minLimitBytes ?? ARTWORK_CACHE_MIN_BYTES));
  const maxLimit = Math.max(minLimit, Math.floor(options.maxLimitBytes ?? ARTWORK_CACHE_MAX_BYTES));
  const maxEntryBytes = Math.max(
    1,
    Math.floor(options.maxEntryBytes ?? DEFAULT_MAX_ARTWORK_ENTRY_BYTES),
  );
  const timeoutMs = Math.max(10, Math.floor(options.timeoutMs ?? DEFAULT_ARTWORK_FETCH_TIMEOUT_MS));
  const fetchFn = options.fetch ?? globalThis.fetch;
  const allowPrivateHosts = Boolean(options.allowPrivateHosts);

  const clampLimit = (value: number): number => {
    if (!Number.isFinite(value))
      return Math.min(maxLimit, Math.max(minLimit, DEFAULT_ARTWORK_CACHE_BYTES));
    return Math.max(minLimit, Math.min(maxLimit, Math.floor(value)));
  };

  let limitBytes = clampLimit(options.maxBytes ?? DEFAULT_ARTWORK_CACHE_BYTES);
  const entries = new Map<string, number>();
  let totalBytes = 0;
  let initialized = false;
  let queue: Promise<void> = Promise.resolve();

  const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const filePathFor = (key: string): string => join(dir, `${key}.img`);
  const persistIndex = async (): Promise<void> => {
    const list = [...entries.entries()].map(([key, bytes]) => ({ key, bytes }));
    await writeFileAtomic(dir, indexPath, JSON.stringify({ entries: list }));
  };
  const evictOverflow = async (incomingBytes: number): Promise<void> => {
    const evicted: string[] = [];
    while (entries.size > 0 && totalBytes + incomingBytes > limitBytes) {
      const oldest = entries.entries().next().value as [string, number] | undefined;
      if (!oldest) break;
      entries.delete(oldest[0]);
      totalBytes -= oldest[1];
      evicted.push(oldest[0]);
    }
    for (const key of evicted) await unlink(filePathFor(key)).catch(() => undefined);
  };

  const readSavedKeys = async (): Promise<string[]> => {
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries
        .map((item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { key?: unknown }).key === 'string'
            ? (item as { key: string }).key
            : '',
        )
        .filter((key) => SHA256_HEX.test(key));
    } catch {
      return [];
    }
  };

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    await mkdir(dir, { recursive: true });
    const savedKeys = await readSavedKeys();
    const diskFiles = new Map<string, { size: number; mtimeMs: number }>();
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name === INDEX_FILENAME) continue;
      if (name.startsWith('.tmp-')) {
        await unlink(join(dir, name)).catch(() => undefined);
        continue;
      }
      if (!name.endsWith('.img')) continue;
      const key = name.slice(0, -4);
      if (!SHA256_HEX.test(key)) continue;
      try {
        const info = await stat(join(dir, name));
        if (info.isFile() && info.size > 0)
          diskFiles.set(key, { size: info.size, mtimeMs: info.mtimeMs });
        else await unlink(join(dir, name)).catch(() => undefined);
      } catch {
        // Ignore vanished file during reconciliation.
      }
    }
    entries.clear();
    totalBytes = 0;
    for (const key of savedKeys) {
      const file = diskFiles.get(key);
      if (!file) continue;
      entries.set(key, file.size);
      totalBytes += file.size;
      diskFiles.delete(key);
    }
    for (const [key, file] of [...diskFiles.entries()].sort(
      (a, b) => a[1].mtimeMs - b[1].mtimeMs,
    )) {
      entries.set(key, file.size);
      totalBytes += file.size;
    }
    await evictOverflow(0);
    await persistIndex();
    initialized = true;
  };

  const getInternal = async (uri: string): Promise<string | null> => {
    if (!isSafeArtworkUrl(uri, { allowPrivateHosts })) return null;
    await ensureInitialized();
    const key = sha256Hex(uri);
    const size = entries.get(key);
    if (size === undefined) return null;
    const path = filePathFor(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      entries.delete(key);
      totalBytes -= size;
      await persistIndex();
      return null;
    }
    entries.delete(key);
    entries.set(key, size);
    await persistIndex();
    return path;
  };

  const putInternal = async (uri: string, data: Uint8Array): Promise<string | null> => {
    if (!isSafeArtworkUrl(uri, { allowPrivateHosts })) return null;
    const size = data.byteLength;
    if (size <= 0 || size > maxEntryBytes) return null;
    await ensureInitialized();
    if (size > limitBytes) return null;
    const key = sha256Hex(uri);
    const path = filePathFor(key);
    await writeFileAtomic(dir, path, data);

    const existing = entries.get(key);
    if (existing !== undefined) {
      entries.delete(key);
      totalBytes -= existing;
    }
    await evictOverflow(size);
    entries.set(key, size);
    totalBytes += size;
    await persistIndex();
    return path;
  };

  return {
    dir,
    get(uri: string): Promise<string | null> {
      return runExclusive(() => getInternal(uri));
    },
    put(uri: string, data: Uint8Array): Promise<string | null> {
      return runExclusive(() => putInternal(uri, data));
    },
    async fetchAndCache(uri: string): Promise<string | null> {
      if (!isSafeArtworkUrl(uri, { allowPrivateHosts })) return null;
      const hit = await runExclusive(() => getInternal(uri));
      if (hit !== null) return hit;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let currentUrl = uri;
        let response: Response | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          response = await fetchFn(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            const loc = response.headers.get('location');
            if (!loc) return null;
            const nextUrl = new URL(loc, currentUrl).toString();
            if (!isSafeArtworkUrl(nextUrl, { allowPrivateHosts })) return null;
            currentUrl = nextUrl;
            continue;
          }
          break;
        }
        if (!response?.ok) return null;
        const maxAllowed = Math.min(maxEntryBytes, limitBytes);
        const bytes = await readBoundedBody(response, maxAllowed);
        if (!bytes) return null;
        return await runExclusive(() => putInternal(uri, bytes));
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    setLimitBytes(nextMaxBytes: number): Promise<void> {
      return runExclusive(async () => {
        await ensureInitialized();
        limitBytes = clampLimit(nextMaxBytes);
        await evictOverflow(0);
        await persistIndex();
      });
    },
    clear(): Promise<void> {
      return runExclusive(async () => {
        await ensureInitialized();
        entries.clear();
        totalBytes = 0;
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names) {
          await unlink(join(dir, name)).catch(() => undefined);
        }
        await options.onClear?.();
      });
    },
    stats(): Promise<DesktopArtworkCacheStats> {
      return runExclusive(async () => {
        await ensureInitialized();
        return { bytes: totalBytes, entries: entries.size, maxBytes: limitBytes };
      });
    },
  };
}

/** Subset of Electron `ipcMain` used by {@link registerArtworkIpc}. */
export interface ArtworkIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Registers `artwork:clear`, `artwork:set-limit`, and `artwork:stats` handlers on `ipcMain`. */
export function registerArtworkIpc(deps: {
  readonly ipcMain: ArtworkIpcMainLike;
  readonly cache: DesktopArtworkCache;
  readonly log: (line: string) => void;
}): () => void {
  const { ipcMain, cache, log } = deps;

  ipcMain.handle(ARTWORK_CHANNELS.clear, async () => {
    await cache.clear();
  });

  ipcMain.handle(ARTWORK_CHANNELS.setLimit, async (_event, maxBytes) => {
    if (!isArtworkSetLimitBytes(maxBytes)) {
      log(`artwork ipc: dropped invalid ${ARTWORK_CHANNELS.setLimit} payload`);
      return;
    }
    await cache.setLimitBytes(clampArtworkCacheLimitBytes(maxBytes));
  });

  ipcMain.handle(ARTWORK_CHANNELS.stats, () => cache.stats());

  return () => {
    ipcMain.removeHandler(ARTWORK_CHANNELS.clear);
    ipcMain.removeHandler(ARTWORK_CHANNELS.setLimit);
    ipcMain.removeHandler(ARTWORK_CHANNELS.stats);
  };
}
