import { release as osRelease } from 'node:os';
import { corpusCatalog } from '../sim/corpus.ts';
import { findFfmpeg } from '../sim/media.ts';
import { prepareAllRecipes } from '../sim/prepare.ts';
import { type ApkTarget, androidGateDevice, buildApk, type Exec, POLL_MS } from './adb.ts';
import { readUntil, waitExit } from './app-lines.ts';
import {
  CORPUS_ITEM_COUNT,
  type CorpusLine,
  type CorpusVerdict,
  judgeCorpus,
  parseCorpusLine,
} from './corpus-judge.ts';
import { type DesktopGateDeps, systemDesktopDeps } from './desktop-gate.ts';
import type { GateDevice } from './gate-device.ts';
import type { SimControl } from './import-gate.ts';
import { connectionStats, httpSimLog, type SimLog } from './sim-log.ts';
import { appleSimDevice } from './simctl.ts';

export { type CorpusLine, judgeCorpus, parseCorpusLine };

const CORPUS_ACCOUNT = 'corpus';
const CORPUS_TIMEOUT_MS = 420_000;
const EXIT_GRACE_MS = 3000;
const SUBTITLE_RECIPE = 'h264-2audio-subs-720p25';
const AUDIO_ONLY_RECIPE = 'aac-radio';
const EMPTY_VOD_ERRORS: readonly string[] = ['playback/network', 'playback/unsupported-format'];

/** Target platform of a format corpus gate run. */
export type CorpusTarget =
  | 'android-tv'
  | 'fire-os'
  | 'android'
  | 'android-phone'
  | 'tvos'
  | 'ios'
  | 'desktop'
  | 'windows'
  | 'macos';

const APK_TARGETS: Partial<Record<CorpusTarget, ApkTarget>> = {
  'android-tv': 'android-tv',
  'fire-os': 'fire-tv',
  android: 'android',
  'android-phone': 'android',
};

/** One item in the 29-item format corpus manifest built from `corpusCatalog(1)`. */
export interface GateCorpusItem {
  id: string;
  label: string;
  kind: 'live' | 'vod';
  url: string;
  expect: 'playing' | 'failed';
  audioOnly?: boolean;
  /** Allowed `category/code` values a failing item must end with. */
  expectErrors?: readonly string[];
  selectAudioLang?: string;
  selectSubtitleLang?: string;
  seekMs?: number;
}

