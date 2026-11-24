import { afterEach, describe, expect, it } from 'vitest';
import { type LogEntry, redact } from '../src/sim/log.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';
import { resolveStalkerAccount, StalkerSessionStore, stalkerApi } from '../src/sim/stalker.ts';

const CLOCK = new Date('2026-01-01T12:00:00Z');
const DEMO_MAC = '00:1A:79:00:00:01';
const EXPIRED_MAC = '00:1A:79:00:00:02';
const REJECTED_MAC = '00:1A:79:00:00:99';
const FLEX_MAC = '00:1A:79:AA:BB:42';

const open: SimHandle[] = [];

async function sim(): Promise<SimHandle> {
  const handle = await startSim({ port: 0, clock: CLOCK, ffmpegPath: null });
  open.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

function macCookie(mac: string, encoded = true): string {
  const value = encoded ? encodeURIComponent(mac) : mac;
  return `mac=${value}; stb_lang=en; timezone=UTC`;
}

async function handshake(
  baseUrl: string,
  portalPath: string,
  mac = DEMO_MAC,
  extra = '',
): Promise<{ status: number; token: string; random: string }> {
  const suffix = extra ? `&${extra}` : '';
  const res = await fetch(`${baseUrl}${portalPath}?type=stb&action=handshake${suffix}`, {
    headers: { cookie: macCookie(mac) },
  });
  if (res.status !== 200) {
    return { status: res.status, token: '', random: '' };
  }
  const body = (await res.json()) as { js: { token: string; random: string } };
  return { status: res.status, token: body.js.token, random: body.js.random };
}

describe('stalker MAC mapping & unit protocol', () => {
  it('maps known synthetic MACs and rejects unauthorized or malformed MACs', () => {
    expect(resolveStalkerAccount(DEMO_MAC)?.username).toBe('demo');
    expect(resolveStalkerAccount(DEMO_MAC.toLowerCase())?.username).toBe('demo');
    expect(resolveStalkerAccount(EXPIRED_MAC)?.username).toBe('expired');
    expect(resolveStalkerAccount(FLEX_MAC)?.username).toBe('demo');
    expect(resolveStalkerAccount(REJECTED_MAC)).toBeUndefined();
    expect(resolveStalkerAccount('00:1A:79:12:34:56')).toBeUndefined();
    expect(resolveStalkerAccount('not-a-mac')).toBeUndefined();
    expect(resolveStalkerAccount(null)).toBeUndefined();
  });

  it('produces deterministic tokens per MAC and rejects unauthenticated requests', () => {
    const storeA = new StalkerSessionStore();
    const storeB = new StalkerSessionStore();
    const ctx = { baseUrl: 'http://127.0.0.1:7878', now: CLOCK, seed: 1 };

    const a = stalkerApi(
      new URLSearchParams({ type: 'stb', action: 'handshake' }),
      { cookie: macCookie(DEMO_MAC) },
      ctx,
      storeA,
    );
    const b = stalkerApi(
      new URLSearchParams({ type: 'stb', action: 'handshake' }),
      { cookie: macCookie(DEMO_MAC) },
      ctx,
      storeB,
    );
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);

    const noAuth = stalkerApi(
      new URLSearchParams({ type: 'stb', action: 'get_profile' }),
      { cookie: macCookie(DEMO_MAC) },
      ctx,
      storeA,
    );
    expect(noAuth.status).toBe(401);
  });
});

