import { existsSync } from 'node:fs';
import { buildPrebuildCommand } from '../run-command.ts';
import type { GateMetrics, GateResult, RealKeys } from './compare.ts';
import { type FrameStats, parseGfxinfo } from './gfxinfo.ts';
import { expectedHoldMoves, HOLD_TOLERANCE } from './hold.ts';

/** Package of the development variant, the only one that contains the gate screen. */
const APP_PACKAGE = 'io.github.fatihmutluu.elviptv.dev';
const APK = 'apps/tv-mobile/android/app/build/outputs/apk/release/app-release.apk';
const POLL_MS = 1000;
const FOREGROUND_POLLS = 8;
const WAIT_MARGIN_MS = 30_000;
const KEY_DOWN = '20';
const KEY_BACK = '4';
const KEY_DOWN_NAME = 'KEYCODE_DPAD_DOWN';
const HOLD_MIN_SDK = 33;
const APP_BOOT_MS = 3000;
const BURST_IDLE_MS = 2000;
const ADB_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;

/** Runs one adb command with a timeout; a hung command throws instead of blocking the gate. */
async function adbCall(
  exec: Exec,
  adb: string,
  args: string[],
  timeoutMs = ADB_TIMEOUT_MS,
): Promise<ExecResult> {
  const result = await exec(adb, args, { timeoutMs });
  if (result.timedOut === true) {
    const shown = args[0] === '-s' ? args.slice(2) : args;
    throw new Error(
      `gate: adb ${shown.join(' ')} timed out after ${Math.round(timeoutMs / 1000)} s`,
    );
  }
  return result;
}

/** Output of a finished process. */
interface ExecResult {
  ok: boolean;
  output: string;
  /** The process was killed because it ran longer than `timeoutMs`. */
  timedOut?: boolean;
}

/** Runs a process and captures its combined output; injected so tests never start adb. */
export type Exec = (
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<ExecResult>;

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

/** Finds adb in `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the default SDK folder, else relies on PATH. */
export function resolveAdb(
  env: Record<string, string | undefined>,
  platform: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const win = platform === 'win32';
  const name = win ? 'adb.exe' : 'adb';
  const sep = win ? '\\' : '/';
  const home = win ? env.LOCALAPPDATA : env.HOME;
  const defaultSdk =
    home === undefined ? undefined : `${home}${sep}${win ? 'Android\\Sdk' : 'Android/Sdk'}`;
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaultSdk]) {
    if (sdk === undefined || sdk === '') continue;
    const candidate = `${sdk}${sep}platform-tools${sep}${name}`;
    if (exists(candidate)) return candidate;
  }
  return 'adb';
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

/** The resumed activity (`package/.Class`) from `dumpsys activity activities`, or undefined. */
export function topActivity(dump: string): string | undefined {
  const match = /topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)/.exec(dump);
  return match?.[1];
}

/** Serial of the device to measure: the emulator running `avd`, or the only attached device. */
export async function findDevice(exec: Exec, adb: string, avd?: string): Promise<string> {
  const listing = await adbCall(exec, adb, ['devices']);
  const serials = listing.output
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => cols[1]?.trim() === 'device')
    .map((cols) => cols[0] as string);
  if (avd !== undefined) {
    for (const serial of serials) {
      const name = await adbCall(exec, adb, ['-s', serial, 'emu', 'avd', 'name']);
      if (name.output.split(/\r?\n/)[0]?.trim() === avd) return serial;
    }
    throw new Error(
      `gate: no running emulator for AVD "${avd}"; start it with: emulator -avd ${avd}`,
    );
  }
  if (serials.length === 0) {
    throw new Error('gate: no device attached; start an Android TV emulator');
  }
  if (serials.length > 1) {
    throw new Error(
      `gate: ${serials.length} devices attached (${serials.join(', ')}); pass --avd <name>`,
    );
  }
  return serials[0] as string;
}

/** Product name, Android release and API level of a device, for the baseline metadata. */
export async function deviceInfo(
  exec: Exec,
  adb: string,
  serial: string,
): Promise<{ model: string; release: string; sdk: string }> {
  const prop = async (name: string) =>
    (await adbCall(exec, adb, ['-s', serial, 'shell', 'getprop', name])).output.trim();
  return {
    model: await prop('ro.product.name'),
    release: await prop('ro.build.version.release'),
    sdk: await prop('ro.build.version.sdk'),
  };
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

async function buildApk(exec: Exec, root: string, adb: string): Promise<void> {
  const sdk = /^(.*)[\\/]platform-tools[\\/][^\\/]*$/.exec(adb)?.[1];
  const prebuild = buildPrebuildCommand({
    target: 'android-tv',
    variant: 'development',
    devEnv: {},
  });
  const steps = [
    {
      command: prebuild.command,
      args: prebuild.args,
      cwd: `${root}/${prebuild.cwd}`,
      env: prebuild.env,
    },
    {
      command: process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew',
      args: ['assembleRelease', '--console=plain'],
      cwd: `${root}/${prebuild.cwd}/android`,
      env: {
        APP_VARIANT: 'development',
        EXPO_TV: '1',
        ...(sdk === undefined ? {} : { ANDROID_HOME: sdk }),
      },
    },
  ];
  for (const step of steps) {
    const done = await exec(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (!done.ok) {
      const tail = done.output.trim().split(/\r?\n/).slice(-5).join('\n');
      throw new Error(`gate: ${step.command} failed\n${tail}`);
    }
  }
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

  const serial = await findDevice(exec, adb, opts.avd);
  const dev = (...args: string[]): Promise<ExecResult> =>
    adbCall(exec, adb, ['-s', serial, ...args]);
  const shell = (...args: string[]) => dev('shell', ...args);

  const booted = await shell('getprop', 'sys.boot_completed');
  if (booted.output.trim() !== '1') throw new Error(`gate: ${serial} has not finished booting`);
  const install = await adbCall(
    exec,
    adb,
    ['-s', serial, 'install', '-r', `${root}/${APK}`],
    INSTALL_TIMEOUT_MS,
  );
  if (!install.ok || !install.output.includes('Success')) {
    const reason = install.output.trim().split(/\r?\n/).pop() ?? '';
    throw new Error(`gate: adb install failed (${reason}); build the APK first with --build`);
  }

  const urlFor = (auto: boolean) =>
    `elviptv://gate/list?items=${items}&auto=${auto ? 1 : 0}&rate=${rate}&moves=${moves}`;

  const launch = async (url: string) => {
    await shell('am', 'force-stop', APP_PACKAGE);
    await dev('logcat', '-c');
    await shell('dumpsys', 'gfxinfo', APP_PACKAGE, 'reset');
    await shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, APP_PACKAGE);
  };

  const foregroundBlocker = async (): Promise<string | undefined> => {
    let other: string | undefined;
    for (let i = 0; i < FOREGROUND_POLLS; i++) {
      other = topActivity((await shell('dumpsys', 'activity', 'activities')).output);
      if (other === undefined || other.startsWith(`${APP_PACKAGE}/`)) return undefined;
      await sleep(POLL_MS);
    }
    return other;
  };

  const start = async (url: string) => {
    await launch(url);
    if ((await foregroundBlocker()) === undefined) return;
    await shell('input', 'keyevent', KEY_BACK);
    await sleep(POLL_MS);
    await launch(url);
    const again = await foregroundBlocker();
    if (again !== undefined) {
      throw new Error(
        `gate: ${again} holds the foreground, not the app; dismiss it on the device and rerun`,
      );
    }
  };

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
