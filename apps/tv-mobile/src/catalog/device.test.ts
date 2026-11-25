import { EXPECTED_FTS_TABLES, EXPECTED_TABLE_COLUMNS } from '@elv/data';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

const xmltvNative = vi.hoisted(() => ({
  isNativeXmltvStagerAvailable: vi.fn(() => false),
  stageXmltv: vi.fn(),
  cancelXmltvStage: vi.fn(),
}));
vi.mock('@elv/xmltv-native', () => xmltvNative);

const createCatalogServiceSpy = vi.hoisted(() => ({
  lastDeps: undefined as Record<string, unknown> | undefined,
}));
vi.mock('@elv/data', async () => {
  const actual = await vi.importActual<typeof import('@elv/data')>('@elv/data');
  return {
    ...actual,
    createCatalogService: (deps: Parameters<typeof actual.createCatalogService>[0]) => {
      createCatalogServiceSpy.lastDeps = deps as unknown as Record<string, unknown>;
      return actual.createCatalogService(deps);
    },
  };
});

const FTS_SET = new Set<string>(EXPECTED_FTS_TABLES);

const migrated = async (sql: string, params?: readonly unknown[]): Promise<unknown[]> => {
  if (sql.includes('user_version')) return [{ user_version: 1 }];
  const match = /PRAGMA table_info\(([^)]+)\)/.exec(sql);
  if (match !== null) {
    const table = match[1] as string;
    return (EXPECTED_TABLE_COLUMNS[table] ?? []).map((c) => ({ name: c.name }));
  }
  if (sql.includes('sqlite_master') && typeof params?.[0] === 'string' && FTS_SET.has(params[0])) {
    return [{ name: params[0] }];
  }
  return [];
};
const driver = {
  exec: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ changes: 0 })),
  all: vi.fn(migrated),
  batch: vi.fn(async () => undefined),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(driver)),
  setAbortSignal: vi.fn(),
  getDbPath: vi.fn(() => '/data/data/app/databases/catalog.db'),
  runExclusiveWrite: vi.fn(async <T>(work: () => Promise<T>) => work()),
  close: vi.fn(async () => undefined),
};
const createOpSqliteDriver = vi.fn(async (_name: string, _location?: string) => driver);
const manifest = { read: vi.fn((): string | undefined => undefined), write: vi.fn() };
const userData = {
  maxBytes: 393_216,
  read: vi.fn((): string | undefined => undefined),
  write: vi.fn(),
};
const createSettingsStore = vi.fn((_key: string) => manifest);
const createAppleUserDataStore = vi.fn((_key: string) => userData);
const createSecureSecretStore = vi.fn(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }));

vi.mock('../storage', () => ({
  createOpSqliteDriver,
  databaseLocation: (os: string) => (os === 'ios' ? '/app/Library/Caches' : undefined),
  createSettingsStore,
  createAppleUserDataStore,
  createMacrotaskScheduler: () => ({ yieldNow: async () => undefined }),
  createDeviceHttpClient: () => ({ get: vi.fn() }),
  createSecureSecretStore,
}));

beforeEach(() => {
  vi.resetModules();
  createOpSqliteDriver.mockClear();
  createSettingsStore.mockClear();
  createAppleUserDataStore.mockClear();
  createSecureSecretStore.mockClear();
  manifest.read.mockClear();
  manifest.write.mockClear();
  userData.read.mockClear();
  userData.write.mockClear();
  driver.close.mockClear();
  driver.getDbPath.mockClear();
  driver.runExclusiveWrite.mockClear();
  driver.all.mockImplementation(migrated);
  xmltvNative.isNativeXmltvStagerAvailable.mockReset().mockReturnValue(false);
  xmltvNative.stageXmltv.mockReset();
  xmltvNative.cancelXmltvStage.mockReset();
  createCatalogServiceSpy.lastDeps = undefined;
});

