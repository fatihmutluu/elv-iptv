import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok } from '@elv/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogClientMessage } from '../../shared/catalog-ipc.ts';
import { createDesktopDownloadDeps } from './desktop-download-deps.ts';
import { createDesktopDownloadManager, type DesktopDownloadManager } from './download-manager.ts';
import {
  classifyDownloadHost,
  DownloadRedirectError,
  fetchDownloadWithManualRedirects,
  MAX_DOWNLOAD_REDIRECT_HOPS,
} from './download-redirect.ts';

const PUBLIC_DNS = async (): Promise<readonly string[]> => ['93.184.216.34'];

describe('classifyDownloadHost', () => {
  it('classifies IPv4, alternate IPv4 encodings, IPv6, IPv4-mapped IPv6, and metadata hosts accurately', () => {
    // Cloud metadata
    expect(classifyDownloadHost('169.254.169.254')).toBe('metadata');
    expect(classifyDownloadHost('169.254.0.1')).toBe('metadata');
    expect(classifyDownloadHost('0xa9fea9fe')).toBe('metadata');
    expect(classifyDownloadHost('2852039166')).toBe('metadata');
    expect(classifyDownloadHost('[fd00:ec2::254]')).toBe('metadata');
    expect(classifyDownloadHost('fd00:ec2:0:0:0:0:0:254')).toBe('metadata');
    expect(classifyDownloadHost('metadata.google.internal')).toBe('metadata');
    expect(classifyDownloadHost('METADATA.GOOGLE.INTERNAL.')).toBe('metadata');
    expect(classifyDownloadHost('[::ffff:169.254.169.254]')).toBe('metadata');
    expect(classifyDownloadHost('[::ffff:a9fe:a9fe]')).toBe('metadata');

    // Loopback
    expect(classifyDownloadHost('127.0.0.1')).toBe('loopback');
    expect(classifyDownloadHost('127.255.255.254')).toBe('loopback');
    expect(classifyDownloadHost('0x7f000001')).toBe('loopback');
    expect(classifyDownloadHost('2130706433')).toBe('loopback');
    expect(classifyDownloadHost('0177.0.0.1')).toBe('loopback');
    expect(classifyDownloadHost('127.1')).toBe('loopback');
    expect(classifyDownloadHost('localhost')).toBe('loopback');
    expect(classifyDownloadHost('sub.localhost')).toBe('loopback');
    expect(classifyDownloadHost('LOCALHOST.')).toBe('loopback');
    expect(classifyDownloadHost('[::1]')).toBe('loopback');
    expect(classifyDownloadHost('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(classifyDownloadHost('[::ffff:127.0.0.1]')).toBe('loopback');
    expect(classifyDownloadHost('[::ffff:7f00:1]')).toBe('loopback');
    expect(classifyDownloadHost('[0:0:0:0:0:ffff:7f00:0001]')).toBe('loopback');

    // Unspecified
    expect(classifyDownloadHost('0.0.0.0')).toBe('unspecified');
    expect(classifyDownloadHost('0')).toBe('unspecified');
    expect(classifyDownloadHost('[::]')).toBe('unspecified');
    expect(classifyDownloadHost('[::ffff:0.0.0.0]')).toBe('unspecified');
    expect(classifyDownloadHost('[::ffff:0:0]')).toBe('unspecified');

    // Private LAN & link-local IPv6
    expect(classifyDownloadHost('10.0.0.5')).toBe('private-lan');
    expect(classifyDownloadHost('172.16.0.1')).toBe('private-lan');
    expect(classifyDownloadHost('172.31.255.254')).toBe('private-lan');
    expect(classifyDownloadHost('192.168.1.50')).toBe('private-lan');
    expect(classifyDownloadHost('100.64.1.2')).toBe('private-lan');
    expect(classifyDownloadHost('[fc00::1]')).toBe('private-lan');
    expect(classifyDownloadHost('[fd12:3456::1]')).toBe('private-lan');
    expect(classifyDownloadHost('[::ffff:192.168.1.10]')).toBe('private-lan');
    expect(classifyDownloadHost('[::ffff:c0a8:010a]')).toBe('private-lan');
    expect(classifyDownloadHost('[fe80::1]')).toBe('link-local');
    expect(classifyDownloadHost('[febf::1]')).toBe('link-local');

    // 6to4 (2002::/16) and local-use NAT64 (64:ff9b:1::/48)
    expect(classifyDownloadHost('[2002:7f00:0001::1]')).toBe('loopback');
    expect(classifyDownloadHost('[2002:a9fe:a9fe::1]')).toBe('metadata');
    expect(classifyDownloadHost('[2002:c0a8:0101::1]')).toBe('private-lan');
    expect(classifyDownloadHost('[2002:0a00:0001::1]')).toBe('private-lan');
    expect(classifyDownloadHost('[2002:5db8:d822::1]')).toBe('public');
    expect(classifyDownloadHost('[64:ff9b:1::127.0.0.1]')).toBe('loopback');
    expect(classifyDownloadHost('[64:ff9b:1::169.254.169.254]')).toBe('metadata');
    expect(classifyDownloadHost('[64:ff9b:1::10.0.0.5]')).toBe('private-lan');
    expect(classifyDownloadHost('[64:ff9b:1::93.184.216.34]')).toBe('private-lan');

    // Public hosts
    expect(classifyDownloadHost('cdn.example.test')).toBe('public');
    expect(classifyDownloadHost('93.184.216.34')).toBe('public');
    expect(classifyDownloadHost('172.15.255.255')).toBe('public');
    expect(classifyDownloadHost('172.32.0.1')).toBe('public');
    expect(classifyDownloadHost('[2606:2800:220:1:248:1893:25c8:1946]')).toBe('public');
  });
});

describe('fetchDownloadWithManualRedirects', () => {
  it('follows same-host upgrades and port moves while preserving credentials', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
    const canceledBodies: number[] = [];

    const fetchHop = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: { ...(init.headers as Record<string, string>) },
        redirect: init.redirect,
      });
      if (seen.length === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceledBodies.push(1);
            },
          }),
          { status: 302, headers: { location: 'https://cdn.example.test:8443/stream/final.mp4' } },
        );
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-length': '4' },
      });
    });

    const response = await fetchDownloadWithManualRedirects({
      initialUrl: 'http://cdn.example.test/stream/start.mp4',
      headers: {
        Authorization: 'Bearer secret-token',
        Cookie: 'sid=123',
        'X-Auth-Token': 'tok-1',
        Range: 'bytes=100-',
        'User-Agent': 'ELV/1.0',
      },
      signal: new AbortController().signal,
      fetchHop,
      lookup: PUBLIC_DNS,
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[1]?.redirect).toBe('manual');
    expect(seen[1]?.url).toBe('https://cdn.example.test:8443/stream/final.mp4');
    expect(seen[1]?.headers.Authorization).toBe('Bearer secret-token');
    expect(seen[1]?.headers.Cookie).toBe('sid=123');
    expect(seen[1]?.headers['X-Auth-Token']).toBe('tok-1');
    expect(seen[1]?.headers.Range).toBe('bytes=100-');
    expect(canceledBodies).toEqual([1]);
  });

  it('uses an explicit safe-header allowlist on cross-host redirect and https -> http protocol downgrade', async () => {
    const seenCross: Array<Record<string, string>> = [];
    const crossRes = await fetchDownloadWithManualRedirects({
      initialUrl: 'https://origin.example.test/movie.mp4',
      headers: {
        Authorization: 'Bearer a',
        'Proxy-Authorization': 'Basic b',
        Cookie: 'c=1',
        'X-Api-Key': 'k',
        'X-Auth-Token': 't1',
        'X-Access-Token': 't2',
        'X-Session-Token': 'custom-session',
        'Api-Key': 'custom-key',
        Token: 't3',
        Range: 'bytes=50-',
        'User-Agent': 'ELV/1.0',
        Accept: '*/*',
        Referer: 'https://origin.example.test/',
        'If-Range': '"etag-1"',
      },
      signal: new AbortController().signal,
      lookup: PUBLIC_DNS,
      fetchHop: async (url, init) => {
        seenCross.push({ ...(init.headers as Record<string, string>) });
        if (url.includes('origin.example.test')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://edge.other.test/movie.mp4' },
          });
        }
        return new Response('ok', { status: 200 });
      },
    });
    expect(crossRes.status).toBe(200);
    expect(seenCross[1]).toEqual({
      Range: 'bytes=50-',
      'User-Agent': 'ELV/1.0',
      Accept: '*/*',
      Referer: 'https://origin.example.test/',
      'If-Range': '"etag-1"',
    });

    const seenDowngrade: Array<Record<string, string>> = [];
    const downRes = await fetchDownloadWithManualRedirects({
      initialUrl: 'https://cdn.example.test/movie.mp4',
      headers: {
        Authorization: 'Bearer a',
        Cookie: 'c=1',
        'X-Access-Token': 't2',
        'X-Custom-Secret': 'should-strip',
        Token: 't3',
        Range: 'bytes=10-',
      },
      signal: new AbortController().signal,
      lookup: PUBLIC_DNS,
      fetchHop: async (url, init) => {
        seenDowngrade.push({ ...(init.headers as Record<string, string>) });
        if (url.startsWith('https://')) {
          return new Response(null, {
            status: 307,
            headers: { location: 'http://cdn.example.test/movie.mp4' },
          });
        }
        return new Response('ok', { status: 200 });
      },
    });
    expect(downRes.status).toBe(200);
    expect(seenDowngrade[1]).toEqual({ Range: 'bytes=10-' });
  });

  it('blocks SSRF redirects from public hosts to private/loopback/link-local/metadata/IPv4-mapped IPv6 and disallowed schemes', async () => {
    const blockedTargets = [
      'http://127.0.0.1/admin',
      'http://localhost/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://[::ffff:127.0.0.1]/secret',
      'http://[::ffff:7f00:1]/secret',
      'http://[::ffff:a9fe:a9fe]/meta',
      'http://10.0.0.1/internal',
      'http://192.168.1.1/router',
      'http://172.16.0.5/lan',
      'http://0.0.0.0/local',
      'http://[::]/local',
      'http://[fe80::1]/link',
      'http://[fc00::1]/ula',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@cdn.example.test/movie.mp4',
    ];

    for (const target of blockedTargets) {
      let calls = 0;
      let canceled = false;
      await expect(
        fetchDownloadWithManualRedirects({
          initialUrl: 'https://public.example.test/movie.mp4',
          headers: {},
          signal: new AbortController().signal,
          lookup: PUBLIC_DNS,
          fetchHop: async () => {
            calls += 1;
            return new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  canceled = true;
                },
              }),
              { status: 302, headers: { location: target } },
            );
          },
        }),
      ).rejects.toBeInstanceOf(DownloadRedirectError);
      expect(calls).toBe(1);
      expect(canceled).toBe(true);
    }
  });

  it('blocks LAN -> loopback/metadata redirects while allowing LAN -> LAN and loopback -> same loopback', async () => {
    // LAN -> loopback blocked
    for (const target of [
      'http://127.0.0.1:8080/x',
      'http://[::1]/x',
      'http://localhost/x',
      'http://169.254.169.254/latest',
      'http://0.0.0.0/x',
    ]) {
      await expect(
        fetchDownloadWithManualRedirects({
          initialUrl: 'http://192.168.1.50:8080/movie.mp4',
          headers: {},
          signal: new AbortController().signal,
          fetchHop: async () => new Response(null, { status: 302, headers: { location: target } }),
        }),
      ).rejects.toBeInstanceOf(DownloadRedirectError);
    }

    // LAN -> LAN allowed
    let lanCalls = 0;
    const lanRes = await fetchDownloadWithManualRedirects({
      initialUrl: 'http://192.168.1.50:8080/movie.mp4',
      headers: { Authorization: 'Bearer secret' },
      signal: new AbortController().signal,
      fetchHop: async (url) => {
        lanCalls += 1;
        if (url.includes('192.168.1.50')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://192.168.1.51:8080/movie.mp4' },
          });
        }
        return new Response('lan-ok', { status: 200 });
      },
    });
    expect(lanRes.status).toBe(200);
    expect(lanCalls).toBe(2);

    // Loopback -> same loopback allowed (simulator/local tests)
    const loopRes = await fetchDownloadWithManualRedirects({
      initialUrl: 'http://127.0.0.1:7878/redirect.mp4',
      headers: {},
      signal: new AbortController().signal,
      fetchHop: async (url) => {
        if (url.endsWith('/redirect.mp4')) {
          return new Response(null, { status: 302, headers: { location: '/final.mp4' } });
        }
        return new Response('loop-ok', { status: 200 });
      },
    });
    expect(loopRes.status).toBe(200);

    // Loopback -> metadata still blocked
    await expect(
      fetchDownloadWithManualRedirects({
        initialUrl: 'http://127.0.0.1:7878/redirect.mp4',
        headers: {},
        signal: new AbortController().signal,
        fetchHop: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
      }),
    ).rejects.toBeInstanceOf(DownloadRedirectError);
  });

  it('rejects embedded userinfo on initial URL and enforces MAX_DOWNLOAD_REDIRECT_HOPS', async () => {
    expect(MAX_DOWNLOAD_REDIRECT_HOPS).toBe(8);

    await expect(
      fetchDownloadWithManualRedirects({
        initialUrl: 'https://user:pass@cdn.example.test/movie.mp4',
        headers: {},
        signal: new AbortController().signal,
        fetchHop: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(DownloadRedirectError);

    let hops = 0;
    await expect(
      fetchDownloadWithManualRedirects({
        initialUrl: 'https://cdn.example.test/hop/0',
        headers: {},
        signal: new AbortController().signal,
        lookup: PUBLIC_DNS,
        fetchHop: async () => {
          hops += 1;
          return new Response(null, {
            status: 302,
            headers: { location: `https://cdn.example.test/hop/${hops}` },
          });
        },
      }),
    ).rejects.toMatchObject({ reason: 'too-many-redirects' });
    expect(hops).toBe(MAX_DOWNLOAD_REDIRECT_HOPS + 1);
  });

  it('resolves DNS for non-IP hosts on initial and redirect hops and blocks DNS SSRF, lookup failures, and LAN -> public -> LAN bounces', async () => {
    const dnsTable: Record<string, readonly string[]> = {
      'public.example.test': ['93.184.216.34'],
      '127.0.0.1.nip.io': ['127.0.0.1'],
      'meta.evil.test': ['169.254.169.254'],
      'dual.evil.test': ['93.184.216.34', '192.168.1.10'],
      'rebind.evil.test': ['::ffff:127.0.0.1'],
    };
    const lookup = async (host: string): Promise<readonly string[]> => {
      const hit = dnsTable[host];
      if (!hit) throw new Error(`ENOTFOUND ${host}`);
      return hit;
    };

    // 1. Redirect from public to hostname resolving to loopback / metadata / dual-stack private / mapped IPv6 / NXDOMAIN
    for (const target of [
      'http://127.0.0.1.nip.io/admin',
      'http://meta.evil.test/latest',
      'http://dual.evil.test/lan',
      'http://rebind.evil.test/secret',
      'http://nxdomain.evil.test/file.mp4',
    ]) {
      let calls = 0;
      await expect(
        fetchDownloadWithManualRedirects({
          initialUrl: 'https://public.example.test/movie.mp4',
          headers: {},
          signal: new AbortController().signal,
          lookup,
          fetchHop: async () => {
            calls += 1;
            return new Response(null, { status: 302, headers: { location: target } });
          },
        }),
      ).rejects.toBeInstanceOf(DownloadRedirectError);
      expect(calls).toBe(1);
    }

    // 2. Initial URL failing DNS lookup or resolving to metadata fails closed before fetchHop
    const neverCalled = vi.fn();
    await expect(
      fetchDownloadWithManualRedirects({
        initialUrl: 'https://meta.evil.test/movie.mp4',
        headers: {},
        signal: new AbortController().signal,
        lookup,
        fetchHop: neverCalled,
      }),
    ).rejects.toBeInstanceOf(DownloadRedirectError);
    await expect(
      fetchDownloadWithManualRedirects({
        initialUrl: 'https://nxdomain.evil.test/movie.mp4',
        headers: {},
        signal: new AbortController().signal,
        lookup,
        fetchHop: neverCalled,
      }),
    ).rejects.toBeInstanceOf(DownloadRedirectError);
    expect(neverCalled).not.toHaveBeenCalled();

    // 3. Hop-to-hop policy blocks private-lan -> public -> private-lan bounce
    let bounceCalls = 0;
    await expect(
      fetchDownloadWithManualRedirects({
        initialUrl: 'http://192.168.1.50/start.mp4',
        headers: {},
        signal: new AbortController().signal,
        lookup,
        fetchHop: async (url) => {
          bounceCalls += 1;
          if (url.includes('192.168.1.50')) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://public.example.test/bounce.mp4' },
            });
          }
          return new Response(null, {
            status: 302,
            headers: { location: 'http://192.168.1.99/router-admin' },
          });
        },
      }),
    ).rejects.toBeInstanceOf(DownloadRedirectError);
    expect(bounceCalls).toBe(2);
  });
});

