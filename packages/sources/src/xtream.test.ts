import {
  type ElvError,
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient, type XtreamClient, type XtreamClientOptions } from './xtream';

type Reply =
  | { json: unknown; status?: number }
  | { text: string; status?: number }
  | { throws: true }
  | { fail: ElvError };

interface Recorded {
  url: string;
  headers: Record<string, string> | undefined;
}

const USER = 'u1';
const PASS = 'p@ss/word';

function fakeHttp(route: (url: string) => Reply) {
  const requests: Recorded[] = [];
  const http: HttpClient = {
    async get(url, options): Promise<Result<HttpResponse>> {
      requests.push({ url, headers: options?.headers ? { ...options.headers } : undefined });
      const reply = route(url);
      if ('throws' in reply) throw new Error(`boom ${url}`);
      if ('fail' in reply) return err(reply.fail);
      const text = 'json' in reply ? JSON.stringify(reply.json) : reply.text;
      const bytes = new TextEncoder().encode(text);
      async function* body() {
        yield bytes.slice(0, 3);
        yield bytes.slice(3);
      }
      return ok({ status: reply.status ?? 200, headers: {}, body: body() });
    },
  };
  return { http, requests };
}

function client(route: (url: string) => Reply, extra: Partial<XtreamClientOptions> = {}) {
  const { http, requests } = fakeHttp(route);
  const c = createXtreamClient({
    http,
    server: 'http://h.example:8080/',
    username: USER,
    password: PASS,
    ...extra,
  });
  return { c, requests };
}

const action = (url: string) => new URL(url).searchParams.get('action');

