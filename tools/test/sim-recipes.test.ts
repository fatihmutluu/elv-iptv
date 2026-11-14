import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ENCODER_SKIP_MARKER,
  ensureRecipe,
  findFfmpeg,
  type LiveProcess,
  missingEncoders,
  parseEncoders,
  recipeDirName,
  spawnLive,
} from '../src/sim/media.ts';
import { ALL_RECIPES, type RecipeName, switchSeconds } from '../src/sim/recipes.ts';
import { streamLines } from './ffmpeg-probe.ts';
import { removeCache } from './media-cache.ts';

it.each([
  [4, 2],
  [10, 4],
  [59, 28],
  [60, 30],
  [600, 30],
])('switches every %is loop at %is', (s, w) => expect(switchSeconds(s)).toBe(w));

it.each([
  ['h264-aac-720p25', 'h264-aac-720p25-600s-4ea8ff4268'],
  ['hevc-main10-1080p25', 'hevc-main10-1080p25-600s-bd83cfaa49'],
  ['mpeg2-ac3-576i25', 'mpeg2-ac3-576i25-600s-78048bb11b'],
  ['aac-radio', 'aac-radio-600s-f2115b03ac'],
] as const)('keeps the cache folder of %s', (r, name) => expect(recipeDirName(r, 600)).toBe(name));

it('lists eleven recipes, the existing four first', () => {
  expect(ALL_RECIPES).toHaveLength(11);
  expect(ALL_RECIPES.slice(0, 4)).toEqual([
    'h264-aac-720p25',
    'hevc-main10-1080p25',
    'mpeg2-ac3-576i25',
    'aac-radio',
  ]);
});

it('gives every recipe its own cache folder', () => {
  expect(new Set(ALL_RECIPES.map((r) => recipeDirName(r, 600))).size).toBe(11);
});

it('reads encoder names from the listing', () => {
  const listing =
    'Encoders:\n V..... = Video\n ------\n V....D libx264   H.264\n A....D aac   AAC\n';
  expect([...parseEncoders(listing)]).toEqual(['libx264', 'aac']);
});

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') throw new Error('ffmpeg is required in CI');
const withFfmpeg = ffmpeg === null ? describe.skip : describe;

const EXPECT: Record<string, { loop: RegExp[]; mp4?: RegExp[]; mkv?: RegExp[] }> = {
  'hevc-main-1080p25': { loop: [/Video: hevc \(Main\)/, /1920x1080/], mp4: [/hvc1/] },
  'h264-aac-1080i25': { loop: [/Video: h264/, /top first/, /1920x1080/, /25 fps/] },
  'h264-eac3-720p50': { loop: [/Audio: eac3/, /5\.1/, /50 fps/], mp4: [/Audio: eac3/] },
  'h264-mp2-576p25': { loop: [/Audio: mp2/, /SAR 64:45/], mkv: [/Audio: mp2/] },
  'h264-mp3-720p30': { loop: [/Audio: mp3/, /29\.97 fps/] },
  'h264-aac-res-switch': { loop: [/1280x720/, /Audio: aac/] },
  'h264-2audio-subs-720p25': {
    loop: [/\(tur\): Audio: aac/, /\(eng\): Audio: aac/],
    mp4: [/\(tur\): Audio: aac/, /\(eng\): Audio: aac/],
    mkv: [/\(tur\): Audio: aac/, /\(eng\): Audio: aac/],
  },
};

withFfmpeg('new recipes', () => {
  let cacheDir = '';
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'sim-recipes-'));
  });
  const live: LiveProcess[] = [];
  afterEach(async () => {
    const procs = live.splice(0);
    for (const l of procs) l.stop();
    await Promise.all(procs.map((l) => l.exited));
  });
  afterAll(() => removeCache(cacheDir));

  function skipReason(r: RecipeName): boolean {
    const missing = missingEncoders(ffmpeg as string, r);
    if (missing.length === 0) return false;
    if (process.env.CI === 'true') throw new Error(`FFmpeg lacks ${missing.join(' ')} for ${r}`);
    process.stderr.write(`sim-recipes: ${ENCODER_SKIP_MARKER}: ${r}\n`);
    return true;
  }
  const opts = () => ({ ffmpeg: ffmpeg as string, cacheDir, seconds: 4 });

  it.each(Object.keys(EXPECT))(
    '%s generates the documented streams',
    async (name) => {
      const r = name as RecipeName;
      if (skipReason(r)) return;
      const files = await ensureRecipe(r, opts());
      const want = EXPECT[name];
      const loop = streamLines(ffmpeg as string, files.loopTs);
      for (const [file, patterns] of [
        [files.loopTs, want?.loop],
        [files.vodMp4, want?.mp4],
        [files.vodMkv, want?.mkv],
      ] as const) {
        const lines = streamLines(ffmpeg as string, file);
        for (const re of patterns ?? [])
          expect(
            lines.some((l) => re.test(l)),
            `${name} ${file} ${re}`,
          ).toBe(true);
      }
      const seg = streamLines(ffmpeg as string, join(files.segmentsDir, 'seg00000.ts'));
      const codecs = (lines: string[]) =>
        lines.map((l) => /(Video|Audio): (\w+)/.exec(l)?.[0]).sort();
      expect(codecs(seg)).toEqual(codecs(loop));
    },
    60_000,
  );

  it('the resolution switch lands on a segment boundary', async () => {
    const r: RecipeName = 'h264-aac-res-switch';
    if (skipReason(r)) return;
    const files = await ensureRecipe(r, opts());
    expect(files.segmentCount).toBe(2);
    const a = streamLines(ffmpeg as string, join(files.segmentsDir, 'seg00000.ts'));
    const b = streamLines(ffmpeg as string, join(files.segmentsDir, 'seg00001.ts'));
    expect(a.some((l) => /1280x720/.test(l))).toBe(true);
    expect(b.some((l) => /1920x1080/.test(l))).toBe(true);
    const dir = join(files.loopTs, '..');
    for (const f of ['part-a.ts', 'part-b.ts', 'parts.txt'])
      expect(existsSync(join(dir, f))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['loop.ts', 'segments', 'vod.mkv', 'vod.mp4']);
  }, 60_000);

  it('the live copy keeps both audio tracks', async () => {
    const r: RecipeName = 'h264-2audio-subs-720p25';
    if (skipReason(r)) return;
    const files = await ensureRecipe(r, opts());
    const proc = spawnLive(ffmpeg as string, files.loopTs);
    live.push(proc);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of proc.stdout) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size >= 65_536) break;
    }
    proc.stop();
    const head = Buffer.concat(chunks).subarray(0, 65_536).toString('latin1');
    expect(head).toContain('tur');
    expect(head).toContain('eng');
  }, 60_000);
});
