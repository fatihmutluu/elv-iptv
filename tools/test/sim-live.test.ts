import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, type Account } from '../src/sim/accounts.ts';
import { applyStreamFaults, parseFaults } from '../src/sim/faults.ts';
import { hlsPlaylist } from '../src/sim/hls.ts';
import { activeChildren, ensureRecipe, findFfmpeg, MEDIA_SKIP_MARKER } from '../src/sim/media.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';
import { packetPids, startsWithKeyframe } from './ts-packets.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') {
  throw new Error('ffmpeg is required in CI');
}
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`sim-live: ${MEDIA_SKIP_MARKER}\n`);

function account(name: string): Account {
  const found = ACCOUNTS.find((a) => a.username === name);
  if (!found) throw new Error(`account ${name} missing`);
  return found;
}
const pairOf = (a: Account): string => `${a.username}/${a.password}`;
const demoAccount = account('demo');
const demo = pairOf(demoAccount);
const wrongPassword = `${demoAccount.password}-wrong`;
const large = pairOf(account('large'));
const compat = pairOf(account('compat'));

const open: SimHandle[] = [];
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const c of aborts.splice(0)) c.abort();
  await Promise.all(open.splice(0).map((h) => h.close()));
  await waitFor(() => activeChildren() === 0, 3000);
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Opens a streaming request and returns once the first chunk arrived. */
async function hold(url: string): Promise<{ res: Response; first: Uint8Array; abort(): void }> {
  const controller = new AbortController();
  aborts.push(controller);
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body?.getReader();
  const chunk = await reader?.read();
  return { res, first: chunk?.value ?? new Uint8Array(), abort: () => controller.abort() };
}

function ticker(): Readable {
  return new Readable({
    read() {
      setTimeout(() => this.push(Buffer.alloc(1024)), 50);
    },
  });
}

