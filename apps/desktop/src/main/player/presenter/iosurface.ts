import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Native macOS IOSurface lookup/release bridge loaded from `elv-iosurface.node`. */
export interface IoSurfaceResolver {
  lookup(surfaceId: number): Buffer | null;
  release(surfaceBuf: Buffer): void;
}

/** Platform-specific shared texture handle accepted by Electron's `sharedTexture.importSharedTexture`. */
export type SharedTexturePlatformHandle = { ntHandle: Buffer } | { ioSurface: Buffer };

/** Injectable `process.dlopen` signature for loading native N-API `.node` addons. */
export type DlopenFn = (module: { exports: unknown }, filename: string) => void;

/** Per-presenter IPC endpoint (Windows named pipe or macOS private Unix domain socket). */
export interface CanvasEndpoint {
  path: string;
  onListening?(): void;
  cleanup(): void;
}

/** Optional filesystem hooks for testing `createCanvasEndpoint` without touching host `/tmp`. */
export interface CanvasEndpointDeps {
  tmpdir?: () => string;
  mkdtempSync?: (prefix: string) => string;
  chmodSync?: (path: string, mode: number) => void;
  rmSync?: (path: string, options: { recursive: boolean; force: boolean }) => void;
}

const MAX_UNIX_SOCK_PATH = 96;
const UINT32_MAX = 0xffff_ffffn;
const addonCache = new Map<string, IoSurfaceResolver>();

/**
 * Loads the native `elv-iosurface.node` N-API addon via `process.dlopen` and validates its
 * `lookup` and `release` exports. Cached per `addonPath` when using the default `process.dlopen`.
 */
export function loadIoSurfaceAddon(
  addonPath: string,
  dlopenFn: DlopenFn = process.dlopen,
): IoSurfaceResolver {
  const useCache = dlopenFn === process.dlopen;
  if (useCache) {
    const cached = addonCache.get(addonPath);
    if (cached) return cached;
  }

  const mod: { exports: unknown } = { exports: {} };
  dlopenFn(mod, addonPath);
  const exportsObj = mod.exports as Partial<IoSurfaceResolver> | null | undefined;
  if (
    !exportsObj ||
    typeof exportsObj !== 'object' ||
    typeof exportsObj.lookup !== 'function' ||
    typeof exportsObj.release !== 'function'
  ) {
    throw new Error(
      `Invalid IOSurface addon at ${addonPath}: expected lookup and release function exports`,
    );
  }

  const resolver: IoSurfaceResolver = {
    lookup: exportsObj.lookup,
    release: exportsObj.release,
  };
  if (useCache) addonCache.set(addonPath, resolver);
  return resolver;
}

/**
 * Creates a per-presenter canvas IPC endpoint: an exclusive Windows named pipe on `'win32'`,
 * or a Unix domain socket inside a `0o700` private temporary directory on POSIX platforms
 * (falling back to `'/tmp'` whenever `tmpdir()` would exceed macOS's 104-byte `SUN_LEN`).
 */
export function createCanvasEndpoint(
  platform: NodeJS.Platform,
  deps?: CanvasEndpointDeps,
): CanvasEndpoint {
  if (platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\elv-mpv-canvas-${randomBytes(8).toString('hex')}`,
      cleanup: () => undefined,
    };
  }

  const getTmpDir = deps?.tmpdir ?? tmpdir;
  const makeTempDir = deps?.mkdtempSync ?? mkdtempSync;
  const chmod = deps?.chmodSync ?? chmodSync;
  const remove = deps?.rmSync ?? rmSync;

  const candidateTmp = getTmpDir();
  const baseDir =
    Buffer.byteLength(join(candidateTmp, 'elv-c-XXXXXX', 'c.sock'), 'utf8') > MAX_UNIX_SOCK_PATH
      ? '/tmp'
      : candidateTmp;
  const dir = makeTempDir(join(baseDir, 'elv-c-'));
  const path = join(dir, 'c.sock');
  let cleaned = false;

  return {
    path,
    onListening() {
      try {
        chmod(path, 0o600);
      } catch {
        // best-effort permission tightening
      }
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        remove(dir, { recursive: true, force: true });
      } catch {
        // best-effort temp directory cleanup
      }
    },
  };
}

/** Resolves a `CanvasEndpoint` from optional presenter overrides, defaulting to a Windows named pipe. */
export function resolveCanvasEndpoint(
  createEndpoint?: () => CanvasEndpoint,
  generatePipeName?: () => string,
): CanvasEndpoint {
  if (createEndpoint) return createEndpoint();
  if (generatePipeName) return { path: generatePipeName(), cleanup: () => undefined };
  return createCanvasEndpoint('win32');
}

/**
 * Resolves a canvas pipe surface handle into a platform `SharedTexturePlatformHandle`
 * (`ioSurface` via `resolver` on macOS, or an 8-byte LE `ntHandle` on Windows), runs `useHandle`,
 * and guarantees `resolver.release(ioSurface)` in `finally`.
 */
export function withPlatformSurfaceHandle<T>(
  handle: bigint,
  resolver: IoSurfaceResolver | undefined,
  useHandle: (platformHandle: SharedTexturePlatformHandle) => T,
): T | undefined {
  if (resolver) {
    if (handle > UINT32_MAX) return undefined;
    let ioSurface: Buffer | null = null;
    try {
      ioSurface = resolver.lookup(Number(handle));
    } catch {
      return undefined;
    }
    if (!ioSurface) return undefined;
    try {
      return useHandle({ ioSurface });
    } catch {
      return undefined;
    } finally {
      try {
        resolver.release(ioSurface);
      } catch {
        // best-effort CFRelease
      }
    }
  }
  const ntHandle = Buffer.alloc(8);
  ntHandle.writeBigUInt64LE(handle, 0);
  try {
    return useHandle({ ntHandle });
  } catch {
    return undefined;
  }
}
