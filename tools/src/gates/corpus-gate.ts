import { release as osRelease } from 'node:os';
import { corpusCatalog } from '../sim/corpus.ts';
import { findFfmpeg } from '../sim/media.ts';
import { androidGateDevice, buildApk, type Exec, POLL_MS } from './adb.ts';
import { type DesktopGateDeps, systemDesktopDeps } from './desktop-gate.ts';
import type { GateDevice } from './gate-device.ts';
import type { SimControl } from './import-gate.ts';
import { crashFailures } from './player-judge.ts';
import { connectionStats, httpSimLog, type SimLog } from './sim-log.ts';
import { appleSimDevice } from './simctl.ts';

const CORPUS_ACCOUNT = 'corpus';
const CORPUS_TIMEOUT_MS = 420_000;
const SUBTITLE_RECIPE = 'h264-2audio-subs-720p25';

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

/** One item in the 29-item format corpus manifest built from `corpusCatalog(1)`. */
export interface GateCorpusItem {
  id: string;
  label: string;
  kind: 'live' | 'vod';
  url: string;
  expect: 'playing' | 'failed';
  selectAudioLang?: string;
  selectSubtitleLang?: string;
  seekMs?: number;
}

/** One item that failed its expected corpus outcome. */
interface CorpusFailure {
  id: string;
  label: string;
  reason: string;
}

/** Parsed payload of `ELV_GATE_CORPUS {json}`. */
export interface CorpusLine {
  total: number;
  passed: number;
  failed: CorpusFailure[];
  surfaceCreated: number;
  staleEventsApplied: number;
}

