import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTWORK_CHANNELS, isSafeArtworkUrl } from '../shared/artwork-ipc.ts';
import { createDesktopArtworkCache, registerArtworkIpc } from './artwork-cache.ts';

const tempDirs: string[] = [];

async function makeTempUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'elv-artwork-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('isSafeArtworkUrl (#405)', () => {
  it('allows public HTTP/HTTPS artwork URLs and blocks unsafe schemes, credentials, and private/metadata hosts', () => {
    expect(isSafeArtworkUrl('https://cdn.example/posters/a.jpg')).toBe(true);
    expect(isSafeArtworkUrl('http://img.provider.test:8080/logo.png')).toBe(true);

    expect(isSafeArtworkUrl('')).toBe(false);
    expect(isSafeArtworkUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeArtworkUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSafeArtworkUrl('https://user:pass@cdn.example/a.jpg')).toBe(false);
    expect(isSafeArtworkUrl('https://cdn.example/a\n.jpg')).toBe(false);
    expect(isSafeArtworkUrl('http://localhost/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://sub.localhost/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://127.0.0.1/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeArtworkUrl('http://10.0.0.5/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://192.168.1.10/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://172.16.0.1/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[fe80::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[fc00::1]/logo.png')).toBe(false);
    expect(isSafeArtworkUrl('http://[::ffff:127.0.0.1]/logo.png')).toBe(false);
  });
});

describe('createDesktopArtworkCache (#405)', () => {
  it('stores SHA-256 keyed files under userData/artwork-cache, enforces LRU eviction, and reconciles on restart', async () => {
    const userDataDir = await makeTempUserData();
    const cache = createDesktopArtworkCache({
      userDataDir,
      maxBytes: 100,
      minLimitBytes: 10,
      maxLimitBytes: 500,
      maxEntryBytes: 100,
    });

    const pA = await cache.put('https://cdn.example/a.jpg', new Uint8Array(40));
    const pB = await cache.put('https://cdn.example/b.jpg', new Uint8Array(40));
    expect(pA).not.toBeNull();
    expect(pB).not.toBeNull();
    expect(await cache.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });

    // Touch A so B becomes LRU
    expect(await cache.get('https://cdn.example/a.jpg')).toBe(pA);

    // Put C (40 bytes) -> evicts B from disk
    const pC = await cache.put('https://cdn.example/c.jpg', new Uint8Array(40));
    expect(pC).not.toBeNull();
    expect(await cache.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });
    expect(await cache.get('https://cdn.example/b.jpg')).toBeNull();
    if (pB) {
      await expect(stat(pB)).rejects.toThrow();
    }

    // Reject oversized entry without thrashing existing files
    expect(await cache.put('https://cdn.example/huge.jpg', new Uint8Array(101))).toBeNull();
    expect(await cache.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });

    // Leave a stale .tmp file and verify a fresh instance reconciles disk state cleanly
    await writeFile(join(cache.dir, '.tmp-leftover'), new Uint8Array(12));
    const restarted = createDesktopArtworkCache({
      userDataDir,
      maxBytes: 100,
      minLimitBytes: 10,
      maxLimitBytes: 500,
      maxEntryBytes: 100,
    });
    expect(await restarted.stats()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });
    expect(await restarted.get('https://cdn.example/a.jpg')).toBe(pA);
    const files = await readdir(cache.dir);
    expect(files.some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  it('recovers from corrupt index.json, shrinks on setLimitBytes, and wipes files + invokes onClear on clear()', async () => {
    const userDataDir = await makeTempUserData();
    const onClear = vi.fn(async () => undefined);
    const cache = createDesktopArtworkCache({
      userDataDir,
      maxBytes: 120,
      minLimitBytes: 20,
      maxLimitBytes: 500,
      maxEntryBytes: 120,
      onClear,
    });

    await cache.put('https://cdn.example/1.jpg', new Uint8Array(50));
    await cache.put('https://cdn.example/2.jpg', new Uint8Array(50));
    expect(await cache.stats()).toEqual({ bytes: 100, entries: 2, maxBytes: 120 });

    // Shrink ceiling -> evicts oldest entry
    await cache.setLimitBytes(60);
    expect(await cache.stats()).toEqual({ bytes: 50, entries: 1, maxBytes: 60 });

    // Corrupt index.json and restart -> adopts existing .img file safely
    await writeFile(join(cache.dir, 'index.json'), '{not-valid-json', 'utf8');
    const recovered = createDesktopArtworkCache({
      userDataDir,
      maxBytes: 120,
      minLimitBytes: 20,
      maxLimitBytes: 500,
      maxEntryBytes: 120,
      onClear,
    });
    expect(await recovered.stats()).toEqual({ bytes: 50, entries: 1, maxBytes: 120 });

    await recovered.clear();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(await recovered.stats()).toEqual({ bytes: 0, entries: 0, maxBytes: 120 });
    expect(await readdir(cache.dir)).toEqual([]);
  });

  it('fetches and caches valid remote artwork, rejects SSRF redirects, oversized streams, and timeouts', async () => {
    const userDataDir = await makeTempUserData();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://cdn.example/poster.jpg') {
        return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          status: 200,
          headers: { 'content-length': '5' },
        });
      }
      if (url === 'https://cdn.example/ssrf-redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      if (url === 'https://cdn.example/too-big') {
        return new Response(new Uint8Array(200), { status: 200 });
      }
      if (url === 'https://cdn.example/slow') {
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 5);
        });
      }
      return new Response(null, { status: 404 });
    });

    const cache = createDesktopArtworkCache({
      userDataDir,
      maxBytes: 100,
      minLimitBytes: 10,
      maxLimitBytes: 500,
      maxEntryBytes: 64,
      timeoutMs: 50,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const first = await cache.fetchAndCache('https://cdn.example/poster.jpg');
    expect(first).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second fetch hits disk cache directly
    const second = await cache.fetchAndCache('https://cdn.example/poster.jpg');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Unsafe URL, SSRF redirect, oversized response, 404, and timeout all return null cleanly
    expect(await cache.fetchAndCache('http://127.0.0.1/secret.png')).toBeNull();
    expect(await cache.fetchAndCache('https://cdn.example/ssrf-redirect')).toBeNull();
    expect(await cache.fetchAndCache('https://cdn.example/too-big')).toBeNull();
    expect(await cache.fetchAndCache('https://cdn.example/missing')).toBeNull();
    expect(await cache.fetchAndCache('https://cdn.example/slow')).toBeNull();
    expect(await cache.stats()).toEqual({ bytes: 5, entries: 1, maxBytes: 100 });
  });
});

