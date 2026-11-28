import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_DB_MMAP_SIZE_BYTES,
  CATALOG_WORKER_AUTO_SELECT_FAMILY_TIMEOUT_MS,
  configureCatalogWorkerRuntime,
  openHardenedCatalogDatabase,
} from './catalog-worker.ts';

describe('configureCatalogWorkerRuntime', () => {
  it('enables V8 compile cache and raises Node Happy Eyeballs timeout to 2500ms', () => {
    const enableCompileCache = vi.fn();
    const setDefaultAutoSelectFamilyAttemptTimeout = vi.fn();

    configureCatalogWorkerRuntime({
      enableCompileCache,
      setDefaultAutoSelectFamilyAttemptTimeout,
    });

    expect(CATALOG_WORKER_AUTO_SELECT_FAMILY_TIMEOUT_MS).toBe(2_500);
    expect(enableCompileCache).toHaveBeenCalledTimes(1);
    expect(setDefaultAutoSelectFamilyAttemptTimeout).toHaveBeenCalledWith(2_500);
  });

  it('respects an explicit --network-family-autoselection-attempt-timeout override in execArgv or NODE_OPTIONS (M5)', () => {
    const setTimeout1 = vi.fn();
    configureCatalogWorkerRuntime({
      enableCompileCache: vi.fn(),
      setDefaultAutoSelectFamilyAttemptTimeout: setTimeout1,
      execArgv: ['--network-family-autoselection-attempt-timeout=750'],
      nodeOptions: '',
    });
    expect(setTimeout1).not.toHaveBeenCalled();

    const setTimeout2 = vi.fn();
    configureCatalogWorkerRuntime({
      enableCompileCache: vi.fn(),
      setDefaultAutoSelectFamilyAttemptTimeout: setTimeout2,
      execArgv: [],
      nodeOptions: '--max-old-space-size=4096 --network-family-autoselection-attempt-timeout=1000',
    });
    expect(setTimeout2).not.toHaveBeenCalled();

    const setTimeout3 = vi.fn();
    configureCatalogWorkerRuntime({
      enableCompileCache: vi.fn(),
      setDefaultAutoSelectFamilyAttemptTimeout: setTimeout3,
      execArgv: ['--network-family-autoselection-attempt-timeout', '500'],
      nodeOptions: '',
    });
    expect(setTimeout3).not.toHaveBeenCalled();
  });

  it('swallows compile-cache or timeout errors safely on runtimes without support', () => {
    expect(() =>
      configureCatalogWorkerRuntime({
        enableCompileCache: () => {
          throw new Error('unsupported');
        },
        setDefaultAutoSelectFamilyAttemptTimeout: () => {
          throw new Error('unsupported');
        },
      }),
    ).not.toThrow();
    expect(() => configureCatalogWorkerRuntime({})).not.toThrow();
  });
});

describe('openHardenedCatalogDatabase', () => {
  it('creates parent directory with mode 0o700 and hardens db/wal/shm to 0o600 on POSIX', () => {
    const mkdir = vi.fn();
    const chmod = vi.fn();
    const exists = vi.fn((p: string) => p.endsWith('-wal'));
    const fakeDb = {} as Database.Database;
    const openDb = vi.fn(() => fakeDb);

    const db = openHardenedCatalogDatabase('/tmp/elv-user-data/catalog.db', {
      platform: 'linux',
      mkdir: mkdir as unknown as typeof import('node:fs').mkdirSync,
      chmod: chmod as unknown as typeof import('node:fs').chmodSync,
      exists: exists as unknown as typeof import('node:fs').existsSync,
      openDb,
    });

    expect(db).toBe(fakeDb);
    expect(mkdir).toHaveBeenCalledWith('/tmp/elv-user-data', { recursive: true, mode: 0o700 });
    expect(openDb).toHaveBeenCalledWith('/tmp/elv-user-data/catalog.db');
    expect(chmod).toHaveBeenCalledWith('/tmp/elv-user-data/catalog.db', 0o600);
    expect(chmod).toHaveBeenCalledWith('/tmp/elv-user-data/catalog.db-wal', 0o600);
    expect(chmod).not.toHaveBeenCalledWith('/tmp/elv-user-data/catalog.db-shm', 0o600);
  });

  it('skips chmod on win32 and swallows chmod errors best-effort on POSIX', () => {
    const mkdir = vi.fn();
    const chmod = vi.fn(() => {
      throw new Error('EPERM');
    });
    const fakeDb = {} as Database.Database;
    const openDb = vi.fn(() => fakeDb);

    openHardenedCatalogDatabase('C:\\Users\\demo\\elv\\catalog.db', {
      platform: 'win32',
      mkdir: mkdir as unknown as typeof import('node:fs').mkdirSync,
      chmod: chmod as unknown as typeof import('node:fs').chmodSync,
      exists: () => true,
      openDb,
    });
    expect(chmod).not.toHaveBeenCalled();

    expect(() =>
      openHardenedCatalogDatabase('/tmp/elv-user-data/catalog.db', {
        platform: 'darwin',
        mkdir: mkdir as unknown as typeof import('node:fs').mkdirSync,
        chmod: chmod as unknown as typeof import('node:fs').chmodSync,
        exists: () => true,
        openDb,
      }),
    ).not.toThrow();
    expect(chmod).toHaveBeenCalledTimes(3);
  });

  it('applies 256 MiB PRAGMA mmap_size on desktop database open and swallows errors best-effort', () => {
    expect(CATALOG_DB_MMAP_SIZE_BYTES).toBe(268_435_456);
    const pragma = vi.fn();
    const fakeDb = { pragma } as unknown as Database.Database;
    openHardenedCatalogDatabase('/tmp/elv-user-data/catalog.db', {
      platform: 'win32',
      mkdir: vi.fn() as unknown as typeof import('node:fs').mkdirSync,
      openDb: () => fakeDb,
    });
    expect(pragma).toHaveBeenCalledWith('mmap_size = 268435456');

    const throwingDb = {
      pragma: () => {
        throw new Error('unsupported');
      },
    } as unknown as Database.Database;
    expect(() =>
      openHardenedCatalogDatabase('/tmp/elv-user-data/catalog.db', {
        platform: 'win32',
        mkdir: vi.fn() as unknown as typeof import('node:fs').mkdirSync,
        openDb: () => throwingDb,
      }),
    ).not.toThrow();
  });
});