/** Verdict of a corpus gate run. */
export interface CorpusVerdict {
  ok: boolean;
  failures: string[];
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
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
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
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'vod-200010-hls',
    label: 'Two audio tracks and subtitles (VOD HLS WebVTT)',
    kind: 'vod',
    url: `${base}/movie/${pair}/200010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
    seekMs: 30_000,
  });

  items.push({
    id: 'vod-200001-empty',
    label: 'Empty 200 VOD response',
    kind: 'vod',
    url: `${base}/movie/${pair}/200001.mp4?fault=empty`,
    expect: 'failed',
  });

  return items;
}

function readCorpus(value: unknown): CorpusLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.total !== 'number' || !Number.isInteger(v.total) || v.total < 0) return undefined;
  if (typeof v.passed !== 'number' || !Number.isInteger(v.passed) || v.passed < 0) return undefined;
  if (typeof v.surfaceCreated !== 'number' || typeof v.staleEventsApplied !== 'number') {
    return undefined;
  }
  if (!Array.isArray(v.failed)) return undefined;
  const failed: CorpusFailure[] = [];
  for (const item of v.failed) {
    if (typeof item !== 'object' || item === null) return undefined;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      typeof entry.label !== 'string' ||
      typeof entry.reason !== 'string'
    ) {
      return undefined;
    }
    failed.push({ id: entry.id, label: entry.label, reason: entry.reason });
  }
  return {
    total: v.total,
    passed: v.passed,
    failed,
    surfaceCreated: v.surfaceCreated,
    staleEventsApplied: v.staleEventsApplied,
  };
}

/** The last well-formed `ELV_GATE_CORPUS {json}` line in a log dump, or undefined when there is none. */
export function parseCorpusLine(log: string): CorpusLine | undefined {
  let found: CorpusLine | undefined;
  const tag = 'ELV_GATE_CORPUS {';
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(at + tag.length - 1, end + 1));
      found = readCorpus(parsed) ?? found;
    } catch {
      // a truncated or foreign line: keep the previous one
    }
  }
  return found;
}

/** Judges the corpus report line, simulator connection stats, and crash reports. */
export function judgeCorpus(
  line: CorpusLine,
  connections: { limitResponses: number; overlapMs: number },
  crashes: readonly string[] = [],
): CorpusVerdict {
  const failures = line.failed.map((f) => `${f.id} (${f.label}): ${f.reason}`);
  if (line.total === 0) failures.push('corpus: 0 items ran');
  if (line.passed + line.failed.length !== line.total) {
    failures.push(
      `corpus: passed (${line.passed}) + failed (${line.failed.length}) != total (${line.total})`,
    );
  }
  if (line.staleEventsApplied > 0) {
    failures.push(`staleEventsApplied: ${line.staleEventsApplied} (expected 0)`);
  }
  if (connections.limitResponses > 0) {
    failures.push(`limitResponses: ${connections.limitResponses} (expected 0)`);
  }
  failures.push(...crashFailures(crashes));
  return { ok: failures.length === 0, failures };
}

const NO_FFMPEG =
  'gate: FFmpeg not found: set FFMPEG_PATH or install FFmpeg; the simulator needs it for live streams';

function isDesktopTarget(target: CorpusTarget): boolean {
  return target === 'desktop' || target === 'windows' || target === 'macos';
}

function isAndroidTarget(target: CorpusTarget): boolean {
  return (
    target === 'android-tv' ||
    target === 'fire-os' ||
    target === 'android' ||
    target === 'android-phone'
  );
}

async function runDesktopCorpus(
  opts: CorpusGateOptions,
  target: CorpusTarget,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<CorpusGateOutput> {
  const root = opts.root ?? '.';
  const deps = opts.desktopDeps ?? systemDesktopDeps(root, opts.exec);
  if (opts.build === true && deps.buildApp) await deps.buildApp();
  const externalSim = opts.simUrl !== undefined;
  const sim = externalSim
    ? (() => {
        const url = (opts.simUrl as string).replace(/\/+$/, '');
        const log = httpSimLog(url);
        return {
          url,
          requests: () => log.entries(),
          clearRequests: () => log.clear(),
          close: async () => {},
        };
      })()
    : await deps.startSim();

  try {
    await sim.clearRequests();
    const burst = opts.burst ?? 0;
    const query = `elv-gate=corpus&base=${sim.url}&account=${CORPUS_ACCOUNT}${burst > 0 ? `&burst=${burst}` : ''}`;
    const app = deps.spawnApp([`--elv-gate=${query}`]);
    let found: CorpusLine | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      found = await Promise.race([
        (async () => {
          for await (const raw of app.lines) {
            const parsed = parseCorpusLine(raw);
            if (parsed !== undefined) return parsed;
          }
          throw new Error(
            `gate: desktop process exited before emitting ELV_GATE_CORPUS (timeout ${Math.round(timeoutMs / 1000)} s)`,
          );
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `gate: no ELV_GATE_CORPUS line within ${Math.round(timeoutMs / 1000)} s; the desktop corpus run did not finish`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      app.kill();
    }
    await sleep(100);
    const entries = await sim.requests();
    const connections = connectionStats(entries, CORPUS_ACCOUNT);
    const outcome = judgeCorpus(found, connections, []);
    return {
      target,
      device: { platform: process.platform, arch: process.arch, release: osRelease() },
      line: found,
      connections,
      crashes: [],
      outcome,
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

  if (lookup() === null && opts.sim.running !== undefined && !(await opts.sim.running())) {
    throw new Error(NO_FFMPEG);
  }
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const now = opts.now ?? Date.now;

  if (opts.build === true && isAndroidTarget(target)) await buildApk(opts.exec, root, adb);
  const sim = await opts.sim.ensure();
  if (!sim.reused && lookup() === null) {
    await sim.stop();
    throw new Error(NO_FFMPEG);
  }
  const log = opts.simLog ?? httpSimLog('http://127.0.0.1:7878');
  let device: GateDevice | undefined;
  try {
    if (sim.reused) opts.onNote?.('simulator already running on port 7878: reusing it');
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
            if (opts.app === undefined || opts.app === '') {
              throw new Error(`gate: --target ${target} requires --app <path/to/App.app>`);
            }
            return appleSimDevice(opts.exec, {
              platform: target === 'tvos' ? 'tvos' : 'ios',
              app: opts.app,
              ...(opts.deviceName === undefined ? {} : { device: opts.deviceName }),
            });
          })());
    await device.install();
    await sim.reset?.();
    await log.clear().catch(() => undefined);
    const startedAt = now();
    const burst = opts.burst ?? 0;
    const url = `elviptv://gate/corpus?host=${device.simHost}&account=${CORPUS_ACCOUNT}${burst > 0 ? `&burst=${burst}` : ''}`;
    await device.start(url);
    for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
      const line = parseCorpusLine(await device.readLog());
      if (line !== undefined) {
        await device.stop();
        await sleep(POLL_MS);
        const entries = await log.entries().catch(() => []);
        const connections = connectionStats(entries, CORPUS_ACCOUNT);
        const crashes = await device.crashesSince(startedAt);
        const info = await device.describe();
        return {
          target,
          device: info,
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
