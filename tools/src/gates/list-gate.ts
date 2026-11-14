import {
  type AdbDevice,
  APP_PACKAGE,
  buildApk,
  type Exec,
  installApk,
  openDevice,
  POLL_MS,
  startGate,
} from './adb.ts';
import type { GateMetrics, GateResult, RealKeys } from './compare.ts';
import { type FrameStats, parseGfxinfo } from './gfxinfo.ts';
import { expectedHoldMoves, HOLD_TOLERANCE } from './hold.ts';

export {
  deviceInfo,
  type Exec,
  findDevice,
  resolveAdb,
  topActivity,
} from './adb.ts';

const WAIT_MARGIN_MS = 30_000;
const KEY_DOWN = '20';
const KEY_DOWN_NAME = 'KEYCODE_DPAD_DOWN';
const HOLD_MIN_SDK = 33;
const APP_BOOT_MS = 3000;
const BURST_IDLE_MS = 2000;

/** Options of {@link runListGate}. */
export interface ListGateOptions {
  exec: Exec;
  /** Name of the AVD to use when several devices run; with one device it is optional. */
  avd?: string;
  /** Build the development release APK before installing it. */
  build?: boolean;
  /** Number of real D-pad presses to send after the auto runs (0 or undefined: none). */
  realKeys?: number;
  /** Duration in ms of one real held Down key (API 33+); the move count is checked against the interpreter. */
  realHold?: number;
  /** Number of auto runs; the result is the median per metric (default 1). */
  runs?: number;
  items?: number;
  rate?: number;
  moves?: number;
  /** Repository root (default: the current directory). */
  root?: string;
  /** The adb executable (default `adb` from PATH; see {@link resolveAdb}). */
  adb?: string;
  /** Called with the result of each auto run as it finishes, before the median is taken. */
  onRun?: (run: GateResult) => void;
  sleep?: (ms: number) => Promise<void>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function toMetrics(value: unknown): GateMetrics | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const k = v.keyToHighlightMs as Record<string, unknown> | null | undefined;
  if (
    !isNumber(v.moves) ||
    !isNumber(v.coalesced) ||
    !isNumber(v.losses) ||
    !isNumber(v.maxJsGapMs) ||
    !isNumber(v.items) ||
    typeof k !== 'object' ||
    k === null ||
    !isNumber(k.p50) ||
    !isNumber(k.p95) ||
    !isNumber(k.max)
  ) {
    return undefined;
  }
  return {
    moves: v.moves,
    ...(isNumber(v.scripted) ? { scripted: v.scripted } : {}),
    coalesced: v.coalesced,
    losses: v.losses,
    keyToHighlightMs: { p50: k.p50, p95: k.p95, max: k.max },
    maxJsGapMs: v.maxJsGapMs,
    ...(isNumber(v.maxFrameStallMs) ? { maxFrameStallMs: v.maxFrameStallMs } : {}),
    items: v.items,
  };
}

/** The metrics of the last well-formed `ELV_GATE {json}` line in a logcat dump, or undefined. */
export function parseGateLine(logcat: string): GateMetrics | undefined {
  let found: GateMetrics | undefined;
  for (const line of logcat.split(/\r?\n/)) {
    const at = line.indexOf('ELV_GATE {');
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      found = toMetrics(JSON.parse(line.slice(at + 'ELV_GATE '.length, end + 1))) ?? found;
    } catch {
      // a truncated or foreign line: keep the previous one
    }
  }
  return found;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value * 100) / 100;
};
const pick = <T>(items: T[], f: (item: T) => number): number => median(items.map(f));

function medianMetrics(runs: GateMetrics[]): GateMetrics {
  const stalls = runs.map((r) => r.maxFrameStallMs).filter(isNumber);
  const scripted = runs.map((r) => r.scripted).filter(isNumber);
  return {
    moves: pick(runs, (r) => r.moves),
    ...(scripted.length === runs.length ? { scripted: median(scripted) } : {}),
    coalesced: pick(runs, (r) => r.coalesced),
    losses: Math.max(...runs.map((r) => r.losses)),
    keyToHighlightMs: {
      p50: pick(runs, (r) => r.keyToHighlightMs.p50),
      p95: pick(runs, (r) => r.keyToHighlightMs.p95),
      max: pick(runs, (r) => r.keyToHighlightMs.max),
    },
    maxJsGapMs: pick(runs, (r) => r.maxJsGapMs),
    ...(stalls.length === runs.length ? { maxFrameStallMs: median(stalls) } : {}),
    items: pick(runs, (r) => r.items),
  };
}

