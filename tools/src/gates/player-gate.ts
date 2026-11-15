import { findFfmpeg } from '../sim/media.ts';
import { buildApk, type Exec, POLL_MS } from './adb.ts';
import { resolveGateDevice } from './contract-gate.ts';
import { FAULT_ZAPS, type Fault, faultRate, faultsFor, judgeFault } from './fault-judge.ts';
import type { GateDevice, GateTarget } from './gate-device.ts';
import type { SimControl } from './import-gate.ts';
import {
  ACCOUNT,
  aggregateRuns,
  comparePlayer,
  crashFailures,
  judgeSoak,
  judgeStress,
  type MemorySamples,
  type PlayerLine,
  type PlayerResult,
  parsePlayerLine,
  type StressRun,
  type Verdict,
} from './player-judge.ts';
import { connectionStats, httpSimLog, type SimLog } from './sim-log.ts';

export {
  aggregateRuns,
  comparePlayer,
  judgeFault,
  type PlayerLine,
  type PlayerResult,
  parsePlayerLine,
};

const DEFAULT_CHANNELS: readonly string[] = ['1001', '1002', '1003', '1004'];
const ZAP_RATE = 0.5;
const STRESS_ZAPS = 200;
const STRESS_RATE = 5;
const LINE_MARGIN_MS = 60_000;
const MEMORY_WARMUP_MS = 5000;
const NO_FFMPEG =
  'gate: FFmpeg not found: set FFMPEG_PATH or install FFmpeg; the simulator needs it for live streams';

/** Stream form a player gate run tunes. */
export type PlayerStreamKind = 'ts' | 'hls' | 'vod';

/** Verdict on one fault run, with the simulator's connection numbers of that run. */
export interface FaultReport {
  fault: Fault;
  line: PlayerLine;
  failures: string[];
  warnings: string[];
  limitResponses: number;
  overlapMs: number;
  crashes: string[];
}

/** Report of a `--soak <min>` run. */
export interface SoakReport {
  minutes: number;
  stream: PlayerStreamKind;
  line: PlayerLine;
  memory: MemorySamples;
  crashes: string[];
  limitResponses: number;
  overlapMs: number;
  verdict: Verdict;
}

interface StressReport {
  zaps: number;
  runs: StressRun[];
  verdict: Verdict;
}

/** What {@link runPlayerGate} measured. */
export interface PlayerGateOutput {
  device: Record<string, string>;
  result: PlayerResult;
  runs: PlayerResult[];
  faults: FaultReport[];
  crashes: string[];
  soak?: SoakReport;
  stress?: StressReport;
}

