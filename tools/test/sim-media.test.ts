import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../src/sim/accounts.ts';
import { buildCatalog } from '../src/sim/catalog.ts';
import { ensureRecipe, findFfmpeg } from '../src/sim/media.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') {
  throw new Error('ffmpeg is required in CI');
}
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write('sim-media: FFmpeg not found, media tests skipped\n');

const demo = ACCOUNTS.find((a) => a.username === 'demo');
if (!demo) throw new Error('demo account missing');
const catalog = buildCatalog(demo.profile, 1);
const movie = catalog.movies[0];
const episode = catalog.series[0]?.episodes[0];
if (!movie || !episode) throw new Error('catalog has no movie or episode');
const pair = `${demo.username}/${demo.password}`;

const open: SimHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

withFfmpeg('recipes', () => {
  let cacheDir = '';
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-media-'));
  });
  afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

  it('generates a recipe once for concurrent callers', async () => {
    let runs = 0;
    const opts = { ffmpeg: ffmpeg as string, cacheDir, seconds: 4, onSpawn: () => runs++ };
    const first = ensureRecipe('h264-aac-720p25', opts);
    const second = ensureRecipe('h264-aac-720p25', opts);
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(runs).toBe(4);
    expect(a).toEqual(b);
    expect(readdirSync(cacheDir)).toHaveLength(1);
    expect(a.segmentCount).toBeGreaterThanOrEqual(2);
    const before = statSync(a.loopTs).mtimeMs;
    const c = await ensureRecipe('h264-aac-720p25', opts);
    expect(runs).toBe(4);
    expect(c).toEqual(a);
    expect(statSync(c.loopTs).mtimeMs).toBe(before);
  });

  it('loop starts like a live stream', async () => {
    const files = await ensureRecipe('h264-aac-720p25', {
      ffmpeg: ffmpeg as string,
      cacheDir,
      seconds: 4,
    });
    const data = readFileSync(files.loopTs);
    expect(data[0]).toBe(0x47);
    const pids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const at = i * 188;
      expect(data[at]).toBe(0x47);
      pids.push((((data[at + 1] as number) & 0x1f) << 8) | (data[at + 2] as number));
    }
    expect(pids).toContain(0);
  });

  it('serves VOD with ranges', async () => {
    const sim = await startSim({ port: 0, mediaSeconds: 4, cacheDir, ffmpegPath: ffmpeg });
    open.push(sim);
    for (const path of [`/movie/${pair}/${movie.id}.mp4`, `/series/${pair}/${episode.id}.mp4`]) {
      const full = await fetch(`${sim.url}${path}`);
      expect(full.status).toBe(200);
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      const body = Buffer.from(await full.arrayBuffer());
      const size = body.length;
      expect(Number(full.headers.get('content-length'))).toBe(size);

      const head = await fetch(`${sim.url}${path}`, { headers: { range: 'bytes=0-99' } });
      expect(head.status).toBe(206);
      expect(head.headers.get('content-range')).toBe(`bytes 0-99/${size}`);
      expect(Buffer.from(await head.arrayBuffer())).toEqual(body.subarray(0, 100));

      const rest = await fetch(`${sim.url}${path}`, { headers: { range: 'bytes=100-' } });
      expect(rest.status).toBe(206);
      expect(Buffer.from(await rest.arrayBuffer())).toEqual(body.subarray(100));

      const tail = await fetch(`${sim.url}${path}`, { headers: { range: 'bytes=-50' } });
      expect(tail.status).toBe(206);
      expect(Buffer.from(await tail.arrayBuffer())).toEqual(body.subarray(size - 50));

      const past = await fetch(`${sim.url}${path}`, { headers: { range: `bytes=${size}-` } });
      expect(past.status).toBe(416);
      expect(past.headers.get('content-range')).toBe(`bytes */${size}`);
    }
  }, 60_000);
});

describe('generation failure', () => {
  const missing = join(tmpdir(), 'sim-no-such-ffmpeg', 'ffmpeg');
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sim-media-fail-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects, leaves no folders and retries on the next call', async () => {
    let runs = 0;
    const opts = { ffmpeg: missing, cacheDir: dir, seconds: 4, onSpawn: () => runs++ };
    await expect(ensureRecipe('h264-aac-720p25', opts)).rejects.toThrow(/cannot start FFmpeg/);
    expect(readdirSync(dir)).toEqual([]);
    await expect(ensureRecipe('h264-aac-720p25', opts)).rejects.toThrow(/cannot start FFmpeg/);
    expect(runs).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(ffmpeg === null)('succeeds after an earlier failure', async () => {
    const base = { cacheDir: dir, seconds: 4 };
    await expect(ensureRecipe('aac-radio', { ...base, ffmpeg: missing })).rejects.toThrow();
    const files = await ensureRecipe('aac-radio', { ...base, ffmpeg: ffmpeg as string });
    expect(files.segmentCount).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('answers 503 with the failure text when generation fails', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: missing, cacheDir: dir });
    open.push(sim);
    const res = await fetch(`${sim.url}/movie/${pair}/${movie.id}.mp4`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('FFmpeg failed');
  });
});

describe('vod access', () => {
  it('answers 503 without ffmpeg', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    const res = await fetch(`${sim.url}/movie/${pair}/${movie.id}.mp4`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('FFmpeg');
    const data = await fetch(
      `${sim.url}/player_api.php?username=${demo.username}&password=${demo.password}`,
    );
    expect(data.status).toBe(200);
  });

  it('rejects bad credentials, expired accounts and unknown ids', async () => {
    const sim = await startSim({ port: 0, ffmpegPath: null });
    open.push(sim);
    expect((await fetch(`${sim.url}/movie/${demo.username}/nope/${movie.id}.mp4`)).status).toBe(
      401,
    );
    const expired = ACCOUNTS.find((a) => a.status === 'Expired');
    if (!expired) throw new Error('no expired account');
    const path = `/movie/${expired.username}/${expired.password}/${movie.id}.mp4`;
    expect((await fetch(`${sim.url}${path}`)).status).toBe(403);
    expect((await fetch(`${sim.url}/movie/${pair}/999999999.mp4`)).status).toBe(404);
  });
});