/** Options of {@link runCorpusGate}. */
export interface CorpusGateOptions {
  exec: Exec;
  sim: SimControl;
  target?: CorpusTarget;
  avd?: string;
  build?: boolean;
  app?: string;
  deviceName?: string;
  burst?: number;
  simUrl?: string;
  device?: GateDevice;
  simLog?: SimLog;
  desktopDeps?: DesktopGateDeps;
  prepareMedia?: () => Promise<void>;
  root?: string;
  adb?: string;
  timeoutMs?: number;
  ffmpeg?: () => string | null;
  now?: () => number;
  onNote?: (note: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Output of {@link runCorpusGate}. */
export interface CorpusGateOutput {
  target: string;
  device: Record<string, string>;
  line: CorpusLine;
  connections: { limitResponses: number; overlapMs: number };
  crashes: string[];
  outcome: CorpusVerdict;
}

/** Builds the 29-item format corpus manifest directly from `corpusCatalog(1)`. */
export function buildGateCorpusItems(opts: {
  base: string;
  account: string;
  burst?: number;
}): GateCorpusItem[] {
  const { base, account, burst = 0 } = opts;
  const pair = `${account}/${account}`;
  const catalog = corpusCatalog(1);
  const items: GateCorpusItem[] = [];

  for (const ch of catalog.live) {
    if (ch.fault === 'redirect=hls') {
      items.push({
        id: `live-${ch.id}`,
        label: ch.name,
        kind: 'live',
        url: `${base}/${pair}/${ch.id}`,
        expect: 'playing',
      });
      continue;
    }
    const queryParts = [
      ch.fault !== null && burst > 0 ? ch.fault : undefined,
      burst > 0 ? `burst=${burst}` : undefined,
    ].filter((part): part is string => part !== undefined);
    const suffix = queryParts.length === 0 ? '' : `?fault=${queryParts.join(',')}`;
    const tracks = ch.recipe === SUBTITLE_RECIPE;
    items.push({
      id: `live-${ch.id}`,
      label: ch.name,
      kind: 'live',
      url: `${base}/live/${pair}/${ch.id}.ts${suffix}`,
      expect: 'playing',
      ...(ch.recipe === AUDIO_ONLY_RECIPE ? { audioOnly: true } : {}),
      ...(tracks ? { selectAudioLang: 'eng' } : {}),
    });
  }

  items.push({
    id: 'live-1010-hls',
    label: 'Two audio tracks and subtitles (Live HLS WebVTT)',
    kind: 'live',
    url: `${base}/live/${pair}/1010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
  });

  for (const movie of catalog.movies) {
    const tracks = movie.recipe === SUBTITLE_RECIPE;
    items.push({
      id: `vod-${movie.id}`,
      label: movie.name,
      kind: 'vod',
      url: `${base}/movie/${pair}/${movie.id}.${movie.ext}`,
      expect: 'playing',
      ...(movie.recipe === AUDIO_ONLY_RECIPE ? { audioOnly: true } : {}),
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push(
    {
      id: 'vod-200010-hls',
      label: 'Two audio tracks and subtitles (VOD HLS WebVTT)',
      kind: 'vod',
      url: `${base}/movie/${pair}/200010.m3u8`,
      expect: 'playing',
      selectSubtitleLang: 'tur',
      seekMs: 30_000,
    },
    {
      id: 'vod-200001-empty',
      label: 'Empty 200 VOD response',
      kind: 'vod',
      url: `${base}/movie/${pair}/200001.mp4?fault=empty`,
      expect: 'failed',
      expectErrors: EMPTY_VOD_ERRORS,
    },
  );
  if (items.length !== CORPUS_ITEM_COUNT) {
    throw new Error(
      `gate: corpus manifest has ${items.length} items, expected ${CORPUS_ITEM_COUNT}`,
    );
  }
  return items;
}

const NO_FFMPEG =
  'gate: FFmpeg not found: set FFMPEG_PATH or install FFmpeg; the simulator needs it for live streams';

const isDesktopTarget = (t: CorpusTarget): boolean =>
  t === 'desktop' || t === 'windows' || t === 'macos';
const isAndroidTarget = (t: CorpusTarget): boolean => APK_TARGETS[t] !== undefined;

async function runDesktopCorpus(
  opts: CorpusGateOptions,
  target: CorpusTarget,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<CorpusGateOutput> {
  const deps = opts.desktopDeps ?? systemDesktopDeps(opts.root ?? '.', opts.exec);
  if (opts.build === true && deps.buildApp) await deps.buildApp();
  if (opts.simUrl === undefined) await (opts.prepareMedia ?? deps.prepareMedia)?.();
  const sim =
    opts.simUrl !== undefined
      ? (() => {
          const url = opts.simUrl.replace(/\/+$/, '');
          const log = opts.simLog ?? httpSimLog(url);
          return {
            url,
            requests: () => log.entries(),
            clearRequests: () => log.clear(),
            close: async () => {},
          };
        })()
      : await deps.startSim();

  try {
    if (opts.simUrl !== undefined) opts.onNote?.(`using external simulator at ${sim.url}`);
    await sim.clearRequests();
    const burst = opts.burst ?? 0;
    const query = `elv-gate=corpus&base=${sim.url}&account=${CORPUS_ACCOUNT}${burst > 0 ? `&burst=${burst}` : ''}`;
    const app = deps.spawnApp([`--elv-gate=${query}`]);
    let found: CorpusLine;
    try {
      found = await readUntil(
        app.lines,
        parseCorpusLine,
        timeoutMs,
        () =>
          new Error(
            `gate: no ELV_GATE_CORPUS line within ${Math.round(timeoutMs / 1000)} s; the desktop corpus run did not finish`,
          ),
        () => new Error('gate: desktop process exited before emitting ELV_GATE_CORPUS'),
      );
    } catch (error) {
      app.kill();
      throw error;
    }
    await waitExit(app, EXIT_GRACE_MS);
    await sleep(100);
    const connections = connectionStats(await sim.requests(), CORPUS_ACCOUNT);
    return {
      target,
      device: { platform: process.platform, arch: process.arch, release: osRelease() },
      line: found,
      connections,
      crashes: [],
      outcome: judgeCorpus(found, connections, []),
    };
  } finally {
    await sim.close();
  }
}

/** Runs the 29-item format corpus gate on an Android, Apple simulator, or desktop target. */
export async function runCorpusGate(opts: CorpusGateOptions): Promise<CorpusGateOutput> {
  const target = opts.target ?? 'android-tv';
  const lookup = opts.ffmpeg ?? findFfmpeg;
  const timeoutMs = opts.timeoutMs ?? CORPUS_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  if (isDesktopTarget(target)) {
    if (opts.simUrl === undefined && lookup() === null) throw new Error(NO_FFMPEG);
    return runDesktopCorpus(opts, target, timeoutMs, sleep);
  }
  if (opts.simUrl !== undefined) {
    throw new Error(`gate: --sim is supported only with --target desktop, not ${target}`);
  }
  if (lookup() === null && opts.sim.running !== undefined && !(await opts.sim.running())) {
    throw new Error(NO_FFMPEG);
  }
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const now = opts.now ?? Date.now;
  const apkTarget = APK_TARGETS[target];
  if (opts.build === true && apkTarget !== undefined) {
    await buildApk(opts.exec, root, adb, apkTarget);
  }
  const sim = await opts.sim.ensure();
  if (!sim.reused && lookup() === null) {
    await sim.stop();
    throw new Error(NO_FFMPEG);
  }
  const log = opts.simLog ?? httpSimLog('http://127.0.0.1:7878');
  let device: GateDevice | undefined;
  try {
    if (sim.reused) {
      opts.onNote?.('simulator already running on port 7878: reusing it');
    } else if (opts.prepareMedia !== undefined) {
      await opts.prepareMedia();
    } else if (opts.device === undefined) {
      const ffmpeg = lookup();
      if (ffmpeg !== null) await prepareAllRecipes(ffmpeg);
    }
    device =
      opts.device ??
      (isAndroidTarget(target)
        ? await androidGateDevice(opts.exec, {
            adb,
            root,
            sleep,
            ...(opts.avd === undefined ? {} : { avd: opts.avd }),
          })
        : await (() => {
            if (!opts.app)
              throw new Error(`gate: --target ${target} requires --app <path/to/App.app>`);
            return appleSimDevice(opts.exec, {
              platform: target === 'tvos' ? 'tvos' : 'ios',
              app: opts.app,
              ...(opts.deviceName === undefined ? {} : { device: opts.deviceName }),
            });
          })());
    await device.install();
    await sim.reset?.();
    const startedAt = now();
    const burst = opts.burst ?? 0;
    await device.start(
      `elviptv://gate/corpus?host=${device.simHost}&account=${CORPUS_ACCOUNT}${burst > 0 ? `&burst=${burst}` : ''}`,
      { afterStop: () => log.clear() },
    );
    for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
      const line = parseCorpusLine(await device.readLog());
      if (line !== undefined) {
        await device.stop();
        await sleep(POLL_MS);
        const connections = connectionStats(await log.entries(), CORPUS_ACCOUNT);
        const crashes = await device.crashesSince(startedAt);
        return {
          target,
          device: await device.describe(),
          line,
          connections,
          crashes,
          outcome: judgeCorpus(line, connections, crashes),
        };
      }
      await sleep(POLL_MS);
    }
    throw new Error(
      `gate: no ELV_GATE_CORPUS line within ${Math.round(timeoutMs / 1000)} s; the corpus run did not finish`,
    );
  } finally {
    try {
      await device?.close();
    } finally {
      await sim.stop();
    }
  }
}