describe('stalker HTTP routes', () => {
  it('serves handshake, profile, and genres on both /portal.php and /stalker_portal/server/load.php', async () => {
    const { url } = await sim();

    for (const portalPath of ['/portal.php', '/stalker_portal/server/load.php']) {
      const hs = await handshake(url, portalPath, DEMO_MAC);
      expect(hs.status, portalPath).toBe(200);
      expect(hs.token.length).toBeGreaterThan(8);
      expect(hs.random).toBe('123456');

      const profileRes = await fetch(`${url}${portalPath}?type=stb&action=get_profile`, {
        headers: {
          cookie: macCookie(DEMO_MAC),
          authorization: `Bearer ${hs.token}`,
        },
      });
      expect(profileRes.status).toBe(200);
      const profile = (await profileRes.json()) as { js: Record<string, unknown> };
      expect(profile.js).toMatchObject({
        id: '1',
        status: 0,
        blocked: '0',
        default_timezone: 'UTC',
        max_online: 1,
      });
      expect(String(profile.js.expire_billing_date)).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      );

      const genresRes = await fetch(`${url}${portalPath}?type=itv&action=get_genres`, {
        headers: { authorization: `Bearer ${hs.token}` },
      });
      expect(genresRes.status).toBe(200);
      const genres = (await genresRes.json()) as { js: Array<{ id: string; title: string }> };
      expect(genres.js[0]).toEqual({ id: '*', title: 'All' });
      expect(genres.js.length).toBe(5); // All + 4 live categories in small profile
    }
  });

  it('enforces MAC rejection, expired profile blocked flag, and Bearer auth', async () => {
    const { url } = await sim();

    const rejected = await handshake(url, '/portal.php', REJECTED_MAC);
    expect(rejected.status).toBe(401);

    const missingCookie = await fetch(`${url}/portal.php?type=stb&action=handshake`);
    expect(missingCookie.status).toBe(401);

    const expiredHs = await handshake(url, '/portal.php', EXPIRED_MAC);
    expect(expiredHs.status).toBe(200);
    const expiredProfile = (await (
      await fetch(`${url}/portal.php?type=stb&action=get_profile`, {
        headers: { authorization: `Bearer ${expiredHs.token}` },
      })
    ).json()) as { js: Record<string, unknown> };
    expect(expiredProfile.js.blocked).toBe('1');
    expect(String(expiredProfile.js.expire_billing_date)).toBe('2025-12-31 12:00:00');

    const badBearer = await fetch(`${url}/portal.php?type=itv&action=get_genres`, {
      headers: { authorization: 'Bearer bogus-token' },
    });
    expect(badBearer.status).toBe(401);

    const flexHs = await handshake(url, '/portal.php', FLEX_MAC);
    expect(flexHs.status).toBe(200);
  });

  it('supports sim_expire_once=1 and runtime fault rules for re-handshake testing', async () => {
    const { url } = await sim();

    const hs1 = await handshake(url, '/portal.php', DEMO_MAC, 'sim_expire_once=1');
    expect(hs1.status).toBe(200);

    // First authenticated call fails with 401 and invalidates the token
    const expiredCall = await fetch(`${url}/portal.php?type=stb&action=get_profile`, {
      headers: { authorization: `Bearer ${hs1.token}` },
    });
    expect(expiredCall.status).toBe(401);

    // Client re-handshakes and gets a working token
    const hs2 = await handshake(url, '/portal.php', DEMO_MAC);
    expect(hs2.status).toBe(200);
    expect(hs2.token).not.toBe(hs1.token);

    const okCall = await fetch(`${url}/portal.php?type=stb&action=get_profile`, {
      headers: { authorization: `Bearer ${hs2.token}` },
    });
    expect(okCall.status).toBe(200);

    // Runtime fault rule expires once on next authenticated request
    const addRule = await fetch(`${url}/_sim/faults`, {
      method: 'POST',
      body: JSON.stringify({ account: 'demo', stream: '*', spec: 'status=401', count: 1 }),
    });
    expect(addRule.status).toBe(201);

    const faulted = await fetch(`${url}/portal.php?type=itv&action=get_genres`, {
      headers: { authorization: `Bearer ${hs2.token}` },
    });
    expect(faulted.status).toBe(401);

    const recovered = await fetch(`${url}/portal.php?type=itv&action=get_genres`, {
      headers: { authorization: `Bearer ${hs2.token}` },
    });
    expect(recovered.status).toBe(200);
  });

  it('serves live get_all_channels and paginated get_ordered_list with genre filtering', async () => {
    const { url } = await sim();
    const { token } = await handshake(url, '/portal.php');
    const auth = { authorization: `Bearer ${token}` };

    const allRes = await fetch(`${url}/portal.php?type=itv&action=get_all_channels`, {
      headers: auth,
    });
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as {
      js: { total_items: number; data: Array<Record<string, unknown>> };
    };
    expect(all.js.total_items).toBe(50);
    expect(all.js.data).toHaveLength(50);
    expect(all.js.data[0]).toMatchObject({
      id: '1001',
      number: '1',
      name: 'Channel 0001',
      tv_genre_id: '1',
      cmd: 'ffrt http://localhost/ch/1001',
      enable_tv_archive: 0,
      tv_archive_duration: 0,
    });
    expect(all.js.data[0]?.logo).toBe(`${url}/logos/9.png`);

    const p1 = (await (
      await fetch(`${url}/portal.php?type=itv&action=get_ordered_list&genre=*&p=1`, {
        headers: auth,
      })
    ).json()) as { js: { total_items: number; max_page_items: number; data: unknown[] } };
    expect(p1.js.total_items).toBe(50);
    expect(p1.js.max_page_items).toBe(14);
    expect(p1.js.data).toHaveLength(14);

    const p4 = (await (
      await fetch(`${url}/portal.php?type=itv&action=get_ordered_list&genre=*&p=4`, {
        headers: auth,
      })
    ).json()) as { js: { data: unknown[] } };
    expect(p4.js.data).toHaveLength(8); // 50 - 3*14 = 8

    const byGenre = (await (
      await fetch(`${url}/portal.php?type=itv&action=get_ordered_list&genre=2&p=1`, {
        headers: auth,
      })
    ).json()) as { js: { total_items: number; data: Array<{ tv_genre_id: string }> } };
    expect(byGenre.js.total_items).toBe(13);
    expect(byGenre.js.data.every((c) => c.tv_genre_id === '2')).toBe(true);
  });

  it('serves VOD categories and paginated movies', async () => {
    const { url } = await sim();
    const { token } = await handshake(url, '/portal.php');
    const auth = { authorization: `Bearer ${token}` };

    const cats = (await (
      await fetch(`${url}/portal.php?type=vod&action=get_categories`, { headers: auth })
    ).json()) as { js: Array<{ id: string; title: string }> };
    expect(cats.js[0]).toEqual({ id: '*', title: 'All' });
    expect(cats.js.length).toBe(4); // All + 3 vod categories

    const page1 = (await (
      await fetch(`${url}/portal.php?type=vod&action=get_ordered_list&category=*&p=1`, {
        headers: auth,
      })
    ).json()) as {
      js: { total_items: number; max_page_items: number; data: Array<Record<string, unknown>> };
    };
    expect(page1.js.total_items).toBe(30);
    expect(page1.js.max_page_items).toBe(14);
    expect(page1.js.data).toHaveLength(14);
    expect(page1.js.data[0]).toMatchObject({
      id: '200001',
      name: 'Movie 0001',
      category_id: '10001',
      cmd: 'ffmpeg http://localhost/vod/200001',
    });
    expect(page1.js.data[0]?.screenshot_uri).toBe(`${url}/logos/1.png`);
    expect(page1.js.data[0]?.rating_imdb).toBeDefined();
    expect(page1.js.data[0]?.year).toBeDefined();
    expect(page1.js.data[0]?.description).toContain('Movie 0001');
    expect(page1.js.data[0]?.actors).toBeDefined();
    expect(page1.js.data[0]?.director).toBeDefined();
  });

  it('serves series categories, series list, seasons, and episodes', async () => {
    const { url } = await sim();
    const { token } = await handshake(url, '/portal.php');
    const auth = { authorization: `Bearer ${token}` };

    const cats = (await (
      await fetch(`${url}/portal.php?type=series&action=get_categories`, { headers: auth })
    ).json()) as { js: Array<{ id: string; title: string }> };
    expect(cats.js[0]).toEqual({ id: '*', title: 'All' });
    expect(cats.js.length).toBe(4); // All + 3 series categories

    const seriesList = (await (
      await fetch(`${url}/portal.php?type=series&action=get_ordered_list&category=*&p=1`, {
        headers: auth,
      })
    ).json()) as { js: { total_items: number; data: Array<Record<string, unknown>> } };
    expect(seriesList.js.total_items).toBe(5);
    const firstSeries = seriesList.js.data[0] as Record<string, unknown>;
    expect(firstSeries.id).toBe('300001');
    expect(firstSeries.name).toBe('Series 0001');

    const seasons = (await (
      await fetch(
        `${url}/portal.php?type=series&action=get_ordered_list&movie_id=${firstSeries.id}&p=1`,
        { headers: auth },
      )
    ).json()) as { js: { total_items: number; data: Array<Record<string, unknown>> } };
    expect(seasons.js.total_items).toBe(2);
    expect(seasons.js.data[0]).toMatchObject({
      id: '300001:1',
      season_number: 1,
      name: 'Season 1',
    });

    const episodes = (await (
      await fetch(
        `${url}/portal.php?type=series&action=get_ordered_list&movie_id=${firstSeries.id}&season_id=300001:1&p=1`,
        { headers: auth },
      )
    ).json()) as { js: { total_items: number; data: Array<Record<string, unknown>> } };
    expect(episodes.js.total_items).toBe(3);
    expect(episodes.js.data[0]).toMatchObject({
      id: '400001',
      season_number: 1,
      series_number: 1,
      name: 'Series 0001 S01E01',
      cmd: 'ffmpeg http://localhost/series/400001',
    });
  });

  it('serves get_epg_info and get_short_epg anchored to ctx.now()', async () => {
    const { url } = await sim();
    const { token } = await handshake(url, '/portal.php');
    const auth = { authorization: `Bearer ${token}` };

    const epgInfo = (await (
      await fetch(`${url}/portal.php?type=itv&action=get_epg_info&period=24`, { headers: auth })
    ).json()) as {
      js: { data: Record<string, Array<Record<string, unknown>>> };
    };
    const ch1001 = epgInfo.js.data['1001'];
    expect(ch1001).toBeDefined();
    expect(ch1001?.length).toBeGreaterThan(0);
    const first = ch1001?.[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      ch_id: '1001',
    });
    expect(typeof first.id).toBe('string');
    expect(typeof first.name).toBe('string');
    expect(typeof first.descr).toBe('string');
    expect(String(first.time)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(first.time_to)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Number(first.stop_timestamp)).toBeGreaterThan(Number(first.start_timestamp));

    const shortEpg = (await (
      await fetch(`${url}/portal.php?type=itv&action=get_short_epg&ch_id=1001&size=4`, {
        headers: auth,
      })
    ).json()) as { js: Array<Record<string, unknown>> };
    expect(shortEpg.js).toHaveLength(4);
    const nowSec = Math.floor(CLOCK.getTime() / 1000);
    expect(Number(shortEpg.js[0]?.stop_timestamp)).toBeGreaterThan(nowSec);
  });

  it('resolves create_link for live, vod, and series to real simulator media URLs', async () => {
    const { url } = await sim();
    const { token } = await handshake(url, '/stalker_portal/server/load.php');
    const auth = { authorization: `Bearer ${token}` };

    const liveLink = (await (
      await fetch(
        `${url}/stalker_portal/server/load.php?type=itv&action=create_link&cmd=${encodeURIComponent('ffrt http://localhost/ch/1001')}`,
        { headers: auth },
      )
    ).json()) as { js: { cmd: string } };
    expect(liveLink.js.cmd).toBe(`ffmpeg ${url}/live/demo/demo/1001.ts`);

    const vodLink = (await (
      await fetch(
        `${url}/stalker_portal/server/load.php?type=vod&action=create_link&cmd=${encodeURIComponent('ffmpeg http://localhost/vod/200001')}`,
        { headers: auth },
      )
    ).json()) as { js: { cmd: string } };
    expect(vodLink.js.cmd).toBe(`ffmpeg ${url}/movie/demo/demo/200001.mp4`);

    const seriesLink = (await (
      await fetch(
        `${url}/stalker_portal/server/load.php?type=series&action=create_link&cmd=${encodeURIComponent('ffmpeg http://localhost/series/400001')}`,
        { headers: auth },
      )
    ).json()) as { js: { cmd: string } };
    expect(seriesLink.js.cmd).toBe(`ffmpeg ${url}/series/demo/demo/400001.mp4`);

    // Verify the resolved URL hits the real simulator media route (503 because ffmpegPath: null in test, NOT 404/401)
    const targetUrl = vodLink.js.cmd.replace(/^ffmpeg\s+/, '');
    const mediaRes = await fetch(targetUrl);
    expect(mediaRes.status).toBe(503);
  });
});

