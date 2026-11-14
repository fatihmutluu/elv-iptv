import { elvError, err, ok, type Result } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogService, SeasonRow } from '../../catalog';
import { importLine, runImport } from './run-import';

const params = {
  host: '10.0.2.2:7878',
  account: 'large',
  batch: 1000,
  maxBody: 2048,
  series: false,
  probeReads: false,
} as const;

const summary = {
  runId: 1,
  counts: { categories: 9, live: 10, movies: 5, series: 2 },
  warnings: 0,
  warningCodes: [],
  durationMs: 321.4,
};

function fakeCatalog(importResult: Awaited<ReturnType<CatalogService['importSource']>>) {
  const addSource = vi.fn(async () =>
    ok({ id: 's1', kind: 'xtream', name: 'gate', createdAt: 1, needsImport: true }),
  );
  const importSource = vi.fn(async () => importResult);
  const categories = vi.fn(async (_source: string, kind: string) =>
    kind === 'series'
      ? [
          { id: 'empty', itemCount: 0 },
          { id: 'c1', itemCount: 3 },
        ]
      : [],
  );
  const items = vi.fn(async (categoryId: string) => (categoryId === 'c1' ? [{ id: 77 }] : []));
  const seasons = vi.fn(
    async (): Promise<Result<SeasonRow[]>> =>
      ok([
        { season: 1, episodeCount: 4 },
        { season: 2, episodeCount: 6 },
      ]),
  );
  return {
    catalog: { addSource, importSource, categories, items, seasons } as unknown as CatalogService,
    addSource,
    importSource,
    categories,
    items,
    seasons,
  };
}

const noProbe = () => ({ stop: async () => ({ maxReadMs: 0, reads: 0, readErrors: 0 }) });

describe('runImport', () => {
  it('adds the simulator account, imports with the batch size and sums the rows', async () => {
    const { catalog, addSource, importSource, seasons } = fakeCatalog(ok(summary));
    const stop = vi.fn(() => 42);
    const result = await runImport(catalog, params, () => ({ stop }));
    expect(addSource).toHaveBeenCalledWith({
      kind: 'xtream',
      name: 'gate-large',
      server: 'http://10.0.2.2:7878',
      username: 'large',
      password: 'large',
    });
    expect(importSource).toHaveBeenCalledWith('s1', { batchSize: 1000, maxBodyBytes: 2048 * 1024 });
    expect(result).toEqual({
      account: 'large',
      batch: 1000,
      maxBody: 2048,
      rows: 17,
      durationMs: 321.4,
      maxStallMs: 42,
    });
    expect(seasons).not.toHaveBeenCalled();
  });

  it('opens the first series after the import with series=1 and counts its seasons and episodes', async () => {
    const { catalog, items, seasons } = fakeCatalog(ok(summary));
    const stop = vi.fn(() => 1);
    const result = await runImport(catalog, { ...params, series: true }, () => ({ stop }));
    expect(items).toHaveBeenCalledWith('c1', 0, 1);
    expect(seasons).toHaveBeenCalledWith(77);
    expect(result).toMatchObject({ rows: 17, seasons: 2, episodes: 10 });
    expect(result).toHaveProperty('seriesMs');
  });

  it('reports why the series step failed', async () => {
    const { catalog, seasons } = fakeCatalog(ok(summary));
    seasons.mockResolvedValueOnce(err(elvError('source-format', 'too-large')));
    const failed = await runImport(catalog, { ...params, series: true }, () => ({ stop: () => 1 }));
    expect(failed).toMatchObject({ rows: 17, seriesError: 'source-format/too-large' });
    const empty = fakeCatalog(ok(summary));
    empty.categories.mockResolvedValue([]);
    const none = await runImport(empty.catalog, { ...params, series: true }, () => ({
      stop: () => 1,
    }));
    expect(none).toMatchObject({ seriesError: 'storage/item-not-found' });
  });

  it('probes reader latency on the live categories during the import with probeReads=1', async () => {
    const { catalog, categories } = fakeCatalog(ok(summary));
    let read: (() => Promise<unknown>) | undefined;
    const probe = vi.fn((r: () => Promise<unknown>) => {
      read = r;
      return { stop: async () => ({ maxReadMs: 12.3, reads: 40, readErrors: 0 }) };
    });
    const result = await runImport(
      catalog,
      { ...params, probeReads: true },
      () => ({ stop: () => 1 }),
      probe,
    );
    expect(probe).toHaveBeenCalledOnce();
    await read?.();
    expect(categories).toHaveBeenCalledWith('s1', 'live');
    expect(result).toMatchObject({ rows: 17, maxReadMs: 12.3, reads: 40, readErrors: 0 });
    const plain = await runImport(catalog, params, () => ({ stop: () => 1 }), probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(plain).not.toHaveProperty('maxReadMs');
  });

  it('reports the typed error and still stops the meter', async () => {
    const { catalog } = fakeCatalog(err(elvError('network', 'timeout')));
    const stop = vi.fn(() => 5);
    const result = await runImport(
      catalog,
      { ...params, series: true, probeReads: true },
      () => ({
        stop,
      }),
      noProbe,
    );
    expect(result).toMatchObject({
      account: 'large',
      batch: 1000,
      maxBody: 2048,
      error: 'network/timeout',
      maxReadMs: 0,
    });
    expect(result).not.toHaveProperty('seasons');
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('importLine', () => {
  it('prefixes the JSON with ELV_GATE_IMPORT', () => {
    const line = importLine({
      account: 'large',
      batch: 500,
      maxBody: 4096,
      rows: 1,
      durationMs: 2,
      maxStallMs: 3,
    });
    expect(line).toBe(
      'ELV_GATE_IMPORT {"account":"large","batch":500,"maxBody":4096,"rows":1,"durationMs":2,"maxStallMs":3}',
    );
  });
});
