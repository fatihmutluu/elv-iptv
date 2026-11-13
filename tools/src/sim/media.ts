import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RecipeName } from './catalog.ts';

/** Files of one generated recipe. Segments are named `seg00000.ts` and up, 2 s each. */
export interface RecipeFiles {
  loopTs: string;
  vodMp4: string;
  vodMkv: string;
  segmentsDir: string;
  segmentCount: number;
  segmentSec: 2;
}

/** Every recipe the catalog can reference. */
export const ALL_RECIPES: readonly RecipeName[] = [
  'h264-aac-720p25',
  'hevc-main10-1080p25',
  'mpeg2-ac3-576i25',
  'aac-radio',
];

const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000'];
const GOP = '25';
const AAC = ['-c:a', 'aac', '-b:a', '64k', '-ac', '2'];

function picture(size: string, rate: number): string[] {
  return ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}`];
}

/** Encoder arguments per recipe, placed before `-t` and the output file. */
const RECIPE_ARGS: Record<RecipeName, string[]> = {
  'h264-aac-720p25': [
    ...picture('1280x720', 25),
    ...TONE,
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
    ...['-b:v', '500k', '-maxrate', '500k', '-bufsize', '1000k'],
    ...['-g', GOP, '-keyint_min', GOP, '-sc_threshold', '0'],
    ...AAC,
  ],
  'hevc-main10-1080p25': [
    ...picture('1920x1080', 25),
    ...TONE,
    ...['-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le'],
    ...['-profile:v', 'main10', '-b:v', '1000k', '-tag:v', 'hvc1'],
    ...['-x265-params', `keyint=${GOP}:min-keyint=${GOP}:scenecut=0:log-level=error`],
    ...AAC,
  ],
  'mpeg2-ac3-576i25': [
    ...picture('720x576', 50),
    ...TONE,
    ...['-vf', 'tinterlace=mode=interleave_top,format=yuv420p'],
    ...['-c:v', 'mpeg2video', '-b:v', '1500k', '-maxrate', '1500k', '-bufsize', '1200k'],
    ...['-flags', '+ildct+ilme', '-g', GOP],
    ...['-c:a', 'ac3', '-b:a', '96k', '-ac', '2'],
  ],
  'aac-radio': [...TONE, ...AAC],
};

const QUIET = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const inflight = new Map<string, Promise<RecipeFiles>>();

/** FFmpeg from `FFMPEG_PATH`, then PATH; null when absent. Checked with `-version`. */
export function findFfmpeg(): string | null {
  const wanted = process.env.FFMPEG_PATH;
  for (const candidate of wanted ? [wanted, 'ffmpeg'] : ['ffmpeg']) {
    const probe = spawnSync(candidate, ['-version'], { windowsHide: true, stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runFfmpeg(
  ffmpeg: string,
  args: string[],
  recipe: RecipeName,
  onSpawn?: () => void,
): Promise<void> {
  onSpawn?.();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [...QUIET, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => reject(new Error(`cannot start FFmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      const missing = /Unknown encoder '([^']+)'/.exec(stderr);
      const prefix = missing
        ? `this FFmpeg build lacks the ${missing[1]} encoder needed by recipe ${recipe}; `
        : '';
      reject(new Error(`${prefix}FFmpeg exited with code ${code}\n${tail}`));
    });
  });
}

function recipeDir(recipe: RecipeName, cacheDir: string, seconds: number): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([RECIPE_ARGS[recipe], seconds, 'v1']))
    .digest('hex')
    .slice(0, 10);
  return join(cacheDir, `${recipe}-${seconds}s-${hash}`);
}

function describeDir(dir: string): RecipeFiles {
  const segmentsDir = join(dir, 'segments');
  const segmentCount = readdirSync(segmentsDir).filter((f) => /^seg\d+\.ts$/.test(f)).length;
  return {
    loopTs: join(dir, 'loop.ts'),
    vodMp4: join(dir, 'vod.mp4'),
    vodMkv: join(dir, 'vod.mkv'),
    segmentsDir,
    segmentCount,
    segmentSec: 2,
  };
}

async function generate(
  recipe: RecipeName,
  dir: string,
  ffmpeg: string,
  seconds: number,
  onSpawn?: () => void,
): Promise<void> {
  const run = (args: string[]): Promise<void> => runFfmpeg(ffmpeg, args, recipe, onSpawn);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(join(tmp, 'segments'), { recursive: true });
  try {
    const loop = join(tmp, 'loop.ts');
    const copy = ['-i', loop, '-c', 'copy'];
    const hls = ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod'];
    const names = ['-hls_segment_filename', join(tmp, 'segments', 'seg%05d.ts')];
    await run([...RECIPE_ARGS[recipe], '-t', `${seconds}`, '-f', 'mpegts', loop]);
    await run([...copy, '-movflags', '+faststart', join(tmp, 'vod.mp4')]);
    await run([...copy, join(tmp, 'vod.mkv')]);
    await run([...copy, ...hls, ...names, join(tmp, 'segments', 'index.m3u8')]);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Generates (once per process and cache dir, single-flight) and returns the recipe files.
 * `onSpawn` is called before each FFmpeg run; tests use it to count runs.
 */
export function ensureRecipe(
  recipe: RecipeName,
  opts: { ffmpeg: string; cacheDir: string; seconds: number; onSpawn?: () => void },
): Promise<RecipeFiles> {
  const dir = recipeDir(recipe, opts.cacheDir, opts.seconds);
  const running = inflight.get(dir);
  if (running) return running;
  const job = (async () => {
    if (!existsSync(join(dir, 'segments', 'index.m3u8'))) {
      mkdirSync(opts.cacheDir, { recursive: true });
      await generate(recipe, dir, opts.ffmpeg, opts.seconds, opts.onSpawn);
    }
    return describeDir(dir);
  })();
  inflight.set(dir, job);
  job.catch(() => inflight.delete(dir));
  return job;
}
