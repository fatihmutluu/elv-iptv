import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogService } from '../../catalog';
import { importLine, runImport } from './run-import';

const params = { host: '10.0.2.2:7878', account: 'large', batch: 1000 } as const;

function fakeCatalog(importResult: Awaited<ReturnType<CatalogService['importSource']>>) {
  const addSource = vi.fn(async () => ok({ id: 's1', kind: 'xtream', name: 'gate', createdAt: 1 }));
  const importSource = vi.fn(async () => importResult);
  return {
    catalog: { addSource, importSource } as unknown as CatalogService,
    addSource,
    importSource,
  };
}

describe('runImport', () => {
  it('adds the simulator account, imports with the batch size and sums the rows', async () => {
    const summary = {
      runId: 1,
      counts: { categories: 9, live: 10, movies: 5, series: 2 },
      warnings: 0,
      warningCodes: [],
      durationMs: 321.4,
    };
    const { catalog, addSource, importSource } = fakeCatalog(ok(summary));
    const stop = vi.fn(() => 42);
    const result = await runImport(catalog, params, () => ({ stop }));
    expect(addSource).toHaveBeenCalledWith({
      kind: 'xtream',
      name: 'gate-large',
      server: 'http://10.0.2.2:7878',
      username: 'large',
      password: 'large',
    });
    expect(importSource).toHaveBeenCalledWith('s1', { batchSize: 1000 });
    expect(result).toEqual({
      account: 'large',
      batch: 1000,
      rows: 17,
      durationMs: 321.4,
      maxStallMs: 42,
    });
  });

  it('reports the typed error and still stops the meter', async () => {
    const { catalog } = fakeCatalog(err(elvError('network', 'timeout')));
    const stop = vi.fn(() => 5);
    const result = await runImport(catalog, params, () => ({ stop }));
    expect(result).toMatchObject({ account: 'large', batch: 1000, error: 'network/timeout' });
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('importLine', () => {
  it('prefixes the JSON with ELV_GATE_IMPORT', () => {
    const line = importLine({
      account: 'large',
      batch: 500,
      rows: 1,
      durationMs: 2,
      maxStallMs: 3,
    });
    expect(line).toBe(
      'ELV_GATE_IMPORT {"account":"large","batch":500,"rows":1,"durationMs":2,"maxStallMs":3}',
    );
  });
});
