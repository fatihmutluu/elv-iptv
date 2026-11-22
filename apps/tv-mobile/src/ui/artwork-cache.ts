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
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_INDEX_FLUSH_DELAY_MS = 1_500;
const MAX_REDIRECTS = 3;
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
  writeBytes?(path: string, data: Uint8Array): Promise<void>;
  downloadToFile?(
    url: string,
    destinationPath: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: number } | null>;
  deleteFile(path: string): Promise<void>;
}

/** Expo SDK 58 native `FileSystem` or legacy `expo-file-system` compatible module shape. */
export interface ExpoFileSystemLike {
  readonly cacheDirectory?: string | null;
  readonly FileSystemDirectory?: new (
    uri: string,
  ) => {
    create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
    listAsRecords(): Array<{ readonly isDirectory: boolean; readonly uri: string }>;
  };
  readonly FileSystemFile?: new (
    uri: string,
  ) => {
    info(): { exists: boolean; size?: number; modificationTime?: number };
    text(): Promise<string>;
    write(content: string | Uint8Array): Promise<void>;
    delete(): void;
  };
  makeDirectoryAsync?(dir: string, options?: { intermediates?: boolean }): Promise<void>;
  readDirectoryAsync?(dir: string): Promise<string[]>;
  getInfoAsync?(
    path: string,
  ): Promise<{ exists: boolean; size?: number; modificationTime?: number }>;
  readAsStringAsync?(path: string): Promise<string>;
  writeAsStringAsync?(path: string, contents: string): Promise<void>;
  deleteAsync?(path: string, options?: { idempotent?: boolean }): Promise<void>;
  downloadAsync?(
    uri: string,
    fileUri: string,
  ): Promise<{ status: number; headers?: Record<string, string> }>;
}

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(rawHost: string): boolean {
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const lower = host.toLowerCase();
  if (
    lower === '::1' ||
    lower === '::' ||
    lower === '0:0:0:0:0:0:0:0' ||
    lower === '0:0:0:0:0:0:0:1' ||
    /^fe[89ab][0-9a-f]:/.test(lower) ||
    /^f[cd][0-9a-f]{2}:/.test(lower)
  ) {
    return true;
  }
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (v4Mapped?.[1] && isPrivateIpv4(v4Mapped[1])) return true;
  const v4HexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (v4HexMapped?.[1] && v4HexMapped[2]) {
    const hi = Number.parseInt(v4HexMapped[1], 16);
    const lo = Number.parseInt(v4HexMapped[2], 16);
    return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  return false;
}

/** Validates that a mobile/TV artwork URL is HTTP/HTTPS without credentials, control chars, or SSRF targets (`#405`). */
export function isSafeMobileArtworkUrl(
  uri: string,
  opts?: { readonly allowPrivateHosts?: boolean },
): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_CHARS) return false;
  for (let i = 0; i < uri.length; i += 1) {
    const code = uri.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return false;
  if (opts?.allowPrivateHosts) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateIpv4(host)) return false;
  return !(host.includes(':') && isPrivateIpv6(host));
}

function isAllowedImageContentType(header: string | null | undefined): boolean {
  if (header === null || header === undefined) return true;
  const mime = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime.length === 0) return true;
  if (mime === 'application/octet-stream') return true;
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

function findHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const lenHeader = response.headers.get('content-length');
  if (lenHeader !== null) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
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

