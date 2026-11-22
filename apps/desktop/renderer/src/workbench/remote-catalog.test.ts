import type { ImportProgress, ImportSummary, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkbenchRemoteCatalog,
  probeWorkbenchBridge,
  readWorkbenchBridgeConfig,
  type WorkbenchBridgeConfig,
} from './remote-catalog.ts';

const CONFIG: WorkbenchBridgeConfig = {
  baseUrl: 'http://127.0.0.1:8082',
  token: 'test-workbench-token',
};

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function createFetchMock(impl?: FetchHandler) {
  const spy = vi.fn<FetchHandler>(impl);
  return { spy, fetchImpl: spy as unknown as typeof fetch };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeChunkedNdjsonResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('readWorkbenchBridgeConfig', () => {
  it('accepts valid loopback 127.0.0.1 and localhost URLs and trims trailing slashes', () => {
    expect(
      readWorkbenchBridgeConfig({
        EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL: 'http://127.0.0.1:8082',
        EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN: 'abc123',
      }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:8082', token: 'abc123' });

    expect(
      readWorkbenchBridgeConfig({
        EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL: '  HTTP://LOCALHOST:9090///  ',
        EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN: '  tok-99  ',
      }),
    ).toEqual({ baseUrl: 'http://localhost:9090', token: 'tok-99' });
  });

  it('rejects non-loopback hosts, invalid protocols, missing/bad ports, paths, and blank tokens', () => {
    const validToken = 'valid-token-1234';
    const invalidUrls = [
      undefined,
      '',
      '   ',
      'http://evil.example:8082',
      'http://192.168.1.20:8082',
      'http://127.0.0.1.evil.example:8082',
      'http://127.0.0.1@evil.example:8082',
      'http://user:pass@127.0.0.1:8082',
      'https://127.0.0.1:8082',
      'ws://localhost:8082',
      'http://127.0.0.1',
      'http://localhost',
      'http://127.0.0.1:0',
      'http://127.0.0.1:70000',
      'http://127.0.0.1:8082/extra',
      'http://127.0.0.1:8082?foo=bar',
      'not-a-url',
    ];
    for (const url of invalidUrls) {
      expect(
        readWorkbenchBridgeConfig({
          EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL: url,
          EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN: validToken,
        }),
      ).toBeNull();
    }

    const invalidTokens = [undefined, '', '   ', 'bad\ntoken', 'bad\rtoken'];
    for (const token of invalidTokens) {
      expect(
        readWorkbenchBridgeConfig({
          EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL: 'http://127.0.0.1:8082',
          EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN: token,
        }),
      ).toBeNull();
    }
  });

  it('reads from process.env when env argument is omitted', () => {
    vi.stubEnv('EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL', 'http://127.0.0.1:8123/');
    vi.stubEnv('EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN', 'env-token');
    expect(readWorkbenchBridgeConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:8123',
      token: 'env-token',
    });

    vi.stubEnv('EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL', '');
    expect(readWorkbenchBridgeConfig()).toBeNull();
  });
});

describe('probeWorkbenchBridge', () => {
  it('returns true when GET /health responds 200 with ok: true and sends auth header', async () => {
    const { spy, fetchImpl } = createFetchMock(async () =>
      makeJsonResponse({ ok: true, version: 1 }),
    );
    await expect(probeWorkbenchBridge(CONFIG, fetchImpl)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8082/health');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ 'X-Elv-Workbench-Token': CONFIG.token });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns false on non-200 status, ok: false, invalid JSON, network error, or timeout', async () => {
    await expect(
      probeWorkbenchBridge(
        CONFIG,
        createFetchMock(async () => makeJsonResponse({ ok: false }, 401)).fetchImpl,
      ),
    ).resolves.toBe(false);
    await expect(
      probeWorkbenchBridge(
        CONFIG,
        createFetchMock(async () => makeJsonResponse({ ok: false }, 500)).fetchImpl,
      ),
    ).resolves.toBe(false);
    await expect(
      probeWorkbenchBridge(
        CONFIG,
        createFetchMock(async () => makeJsonResponse({ ok: false }, 200)).fetchImpl,
      ),
    ).resolves.toBe(false);
    await expect(
      probeWorkbenchBridge(
        CONFIG,
        createFetchMock(async () => new Response('not json', { status: 200 })).fetchImpl,
      ),
    ).resolves.toBe(false);
    await expect(
      probeWorkbenchBridge(
        CONFIG,
        createFetchMock(async () => {
          throw new Error('ECONNREFUSED');
        }).fetchImpl,
      ),
    ).resolves.toBe(false);

    vi.useFakeTimers();
    const { fetchImpl: hangingFetch } = createFetchMock(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const pending = probeWorkbenchBridge(CONFIG, hangingFetch, 50);
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBe(false);
  });
});

describe('createWorkbenchRemoteCatalog', () => {
  it('forwards every CatalogService RPC method with exact payload and token header', async () => {
    const calls: Array<{
      url: string;
      token: string | undefined;
      method: string;
      args: unknown[];
    }> = [];
    const sourceRow: SourceRow = {
      id: 'src-1',
      kind: 'm3u',
      name: 'Live List',
      createdAt: 1000,
      needsImport: true,
    };
    const responses: Record<string, unknown> = {
      addSource: ok(sourceRow),
      addSourceFromLink: ok(sourceRow),
      removeSource: { ok: true },
      importGuide: ok({
        runId: 2,
        counts: { guideChannels: 4, programmes: 20 },
        warnings: 0,
        warningCodes: [],
        durationMs: 15,
      }),
      listSources: [sourceRow],
      categories: [{ id: 'src-1|live|1', sourceId: 'src-1', kind: 'live', name: 'News', count: 5 }],
      items: [],
      itemDetail: null,
      search: { live: [], movies: [], series: [] },
      nowNext: [],
      epgWindow: {},
      channelByNumber: null,
      seasons: ok([{ season: 1, episodeCount: 6 }]),
      episodes: [],
      resolveStream: ok({ url: 'http://127.0.0.1:7879/live/1.ts', headers: {} }),
      saveProgress: ok({
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'm:src-1:1',
        kind: 'movie',
        title: 'Film',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 12_000,
        durationMs: 90_000,
        watched: false,
        updatedAt: 2000,
      }),
      setWatched: { ok: true },
      getProgress: null,
      listContinueWatching: [],
      listProgressByKeys: [],
      clearProgress: { ok: true },
      toggleFavorite: ok(true),
      listFavorites: [],
      listFavoriteKeys: ['m:src-1:1'],
    };

    const { fetchImpl } = createFetchMock(async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const parsed = JSON.parse(String(init?.body ?? '{}')) as {
        method: string;
        args: unknown[];
      };
      calls.push({
        url: String(input),
        token: headers['X-Elv-Workbench-Token'],
        method: parsed.method,
        args: parsed.args,
      });
      return makeJsonResponse({ value: responses[parsed.method] });
    });

    const catalog = createWorkbenchRemoteCatalog(CONFIG, fetchImpl);

    expect(
      await catalog.addSource({
        kind: 'm3u',
        name: 'Live List',
        playlistUrl: 'http://example.invalid/list.m3u',
      }),
    ).toEqual(ok(sourceRow));
    expect(
      await catalog.addSourceFromLink({ name: 'Link', url: 'http://example.invalid/list.m3u' }),
    ).toEqual(ok(sourceRow));
    expect((await catalog.removeSource('src-1')).ok).toBe(true);
    expect((await catalog.importGuide?.('src-1', { batchSize: 250 }))?.ok).toBe(true);
    expect(await catalog.listSources()).toEqual([sourceRow]);
    expect(await catalog.categories('src-1', 'live')).toHaveLength(1);
    expect(await catalog.items('src-1|live|1', 0, 20)).toEqual([]);
    expect(await catalog.itemDetail?.('m:src-1:1')).toBeNull();
    expect(await catalog.search?.('news', { scope: 'live', limit: 10 })).toEqual({
      live: [],
      movies: [],
      series: [],
    });
    expect(await catalog.nowNext?.(['m:src-1:1'], 1_700_000_000_000)).toEqual([]);
    expect(await catalog.epgWindow?.(['m:src-1:1'], 1000, 2000)).toEqual({});
    expect(await catalog.channelByNumber?.(101, 'src-1')).toBeNull();
    expect(await catalog.seasons(42)).toEqual(ok([{ season: 1, episodeCount: 6 }]));
    expect(await catalog.episodes(42, 1)).toEqual([]);
    expect((await catalog.resolveStream('m:src-1:1')).ok).toBe(true);
    expect(
      (
        await catalog.saveProgress?.({
          sourceId: 'src-1',
          itemKey: 'm:src-1:1',
          kind: 'movie',
          title: 'Film',
          positionMs: 12_000,
          durationMs: 90_000,
        })
      )?.ok,
    ).toBe(true);
    expect((await catalog.setWatched?.('m:src-1:1', true, 'p1'))?.ok).toBe(true);
    expect(await catalog.getProgress?.('m:src-1:1', 'p1')).toBeNull();
    expect(await catalog.listContinueWatching?.(10, 'p1')).toEqual([]);
    expect(await catalog.listProgressByKeys?.(['m:src-1:1'], 'p1')).toEqual([]);
    expect((await catalog.clearProgress?.('m:src-1:1', 'p1'))?.ok).toBe(true);
    expect(
      await catalog.toggleFavorite?.({
        sourceId: 'src-1',
        itemKey: 'm:src-1:1',
        kind: 'movie',
        title: 'Film',
      }),
    ).toEqual(ok(true));
    expect(await catalog.listFavorites?.(20)).toEqual([]);
    expect(await catalog.listFavoriteKeys?.()).toEqual(['m:src-1:1']);

    await catalog.close();

    expect(calls).toHaveLength(24);
    expect(calls.every((c) => c.url === 'http://127.0.0.1:8082/rpc')).toBe(true);
    expect(calls.every((c) => c.token === CONFIG.token)).toBe(true);
    expect(calls.find((c) => c.method === 'importGuide')?.args).toEqual([
      'src-1',
      { batchSize: 250 },
    ]);
    expect(calls.find((c) => c.method === 'listFavoriteKeys')?.args).toEqual([]);
    expect(calls.find((c) => c.method === 'listFavorites')?.args).toEqual([20]);
  });

  it('streams split-chunk NDJSON progress in importSource and isolates throwing onProgress', async () => {
    const summary: ImportSummary = {
      runId: 7,
      counts: { categories: 3, live: 12, movies: 4, series: 1, episodes: 2 },
      warnings: 0,
      warningCodes: [],
      durationMs: 42,
    };
    const ndjson = [
      '{"type":"progress","progress":{"phase":"catego',
      'ries","done":3,"total":3}}\n{"type":"progress","prog',
      'ress":{"phase":"live","done":12,"total":12}}\n',
      `${JSON.stringify({ type: 'result', result: ok(summary) })}\n`,
    ];

    const { spy: fetchMock, fetchImpl } = createFetchMock(async () =>
      makeChunkedNdjsonResponse(ndjson),
    );
    const catalog = createWorkbenchRemoteCatalog(CONFIG, fetchImpl);

    const seen: ImportProgress[] = [];
    const res = await catalog.importSource('src-1', {
      batchSize: 500,
      maxBodyBytes: 1_000_000,
      onProgress: (p) => {
        seen.push(p);
        if (p.phase === 'categories') throw new Error('ui callback failure');
      },
    });

    expect(res).toEqual(ok(summary));
    expect(seen).toEqual([
      { phase: 'categories', done: 3, total: 3 },
      { phase: 'live', done: 12, total: 12 },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8082/rpc/import');
    expect(JSON.parse(String(init?.body))).toEqual({
      id: 'src-1',
      batchSize: 500,
      maxBodyBytes: 1_000_000,
    });
  });

  it('supports res.text() fallback when res.body is null on importSource', async () => {
    const summary: ImportSummary = {
      runId: 9,
      counts: { live: 5 },
      warnings: 0,
      warningCodes: [],
      durationMs: 11,
    };
    const rawText = [
      JSON.stringify({ type: 'progress', progress: { phase: 'live', done: 5, total: 5 } }),
      JSON.stringify({ type: 'result', result: ok(summary) }),
    ].join('\n');

    const fakeResponse = {
      ok: true,
      status: 200,
      body: null,
      text: async () => rawText,
    } as unknown as Response;

    const catalog = createWorkbenchRemoteCatalog(
      CONFIG,
      createFetchMock(async () => fakeResponse).fetchImpl,
    );
    const seen: ImportProgress[] = [];
    const res = await catalog.importSource('src-2', { onProgress: (p) => seen.push(p) });

    expect(seen).toEqual([{ phase: 'live', done: 5, total: 5 }]);
    expect(res).toEqual(ok(summary));
  });

  it('returns network/aborted for pre-aborted and mid-stream AbortSignal on importSource and importGuide', async () => {
    const { spy: fetchMock, fetchImpl } = createFetchMock();
    const catalog = createWorkbenchRemoteCatalog(CONFIG, fetchImpl);

    const preAborted = new AbortController();
    preAborted.abort();
    expect(await catalog.importSource('src-1', { signal: preAborted.signal })).toEqual(
      err(elvError('network', 'aborted')),
    );
    expect(await catalog.importGuide?.('src-1', { signal: preAborted.signal })).toEqual(
      err(elvError('network', 'aborted')),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Mid-stream abort during reader.read()
    const streamCtl = new AbortController();
    const encoder = new TextEncoder();
    let reads = 0;
    const streamResponse = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            if (reads === 1) {
              return {
                done: false,
                value: encoder.encode('{"type":"progress","progress":{"phase":"live","done":1}}\n'),
              };
            }
            streamCtl.abort();
            throw Object.assign(new Error('stream aborted'), { name: 'AbortError' });
          },
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;

    const abortingCatalog = createWorkbenchRemoteCatalog(
      CONFIG,
      createFetchMock(async () => streamResponse).fetchImpl,
    );
    expect(await abortingCatalog.importSource('src-1', { signal: streamCtl.signal })).toEqual(
      err(elvError('network', 'aborted')),
    );

    // Mid-flight abort during importGuide fetch
    const guideCtl = new AbortController();
    const { fetchImpl: guideFetch } = createFetchMock((_input, init) => {
      expect(init?.signal).toBe(guideCtl.signal);
      guideCtl.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    const guideCatalog = createWorkbenchRemoteCatalog(CONFIG, guideFetch);
    expect(await guideCatalog.importGuide?.('src-1', { signal: guideCtl.signal })).toEqual(
      err(elvError('network', 'aborted')),
    );
  });

  it('converts network errors, HTTP errors, and malformed payloads into typed network/unreachable errors on Result RPCs', async () => {
    const downCatalog = createWorkbenchRemoteCatalog(
      CONFIG,
      createFetchMock(async () => {
        throw new Error('fetch failed');
      }).fetchImpl,
    );
    expect(
      await downCatalog.addSource({
        kind: 'm3u',
        name: 'X',
        playlistUrl: 'http://example.invalid/x.m3u',
      }),
    ).toEqual(err(elvError('network', 'unreachable')));
    expect(await downCatalog.importSource('src-1')).toEqual(
      err(elvError('network', 'unreachable')),
    );
    expect(await downCatalog.resolveStream('k1')).toEqual(err(elvError('network', 'unreachable')));

    const err500Catalog = createWorkbenchRemoteCatalog(
      CONFIG,
      createFetchMock(async () => new Response('boom', { status: 500 })).fetchImpl,
    );
    expect(await err500Catalog.removeSource('src-1')).toEqual(
      err(elvError('network', 'unreachable')),
    );
    expect(await err500Catalog.importSource('src-1')).toEqual(
      err(elvError('network', 'unreachable')),
    );
    await expect(err500Catalog.listSources()).rejects.toThrow(/HTTP 500/);

    // Stream ends without a final result line
    const truncatedCatalog = createWorkbenchRemoteCatalog(
      CONFIG,
      createFetchMock(async () =>
        makeChunkedNdjsonResponse(['{"type":"progress","progress":{"phase":"live","done":1}}\n']),
      ).fetchImpl,
    );
    expect(await truncatedCatalog.importSource('src-1')).toEqual(
      err(elvError('network', 'unreachable')),
    );

    // Malformed RPC envelope on Result and Query calls
    const malformedCatalog = createWorkbenchRemoteCatalog(
      CONFIG,
      createFetchMock(async () => makeJsonResponse({ wrong: true })).fetchImpl,
    );
    expect(await malformedCatalog.seasons(1)).toEqual(err(elvError('network', 'unreachable')));
    await expect(malformedCatalog.listSources()).rejects.toThrow(/invalid payload/);
  });

  it('forwards ListItemsOptions on items and allSourcesItems RPCs (#125)', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const { fetchImpl } = createFetchMock(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; args: unknown[] };
      calls.push(body);
      return makeJsonResponse({ value: [] });
    });
    const catalog = createWorkbenchRemoteCatalog(CONFIG, fetchImpl);
    const opts = { sortBy: 'alpha' as const, excludeWatched: true };

    await catalog.items('src-1|movie|10', 0, 18, opts);
    await catalog.allSourcesItems?.('series', 0, 12, ['src-1'], opts);

    expect(calls).toEqual([
      { method: 'items', args: ['src-1|movie|10', 0, 18, opts] },
      { method: 'allSourcesItems', args: ['series', 0, 12, ['src-1'], opts] },
    ]);
  });
});
