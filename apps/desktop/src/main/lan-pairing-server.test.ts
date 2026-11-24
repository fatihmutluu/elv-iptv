import { request as httpRequest } from 'node:http';
import type { NetworkInterfaceInfo } from 'node:os';
import { LAN_PAIRING_MAX_BODY_BYTES, type LanPairingPayload } from '@elv/sources';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLanPairingBridge } from '../preload/lan-pairing-bridge.ts';
import { LAN_PAIRING_CHANNELS } from '../shared/lan-pairing-ipc.ts';
import { registerLanPairingIpc } from './lan-pairing-ipc.ts';
import {
  createLanPairingServer,
  discoverLanIpv4,
  type LanPairingServer,
} from './lan-pairing-server.ts';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function sendRawHttp(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const activeServers: LanPairingServer[] = [];

function trackServer(server: LanPairingServer): LanPairingServer {
  activeServers.push(server);
  return server;
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) await srv.stop();
  }
});

describe('discoverLanIpv4', () => {
  it('prefers non-internal RFC1918 Wi-Fi/Ethernet addresses over virtual and loopback interfaces', () => {
    const makeInfo = (address: string, internal = false): NetworkInterfaceInfo => ({
      address,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:11:22:33:44:55',
      internal,
      cidr: `${address}/24`,
    });

    expect(
      discoverLanIpv4({
        lo: [makeInfo('127.0.0.1', true)],
        'vEthernet (WSL)': [makeInfo('172.25.16.1')],
        'Wi-Fi': [makeInfo('192.168.1.42')],
      }),
    ).toBe('192.168.1.42');

    expect(
      discoverLanIpv4({
        lo: [makeInfo('127.0.0.1', true)],
        eth0: [makeInfo('203.0.113.10')],
      }),
    ).toBeNull();
  });
});

