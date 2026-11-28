import { type HttpClient, type HttpRequestOptions, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createStalkerClient } from './stalker';
import { toStalkerChannels, toStalkerVodItems } from './stalker-records';
import {
  encodeStalkerCmdQueryValue,
  parseStalkerTimestampMs,
  validateStalkerStreamUrl,
} from './stalker-url';

const MAC = '00:1a:79:aa:bb:cc';
const SERIAL = 'SN-MAG-12345';

interface RecordedRequest {
  url: string;
  options?: HttpRequestOptions;
}

function bodyOf(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return {
    async *[Symbol.asyncIterator]() {
      if (bytes.length > 0) yield bytes;
    },
  };
}

function mockPortal(
  handler: (
    url: string,
    options?: HttpRequestOptions,
  ) => { json?: unknown; text?: string; status?: number },
): {
  http: HttpClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const http: HttpClient = {
    async get(url, options) {
      requests.push(options === undefined ? { url } : { url, options });
      const reply = handler(url, options);
      const status = reply.status ?? 200;
      const text = 'json' in reply ? JSON.stringify(reply.json) : (reply.text ?? '');
      return ok({ status, headers: {}, body: bodyOf(text), finalUrl: url });
    },
  };
  return { http, requests };
}

function unwrap<T>(r: Result<T>): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`${r.error.category}/${r.error.code}`);
  return r.value;
}

