import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTWORK_PROTOCOL_ORIGIN } from '../shared/artwork-ipc.ts';
import {
  detectImageMimeType,
  resolveArtworkFile,
  serveArtworkRequest,
} from './artwork-protocol.ts';

const VALID_KEY = 'a'.repeat(64);
const root = resolve('/srv/user-data/artwork-cache');

describe('resolveArtworkFile (#405)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves canonical elv-art://cache/<64-hex> URLs strictly inside cacheDir', () => {
    expect(resolveArtworkFile(root, `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}`)).toBe(
      resolve(root, `${VALID_KEY}.img`),
    );
  });

  it.each([
    `${ARTWORK_PROTOCOL_ORIGIN}/../secret`,
    `${ARTWORK_PROTOCOL_ORIGIN}/%2e%2e/secret`,
    `${ARTWORK_PROTOCOL_ORIGIN}/..%5csecret`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}/../other`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}.img`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY.toUpperCase()}`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${'g'.repeat(64)}`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${'a'.repeat(63)}`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${'a'.repeat(65)}`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}?v=1`,
    `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}#hash`,
    `${ARTWORK_PROTOCOL_ORIGIN}/index.json`,
    `elv-art://other/${VALID_KEY}`,
    `elv-art://user:pass@cache/${VALID_KEY}`,
    `elv-art://cache:8080/${VALID_KEY}`,
    `https://cache/${VALID_KEY}`,
    'not-a-url',
  ])('rejects traversal, non-hex, and malformed URL %s', (url) => {
    expect(resolveArtworkFile(root, url)).toBeNull();
  });

  it('rejects symlinks escaping cacheDir while allowing regular files inside cacheDir', () => {
    const base = mkdtempSync(join(tmpdir(), 'elv-art-proto-'));
    tempDirs.push(base);
    const cacheDir = join(base, 'artwork-cache');
    const outsideDir = join(base, 'outside');
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const regularFile = join(cacheDir, `${VALID_KEY}.img`);
    writeFileSync(regularFile, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(resolveArtworkFile(cacheDir, `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}`)).toBe(
      resolve(regularFile),
    );

    const outsideSecret = join(outsideDir, 'secret.txt');
    writeFileSync(outsideSecret, 'top-secret');
    const escapeKey = 'f'.repeat(64);
    const escapeLink = join(cacheDir, `${escapeKey}.img`);
    let createdSymlink = false;
    try {
      symlinkSync(outsideSecret, escapeLink, 'file');
      createdSymlink = true;
    } catch {
      // Unprivileged Windows without Developer Mode may disallow file symlinks.
    }
    if (createdSymlink) {
      expect(resolveArtworkFile(cacheDir, `${ARTWORK_PROTOCOL_ORIGIN}/${escapeKey}`)).toBeNull();
    }
  });
});

describe('detectImageMimeType & serveArtworkRequest (#405)', () => {
  it('sniffs common raster image MIME types from magic bytes', () => {
    expect(
      detectImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(
      'image/gif',
    );
    expect(
      detectImageMimeType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp');
    expect(
      detectImageMimeType(
        new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
      ),
    ).toBe('image/avif');
    expect(detectImageMimeType(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('image/bmp');
    expect(detectImageMimeType(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBe('image/x-icon');
    expect(detectImageMimeType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('serves cached files with sniffed Content-Type and answers 404 without touching disk for invalid URLs', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const isFile = vi.fn(async () => true);
    const readFile = vi.fn(async () => pngBytes);

    const ok = await serveArtworkRequest(root, `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}`, {
      isFile,
      readFile,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(pngBytes);

    isFile.mockClear();
    readFile.mockClear();
    const bad = await serveArtworkRequest(root, `${ARTWORK_PROTOCOL_ORIGIN}/../secret`, {
      isFile,
      readFile,
    });
    expect(bad.status).toBe(404);
    expect(isFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();

    const missing = await serveArtworkRequest(root, `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}`, {
      isFile: async () => false,
      readFile,
    });
    expect(missing.status).toBe(404);

    const readErr = await serveArtworkRequest(root, `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}`, {
      isFile: async () => true,
      readFile: async () => {
        throw new Error('EACCES');
      },
    });
    expect(readErr.status).toBe(404);

    const raw = await serveArtworkRequest(root, `${ARTWORK_PROTOCOL_ORIGIN}/${VALID_KEY}`, {
      isFile: async () => true,
      readFile: async () => new Uint8Array([1, 2, 3, 4]),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('application/octet-stream');
  });
});