describe('createDeviceCatalog', () => {
  it('opens catalog.db once in the default directory on Android, without a manifest', async () => {
    platform.OS = 'android';
    const { createDeviceCatalog } = await import('./device');
    const first = await createDeviceCatalog();
    const second = await createDeviceCatalog();
    expect(first).toBe(second);
    expect(createOpSqliteDriver).toHaveBeenCalledTimes(1);
    expect(createOpSqliteDriver).toHaveBeenCalledWith('catalog.db', undefined);
    expect(createSettingsStore).not.toHaveBeenCalled();
    expect(typeof first.importSource).toBe('function');
  });

  it('opens catalog.db in Caches on Apple platforms and reconciles both manifest and user data (#79)', async () => {
    platform.OS = 'ios';
    const { createDeviceCatalog } = await import('./device');
    await createDeviceCatalog();
    expect(createOpSqliteDriver).toHaveBeenCalledWith('catalog.db', '/app/Library/Caches');
    expect(createSettingsStore).toHaveBeenCalledWith('elv.catalog.sources');
    expect(createAppleUserDataStore).toHaveBeenCalledWith('elv.catalog.userstate.v1');
    expect(manifest.read).toHaveBeenCalled();
    expect(userData.read).toHaveBeenCalled();
  });

  it('opens the catalog when user-data reconciliation fails, logging only a category (#79)', async () => {
    platform.OS = 'ios';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    driver.all.mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('FROM favorites')) throw new Error('disk I/O at /secret/userstate');
      return migrated(sql, params);
    });
    try {
      const { createDeviceCatalog } = await import('./device');
      const catalog = await createDeviceCatalog();
      expect(catalog).toBeDefined();
      expect(warn).toHaveBeenCalledWith('catalog: storage/user-data-failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('opens the catalog when the manifest cannot be reconciled, logging only a category', async () => {
    platform.OS = 'ios';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    driver.all.mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('settings_json FROM sources')) throw new Error('disk I/O at /secret/path');
      return migrated(sql, params);
    });
    try {
      const { createDeviceCatalog } = await import('./device');
      const catalog = await createDeviceCatalog();
      expect(warn).toHaveBeenCalledWith('catalog: storage/manifest-failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      expect(manifest.write).not.toHaveBeenCalled();
      driver.all.mockImplementation(migrated);
      await catalog.removeSource('gone');
      expect(manifest.write).toHaveBeenCalledWith('{"v":1,"sources":[]}');
    } finally {
      warn.mockRestore();
    }
  });

  it('closes the failed driver, rejects, and retries later when the database cannot be opened', async () => {
    platform.OS = 'android';
    driver.all.mockRejectedValueOnce(new Error('disk'));
    const { createDeviceCatalog } = await import('./device');
    await expect(createDeviceCatalog()).rejects.toThrow('catalog open failed');
    expect(driver.close).toHaveBeenCalledTimes(1);
    await expect(createDeviceCatalog()).resolves.toBeDefined();
  });

  it('closes the partial SQLite handle when setup throws after openCatalog and allows clean retry', async () => {
    platform.OS = 'android';
    createSecureSecretStore.mockImplementationOnce(() => {
      throw new Error('keystore unavailable');
    });
    const { createDeviceCatalog } = await import('./device');
    await expect(createDeviceCatalog()).rejects.toThrow('keystore unavailable');
    expect(driver.close).toHaveBeenCalledTimes(1);

    const recovered = await createDeviceCatalog();
    expect(recovered).toBeDefined();
    expect(createOpSqliteDriver).toHaveBeenCalledTimes(2);
  });

  it('preserves the original open error even if closing the partial handle also rejects', async () => {
    platform.OS = 'ios';
    createSettingsStore.mockImplementationOnce(() => {
      throw new Error('settings init failed');
    });
    driver.close.mockRejectedValueOnce(new Error('close failed'));
    const { createDeviceCatalog } = await import('./device');
    await expect(createDeviceCatalog()).rejects.toThrow('settings init failed');
    expect(driver.close).toHaveBeenCalledTimes(1);

    createSettingsStore.mockImplementationOnce(() => {
      throw new Error('settings sync fail');
    });
    driver.close.mockImplementationOnce(() => {
      throw new Error('sync close boom');
    });
    await expect(createDeviceCatalog()).rejects.toThrow('settings sync fail');
    await expect(createDeviceCatalog()).resolves.toBeDefined();
  });

  it('wires nativeGuideStager through db.runExclusiveWrite and db.getDbPath when @elv/xmltv-native is available (#478)', async () => {
    platform.OS = 'android';
    xmltvNative.isNativeXmltvStagerAvailable.mockReturnValue(true);
    xmltvNative.stageXmltv.mockResolvedValue({
      kind: 'not-modified',
      etag: '"v1"',
    });

    const { createDeviceCatalog } = await import('./device');
    await createDeviceCatalog();

    const stager = createCatalogServiceSpy.lastDeps?.nativeGuideStager as
      | {
          stage(req: Record<string, unknown>): Promise<unknown>;
          cancel?(jobId: string): void;
        }
      | undefined;
    expect(stager).toBeDefined();

    const res = await stager?.stage({
      jobId: 'job-99',
      url: 'https://guide.example/epg.xml',
      sourceId: 'src-1',
      runId: 3,
      fromMs: 100,
      toMs: 200,
      ifNoneMatch: '"v1"',
    });
    expect(driver.runExclusiveWrite).toHaveBeenCalledTimes(1);
    expect(driver.getDbPath).toHaveBeenCalledTimes(1);
    expect(xmltvNative.stageXmltv).toHaveBeenCalledWith({
      jobId: 'job-99',
      url: 'https://guide.example/epg.xml',
      dbPath: '/data/data/app/databases/catalog.db',
      sourceId: 'src-1',
      runId: 3,
      fromMs: 100,
      toMs: 200,
      ifNoneMatch: '"v1"',
    });
    expect(res).toEqual({ kind: 'not-modified', etag: '"v1"' });

    stager?.cancel?.('job-99');
    expect(xmltvNative.cancelXmltvStage).toHaveBeenCalledWith('job-99');
  });
});
