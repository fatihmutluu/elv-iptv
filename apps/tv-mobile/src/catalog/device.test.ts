import { describe, expect, it, vi } from 'vitest';

const driver = {
  exec: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ changes: 0 })),
  all: vi.fn(async (sql: string) => (sql.includes('user_version') ? [{ user_version: 1 }] : [])),
  batch: vi.fn(async () => undefined),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(driver)),
  setAbortSignal: vi.fn(),
};
const createOpSqliteDriver = vi.fn(async (_name: string) => driver);

vi.mock('../storage', () => ({
  createOpSqliteDriver,
  createMacrotaskScheduler: () => ({ yieldNow: async () => undefined }),
  createDeviceHttpClient: () => ({ get: vi.fn() }),
  createSecureSecretStore: () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}));

describe('createDeviceCatalog', () => {
  it('opens catalog.db once and returns the same service', async () => {
    const { createDeviceCatalog } = await import('./device');
    const first = await createDeviceCatalog();
    const second = await createDeviceCatalog();
    expect(first).toBe(second);
    expect(createOpSqliteDriver).toHaveBeenCalledTimes(1);
    expect(createOpSqliteDriver).toHaveBeenCalledWith('catalog.db');
    expect(typeof first.importSource).toBe('function');
  });

  it('rejects, and retries later, when the database cannot be opened', async () => {
    vi.resetModules();
    driver.all.mockRejectedValueOnce(new Error('disk'));
    const { createDeviceCatalog } = await import('./device');
    await expect(createDeviceCatalog()).rejects.toThrow('catalog open failed');
    await expect(createDeviceCatalog()).resolves.toBeDefined();
  });
});
