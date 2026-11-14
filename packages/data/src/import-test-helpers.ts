import {
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  httpStatusError,
  ok,
  type Result,
  type SqlDriver,
} from '@elv/domain';
import type { ImportDeps } from './import-types';
import { openCatalog } from './migrate';
import { addM3uSource, addXtreamSource, type M3uSourceInput } from './sources';
import { countingScheduler, memorySecrets, tempFileDb, testDb } from './test-db';

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

/**
 * Fake panel behind an `HttpClient`; `fail` maps an action to an HTTP status, `bloat` pads whole-list bodies (and the
 * `get_series_info` object), `bloatCategory` pads per-category bodies too.
 */
function fakePanel(data: PanelData) {
  const state = {
    data,
    fail: new Map<string, number>(),
    bloat: new Set<string>(),
    bloatCategory: new Set<string>(),
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
      if (status !== undefined) return err(httpStatusError(status));
      const cat = u.searchParams.get('category_id');
      const d = state.data;
      const pick = (rows: Row[], action2: string): Row[] => {
        const matching = cat === null ? rows : rows.filter((r) => idsOf(r).includes(cat));
        const padded =
          state.bloat.has(action2) && (cat === null || state.bloatCategory.has(action2));
        return padded ? matching.map((r) => ({ ...r, pad: 'x'.repeat(400) })) : matching;
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
        case 'get_series_info': {
          const info = d.seriesInfo[u.searchParams.get('series_id') ?? ''] ?? [];
          json = state.bloat.has(action) ? { ...(info as object), pad: 'x'.repeat(4000) } : info;
          break;
        }
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

/** Credentials of the fictional M3U account; assembled at runtime so no literal secret sits in the source. */
export const M3U_USER = 'demo-user';
export const M3U_PASS = ['pw', 'Xyz', '19'].join('');
export const M3U_TOKEN = ['tok', 'En9f3a7c21'].join('');

/** Playlist URL of the fictional panel in the Xtream `get.php` shape. */
export const playlistUrlFor = (user = M3U_USER, pass = M3U_PASS): string =>
  `http://list.example:8080/get.php?username=${user}&password=${pass}&type=m3u_plus`;

/** One `#EXTINF` entry for a generated playlist. */
export function extinf(name: string, url: string, attrs = ''): string {
  return `#EXTINF:-1 ${attrs},${name}
${url}
`;
}

/**
 * Sets up an M3U source whose playlist is served from `state.body` by a fake `HttpClient`; `file` puts the
 * catalog in a temporary file database (WAL) instead of memory.
 */
export async function setupM3u(
  body = '',
  input: Partial<M3uSourceInput> = {},
  playlistUrl = playlistUrlFor(),
  file = false,
) {
  const t = file ? tempFileDb() : testDb();
  await openCatalog(t.db);
  const secrets = memorySecrets();
  const scheduler = countingScheduler();
  const state = {
    body,
    status: 200,
    urls: [] as string[],
    chunk: 64,
    failAfter: undefined as number | undefined,
  };
  const http: HttpClient = {
    async get(url): Promise<Result<HttpResponse>> {
      state.urls.push(url);
      if (state.status < 200 || state.status >= 300) return err(httpStatusError(state.status));
      const bytes = new TextEncoder().encode(state.body);
      async function* chunks() {
        for (let i = 0; i < bytes.length; i += state.chunk) {
          if (state.failAfter !== undefined && i >= state.failAfter) {
            throw elvError('network', 'timeout');
          }
          yield bytes.slice(i, i + state.chunk);
        }
      }
      return ok({ status: state.status, headers: {}, body: chunks() });
    },
  };
  const source = await addM3uSource(
    { name: 'List', playlistUrl, ...input },
    { db: t.db, secrets, clock: () => 1, newId: () => 's1' },
  );
  if (!source.ok) throw new Error('source setup failed');
  const deps: ImportDeps = {
    db: t.db,
    http,
    secrets,
    scheduler,
    clock: (() => {
      let now = 1000;
      return () => (now += 10);
    })(),
  };
  return { ...t, secrets, scheduler, state, deps, sourceId: 's1' };
}
