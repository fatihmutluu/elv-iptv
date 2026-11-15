import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient, type HttpResponse, ok } from '@elv/domain';
import type { AndroidKeyEvent, AndroidKeySource } from '@elv/ui-kit';

function makeBody(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
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

export interface BrowseCatalogOptions {
  liveCount?: number;
  failSeriesInfoAttempts?: number;
}

export function createBrowseHttpClient(opts: BrowseCatalogOptions = {}): HttpClient {
  const liveCount = opts.liveCount ?? 3;
  let remainingSeriesFailures = opts.failSeriesInfoAttempts ?? 0;

  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname !== '/player_api.php') {
        return err(elvError('network', 'http-404'));
      }
      const action = url.searchParams.get('action');
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
        return ok(
          jsonResponse([
            { category_id: '1', category_name: 'General' },
            { category_id: '2', category_name: 'Regional' },
          ]),
        );
      }
      if (action === 'get_vod_categories') {
        return ok(jsonResponse([{ category_id: '10', category_name: 'Feature Films' }]));
      }
      if (action === 'get_series_categories') {
        return ok(jsonResponse([{ category_id: '20', category_name: 'Shows' }]));
      }
      if (action === 'get_live_streams') {
        const rows = Array.from({ length: liveCount }, (_, i) => ({
          stream_id: 1_000 + i,
          name: `Channel ${i + 1}`,
          category_id: '1',
          num: i + 1,
        }));
        rows.push({
          stream_id: 999_001,
          name: 'Regional One',
          category_id: '2',
          num: 901,
        });
        return ok(jsonResponse(rows));
      }
      if (action === 'get_vod_streams') {
        return ok(
          jsonResponse([
            {
              stream_id: 201,
              name: 'Synthetic Movie One',
              category_id: '10',
              container_extension: 'mp4',
              year: '2024',
            },
          ]),
        );
      }
      if (action === 'get_series') {
        return ok(
          jsonResponse([
            { series_id: 301, name: 'Synthetic Series One', category_id: '20' },
            { series_id: 302, name: 'Synthetic Series Two', category_id: '20' },
          ]),
        );
      }
      if (action === 'get_series_info') {
        if (remainingSeriesFailures > 0) {
          remainingSeriesFailures -= 1;
          return err(elvError('network', 'unreachable'));
        }
        return ok(
          jsonResponse({
            seasons: [{ season_number: 1 }, { season_number: 2 }],
            episodes: {
              '1': [
                { id: '9001', episode_num: 1, title: 'Pilot', container_extension: 'mp4' },
                { id: '9002', episode_num: 2, title: 'Second', container_extension: 'mp4' },
              ],
              '2': [{ id: '9003', episode_num: 1, title: '', container_extension: 'mp4' }],
            },
          }),
        );
      }
      return ok(jsonResponse([]));
    },
  };
}

export async function openBrowseTestCatalog(opts: BrowseCatalogOptions = {}) {
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
    http: createBrowseHttpClient(opts),
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });

  return {
    catalog,
    async addAndImport(name = 'Demo') {
      const added = await catalog.addSource({
        kind: 'xtream',
        name,
        server: 'http://sim.example.test:8080',
        username: 'demo',
        password: ['de', 'mo'].join(''),
      });
      if (!added.ok) throw new Error(`addSource failed: ${added.error.code}`);
      const imported = await catalog.importSource(added.value.id);
      if (!imported.ok) throw new Error(`importSource failed: ${imported.error.code}`);
      return catalog.listSources();
    },
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

export function createFakeBrowseKeys() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const source: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    tap(keyCode: number) {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
      listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
    },
  };
}