describe('createLanPairingServer (#50)', () => {
  it('rejects start() with lan-unavailable when no private LAN interface exists and advertiseHost is not injected', async () => {
    const makeInfo = (address: string, internal = false): NetworkInterfaceInfo => ({
      address,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:11:22:33:44:55',
      internal,
      cidr: `${address}/24`,
    });
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        getNetworkInterfaces: () => ({
          lo: [makeInfo('127.0.0.1', true)],
          eth0: [makeInfo('203.0.113.10')],
        }),
      }),
    );

    await expect(server.start()).rejects.toThrow('lan-unavailable');
    expect(server.isActive()).toBe(false);
  });

  it('serves self-contained HTML with no-store and nosniff headers on GET /pair/<token>', async () => {
    const server = trackServer(
      createLanPairingServer({ bindHost: '127.0.0.1', advertiseHost: '127.0.0.1' }),
    );
    const session = await server.start({ locale: 'tr' });

    expect(session.host).toBe('127.0.0.1');
    expect(session.port).toBeGreaterThan(0);
    expect(session.token).toMatch(/^[0-9a-f]{48}$/);
    expect(session.url).toBe(`http://127.0.0.1:${session.port}/pair/${session.token}`);

    const res = await sendRawHttp({
      port: session.port,
      method: 'GET',
      path: `/pair/${session.token}`,
      headers: { Host: `127.0.0.1:${session.port}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.body).toContain('<html lang="tr">');
    expect(res.body).toContain(`/pair/${session.token}`);
    expect(server.isActive()).toBe(true);
  });

  it('returns 404 on wrong token and locks out after 5 failed attempts', async () => {
    const closedReasons: string[] = [];
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        onClosed: (reason) => closedReasons.push(reason),
      }),
    );
    const session = await server.start();

    for (let i = 0; i < 5; i += 1) {
      const res = await sendRawHttp({
        port: session.port,
        method: 'GET',
        path: `/pair/${'0'.repeat(48)}`,
        headers: { Host: `127.0.0.1:${session.port}` },
      });
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
    }

    await vi.waitFor(() => {
      expect(server.isActive()).toBe(false);
    });
    expect(closedReasons).toContain('locked-out');
  });

  it('rejects bad Host headers (DNS rebinding) and cross-origin POST Origin headers', async () => {
    const payloads: LanPairingPayload[] = [];
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        onPayload: (p) => payloads.push(p),
      }),
    );
    const session = await server.start();

    const badHost = await sendRawHttp({
      port: session.port,
      method: 'GET',
      path: `/pair/${session.token}`,
      headers: { Host: `evil.example:${session.port}` },
    });
    expect(badHost.status).toBe(403);

    const badOrigin = await sendRawHttp({
      port: session.port,
      method: 'POST',
      path: `/pair/${session.token}`,
      headers: {
        Host: `127.0.0.1:${session.port}`,
        Origin: 'http://attacker.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'm3u', url: 'https://example.com/list.m3u' }),
    });
    expect(badOrigin.status).toBe(403);
    expect(payloads).toEqual([]);
  });

  it('rejects non-private peer addresses with 403', async () => {
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        resolvePeerIp: () => '8.8.8.8',
      }),
    );
    const session = await server.start();

    const res = await sendRawHttp({
      port: session.port,
      method: 'GET',
      path: `/pair/${session.token}`,
      headers: { Host: `127.0.0.1:${session.port}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects oversized POST bodies (> 16 KiB) with 413 Payload Too Large', async () => {
    const payloads: LanPairingPayload[] = [];
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        onPayload: (p) => payloads.push(p),
      }),
    );
    const session = await server.start();

    const oversized = JSON.stringify({
      kind: 'm3u',
      name: 'Big',
      url: `https://example.com/${'a'.repeat(LAN_PAIRING_MAX_BODY_BYTES + 256)}`,
    });

    const res = await sendRawHttp({
      port: session.port,
      method: 'POST',
      path: `/pair/${session.token}`,
      headers: {
        Host: `127.0.0.1:${session.port}`,
        Origin: `http://127.0.0.1:${session.port}`,
        'Content-Type': 'application/json',
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(payloads).toEqual([]);
  });

  it('emits validated LanPairingPayload on valid POST and immediately closes the server', async () => {
    const payloads: LanPairingPayload[] = [];
    const closedReasons: string[] = [];
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        onPayload: (p) => payloads.push(p),
        onClosed: (reason) => closedReasons.push(reason),
      }),
    );
    const session = await server.start();

    const res = await sendRawHttp({
      port: session.port,
      method: 'POST',
      path: `/pair/${session.token}`,
      headers: {
        Host: `127.0.0.1:${session.port}`,
        Origin: `http://127.0.0.1:${session.port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'xtream',
        name: 'Living Room',
        server: 'https://iptv.example.com:8080',
        username: 'demo_user',
        password: 'demo_password',
        guideUrl: 'https://iptv.example.com/epg.xml',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(payloads).toEqual([
      {
        kind: 'xtream',
        name: 'Living Room',
        server: 'https://iptv.example.com:8080',
        username: 'demo_user',
        password: 'demo_password',
        guideUrl: 'https://iptv.example.com/epg.xml',
      },
    ]);

    await vi.waitFor(() => {
      expect(server.isActive()).toBe(false);
    });
    expect(closedReasons).toContain('delivered');

    await expect(
      sendRawHttp({
        port: session.port,
        method: 'GET',
        path: `/pair/${session.token}`,
        headers: { Host: `127.0.0.1:${session.port}` },
      }),
    ).rejects.toThrow();
  });

  it('auto-closes when TTL expires', async () => {
    const closedReasons: string[] = [];
    const server = trackServer(
      createLanPairingServer({
        bindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        ttlMs: 40,
        onClosed: (reason) => closedReasons.push(reason),
      }),
    );
    await server.start();
    expect(server.isActive()).toBe(true);

    await vi.waitFor(() => {
      expect(server.isActive()).toBe(false);
    });
    expect(closedReasons).toContain('expired');
  });
});

describe('LAN pairing IPC and preload bridge (#50)', () => {
  it('bridges startSession, payload delivery, and stopSession cleanly between preload and main', async () => {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>();
    const rendererListeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();

    const sender = {
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        for (const fn of rendererListeners.get(channel) ?? []) {
          fn({}, ...args);
        }
      },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    };

    const server = trackServer(
      createLanPairingServer({ bindHost: '127.0.0.1', advertiseHost: '127.0.0.1' }),
    );
    const ipcHandle = registerLanPairingIpc({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
      },
      server,
    });

    const bridge = createLanPairingBridge({
      invoke: async (channel, ...args) => {
        const fn = handlers.get(channel);
        if (!fn) throw new Error(`missing handler ${channel}`);
        return fn({ sender }, ...args);
      },
      on: (channel, listener) => {
        let set = rendererListeners.get(channel);
        if (!set) {
          set = new Set();
          rendererListeners.set(channel, set);
        }
        set.add(listener);
      },
      removeListener: (channel, listener) => {
        rendererListeners.get(channel)?.delete(listener);
      },
    });

    const received: LanPairingPayload[] = [];
    const off = bridge.onPayloadReceived((payload) => received.push(payload));

    try {
      const session = await bridge.startSession({ locale: 'en' });
      expect(session.url).toContain('/pair/');

      const res = await sendRawHttp({
        port: session.port,
        method: 'POST',
        path: `/pair/${session.token}`,
        headers: {
          Host: `127.0.0.1:${session.port}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ kind: 'm3u', name: 'Phone M3U', url: 'https://example.com/a.m3u' }),
      });
      expect(res.status).toBe(200);
      expect(received).toEqual([
        { kind: 'm3u', name: 'Phone M3U', url: 'https://example.com/a.m3u' },
      ]);

      await bridge.stopSession();
      expect(server.isActive()).toBe(false);
    } finally {
      off();
      await ipcHandle.dispose();
    }

    expect(handlers.has(LAN_PAIRING_CHANNELS.start)).toBe(false);
    expect(handlers.has(LAN_PAIRING_CHANNELS.stop)).toBe(false);
  });
});