function medianFrames(runs: FrameStats[]): FrameStats {
  const legacy = runs.map((r) => r.legacyJankyPercent).filter(isNumber);
  return {
    totalFrames: pick(runs, (r) => r.totalFrames),
    jankyPercent: pick(runs, (r) => r.jankyPercent),
    ...(legacy.length === runs.length ? { legacyJankyPercent: median(legacy) } : {}),
    p50: pick(runs, (r) => r.p50),
    p90: pick(runs, (r) => r.p90),
    p95: pick(runs, (r) => r.p95),
    p99: pick(runs, (r) => r.p99),
  };
}

/**
 * Builds (optional) and installs the development app on the Android TV emulator, runs the list gate `runs` times
 * through the `elviptv://gate/list` deep link, reads each run's `ELV_GATE` line and `dumpsys gfxinfo`, and returns the
 * median per metric (losses: the maximum). With `realKeys` it then sends that many real D-pad presses, one per second,
 * and adds the burst's key-to-highlight. Every wait has a timeout; failures throw a one-line `Error`.
 */
export async function runListGate(opts: ListGateOptions): Promise<GateResult> {
  const { exec } = opts;
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const items = opts.items ?? 100_000;
  const rate = opts.rate ?? 20;
  const moves = opts.moves ?? 600;
  const runs = Math.max(1, opts.runs ?? 1);

  if (opts.build === true) await buildApk(exec, root, adb);

  const device: AdbDevice = await openDevice(exec, adb, opts.avd);
  const { dev, shell } = device;
  await installApk(exec, adb, device.serial, root);

  const urlFor = (auto: boolean) =>
    `elviptv://gate/list?items=${items}&auto=${auto ? 1 : 0}&rate=${rate}&moves=${moves}`;

  const start = (url: string) => startGate(device, sleep, url, { resetFrames: true });

  const waitForLine = async (timeoutMs: number): Promise<GateMetrics> => {
    for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
      const metrics = parseGateLine((await dev('logcat', '-d', '-s', 'ReactNativeJS:V')).output);
      if (metrics !== undefined) return metrics;
      await sleep(POLL_MS);
    }
    throw new Error(
      `gate: no ELV_GATE line within ${Math.round(timeoutMs / 1000)} s; the run did not finish`,
    );
  };

  const autoRuns: GateMetrics[] = [];
  const frameRuns: FrameStats[] = [];
  for (let i = 0; i < runs; i++) {
    await start(urlFor(true));
    autoRuns.push(await waitForLine((moves / rate) * 1000 + WAIT_MARGIN_MS));
    const frames = parseGfxinfo((await shell('dumpsys', 'gfxinfo', APP_PACKAGE)).output);
    if (frames === undefined) throw new Error('gate: gfxinfo reported no rendered frames');
    frameRuns.push(frames);
    opts.onRun?.({ metrics: autoRuns[i] as GateMetrics, frames });
  }

  const result: GateResult = { metrics: medianMetrics(autoRuns), frames: medianFrames(frameRuns) };
  const holdMs = opts.realHold ?? 0;
  if (holdMs > 0) {
    const sdk = Number((await shell('getprop', 'ro.build.version.sdk')).output.trim());
    if (!(sdk >= HOLD_MIN_SDK)) {
      throw new Error('gate: --real-hold needs API 33 or newer (input keyevent --duration)');
    }
  }
  const presses = opts.realKeys ?? 0;
  if (presses > 0) {
    await start(urlFor(false));
    await sleep(APP_BOOT_MS);
    for (let i = 0; i < presses; i++) {
      await shell('input', 'keyevent', KEY_DOWN);
      await sleep(POLL_MS);
    }
    const burst = await waitForLine(BURST_IDLE_MS + WAIT_MARGIN_MS);
    if (burst.moves < presses) {
      throw new Error(`gate: only ${burst.moves} of ${presses} real key presses reached the app`);
    }
    const real: RealKeys = {
      p50: burst.keyToHighlightMs.p50,
      p95: burst.keyToHighlightMs.p95,
      max: burst.keyToHighlightMs.max,
      losses: burst.losses,
    };
    result.realKeys = real;
  }
  if (holdMs > 0) {
    await start(urlFor(false));
    await sleep(APP_BOOT_MS);
    await shell('input', 'keyevent', '--duration', String(holdMs), KEY_DOWN_NAME);
    const held = await waitForLine(holdMs + BURST_IDLE_MS + WAIT_MARGIN_MS);
    const expected = expectedHoldMoves(holdMs);
    if (Math.abs(held.moves - expected) > HOLD_TOLERANCE) {
      throw new Error(
        `gate: a ${holdMs} ms hold gave ${held.moves} moves, expected ${expected} ± ${HOLD_TOLERANCE}`,
      );
    }
    result.realHold = { holdMs, moves: held.moves, expected };
  }
  return result;
}