/** Options of {@link runPlayerGate}. */
export interface PlayerGateOptions {
  exec: Exec;
  sim: SimControl;
  target?: GateTarget;
  avd?: string;
  build?: boolean;
  app?: string;
  deviceName?: string;
  device?: GateDevice;
  channels?: readonly string[];
  stream?: PlayerStreamKind;
  rate?: number;
  /** Live TS initial burst in seconds (0–30, default 0). */
  burst?: number;
  /** Soak hold in minutes (1–180): one run, judged by {@link judgeSoak}. */
  soak?: number;
  /** Stress mode: `runs` (default 3) of 200 zaps at 5/s, judged on counters only. */
  stress?: boolean;
  /** Zaps per zap run (default 30, or 200 with `stress`). */
  zaps?: number;
  /** Zap runs; the result combines them (default 3). */
  runs?: number;
  /** Also run one run per fault. */
  faults?: boolean;
  root?: string;
  adb?: string;
  /** The simulator's request log (default: over HTTP on 127.0.0.1:7878). */
  log?: SimLog;
  /** FFmpeg lookup (default: the simulator's); required only when starting the simulator locally. */
  ffmpeg?: () => string | null;
  now?: () => number;
  onRun?: (run: PlayerResult) => void;
  onFault?: (report: FaultReport) => void;
  onNote?: (note: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

function buildLink(opts: {
  host: string;
  channels: readonly string[];
  zaps: number;
  rate: number;
  fault: string;
  stream: PlayerStreamKind;
  soak?: number;
  burst?: number;
}): string {
  const stream = opts.stream === 'ts' ? '' : `&stream=${opts.stream}`;
  const soak = opts.soak === undefined ? '' : `&soak=${opts.soak}`;
  const burst = (opts.burst ?? 0) > 0 ? `&burst=${opts.burst}` : '';
  return `elviptv://gate/player?host=${opts.host}&account=${ACCOUNT}&channels=${opts.channels.join(',')}&zaps=${opts.zaps}&rate=${opts.rate}&fault=${opts.fault}${stream}${soak}${burst}`;
}

/**
 * Installs the development app, starts the stream simulator (or reuses a running one without requiring local FFmpeg),
 * and runs zap, fault, soak or stress sessions against `elviptv://gate/player`.
 */
export async function runPlayerGate(opts: PlayerGateOptions): Promise<PlayerGateOutput> {
  const lookup = opts.ffmpeg ?? findFfmpeg;
  if (lookup() === null && opts.sim.running !== undefined && !(await opts.sim.running())) {
    throw new Error(NO_FFMPEG);
  }
  const target = opts.target ?? 'android-tv';
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const channels = opts.channels ?? DEFAULT_CHANNELS;
  const stream = opts.stream ?? 'ts';
  const burstSec = opts.burst ?? 0;
  const runs = Math.max(1, opts.runs ?? 3);
  const log = opts.log ?? httpSimLog('http://127.0.0.1:7878');

  if (opts.build === true && target === 'android-tv') await buildApk(opts.exec, root, adb);
  const sim = await opts.sim.ensure();
  if (!sim.reused && lookup() === null) {
    await sim.stop();
    throw new Error(NO_FFMPEG);
  }
  let device: GateDevice | undefined;
  try {
    if (sim.reused) opts.onNote?.('simulator already running on port 7878: reusing it');
    device = await resolveGateDevice({
      exec: opts.exec,
      target,
      adb,
      root,
      sleep,
      ...(opts.avd === undefined ? {} : { avd: opts.avd }),
      ...(opts.app === undefined ? {} : { app: opts.app }),
      ...(opts.deviceName === undefined ? {} : { deviceName: opts.deviceName }),
      ...(opts.device === undefined ? {} : { device: opts.device }),
    });
    const active = device;
    await active.install();

    const play = async (
      url: string,
      stayMs: number,
      sampleMemory = false,
    ): Promise<{ line: PlayerLine; crashes: string[]; memory: MemorySamples }> => {
      const startedAt = now();
      await active.start(url, { afterStop: () => log.clear() });
      const timeoutMs = stayMs + LINE_MARGIN_MS;
      let firstMb: number | null = null;
      for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
        if (sampleMemory && firstMb === null && waited >= MEMORY_WARMUP_MS) {
          firstMb = await active.memoryMb();
        }
        const line = parsePlayerLine(await active.readLog());
        if (line !== undefined) {
          const lastMb = sampleMemory && line.ttffColdMs !== null ? await active.memoryMb() : null;
          await active.stop();
          await sleep(POLL_MS);
          const crashes = await active.crashesSince(startedAt);
          return {
            line,
            crashes,
            memory: { firstMb: line.ttffColdMs === null ? null : firstMb, lastMb },
          };
        }
        await sleep(POLL_MS);
      }
      throw new Error(
        `gate: no ELV_GATE_PLAYER line within ${Math.round(timeoutMs / 1000)} s; the run did not finish`,
      );
    };

    const link = (zaps: number, rate: number, fault: string, soak?: number): string =>
      buildLink({
        host: active.simHost,
        channels,
        zaps,
        rate,
        fault,
        stream,
        burst: burstSec,
        ...(soak === undefined ? {} : { soak }),
      });

    if (opts.soak !== undefined) {
      const minutes = opts.soak;
      const done = await play(link(1, ZAP_RATE, '', minutes), minutes * 60_000, true);
      const stat = connectionStats(await log.entries(), ACCOUNT);
      const verdict = judgeSoak(done.line, { stream, crashes: done.crashes, memory: done.memory });
      const single = aggregateRuns([done.line], [stat], burstSec);
      const info = await active.describe();
      return {
        device: info,
        result: single,
        runs: [single],
        faults: [],
        crashes: done.crashes,
        soak: {
          minutes,
          stream,
          line: done.line,
          memory: done.memory,
          crashes: done.crashes,
          ...stat,
          verdict,
        },
      };
    }

    const stress = opts.stress === true;
    const zaps = opts.zaps ?? (stress ? STRESS_ZAPS : 30);
    const rate = opts.rate ?? (stress ? STRESS_RATE : ZAP_RATE);

    const lines: PlayerLine[] = [];
    const stats: { limitResponses: number; overlapMs: number }[] = [];
    const stressRuns: StressRun[] = [];
    const crashes: string[] = [];

    for (let i = 0; i < runs; i++) {
      const done = await play(link(zaps, rate, ''), (zaps / rate) * 1000);
      if (done.line.fault !== '' || (!stress && done.line.zaps < zaps)) {
        throw new Error(
          `gate: the screen ran fault "${done.line.fault}" with ${done.line.zaps} zaps, requested no fault and ${zaps} zaps`,
        );
      }
      const stat = connectionStats(await log.entries(), ACCOUNT);
      lines.push(done.line);
      stats.push(stat);
      crashes.push(...done.crashes);
      stressRuns.push({ line: done.line, ...stat, crashes: done.crashes });
      opts.onRun?.(aggregateRuns([done.line], [stat], burstSec));
    }

    const faults: FaultReport[] = [];
    const runFaults = !stress && opts.faults === true ? faultsFor(target) : [];
    for (const fault of runFaults) {
      const fRate = faultRate(fault, burstSec);
      const done = await play(link(FAULT_ZAPS, fRate, fault), (FAULT_ZAPS / fRate) * 1000);
      const entries = await log.entries();
      const verdict = judgeFault(fault, done.line, entries, channels[0] as string, burstSec);
      verdict.failures.push(...crashFailures(done.crashes));
      const report: FaultReport = {
        fault,
        line: done.line,
        ...verdict,
        ...connectionStats(entries, ACCOUNT),
        crashes: done.crashes,
      };
      faults.push(report);
      opts.onFault?.(report);
    }

    const info = await active.describe();
    const perRun = lines.map((l, i) =>
      aggregateRuns([l], [stats[i] as (typeof stats)[number]], burstSec),
    );
    return {
      device: info,
      result: aggregateRuns(lines, stats, burstSec),
      runs: perRun,
      faults,
      crashes,
      ...(stress
        ? { stress: { zaps, runs: stressRuns, verdict: judgeStress(stressRuns, zaps) } }
        : {}),
    };
  } finally {
    try {
      await device?.close();
    } finally {
      await sim.stop();
    }
  }
}
