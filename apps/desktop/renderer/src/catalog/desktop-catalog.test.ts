import type { ImportProgress, ImportSummary, SourceRow } from '@elv/data';
import { elvError, err, ok, type Result } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogBridge, CatalogBridgeImportOptions } from '../../../src/shared/catalog-ipc.ts';
import { CatalogOpenError, createDesktopCatalog, createDesktopCatalogFromBridge } from './index.ts';

function makeFakeBridge(overrides?: Partial<CatalogBridge>): {
  bridge: CatalogBridge;
  cancelledIds: number[];
} {
  const cancelledIds: number[] = [];
  let nextReq = 0;

  const base: CatalogBridge = {
    open: async () => ok(undefined),
    addSource: async () =>
      ok({
        id: 's1',
        kind: 'm3u',
        name: 'Demo',
        createdAt: 1,
        needsImport: true,
      } satisfies SourceRow),
    addSourceFromLink: async () =>
      ok({
        id: 's2',
        kind: 'xtream',
        name: 'Link',
        createdAt: 2,
        needsImport: true,
      } satisfies SourceRow),
    removeSource: async () => ok(undefined),
    startImport: (_id: string, opts?: CatalogBridgeImportOptions) => {
      const reqId = ++nextReq;
      opts?.onProgress?.({ phase: 'live', done: 5, total: 10 });
      const summary: ImportSummary = {
        runId: 1,
        counts: {
          categories: 1,
          live: 10,
          movies: 0,
          series: 0,
          episodes: 0,
          guideChannels: 0,
          programmes: 0,
        },
        warnings: 0,
        warningCodes: [],
        durationMs: 12,
      };
      return { reqId, result: Promise.resolve(ok(summary)) };
    },
    cancelImport: (reqId: number) => {
      cancelledIds.push(reqId);
    },
    listSources: async () => [],
    categories: async () => [],
    items: async () => [],
    seasons: async () => ok([]),
    episodes: async () => [],
    resolveStream: async () =>
      ok({ url: 'http://127.0.0.1:7879/live/demo/demo/1.ts', headers: {} }),
    close: async () => undefined,
  };

  return { bridge: { ...base, ...overrides }, cancelledIds };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop CatalogService', () => {
  it('opens singleton over window.elv.catalog, retries after a failed open, and delegates every CatalogService method', async () => {
    let shouldFailOpen = true;
    const { bridge } = makeFakeBridge({
      open: async () =>
        shouldFailOpen ? err(elvError('storage', 'schema-too-new')) : ok(undefined),
    });
    vi.stubGlobal('window', { elv: { catalog: bridge } });

    await expect(createDesktopCatalog()).rejects.toBeInstanceOf(CatalogOpenError);
    await expect(createDesktopCatalog()).rejects.toMatchObject({
      error: { category: 'storage', code: 'schema-too-new' },
    });

    // Retry succeeds after failure (failed open was not cached)
    shouldFailOpen = false;
    const c1 = await createDesktopCatalog();
    const c2 = await createDesktopCatalog();
    expect(c1).toBe(c2);

    expect(
      (await c1.addSource({ kind: 'm3u', name: 'A', playlistUrl: 'http://a.example/list.m3u' })).ok,
    ).toBe(true);
    expect((await c1.addSourceFromLink({ name: 'B', url: 'http://b.example/list.m3u' })).ok).toBe(
      true,
    );
    expect((await c1.removeSource('s1')).ok).toBe(true);
    expect(await c1.listSources()).toEqual([]);
    expect(await c1.categories('s1', 'live')).toEqual([]);
    expect(await c1.items('cat1', 0, 25)).toEqual([]);
    expect((await c1.seasons(1)).ok).toBe(true);
    expect(await c1.episodes(1, 1)).toEqual([]);
    expect((await c1.resolveStream('x:s1:live:1')).ok).toBe(true);

    await c1.close();
  });

  it('rejects with CatalogOpenError when window.elv.catalog is absent', async () => {
    vi.stubGlobal('window', {});
    await expect(createDesktopCatalog()).rejects.toMatchObject({
      error: { category: 'storage', code: 'bridge-unavailable' },
    });
  });

  it('maps pre-aborted and mid-flight AbortSignal onto cancelImport and isolates throwing onProgress', async () => {
    let finishImport!: (res: Result<ImportSummary>) => void;
    const { bridge, cancelledIds } = makeFakeBridge({
      startImport: (_id, opts) => {
        opts?.onProgress?.({ phase: 'live', done: 1 });
        return {
          reqId: 77,
          result: new Promise((resolve) => {
            finishImport = resolve;
          }),
        };
      },
    });
    const service = createDesktopCatalogFromBridge(bridge);

    // Pre-aborted signal returns network/aborted without calling startImport
    const preAborted = new AbortController();
    preAborted.abort();
    const preRes = await service.importSource('s1', { signal: preAborted.signal });
    expect(preRes).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(cancelledIds).toEqual([]);

    // Mid-flight abort forwards cancelImport(77), and throwing onProgress does not break importSource
    const ctl = new AbortController();
    const seen: ImportProgress[] = [];
    const running = service.importSource('s1', {
      signal: ctl.signal,
      batchSize: 500,
      maxBodyBytes: 1_000_000,
      onProgress: (p) => {
        seen.push(p);
        throw new Error('ui boom');
      },
    });
    expect(seen).toEqual([{ phase: 'live', done: 1 }]);

    ctl.abort();
    expect(cancelledIds).toEqual([77]);
    finishImport(err(elvError('network', 'aborted')));
    expect(await running).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
  });
});
