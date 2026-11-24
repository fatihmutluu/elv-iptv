import type * as dns from 'node:dns';
import * as http from 'node:http';
import type * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { FetchLike } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopHttpClient,
  createLegacyTlsAgent,
  LEGACY_TLS_CIPHERS,
  LEGACY_TLS_MIN_VERSION,
} from './legacy-tls-http.ts';

function okFetch(bodyText: string): FetchLike {
  return vi.fn(async (url) => ({
    status: 200,
    url,
    headers: {
      forEach: () => {},
      get: () => null,
      getSetCookie: () => [],
    },
    body: (async function* () {
      yield new TextEncoder().encode(bodyText);
    })(),
  }));
}

async function drainText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

describe('createDesktopHttpClient & legacy TLS (#182)', () => {
  it('routes default requests strictly to the modern fetch client and legacy requests strictly to the isolated legacy client', async () => {
    const modernFetch = okFetch('modern-response');
    const legacyFetch = okFetch('legacy-response');
    const client = createDesktopHttpClient(modernFetch, { legacyFetchImpl: legacyFetch });

    const r1 = await client.get('https://modern.example/list.m3u');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(await drainText(r1.value.body)).toBe('modern-response');
    expect(modernFetch).toHaveBeenCalledTimes(1);
    expect(legacyFetch).not.toHaveBeenCalled();

    const r2 = await client.get('https://legacy.example/list.m3u', { allowLegacyTls: true });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(await drainText(r2.value.body)).toBe('legacy-response');
    expect(modernFetch).toHaveBeenCalledTimes(1);
    expect(legacyFetch).toHaveBeenCalledTimes(1);

    const r3 = await client.get('https://modern2.example/list.m3u', { allowLegacyTls: false });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(await drainText(r3.value.body)).toBe('modern-response');
    expect(modernFetch).toHaveBeenCalledTimes(2);
    expect(legacyFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects non-http(s) protocols on both modern and legacy clients', async () => {
    const modernFetch = okFetch('no');
    const legacyFetch = okFetch('no');
    const client = createDesktopHttpClient(modernFetch, { legacyFetchImpl: legacyFetch });

    const r1 = await client.get('file:///etc/passwd');
    const r2 = await client.get('file:///etc/passwd', { allowLegacyTls: true });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(modernFetch).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('configures the isolated legacy HTTPS agent with TLSv1, SECLEVEL=0 ciphers, and certificate verification intact', () => {
    const agent = createLegacyTlsAgent();
    try {
      expect(agent.options.minVersion).toBe(LEGACY_TLS_MIN_VERSION);
      expect(agent.options.ciphers).toBe(LEGACY_TLS_CIPHERS);
      expect(agent.options.rejectUnauthorized).toBe(true);
    } finally {
      agent.destroy();
    }
  });
});

interface CapturedRequest {
  readonly url: URL;
  readonly options: https.RequestOptions;
}

function makeMockRequest(
  responses: Array<{ status: number; headers?: http.IncomingHttpHeaders; body?: string }>,
): {
  captured: CapturedRequest[];
  request: typeof https.request;
} {
  const captured: CapturedRequest[] = [];
  let idx = 0;
  const request = vi.fn((url: URL | string, options: https.RequestOptions) => {
    const parsed = url instanceof URL ? url : new URL(url);
    captured.push({ url: parsed, options });
    const spec = responses[Math.min(idx, responses.length - 1)] ?? { status: 200, body: 'ok' };
    idx += 1;

    const req = new PassThrough() as unknown as http.ClientRequest;
    const origEnd = req.end.bind(req);
    req.end = ((...args: unknown[]) => {
      queueMicrotask(() => {
        const resStream = new PassThrough();
        const res = resStream as unknown as http.IncomingMessage;
        res.statusCode = spec.status;
        res.headers = spec.headers ?? {};
        req.emit('response', res);
        if (spec.body !== undefined && spec.body.length > 0) {
          resStream.write(spec.body);
        }
        resStream.end();
      });
      return origEnd(...(args as []));
    }) as typeof req.end;
    return req;
  }) as unknown as typeof https.request;
  return { captured, request };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

type CustomLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
) => void;

const activeServers: http.Server[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('createDesktopHttpClient DNS family & hostOverride transport (#172)', () => {
  it('uses modern TLS agent (not legacy TLS), preserves TLS SNI and rejectUnauthorized=true, and resolves hostOverride for both all:true and all:false', async () => {
    const modernFetch = okFetch('unused');
    const dnsLookup = vi.fn();
    const { captured, request } = makeMockRequest([{ status: 200, body: 'override-ok' }]);
    const client = createDesktopHttpClient(modernFetch, {
      dnsLookup: dnsLookup as unknown as typeof dns.lookup,
      httpsRequest: request,
    });

    const res = await client.get('https://Provider.Example.Test/player_api.php', {
      hostOverride: '203.0.113.10',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(await drainText(res.value.body)).toBe('override-ok');
    expect(modernFetch).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);

    const reqOpts = captured[0]?.options;
    expect(reqOpts?.servername).toBe('provider.example.test');
    expect(reqOpts?.rejectUnauthorized).toBe(true);
    const agent = reqOpts?.agent as https.Agent | undefined;
    expect(agent).toBeDefined();
    expect(agent?.options.rejectUnauthorized).toBe(true);
    expect(agent?.options.minVersion).not.toBe(LEGACY_TLS_MIN_VERSION);
    expect(agent?.options.ciphers).not.toBe(LEGACY_TLS_CIPHERS);

    const lookup = reqOpts?.lookup as CustomLookup | undefined;
    expect(lookup).toBeTypeOf('function');

    // Node 20+/24 net.connect passes { all: true }
    const allRes = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      lookup?.('provider.example.test', { all: true }, (e, addrs) => {
        if (e) reject(e);
        else resolve(addrs as dns.LookupAddress[]);
      });
    });
    expect(allRes).toEqual([{ address: '203.0.113.10', family: 4 }]);

    // Legacy / { all: false } callback signature
    const singleRes = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      lookup?.('PROVIDER.EXAMPLE.TEST', { all: false }, (e, address, family) => {
        if (e) reject(e);
        else resolve({ address: address as string, family });
      });
    });
    expect(singleRes).toEqual({ address: '203.0.113.10', family: 4 });
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('supports IPv6 hostOverride (including bracketed literals) with family 6 for both all:true and all:false', async () => {
    const modernFetch = okFetch('unused');
    const dnsLookup = vi.fn();
    const { captured, request } = makeMockRequest([{ status: 200, body: 'v6-ok' }]);
    const client = createDesktopHttpClient(modernFetch, {
      dnsLookup: dnsLookup as unknown as typeof dns.lookup,
      httpsRequest: request,
    });

    const res = await client.get('https://ipv6.example.test/list.m3u', {
      hostOverride: '[2001:DB8::42]',
    });
    expect(res.ok).toBe(true);
    const lookup = captured[0]?.options.lookup as CustomLookup | undefined;
    expect(lookup).toBeTypeOf('function');

    const allRes = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      lookup?.('ipv6.example.test', { all: true }, (e, addrs) => {
        if (e) reject(e);
        else resolve(addrs as dns.LookupAddress[]);
      });
    });
    expect(allRes).toEqual([{ address: '2001:db8::42', family: 6 }]);

    const singleRes = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      lookup?.('ipv6.example.test', { all: false }, (e, address, family) => {
        if (e) reject(e);
        else resolve({ address: address as string, family });
      });
    });
    expect(singleRes).toEqual({ address: '2001:db8::42', family: 6 });
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('uses legacy TLS agent only when allowLegacyTls is true alongside dnsFamily/hostOverride', async () => {
    const modernFetch = okFetch('unused');
    const { captured, request } = makeMockRequest([{ status: 200, body: 'legacy-v4' }]);
    const client = createDesktopHttpClient(modernFetch, {
      httpsRequest: request,
    });

    const res = await client.get('https://legacy.example.test/list.m3u', {
      allowLegacyTls: true,
      dnsFamily: 'ipv4',
      hostOverride: '198.51.100.7',
    });
    expect(res.ok).toBe(true);
    const agent = captured[0]?.options.agent as https.Agent | undefined;
    expect(agent?.options.minVersion).toBe(LEGACY_TLS_MIN_VERSION);
    expect(agent?.options.ciphers).toBe(LEGACY_TLS_CIPHERS);
    expect(agent?.options.rejectUnauthorized).toBe(true);
    expect(captured[0]?.options.servername).toBe('legacy.example.test');
  });

  it('forwards dnsFamily ipv4 and ipv6 as family 4 or 6 to dns.lookup while keeping system on default fetch', async () => {
    const modernFetch = okFetch('system-default');
    const dnsCalls: Array<{ hostname: string; options: dns.LookupOptions }> = [];
    const dnsLookup = vi.fn((hostname: string, options: dns.LookupOptions, cb: LookupCallback) => {
      dnsCalls.push({ hostname, options });
      const fam = options.family === 6 ? 6 : 4;
      const addr = fam === 6 ? '2001:db8::1' : '192.0.2.1';
      if (options.all) {
        cb(null, [{ address: addr, family: fam }]);
      } else {
        cb(null, addr, fam);
      }
    });
    const { captured, request } = makeMockRequest([
      { status: 200, body: 'v4' },
      { status: 200, body: 'v6' },
    ]);
    const client = createDesktopHttpClient(modernFetch, {
      dnsLookup: dnsLookup as unknown as typeof dns.lookup,
      httpsRequest: request,
    });

    // 'system' stays on standard modernFetch
    const sys = await client.get('https://sys.example.test/a', { dnsFamily: 'system' });
    expect(sys.ok).toBe(true);
    expect(modernFetch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);

    // 'ipv4' routes through Node request with family: 4
    const v4 = await client.get('https://v4.example.test/a', { dnsFamily: 'ipv4' });
    expect(v4.ok).toBe(true);
    const lookup4 = captured[0]?.options.lookup as CustomLookup;
    await new Promise<void>((resolve) => {
      lookup4('v4.example.test', { all: true }, () => resolve());
    });
    expect(dnsCalls[0]).toEqual({
      hostname: 'v4.example.test',
      options: { all: true, family: 4 },
    });

    // 'ipv6' routes through Node request with family: 6
    const v6 = await client.get('https://v6.example.test/a', { dnsFamily: 'ipv6' });
    expect(v6.ok).toBe(true);
    const lookup6 = captured[1]?.options.lookup as CustomLookup;
    await new Promise<void>((resolve) => {
      lookup6('v6.example.test', { all: false }, () => resolve());
    });
    expect(dnsCalls[1]).toEqual({
      hostname: 'v6.example.test',
      options: { all: false, family: 6 },
    });
  });

  it('never leaks hostOverride onto a cross-origin redirect hop', async () => {
    const modernFetch = okFetch('unused');
    const dnsCalls: Array<{ hostname: string; options: dns.LookupOptions }> = [];
    const dnsLookup = vi.fn((hostname: string, options: dns.LookupOptions, cb: LookupCallback) => {
      dnsCalls.push({ hostname, options });
      if (options.all) cb(null, [{ address: '198.51.100.99', family: 4 }]);
      else cb(null, '198.51.100.99', 4);
    });
    const { captured, request } = makeMockRequest([
      { status: 302, headers: { location: 'https://cdn.other.test/playlist.m3u' } },
      { status: 200, body: 'redirected-body' },
    ]);
    const client = createDesktopHttpClient(modernFetch, {
      dnsLookup: dnsLookup as unknown as typeof dns.lookup,
      httpsRequest: request,
    });

    const res = await client.get('https://origin.example.test/start', {
      hostOverride: '203.0.113.5',
      dnsFamily: 'ipv4',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(await drainText(res.value.body)).toBe('redirected-body');
      expect(res.value.finalUrl).toBe('https://cdn.other.test/playlist.m3u');
    }
    expect(captured).toHaveLength(2);

    // Hop 1 targets origin.example.test -> uses hostOverride 203.0.113.5
    const hop1Lookup = captured[0]?.options.lookup as CustomLookup;
    const hop1Addrs = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      hop1Lookup('origin.example.test', { all: true }, (e, addrs) => {
        if (e) reject(e);
        else resolve(addrs as dns.LookupAddress[]);
      });
    });
    expect(hop1Addrs).toEqual([{ address: '203.0.113.5', family: 4 }]);
    expect(dnsLookup).not.toHaveBeenCalled();

    // Hop 2 targets cdn.other.test -> MUST NOT use 203.0.113.5; calls dns.lookup with family: 4
    expect(captured[1]?.options.servername).toBe('cdn.other.test');
    const hop2Lookup = captured[1]?.options.lookup as CustomLookup;
    const hop2Addrs = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      hop2Lookup('cdn.other.test', { all: true }, (e, addrs) => {
        if (e) reject(e);
        else resolve(addrs as dns.LookupAddress[]);
      });
    });
    expect(hop2Addrs).toEqual([{ address: '198.51.100.99', family: 4 }]);
    expect(dnsCalls).toEqual([{ hostname: 'cdn.other.test', options: { all: true, family: 4 } }]);
  });

  it('rejects invalid hostOverride values without issuing a network request', async () => {
    const modernFetch = okFetch('unused');
    const { captured, request } = makeMockRequest([{ status: 200, body: 'no' }]);
    const client = createDesktopHttpClient(modernFetch, { httpsRequest: request });

    for (const bad of ['evil.example', '203.0.113.1:8080', 'http://203.0.113.1', 'fe80::1%eth0']) {
      const res = await client.get('https://provider.example.test/list.m3u', {
        hostOverride: bad,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid-host-override');
    }
    expect(modernFetch).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('connects end-to-end to a real local HTTP server via hostOverride for an unresolvable hostname', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`host=${req.headers.host ?? ''}`);
    });
    activeServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const client = createDesktopHttpClient(okFetch('unused'));
    const res = await client.get(`http://unresolvable-override.invalid:${port}/live.m3u`, {
      hostOverride: '127.0.0.1',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(await drainText(res.value.body)).toBe(`host=unresolvable-override.invalid:${port}`);
    }
  });
});
