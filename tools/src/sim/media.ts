import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { RECIPES, type RecipeName, switchSeconds } from './recipes.ts';

/** Files of one generated recipe. Segments are named `seg00000.ts` and up, 2 s each. */
export interface RecipeFiles {
  loopTs: string;
  vodMp4: string;
  vodMkv: string;
  segmentsDir: string;
  segmentCount: number;
  segmentSec: 2;
}

/** Printed by the media tests when FFmpeg is absent; the `vitest` check turns it into a visible note. */
export const MEDIA_SKIP_MARKER = 'FFmpeg not found, media tests skipped';

/** Printed by the recipe tests when FFmpeg lacks an encoder; the `vitest` check turns it into a note. */
export const ENCODER_SKIP_MARKER = 'FFmpeg lacks an encoder, recipe tests skipped';

const QUIET = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const inflight = new Map<string, Promise<RecipeFiles>>();

const probed = new Map<string, string | null>();

/**
 * FFmpeg from `FFMPEG_PATH`, then PATH; null when absent. Checked with `-version` once per process and
 * `FFMPEG_PATH` value.
 */
export function findFfmpeg(): string | null {
  const wanted = process.env.FFMPEG_PATH ?? '';
  const known = probed.get(wanted);
  if (known !== undefined) return known;
  let found: string | null = null;
  for (const candidate of wanted ? [wanted, 'ffmpeg'] : ['ffmpeg']) {
    const probe = spawnSync(candidate, ['-version'], { windowsHide: true, stdio: 'ignore' });
    if (probe.status === 0) {
      found = candidate;
      break;
    }
  }
  probed.set(wanted, found);
  return found;
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

const ORIGINAL: readonly RecipeName[] = [
  'h264-aac-720p25',
  'hevc-main10-1080p25',
  'mpeg2-ac3-576i25',
  'aac-radio',
];

/** Cache folder name of a recipe: the name, the loop length and a hash of everything that shapes the media. */
export function recipeDirName(recipe: RecipeName, seconds: number): string {
  const def = RECIPES[recipe];
  const input = ORIGINAL.includes(recipe)
    ? [def.args, seconds, 'v2']
    : [def.args, seconds, 'v2', def.mp4Args, def.parts ?? null];
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 10);
  return `${recipe}-${seconds}s-${hash}`;
}

/** Encoder names in the output of `ffmpeg -encoders`; the legend lines are not encoders. */
export function parseEncoders(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split('\n')) {
    const m = /^\s*[VASD][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m?.[1] && m[1] !== '=') names.add(m[1]);
  }
  return names;
}

const encoderCache = new Map<string, Set<string>>();

/** External encoders the recipe needs that this FFmpeg build lacks. */
export function missingEncoders(ffmpeg: string, recipe: RecipeName): string[] {
  let known = encoderCache.get(ffmpeg);
  if (!known) {
    const out = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    known = parseEncoders(out.stdout ?? '');
    encoderCache.set(ffmpeg, known);
  }
  const have = known;
  return RECIPES[recipe].encoders.filter((e) => !have.has(e));
}

function recipeDir(recipe: RecipeName, cacheDir: string, seconds: number): string {
  return join(cacheDir, recipeDirName(recipe, seconds));
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
    const copy = ['-i', loop, '-map', '0', '-c', 'copy'];
    const hls = ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod'];
    const names = ['-hls_segment_filename', join(tmp, 'segments', 'seg%05d.ts')];
    const def = RECIPES[recipe];
    if (def.parts) {
      const step = switchSeconds(seconds);
      const partA = join(tmp, 'part-a.ts');
      const partB = join(tmp, 'part-b.ts');
      const list = join(tmp, 'parts.txt');
      await run([...def.parts.a, '-t', `${step}`, '-f', 'mpegts', partA]);
      await run([...def.parts.b, '-t', `${step}`, '-f', 'mpegts', partB]);
      const lines = Array.from(
        { length: Math.ceil(seconds / step) },
        (_, i) => `file '${i % 2 === 0 ? 'part-a.ts' : 'part-b.ts'}'`,
      );
      writeFileSync(list, `${lines.join('\n')}\n`);
      await run([
        '-f',
        'concat',
        '-i',
        list,
        ...def.args,
        '-t',
        `${seconds}`,
        '-f',
        'mpegts',
        loop,
      ]);
      for (const f of [partA, partB, list]) rmSync(f, { force: true });
    } else {
      await run([...def.args, '-t', `${seconds}`, '-f', 'mpegts', loop]);
    }
    await run([...copy, ...def.mp4Args, '-movflags', '+faststart', join(tmp, 'vod.mp4')]);
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

const children = new Set<ChildProcess>();
const KILL_GRACE_MS = 2000;

/** Number of live FFmpeg children the simulator is running right now. */
export function activeChildren(): number {
  return children.size;
}

/** A running real-time FFmpeg copy of a recipe loop. */
export interface LiveProcess {
  stdout: Readable;
  stop(): void;
}

/** Starts FFmpeg looping `loopTs` at real time as MPEG-TS on stdout. */
export function spawnLive(ffmpeg: string, loopTs: string): LiveProcess {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-stream_loop', '-1'];
  const child = spawn(
    ffmpeg,
    [...args, '-i', loopTs, '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1'],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  children.add(child);
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  child.on('error', () => child.stdout.destroy());
  child.on('close', () => {
    children.delete(child);
    clearTimeout(timer);
  });
  child.stdout.on('error', () => undefined);
  return {
    stdout: child.stdout,
    stop() {
      if (stopping || !children.has(child)) return;
      stopping = true;
      child.kill();
      timer = setTimeout(() => {
        if (!children.has(child)) return;
        if (process.platform === 'win32' && child.pid !== undefined) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => undefined);
        } else child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      timer.unref();
    },
  };
}