function expectErr<T>(r: Result<T>, category: string, code: string): ElvError {
  if (r.ok) throw new Error('expected an error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
  return r.error;
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected error ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('account', () => {
  const info = {
    user_info: {
      auth: 1,
      status: 'Active',
      exp_date: '1900000000',
      max_connections: '2',
      active_cons: 1,
      is_trial: '0',
      allowed_output_formats: ['m3u8', 'ts'],
    },
    server_info: { timezone: 'Europe/Berlin' },
  };

  it('maps the field list from numbers and numeric strings', async () => {
    const { c } = client(() => ({ json: info }));
    expect(value(await c.account())).toEqual({
      status: 'Active',
      expiresAt: 1900000000000,
      maxConnections: 2,
      activeConnections: 1,
      isTrial: false,
      outputFormats: ['m3u8', 'ts'],
      serverTimezone: 'Europe/Berlin',
    });
  });

  it('tolerates a sparse account', async () => {
    const { c } = client(() => ({
      json: { user_info: { auth: '1', is_trial: 1, exp_date: null } },
    }));
    expect(value(await c.account())).toEqual({
      status: 'Active',
      isTrial: true,
      outputFormats: [],
    });
  });

  it('classifies bad credentials, expiry, HTTP and format failures', async () => {
    expectErr(
      await client(() => ({ json: { user_info: { auth: 0 } } })).c.account(),
      'auth',
      'invalid-credentials',
    );
    expectErr(
      await client(() => ({ json: { user_info: { auth: 1, status: 'Expired' } } })).c.account(),
      'auth',
      'account-expired',
    );
    expectErr(
      await client(() => ({ json: { user_info: { auth: 1, status: 'Some Odd' } } })).c.account(),
      'auth',
      'account-some-odd',
    );
    expectErr(await client(() => ({ text: '', status: 401 })).c.account(), 'auth', 'unauthorized');
    expectErr(await client(() => ({ text: '', status: 403 })).c.account(), 'auth', 'unauthorized');
    expectErr(
      await client(() => ({ text: '', status: 503 })).c.account(),
      'network',
      'server-error',
    );
    expectErr(
      await client(() => ({ text: '', status: 404 })).c.account(),
      'network',
      'http-status',
    );
    expectErr(
      await client(() => ({ text: '<html>' })).c.account(),
      'source-format',
      'invalid-json',
    );
    expectErr(
      await client(() => ({ json: { foo: 1 } })).c.account(),
      'source-format',
      'unexpected-shape',
    );
    expectErr(
      await client(() => ({ json: null })).c.account(),
      'source-format',
      'unexpected-shape',
    );
    expectErr(await client(() => ({ throws: true })).c.account(), 'network', 'request-failed');
    const timeout = elvError('network', 'timeout', 'https://h.example/?password=zzz');
    const e = expectErr(await client(() => ({ fail: timeout })).c.account(), 'network', 'timeout');
    expect(e.detail).toBeUndefined();
  });

  it('reports a body that dies mid-stream', async () => {
    const http: HttpClient = {
      async get() {
        async function* body() {
          yield new Uint8Array([1]);
          throw new Error('reset');
        }
        return ok({ status: 200, headers: {}, body: body() });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://h.example',
      username: USER,
      password: PASS,
    });
    expectErr(await c.account(), 'network', 'stream-failed');
  });
});

describe('categories', () => {
  it('uses the right action per kind and maps ids', async () => {
    const { c, requests } = client(() => ({
      json: [
        { category_id: '5', category_name: 'News &amp; Co ', parent_id: 0 },
        { category_id: 6, category_name: 'Sub', parent_id: '5' },
        { category_name: 'no id' },
      ],
    }));
    const live = value(await c.categories('live'));
    expect(live).toEqual([
      { id: '5', name: 'News & Co' },
      { id: '6', name: 'Sub', parentId: '5' },
    ]);
    await c.categories('movie');
    await c.categories('series');
    expect(requests.map((r) => action(r.url))).toEqual([
      'get_live_categories',
      'get_vod_categories',
      'get_series_categories',
    ]);
  });
  it('rejects a non-array', async () => {
    expectErr(
      await client(() => ({ json: { a: 1 } })).c.categories('live'),
      'source-format',
      'unexpected-shape',
    );
  });
  it('treats an empty reply as an empty list', async () => {
    expect(value(await client(() => ({ json: null })).c.categories('live'))).toEqual([]);
    expect(value(await client(() => ({ json: false })).c.categories('live'))).toEqual([]);
  });
});

describe('lists', () => {
  it('maps live streams of both stream types', async () => {
    const { c, requests } = client(() => ({
      json: [
        {
          stream_id: 1,
          num: 1,
          name: 'A',
          stream_type: 'live',
          category_id: '3',
          category_ids: [1, 2],
          stream_icon: 'http://i.example/a.png',
          epg_channel_id: null,
          tv_archive: 1,
          tv_archive_duration: '10',
          added: '1700000000',
        },
        {
          stream_id: '2',
          name: 'B',
          stream_type: 'created_live',
          category_id: '4',
          epg_channel_id: '',
          tv_archive: 0,
        },
        { stream_id: 3, name: 'C', category_id: '', epg_channel_id: 'c.example', stream_icon: '' },
        { name: 'no id' },
      ],
    }));
    const live = value(await c.liveStreams());
    expect(live).toEqual([
      {
        id: 1,
        num: 1,
        name: 'A',
        categoryIds: ['1', '2'],
        icon: 'http://i.example/a.png',
        catchupDays: 10,
        added: 1700000000000,
      },
      { id: 2, name: 'B', categoryIds: ['4'], catchupDays: 0 },
      { id: 3, name: 'C', categoryIds: [], epgId: 'c.example', catchupDays: 0 },
    ]);
    expect(live[0]?.epgId).toBeUndefined();
    await c.liveStreams('7');
    expect(requests[1]?.url).toContain('&category_id=7');
    expect(requests[0]?.url).not.toContain('category_id');
  });

  it('merges repeated live ids too', async () => {
    const { c } = client(() => ({
      json: [
        { stream_id: 1, name: 'A', category_id: '1' },
        { stream_id: 1, name: 'A', category_id: '2' },
      ],
    }));
    expect(value(await c.liveStreams())).toHaveLength(1);
  });

  it('merges repeated movies and keeps messy fields tolerant', async () => {
    const { c, requests } = client(() => ({
      json: [
        {
          stream_id: 9,
          name: 'M &amp; N ',
          category_id: '1',
          container_extension: 'mkv',
          rating: '7.5',
          year: '2020',
          stream_icon: 'x',
        },
        {
          stream_id: 10,
          name: 12345,
          category_id: '1',
          year: '',
          rating: null,
          episode_run_time: 90,
        },
        { stream_id: 9, name: 'M', category_id: '2' },
        { stream_id: 9, name: 'M', category_id: '1' },
      ],
    }));
    const movies = value(await c.vodStreams('1'));
    expect(movies).toEqual([
      {
        id: 9,
        name: 'M & N',
        categoryIds: ['1', '2'],
        icon: 'x',
        rating: 7.5,
        year: 2020,
        extension: 'mkv',
      },
      { id: 10, name: '12345', categoryIds: ['1'], extension: 'mp4' },
    ]);
    expect(action(requests[0]?.url ?? '')).toBe('get_vod_streams');
  });

  it('merges repeated series and reads either release date spelling', async () => {
    const { c, requests } = client(() => ({
      json: [
        {
          series_id: 4,
          name: 'S',
          category_id: '1',
          cover: 'c',
          plot: ' P &lt; ',
          rating: '8',
          release_date: '2019-05-01',
          last_modified: '1700000001',
        },
        { series_id: 4, name: 'S', category_id: '2' },
        { series_id: 5, name: 'T', category_ids: ['3'], releaseDate: '2018-01-01' },
        { series_id: 6, name: 'U', category_id: '3', year: 2001 },
        { series_id: 7, name: 'V', category_id: '3', release_date: 'soon' },
      ],
    }));
    const list = value(await c.series());
    expect(list[0]).toEqual({
      id: 4,
      name: 'S',
      categoryIds: ['1', '2'],
      cover: 'c',
      plot: 'P <',
      rating: 8,
      year: 2019,
      lastModified: 1700000001000,
    });
    expect(list.map((s) => s.year)).toEqual([2019, 2018, 2001, undefined]);
    expect(action(requests[0]?.url ?? '')).toBe('get_series');
  });
});

describe('seriesInfo', () => {
  it('flattens episodes sorted by season then episode', async () => {
    const { c, requests } = client(() => ({
      json: {
        seasons: [{ season_number: 2 }, 1],
        episodes: {
          '2': [
            {
              id: '21',
              episode_num: '1',
              title: 'S2E1',
              container_extension: 'mkv',
              info: { duration_secs: '1500' },
            },
          ],
          '1': [
            { id: '12', episode_num: 2, title: 'Two', container_extension: 'mp4' },
            { id: '11', episode_num: 1, title: ' One &amp; ', info: [] },
            { episode_num: 3 },
          ],
        },
      },
    }));
    const info = value(await c.seriesInfo(42));
    expect(info.seasons).toEqual([1, 2]);
    expect(info.episodes).toEqual([
      { id: 11, season: 1, episode: 1, title: 'One &', extension: 'mp4' },
      { id: 12, season: 1, episode: 2, title: 'Two', extension: 'mp4' },
      { id: 21, season: 2, episode: 1, title: 'S2E1', extension: 'mkv', durationSec: 1500 },
    ]);
    expect(requests[0]?.url).toContain('action=get_series_info&series_id=42');
  });

  it('derives seasons from the episode keys and accepts an array of seasons', async () => {
    const { c } = client(() => ({
      json: { episodes: [[{ id: 1, season: 3, episode_num: 1, title: 'x' }], 'junk'] },
    }));
    const info = value(await c.seriesInfo(1));
    expect(info.seasons).toEqual([3]);
    const { c: c2 } = client(() => ({ json: { episodes: { '4': [{ id: 1, episode_num: 1 }] } } }));
    const i2 = value(await c2.seriesInfo(1));
    expect(i2.seasons).toEqual([4]);
    expect(i2.episodes[0]?.title).toBe('');
  });

  it('tolerates a series without episodes and rejects non-objects', async () => {
    expect(value(await client(() => ({ json: {} })).c.seriesInfo(1))).toEqual({
      seasons: [],
      episodes: [],
    });
    expectErr(
      await client(() => ({ json: [1] })).c.seriesInfo(1),
      'source-format',
      'unexpected-shape',
    );
  });
});

describe('vodInfo', () => {
  it('maps info and movie data', async () => {
    const { c, requests } = client(() => ({
      json: {
        info: { duration_secs: '5400', plot: ' Plot ', releasedate: '2020-03-04' },
        movie_data: { container_extension: 'mkv' },
      },
    }));
    expect(value(await c.vodInfo(8))).toEqual({
      durationSec: 5400,
      plot: 'Plot',
      year: 2020,
      extension: 'mkv',
    });
    expect(requests[0]?.url).toContain('action=get_vod_info&vod_id=8');
  });
  it('defaults the extension and prefers year', async () => {
    const { c } = client(() => ({ json: { info: { year: '1999', releasedate: '2020-01-01' } } }));
    expect(value(await c.vodInfo(1))).toEqual({ year: 1999, extension: 'mp4' });
    expect(value(await client(() => ({ json: {} })).c.vodInfo(1))).toEqual({ extension: 'mp4' });
  });
});

describe('shortEpg', () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  it('decodes base64 as UTF-8 and converts seconds to ms', async () => {
    const { c, requests } = client(() => ({
      json: {
        epg_listings: [
          {
            title: b64('Çay saati ☕'),
            description: b64('Açıklama'),
            start_timestamp: '1700000000',
            stop_timestamp: 1700003600,
          },
          { title: '!!notbase64!!', description: '', start_timestamp: 1, stop_timestamp: 2 },
          { title: b64('bad'), start_timestamp: 'x', stop_timestamp: 2 },
        ],
      },
    }));
    expect(value(await c.shortEpg(5, 3))).toEqual([
      { start: 1700000000000, stop: 1700003600000, title: 'Çay saati ☕', desc: 'Açıklama' },
      { start: 1000, stop: 2000, title: '!!notbase64!!' },
    ]);
    expect(requests[0]?.url).toContain('action=get_short_epg&stream_id=5&limit=3');
    await c.shortEpg(5);
    expect(requests[1]?.url).not.toContain('limit');
  });
  it('returns an empty list without listings', async () => {
    expect(value(await client(() => ({ json: {} })).c.shortEpg(1))).toEqual([]);
    expect(value(await client(() => ({ json: { epg_listings: [] } })).c.shortEpg(1))).toEqual([]);
  });
});

describe('urls', () => {
  const enc = encodeURIComponent;
  it('are the same with or without a trailing slash', () => {
    const a = client(() => ({ json: [] }), { server: 'http://h:8080/' }).c;
    const b = client(() => ({ json: [] }), { server: 'http://h:8080' }).c;
    expect(a.playlistUrl()).toBe(b.playlistUrl());
    expect(a.streamUrl('live', 5)).toBe(b.streamUrl('live', 5));
    expect(a.guideUrl()).toBe(`http://h:8080/xmltv.php?username=${USER}&password=${enc(PASS)}`);
  });
  it('builds playlist and stream URLs from the transport format', () => {
    const ts = client(() => ({ json: [] })).c;
    const hls = client(() => ({ json: [] }), { transport: { xtreamFormat: 'm3u8' } }).c;
    expect(ts.playlistUrl()).toBe(
      `http://h.example:8080/get.php?username=${USER}&password=${enc(PASS)}&type=m3u_plus&output=ts`,
    );
    expect(hls.playlistUrl()).toContain('&type=m3u_plus&output=m3u8');
    expect(ts.streamUrl('live', 5)).toBe(`http://h.example:8080/live/${USER}/${enc(PASS)}/5.ts`);
    expect(hls.streamUrl('live', 5)).toMatch(/\/5\.m3u8$/);
    expect(ts.streamUrl('live', 5, 'm3u8')).toMatch(/\/5\.m3u8$/);
    expect(ts.streamUrl('movie', 6)).toMatch(/\/movie\/u1\/.+\/6\.mp4$/);
    expect(ts.streamUrl('movie', 6, 'mkv')).toMatch(/\/6\.mkv$/);
    expect(ts.streamUrl('episode', 7, 'mkv')).toMatch(/\/series\/u1\/.+\/7\.mkv$/);
    expect(ts.streamUrl('series', 7)).toMatch(/\/series\/.+\/7\.mp4$/);
  });
  it('keeps a path in the server URL', () => {
    const c = client(() => ({ json: [] }), { server: 'http://h.example/panel//' }).c;
    expect(c.guideUrl()).toMatch(/^http:\/\/h\.example\/panel\/xmltv\.php\?/);
  });
});

describe('requests', () => {
  it('carry the transport headers and the credentials in the API URL', async () => {
    const transport = { userAgent: 'UA/1', referer: 'http://r.example/' };
    const { c, requests } = client(() => ({ json: [] }), { transport });
    await c.liveStreams();
    expect(requests[0]?.headers).toEqual(transportHeaders(transport));
    const u = new URL(requests[0]?.url ?? '');
    expect(u.pathname).toBe('/player_api.php');
    expect(u.searchParams.get('username')).toBe(USER);
    expect(u.searchParams.get('password')).toBe(PASS);
  });
});

describe('never leaks credentials in errors', () => {
  it('keeps password, its encoding and the URL out of every failure', async () => {
    const routes: Reply[] = [
      { throws: true },
      { text: 'oops', status: 500 },
      { text: 'not json' },
      { json: { nothing: true } },
      { fail: elvError('network', 'timeout') },
      { text: '', status: 401 },
    ];
    for (const reply of routes) {
      const { c } = client(() => reply);
      const calls: Array<(x: XtreamClient) => Promise<Result<unknown>>> = [
        (x) => x.account(),
        (x) => x.liveStreams(),
        (x) => x.seriesInfo(1),
        (x) => x.shortEpg(1),
      ];
      for (const call of calls) {
        const text = JSON.stringify(await call(c));
        expect(text).not.toContain(PASS);
        expect(text).not.toContain(encodeURIComponent(PASS));
        expect(text).not.toContain('player_api');
        expect(text).not.toContain('h.example');
      }
    }
  });
});
