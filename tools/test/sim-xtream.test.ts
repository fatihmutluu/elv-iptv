import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/sim/accounts.ts';
import { buildCatalog } from '../src/sim/catalog.ts';
import { type ApiContext, playerApi } from '../src/sim/xtream.ts';

const NOW = new Date('2026-01-01T12:34:56Z');
const ctx: ApiContext = { baseUrl: 'http://127.0.0.1:8080', now: NOW, seed: 1 };

type Obj = Record<string, unknown>;

function call(user: string, params: Record<string, string> = {}) {
  const account = ACCOUNTS.find((a) => a.username === user);
  const query = new URLSearchParams({
    username: account?.username ?? user,
    password: account?.password ?? 'x',
    ...params,
  });
  return playerApi(query, ctx);
}
const list = (user: string, action: string, extra: Record<string, string> = {}): Obj[] =>
  call(user, { action, ...extra }).body as Obj[];
const decode = (v: unknown) => Buffer.from(String(v), 'base64').toString('utf8');

describe('playerApi', () => {
  it('answers auth failure with status 200 and auth 0', () => {
    for (const query of [
      new URLSearchParams({ username: 'demo', password: 'wrong' }),
      new URLSearchParams(),
    ]) {
      expect(playerApi(query, ctx)).toEqual({ status: 200, body: { user_info: { auth: 0 } } });
    }
  });

  it('returns account info and server info', () => {
    const { status, body } = call('demo');
    const { user_info: u, server_info: s } = body as { user_info: Obj; server_info: Obj };
    expect(status).toBe(200);
    expect(u).toMatchObject({
      username: 'demo',
      password: 'demo',
      auth: 1,
      status: 'Active',
      is_trial: '0',
      active_cons: '0',
      max_connections: '1',
      allowed_output_formats: ['m3u8', 'ts'],
    });
    expect(u.exp_date).toBeDefined();
    expect(u.created_at).toBeDefined();
    expect(s).toMatchObject({
      url: '127.0.0.1',
      port: '8080',
      server_protocol: 'http',
      timezone: 'UTC',
      timestamp_now: Math.floor(NOW.getTime() / 1000),
      time_now: '2026-01-01 12:34:56',
    });
    expect(s).toHaveProperty('https_port');
    expect(s).toHaveProperty('rtmp_port');
  });

  it('reports the expired account as Expired', () => {
    const { user_info: u } = call('expired').body as { user_info: Obj };
    expect(u.status).toBe('Expired');
    expect(Number(u.exp_date)).toBeLessThan(NOW.getTime() / 1000);
  });

  it('lists categories per kind', () => {
    const catalog = buildCatalog('small', 1);
    for (const [action, kind] of [
      ['get_live_categories', 'live'],
      ['get_vod_categories', 'vod'],
      ['get_series_categories', 'series'],
    ] as const) {
      const expected = catalog.categories
        .filter((c) => c.kind === kind)
        .map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }));
      expect(list('demo', action)).toEqual(expected);
    }
  });

  it('lists live streams and filters by category', () => {
    const all = list('demo', 'get_live_streams');
    expect(all).toHaveLength(50);
    expect(all[0]).toMatchObject({
      num: 1,
      name: 'Channel 0001',
      stream_type: 'live',
      stream_id: 1001,
      stream_icon: 'http://127.0.0.1:8080/logos/9.png',
      epg_channel_id: 'ch1001',
      category_id: '1',
      custom_sid: '',
      tv_archive: 0,
      direct_source: '',
      tv_archive_duration: 0,
    });
    expect(all[0]).toHaveProperty('added');
    expect(all.find((s) => s.epg_channel_id === '')).toBeDefined();
    const filtered = list('demo', 'get_live_streams', { category_id: '2' });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((s) => s.category_id === '2')).toBe(true);
  });

  it('flags catch-up channels', () => {
    const withArchive = list('compat', 'get_live_streams').filter((s) => s.tv_archive === 1);
    expect(withArchive.length).toBeGreaterThan(0);
    expect(withArchive.every((s) => s.tv_archive_duration === 3)).toBe(true);
  });

  it('lists vod streams and series', () => {
    const vod = list('demo', 'get_vod_streams');
    expect(vod).toHaveLength(30);
    expect(vod[0]).toMatchObject({
      stream_type: 'movie',
      stream_id: 200001,
      name: 'Movie 0001',
      category_id: '10001',
      container_extension: 'mp4',
    });
    for (const k of ['stream_icon', 'rating', 'added']) expect(vod[0]).toHaveProperty(k);
    const filtered = list('demo', 'get_vod_streams', { category_id: '10002' });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((v) => v.category_id === '10002')).toBe(true);
    const series = list('demo', 'get_series');
    expect(series).toHaveLength(5);
    expect(series[0]).toMatchObject({
      series_id: 300001,
      name: 'Series 0001',
      category_id: '20001',
    });
    for (const k of ['cover', 'plot', 'last_modified']) expect(series[0]).toHaveProperty(k);
  });

  it('returns vod info and an empty shape for unknown ids', () => {
    const { info, movie_data } = call('demo', {
      action: 'get_vod_info',
      vod_id: '200001',
    }).body as { info: Obj; movie_data: Obj };
    const movie = buildCatalog('small', 1).movies[0];
    expect(info).toMatchObject({ name: 'Movie 0001', duration_secs: movie?.durationSec });
    expect(info).toHaveProperty('duration');
    expect(info).toHaveProperty('plot');
    expect(movie_data).toMatchObject({
      stream_id: 200001,
      name: 'Movie 0001',
      category_id: '10001',
      container_extension: 'mp4',
    });
    expect(movie_data).toHaveProperty('added');
    expect(call('demo', { action: 'get_vod_info', vod_id: '1' }).body).toEqual({
      info: [],
      movie_data: [],
    });
  });

  it('returns series info keyed by season', () => {
    const body = call('demo', { action: 'get_series_info', series_id: '300001' }).body as {
      seasons: Obj[];
      info: Obj;
      episodes: Record<string, Obj[]>;
    };
    expect(body.seasons).toHaveLength(2);
    expect(body.info).toMatchObject({ name: 'Series 0001' });
    expect(Object.keys(body.episodes)).toEqual(['1', '2']);
    const ep = body.episodes['1']?.[0] as Obj;
    expect(ep).toMatchObject({
      id: '400001',
      episode_num: 1,
      title: 'Series 0001 S01E01',
      container_extension: 'mp4',
      season: 1,
    });
    expect((ep.info as Obj).duration_secs).toBeGreaterThan(0);
  });

  it('returns a short epg starting with the programme airing now', () => {
    const { epg_listings: l } = call('demo', {
      action: 'get_short_epg',
      stream_id: '1001',
      limit: '4',
    }).body as { epg_listings: Obj[] };
    expect(l).toHaveLength(4);
    const first = l[0] as Obj;
    const nowSec = NOW.getTime() / 1000;
    expect(Number(first.start_timestamp)).toBeLessThanOrEqual(nowSec);
    expect(Number(first.stop_timestamp)).toBeGreaterThan(nowSec);
    expect(first).toMatchObject({ lang: 'en', channel_id: 'ch1001' });
    expect(decode(first.title)).toMatch(/^Programme \d+$/);
    expect(decode(first.description)).toContain('ch1001');
    for (const k of ['id', 'epg_id', 'start', 'end']) expect(first).toHaveProperty(k);
    expect(l[1]?.start_timestamp).toBe(first.stop_timestamp);
  });

  it('returns an empty short epg for channels without a guide', () => {
    const { epg_listings: l } = call('demo', { action: 'get_short_epg', stream_id: '1010' })
      .body as { epg_listings: Obj[] };
    expect(l).toEqual([]);
  });

  it('returns the whole window in the simple data table', () => {
    const { epg_listings: l } = call('compat', {
      action: 'get_simple_data_table',
      stream_id: '1001',
    }).body as { epg_listings: Obj[] };
    expect(l.length).toBeGreaterThan(100);
    expect(l.filter((e) => e.now_playing === 1)).toHaveLength(1);
    expect(l.every((e) => e.has_archive === 0 || e.has_archive === 1)).toBe(true);
  });

  it('reproduces provider quirks only on the quirks account', () => {
    const live = list('quirks', 'get_live_streams');
    expect(live.every((s) => typeof s.stream_id === 'string' && typeof s.num === 'string')).toBe(
      true,
    );
    expect(live.some((s) => s.stream_icon === null)).toBe(true);
    expect(live.some((s) => String(s.name).includes('&amp;'))).toBe(true);
    const cats = new Set(list('quirks', 'get_live_categories').map((c) => c.category_id));
    expect(live.some((s) => !cats.has(s.category_id as string))).toBe(true);
    const ids = live.map((s) => s.stream_id);
    expect(new Set(ids).size).toBeLessThan(ids.length);
    const plain = list('demo', 'get_live_streams');
    expect(new Set(plain.map((s) => s.stream_id)).size).toBe(plain.length);
    expect(plain.some((s) => s.stream_icon === null)).toBe(false);
  });

  it('answers an unknown action with an empty list', () => {
    expect(call('demo', { action: 'nope' })).toEqual({ status: 200, body: [] });
  });

  it('is deterministic', () => {
    expect(call('demo', { action: 'get_vod_streams' })).toEqual(
      call('demo', { action: 'get_vod_streams' }),
    );
  });
});
