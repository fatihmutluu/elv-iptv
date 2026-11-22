import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCanvasEndpoint, type IoSurfaceResolver, loadIoSurfaceAddon } from './iosurface.ts';

describe('loadIoSurfaceAddon', () => {
  it('loads and validates lookup and release exports via dlopenFn', () => {
    const fakeBuf = Buffer.alloc(8, 0xaa);
    const lookup = vi.fn((id: number) => (id === 42 ? fakeBuf : null));
    const release = vi.fn();
    const dlopen = vi.fn((mod: { exports: unknown }, filename: string) => {
      expect(filename).toBe('/fake/elv-iosurface.node');
      mod.exports = { lookup, release };
    });

    const resolver: IoSurfaceResolver = loadIoSurfaceAddon('/fake/elv-iosurface.node', dlopen);
    expect(dlopen).toHaveBeenCalledTimes(1);
    expect(resolver.lookup(42)).toBe(fakeBuf);
    expect(resolver.lookup(99)).toBeNull();
    resolver.release(fakeBuf);
    expect(release).toHaveBeenCalledWith(fakeBuf);
  });

  it('throws a clear error when lookup or release is missing or not a function', () => {
    expect(() =>
      loadIoSurfaceAddon('/bad/missing-lookup.node', (mod) => {
        mod.exports = { release: () => undefined };
      }),
    ).toThrow(/lookup|release|IOSurface/i);

    expect(() =>
      loadIoSurfaceAddon('/bad/missing-release.node', (mod) => {
        mod.exports = { lookup: () => null };
      }),
    ).toThrow(/lookup|release|IOSurface/i);

    expect(() =>
      loadIoSurfaceAddon('/bad/non-object.node', (mod) => {
        mod.exports = null;
      }),
    ).toThrow(/lookup|release|IOSurface/i);
  });

  it('caches by addonPath when using the default process.dlopen', () => {
    let loads = 0;
    const spy = vi.spyOn(process, 'dlopen').mockImplementation((mod: object, _filename: string) => {
      loads += 1;
      (mod as { exports: unknown }).exports = {
        lookup: () => null,
        release: () => undefined,
      };
    });
    try {
      const a1 = loadIoSurfaceAddon('/cached/a/elv-iosurface.node');
      const a2 = loadIoSurfaceAddon('/cached/a/elv-iosurface.node');
      const b1 = loadIoSurfaceAddon('/cached/b/elv-iosurface.node');
      expect(a1).toBe(a2);
      expect(b1).not.toBe(a1);
      expect(loads).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createCanvasEndpoint', () => {
  it('creates unique Windows named pipes on win32 with no-op cleanup', () => {
    const ep1 = createCanvasEndpoint('win32');
    const ep2 = createCanvasEndpoint('win32');
    expect(ep1.path).toMatch(/^\\\\\.\\pipe\\elv-mpv-canvas-[0-9a-f]{16}$/);
    expect(ep2.path).toMatch(/^\\\\\.\\pipe\\elv-mpv-canvas-[0-9a-f]{16}$/);
    expect(ep1.path).not.toBe(ep2.path);
    expect(ep1.onListening).toBeUndefined();
    expect(() => ep1.cleanup()).not.toThrow();
  });

  it('creates a private temp directory and c.sock path on darwin and removes it on cleanup', () => {
    const ep = createCanvasEndpoint('darwin');
    const dir = dirname(ep.path);
    try {
      expect(ep.path).toBe(join(dir, 'c.sock'));
      expect(ep.path.length).toBeLessThanOrEqual(96);
      expect(existsSync(dir)).toBe(true);
      expect(typeof ep.onListening).toBe('function');
      expect(() => ep.onListening?.()).not.toThrow();
    } finally {
      ep.cleanup();
    }
    expect(existsSync(dir)).toBe(false);
    // Cleanup is idempotent
    expect(() => ep.cleanup()).not.toThrow();
  });

  it('falls back to /tmp when tmpdir() would exceed the 96-byte Unix socket limit and applies chmod 0o600', () => {
    const longTmp =
      '/var/folders/xx/very-long-macos-per-user-temporary-directory-path-exceeding-limit/T';
    const mkdtempSync = vi.fn((prefix: string) => `${prefix}abcdef`);
    const chmodSync = vi.fn();
    const rmSync = vi.fn();

    const ep = createCanvasEndpoint('darwin', {
      tmpdir: () => longTmp,
      mkdtempSync,
      chmodSync,
      rmSync,
    });

    expect(mkdtempSync).toHaveBeenCalledWith(join('/tmp', 'elv-c-'));
    const expectedDir = `${join('/tmp', 'elv-c-')}abcdef`;
    expect(ep.path).toBe(join(expectedDir, 'c.sock'));
    expect(ep.path.length).toBeLessThanOrEqual(96);

    ep.onListening?.();
    expect(chmodSync).toHaveBeenCalledWith(ep.path, 0o600);

    ep.cleanup();
    ep.cleanup();
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledWith(expectedDir, { recursive: true, force: true });
  });

  it('checks UTF-8 byte length (not UTF-16 code units) so non-ASCII tmpdir falls back to /tmp', () => {
    const nonAsciiTmp = `/tmp/${'ü'.repeat(42)}`;
    expect(join(nonAsciiTmp, 'elv-c-XXXXXX', 'c.sock').length).toBeLessThanOrEqual(96);
    expect(Buffer.byteLength(join(nonAsciiTmp, 'elv-c-XXXXXX', 'c.sock'), 'utf8')).toBeGreaterThan(
      96,
    );
    const mkdtempSync = vi.fn((prefix: string) => `${prefix}utf8ok`);

    const ep = createCanvasEndpoint('darwin', {
      tmpdir: () => nonAsciiTmp,
      mkdtempSync,
      chmodSync: () => undefined,
      rmSync: () => undefined,
    });

    expect(mkdtempSync).toHaveBeenCalledWith(join('/tmp', 'elv-c-'));
    expect(Buffer.byteLength(ep.path, 'utf8')).toBeLessThanOrEqual(96);
  });

  it('swallows chmodSync and rmSync errors in onListening and cleanup', () => {
    const ep = createCanvasEndpoint('darwin', {
      tmpdir: () => '/tmp',
      mkdtempSync: (prefix) => `${prefix}123456`,
      chmodSync: () => {
        throw new Error('EPERM');
      },
      rmSync: () => {
        throw new Error('EBUSY');
      },
    });

    expect(() => ep.onListening?.()).not.toThrow();
    expect(() => ep.cleanup()).not.toThrow();
  });
});
