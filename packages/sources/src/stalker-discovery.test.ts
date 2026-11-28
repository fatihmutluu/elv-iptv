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
import { createStalkerClient, normalizeStalkerPortalUrl } from './stalker';

const MAC = '00:1a:79:aa:bb:cc';

interface RecordedRequest {
  url: string;
  options?: HttpRequestOptions;
}

type MockReply =
  | { json: unknown; status?: number; headers?: Record<string, string>; finalUrl?: string }
  | { text: string; status?: number; headers?: Record<string, string>; finalUrl?: string }
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
      return ok({
        status,
        headers: reply.headers ?? {},
        body: bodyOf(text),
        finalUrl: reply.finalUrl ?? url,
      });
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

describe('STK-1: Stalker candidate enumeration & behavioral endpoint discovery', () => {
  it('enumerates deduplicated candidates for explicit .php, root, /stalker_portal, and literal /c/ paths', () => {
    const customPhp = unwrap(normalizeStalkerPortalUrl('http://portal.example/cp/api.php'));
    expect(customPhp.endpoint).toBe('http://portal.example/cp/api.php');
    expect(customPhp.candidates).toEqual([
      'http://portal.example/cp/api.php',
      'http://portal.example/cp/portal.php',
      'http://portal.example/cp/server/load.php',
      'http://portal.example/cp/stalker_portal/server/load.php',
    ]);
    expect(customPhp.candidates?.some((u) => u.includes('api.php/'))).toBe(false);

    const literalC = unwrap(normalizeStalkerPortalUrl('http://portal.example/tenant/c/portal.php'));
    expect(literalC.endpoint).toBe('http://portal.example/tenant/c/portal.php');
    expect(literalC.candidates).toEqual([
      'http://portal.example/tenant/c/portal.php',
      'http://portal.example/tenant/c/server/load.php',
      'http://portal.example/tenant/c/stalker_portal/server/load.php',
      'http://portal.example/tenant/portal.php',
      'http://portal.example/tenant/server/load.php',
      'http://portal.example/tenant/stalker_portal/server/load.php',
    ]);

    const rootPortal = unwrap(normalizeStalkerPortalUrl('https://portal.example:8443'));
    expect(rootPortal.candidates).toEqual([
      'https://portal.example:8443/portal.php',
      'https://portal.example:8443/server/load.php',
      'https://portal.example:8443/stalker_portal/server/load.php',
    ]);

    const stalkerSub = unwrap(normalizeStalkerPortalUrl('http://portal.example/stalker_portal/'));
    expect(stalkerSub.candidates).toEqual([
      'http://portal.example/stalker_portal/server/load.php',
      'http://portal.example/stalker_portal/portal.php',
    ]);
    expect(stalkerSub.candidates?.some((u) => u.includes('stalker_portal/stalker_portal'))).toBe(
      false,
    );
  });

  it('classifies token-free ("simple") reseller portals via get_genres without requiring handshake', async () => {
    const { http, requests } = mockPortal((url) => {
      const action = paramOf(url, 'action');
      if (action === 'handshake') return { status: 404, text: 'Not Found' };
      if (action === 'get_genres') {
        return {
          json: {
            js: [
              { id: '*', title: 'All' },
              { id: '1', title: 'Movies' },
            ],
          },
        };
      }
      if (action === 'get_all_channels') {
        return {
          json: {
            js: { data: [{ id: '10', name: 'Simple Ch', cmd: 'http://cdn.example/10.ts' }] },
          },
        };
      }
      return { json: { js: [] } };
    });

    const client = createStalkerClient({
      http,
      portalUrl: 'http://simple.example.test',
      mac: MAC,
    });

    unwrap(await client.handshake());
    expect(client.discoveredPortal()).toEqual({
      endpoint: 'http://simple.example.test/portal.php',
      mode: 'simple',
    });

    const channels = unwrap(await client.allLiveChannels());
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('Simple Ch');
    expect(requests.some((r) => paramOf(r.url, 'action') === 'handshake')).toBe(false);
    expect(requests.every((r) => r.options?.headers?.Authorization === undefined)).toBe(true);
  });

  it('detects full token mode across 401/403, plain-text auth markers, and JSON auth envelopes', async () => {
    const authResponses: MockReply[] = [
      { status: 401, text: 'Unauthorized' },
      { status: 403, text: 'Forbidden' },
      { status: 200, text: 'Access denied.' },
      { status: 200, text: 'Unauthorized request.' },
      { status: 200, json: { js: { error: 'Invalid token' } } },
      { status: 200, json: { js: { msg: 'Auth failed for device' } } },
    ];

    for (const authReply of authResponses) {
      const { http } = mockPortal((url, opts) => {
        const action = paramOf(url, 'action');
        if (action === 'handshake') return { json: { js: { token: 'TOK-FULL' } } };
        if (opts?.headers?.Authorization !== 'Bearer TOK-FULL') return authReply;
        return { json: { js: [{ id: '9', title: 'Live' }] } };
      });
      const client = createStalkerClient({
        http,
        portalUrl: 'http://auth.example.test',
        mac: MAC,
      });
      expect(unwrap(await client.genres())).toEqual([{ id: '9', title: 'Live' }]);
      expect(client.discoveredPortal()).toEqual({
        endpoint: 'http://auth.example.test/portal.php',
        mode: 'full',
      });
    }
  });

  it('continues probing across 404, 401, 5xx, and timeouts, and stops early on host-level errors or abort', async () => {
    const { http, requests } = mockPortal((url, opts) => {
      const path = new URL(url).pathname;
      if (path === '/portal.php') return { fail: elvError('network', 'timeout') };
      if (path === '/server/load.php') return { status: 503, text: 'Service Unavailable' };
      if (path === '/stalker_portal/server/load.php') {
        if (paramOf(url, 'action') === 'handshake') return { json: { js: { token: 'TOK-3' } } };
        if (opts?.headers?.Authorization !== 'Bearer TOK-3') {
          return { status: 401, text: 'Authorization failed.' };
        }
        return { json: { js: [{ id: '2', title: 'Sports' }] } };
      }
      return { status: 404, text: 'Not found' };
    });

    const client = createStalkerClient({ http, portalUrl: 'http://multi.example.test', mac: MAC });
    expect(unwrap(await client.genres())).toEqual([{ id: '2', title: 'Sports' }]);
    expect(client.discoveredPortal()).toEqual({
      endpoint: 'http://multi.example.test/stalker_portal/server/load.php',
      mode: 'full',
    });
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/portal.php',
      '/server/load.php',
      '/stalker_portal/server/load.php',
      '/stalker_portal/server/load.php',
      '/stalker_portal/server/load.php',
    ]);

    // Host/DNS/connect failure stops early after first attempt (no multi-candidate stall)
    const { http: dnsHttp, requests: dnsReqs } = mockPortal(() => ({
      fail: elvError('network', 'fetch-failed'),
    }));
    expectErr(
      await createStalkerClient({
        http: dnsHttp,
        portalUrl: 'http://down.example.test',
        mac: MAC,
      }).handshake(),
      'network',
      'fetch-failed',
    );
    expect(dnsReqs).toHaveLength(1);
  });

  it('derives ../server/load.php and sibling /c candidates from safe HTML /c/ redirects, rejecting https->http downgrade', async () => {
    const { http } = mockPortal((url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/portal.php') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          text: '<!doctype html><html><body>STB Portal</body></html>',
          finalUrl: 'https://panel.example.test/custom_panel/c/',
        };
      }
      if (parsed.pathname === '/custom_panel/server/load.php') {
        if (paramOf(url, 'action') === 'get_genres') {
          return { json: { js: [{ id: '7', title: 'Redirected' }] } };
        }
      }
      return { status: 404, text: 'Not Found' };
    });

    const client = createStalkerClient({
      http,
      portalUrl: 'https://panel.example.test',
      mac: MAC,
    });
    expect(unwrap(await client.genres())).toEqual([{ id: '7', title: 'Redirected' }]);
    expect(client.discoveredPortal()).toEqual({
      endpoint: 'https://panel.example.test/custom_panel/server/load.php',
      mode: 'simple',
    });

    // Reject https -> http downgrade redirect derivation
    const { http: downgradeHttp, requests: downgradeReqs } = mockPortal((url) => {
      if (url.startsWith('https://secure.example.test/portal.php')) {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: '<html><body>Downgraded</body></html>',
          finalUrl: 'http://secure.example.test/ministra/c/',
        };
      }
      return { status: 404, text: 'Not Found' };
    });
    expectErr(
      await createStalkerClient({
        http: downgradeHttp,
        portalUrl: 'https://secure.example.test',
        mac: MAC,
      }).handshake(),
      'network',
      'http-404',
    );
    expect(downgradeReqs.every((r) => r.url.startsWith('https://'))).toBe(true);
    // Reject cross-host and private-LAN SSRF /c/ redirects (never send MAC/SN/login off-host!)
    for (const unsafeTarget of [
      'https://evil.example.test/stalker_portal/c/',
      'http://192.168.1.1/c/',
      'http://10.0.0.5/c/',
      'http://172.16.0.10/c/',
      'http://100.64.0.1/c/',
      'http://[fc00::1]/c/',
    ]) {
      const { http: ssrfHttp, requests: ssrfReqs } = mockPortal((url) => {
        if (url.endsWith('/portal.php?type=itv&action=get_genres&JsHttpRequest=1-xml')) {
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            text: '<html><body>Portal</body></html>',
            finalUrl: unsafeTarget,
          };
        }
        return { status: 404, text: 'Not Found' };
      });
      expectErr(
        await createStalkerClient({
          http: ssrfHttp,
          portalUrl: 'http://panel.example.test',
          mac: MAC,
        }).handshake(),
        'network',
        'http-404',
      );
      expect(ssrfReqs.every((r) => new URL(r.url).hostname === 'panel.example.test')).toBe(true);
    }

    // Allow same-host http -> https upgrade + port move redirect derivation
    const { http: upgradeHttp } = mockPortal((url) => {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' && parsed.pathname === '/portal.php') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: '<html><body>Moved</body></html>',
          finalUrl: 'https://panel.example.test:8443/sub/c/',
        };
      }
      if (
        parsed.origin === 'https://panel.example.test:8443' &&
        parsed.pathname === '/sub/server/load.php'
      ) {
        return { json: { js: [{ id: '8', title: 'Upgraded' }] } };
      }
      return { status: 404, text: 'Not Found' };
    });
    const upgradedClient = createStalkerClient({
      http: upgradeHttp,
      portalUrl: 'http://panel.example.test',
      mac: MAC,
    });
    expect(unwrap(await upgradedClient.genres())).toEqual([{ id: '8', title: 'Upgraded' }]);
  });

  it('passes skipGuard: true during discoverPortal probes and handshakes, and omits it on normal API calls', async () => {
    const { http, requests } = mockPortal((url, opts) => {
      const path = new URL(url).pathname;
      if (path === '/portal.php' || path === '/server/load.php') {
        return { status: 404, text: 'Not Found' };
      }
      if (paramOf(url, 'action') === 'handshake') return { json: { js: { token: 'TOK-SG' } } };
      if (opts?.headers?.Authorization !== 'Bearer TOK-SG') {
        return { status: 401, text: 'Authorization failed.' };
      }
      return { json: { js: [{ id: '3', title: 'Kids' }] } };
    });

    const client = createStalkerClient({ http, portalUrl: 'http://sg.example.test', mac: MAC });
    expect(unwrap(await client.genres())).toEqual([{ id: '3', title: 'Kids' }]);

    // First 4 calls are discovery probes + discovery handshake -> all MUST pass skipGuard: true
    expect(requests.length).toBe(5);
    for (const req of requests.slice(0, 4)) {
      expect(req.options?.skipGuard).toBe(true);
    }
    // Final normal API call MUST NOT set skipGuard
    expect(requests[4]?.options?.skipGuard).toBeUndefined();
  });

  it('seeds same-host /c/ candidates on runtime html-redirect and fast-returns on host error during re-handshake', async () => {
    let redirectNow = false;
    const { http } = mockPortal((url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/portal.php') {
        if (!redirectNow) return { json: { js: [{ id: '1', title: 'Initial' }] } };
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: '<html><body>Portal</body></html>',
          finalUrl: 'https://live.example.test/v2/c/',
        };
      }
      if (parsed.pathname === '/v2/server/load.php') {
        return { json: { js: [{ id: '2', title: 'RuntimeSeeded' }] } };
      }
      return { status: 404, text: 'Not Found' };
    });

    const c1 = createStalkerClient({
      http,
      portalUrl: 'https://live.example.test',
      mac: MAC,
      discoveredEndpoint: 'https://live.example.test/portal.php',
      portalMode: 'simple',
    });
    expect(unwrap(await c1.genres())).toEqual([{ id: '1', title: 'Initial' }]);
    redirectNow = true;
    expect(unwrap(await c1.genres())).toEqual([{ id: '2', title: 'RuntimeSeeded' }]);
    expect(c1.discoveredPortal()?.endpoint).toBe('https://live.example.test/v2/server/load.php');

    // Host-level network error during re-handshake fast-returns without probing other candidates
    let hsCalls = 0;
    const { http: rehsDownHttp, requests: rehsReqs } = mockPortal((url, opts) => {
      if (paramOf(url, 'action') === 'handshake') {
        hsCalls += 1;
        if (hsCalls === 1) return { json: { js: { token: 'T1' } } };
        return { fail: elvError('network', 'fetch-failed') };
      }
      if (opts?.headers?.Authorization === 'Bearer T1') {
        return { status: 401, text: 'Authorization failed.' };
      }
      return { status: 404, text: 'Not Found' };
    });
    const c2 = createStalkerClient({
      http: rehsDownHttp,
      portalUrl: 'https://down.example.test',
      mac: MAC,
      discoveredEndpoint: 'https://down.example.test/portal.php',
      portalMode: 'full',
    });
    expectErr(await c2.genres(), 'network', 'fetch-failed');
    // Only 3 calls: initial handshake -> 401 genres -> failed re-handshake (NO sibling probing!)
    expect(rehsReqs).toHaveLength(3);
  });

  it('uses persisted discoveredEndpoint/portalMode directly and lazily self-repairs on 404 or auth-failed', async () => {
    let brokenSimple = false;
    const { http, requests } = mockPortal((url, opts) => {
      const path = new URL(url).pathname;
      if (path === '/portal.php') {
        if (!brokenSimple) return { json: { js: [{ id: '1', title: 'Fast' }] } };
        return { status: 404, text: 'Moved' };
      }
      if (path === '/server/load.php') {
        if (paramOf(url, 'action') === 'handshake') return { json: { js: { token: 'REPAIRED' } } };
        if (opts?.headers?.Authorization !== 'Bearer REPAIRED') {
          return { status: 401, text: 'Authorization failed.' };
        }
        return { json: { js: [{ id: '2', title: 'Repaired' }] } };
      }
      return { status: 404, text: 'Not found' };
    });

    const client = createStalkerClient({
      http,
      portalUrl: 'http://repair.example.test',
      mac: MAC,
      discoveredEndpoint: 'http://repair.example.test/portal.php',
      portalMode: 'simple',
    });

    // Fast path: 1 direct call, zero probe/handshake
    expect(unwrap(await client.genres())).toEqual([{ id: '1', title: 'Fast' }]);
    expect(requests).toHaveLength(1);

    // Portal migrates to /server/load.php with full auth -> lazy self-repair succeeds
    brokenSimple = true;
    expect(unwrap(await client.genres())).toEqual([{ id: '2', title: 'Repaired' }]);
    expect(client.discoveredPortal()).toEqual({
      endpoint: 'http://repair.example.test/server/load.php',
      mode: 'full',
    });
  });
});
