import {
  ARTWORK_CACHE_MAX_MB,
  ARTWORK_CACHE_MIN_MB,
  type ArtworkCacheAdapter,
  type ArtworkCacheStats,
  createArtworkCacheIndex,
  DEFAULT_ARTWORK_CACHE_MB,
  type DeadHostRegistry,
  defaultDeadHostRegistry,
  defaultLoadedArtworkUris,
  type LoadedUriCache,
} from '@elv/ui-kit';

const BYTES_PER_MIB = 1024 * 1024;
const MIN_LIMIT_BYTES = ARTWORK_CACHE_MIN_MB * BYTES_PER_MIB;
const MAX_LIMIT_BYTES = ARTWORK_CACHE_MAX_MB * BYTES_PER_MIB;
const DEFAULT_LIMIT_BYTES = DEFAULT_ARTWORK_CACHE_MB * BYTES_PER_MIB;
const DEFAULT_MAX_ENTRY_BYTES = 4 * BYTES_PER_MIB;
const MAX_URI_CHARS = 4096;
const INDEX_FILENAME = 'index.json';
const HEX_KEY = /^[a-f0-9]{16,64}$/;

/** Directory entry returned by {@link ArtworkCacheFsPort.listFiles}. */
interface ArtworkCacheFsEntry {
  readonly name: string;
  readonly size: number;
  readonly modifiedMs?: number;
}

/** Injectable filesystem port backing mobile/TV bounded artwork disk cache (`#405`). */
export interface ArtworkCacheFsPort {
  readonly cacheDirectory: string;
  ensureDir(dir: string): Promise<void>;
  listFiles(dir: string): Promise<readonly ArtworkCacheFsEntry[]>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  downloadToFile?(
    url: string,
    destinationPath: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: number } | null>;
  deleteFile(path: string): Promise<void>;
}

/** Minimal `expo-file-system` compatible module shape accepted by {@link createExpoFileSystemPort}. */
export interface ExpoFileSystemLike {
  readonly cacheDirectory?: string | null;
  makeDirectoryAsync?(dir: string, options?: { intermediates?: boolean }): Promise<void>;
  readDirectoryAsync?(dir: string): Promise<string[]>;
  getInfoAsync?(
    path: string,
  ): Promise<{ exists: boolean; size?: number; modificationTime?: number }>;
  readAsStringAsync?(path: string): Promise<string>;
  writeAsStringAsync?(path: string, contents: string): Promise<void>;
  deleteAsync?(path: string, options?: { idempotent?: boolean }): Promise<void>;
  downloadAsync?(uri: string, fileUri: string): Promise<{ status: number }>;
}

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Adapts an `expo-file-system` module instance to {@link ArtworkCacheFsPort}. */
export function createExpoFileSystemPort(fs: ExpoFileSystemLike): ArtworkCacheFsPort | undefined {
  if (!fs.cacheDirectory) return undefined;
  const cacheDirectory = stripTrailingSlash(fs.cacheDirectory);
  return {
    cacheDirectory,
    async ensureDir(dir: string): Promise<void> {
      await fs.makeDirectoryAsync?.(dir, { intermediates: true });
    },
    async listFiles(dir: string): Promise<readonly ArtworkCacheFsEntry[]> {
      const names = (await fs.readDirectoryAsync?.(dir)) ?? [];
      const out: ArtworkCacheFsEntry[] = [];
      for (const name of names) {
        const info = await fs.getInfoAsync?.(`${dir}/${name}`);
        if (!info?.exists) continue;
        const size = typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : 0;
        const modifiedMs =
          typeof info.modificationTime === 'number' && Number.isFinite(info.modificationTime)
            ? info.modificationTime * 1000
            : undefined;
        out.push({
          name,
          size,
          ...(modifiedMs !== undefined ? { modifiedMs } : {}),
        });
      }
      return out;
    },
    async readText(path: string): Promise<string | null> {
      try {
        return (await fs.readAsStringAsync?.(path)) ?? null;
      } catch {
        return null;
      }
    },
    async writeText(path: string, content: string): Promise<void> {
      await fs.writeAsStringAsync?.(path, content);
    },
    async downloadToFile(
      url: string,
      destinationPath: string,
      maxBytes: number,
    ): Promise<{ readonly bytes: number } | null> {
      if (!fs.downloadAsync || !fs.getInfoAsync) return null;
      const result = await fs.downloadAsync(url, destinationPath);
      if (result.status < 200 || result.status >= 300) {
        await fs.deleteAsync?.(destinationPath, { idempotent: true });
        return null;
      }
      const info = await fs.getInfoAsync(destinationPath);
      const bytes = info.exists && typeof info.size === 'number' ? info.size : 0;
      if (bytes <= 0 || bytes > maxBytes) {
        await fs.deleteAsync?.(destinationPath, { idempotent: true });
        return null;
      }
      return { bytes };
    },
    async deleteFile(path: string): Promise<void> {
      await fs.deleteAsync?.(path, { idempotent: true });
    },
  };
}

function isAllowedArtworkUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > MAX_URI_CHARS) return false;
  for (let i = 0; i < uri.length; i += 1) {
    const code = uri.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (!/^https?:\/\//i.test(uri)) return false;
  try {
    const parsed = new URL(uri);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/** Deterministic 64-bit hex digest (dual FNV-1a) avoiding `node:crypto` on Hermes/RN. */
function hashArtworkKey(uri: string, maxDecodePx: number): string {
  const input = `${maxDecodePx}|${uri}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((ch + i) & 0xffff), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Configuration for {@link createMobileArtworkCache}. */
export interface MobileArtworkCacheOptions {
  readonly fs?: ArtworkCacheFsPort;
  readonly maxBytes?: number;
  readonly minLimitBytes?: number;
  readonly maxLimitBytes?: number;
  readonly maxEntryBytes?: number;
  readonly deadHosts?: DeadHostRegistry;
  readonly loadedUris?: LoadedUriCache;
  readonly onClear?: () => Promise<void> | void;
}

/**
 * Creates a bounded LRU disk artwork cache adapter for mobile/TV targets (`#405`).
 * Reconciles persisted LRU state against files on disk, skips dead hosts, enforces the configured
 * byte ceiling, and degrades cleanly when no native filesystem port is attached.
 */
export function createMobileArtworkCache(options?: MobileArtworkCacheOptions): ArtworkCacheAdapter {
  const fs = options?.fs;
  const deadHosts = options?.deadHosts ?? defaultDeadHostRegistry;
  const loadedUris = options?.loadedUris ?? defaultLoadedArtworkUris;
  const minLimit = Math.max(1, Math.floor(options?.minLimitBytes ?? MIN_LIMIT_BYTES));
  const maxLimit = Math.max(minLimit, Math.floor(options?.maxLimitBytes ?? MAX_LIMIT_BYTES));
  const maxEntryBytes = Math.max(1, Math.floor(options?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES));

  const clampLimit = (value: number): number => {
    if (!Number.isFinite(value)) {
      return Math.max(minLimit, Math.min(maxLimit, DEFAULT_LIMIT_BYTES));
    }
    return Math.max(minLimit, Math.min(maxLimit, Math.floor(value)));
  };

  const index = createArtworkCacheIndex(clampLimit(options?.maxBytes ?? DEFAULT_LIMIT_BYTES));
  const cacheDir = fs ? `${stripTrailingSlash(fs.cacheDirectory)}/artwork-cache` : '';
  const indexPath = fs ? `${cacheDir}/${INDEX_FILENAME}` : '';
  const inFlight = new Map<string, Promise<string | null>>();
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

  const filePathFor = (key: string): string => `${cacheDir}/${key}.img`;

  const persistIndex = async (): Promise<void> => {
    if (!fs) return;
    await fs.writeText(indexPath, JSON.stringify({ entries: index.snapshot() }));
  };

  const deleteEvicted = async (keys: readonly string[]): Promise<void> => {
    if (!fs) return;
    for (const key of keys) {
      await fs.deleteFile(filePathFor(key)).catch(() => undefined);
    }
  };

  const ensureInitialized = async (): Promise<void> => {
    if (initialized || !fs) {
      initialized = true;
      return;
    }
    await fs.ensureDir(cacheDir);
    let savedKeys: string[] = [];
    try {
      const raw = await fs.readText(indexPath);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { entries?: unknown };
        if (Array.isArray(parsed.entries)) {
          savedKeys = parsed.entries
            .map((entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as { key?: unknown }).key === 'string'
                ? (entry as { key: string }).key
                : '',
            )
            .filter((key) => HEX_KEY.test(key));
        }
      }
    } catch {
      savedKeys = [];
    }

    const diskMap = new Map<string, { size: number; modifiedMs: number }>();
    const listed = await fs.listFiles(cacheDir).catch(() => [] as readonly ArtworkCacheFsEntry[]);
    for (const entry of listed) {
      if (entry.name === INDEX_FILENAME) continue;
      if (!entry.name.endsWith('.img')) continue;
      const key = entry.name.slice(0, -4);
      if (!HEX_KEY.test(key) || entry.size <= 0) continue;
      diskMap.set(key, { size: entry.size, modifiedMs: entry.modifiedMs ?? 0 });
    }

    index.clear();
    const evicted: string[] = [];
    for (const key of savedKeys) {
      const disk = diskMap.get(key);
      if (!disk) continue;
      evicted.push(...index.put(key, disk.size));
      diskMap.delete(key);
    }
    const orphans = [...diskMap.entries()].sort((a, b) => a[1].modifiedMs - b[1].modifiedMs);
    for (const [key, disk] of orphans) {
      evicted.push(...index.put(key, disk.size));
    }

    await deleteEvicted(evicted);
    await persistIndex();
    initialized = true;
  };

  return {
    async resolveUri(uri: string, maxDecodePx: number): Promise<string | null> {
      const trimmed = uri.trim();
      if (!fs || !isAllowedArtworkUri(trimmed) || deadHosts.isDead(trimmed)) return null;

      const key = hashArtworkKey(trimmed, Math.max(32, Math.round(maxDecodePx)));
      const hit = await runExclusive(async () => {
        await ensureInitialized();
        if (!index.touch(key)) return null;
        await persistIndex();
        return filePathFor(key);
      });
      if (hit !== null) return hit;
      if (!fs.downloadToFile) return null;

      const existingFlight = inFlight.get(key);
      if (existingFlight) return existingFlight;

      const downloadTask = (async (): Promise<string | null> => {
        try {
          const dest = filePathFor(key);
          const budget = Math.min(maxEntryBytes, index.stats().maxBytes);
          const result = await fs.downloadToFile?.(trimmed, dest, budget);
          if (!result || result.bytes <= 0 || result.bytes > budget) {
            await fs.deleteFile(dest).catch(() => undefined);
            return null;
          }
          return await runExclusive(async () => {
            await ensureInitialized();
            if (result.bytes > index.stats().maxBytes) {
              await fs.deleteFile(dest).catch(() => undefined);
              return null;
            }
            const evicted = index.put(key, result.bytes);
            await deleteEvicted(evicted);
            await persistIndex();
            return dest;
          });
        } catch {
          return null;
        } finally {
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, downloadTask);
      return downloadTask;
    },

    setLimitBytes(nextMaxBytes: number): Promise<void> {
      return runExclusive(async () => {
        await ensureInitialized();
        const evicted = index.setMaxBytes(clampLimit(nextMaxBytes));
        await deleteEvicted(evicted);
        await persistIndex();
      });
    },

    clear(): Promise<void> {
      return runExclusive(async () => {
        await ensureInitialized();
        index.clear();
        loadedUris.clear();
        if (fs) {
          const listed = await fs
            .listFiles(cacheDir)
            .catch(() => [] as readonly ArtworkCacheFsEntry[]);
          for (const entry of listed) {
            await fs.deleteFile(`${cacheDir}/${entry.name}`).catch(() => undefined);
          }
        }
        await options?.onClear?.();
      });
    },

    stats(): Promise<ArtworkCacheStats> {
      return runExclusive(async () => {
        await ensureInitialized();
        return index.stats();
      });
    },
  };
}
