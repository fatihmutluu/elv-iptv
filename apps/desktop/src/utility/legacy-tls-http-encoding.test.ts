import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { createHostConnectivityGuard, type FetchLike } from '@elv/domain';
import { scanXmltv } from '@elv/sources';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopHttpClient, createSmartInflate } from './legacy-tls-http.ts';
import { createNodeGzipDecompressor } from './node-gzip-decompressor.ts';

function unusedFetch(): FetchLike {
  return vi.fn(async () => {
    throw new Error('default fetch should not be called');
  });
}

async function drainBytes(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

const activeServers: http.Server[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
});

async function startServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler);
  activeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('createDesktopHttpClient custom Node transport Content-Encoding (NET-1)', () => {
  it('inflates gzip, br, deflate (zlib), raw RFC 1951 deflate, and stacked gzip, br responses', async () => {
    const jsonPayload = JSON.stringify({
      user_info: { status: 'Active' },
      channels: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Channel ${i}` })),
    });
    const rawBuf = Buffer.from(jsonPayload, 'utf8');

    const { baseUrl } = await startServer((req, res) => {
      switch (req.url) {
        case '/gzip': {
          const gz = zlib.gzipSync(rawBuf);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': String(gz.length),
          });
          res.end(gz);
          return;
        }
        case '/br': {
          const br = zlib.brotliCompressSync(rawBuf);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'br',
            'content-length': String(br.length),
          });
          res.end(br);
          return;
        }
        case '/deflate-zlib': {
          const df = zlib.deflateSync(rawBuf);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'deflate',
            'content-length': String(df.length),
          });
          res.end(df);
          return;
        }
        case '/deflate-raw': {
          const rawDf = zlib.deflateRawSync(rawBuf);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'deflate',
            'content-length': String(rawDf.length),
          });
          res.end(rawDf);
          return;
        }
        case '/stacked': {
          // Applied in order: gzip first, then br second -> receiver must decode br then gzip
          const stacked = zlib.brotliCompressSync(zlib.gzipSync(rawBuf));
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip, identity, br',
            'content-length': String(stacked.length),
          });
          res.end(stacked);
          return;
        }
        default:
          res.writeHead(404);
          res.end();
      }
    });

    const client = createDesktopHttpClient(unusedFetch());
    for (const path of ['/gzip', '/br', '/deflate-zlib', '/deflate-raw', '/stacked']) {
      const res = await client.get(`${baseUrl}${path}`, { dnsFamily: 'ipv4' });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.value.headers['content-encoding']).toBeUndefined();
      expect(res.value.headers['content-length']).toBeUndefined();
      const bodyText = (await drainBytes(res.value.body)).toString('utf8');
      expect(bodyText).toBe(jsonPayload);
    }
  });

  it('handles 204, 205, 304, and 0-byte 200 responses with Content-Encoding without throwing', async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === '/204') {
        res.writeHead(204, { 'content-encoding': 'gzip' });
        res.end();
        return;
      }
      if (req.url === '/205') {
        res.writeHead(205, { 'content-encoding': 'deflate' });
        res.end();
        return;
      }
      if (req.url === '/304') {
        res.writeHead(304, { 'content-encoding': 'br', etag: '"v1"' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-encoding': 'deflate', 'content-length': '0' });
      res.end();
    });

    const client = createDesktopHttpClient(unusedFetch());
    for (const path of ['/204', '/205', '/304', '/empty-200']) {
      const res = await client.get(`${baseUrl}${path}`, { dnsFamily: 'ipv4' });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect((await drainBytes(res.value.body)).length).toBe(0);
    }
  });

  it('decodes double-compressed Content-Encoding: gzip + .xml.gz cleanly with downstream decodeMaybeGzip', async () => {
    const xml = '<tv><channel id="c1"><display-name>Double Gzip</display-name></channel></tv>';
    const fileLevelGz = zlib.gzipSync(Buffer.from(xml, 'utf8'));
    const transportLevelGz = zlib.gzipSync(fileLevelGz);

    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-encoding': 'gzip',
      });
      res.end(transportLevelGz);
    });

    const client = createDesktopHttpClient(unusedFetch());
    const res = await client.get(`${baseUrl}/guide.xml.gz`, { dnsFamily: 'ipv4' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const channels: Array<{ id: string; name: string | undefined }> = [];
    const gen = scanXmltv(res.value.body, { decompressor: createNodeGzipDecompressor() });
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value).toEqual({ ok: true, value: undefined });
        break;
      }
      for (const ch of step.value.channels) channels.push({ id: ch.id, name: ch.names[0] });
    }
    expect(channels).toEqual([{ id: 'c1', name: 'Double Gzip' }]);
  });

  it('propagates corrupt compressed stream errors and cleans up on abort', async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url === '/corrupt') {
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(Buffer.from('not-actually-gzip-bytes-at-all'));
        return;
      }
      res.writeHead(200, { 'content-encoding': 'gzip' });
      const gz = zlib.createGzip();
      gz.pipe(res);
      gz.write('a'.repeat(16 * 1024));
      gz.flush();
      res.once('close', () => gz.destroy());
    });

    const client = createDesktopHttpClient(unusedFetch());
    const corruptRes = await client.get(`${baseUrl}/corrupt`, { dnsFamily: 'ipv4' });
    expect(corruptRes.ok).toBe(true);
    if (corruptRes.ok) {
      await expect(drainBytes(corruptRes.value.body)).rejects.toThrow();
    }

    const ctl = new AbortController();
    const slowRes = await client.get(`${baseUrl}/slow`, {
      dnsFamily: 'ipv4',
      signal: ctl.signal,
    });
    expect(slowRes.ok).toBe(true);
    if (slowRes.ok) {
      let chunks = 0;
      await expect(async () => {
        for await (const _chunk of slowRes.value.body) {
          chunks += 1;
          ctl.abort();
        }
      }).rejects.toThrow('aborted');
      expect(chunks).toBeGreaterThanOrEqual(1);
    }
  });

  it('marks TCP connect on slow Node transport responses so header timeouts never trip HostConnectivityGuard', async () => {
    const openResponses: http.ServerResponse[] = [];
    const { baseUrl } = await startServer((_req, res) => {
      // Accept TCP socket immediately, delay HTTP headers past timeoutMs
      openResponses.push(res);
    });
    try {
      const guard = createHostConnectivityGuard();
      const client = createDesktopHttpClient(unusedFetch(), { connectivityGuard: guard });
      for (let i = 0; i < 3; i++) {
        const res = await client.get(`${baseUrl}/slow-headers`, {
          dnsFamily: 'ipv4',
          timeoutMs: 80,
        });
        expect(res).toEqual({ ok: false, error: { category: 'network', code: 'timeout' } });
      }
      // Because TCP connected on each attempt, circuit must remain closed!
      expect(guard.acquire(`${baseUrl}/next`).allowed).toBe(true);
    } finally {
      for (const r of openResponses) r.destroy();
    }
  });

  it('handles Z_DATA_ERROR raw-deflate fallback under backpressure, caps replay buffer, and pauses inflate when downstream stops reading (B4)', async () => {
    // (a) Valid RFC 1951 raw deflate whose first 2 bytes (0x08, 0x1d) pass RFC 1950 zlib header check
    const p1 = Buffer.from('A'.repeat(29));
    const p2 = Buffer.from('B'.repeat(40_000));
    const rawColliding = Buffer.concat([
      Buffer.from([0x08, 0x1d, 0x00, 0xe2, 0xff]),
      p1,
      zlib.deflateRawSync(p2),
    ]);
    const smart = createSmartInflate({ highWaterMark: 16 });
    const outChunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      smart.on('data', (c: Buffer) => outChunks.push(c));
      smart.on('end', resolve);
      smart.on('error', reject);
    });
    // Write in small chunks so backpressure triggers pendingWriteCb before Z_DATA_ERROR
    for (let off = 0; off < rawColliding.length; off += 32) {
      const slice = rawColliding.subarray(off, Math.min(rawColliding.length, off + 32));
      if (!smart.write(slice)) {
        await new Promise<void>((resolve) => smart.once('drain', resolve));
      }
    }
    smart.end();
    await done;
    expect(Buffer.concat(outChunks)).toEqual(Buffer.concat([p1, p2]));

    // (b) >64 KiB of zero-output zlib-header data disables replay fallback rather than growing unboundedly
    const hugeZeroOutput = createSmartInflate();
    const zeroErr = new Promise<Error>((resolve) => {
      hugeZeroOutput.once('error', resolve);
    });
    // Valid zlib header 0x78 0x9c followed by >64 KiB of unclosed fixed/stored invalid deflate that produces 0 bytes
    // Wait: a valid zlib header + non-final empty stored blocks (0x00 0x00 0x00 0xff 0xff repeated 14,000 times = 70 KiB producing 0 output bytes!)
    // followed by a corrupt byte triggering Z_DATA_ERROR after >64 KiB!
    const emptyStoredBlock = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);
    hugeZeroOutput.write(Buffer.from([0x78, 0x9c]));
    const blockBatch = Buffer.concat(Array.from({ length: 14_000 }, () => emptyStoredBlock)); // 70,000 bytes, 0 output bytes
    hugeZeroOutput.write(blockBatch);
    // Corrupt block (BTYPE=11 -> invalid block type -> Z_DATA_ERROR)
    hugeZeroOutput.write(Buffer.from([0x06, 0x00]));
    hugeZeroOutput.end();
    const errSeen = await zeroErr;
    expect((errSeen as NodeJS.ErrnoException).code).toBe('Z_DATA_ERROR');

    // (c) Pausing downstream applies backpressure so a 2 MiB deflate expansion stays bounded in readableLength
    const twoMbZeros = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const compressed = zlib.deflateSync(twoMbZeros);
    const pausedInflate = createSmartInflate({ highWaterMark: 16 * 1024 });
    // Feed compressed stream WITHOUT attaching a 'data' consumer
    pausedInflate.end(compressed);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    // Must stay far below full 2 MiB expansion when paused!
    expect(pausedInflate.readableLength).toBeLessThan(512 * 1024);
    // Resuming drains all 2 MiB cleanly
    const drained: Buffer[] = [];
    for await (const c of pausedInflate) drained.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    expect(Buffer.concat(drained).length).toBe(twoMbZeros.length);
  });

  it('modernClient does not trip HostConnectivityGuard on slow header timeouts, but trips on UND_ERR_CONNECT_TIMEOUT / ECONNREFUSED (M6)', async () => {
    const guard = createHostConnectivityGuard();
    let mode: 'slow-timeout' | 'connect-timeout' = 'slow-timeout';
    const modernFetch: FetchLike = vi.fn<FetchLike>((_url, init) => {
      if (mode === 'slow-timeout') {
        return new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('Connect Timeout Error'), {
            code: 'UND_ERR_CONNECT_TIMEOUT',
          }),
        }),
      );
    });
    const client = createDesktopHttpClient(modernFetch, { connectivityGuard: guard });

    // Slow-but-connected header timeouts on modernClient (no TCP connect hook) must NOT open circuit
    for (let i = 0; i < 3; i++) {
      const res = await client.get('https://slow-modern.example/api', { timeoutMs: 15 });
      expect(res).toEqual({ ok: false, error: { category: 'network', code: 'timeout' } });
    }
    expect(guard.acquire('https://slow-modern.example/api').allowed).toBe(true);

    // Explicit Undici pre-connect failure codes DO trip the circuit
    mode = 'connect-timeout';
    expect((await client.get('https://dead-modern.example/1')).ok).toBe(false);
    expect((await client.get('https://dead-modern.example/2')).ok).toBe(false);
    const blocked = await client.get('https://dead-modern.example/3');
    expect(blocked).toEqual({
      ok: false,
      error: { category: 'network', code: 'host-unreachable' },
    });
  });
});