describe('log.ts Stalker redaction', () => {
  it('redacts Stalker MAC cookies, MAC query params, and Authorization Bearer tokens', async () => {
    const raw: LogEntry = {
      t: CLOCK.toISOString(),
      method: 'GET',
      path: '/portal.php',
      query: {
        type: 'stb',
        action: 'handshake',
        mac: DEMO_MAC,
        sn: 'SN-UNIT-SECRET-99',
        cmd: 'ffmpeg http://secret.portal.test/ch/101?tok=abc',
      },
      headers: {
        cookie: `mac=${encodeURIComponent(DEMO_MAC)}; stb_lang=en`,
        authorization: 'Bearer sim-stalker-secret-token-1234',
        'x-extra': 'mac=00:1A:79:00:00:01 Bearer other-token',
      },
      status: 200,
      bytes: 42,
      ms: 1,
      account: 'demo',
      streamId: null,
      recipe: null,
      fault: null,
      faultRule: null,
      openConnections: 0,
    };
    const cleaned = redact(raw);
    expect(cleaned.query.mac).toBe('***');
    expect(cleaned.query.sn).toBe('***');
    expect(cleaned.query.cmd).toBe('***');
    expect(cleaned.headers.authorization).toBe('***');
    expect(cleaned.headers.cookie).toBe('mac=***; stb_lang=en');
    expect(cleaned.headers.cookie).not.toContain('00:1A:79');
    expect(cleaned.headers.cookie).not.toContain('00%3A1A%3A79');
    expect(cleaned.headers['x-extra']).not.toContain('00:1A:79');
    expect(cleaned.headers['x-extra']).not.toContain('other-token');

    // End-to-end check on simulator request log
    const handle = await sim();
    const { token } = await handshake(handle.url, '/portal.php', DEMO_MAC);
    await fetch(`${handle.url}/portal.php?type=stb&action=get_profile&sn=SN-LIVE-SECRET-42`, {
      headers: {
        cookie: macCookie(DEMO_MAC, false),
        authorization: `Bearer ${token}`,
      },
    });
    await fetch(
      `${handle.url}/portal.php?type=itv&action=create_link&cmd=${encodeURIComponent('ffmpeg http://secret-cmd.example.test/live/100001')}`,
      {
        headers: {
          cookie: macCookie(DEMO_MAC, false),
          authorization: `Bearer ${token}`,
        },
      },
    );
    const entries = handle.requests();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(DEMO_MAC);
    expect(serialized).not.toContain(encodeURIComponent(DEMO_MAC));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('SN-LIVE-SECRET-42');
    expect(serialized).not.toContain('secret-cmd.example.test');
    const profileEntry = entries.find((e) => e.query.action === 'get_profile');
    const linkEntry = entries.find((e) => e.query.action === 'create_link');
    expect(profileEntry?.query.sn).toBe('***');
    expect(linkEntry?.query.cmd).toBe('***');
  });
});
