import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseArtworkProtocolKey } from '../shared/artwork-ipc.ts';

/** File access injected by the caller so `elv-art://` serving runs cleanly in tests without Electron. */
export interface ArtworkServeDeps {
  /** True only for an existing regular (non-symlink) file. */
  isFile(path: string): Promise<boolean>;
  /** Reads the file contents from disk; may reject. */
  readFile(path: string): Promise<Uint8Array>;
}

/**
 * Resolves a canonical `elv-art://cache/<64-lowercase-hex>` URL to `<cacheDir>/<key>.img`.
 * Rejects any traversal, non-hex key, wrong host/scheme/port/userinfo, query/fragment, or symlink
 * escaping `cacheDir`.
 */
export function resolveArtworkFile(cacheDir: string, requestUrl: string): string | null {
  const key = parseArtworkProtocolKey(requestUrl);
  if (key === null) return null;

  const root = resolve(cacheDir);
  const file = resolve(root, `${key}.img`);
  if (!file.startsWith(root + sep)) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? file : null;
  }

  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    const realFile = realpathSync(file);
    return realFile.startsWith(realRoot + sep) ? file : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? file : null;
  }
}

/** Sniffs common raster image MIME types from magic bytes for `.img` cache responses. */
export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.byteLength >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'image/png';
    }
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'image/avif';
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return 'image/x-icon';
  }
  return null;
}

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * Serves a cached artwork file strictly from `cacheDir` for `elv-art://cache/<sha256>` requests.
 * Rejects malformed URLs, traversal attempts, symlinks, directories, and missing files with 404.
 */
export async function serveArtworkRequest(
  cacheDir: string,
  requestUrl: string,
  deps: ArtworkServeDeps,
): Promise<Response> {
  const file = resolveArtworkFile(cacheDir, requestUrl);
  if (file === null) return notFound();
  try {
    if (!(await deps.isFile(file))) return notFound();
    const bytes = await deps.readFile(file);
    const mime = detectImageMimeType(bytes);
    const headers = new Headers({
      'Cache-Control': 'private, max-age=3600',
    });
    if (mime !== null) {
      headers.set('Content-Type', mime);
      headers.set('X-Content-Type-Options', 'nosniff');
    } else {
      headers.set('Content-Type', 'application/octet-stream');
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  } catch {
    return notFound();
  }
}