function paramOf(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

describe('STK-2: Stalker wire protocol parity', () => {
  it('encodes cmd leaving % unescaped while percent-encoding &, #, ;, +, whitespace, quotes, controls, and UTF-8', () => {
    const encoded = encodeStalkerCmdQueryValue(
      `ffrt http://host/ch/1?a=1&b=2#f;c+d%3Ae "q"'s\r\ncafé`,
    );
    expect(encoded).toContain('%3Ae');
    expect(encoded).not.toContain('%253A');
    expect(encoded).toContain('%20');
    expect(encoded).toContain('%26');
    expect(encoded).toContain('%23');
    expect(encoded).toContain('%3B');
    expect(encoded).toContain('%2B');
    expect(encoded).toContain('%22');
    expect(encoded).toContain('%27');
    expect(encoded).toContain('%0D%0A');
    expect(encoded).toContain('%C3%A9');
  });

  it('resolves relative /media/... and query-only ?token=... create_link outputs against portal installation base', () => {
    const stalkerBase = 'https://panel.example.test/stalker_portal/server/load.php';
    expect(unwrap(validateStalkerStreamUrl('ffmpeg /media/file_42.mpg', stalkerBase))).toBe(
      'https://panel.example.test/stalker_portal/media/file_42.mpg',
    );
    expect(unwrap(validateStalkerStreamUrl('/stalker_portal/media/file_42.mpg', stalkerBase))).toBe(
      'https://panel.example.test/stalker_portal/media/file_42.mpg',
    );
    expect(unwrap(validateStalkerStreamUrl('?token=abc123&ch=5', stalkerBase))).toBe(
      'https://panel.example.test/stalker_portal/?token=abc123&ch=5',
    );

    const cpBase = 'http://panel.example.test/cp/portal.php';
    expect(unwrap(validateStalkerStreamUrl('/media/live/1.ts', cpBase))).toBe(
      'http://panel.example.test/cp/media/live/1.ts',
    );

    expect(validateStalkerStreamUrl('javascript:alert(1)', stalkerBase).ok).toBe(false);
    expect(validateStalkerStreamUrl('file:///etc/passwd', stalkerBase).ok).toBe(false);
    expect(validateStalkerStreamUrl('//evil.example/a.ts', stalkerBase).ok).toBe(false);
    expect(validateStalkerStreamUrl('/media/bad\r\n.mpg', stalkerBase).ok).toBe(false);
  });

  it('parses fixed UTC+/-H[:MM] and GMT+/-H[:MM] offsets in parseStalkerTimestampMs', () => {
    expect(parseStalkerTimestampMs('2026-11-24 15:00:00', 'UTC+3')).toBe(
      Date.UTC(2026, 10, 24, 12, 0, 0),
    );
    expect(parseStalkerTimestampMs('2026-11-24 15:00:00', 'GMT-05:30')).toBe(
      Date.UTC(2026, 10, 24, 20, 30, 0),
    );
    expect(parseStalkerTimestampMs('2026-11-24 15:00:00', 'UTC+05:30')).toBe(
      Date.UTC(2026, 10, 24, 9, 30, 0),
    );
  });

  it('dynamically rebuilds Cookie timezone after profile(), sends MAG250 UA, SN, __cfduid, do_auth second step, and watchdogEvents', async () => {
    let didDoAuth = false;
    const { http, requests } = mockPortal((url, opts) => {
      const type = paramOf(url, 'type');
      const action = paramOf(url, 'action');
      if (action === 'handshake') return { json: { js: { token: 'TOK-W' } } };
      if (opts?.headers?.Authorization !== 'Bearer TOK-W') {
        return { status: 401, text: 'Authorization failed.' };
      }
      if (type === 'stb' && action === 'get_profile') {
        if (!didDoAuth) {
          return { json: { js: { status: 2, blocked: 0 } } };
        }
        return {
          json: {
            js: {
              status: 0,
              blocked: 0,
              default_timezone: 'Europe/Istanbul',
              watchdog_timeout: 90,
            },
          },
        };
      }
      if (type === 'stb' && action === 'do_auth') {
        didDoAuth = true;
        return { json: { js: true } };
      }
      if (type === 'watchdog' && action === 'get_events') {
        return { json: { js: { data: { event: '' }, watchdog_timeout: 120 } } };
      }
      if (action === 'create_link') {
        return { json: { js: { cmd: 'ffmpeg /media/file_77.mpg' } } };
      }
      return { json: { js: [] } };
    });

    const client = createStalkerClient({
      http,
      portalUrl: 'https://panel.example.test/stalker_portal/server/load.php',
      mac: MAC,
      serialNumber: SERIAL,
      deviceId: 'DEV-ID-1',
      deviceId2: 'DEV-ID-2',
      signature: 'SIG-1',
      login: 'user1',
      password: 'secret-pass',
      discoveredEndpoint: 'https://panel.example.test/stalker_portal/server/load.php',
      portalMode: 'full',
    });

    const prof = unwrap(await client.profile());
    expect(prof.timezone).toBe('Europe/Istanbul');
    expect(prof.watchdogTimeoutSec).toBe(90);

    // Verify do_auth + auth_second_step=1 flow
    const doAuthReq = requests.find((r) => paramOf(r.url, 'action') === 'do_auth');
    expect(doAuthReq).toBeDefined();
    expect(paramOf(doAuthReq?.url ?? '', 'login')).toBe('user1');
    const secondProfileReq = requests.find(
      (r) =>
        paramOf(r.url, 'action') === 'get_profile' && paramOf(r.url, 'auth_second_step') === '1',
    );
    expect(secondProfileReq).toBeDefined();
    expect(paramOf(secondProfileReq?.url ?? '', 'device_id')).toBe('DEV-ID-1');
    expect(paramOf(secondProfileReq?.url ?? '', 'device_id2')).toBe('DEV-ID-2');
    expect(paramOf(secondProfileReq?.url ?? '', 'signature')).toBe('SIG-1');
    expect(paramOf(secondProfileReq?.url ?? '', 'sn')).toBe(SERIAL);

    // Default MAG250 UA, X-User-Agent, SN, and serial-derived __cfduid cookie
    expect(secondProfileReq?.options?.headers?.['user-agent']).toContain('MAG200 stbapp');
    expect(secondProfileReq?.options?.headers?.['X-User-Agent']).toBe('Model: MAG250; Link: WiFi');
    expect(secondProfileReq?.options?.headers?.SN).toBe(SERIAL);
    expect(secondProfileReq?.options?.headers?.Cookie).toContain('__cfduid=');
    expect(secondProfileReq?.options?.headers?.Cookie).not.toContain(SERIAL);

    // Subsequent call after profile() MUST reflect updated timezone in Cookie
    const wd = unwrap(await client.watchdogEvents());
    expect(wd.watchdogTimeoutSec).toBe(120);
    const wdReq = requests.find((r) => paramOf(r.url, 'type') === 'watchdog');
    expect(wdReq?.options?.headers?.Cookie).toContain('timezone=Europe%2FIstanbul');

    // create_link preserves %3A unescaped on wire and resolves relative /media/ against /stalker_portal/
    const link = unwrap(await client.createLink('movie', 'ffrt http://origin/item%3A1&x=2'));
    expect(link).toBe('https://panel.example.test/stalker_portal/media/file_77.mpg');
    const linkReq = requests.find((r) => paramOf(r.url, 'action') === 'create_link');
    expect(linkReq?.url).toContain('item%3A1%26x=2');
    expect(linkReq?.url).not.toContain('%253A');

    // Safe playback headers: attached for same-host https, stripped on cross-host or https->http downgrade
    const sameHostHeaders = client.playbackHeadersFor(
      'https://panel.example.test:8443/stalker_portal/media/file_77.mpg',
    );
    expect(sameHostHeaders.cookie).toContain('timezone=Europe%2FIstanbul');
    expect(sameHostHeaders.authorization).toBe('Bearer TOK-W');
    expect(sameHostHeaders['x-user-agent']).toBe('Model: MAG250; Link: WiFi');
    expect(sameHostHeaders['user-agent']).toContain('MAG200 stbapp');
    expect(sameHostHeaders.sn).toBe(SERIAL);

    const downgradeHeaders = client.playbackHeadersFor(
      'http://panel.example.test/stalker_portal/media/file_77.mpg',
    );
    expect(downgradeHeaders.cookie).toBeUndefined();
    expect(downgradeHeaders.authorization).toBeUndefined();
    expect(downgradeHeaders.sn).toBeUndefined();

    const thirdPartyHeaders = client.playbackHeadersFor('https://cdn.other.test/stream.ts');
    expect(thirdPartyHeaders.cookie).toBeUndefined();
    expect(thirdPartyHeaders.authorization).toBeUndefined();
    expect(thirdPartyHeaders.sn).toBeUndefined();
  });

  it('extracts use_http_tmp_link, use_load_balancing, and embedded seriesEpisodeNumbers on records', () => {
    const [ch] = toStalkerChannels([
      {
        id: '1',
        name: 'Static Ch',
        cmd: 'ffmpeg http://cdn.example.test/1.ts',
        use_http_tmp_link: '0',
        use_load_balancing: 0,
      },
    ]);
    expect(ch?.useHttpTmpLink).toBe(false);
    expect(ch?.useLoadBalancing).toBe(false);

    const [vod] = toStalkerVodItems([
      {
        id: '2',
        name: 'Mini Series',
        cmd: 'ffmpeg http://cdn.example.test/vod/2',
        use_http_tmp_link: 0,
        use_load_balancing: '0',
        series: [1, 2, '3', 2, -1],
      },
    ]);
    expect(vod?.useHttpTmpLink).toBe(false);
    expect(vod?.useLoadBalancing).toBe(false);
    expect(vod?.seriesEpisodeNumbers).toEqual([1, 2, 3]);

    // Rejects <= 0 ratings (falling through to next positive score) and placeholder metadata strings
    const [rated, unrated] = toStalkerVodItems([
      {
        id: '3',
        name: 'Fallback Rating',
        cmd: 'http://cdn.example.test/3.mp4',
        rating_imdb: '0',
        rating_kinopoisk: '7.8',
        description: 'N/A',
        plot: 'Real summary',
        actors: '-',
        cast: 'Alice, Bob',
        director: 'none',
      },
      {
        id: '4',
        name: 'Zero Rated',
        cmd: 'http://cdn.example.test/4.mp4',
        rating_imdb: '0',
        rating_kinopoisk: '-1',
        rating: 0,
        description: 'null',
        actors: 'N/A',
        director: '-',
      },
    ]);
    expect(rated?.rating).toBe(7.8);
    expect(rated?.plot).toBe('Real summary');
    expect(rated?.cast).toBe('Alice, Bob');
    expect(rated?.director).toBeUndefined();
    expect(unrated?.rating).toBeUndefined();
    expect(unrated?.plot).toBeUndefined();
    expect(unrated?.cast).toBeUndefined();
    expect(unrated?.director).toBeUndefined();
  });
});

describe('STK-3: Stalker multi-page seriesSeasons & Ministra vodEpisodeFiles', () => {
  it('paginates seriesSeasons across pages 1..N and stops on duplicate seen-ID no-progress pages', async () => {
    const pagesFetched: number[] = [];
    const { http } = mockPortal((url) => {
      const p = Number(paramOf(url, 'p') ?? '1');
      pagesFetched.push(p);
      if (p === 1) {
        return {
          json: {
            js: {
              total_items: 16,
              max_page_items: 14,
              data: Array.from({ length: 14 }, (_, i) => ({
                id: `s${i + 1}`,
                name: `Season ${i + 1}`,
                season_number: i + 1,
              })),
            },
          },
        };
      }
      return {
        json: {
          js: {
            total_items: 16,
            max_page_items: 14,
            data: [
              { id: 's15', name: 'Season 15', season_number: 15 },
              { id: 's16', name: 'Season 16', season_number: 16 },
            ],
          },
        },
      };
    });

    const client = createStalkerClient({
      http,
      portalUrl: 'http://series.example.test/portal.php',
      mac: MAC,
      discoveredEndpoint: 'http://series.example.test/portal.php',
      portalMode: 'simple',
    });

    const seasons = unwrap(await client.seriesSeasons('900'));
    expect(seasons).toHaveLength(16);
    expect(seasons[15]?.seasonNumber).toBe(16);
    expect(pagesFetched).toEqual([1, 2]);

    // No-progress guard when portal repeats page 1 endlessly
    let stallCalls = 0;
    const { http: stallHttp } = mockPortal(() => {
      stallCalls += 1;
      return {
        json: {
          js: {
            total_items: 100,
            max_page_items: 2,
            data: [
              { id: 's1', name: 'Season 1', season_number: 1 },
              { id: 's2', name: 'Season 2', season_number: 2 },
            ],
          },
        },
      };
    });
    const stalledClient = createStalkerClient({
      http: stallHttp,
      portalUrl: 'http://series.example.test/portal.php',
      mac: MAC,
      discoveredEndpoint: 'http://series.example.test/portal.php',
      portalMode: 'simple',
    });
    const stalledSeasons = unwrap(await stalledClient.seriesSeasons('901'));
    expect(stalledSeasons).toHaveLength(2);
    expect(stallCalls).toBe(2);
  });

  it('supports type=vod seriesSeasons, seasonEpisodes, and vodEpisodeFiles for Ministra VOD-series', async () => {
    const { http, requests } = mockPortal((url) => {
      const type = paramOf(url, 'type');
      const episodeId = paramOf(url, 'episode_id');
      if (type === 'vod' && episodeId === 'ep10') {
        return {
          json: {
            js: {
              total_items: 2,
              max_page_items: 14,
              data: [
                { id: '9001', is_file: 1, file_type: 'subtitle', protocol: 'http', cmd: '' },
                { id: '4567', is_file: 1, file_type: 'video', protocol: 'custom', cmd: '' },
              ],
            },
          },
        };
      }
      return { json: { js: { total_items: 0, max_page_items: 14, data: [] } } };
    });

    const client = createStalkerClient({
      http,
      portalUrl: 'http://ministra.example.test/stalker_portal/server/load.php',
      mac: MAC,
      discoveredEndpoint: 'http://ministra.example.test/stalker_portal/server/load.php',
      portalMode: 'simple',
    });

    const files = unwrap(await client.vodEpisodeFiles('vod10', 'sea1', 'ep10'));
    expect(files).toHaveLength(2);
    expect(files[1]).toEqual({
      id: '4567',
      isFile: true,
      fileType: 'video',
      protocol: 'custom',
    });
    expect(paramOf(requests[0]?.url ?? '', 'type')).toBe('vod');
    expect(paramOf(requests[0]?.url ?? '', 'movie_id')).toBe('vod10');
    expect(paramOf(requests[0]?.url ?? '', 'season_id')).toBe('sea1');
    expect(paramOf(requests[0]?.url ?? '', 'episode_id')).toBe('ep10');

    const badId = await client.vodEpisodeFiles('', 'sea1', 'ep10');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe('invalid-id');
  });

  it('rejects failed do_auth and persistent status=2, and handles array seriesSeasons', async () => {
    const { http: failAuthHttp } = mockPortal((url) => {
      const action = paramOf(url, 'action');
      if (action === 'get_profile') return { json: { js: { status: 2, blocked: 0 } } };
      if (action === 'do_auth') return { json: { js: false } };
      return { json: { js: [] } };
    });
    const c1 = createStalkerClient({
      http: failAuthHttp,
      portalUrl: 'http://auth2.example.test/portal.php',
      mac: MAC,
      login: 'u',
      password: 'p',
      discoveredEndpoint: 'http://auth2.example.test/portal.php',
      portalMode: 'simple',
    });
    const r1 = await c1.profile();
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toEqual({ category: 'auth', code: 'unauthorized' });

    const { http: stillStatus2Http } = mockPortal((url) => {
      const action = paramOf(url, 'action');
      if (action === 'get_profile') return { json: { js: { status: 2, blocked: 0 } } };
      if (action === 'do_auth') return { json: { js: true } };
      return { json: { js: [{ id: 'a1', name: 'Season 1', season_number: 1 }] } };
    });
    const c2 = createStalkerClient({
      http: stillStatus2Http,
      portalUrl: 'http://auth2.example.test/portal.php',
      mac: MAC,
      login: 'u',
      password: 'p',
      discoveredEndpoint: 'http://auth2.example.test/portal.php',
      portalMode: 'simple',
    });
    const r2 = await c2.profile();
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toEqual({ category: 'auth', code: 'unauthorized' });
    const arrSeasons = unwrap(await c2.seriesSeasons('1'));
    expect(arrSeasons).toHaveLength(1);

    // Bare array on page 2+ preserves page 1 seasons and merges any unseen items
    const { http: bareP2Http } = mockPortal((url) => {
      const p = Number(paramOf(url, 'p') ?? '1');
      if (p === 1) {
        return {
          json: {
            js: {
              total_items: 3,
              max_page_items: 2,
              data: [
                { id: 's1', name: 'Season 1', season_number: 1 },
                { id: 's2', name: 'Season 2', season_number: 2 },
              ],
            },
          },
        };
      }
      return {
        json: {
          js: [
            { id: 's2', name: 'Season 2 Dup', season_number: 2 },
            { id: 's3', name: 'Season 3', season_number: 3 },
          ],
        },
      };
    });
    const c3 = createStalkerClient({
      http: bareP2Http,
      portalUrl: 'http://auth2.example.test/portal.php',
      mac: MAC,
      discoveredEndpoint: 'http://auth2.example.test/portal.php',
      portalMode: 'simple',
    });
    const mergedSeasons = unwrap(await c3.seriesSeasons('99'));
    expect(mergedSeasons.map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    // Bare empty array [] on page 2 preserves page 1 seasons
    const { http: emptyP2Http } = mockPortal((url) => {
      const p = Number(paramOf(url, 'p') ?? '1');
      if (p === 1) {
        return {
          json: {
            js: {
              total_items: 5,
              max_page_items: 2,
              data: [
                { id: 's1', name: 'Season 1', season_number: 1 },
                { id: 's2', name: 'Season 2', season_number: 2 },
              ],
            },
          },
        };
      }
      return { json: { js: [] } };
    });
    const c4 = createStalkerClient({
      http: emptyP2Http,
      portalUrl: 'http://auth2.example.test/portal.php',
      mac: MAC,
      discoveredEndpoint: 'http://auth2.example.test/portal.php',
      portalMode: 'simple',
    });
    expect(unwrap(await c4.seriesSeasons('100')).map((s) => s.id)).toEqual(['s1', 's2']);
  });
});
