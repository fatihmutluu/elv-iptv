import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Image: 'Image',
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  VirtualizedList: 'VirtualizedList',
  Animated: { Value: class {}, View: 'AnimatedView' },
  Platform: {
    OS: 'android',
    isTV: false,
    select: (map: Record<string, unknown>) => map.android ?? map.default,
  },
  StyleSheet: {
    create: <T>(styles: T): T => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  Dimensions: {
    get: () => ({ width: 1280, height: 720, scale: 1, fontScale: 1 }),
    addEventListener: () => ({ remove: () => undefined }),
  },
  PixelRatio: { getFontScale: () => 1 },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

import { createDeadHostRegistry, createLoadedUriCache } from '@elv/ui-kit';
import {
  type ArtworkCacheFsPort,
  createExpoFileSystemPort,
  createMobileArtworkCache,
} from './artwork-cache';

function createFakeFs(sizesByUrl: Record<string, number> = {}): {
  fs: ArtworkCacheFsPort;
  files: Map<string, { content: string; size: number; modifiedMs: number }>;
  downloads: ReturnType<typeof vi.fn>;
} {
  const files = new Map<string, { content: string; size: number; modifiedMs: number }>();
  let tick = 1000;
  const downloads = vi.fn(async (url: string, destinationPath: string, maxBytes: number) => {
    const size = sizesByUrl[url];
    if (size === undefined) return null;
    if (size > maxBytes) return null;
    tick += 10;
    files.set(destinationPath, { content: 'img', size, modifiedMs: tick });
    return { bytes: size };
  });

  const fs: ArtworkCacheFsPort = {
    cacheDirectory: 'file:///device/cache',
    async ensureDir() {
      return undefined;
    },
    async listFiles(dir: string) {
      const prefix = `${dir}/`;
      const out: Array<{ name: string; size: number; modifiedMs: number }> = [];
      for (const [path, entry] of files.entries()) {
        if (path.startsWith(prefix)) {
          out.push({
            name: path.slice(prefix.length),
            size: entry.size,
            modifiedMs: entry.modifiedMs,
          });
        }
      }
      return out;
    },
    async readText(path: string) {
      return files.get(path)?.content ?? null;
    },
    async writeText(path: string, content: string) {
      tick += 10;
      files.set(path, { content, size: content.length, modifiedMs: tick });
    },
    downloadToFile: downloads,
    async deleteFile(path: string) {
      files.delete(path);
    },
  };

  return { fs, files, downloads };
}

describe('createMobileArtworkCache (#405)', () => {
  it('downloads, caches, enforces LRU byte ceiling, shrinks on setLimitBytes, and clears files + loadedUris', async () => {
    const { fs, files, downloads } = createFakeFs({
      'https://cdn.example/a.jpg': 40,
      'https://cdn.example/b.jpg': 40,
      'https://cdn.example/c.jpg': 40,
      'https://cdn.example/huge.jpg': 200,
    });
    const deadHosts = createDeadHostRegistry();
    const loadedUris = createLoadedUriCache();
    loadedUris.markLoaded('https://cdn.example/a.jpg');
    const onClear = vi.fn(async () => undefined);

    const cache = createMobileArtworkCache({
      fs,
      maxBytes: 100,
      minLimitBytes: 20,
      maxLimitBytes: 500,
      maxEntryBytes: 100,
      deadHosts,
      loadedUris,
      onClear,
    });

    const localA = await cache.resolveUri?.('https://cdn.example/a.jpg', 320);
    const localB = await cache.resolveUri?.('https://cdn.example/b.jpg', 320);
    expect(localA).toMatch(/^file:\/\/\/device\/cache\/artwork-cache\/[a-f0-9]+\.img$/);
    expect(localB).toMatch(/^file:\/\/\/device\/cache\/artwork-cache\/[a-f0-9]+\.img$/);
    expect(await cache.stats?.()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });

    // Re-resolving A hits cache (touches A to MRU, no second download)
    expect(await cache.resolveUri?.('https://cdn.example/a.jpg', 320)).toBe(localA);
    expect(downloads).toHaveBeenCalledTimes(2);

    // Resolving C (40 bytes) must evict B from disk
    const localC = await cache.resolveUri?.('https://cdn.example/c.jpg', 320);
    expect(localC).not.toBeNull();
    expect(await cache.stats?.()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });
    expect(localB ? files.has(localB) : true).toBe(false);
    expect(localA ? files.has(localA) : false).toBe(true);

    // Oversized item is rejected without thrashing existing entries
    expect(await cache.resolveUri?.('https://cdn.example/huge.jpg', 320)).toBeNull();
    expect(await cache.stats?.()).toEqual({ bytes: 80, entries: 2, maxBytes: 100 });

    // Shrink limit -> evicts A, keeping C
    await cache.setLimitBytes?.(50);
    expect(await cache.stats?.()).toEqual({ bytes: 40, entries: 1, maxBytes: 50 });
    expect(localA ? files.has(localA) : true).toBe(false);

    // Clear wipes disk directory, loadedUris, and calls onClear
    await cache.clear();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(loadedUris.size).toBe(0);
    expect(files.size).toBe(0);
    expect(await cache.stats?.()).toEqual({ bytes: 0, entries: 0, maxBytes: 50 });
  });

  it('skips dead hosts and invalid/non-HTTP URIs cleanly without touching FS or network', async () => {
    const { fs, downloads } = createFakeFs({
      'https://dead.example/a.jpg': 40,
    });
    const deadHosts = createDeadHostRegistry();
    deadHosts.recordFailure('https://dead.example/a.jpg', { message: 'ENOTFOUND' });

    const cache = createMobileArtworkCache({
      fs,
      maxBytes: 100,
      minLimitBytes: 20,
      maxLimitBytes: 500,
      deadHosts,
    });

    expect(await cache.resolveUri?.('https://dead.example/a.jpg', 320)).toBeNull();
    expect(await cache.resolveUri?.('file:///etc/passwd', 320)).toBeNull();
    expect(await cache.resolveUri?.('https://user:pass@cdn.example/a.jpg', 320)).toBeNull();
    expect(downloads).not.toHaveBeenCalled();
  });

  it('reconciles persisted index against disk files on restart and degrades cleanly without FS', async () => {
    const { fs } = createFakeFs({
      'https://cdn.example/persisted.jpg': 48,
    });
    const first = createMobileArtworkCache({
      fs,
      maxBytes: 100,
      minLimitBytes: 20,
      maxLimitBytes: 500,
    });
    const cachedPath = await first.resolveUri?.('https://cdn.example/persisted.jpg', 240);
    expect(cachedPath).not.toBeNull();

    const restarted = createMobileArtworkCache({
      fs,
      maxBytes: 100,
      minLimitBytes: 20,
      maxLimitBytes: 500,
    });
    expect(await restarted.stats?.()).toEqual({ bytes: 48, entries: 1, maxBytes: 100 });
    expect(await restarted.resolveUri?.('https://cdn.example/persisted.jpg', 240)).toBe(cachedPath);

    // Without FS port
    const loadedUris = createLoadedUriCache();
    loadedUris.markLoaded('https://cdn.example/mem.jpg');
    const memoryOnly = createMobileArtworkCache({ loadedUris });
    expect(await memoryOnly.resolveUri?.('https://cdn.example/mem.jpg', 320)).toBeNull();
    await memoryOnly.setLimitBytes?.(256 * 1024 * 1024);
    expect(await memoryOnly.stats?.()).toEqual({
      bytes: 0,
      entries: 0,
      maxBytes: 256 * 1024 * 1024,
    });
    await memoryOnly.clear();
    expect(loadedUris.size).toBe(0);
  });

  it('adapts expo-file-system compatible modules via createExpoFileSystemPort', async () => {
    expect(createExpoFileSystemPort({ cacheDirectory: null })).toBeUndefined();

    const makeDirectoryAsync = vi.fn(async () => undefined);
    const readDirectoryAsync = vi.fn(async () => ['abc.img']);
    const getInfoAsync = vi.fn(async () => ({ exists: true, size: 64, modificationTime: 10 }));
    const readAsStringAsync = vi.fn(async () => '{"entries":[]}');
    const writeAsStringAsync = vi.fn(async () => undefined);
    const deleteAsync = vi.fn(async () => undefined);
    const downloadAsync = vi.fn(async () => ({ status: 200 }));

    const port = createExpoFileSystemPort({
      cacheDirectory: 'file:///expo/cache/',
      makeDirectoryAsync,
      readDirectoryAsync,
      getInfoAsync,
      readAsStringAsync,
      writeAsStringAsync,
      deleteAsync,
      downloadAsync,
    });
    if (!port) throw new Error('expected port');
    expect(port.cacheDirectory).toBe('file:///expo/cache');

    await port.ensureDir('file:///expo/cache/artwork-cache');
    expect(makeDirectoryAsync).toHaveBeenCalledWith('file:///expo/cache/artwork-cache', {
      intermediates: true,
    });
    expect(await port.listFiles('file:///expo/cache/artwork-cache')).toEqual([
      { name: 'abc.img', size: 64, modifiedMs: 10_000 },
    ]);
    expect(await port.readText('file:///expo/cache/artwork-cache/index.json')).toBe(
      '{"entries":[]}',
    );
    await port.writeText('file:///expo/cache/artwork-cache/index.json', '{}');
    expect(writeAsStringAsync).toHaveBeenCalledTimes(1);
    expect(
      await port.downloadToFile?.('https://cdn.example/a.jpg', 'file:///expo/cache/a.img', 100),
    ).toEqual({ bytes: 64 });
    await port.deleteFile('file:///expo/cache/a.img');
    expect(deleteAsync).toHaveBeenCalledWith('file:///expo/cache/a.img', { idempotent: true });
  });
});
