import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeBody(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield encodeUtf8(text);
    },
  };
}

function jsonResponse(payload: unknown): HttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: makeBody(JSON.stringify(payload)),
  };
}

function m3uResponse(text: string): HttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    body: makeBody(text),
  };
}

const DEMO_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch-1" group-title="News",Channel Alpha',
  'http://sim.example.test/live/demo/demo/101.ts',
  '#EXTINF:-1 tvg-id="ch-2" group-title="General",Channel Beta',
  'http://sim.example.test/live/demo/demo/102.ts',
  '',
].join('\n');

const EMPTY_M3U = '#EXTM3U\n';

export interface SimHttpOptions {
  /** Artificial promise barrier before returning live streams so tests can inspect progress / abort mid-import. */
  hangLiveUntil?: Promise<void>;
}

function createSimHttpClient(opts: SimHttpOptions = {}): HttpClient {
  return {
    async get(rawUrl, reqOpts) {
      if (reqOpts?.signal?.aborted) {
        return err(elvError('network', 'aborted'));
      }
      const url = new URL(rawUrl);
      if (url.hostname === 'unreachable.example.test') {
        return err(elvError('network', 'unreachable'));
      }

      if (url.pathname === '/player_api.php') {
        const username = url.searchParams.get('username');
        const password = url.searchParams.get('password');
        const action = url.searchParams.get('action');

        if (username === 'empty' && password === 'test') {
          if (!action) {
            return ok(
              jsonResponse({
                user_info: { auth: 1, status: 'Active' },
                server_info: { timezone: 'UTC' },
              }),
            );
          }
          return ok(jsonResponse([]));
        }

        if (username !== 'demo' || password !== 'demo') {
          return ok(jsonResponse({ user_info: { auth: 0 } }));
        }

        if (!action) {
          return ok(
            jsonResponse({
              user_info: {
                auth: 1,
                status: 'Active',
                allowed_output_formats: ['ts', 'm3u8'],
              },
              server_info: { timezone: 'UTC' },
            }),
          );
        }
        if (action === 'get_live_categories') {
          return ok(jsonResponse([{ category_id: '1', category_name: 'General' }]));
        }
        if (action === 'get_vod_categories') {
          return ok(jsonResponse([{ category_id: '10', category_name: 'Feature Films' }]));
        }
        if (action === 'get_series_categories') {
          return ok(jsonResponse([{ category_id: '20', category_name: 'Shows' }]));
        }
        if (action === 'get_live_streams') {
          if (opts.hangLiveUntil !== undefined) {
            await Promise.race([
              opts.hangLiveUntil,
              new Promise<void>((resolve) => {
                reqOpts?.signal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            if (reqOpts?.signal?.aborted) {
              return err(elvError('network', 'aborted'));
            }
          }
          return ok(
            jsonResponse([
              { stream_id: 101, name: 'Channel Alpha', category_id: '1', num: 1 },
              { stream_id: 102, name: 'Channel Beta', category_id: '1', num: 2 },
            ]),
          );
        }
        if (action === 'get_vod_streams') {
          return ok(
            jsonResponse([
              {
                stream_id: 201,
                name: 'Synthetic Movie One',
                category_id: '10',
                container_extension: 'mp4',
              },
            ]),
          );
        }
        if (action === 'get_series') {
          return ok(
            jsonResponse([
              {
                series_id: 301,
                name: 'Synthetic Series One',
                category_id: '20',
              },
            ]),
          );
        }
        return ok(jsonResponse([]));
      }

      if (url.pathname === '/get.php') {
        const username = url.searchParams.get('username');
        const password = url.searchParams.get('password');
        if (username !== 'demo' || password !== 'demo') {
          return err(elvError('auth', 'http-403'));
        }
        return ok(m3uResponse(DEMO_M3U));
      }

      if (url.pathname === '/playlists/demo.m3u8') {
        return ok(m3uResponse(DEMO_M3U));
      }

      if (url.pathname === '/playlists/empty.m3u8') {
        return ok(m3uResponse(EMPTY_M3U));
      }

      return err(elvError('network', 'http-404'));
    },
  };
}

/** Opens a migrated in-memory SQLite `CatalogService` wired to `createSimHttpClient`. */
export async function openTestCatalog(httpOpts: SimHttpOptions = {}) {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) {
    throw new Error(`migrate failed: ${migrated.error.code}`);
  }
  const secrets = memorySecrets();
  const scheduler = countingScheduler();
  let nextId = 1;
  let now = 1_700_000_000_000;
  const catalog = createCatalogService({
    db: handle.db,
    secrets,
    scheduler,
    http: createSimHttpClient(httpOpts),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });

  return {
    catalog,
    db: handle.db,
    secrets,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}
