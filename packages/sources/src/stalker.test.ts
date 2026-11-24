import {
  type ElvError,
  elvError,
  err,
  type HttpClient,
  type HttpRequestOptions,
  ok,
  type Result,
} from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createStalkerClient, stripStalkerCommandPrefix } from './stalker';

const MAC = '00:1a:79:aa:bb:cc';
const MAC_UPPER = '00:1A:79:AA:BB:CC';
const SERIAL = 'SN-SECRET-998877';
const PORTAL = 'http://portal.example.test:8080';

interface RecordedRequest {
  url: string;
  options?: HttpRequestOptions;
}

type MockReply =
  | { json: unknown; status?: number }
  | { text: string; status?: number }
  | { fail: ElvError }
  | { throws: true };

function bodyOf(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return {
    async *[Symbol.asyncIterator]() {
      if (bytes.length > 0) yield bytes;
    },
  };
}

function mockPortal(handler: (url: string, options?: HttpRequestOptions) => MockReply): {
  http: HttpClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const http: HttpClient = {
    async get(url, options) {
      requests.push(options === undefined ? { url } : { url, options });
      const reply = handler(url, options);
      if ('throws' in reply) throw new Error(`network boom ${url}`);
      if ('fail' in reply) return err(reply.fail);
      const status = reply.status ?? 200;
      const text = 'json' in reply ? JSON.stringify(reply.json) : reply.text;
      return ok({ status, headers: {}, body: bodyOf(text) });
    },
  };
  return { http, requests };
}

function unwrap<T>(r: Result<T>): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`${r.error.category}/${r.error.code}`);
  return r.value;
}

function expectErr<T>(r: Result<T>, category: ElvError['category'], code: string): ElvError {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
  return r.error;
}