describe('registerArtworkIpc (#405)', () => {
  it('registers artwork:clear, artwork:set-limit, and artwork:stats handlers, validates input, and disposes cleanly', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    };
    const cache = {
      dir: '/tmp/artwork-cache',
      get: vi.fn(async () => null),
      put: vi.fn(async () => null),
      fetchAndCache: vi.fn(async () => null),
      setLimitBytes: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      stats: vi.fn(async () => ({ bytes: 42, entries: 1, maxBytes: 128 * 1024 * 1024 })),
    };
    const log = vi.fn();

    const dispose = registerArtworkIpc({ ipcMain, cache, log });
    expect([...handlers.keys()]).toEqual([
      ARTWORK_CHANNELS.clear,
      ARTWORK_CHANNELS.setLimit,
      ARTWORK_CHANNELS.stats,
    ]);

    await handlers.get(ARTWORK_CHANNELS.clear)?.({});
    expect(cache.clear).toHaveBeenCalledTimes(1);

    await handlers.get(ARTWORK_CHANNELS.setLimit)?.({}, 256 * 1024 * 1024);
    expect(cache.setLimitBytes).toHaveBeenCalledWith(256 * 1024 * 1024);

    await handlers.get(ARTWORK_CHANNELS.setLimit)?.({}, 'bad');
    expect(cache.setLimitBytes).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);

    const stats = await handlers.get(ARTWORK_CHANNELS.stats)?.({});
    expect(stats).toEqual({ bytes: 42, entries: 1, maxBytes: 128 * 1024 * 1024 });

    dispose();
    expect(handlers.size).toBe(0);
  });
});