describe('applyStreamFaults', () => {
  afterEach(() => vi.useRealTimers());

  it('drops the stream with an error after the given time', async () => {
    vi.useFakeTimers();
    const out = applyStreamFaults(ticker(), parseFaults('drop@1s'), Date.now);
    const t0 = Date.now();
    let failedAt = 0;
    out.on('data', () => undefined);
    out.on('error', () => {
      failedAt = Date.now() - t0;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(failedAt).toBeGreaterThanOrEqual(1000);
    expect(failedAt).toBeLessThanOrEqual(1200);
  });

  it('pauses delivery for the stall time and then resumes', async () => {
    vi.useFakeTimers();
    const out = applyStreamFaults(ticker(), parseFaults('stall1s@1s'), Date.now);
    const times: number[] = [];
    out.on('data', () => times.push(Date.now()));
    await vi.advanceTimersByTimeAsync(4000);
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1200);
    expect(times.length).toBeGreaterThan(40);
  });

  it('limits throughput to the rate', async () => {
    vi.useFakeTimers();
    const out = applyStreamFaults(ticker(), parseFaults('rate=8'), Date.now);
    let bytes = 0;
    out.on('data', (c: Buffer) => {
      bytes += c.length;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(bytes).toBeGreaterThan(3000);
    expect(bytes).toBeLessThanOrEqual(6000);
  });

  it('passes data through untouched without faults', async () => {
    const out = applyStreamFaults(Readable.from([Buffer.from('abc'), Buffer.from('def')]), []);
    const parts: Buffer[] = [];
    for await (const c of out) parts.push(c as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('abcdef');
  });
});

/** Segment numbers that directly follow a discontinuity tag. */
function taggedSegments(text: string): number[] {
  const out: number[] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line === '#EXT-X-DISCONTINUITY')
      out.push(Number(/(\d+)\.ts$/.exec(lines[i + 2] ?? '')?.[1]));
  }
  return out;
}

const number = (text: string, tag: string): number =>
  Number(new RegExp(`#EXT-X-${tag}:(\\d+)`).exec(text)?.[1]);

describe('hlsPlaylist numbering', () => {
  const epoch = Date.UTC(2026, 0, 1);
  it.each([2, 3, 5])('numbers discontinuities for %i segments per RFC 8216', (count) => {
    let previous: string | null = null;
    for (let n = 0; n < 40; n++) {
      const text = hlsPlaylist('h264-aac-720p25', count, epoch + n * 2000 + 500);
      expect(number(text, 'MEDIA-SEQUENCE')).toBe(n);
      let removed = 0;
      for (let m = 1; m < n; m++) if (m % count === 0) removed++;
      expect(number(text, 'DISCONTINUITY-SEQUENCE')).toBe(removed);
      const expected = [...Array(6).keys()]
        .map((i) => n + i)
        .filter((s) => s > 0 && s % count === 0);
      expect(taggedSegments(text)).toEqual(expected);
      if (previous !== null) {
        const leaving = n - 1 > 0 && (n - 1) % count === 0 ? 1 : 0;
        expect(number(text, 'DISCONTINUITY-SEQUENCE')).toBe(
          number(previous, 'DISCONTINUITY-SEQUENCE') + leaving,
        );
      }
      previous = text;
    }
  });

  it('never decreases across a segment boundary', () => {
    const before = hlsPlaylist('h264-aac-720p25', 2, epoch + 59_999);
    const after = hlsPlaylist('h264-aac-720p25', 2, epoch + 60_000);
    expect(number(after, 'MEDIA-SEQUENCE')).toBe(number(before, 'MEDIA-SEQUENCE') + 1);
    expect(number(after, 'DISCONTINUITY-SEQUENCE')).toBeGreaterThanOrEqual(
      number(before, 'DISCONTINUITY-SEQUENCE'),
    );
  });
});

describe('routes that need no media', () => {
  it('answers 503 for channel 1013 and logs the fault', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    const res = await fetch(`${sim.url}/live/${demo}/1013.ts`);
    expect(res.status).toBe(503);
    const entry = sim.requests().at(-1);
    expect(entry?.fault).toBe('status=503');
    expect(entry?.streamId).toBe(1013);
  });

  it('redirects /redirect/<id>.ts to the compat live URL', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    const res = await fetch(`${sim.url}/redirect/1001.ts`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '', sim.url).pathname).toBe(
      `/live/${compat}/1001.ts`,
    );
    expect(sim.requests()[0]?.path).toBe('/redirect/1001.ts');
  });

  it('builds the redirect target from the request Host', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    const port = new URL(sim.url).port;
    const location = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/redirect/1001.ts',
          headers: { host: `10.0.2.2:${port}` },
        },
        (res) => {
          res.resume();
          resolve(String(res.headers.location));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(location.startsWith(`http://10.0.2.2:${port}/live/`)).toBe(true);
  });

  it('rejects bad credentials and unknown channels, and needs FFmpeg for media', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    expect(
      (await fetch(`${sim.url}/live/${demoAccount.username}/${wrongPassword}/1001.ts`)).status,
    ).toBe(401);
    expect((await fetch(`${sim.url}/live/${demo}/999999.ts`)).status).toBe(404);
    expect((await fetch(`${sim.url}/live/${demo}/1001.ts`)).status).toBe(503);
  });
});

