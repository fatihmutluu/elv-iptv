import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccountPoolKey, type SourceRow } from '@elv/data';
import type { FetchLike } from '@elv/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchBridge, type WorkbenchBridgeHandle } from './workbench-bridge.ts';
import { createWorkbenchSecretStore } from './workbench-secret-store.ts';

interface RawHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function sendRawRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function startSyntheticProvider(): Promise<{
  baseUrl: string;
  user: string;
  secret: string;
  close(): Promise<void>;
}> {
  const user = ['wb', 'test', 'user'].join('_');
  const secret = ['wb', 'test', 'pass', '91'].join('_');

  const server: Server = createHttpServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const origin = `http://127.0.0.1:${port}`;

    if (parsed.pathname === '/playlist.m3u') {
      const m3u = [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="ch-1" tvg-chno="101" group-title="News",Alpha News',
        `${origin}/live/${user}/${secret}/101.ts`,
        '#EXTINF:-1 tvg-id="ch-2" tvg-chno="102" group-title="Sports",Beta Sports',
        `${origin}/live/${user}/${secret}/102.ts`,
        '',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(m3u);
      return;
    }

    if (parsed.pathname === '/player_api.php') {
      const action = parsed.searchParams.get('action');
      const u = parsed.searchParams.get('username');
      const p = parsed.searchParams.get('password');
      if (u !== user || p !== secret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user_info: { auth: 0 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!action) {
        res.end(
          JSON.stringify({
            user_info: {
              auth: 1,
              status: 'Active',
              is_trial: '0',
              exp_date: '1900000000',
              allowed_output_formats: ['ts', 'm3u8'],
            },
            server_info: { server_protocol: 'http', url: '127.0.0.1', port: String(port) },
          }),
        );
        return;
      }
      if (action === 'get_live_categories') {
        res.end(JSON.stringify([{ category_id: '10', category_name: 'General' }]));
        return;
      }
      if (action === 'get_live_streams') {
        res.end(
          JSON.stringify([
            { num: 1, name: 'Gamma Live', stream_id: 501, category_id: '10', stream_icon: '' },
          ]),
        );
        return;
      }
      if (action === 'get_vod_categories') {
        res.end(JSON.stringify([{ category_id: '20', category_name: 'Cinema' }]));
        return;
      }
      if (action === 'get_vod_streams') {
        res.end(
          JSON.stringify([
            {
              num: 1,
              name: 'Orbit Runner',
              stream_id: 601,
              category_id: '20',
              container_extension: 'mp4',
              rating: '7.5',
            },
          ]),
        );
        return;
      }
      if (action === 'get_series_categories') {
        res.end(JSON.stringify([{ category_id: '30', category_name: 'Drama' }]));
        return;
      }
      if (action === 'get_series') {
        res.end(
          JSON.stringify([
            { num: 1, name: 'Signal Zero', series_id: 701, category_id: '30', plot: 'A mystery.' },
          ]),
        );
        return;
      }
      if (action === 'get_series_info') {
        res.end(
          JSON.stringify({
            episodes: {
              '1': [
                {
                  id: '70101',
                  episode_num: 1,
                  title: 'Pilot',
                  container_extension: 'mp4',
                  info: { duration_secs: 2400 },
                },
              ],
            },
          }),
        );
        return;
      }
      res.end('[]');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        user,
        secret,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const tempDirs: string[] = [];
const openBridges: WorkbenchBridgeHandle[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-wb-bridge-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openBridges.length > 0) {
    const b = openBridges.pop();
    if (b) await b.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createWorkbenchSecretStore', () => {
  it('stores, reads, persists, and deletes secrets atomically while handling corrupt JSON', async () => {
    const dir = makeTempDir();
    const store = createWorkbenchSecretStore(dir);

    expect(await store.get('source:s1.xtream')).toBeUndefined();
    await store.delete('source:s1.xtream');

    await Promise.all([
      store.set('source:s1.xtream', 'val-1'),
      store.set('source.s2.urlvars', 'val-2'),
    ]);

    const reopened = createWorkbenchSecretStore(dir);
    expect(await reopened.get('source:s1.xtream')).toBe('val-1');
    expect(await reopened.get('source.s2.urlvars')).toBe('val-2');

    await reopened.delete('source:s1.xtream');
    expect(await reopened.get('source:s1.xtream')).toBeUndefined();
    expect(await reopened.get('source.s2.urlvars')).toBe('val-2');

    // Corrupt JSON does not throw unhandled exceptions
    writeFileSync(join(dir, 'secrets.json'), '{not valid json', 'utf8');
    expect(await reopened.get('source.s2.urlvars')).toBeUndefined();
    await reopened.set('source.s3.urlvars', 'recovered');
    expect(await reopened.get('source.s3.urlvars')).toBe('recovered');
  });

  it('rejects invalid secret keys', async () => {
    const store = createWorkbenchSecretStore(makeTempDir());
    await expect(store.get('')).rejects.toThrow();
    await expect(store.set('bad/key', 'x')).rejects.toThrow();
    await expect(store.delete('has space')).rejects.toThrow();
    await expect(store.get('a'.repeat(161))).rejects.toThrow();
  });
});

describe('createWorkbenchBridge', () => {
  const token = '0'.repeat(32);

  it('rejects non-loopback host or empty token', async () => {
    const dir = makeTempDir();
    await expect(createWorkbenchBridge({ dataDir: dir, token, host: '0.0.0.0' })).rejects.toThrow();
    await expect(
      createWorkbenchBridge({ dataDir: dir, token, host: '192.168.1.5' }),
    ).rejects.toThrow();
    await expect(createWorkbenchBridge({ dataDir: dir, token: '   ' })).rejects.toThrow();
  });

  it('enforces Host, Origin, OPTIONS preflight, token auth, body size limit, and method allowlist', async () => {
    const dir = makeTempDir();
    const bridge = await createWorkbenchBridge({ dataDir: dir, token });
    openBridges.push(bridge);

    // 403 bad Host header
    const badHost = await sendRawRequest({
      port: bridge.port,
      method: 'GET',
      path: '/health',
      headers: { Host: 'evil.example:8082', 'X-Elv-Workbench-Token': token },
    });
    expect(badHost.status).toBe(403);
    expect(badHost.headers['access-control-allow-origin']).toBeUndefined();

    // 403 non-loopback Origin header (no ACAO)
    const badOrigin = await sendRawRequest({
      port: bridge.port,
      method: 'GET',
      path: '/health',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        Origin: 'https://evil.example',
        'X-Elv-Workbench-Token': token,
      },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers['access-control-allow-origin']).toBeUndefined();

    // 204 valid OPTIONS preflight without token
    const preflight = await sendRawRequest({
      port: bridge.port,
      method: 'OPTIONS',
      path: '/rpc',
      headers: {
        Host: `localhost:${bridge.port}`,
        Origin: 'http://localhost:8081',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(preflight.headers.vary).toBe('Origin');
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(preflight.headers['access-control-allow-headers']).toBe(
      'Content-Type, X-Elv-Workbench-Token',
    );

    // 401 missing and wrong token
    const noToken = await sendRawRequest({
      port: bridge.port,
      method: 'GET',
      path: '/health',
      headers: { Host: `127.0.0.1:${bridge.port}` },
    });
    expect(noToken.status).toBe(401);

    const wrongToken = await sendRawRequest({
      port: bridge.port,
      method: 'GET',
      path: '/health',
      headers: { Host: `127.0.0.1:${bridge.port}`, 'X-Elv-Workbench-Token': 'wrong-token' },
    });
    expect(wrongToken.status).toBe(401);

    // 200 GET /health with valid token + loopback origin
    const health = await sendRawRequest({
      port: bridge.port,
      method: 'GET',
      path: '/health',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        Origin: 'http://127.0.0.1:8081',
        'X-Elv-Workbench-Token': token,
      },
    });
    expect(health.status).toBe(200);
    expect(health.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8081');
    expect(JSON.parse(health.body)).toEqual({ ok: true, version: 1 });

    // 413 oversized request body (> 256 KiB)
    const oversized = await sendRawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/rpc',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        'Content-Type': 'application/json',
        'X-Elv-Workbench-Token': token,
      },
      body: JSON.stringify({ method: 'listSources', args: ['x'.repeat(270 * 1024)] }),
    });
    expect(oversized.status).toBe(413);

    // 400 unknown RPC method
    const unknownMethod = await sendRawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/rpc',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        'Content-Type': 'application/json',
        'X-Elv-Workbench-Token': token,
      },
      body: JSON.stringify({ method: 'close', args: [] }),
    });
    expect(unknownMethod.status).toBe(400);
    expect(JSON.parse(unknownMethod.body)).toEqual({
      error: { category: 'storage', code: 'unknown-method' },
    });

    // 400 malformed JSON & invalid /rpc/import
    const badJson = await sendRawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/rpc',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        'Content-Type': 'application/json',
        'X-Elv-Workbench-Token': token,
      },
      body: '{broken',
    });
    expect(badJson.status).toBe(400);

    const badImport = await sendRawRequest({
      port: bridge.port,
      method: 'POST',
      path: '/rpc/import',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        'Content-Type': 'application/json',
        'X-Elv-Workbench-Token': token,
      },
      body: JSON.stringify({ id: '' }),
    });
    expect(badImport.status).toBe(400);

    // 404 unknown route
    const notFound = await sendRawRequest({
      port: bridge.port,
      method: 'GET',
      path: '/unknown',
      headers: { Host: `127.0.0.1:${bridge.port}`, 'X-Elv-Workbench-Token': token },
    });
    expect(notFound.status).toBe(404);
  });

  it('imports M3U and Xtream sources end-to-end, redacts resolveStream, keeps credentials out of catalog.db, and persists across restart', async () => {
    const dir = makeTempDir();
    const provider = await startSyntheticProvider();
    try {
      const bridge = await createWorkbenchBridge({ dataDir: dir, token });
      openBridges.push(bridge);

      const rpc = async <T = unknown>(
        target: WorkbenchBridgeHandle,
        method: string,
        args: unknown[] = [],
      ): Promise<T> => {
        const res = await fetch(`${target.baseUrl}/rpc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Elv-Workbench-Token': token,
          },
          body: JSON.stringify({ method, args }),
        });
        expect(res.status).toBe(200);
        const parsed = (await res.json()) as { value: T };
        return parsed.value;
      };

      const streamImport = async (target: WorkbenchBridgeHandle, id: string) => {
        const res = await fetch(`${target.baseUrl}/rpc/import`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Elv-Workbench-Token': token,
          },
          body: JSON.stringify({ id }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/x-ndjson');
        const text = await res.text();
        return text
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      };

      // 1. Add and import M3U source
      const addedM3u = await rpc<{ ok: boolean; value?: SourceRow }>(bridge, 'addSourceFromLink', [
        { name: 'Local M3U', url: `${provider.baseUrl}/playlist.m3u` },
      ]);
      expect(addedM3u.ok).toBe(true);
      const m3uId = addedM3u.value?.id ?? '';

      const m3uLines = await streamImport(bridge, m3uId);
      expect(m3uLines.some((l) => l.type === 'progress')).toBe(true);
      const m3uFinal = m3uLines[m3uLines.length - 1] as {
        type: string;
        result: { ok: boolean; value?: { counts: Record<string, number> } };
      };
      expect(m3uFinal.type).toBe('result');
      expect(m3uFinal.result.ok).toBe(true);
      expect(m3uFinal.result.value?.counts.live).toBe(2);

      // 2. Add and import Xtream source
      const addedXtream = await rpc<{ ok: boolean; value?: SourceRow }>(bridge, 'addSource', [
        {
          kind: 'xtream',
          name: 'Local Xtream',
          server: provider.baseUrl,
          username: provider.user,
          password: provider.secret,
        },
      ]);
      expect(addedXtream.ok).toBe(true);
      const xtreamId = addedXtream.value?.id ?? '';

      const xtreamLines = await streamImport(bridge, xtreamId);
      const xtreamFinal = xtreamLines[xtreamLines.length - 1] as {
        type: string;
        result: { ok: boolean; value?: { counts: Record<string, number> } };
      };
      expect(xtreamFinal.type).toBe('result');
      expect(xtreamFinal.result.ok).toBe(true);
      expect(xtreamFinal.result.value?.counts).toMatchObject({ live: 1, movies: 1, series: 1 });

      // 3. Query catalog surfaces
      const sources = await rpc<SourceRow[]>(bridge, 'listSources');
      expect(sources.map((s) => s.name)).toEqual(['Local M3U', 'Local Xtream']);
      const xtreamSource = sources.find((s) => s.id === xtreamId);
      expect(xtreamSource?.credentialFingerprint).toMatch(/^fp:[0-9a-f]{64}$/);

      const m3uCats = await rpc<Array<{ id: string; name: string }>>(bridge, 'categories', [
        m3uId,
        'live',
      ]);
      expect(m3uCats.length).toBe(2);
      const m3uItems = await rpc<Array<{ key: string; name: string }>>(bridge, 'items', [
        m3uCats[0]?.id,
        0,
        20,
      ]);
      expect(m3uItems.length).toBe(1);
      const channelKey = m3uItems[0]?.key ?? '';

      const detail = await rpc<{ key: string; name: string } | null>(bridge, 'itemDetail', [
        channelKey,
      ]);
      expect(detail?.name).toBe('Alpha News');

      const hits = await rpc<{ live: Array<{ name: string }> }>(bridge, 'search', [
        'Alpha',
        { scope: 'live' },
      ]);
      expect(hits.live.map((r) => r.name)).toEqual(['Alpha News']);

      expect(await rpc(bridge, 'channelByNumber', [101, m3uId])).toMatchObject({
        name: 'Alpha News',
      });
      expect(await rpc(bridge, 'nowNext', [[channelKey], 1_000])).toEqual([]);
      expect(await rpc(bridge, 'epgWindow', [[channelKey], 1_000, 2_000])).toEqual({});

      // Series seasons & episodes
      const seriesCats = await rpc<Array<{ id: string }>>(bridge, 'categories', [
        xtreamId,
        'series',
      ]);
      const seriesItems = await rpc<Array<{ id: number; key: string }>>(bridge, 'items', [
        seriesCats[0]?.id,
        0,
        10,
      ]);
      const seriesId = seriesItems[0]?.id ?? 0;
      const seasons = await rpc<{ ok: boolean; value?: Array<{ season: number }> }>(
        bridge,
        'seasons',
        [seriesId],
      );
      expect(seasons.ok).toBe(true);
      expect(seasons.value?.[0]?.season).toBe(1);
      const episodes = await rpc<Array<{ key: string; title: string }>>(bridge, 'episodes', [
        seriesId,
        1,
      ]);
      expect(episodes[0]?.title).toBe('Pilot');

      // Progress & favorites
      const saved = await rpc<{ ok: boolean }>(bridge, 'saveProgress', [
        {
          itemKey: channelKey,
          sourceId: m3uId,
          kind: 'live',
          title: 'Alpha News',
          positionMs: 12_000,
          durationMs: 60_000,
        },
      ]);
      expect(saved.ok).toBe(true);
      expect(await rpc(bridge, 'getProgress', [channelKey])).toMatchObject({
        itemKey: channelKey,
        positionMs: 12_000,
      });
      expect((await rpc<unknown[]>(bridge, 'listContinueWatching', [10])).length).toBe(1);
      expect((await rpc<unknown[]>(bridge, 'listProgressByKeys', [[channelKey]])).length).toBe(1);
      expect(await rpc(bridge, 'setWatched', [channelKey, true])).toMatchObject({ ok: true });
      expect(await rpc(bridge, 'clearProgress', [channelKey])).toMatchObject({ ok: true });

      // Regression: JSON-serialized undefined optional args arrive as null ([null, 'p1'])
      expect(
        await rpc(bridge, 'saveProgress', [
          {
            itemKey: channelKey,
            sourceId: m3uId,
            kind: 'live',
            title: 'Alpha News',
            positionMs: 15_000,
            durationMs: 60_000,
            profileId: 'p1',
          },
        ]),
      ).toMatchObject({ ok: true });
      expect((await rpc<unknown[]>(bridge, 'listContinueWatching', [null, 'p1'])).length).toBe(1);
      expect(await rpc(bridge, 'channelByNumber', [101, null])).toMatchObject({
        name: 'Alpha News',
      });

      const fav = await rpc<{ ok: boolean; value?: boolean }>(bridge, 'toggleFavorite', [
        { itemKey: channelKey, sourceId: m3uId, kind: 'live', title: 'Alpha News' },
      ]);
      expect(fav).toEqual({ ok: true, value: true });
      expect(await rpc<string[]>(bridge, 'listFavoriteKeys')).toEqual([channelKey]);
      expect((await rpc<unknown[]>(bridge, 'listFavorites', [10])).length).toBe(1);
      expect(
        await rpc(bridge, 'toggleFavorite', [
          {
            itemKey: channelKey,
            sourceId: m3uId,
            kind: 'live',
            title: 'Alpha News',
            profileId: 'p1',
          },
        ]),
      ).toEqual({ ok: true, value: true });
      expect((await rpc<unknown[]>(bridge, 'listFavorites', [null, 'p1'])).length).toBe(1);

      // 4. resolveStream NEVER leaks real URLs or credentials
      const xtreamCats = await rpc<Array<{ id: string }>>(bridge, 'categories', [xtreamId, 'live']);
      const xtreamItems = await rpc<Array<{ key: string }>>(bridge, 'items', [
        xtreamCats[0]?.id,
        0,
        10,
      ]);
      const streamRes = await rpc<{
        ok: boolean;
        value?: { url: string; headers: Record<string, string>; accountKey?: string };
      }>(bridge, 'resolveStream', [xtreamItems[0]?.key]);
      expect(streamRes).toEqual({
        ok: true,
        value: {
          url: 'https://workbench.invalid/preview.m3u8',
          headers: {},
          accountKey: resolveAccountPoolKey(xtreamSource as SourceRow),
        },
      });
      const serialized = JSON.stringify(streamRes);
      expect(serialized).not.toContain(provider.user);
      expect(serialized).not.toContain(provider.secret);
      expect(serialized).not.toContain(provider.baseUrl);

      // Episode resolveStream also works without leaking secrets
      const epStream = await rpc<{
        ok: boolean;
        value?: { url: string; headers: Record<string, string>; accountKey?: string };
      }>(bridge, 'resolveStream', [episodes[0]?.key]);
      expect(epStream.ok).toBe(true);
      expect(epStream.value?.url).toBe('https://workbench.invalid/preview.m3u8');

      // Series (non-playable container) and missing item resolveStream return storage/item-not-found
      expect(await rpc(bridge, 'resolveStream', [seriesItems[0]?.key])).toEqual({
        ok: false,
        error: { category: 'storage', code: 'item-not-found' },
      });
      const missingStream = await rpc(bridge, 'resolveStream', ['x:missing:live:999']);
      expect(missingStream).toEqual({
        ok: false,
        error: { category: 'storage', code: 'item-not-found' },
      });

      // importGuide returns error cleanly when no guide is configured
      const guideRes = await rpc<{ ok: boolean }>(bridge, 'importGuide', [m3uId]);
      expect(guideRes.ok).toBe(false);

      // 5. Close bridge and verify ZERO plaintext credentials in catalog.db
      await bridge.close();
      openBridges.pop();

      const dbBytes = readFileSync(join(dir, 'catalog.db')).toString('latin1');
      expect(dbBytes).not.toContain(provider.user);
      expect(dbBytes).not.toContain(provider.secret);

      // 6. Reopen bridge on same dataDir and verify persistence
      const reopened = await createWorkbenchBridge({ dataDir: dir, token });
      openBridges.push(reopened);

      const persistedSources = await rpc<SourceRow[]>(reopened, 'listSources');
      expect(persistedSources.map((s) => s.name)).toEqual(['Local M3U', 'Local Xtream']);
      expect(await rpc<string[]>(reopened, 'listFavoriteKeys')).toEqual([channelKey]);
      expect(await rpc(reopened, 'removeSource', [m3uId])).toMatchObject({ ok: true });
      expect((await rpc<SourceRow[]>(reopened, 'listSources')).map((s) => s.id)).toEqual([
        xtreamId,
      ]);
    } finally {
      await provider.close();
    }
  });

  it('aborts an active POST /rpc/import when the client disconnects prematurely', async () => {
    const dir = makeTempDir();
    let fetchStartedResolve: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    let abortedResolve: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });

    const slowFetch: FetchLike = async (_url, init) => {
      fetchStartedResolve?.();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          abortedResolve?.();
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
      throw new Error('unreachable');
    };

    const bridge = await createWorkbenchBridge({ dataDir: dir, token, fetchImpl: slowFetch });
    openBridges.push(bridge);

    const addRes = await fetch(`${bridge.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Elv-Workbench-Token': token },
      body: JSON.stringify({
        method: 'addSourceFromLink',
        args: [{ name: 'Slow', url: 'http://127.0.0.1:9999/slow.m3u' }],
      }),
    });
    const added = (await addRes.json()) as { value: { ok: boolean; value: SourceRow } };
    const sourceId = added.value.value.id;

    const req = httpRequest({
      host: '127.0.0.1',
      port: bridge.port,
      method: 'POST',
      path: '/rpc/import',
      headers: {
        Host: `127.0.0.1:${bridge.port}`,
        'Content-Type': 'application/json',
        'X-Elv-Workbench-Token': token,
      },
    });
    req.on('error', () => undefined);
    req.write(JSON.stringify({ id: sourceId }));
    req.end();

    await fetchStarted;
    req.destroy();
    await aborted;
  });

  it('forwards listSeriesUnplayedCounts over POST /rpc and drops invalid inputs (#409)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-wb-unplayed-'));
    tempDirs.push(dir);
    const token = 'test-token-unplayed';
    const bridge = await createWorkbenchBridge({ dataDir: dir, token });
    openBridges.push(bridge);

    const res = await fetch(`${bridge.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Elv-Workbench-Token': token },
      body: JSON.stringify({
        method: 'listSeriesUnplayedCounts',
        args: [['src-1|series|1'], 'default'],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: [] });

    const invalid = await fetch(`${bridge.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Elv-Workbench-Token': token },
      body: JSON.stringify({
        method: 'listSeriesUnplayedCounts',
        args: ['not-an-array'],
      }),
    });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({ value: [] });
  });
});
