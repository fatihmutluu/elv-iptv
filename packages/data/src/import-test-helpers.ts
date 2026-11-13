import {
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
  type Result,
  type SqlDriver,
} from '@elv/domain';
import type { ImportDeps } from './import-types';
import { openCatalog } from './migrate';
import { addXtreamSource } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';

type Row = Record<string, unknown>;

export interface PanelData {
  liveCats: Row[];
  vodCats: Row[];
  seriesCats: Row[];
  live: Row[];
  vod: Row[];
  series: Row[];
  seriesInfo: Record<string, unknown>;
  user: Row;
}

const SERVER = 'http://panel.example:8080';

export function emptyPanel(): PanelData {
  return {
    liveCats: [],
    vodCats: [],
    seriesCats: [],
    live: [],
    vod: [],
    series: [],
    seriesInfo: {},
    user: { auth: 1, status: 'Active' },
  };
}

const idsOf = (row: Row): string[] =>
  Array.isArray(row.category_ids) ? row.category_ids.map(String) : [String(row.category_id ?? '')];

/** Fake panel behind an `HttpClient`; `fail` maps an action to an HTTP status, `bloat` pads whole-list bodies. */
function fakePanel(data: PanelData) {
  const state = {
    data,
    fail: new Map<string, number>(),
    bloat: new Set<string>(),
    urls: [] as string[],
    failWithCategory: new Map<string, number>(),
    onRequest: undefined as ((action: string | null) => void | Promise<void>) | undefined,
  };
  const http: HttpClient = {
    async get(url): Promise<Result<HttpResponse>> {
      state.urls.push(url);
      const u = new URL(url);
      const action = u.searchParams.get('action');
      await state.onRequest?.(action);
      const status =
        action === null
          ? undefined
          : (state.fail.get(action) ??
            (u.searchParams.has('category_id') ? state.failWithCategory.get(action) : undefined));
      if (status !== undefined) {
        async function* empty() {
          yield new Uint8Array(0);
        }
        return ok({ status, headers: {}, body: empty() });
      }
      const cat = u.searchParams.get('category_id');
      const d = state.data;
      const pick = (rows: Row[], action2: string): Row[] => {
        const matching = cat === null ? rows : rows.filter((r) => idsOf(r).includes(cat));
        return cat === null && state.bloat.has(action2)
          ? matching.map((r) => ({ ...r, pad: 'x'.repeat(400) }))
          : matching;
      };
      let json: unknown;
      switch (action) {
        case null:
          json = { user_info: d.user, server_info: {} };
          break;
        case 'get_live_categories':
          json = d.liveCats;
          break;
        case 'get_vod_categories':
          json = d.vodCats;
          break;
        case 'get_series_categories':
          json = d.seriesCats;
          break;
        case 'get_live_streams':
          json = pick(d.live, action);
          break;
        case 'get_vod_streams':
          json = pick(d.vod, action);
          break;
        case 'get_series':
          json = pick(d.series, action);
          break;
        case 'get_series_info':
          json = d.seriesInfo[u.searchParams.get('series_id') ?? ''] ?? [];
          break;
        default:
          return err(elvError('network', 'request-failed'));
      }
      const bytes = new TextEncoder().encode(JSON.stringify(json));
      async function* body() {
        yield bytes;
      }
      return ok({ status: 200, headers: {}, body: body() });
    },
  };
  return { http, state };
}

export async function setup(data: PanelData = emptyPanel()) {
  const t = testDb();
  await openCatalog(t.db);
  const secrets = memorySecrets();
  const scheduler = countingScheduler();
  const panel = fakePanel(data);
  const source = await addXtreamSource(
    { name: 'Demo', server: SERVER, username: 'demo-user', password: ['pw', 'Xyz', '19'].join('') },
    { db: t.db, secrets, clock: () => 1, newId: () => 's1' },
  );
  if (!source.ok) throw new Error('source setup failed');
  const deps: ImportDeps = {
    db: t.db,
    http: panel.http,
    secrets,
    scheduler,
    clock: (() => {
      let now = 1000;
      return () => (now += 10);
    })(),
  };
  return { ...t, secrets, scheduler, panel, deps, sourceId: 's1' };
}

export const count = async (db: SqlDriver, table: string): Promise<number> =>
  (await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ?? 0;

export function sampleCatalog(): PanelData {
  const d = emptyPanel();
  d.liveCats = [
    { category_id: '1', category_name: 'News' },
    { category_id: '2', category_name: 'Sports' },
  ];
  d.vodCats = [
    { category_id: '10', category_name: 'Drama' },
    { category_id: '11', category_name: 'Comedy' },
  ];
  d.seriesCats = [{ category_id: '20', category_name: 'Anime' }];
  d.live = [
    {
      num: 1,
      name: 'Haber Bir',
      stream_id: 100,
      stream_icon: 'http://img.example/1.png',
      epg_channel_id: 'haber1.tr',
      category_id: '1',
      tv_archive: 1,
      tv_archive_duration: 3,
    },
    { num: 2, name: 'Spor Iki', stream_id: 101, epg_channel_id: '', category_id: '2' },
    { num: 3, name: 'Both Cats', stream_id: 102, category_id: '1', category_ids: [1, 2] },
  ];
  d.vod = [
    {
      name: 'Film A',
      stream_id: 200,
      category_id: '10',
      container_extension: 'mkv',
      rating: '7.5',
    },
    { name: 'Film B', stream_id: 201, category_id: '10' },
    {
      name: 'Film A',
      stream_id: 200,
      category_id: '11',
      container_extension: 'mkv',
      rating: '7.5',
    },
    { name: 'Film C', stream_id: 202, category_id: '11' },
  ];
  d.series = [
    {
      name: 'Show One',
      series_id: 300,
      category_id: '20',
      plot: 'Plot',
      last_modified: '1700000000',
    },
    { name: 'Show Two', series_id: 301, category_id: '20' },
  ];
  d.seriesInfo = {
    '300': {
      seasons: [{ season_number: 1 }],
      episodes: {
        '1': [
          {
            id: '9001',
            episode_num: 1,
            title: 'Pilot',
            container_extension: 'mp4',
            info: { duration_secs: 1500 },
          },
          { id: '9002', episode_num: 2, title: 'Second', container_extension: 'mkv' },
        ],
      },
    },
  };
  return d;
}