async function fetchBoundedArtwork(
  uri: string,
  maxBytes: number,
  opts: {
    readonly fetchFn: typeof globalThis.fetch;
    readonly timeoutMs: number;
    readonly allowPrivateHosts: boolean;
  },
): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let currentUrl = uri;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await opts.fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get('location');
        if (!loc) return null;
        const nextUrl = new URL(loc, currentUrl).toString();
        if (!isSafeMobileArtworkUrl(nextUrl, { allowPrivateHosts: opts.allowPrivateHosts })) {
          return null;
        }
        currentUrl = nextUrl;
        continue;
      }
      break;
    }
    if (!response?.ok) return null;
    if (!isAllowedImageContentType(response.headers.get('content-type'))) return null;
    return await readBoundedBody(response, maxBytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Adapts an Expo SDK 58 native `FileSystem` or legacy `expo-file-system` module to {@link ArtworkCacheFsPort}. */
export function createExpoFileSystemPort(fs: ExpoFileSystemLike): ArtworkCacheFsPort | undefined {
  if (!fs.cacheDirectory) return undefined;
  const cacheDirectory = stripTrailingSlash(fs.cacheDirectory);

  if (fs.FileSystemDirectory && fs.FileSystemFile) {
    const NativeDir = fs.FileSystemDirectory;
    const NativeFile = fs.FileSystemFile;
    return {
      cacheDirectory,
      async ensureDir(dir: string): Promise<void> {
        new NativeDir(dir).create({ intermediates: true, idempotent: true });
      },
      async listFiles(dir: string): Promise<readonly ArtworkCacheFsEntry[]> {
        const records = new NativeDir(dir).listAsRecords();
        const out: ArtworkCacheFsEntry[] = [];
        for (const record of records) {
          if (record.isDirectory) continue;
          const cleanUri = stripTrailingSlash(record.uri);
          const slashIdx = cleanUri.lastIndexOf('/');
          const name = slashIdx >= 0 ? cleanUri.slice(slashIdx + 1) : cleanUri;
          if (!name) continue;
          const info = new NativeFile(record.uri).info();
          if (!info.exists) continue;
          const size = typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : 0;
          const modifiedMs =
            typeof info.modificationTime === 'number' && Number.isFinite(info.modificationTime)
              ? info.modificationTime
              : undefined;
          out.push({ name, size, ...(modifiedMs !== undefined ? { modifiedMs } : {}) });
        }
        return out;
      },
      async readText(path: string): Promise<string | null> {
        try {
          return await new NativeFile(path).text();
        } catch {
          return null;
        }
      },
      async writeText(path: string, content: string): Promise<void> {
        await new NativeFile(path).write(content);
      },
      async writeBytes(path: string, data: Uint8Array): Promise<void> {
        await new NativeFile(path).write(data);
      },
      async deleteFile(path: string): Promise<void> {
        try {
          new NativeFile(path).delete();
        } catch {
          // Idempotent delete for missing files.
        }
      },
    };
  }

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
        out.push({ name, size, ...(modifiedMs !== undefined ? { modifiedMs } : {}) });
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
      if (!fs.downloadAsync || !fs.getInfoAsync || !isSafeMobileArtworkUrl(url)) return null;
      const result = await fs.downloadAsync(url, destinationPath);
      const contentType = findHeaderCaseInsensitive(result.headers, 'content-type');
      if (result.status < 200 || result.status >= 300 || !isAllowedImageContentType(contentType)) {
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
  readonly timeoutMs?: number;
  readonly indexFlushDelayMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowPrivateHosts?: boolean;
  readonly deadHosts?: DeadHostRegistry;
  readonly loadedUris?: LoadedUriCache;
  readonly onClear?: () => Promise<void> | void;
}

/** Bounded LRU mobile/TV artwork cache with lifecycle flush support (`#405`). */
export interface MobileArtworkCache extends ArtworkCacheAdapter {
  dispose(): Promise<void>;
}

/**
 * Creates a bounded LRU disk artwork cache adapter for mobile/TV targets (`#405`).
 * Reconciles persisted LRU state against files on disk, skips dead hosts, enforces SSRF + size
 * bounds before persisting, debounces index writes on hits, and degrades cleanly without FS.
 */
export function createMobileArtworkCache(options?: MobileArtworkCacheOptions): MobileArtworkCache {
  const fs = options?.fs;
  const deadHosts = options?.deadHosts ?? defaultDeadHostRegistry;
  const loadedUris = options?.loadedUris ?? defaultLoadedArtworkUris;
  const minLimit = Math.max(1, Math.floor(options?.minLimitBytes ?? MIN_LIMIT_BYTES));
  const maxLimit = Math.max(minLimit, Math.floor(options?.maxLimitBytes ?? MAX_LIMIT_BYTES));
  const maxEntryBytes = Math.max(1, Math.floor(options?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES));
  const timeoutMs = Math.max(10, Math.floor(options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS));
  const indexFlushDelayMs = Math.max(
    1,
    Math.floor(options?.indexFlushDelayMs ?? DEFAULT_INDEX_FLUSH_DELAY_MS),
  );
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const allowPrivateHosts = Boolean(options?.allowPrivateHosts);

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
  let indexDirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
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

  const cancelScheduledFlush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const persistIndexNow = async (): Promise<void> => {
    cancelScheduledFlush();
    indexDirty = false;
    if (!fs) return;
    await fs.writeText(indexPath, JSON.stringify({ entries: index.snapshot() }));
  };

  const scheduleIndexFlush = (): void => {
    if (!fs) return;
    indexDirty = true;
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void runExclusive(async () => {
        if (!initialized || !indexDirty) return;
        await persistIndexNow();
      }).catch(() => undefined);
    }, indexFlushDelayMs);
    (flushTimer as { unref?: () => void }).unref?.();
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
    await persistIndexNow();
    initialized = true;
  };

  return {
    async resolveUri(uri: string, maxDecodePx: number): Promise<string | null> {
      const trimmed = uri.trim();
      if (
        !fs ||
        !isSafeMobileArtworkUrl(trimmed, { allowPrivateHosts }) ||
        deadHosts.isDead(trimmed)
      ) {
        return null;
      }

      const key = hashArtworkKey(trimmed, Math.max(32, Math.round(maxDecodePx)));
      const hit = await runExclusive(async () => {
        await ensureInitialized();
        if (!index.touch(key)) return null;
        scheduleIndexFlush();
        return filePathFor(key);
      });
      if (hit !== null) return hit;
      if (!fs.writeBytes && !fs.downloadToFile) return null;

      const existingFlight = inFlight.get(key);
      if (existingFlight) return existingFlight;

      const downloadTask = (async (): Promise<string | null> => {
        try {
          const dest = filePathFor(key);
          const budget = Math.min(maxEntryBytes, index.stats().maxBytes);
          let byteCount = 0;

          if (fs.writeBytes) {
            const bytes = await fetchBoundedArtwork(trimmed, budget, {
              fetchFn,
              timeoutMs,
              allowPrivateHosts,
            });
            if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > budget) return null;
            await fs.writeBytes(dest, bytes);
            byteCount = bytes.byteLength;
          } else {
            const result = await fs.downloadToFile?.(trimmed, dest, budget);
            if (!result || result.bytes <= 0 || result.bytes > budget) {
              await fs.deleteFile(dest).catch(() => undefined);
              return null;
            }
            byteCount = result.bytes;
          }

          return await runExclusive(async () => {
            await ensureInitialized();
            if (byteCount > index.stats().maxBytes) {
              await fs.deleteFile(dest).catch(() => undefined);
              return null;
            }
            const evicted = index.put(key, byteCount);
            await deleteEvicted(evicted);
            await persistIndexNow();
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
        await persistIndexNow();
      });
    },

    clear(): Promise<void> {
      return runExclusive(async () => {
        cancelScheduledFlush();
        indexDirty = false;
        await ensureInitialized();
        cancelScheduledFlush();
        indexDirty = false;
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

    dispose(): Promise<void> {
      cancelScheduledFlush();
      return runExclusive(async () => {
        if (!initialized || !indexDirty) return;
        await persistIndexNow();
      });
    },
  };
}