describe('download-runner manual redirect integration', () => {
  const dirs: string[] = [];
  const managers: DesktopDownloadManager[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.dispose();
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('marks SSRF redirect downloads failed with invalid-download-url and strips credentials on cross-host 302', async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), 'elv-dl-redir-'));
    dirs.push(downloadsDir);

    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const manager = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      lookup: PUBLIC_DNS,
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
        if (url === 'https://public.example.test/ssrf.mp4') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://[::ffff:127.0.0.1]/admin' },
          });
        }
        if (url === 'https://origin.example.test/movie.mp4') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn-edge.other.test/movie.mp4' },
          });
        }
        return new Response(new Uint8Array([9, 8, 7, 6]), {
          status: 200,
          headers: { 'content-length': '4' },
        });
      },
    });
    managers.push(manager);

    await manager.enqueueBatch([
      {
        sourceId: 'src-1',
        itemKey: 'movie:ssrf',
        kind: 'movie',
        title: 'SSRF',
        streamUrl: 'https://public.example.test/ssrf.mp4',
      },
      {
        sourceId: 'src-1',
        itemKey: 'movie:cross',
        kind: 'movie',
        title: 'Cross Host',
        streamUrl: 'https://origin.example.test/movie.mp4',
        headers: { Authorization: 'Bearer top-secret', 'User-Agent': 'ELV/1.0' },
      },
    ]);

    const waitStatus = (itemKey: string, status: string) =>
      new Promise<{ status: string; errorCode?: string | null; localUri?: string | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout ${itemKey}`)), 3_000);
          const check = async () => {
            const rec = await manager.get(itemKey);
            if (rec?.status === status) {
              clearTimeout(timer);
              off();
              resolve(rec);
            }
          };
          const off = manager.subscribe(() => void check());
          void check();
        },
      );

    const ssrfRec = await waitStatus('movie:ssrf', 'failed');
    expect(ssrfRec.errorCode).toBe('invalid-download-url');

    const crossRec = await waitStatus('movie:cross', 'completed');
    expect(crossRec.localUri).toBeTruthy();
    const bytes = await readFile(fileURLToPath(crossRec.localUri ?? ''));
    expect(Array.from(bytes)).toEqual([9, 8, 7, 6]);

    const edgeReq = seen.find((s) => s.url === 'https://cdn-edge.other.test/movie.mp4');
    expect(edgeReq?.headers.Authorization).toBeUndefined();
    expect(edgeReq?.headers['User-Agent']).toBe('ELV/1.0');
    expect(seen.some((s) => s.url.includes('127.0.0.1'))).toBe(false);
  });

  it('enforces manual redirect SSRF guard on custom-transport sources (allowLegacyTls & dnsFamily) before connecting to target', async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), 'elv-dl-custom-ssrf-'));
    dirs.push(downloadsDir);

    // Local trap server simulating an internal loopback service that MUST NEVER be contacted
    let trapHits = 0;
    const trapServer = createServer((_req, res) => {
      trapHits += 1;
      res.writeHead(200, { 'Content-Length': '6' });
      res.end('secret');
    });
    servers.push(trapServer);
    await new Promise<void>((resolve) => trapServer.listen(0, '127.0.0.1', () => resolve()));
    const trapAddr = trapServer.address();
    const trapPort = typeof trapAddr === 'object' && trapAddr ? trapAddr.port : 0;

    // Origin server simulating an external CDN returning 302 -> loopback trap or cloud metadata
    let originHits = 0;
    const originServer = createServer((req, res) => {
      originHits += 1;
      if (req.url === '/to-loopback.mp4') {
        res.writeHead(302, { Location: `http://127.0.0.1:${trapPort}/steal` });
        res.end();
        return;
      }
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    servers.push(originServer);
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    const originAddr = originServer.address();
    const originPort = typeof originAddr === 'object' && originAddr ? originAddr.port : 0;

    const coordinator = {
      connectClient: async () => {
        const listeners = new Set<(ev: { readonly data: unknown }) => void>();
        return {
          clientId: 1,
          rendererPort: {
            on: (event: 'message' | 'close', listener: unknown) => {
              if (event === 'message') {
                listeners.add(listener as (ev: { readonly data: unknown }) => void);
              }
            },
            off: (event: 'message' | 'close', listener: unknown) => {
              if (event === 'message') {
                listeners.delete(listener as (ev: { readonly data: unknown }) => void);
              }
            },
            postMessage: (msg: CatalogClientMessage) => {
              if (msg.type !== 'call') return;
              const value =
                msg.call.method === 'listSources'
                  ? [
                      {
                        id: 'src-ipv4',
                        kind: 'xtream',
                        name: 'IPv4 Source',
                        createdAt: 1,
                        needsImport: false,
                        dnsFamily: 'ipv4',
                      },
                      {
                        id: 'src-legacy',
                        kind: 'xtream',
                        name: 'Legacy Source',
                        createdAt: 1,
                        needsImport: false,
                        allowLegacyTls: true,
                      },
                    ]
                  : ok({
                      url: `http://cdn.custom.test:${originPort}/to-loopback.mp4`,
                      headers: {},
                      dnsFamily: 'ipv4',
                    });
              queueMicrotask(() => {
                for (const l of listeners) {
                  l({ data: { type: 'result', reqId: msg.reqId, value } });
                }
              });
            },
            start: () => undefined,
            close: () => listeners.clear(),
          },
        };
      },
      disconnectClient: vi.fn(),
    };

    const deps = createDesktopDownloadDeps({
      getCoordinator: () => coordinator,
      httpClientOptions: {
        // Route cdn.custom.test to our local originServer inside Node transport
        dnsLookup: ((host: string, opts: unknown, cb?: unknown) => {
          const callback = (typeof opts === 'function' ? opts : cb) as (
            err: NodeJS.ErrnoException | null,
            addr: unknown,
            family?: number,
          ) => void;
          const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
          if (host === 'cdn.custom.test') {
            if (all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
            else callback(null, '127.0.0.1', 4);
            return;
          }
          callback(new Error(`unexpected lookup ${host}`) as NodeJS.ErrnoException, undefined);
        }) as never,
      },
    });

    const manager = createDesktopDownloadManager({
      downloadsDir,
      progressThrottleMs: 0,
      fetchForSource: deps.fetchForSource,
      // Classify cdn.custom.test as public in the redirect guard while transport talks to local originServer
      lookup: async (host) => (host === 'cdn.custom.test' ? ['93.184.216.34'] : ['127.0.0.1']),
    });
    managers.push(manager);

    await manager.enqueueBatch([
      {
        sourceId: 'src-ipv4',
        itemKey: 'movie:custom-loopback',
        kind: 'movie',
        title: 'Custom IPv4 Loopback SSRF',
        streamUrl: `http://cdn.custom.test:${originPort}/to-loopback.mp4`,
      },
      {
        sourceId: 'src-legacy',
        itemKey: 'movie:custom-meta',
        kind: 'movie',
        title: 'Custom Legacy Metadata SSRF',
        streamUrl: `http://cdn.custom.test:${originPort}/to-meta.mp4`,
      },
    ]);

    const waitFailed = (itemKey: string) =>
      new Promise<{ status: string; errorCode?: string | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout ${itemKey}`)), 3_000);
        const check = async () => {
          const rec = await manager.get(itemKey);
          if (rec?.status === 'failed' || rec?.status === 'completed') {
            clearTimeout(timer);
            off();
            resolve(rec);
          }
        };
        const off = manager.subscribe(() => void check());
        void check();
      });

    const r1 = await waitFailed('movie:custom-loopback');
    const r2 = await waitFailed('movie:custom-meta');
    expect(r1.status).toBe('failed');
    expect(r1.errorCode).toBe('invalid-download-url');
    expect(r2.status).toBe('failed');
    expect(r2.errorCode).toBe('invalid-download-url');
    expect(originHits).toBe(2);
    expect(trapHits).toBe(0);
  });
});
