import { EXPECTED_FTS_TABLES, EXPECTED_TABLE_COLUMNS } from '@elv/data';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

const expoConstants = vi.hoisted(() => ({
  expoConfig: { extra: {} as Record<string, unknown> },
}));
vi.mock('expo-constants', () => ({ default: expoConstants }));

const xmltvNative = vi.hoisted(() => ({
  isNativeXmltvStagerAvailable: vi.fn(() => false),
  stageXmltv: vi.fn(),
  cancelXmltvStage: vi.fn(),
  cleanupStageFile: vi.fn(),
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

function makeFakeDriver(dbName: string) {
  const migrated = async (sql: string, params?: readonly unknown[]): Promise<unknown[]> => {
    if (sql.includes('user_version')) return [{ user_version: 1 }];
    const match = /PRAGMA table_info\(([^)]+)\)/.exec(sql);
    if (match !== null) {
      const table = match[1] as string;
      return (EXPECTED_TABLE_COLUMNS[table] ?? []).map((c) => ({ name: c.name }));
    }
    if (
      sql.includes('sqlite_master') &&
      typeof params?.[0] === 'string' &&
      FTS_SET.has(params[0])
    ) {
      return [{ name: params[0] }];
    }
    return [];
  };
  const d = {
    name: dbName,
    exec: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ changes: 0 })),
    all: vi.fn(migrated),
    batch: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(d)),
    setAbortSignal: vi.fn(),
    getDbPath: vi.fn(() => `/data/data/app/databases/${dbName}`),
    attachAndCopyProgrammes: vi.fn(async () => undefined),
    attachReadOnly: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return d;
}

const openedDrivers = new Map<string, ReturnType<typeof makeFakeDriver>>();
const createOpSqliteDriver = vi.fn(async (name: string, _location?: string) => {
  const d = makeFakeDriver(name);
  openedDrivers.set(name, d);
  return d;
});

vi.mock('../storage', () => ({
  createOpSqliteDriver,
  databaseLocation: (os: string) => (os === 'ios' ? '/app/Library/Caches' : undefined),
  createSettingsStore: vi.fn(() => ({ read: vi.fn(() => undefined), write: vi.fn() })),
  createAppleUserDataStore: vi.fn(() => ({
    maxBytes: 393_216,
    read: vi.fn(() => undefined),
    write: vi.fn(),
  })),
  createMacrotaskScheduler: () => ({ yieldNow: async () => undefined }),
  createDeviceHttpClient: () => ({ get: vi.fn() }),
  createSecureSecretStore: () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}));

beforeEach(() => {
  vi.resetModules();
  openedDrivers.clear();
  createOpSqliteDriver.mockClear();
  createCatalogServiceSpy.lastDeps = undefined;
  expoConstants.expoConfig = { extra: {} };
});

