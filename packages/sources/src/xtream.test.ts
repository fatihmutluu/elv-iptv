import { elvError, type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { normalizeProviderImdbId, normalizeProviderTmdbId } from './index';
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

  it('falls back across empty action, get_account_info, and get_profile when earlier actions fail with 4xx/5xx or omit user_info (XC-2)', async () => {
    const seen: (string | null)[] = [];
    const { c } = client((url) => {
      const act = action(url);
      seen.push(act);
      if (act === null) return { text: '', status: 404 };
      if (act === 'get_account_info') return { json: { server_info: {} } };
      return {
        json: {
          user_info: { auth: 1, status: 'active', exp_date: '0' },
          server_info: { timezone: 'UTC+3' },
        },
      };
    });
    const acc = value(await c.account());
    expect(seen).toEqual([null, 'get_account_info', 'get_profile']);
    expect(acc).toEqual({
      status: 'Active',
      isTrial: false,
      outputFormats: [],
      serverTimezone: 'UTC+03:00',
    });

    // Rejects auth=false and expired exp_date immediately without probing later actions
    const seenAuth: (string | null)[] = [];
    const { c: expiredClient } = client((url) => {
      seenAuth.push(action(url));
      return {
        json: { user_info: { auth: 1, status: 'Active', exp_date: '1600000000' } },
      };
    });
    expectErr(await expiredClient.account(), 'auth', 'account-expired');
    expect(seenAuth).toEqual([null]);
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
          stream_icon: 'http://img.example/x.png',
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
        icon: 'http://img.example/x.png',
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
          cover: 'http://img.example/c.png',
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
      cover: 'http://img.example/c.png',
      plot: 'P <',
      rating: 8,
      year: 2019,
      lastModified: 1700000001000,
    });
    expect(list.map((s) => s.year)).toEqual([2019, 2018, 2001, undefined]);
    expect(action(requests[0]?.url ?? '')).toBe('get_series');
  });

  it('extracts and bounds cast (or actors) and director on movies and series (#397)', async () => {
    const longCast = `${'A'.repeat(510)}   ${'B'.repeat(40)}`;
    const longDirector = `${'D'.repeat(255)}   ${'E'.repeat(30)}`;
    const movies = value(
      await client(() => ({
        json: [
          {
            stream_id: 1,
            name: 'Movie 1',
            category_id: '1',
            cast: '  Haluk Bilginer &amp; Cansu Dere ',
            director: ' Nuri Bilge Ceylan ',
          },
          {
            stream_id: 2,
            name: 'Movie 2',
            category_id: '1',
            cast: '   ',
            actors: [' Kıvanç Tatlıtuğ ', '', ' Serenay Sarıkaya '],
            director: ['Çağan Irmak', '  '],
          },
          {
            stream_id: 3,
            name: 'Movie 3',
            category_id: '1',
            cast: longCast,
            director: longDirector,
          },
        ],
      })).c.vodStreams(),
    );
    expect(movies[0]?.cast).toBe('Haluk Bilginer & Cansu Dere');
    expect(movies[0]?.director).toBe('Nuri Bilge Ceylan');
    expect(movies[1]?.cast).toBe('Kıvanç Tatlıtuğ, Serenay Sarıkaya');
    expect(movies[1]?.director).toBe('Çağan Irmak');
    expect(movies[2]?.cast?.length).toBe(510);
    expect(movies[2]?.director?.length).toBe(255);

    const series = value(
      await client(() => ({
        json: [
          {
            series_id: 10,
            name: 'Series 1',
            category_id: '1',
            actors: 'Aras Bulut İynemli, Erkan Kolçak Köstendil',
            director: 'Sinan Öztürk',
          },
          {
            series_id: 11,
            name: 'Series 2',
            category_id: '1',
            cast: ['Demet Evgar', 'Buğra Gülsoy'],
          },
        ],
      })).c.series(),
    );
    expect(series[0]?.cast).toBe('Aras Bulut İynemli, Erkan Kolçak Köstendil');
    expect(series[0]?.director).toBe('Sinan Öztürk');
    expect(series[1]?.cast).toBe('Demet Evgar, Buğra Gülsoy');
    expect(series[1]?.director).toBeUndefined();
  });

  it('rejects unsafe and relative artwork URLs in live stream_icon, movie stream_icon, and series cover (#428)', async () => {
    const liveRes = value(
      await client(() => ({
        json: [
          { stream_id: 1, name: 'A', stream_icon: 'javascript:alert(1)' },
          { stream_id: 2, name: 'B', stream_icon: 'file:///etc/passwd' },
          { stream_id: 3, name: 'C', stream_icon: 'data:image/svg+xml,<svg/>' },
          { stream_id: 4, name: 'D', stream_icon: 'data:image/png;base64,AAAA' },
        ],
      })).c.liveStreams(),
    );
    expect(liveRes.map((l) => l.icon)).toEqual([
      undefined,
      undefined,
      undefined,
      'data:image/png;base64,AAAA',
    ]);

    const movieRes = value(
      await client(() => ({
        json: [
          { stream_id: 1, name: 'M1', stream_icon: '//cdn.example/poster.jpg' },
          { stream_id: 2, name: 'M2', stream_icon: 'https://cdn.example/poster.jpg' },
        ],
      })).c.vodStreams(),
    );
    expect(movieRes.map((m) => m.icon)).toEqual([undefined, 'https://cdn.example/poster.jpg']);

    const seriesRes = value(
      await client(() => ({
        json: [
          { series_id: 1, name: 'S1', cover: 'relative/cover.png' },
          { series_id: 2, name: 'S2', cover: 'ftp://cdn.example/cover.png' },
          { series_id: 3, name: 'S3', cover: 'http://cdn.example/cover.png' },
        ],
      })).c.series(),
    );
    expect(seriesRes.map((s) => s.cover)).toEqual([
      undefined,
      undefined,
      'http://cdn.example/cover.png',
    ]);
  });

  it('extracts backdrop from backdrop_path (string or string[]) or explicit backdrop on movies and series without vertical cover fallback', async () => {
    const movies = value(
      await client(() => ({
        json: [
          {
            stream_id: 1,
            name: 'Movie Array BG',
            category_id: '1',
            stream_icon: 'https://cdn.example/vertical1.jpg',
            backdrop_path: [
              '',
              'javascript:bad()',
              'https://cdn.example/m1-bg.jpg',
              'https://cdn.example/m1-bg2.jpg',
            ],
          },
          {
            stream_id: 2,
            name: 'Movie String BG',
            category_id: '1',
            backdrop: 'https://cdn.example/m2-bg.jpg',
          },
          {
            stream_id: 3,
            name: 'Movie No BG',
            category_id: '1',
            stream_icon: 'https://cdn.example/vertical3.jpg',
            movie_image: 'https://cdn.example/vertical3b.jpg',
          },
        ],
      })).c.vodStreams(),
    );
    expect(movies[0]?.backdrop).toBe('https://cdn.example/m1-bg.jpg');
    expect(movies[1]?.backdrop).toBe('https://cdn.example/m2-bg.jpg');
    expect(movies[2]?.backdrop).toBeUndefined();

    const seriesList = value(
      await client(() => ({
        json: [
          {
            series_id: 10,
            name: 'Series String BG',
            category_id: '2',
            cover: 'https://cdn.example/s10-cover.jpg',
            backdrop_path: 'https://cdn.example/s10-bg.jpg',
          },
          {
            series_id: 11,
            name: 'Series Array BG',
            category_id: '2',
            backdrop_path: ['ftp://bad.example/bg.jpg', 'http://cdn.example/s11-bg.jpg'],
          },
          {
            series_id: 12,
            name: 'Series Cover Only',
            category_id: '2',
            cover: 'https://cdn.example/s12-cover.jpg',
          },
        ],
      })).c.series(),
    );
    expect(seriesList[0]?.backdrop).toBe('https://cdn.example/s10-bg.jpg');
    expect(seriesList[1]?.backdrop).toBe('http://cdn.example/s11-bg.jpg');
    expect(seriesList[2]?.backdrop).toBeUndefined();
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

describe('simpleEpg (#306)', () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  it('calls get_simple_data_table, decodes base64, preserves has_archive/now_playing, and applies activeTimezone', async () => {
    const { c, requests } = client((url) => {
      if (!url.includes('action=')) {
        return {
          json: {
            user_info: { auth: 1, status: 'Active' },
            server_info: { timezone: 'Europe/Istanbul' },
          },
        };
      }
      return {
        json: {
          epg_listings: [
            {
              title: b64('Haber Bülteni'),
              description: b64('Canlı yayın'),
              start: '2026-06-01 20:00:00',
              end: '2026-06-01 21:00:00',
              has_archive: 1,
              now_playing: 0,
            },
            {
              title: b64('Gece Spor'),
              start_timestamp: '1780336800',
              stop_timestamp: '1780340400',
              has_archive: '0',
              now_playing: '1',
            },
          ],
        },
      };
    });

    await c.account();
    const list = value(await c.simpleEpg(42));
    expect(requests[1]?.url).toContain('action=get_simple_data_table&stream_id=42');
    expect(list).toEqual([
      {
        start: Date.UTC(2026, 5, 1, 17, 0, 0),
        stop: Date.UTC(2026, 5, 1, 18, 0, 0),
        title: 'Haber Bülteni',
        desc: 'Canlı yayın',
        hasArchive: true,
        nowPlaying: false,
      },
      {
        start: 1780336800000,
        stop: 1780340400000,
        title: 'Gece Spor',
        hasArchive: false,
        nowPlaying: true,
      },
    ]);
  });

  it('handles empty payloads, aborts, and mirror failover through the shared pipeline', async () => {
    expect(value(await client(() => ({ json: {} })).c.simpleEpg(1))).toEqual([]);
    expect(value(await client(() => ({ json: [] })).c.simpleEpg(1))).toEqual([]);

    const ac = new AbortController();
    ac.abort();
    expectErr(
      await client(() => ({ json: {} })).c.simpleEpg(1, { signal: ac.signal }),
      'network',
      'aborted',
    );

    const { c: failoverClient, requests } = client(
      (url) => {
        if (url.startsWith('http://h.example:8080/')) return { text: '', status: 503 };
        return {
          json: {
            epg_listings: [
              {
                title: b64('Mirror EPG'),
                start_timestamp: 100,
                stop_timestamp: 200,
                has_archive: 1,
              },
            ],
          },
        };
      },
      { backupServers: ['http://backup.example:8080'] },
    );
    const entries = value(await failoverClient.simpleEpg(9));
    expect(entries).toEqual([
      { start: 100_000, stop: 200_000, title: 'Mirror EPG', hasArchive: true },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain('http://backup.example:8080/player_api.php');
  });

  it('falls back once to get_simple_date_table on 404/405/501 or empty array without swallowing non-404 errors (XC-4)', async () => {
    const actions1: (string | null)[] = [];
    const { c: c404 } = client((url) => {
      const act = action(url);
      actions1.push(act);
      if (act === 'get_simple_data_table') return { text: '', status: 404 };
      return {
        json: {
          epg_listings: [{ title: b64('Typo Table'), start_timestamp: 100, stop_timestamp: 200 }],
        },
      };
    });
    expect(value(await c404.simpleEpg(12))).toEqual([
      { start: 100_000, stop: 200_000, title: 'Typo Table' },
    ]);
    expect(actions1).toEqual(['get_simple_data_table', 'get_simple_date_table']);

    const actions2: (string | null)[] = [];
    const { c: cEmpty } = client((url) => {
      const act = action(url);
      actions2.push(act);
      if (act === 'get_simple_data_table') return { json: { epg_listings: [] } };
      return {
        json: {
          epg_listings: [
            { title: b64('From Date Table'), start_timestamp: 300, stop_timestamp: 400 },
          ],
        },
      };
    });
    expect(value(await cEmpty.simpleEpg(12))).toEqual([
      { start: 300_000, stop: 400_000, title: 'From Date Table' },
    ]);
    expect(actions2).toEqual(['get_simple_data_table', 'get_simple_date_table']);

    const actions3: (string | null)[] = [];
    const { c: c500 } = client((url) => {
      actions3.push(action(url));
      return { text: '', status: 500 };
    });
    expectErr(await c500.simpleEpg(12), 'network', 'http-500');
    expect(actions3).toEqual(['get_simple_data_table']);
  });
});

describe('provider imdb_id & tmdb_id extraction (#511)', () => {
  it('validates and normalizes provider IMDb and TMDB IDs while rejecting garbage and injection', () => {
    expect(normalizeProviderImdbId('tt1375666')).toBe('tt1375666');
    expect(normalizeProviderImdbId('  TT0133093  ')).toBe('tt0133093');
    expect(normalizeProviderImdbId('tt12345')).toBe('tt12345');
    expect(normalizeProviderImdbId('tt1234567890')).toBe('tt1234567890');
    expect(normalizeProviderImdbId('tt1234')).toBeNull();
    expect(normalizeProviderImdbId('tt12345678901')).toBeNull();
    expect(normalizeProviderImdbId('nm1234567')).toBeNull();
    expect(normalizeProviderImdbId("tt1375666'; DROP TABLE items;--")).toBeNull();
    expect(normalizeProviderImdbId(1375666)).toBeNull();
    expect(normalizeProviderImdbId(null)).toBeNull();
    expect(normalizeProviderImdbId('')).toBeNull();

    expect(normalizeProviderTmdbId(27205)).toBe('27205');
    expect(normalizeProviderTmdbId('27205')).toBe('27205');
    expect(normalizeProviderTmdbId('  603  ')).toBe('603');
    expect(normalizeProviderTmdbId(0)).toBeNull();
    expect(normalizeProviderTmdbId('0')).toBeNull();
    expect(normalizeProviderTmdbId('0000')).toBeNull();
    expect(normalizeProviderTmdbId(-42)).toBeNull();
    expect(normalizeProviderTmdbId(12.5)).toBeNull();
    expect(normalizeProviderTmdbId('12345678901')).toBeNull();
    expect(normalizeProviderTmdbId('27205 OR 1=1')).toBeNull();
    expect(normalizeProviderTmdbId('abc')).toBeNull();
    expect(normalizeProviderTmdbId(null)).toBeNull();
  });

  it('extracts providerImdbId and providerTmdbId on Xtream movies, series, and vodInfo', async () => {
    const movies = value(
      await client(() => ({
        json: [
          {
            stream_id: 1,
            name: 'Inception',
            category_id: '1',
            imdb_id: 'TT1375666',
            tmdb: 27205,
          },
          {
            stream_id: 2,
            name: 'Matrix',
            category_id: '1',
            imdb: 'tt0133093',
            tmdb_id: '603',
          },
          {
            stream_id: 3,
            name: 'Garbage IDs',
            category_id: '1',
            imdb_id: "tt123'; DROP TABLE--",
            tmdb: 0,
          },
        ],
      })).c.vodStreams(),
    );
    expect(movies[0]?.providerImdbId).toBe('tt1375666');
    expect(movies[0]?.providerTmdbId).toBe('27205');
    expect(movies[1]?.providerImdbId).toBe('tt0133093');
    expect(movies[1]?.providerTmdbId).toBe('603');
    expect(movies[2]?.providerImdbId).toBeUndefined();
    expect(movies[2]?.providerTmdbId).toBeUndefined();

    const series = value(
      await client(() => ({
        json: [
          {
            series_id: 10,
            name: 'Breaking Bad',
            category_id: '1',
            imdb_id: 'tt0903747',
            tmdb: 1396,
          },
          {
            series_id: 11,
            name: 'Dark',
            category_id: '1',
            imdb: 'TT5753856',
            tmdb_id: '70523',
          },
          {
            series_id: 12,
            name: 'Invalid',
            category_id: '1',
            imdb_id: 'not-an-id',
            tmdb_id: '0',
          },
        ],
      })).c.series(),
    );
    expect(series[0]?.providerImdbId).toBe('tt0903747');
    expect(series[0]?.providerTmdbId).toBe('1396');
    expect(series[1]?.providerImdbId).toBe('tt5753856');
    expect(series[1]?.providerTmdbId).toBe('70523');
    expect(series[2]?.providerImdbId).toBeUndefined();
    expect(series[2]?.providerTmdbId).toBeUndefined();

    const vodInfo = value(
      await client(() => ({
        json: {
          info: {
            imdb_id: 'tt0468569',
            tmdb_id: 155,
          },
          movie_data: { container_extension: 'mkv' },
        },
      })).c.vodInfo(1),
    );
    expect(vodInfo.providerImdbId).toBe('tt0468569');
    expect(vodInfo.providerTmdbId).toBe('155');

    const vodInfoAlt = value(
      await client(() => ({
        json: {
          info: {
            tmdb: '157336',
          },
          movie_data: { container_extension: 'mp4' },
        },
      })).c.vodInfo(2),
    );
    expect(vodInfoAlt.providerImdbId).toBeUndefined();
    expect(vodInfoAlt.providerTmdbId).toBe('157336');
  });
});
