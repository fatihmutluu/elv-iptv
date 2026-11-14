import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

const driver = {
  exec: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ changes: 0 })),
  all: vi.fn(async (sql: string) => (sql.includes('user_version') ? [{ user_version: 1 }] : [])),
  batch: vi.fn(async () => undefined),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(driver)),
  setAbortSignal: vi.fn(),
};
const createOpSqliteDriver = vi.fn(async (_name: string, _location?: string) => driver);
const manifest = { read: vi.fn((): string | undefined => undefined), write: vi.fn() };
const createSettingsStore = vi.fn((_key: string) => manifest);

vi.mock('../storage', () => ({
  createOpSqliteDriver,
  databaseLocation: (os: string) => (os === 'ios' ? '/app/Library/Caches' : undefined),
  createSettingsStore,
  createMacrotaskScheduler: () => ({ yieldNow: async () => undefined }),
  createDeviceHttpClient: () => ({ get: vi.fn() }),
  createSecureSecretStore: () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}));

beforeEach(() => {
  vi.resetModules();
  createOpSqliteDriver.mockClear();
  createSettingsStore.mockClear();
  manifest.read.mockClear();
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

  it('opens catalog.db in Caches on Apple platforms and reconciles the source manifest', async () => {
    platform.OS = 'ios';
    const { createDeviceCatalog } = await import('./device');
    await createDeviceCatalog();
    expect(createOpSqliteDriver).toHaveBeenCalledWith('catalog.db', '/app/Library/Caches');
    expect(createSettingsStore).toHaveBeenCalledWith('elv.catalog.sources');
    expect(manifest.read).toHaveBeenCalled();
  });

  it('rejects, and retries later, when the database cannot be opened', async () => {
    platform.OS = 'android';
    driver.all.mockRejectedValueOnce(new Error('disk'));
    const { createDeviceCatalog } = await import('./device');
    await expect(createDeviceCatalog()).rejects.toThrow('catalog open failed');
    await expect(createDeviceCatalog()).resolves.toBeDefined();
  });
});