describe('createDeviceCatalog Wave E1 isolated elv-enrichment.db wiring (#511)', () => {
  it('opens isolated elv-enrichment.db beside catalog.db, wires elvClient from syncServerUrl, forwards ELV methods through telemetry wrapper, and closes both DBs', async () => {
    platform.OS = 'android';
    expoConstants.expoConfig = {
      extra: { syncServerUrl: 'https://elv-meta.example.test' },
    };

    const { createDeviceCatalog } = await import('./device');
    const recordCatalogImport = vi.fn();
    const catalog = await createDeviceCatalog({ recordCatalogImport });

    expect(createOpSqliteDriver).toHaveBeenCalledWith('catalog.db', undefined);
    expect(createOpSqliteDriver).toHaveBeenCalledWith('elv-enrichment.db', undefined);
    expect(createCatalogServiceSpy.lastDeps?.enrichmentStore).toBeDefined();
    expect(createCatalogServiceSpy.lastDeps?.elvClient).toBeDefined();

    // Every Wave E1 ELV method is present & forwarded through wrapCatalogWithImportTelemetry
    expect(typeof catalog.getElvEnrichmentForKeys).toBe('function');
    expect(typeof catalog.getElvTitleDetail).toBe('function');
    expect(typeof catalog.listMergedVodVersions).toBe('function');
    expect(typeof catalog.enrichElvPriorityKeys).toBe('function');
    expect(typeof catalog.runElvBackgroundMatching).toBe('function');
    expect(typeof catalog.recordPlaybackQuality).toBe('function');
    expect(typeof catalog.recordPlaybackVariantFailure).toBe('function');
    expect(typeof catalog.setElvManualMatch).toBe('function');
    expect(typeof catalog.wipeElvEnrichment).toBe('function');
    expect(typeof catalog.searchElvItemKeysByAlias).toBe('function');
    expect(typeof catalog.listLiveVariants).toBe('function');
    expect(typeof catalog.findGuideChannelByCleanName).toBe('function');
    // Every Wave E2 ELV discovery/recommendation method is forwarded through wrapCatalogWithImportTelemetry
    expect(typeof catalog.listElvImdbGenres).toBe('function');
    expect(typeof catalog.listElvItemsByImdbGenre).toBe('function');
    expect(typeof catalog.getElvRecommendations).toBe('function');
    expect(typeof catalog.refreshElvFeeds).toBe('function');
    expect(typeof catalog.listElvFranchiseItems).toBe('function');
    expect(typeof catalog.listElvPersonLibraryItems).toBe('function');
    expect(typeof catalog.searchElvMatchCandidates).toBe('function');
    expect(typeof catalog.applyElvFixMatch).toBe('function');

    const map = await catalog.getElvEnrichmentForKeys?.(['x:s1:movie:1']);
    expect(map).toBeInstanceOf(Map);
    expect(map?.size).toBe(0);
    expect(await catalog.searchElvItemKeysByAlias?.('Inception')).toEqual([]);
    expect(await catalog.listElvImdbGenres?.('movie')).toEqual([]);
    expect(await catalog.getElvRecommendations?.({ profile: 'home' })).toEqual([]);

    await catalog.close();
    expect(openedDrivers.get('catalog.db')?.close).toHaveBeenCalledTimes(1);
    expect(openedDrivers.get('elv-enrichment.db')?.close).toHaveBeenCalledTimes(1);
  });

  it('accepts explicit syncServerUrl option and omits elvClient when unconfigured', async () => {
    platform.OS = 'ios';
    const { createDeviceCatalog } = await import('./device');
    const catalog = await createDeviceCatalog();

    expect(createOpSqliteDriver).toHaveBeenCalledWith('catalog.db', '/app/Library/Caches');
    expect(createOpSqliteDriver).toHaveBeenCalledWith('elv-enrichment.db', '/app/Library/Caches');
    expect(createCatalogServiceSpy.lastDeps?.enrichmentStore).toBeDefined();
    expect(createCatalogServiceSpy.lastDeps?.elvClient).toBeUndefined();

    await catalog.close();
    expect(openedDrivers.get('catalog.db')?.close).toHaveBeenCalledTimes(1);
    expect(openedDrivers.get('elv-enrichment.db')?.close).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully to enrichmentStore: undefined if elv-enrichment.db migration fails, without breaking catalog.db', async () => {
    platform.OS = 'android';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createOpSqliteDriver.mockImplementationOnce(async (name: string) => {
      const d = makeFakeDriver(name);
      openedDrivers.set(name, d);
      return d;
    });
    createOpSqliteDriver.mockImplementationOnce(async (name: string) => {
      const d = makeFakeDriver(name);
      d.exec.mockRejectedValueOnce(new Error('SQLITE_CORRUPT: enrichment schema failed'));
      openedDrivers.set(name, d);
      return d;
    });

    try {
      const { createDeviceCatalog } = await import('./device');
      const catalog = await createDeviceCatalog();
      expect(createCatalogServiceSpy.lastDeps?.enrichmentStore).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith('catalog: storage/elv-enrichment-failed');
      expect(openedDrivers.get('elv-enrichment.db')?.close).toHaveBeenCalledTimes(1);
      expect(openedDrivers.get('catalog.db')?.close).not.toHaveBeenCalled();

      expect(await catalog.getElvEnrichmentForKeys?.(['x:s1:movie:1'])).toEqual(new Map());
      expect(await catalog.searchElvItemKeysByAlias?.('Inception')).toEqual([]);

      await catalog.close();
      expect(openedDrivers.get('catalog.db')?.close).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back gracefully if opening elv-enrichment.db throws (e.g. locked or corrupt file)', async () => {
    platform.OS = 'android';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createOpSqliteDriver.mockImplementationOnce(async (name: string) => {
      const d = makeFakeDriver(name);
      openedDrivers.set(name, d);
      return d;
    });
    createOpSqliteDriver.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    try {
      const { createDeviceCatalog } = await import('./device');
      const catalog = await createDeviceCatalog();
      expect(createCatalogServiceSpy.lastDeps?.enrichmentStore).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith('catalog: storage/elv-enrichment-failed');
      expect(openedDrivers.get('catalog.db')?.close).not.toHaveBeenCalled();

      await catalog.close();
      expect(openedDrivers.get('catalog.db')?.close).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