function paramOf(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

describe('handshake, fallback, token renewal, transport, and credential isolation', () => {
  it('sends MAC cookie, X-User-Agent, transport options, and primary-host-scoped hostOverride', async () => {
    const { http, requests } = mockPortal((url) => {
      if (paramOf(url, 'action') === 'handshake') {
        return { json: { js: { token: 'TOK-123', random: 'abc' } } };
      }
      return {
        json: {
          js: {
            id: '1',
            status: 0,
            blocked: '0',
            expire_billing_date: '2027-01-15 00:00:00',
            default_timezone: 'Europe/Berlin',
            max_online: 2,
          },
        },
      };
    });

    const client = createStalkerClient({
      http,
      portalUrl: PORTAL,
      mac: MAC,
      serialNumber: SERIAL,
      timezone: 'Europe/Berlin',
      transport: {
        userAgent: 'CustomUA/1.0',
        referer: 'http://portal.example.test/c/',
        allowLegacyTls: true,
        dnsFamily: 'ipv4',
        hostOverride: '203.0.113.10',
      },
    });

    expect(unwrap(await client.profile())).toEqual({
      status: 'Active',
      expiresAt: Date.UTC(2027, 0, 14, 23, 0, 0),
      maxConnections: 2,
      timezone: 'Europe/Berlin',
      blocked: false,
    });

    expect(requests).toHaveLength(2);
    const hs = requests[0];
    expect(hs).toBeDefined();
    expect(hs?.url).toBe(
      `${PORTAL}/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
    );
    expect(hs?.options?.headers?.Cookie).toBe(
      `mac=${encodeURIComponent(MAC_UPPER)}; stb_lang=en; timezone=Europe%2FBerlin`,
    );
    expect(hs?.options?.headers?.['X-User-Agent']).toBe('Model: MAG250; Link: WiFi');
    expect(hs?.options?.headers?.['user-agent']).toBe('CustomUA/1.0');
    expect(hs?.options?.headers?.referer).toBe('http://portal.example.test/c/');
    expect(hs?.options?.headers?.Authorization).toBeUndefined();
    expect(hs?.options?.allowLegacyTls).toBe(true);
    expect(hs?.options?.dnsFamily).toBe('ipv4');
    expect(hs?.options?.hostOverride).toBe('203.0.113.10');

    const prof = requests[1];
    expect(prof).toBeDefined();
    expect(paramOf(prof?.url ?? '', 'action')).toBe('get_profile');
    expect(paramOf(prof?.url ?? '', 'sn')).toBe(SERIAL);
    expect(prof?.options?.headers?.Authorization).toBe('Bearer TOK-123');
    expect(prof?.options?.hostOverride).toBe('203.0.113.10');
  });

  it('falls back from /portal.php to /stalker_portal/server/load.php on HTTP 404 during handshake', async () => {
    const { http, requests } = mockPortal((url) => {
      if (url.includes('/portal.php')) return { text: 'Not found', status: 404 };
      if (paramOf(url, 'action') === 'handshake')
        return { json: { js: { token: 'FALLBACK-TOK' } } };
      return {
        json: {
          js: [
            { id: '*', title: 'All' },
            { id: '5', title: 'News' },
          ],
        },
      };
    });

    const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });
    expect(unwrap(await client.genres())).toEqual([{ id: '5', title: 'News' }]);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/portal.php',
      '/stalker_portal/server/load.php',
      '/stalker_portal/server/load.php',
    ]);

    const { http: all404 } = mockPortal(() => ({ fail: elvError('network', 'http-404') }));
    expectErr(
      await createStalkerClient({ http: all404, portalUrl: PORTAL, mac: MAC }).handshake(),
      'network',
      'http-404',
    );
  });

  it('auto-rehandshakes once on 401/403 or "Authorization failed" and stops after 1 retry', async () => {
    let tokenSeq = 0;
    const { http } = mockPortal((url, opts) => {
      if (paramOf(url, 'action') === 'handshake') {
        tokenSeq += 1;
        return { json: { js: { token: `TOK-${tokenSeq}` } } };
      }
      if (opts?.headers?.Authorization === 'Bearer TOK-1') {
        return { text: '<html>Authorization failed.</html>' };
      }
      return { json: { js: [{ id: '1', title: 'Sports' }] } };
    });

    const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });
    expect(unwrap(await client.genres())).toEqual([{ id: '1', title: 'Sports' }]);
    expect(tokenSeq).toBe(2);

    let persistentHs = 0;
    let persistentApi = 0;
    const { http: httpFail } = mockPortal((url) => {
      if (paramOf(url, 'action') === 'handshake') {
        persistentHs += 1;
        return { json: { js: { token: `BAD-${persistentHs}` } } };
      }
      persistentApi += 1;
      return { status: 403, text: 'forbidden' };
    });
    const badClient = createStalkerClient({ http: httpFail, portalUrl: PORTAL, mac: MAC });
    const errRes = expectErr(await badClient.genres(), 'auth', 'unauthorized');
    expect(errRes.detail).toBeUndefined();
    expect(persistentHs).toBe(2);
    expect(persistentApi).toBe(2);
  });

  it('handles handshake rejections, HTTP/network/body errors, abort, and zero secret leakage', async () => {
    const secretToken = 'BEARER-SUPER-SECRET-TOKEN';
    const { http: badMacHttp, requests } = mockPortal(() => ({ json: { js: { token: 'NO' } } }));
    expectErr(
      await createStalkerClient({ http: badMacHttp, portalUrl: PORTAL, mac: 'bad' }).handshake(),
      'source-format',
      'invalid-mac',
    );
    expectErr(
      await createStalkerClient({ http: badMacHttp, portalUrl: 'ftp://x', mac: MAC }).profile(),
      'source-format',
      'invalid-portal-url',
    );
    expect(requests).toHaveLength(0);

    expectErr(
      await createStalkerClient({
        http: mockPortal(() => ({ json: { js: false } })).http,
        portalUrl: PORTAL,
        mac: MAC,
      }).handshake(),
      'auth',
      'unauthorized',
    );
    expectErr(
      await createStalkerClient({
        http: mockPortal(() => ({ json: { js: { token: '' } } })).http,
        portalUrl: PORTAL,
        mac: MAC,
      }).handshake(),
      'auth',
      'unauthorized',
    );
    expectErr(
      await createStalkerClient({
        http: mockPortal(() => ({ fail: elvError('auth', 'http-401') })).http,
        portalUrl: PORTAL,
        mac: MAC,
      }).handshake(),
      'auth',
      'unauthorized',
    );
    expectErr(
      await createStalkerClient({
        http: mockPortal(() => ({ json: { wrong: true } })).http,
        portalUrl: PORTAL,
        mac: MAC,
      }).handshake(),
      'source-format',
      'unexpected-shape',
    );
    expectErr(
      await createStalkerClient({
        http: mockPortal(() => ({ text: '<html>502</html>', status: 502 })).http,
        portalUrl: PORTAL,
        mac: MAC,
      }).handshake(),
      'network',
      'http-502',
    );
    expectErr(
      await createStalkerClient({
        http: mockPortal(() => ({ throws: true })).http,
        portalUrl: PORTAL,
        mac: MAC,
      }).handshake(),
      'network',
      'request-failed',
    );

    const ac = new AbortController();
    ac.abort();
    expectErr(
      await createStalkerClient({ http: badMacHttp, portalUrl: PORTAL, mac: MAC }).handshake({
        signal: ac.signal,
      }),
      'network',
      'aborted',
    );

    // Body size cap & mid-stream error & secret redaction.
    const bigHttp = mockPortal(() => ({ text: 'x'.repeat(2048) })).http;
    expectErr(
      await createStalkerClient({
        http: bigHttp,
        portalUrl: PORTAL,
        mac: MAC,
        maxBodyBytes: 1024,
      }).handshake(),
      'source-format',
      'too-large',
    );

    const dyingHttp: HttpClient = {
      async get() {
        async function* body() {
          yield new Uint8Array([123]);
          throw new Error('socket reset');
        }
        return ok({ status: 200, headers: {}, body: body() });
      },
    };
    expectErr(
      await createStalkerClient({ http: dyingHttp, portalUrl: PORTAL, mac: MAC }).handshake(),
      'network',
      'stream-failed',
    );

    const leakyHttp = mockPortal((url) =>
      paramOf(url, 'action') === 'handshake'
        ? { json: { js: { token: secretToken } } }
        : {
            fail: elvError(
              'network',
              'timeout',
              `${PORTAL} mac=${MAC_UPPER} sn=${SERIAL} token=${secretToken}`,
            ),
          },
    ).http;
    const failure = expectErr(
      await createStalkerClient({
        http: leakyHttp,
        portalUrl: PORTAL,
        mac: MAC,
        serialNumber: SERIAL,
      }).genres(),
      'network',
      'timeout',
    );
    const dumped = JSON.stringify(failure);
    expect(dumped).not.toContain(PORTAL);
    expect(dumped).not.toContain(MAC_UPPER);
    expect(dumped).not.toContain(SERIAL);
    expect(dumped).not.toContain(secretToken);
  });

  it('calls create_link, strips ffmpeg/ffrt/auto prefixes, handles series episodes, and rejects unsafe schemes', async () => {
    const { http, requests } = mockPortal((url) => {
      const action = paramOf(url, 'action');
      if (action === 'handshake') return { json: { js: { token: 'T1' } } };
      const cmd = paramOf(url, 'cmd') ?? '';
      if (cmd.includes('bad-file')) return { json: { js: { cmd: 'ffmpeg file:///etc/passwd' } } };
      if (cmd.includes('bad-js')) return { json: { js: { cmd: 'javascript:alert(1)' } } };
      if (cmd.includes('bad-ctrl')) {
        return { json: { js: { cmd: 'https://cdn.example.test/live\r\n.ts' } } };
      }
      if (cmd.includes('empty-out')) return { json: { js: { cmd: 'ffmpeg ' } } };
      if (cmd.includes('false-out')) return { json: { js: false } };
      if (cmd.includes('string-out')) {
        return { json: { js: 'auto ffrt https://cdn.example.test/movie.mp4' } };
      }
      if (cmd.includes('bad-shape')) return { json: { js: { unexpected: 1 } } };
      if (cmd.includes('series-ep')) {
        return { json: { js: { cmd: 'ffrt3 https://cdn.example.test/series/ep2.mp4?tok=fresh' } } };
      }
      return { json: { js: { cmd: 'ffmpeg http://cdn.example.test/live/101.ts?tok=fresh' } } };
    });

    expect(stripStalkerCommandPrefix('ffmpeg http://a.example/1.ts')).toBe('http://a.example/1.ts');
    expect(stripStalkerCommandPrefix('ffrt2 https://a.example/1.ts')).toBe(
      'https://a.example/1.ts',
    );
    expect(stripStalkerCommandPrefix('auto http://a.example/1.ts')).toBe('http://a.example/1.ts');

    const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });
    expect(unwrap(await client.createLink('live', 'https://already.example/live/1.ts'))).toBe(
      'http://cdn.example.test/live/101.ts?tok=fresh',
    );
    expect(unwrap(await client.createLink('movie', 'string-out'))).toBe(
      'https://cdn.example.test/movie.mp4',
    );
    expect(
      unwrap(await client.createLink('series', 'ffmpeg series-ep', { episodeNumber: 2 })),
    ).toBe('https://cdn.example.test/series/ep2.mp4?tok=fresh');

    const seriesReq = requests.find((r) => (paramOf(r.url, 'cmd') ?? '').includes('series-ep'));
    expect(seriesReq).toBeDefined();
    expect(paramOf(seriesReq?.url ?? '', 'type')).toBe('series');
    expect(paramOf(seriesReq?.url ?? '', 'series')).toBe('2');

    expectErr(await client.createLink('live', '   '), 'source-format', 'invalid-command');
    expectErr(await client.createLink('live', 'bad-file'), 'playback', 'unsupported-scheme');
    expectErr(await client.createLink('movie', 'bad-js'), 'playback', 'unsupported-scheme');
    expectErr(await client.createLink('live', 'bad-ctrl'), 'playback', 'unsupported-scheme');
    expectErr(await client.createLink('live', 'empty-out'), 'playback', 'stream-unavailable');
    expectErr(await client.createLink('live', 'false-out'), 'playback', 'stream-unavailable');
    expectErr(await client.createLink('live', 'bad-shape'), 'source-format', 'unexpected-shape');
  });

  it('does not treat valid catalog JSON containing "Authorization failed" in a plot as auth failure, and still handles plain-text auth errors', async () => {
    let handshakes = 0;
    const { http } = mockPortal((url) => {
      const action = paramOf(url, 'action');
      if (action === 'handshake') {
        handshakes += 1;
        return { json: { js: { token: `TOK-${handshakes}` } } };
      }
      if (action === 'get_ordered_list') {
        return {
          json: {
            js: {
              total_items: 1,
              max_page_items: 14,
              data: [
                {
                  id: '900',
                  name: 'The Intruder',
                  description: 'After an Authorization failed alert locks the vault, they escape.',
                  cmd: 'ffmpeg http://cdn.example.test/vod/900.mp4',
                },
              ],
            },
          },
        };
      }
      return { text: 'Authorization failed.', status: 200 };
    });

    const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });
    const page = unwrap(await client.vodItems({ categoryId: '*', page: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.plot).toContain('Authorization failed');
    expect(handshakes).toBe(1);

    // Plain-text HTTP 200 "Authorization failed." still triggers re-handshake and returns unauthorized
    expectErr(await client.genres(), 'auth', 'unauthorized');
    expect(handshakes).toBe(2);
  });

  it('rejects handshake tokens containing CR/LF or ASCII control characters', async () => {
    for (const badToken of ['TOK\r\nX-Injected: 1', 'TOK\nEVIL', 'TOK\u0000NULL', 'TOK\u007fDEL']) {
      const { http, requests } = mockPortal(() => ({ json: { js: { token: badToken } } }));
      const client = createStalkerClient({ http, portalUrl: PORTAL, mac: MAC });
      expectErr(await client.handshake(), 'auth', 'unauthorized');
      expect(requests).toHaveLength(1);
    }
  });
});