withFfmpeg('live streams', () => {
  let cacheDir = '';
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-live-'));
  });
  afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
  const start = async (clock?: Date): Promise<SimHandle> => {
    const sim = await startSim({
      port: 0,
      mediaSeconds: 4,
      cacheDir,
      ffmpegPath: ffmpeg,
      ...(clock ? { clock } : {}),
    });
    open.push(sim);
    return sim;
  };

  it('live TS starts with a PAT', async () => {
    const sim = await start();
    for (const path of [`/live/${demo}/1001.ts`, `/${demo}/1001`]) {
      const got = await hold(`${sim.url}${path}`);
      expect(got.res.status).toBe(200);
      expect(got.res.headers.get('content-type')).toBe('video/mp2t');
      const data = Buffer.from(got.first);
      expect(data[0]).toBe(0x47);
      expect(packetPids(data, 10)).toContain(0);
      expect(startsWithKeyframe(data)).toBe(true);
      got.abort();
      await waitFor(() => activeChildren() === 0);
    }
    await waitFor(() => sim.requests().length === 2);
    const entry = sim.requests()[0];
    expect(entry?.streamId).toBe(1001);
    expect(entry?.recipe).toBeTruthy();
  }, 60_000);

  it('frees the slot and kills ffmpeg when the client aborts', async () => {
    const sim = await start();
    const got = await hold(`${sim.url}/live/${demo}/1001.ts`);
    expect(activeChildren()).toBe(1);
    await fetch(`${sim.url}/live/${demo}/1001.m3u8`);
    expect(sim.requests().at(-1)?.openConnections).toBe(1);
    got.abort();
    await waitFor(() => activeChildren() === 0);
    await fetch(`${sim.url}/live/${demo}/1001.m3u8`);
    expect(sim.requests().at(-1)?.openConnections).toBe(0);
    const again = await hold(`${sim.url}/live/${demo}/1001.ts`);
    expect(again.res.status).toBe(200);
  }, 60_000);

  it('enforces the connection limit', async () => {
    const sim = await start();
    await hold(`${sim.url}/live/${demo}/1001.ts`);
    expect((await fetch(`${sim.url}/live/${demo}/1001.ts`)).status).toBe(509);
    await hold(`${sim.url}/live/${large}/1001.ts`);
    await hold(`${sim.url}/live/${large}/1002.ts`);
    expect((await fetch(`${sim.url}/live/${large}/1003.ts`)).status).toBe(403);
    await hold(`${sim.url}/live/${compat}/1001.ts`);
    const notice = await fetch(`${sim.url}/live/${compat}/1001.ts`);
    expect(notice.status).toBe(200);
    expect(notice.headers.get('content-type')).toContain('text/plain');
    expect(await notice.text()).toBe('Max connections reached');
  }, 60_000);

  it('serves an HLS window that follows the sim clock', async () => {
    const sim = await start(new Date('2026-01-01T00:01:00Z'));
    const res = await fetch(`${sim.url}/live/${demo}/1001.m3u8`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('#EXT-X-VERSION:3');
    expect(text).toContain('#EXT-X-TARGETDURATION:2');
    const seq = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1]);
    expect([30, 31]).toContain(seq);
    const files = await ensureRecipe('h264-aac-720p25', {
      ffmpeg: ffmpeg as string,
      cacheDir,
      seconds: 4,
    });
    const count = files.segmentCount;
    expect(text.match(/#EXTINF:2\.000,/g)).toHaveLength(6);
    const segments = text.split('\n').filter((l) => l.endsWith('.ts'));
    expect(segments.map((s) => Number(/(\d+)\.ts$/.exec(s)?.[1]))).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => seq + i),
    );
    expect(number(text, 'DISCONTINUITY-SEQUENCE')).toBe(Math.floor((seq - 1) / count));
    expect(taggedSegments(text)).toEqual(
      segments.map((s) => Number(/(\d+)\.ts$/.exec(s)?.[1])).filter((n) => n % count === 0),
    );
    const segment = await fetch(`${sim.url}${segments[0]}`);
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toBe('video/mp2t');
    expect(Buffer.from(await segment.arrayBuffer())[0]).toBe(0x47);
    expect(sim.requests().every((r) => r.openConnections === 0)).toBe(true);
  }, 60_000);

  it('answers and logs catch-up requests and the relative live path', async () => {
    const sim = await start();
    const credentials = `username=${demoAccount.username}&password=${demoAccount.password}`;
    const paths = [
      '/catchup/1001.ts?case=default&start=20260101',
      '/1001/archive-1767225600-3600.ts',
      `/timeshift/${demo}/60/2026-01-01:12-00/1001.ts`,
      `/streaming/timeshift.php?${credentials}&stream=1001&start=2026-01-01:12-00&duration=60`,
    ];
    for (const path of paths) {
      const res = await fetch(`${sim.url}${path}`);
      expect(res.status, path).toBe(200);
      await res.arrayBuffer();
    }
    const seen = sim.requests();
    expect(seen[0]?.path).toBe('/catchup/1001.ts');
    expect(seen[0]?.query).toEqual({ case: 'default', start: '20260101' });
    expect(seen[1]?.path).toBe('/1001/archive-1767225600-3600.ts');
    expect(seen[2]?.path).toContain('/60/2026-01-01:12-00/1001.ts');
    expect(seen[3]?.query.stream).toBe('1001');
    const rel = await hold(`${sim.url}/some/relative/1001.ts`);
    expect(rel.res.status).toBe(200);
    expect(Buffer.from(rel.first)[0]).toBe(0x47);
  }, 60_000);

  it('applies the catalog drop fault to channel 1014', async () => {
    const sim = await start();
    const got = await hold(`${sim.url}/live/${demo}/1014.ts`);
    expect(got.res.status).toBe(200);
    expect(sim.requests()).toHaveLength(0);
    got.abort();
    await waitFor(() => sim.requests().length === 1);
    expect(sim.requests()[0]?.fault).toBe('drop@10s');
  }, 60_000);
});
