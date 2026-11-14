import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/sim/accounts.ts';
import { buildCatalog } from '../src/sim/catalog.ts';
import { activeChildren, findFfmpeg, MEDIA_SKIP_MARKER } from '../src/sim/media.ts';
import { hlsRedirectPath } from '../src/sim/request-faults.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';
import { packetPids } from './ts-packets.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') {
  throw new Error('ffmpeg is required in CI');
}
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`sim-delivery: ${MEDIA_SKIP_MARKER}\n`);

const demo = ACCOUNTS.find((a) => a.username === 'demo');
if (!demo) throw new Error('demo account missing');
const pair = `${demo.username}/${demo.password}`;
const movie = buildCatalog(demo.profile, 1).movies[0];
if (!movie) throw new Error('catalog has no movie');

const open: SimHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function sim(ffmpegPath: string | null = null, cacheDir?: string): Promise<SimHandle> {
  const handle = await startSim({
    port: 0,
    clock: new Date('2026-01-01T12:00:00Z'),
    ffmpegPath,
    mediaSeconds: 4,
    ...(cacheDir === undefined ? {} : { cacheDir }),
  });
  open.push(handle);
  return handle;
}

const manual = (url: string): Promise<Response> => fetch(url, { redirect: 'manual' });

/** Reads the first chunk of a response body and cancels the rest. */
async function firstChunk(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  const chunk = await reader?.read();
  await reader?.cancel();
  return Buffer.from(chunk?.value ?? new Uint8Array());
}

describe('hlsRedirectPath', () => {
  it('maps the live account forms only', () => {
    expect(hlsRedirectPath(`/live/${pair}/1001`)).toBe(`/live/${pair}/1001.m3u8`);
    expect(hlsRedirectPath(`/live/${pair}/1001.ts`)).toBe(`/live/${pair}/1001.m3u8`);
    expect(hlsRedirectPath(`/${pair}/1001`)).toBe(`/live/${pair}/1001.m3u8`);
    for (const p of [
      `/live/${pair}/1001.m3u8`,
      '/alice/x/1001',
      `/movie/${pair}/200001.mp4`,
      '/playlists/small.m3u',
    ])
      expect(hlsRedirectPath(p)).toBeNull();
  });
});

describe('redirect=hls', () => {
  it('sends live URL forms to the .m3u8', async () => {
    const handle = await sim();
    const target = `${handle.url}/live/${pair}/1001.m3u8`;
    const res = await manual(`${handle.url}/live/${pair}/1001?x=1&fault=redirect=hls`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${target}?x=1`);
    for (const path of [`/live/${pair}/1001.ts`, `/${pair}/1001`]) {
      const other = await manual(`${handle.url}${path}?fault=redirect=hls`);
      expect(other.status, path).toBe(302);
      expect(other.headers.get('location'), path).toBe(target);
    }
  });

  it('is skipped where it does not apply', async () => {
    const handle = await sim();
    const playlist = await fetch(`${handle.url}/live/${pair}/1001.m3u8?fault=redirect=hls`);
    expect(playlist.status).toBe(503);
    await playlist.text();
    const m3u = await fetch(`${handle.url}/playlists/small.m3u?fault=redirect=hls`);
    expect(m3u.status).toBe(200);
    await m3u.text();
  });

  it('a rule without a count redirects the TS once and serves the playlist', async () => {
    const handle = await sim();
    await fetch(`${handle.url}/_sim/faults`, {
      method: 'POST',
      body: JSON.stringify({ account: 'demo', stream: '1001', spec: 'redirect=hls' }),
    });
    const ts = await manual(`${handle.url}/live/${pair}/1001.ts`);
    expect(ts.status).toBe(302);
    const location = ts.headers.get('location') ?? '';
    expect(new URL(location).pathname).toBe(`/live/${pair}/1001.m3u8`);
    const playlist = await fetch(location);
    expect(playlist.status).toBe(503);
    await playlist.text();
    const log = handle.requests().slice(-2);
    expect(log.map((e) => e.faultRule)).toEqual(['r1', 'r1']);
  });
});

withFfmpeg('delivery quirks with media', () => {
  let cacheDir = '';
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-delivery-'));
  });
  afterAll(async () => {
    const until = Date.now() + 3000;
    while (activeChildren() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('extensionless live URLs serve TS', async () => {
    const handle = await sim(ffmpeg, cacheDir);
    const res = await fetch(`${handle.url}/live/${pair}/1001`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    const data = await firstChunk(res);
    expect(data[0]).toBe(0x47);
    expect(packetPids(data, 10)).toContain(0);
  }, 60_000);

  it('type=text/html relabels live TS and the live playlist', async () => {
    const handle = await sim(ffmpeg, cacheDir);
    const ts = await fetch(`${handle.url}/live/${pair}/1001.ts?fault=type=text/html`);
    expect(ts.headers.get('content-type')).toBe('text/html');
    expect((await firstChunk(ts))[0]).toBe(0x47);
    const list = await fetch(`${handle.url}/live/${pair}/1001.m3u8?fault=type=text/html`);
    expect(list.headers.get('content-type')).toBe('text/html');
    expect((await list.text()).startsWith('#EXTM3U')).toBe(true);
  }, 60_000);

  it('type= relabels a ranged movie', async () => {
    const handle = await sim(ffmpeg, cacheDir);
    const url = `${handle.url}/movie/${pair}/${movie.id}.mp4?fault=type=application/octet-stream`;
    const res = await fetch(url, { headers: { range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  }, 60_000);
});
