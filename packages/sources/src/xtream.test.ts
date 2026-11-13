import { elvError, type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient } from './xtream';
import { action, client, expectErr, PASS, USER, value } from './xtream-test-helpers';

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
    expectErr(await client(() => ({ text: '', status: 401 })).c.account(), 'auth', 'http-401');
    expectErr(await client(() => ({ text: '', status: 403 })).c.account(), 'auth', 'http-403');
    expectErr(await client(() => ({ text: '', status: 503 })).c.account(), 'network', 'http-503');
    expectErr(await client(() => ({ text: '', status: 404 })).c.account(), 'network', 'http-404');
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

describe('empty objects as empty lists', () => {
  it('accepts {} for every list endpoint and rejects a non-empty object', async () => {
    const { c } = client(() => ({ json: {} }));
    expect(value(await c.categories('live'))).toEqual([]);
    expect(value(await c.liveStreams())).toEqual([]);
    expect(value(await c.vodStreams())).toEqual([]);
    expect(value(await c.series())).toEqual([]);
    expectErr(
      await client(() => ({ json: { a: 1 } })).c.series(),
      'source-format',
      'unexpected-shape',
    );
  });
});
