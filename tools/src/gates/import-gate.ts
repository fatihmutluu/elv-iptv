import {
  androidGateDevice,
  buildApk,
  deviceInfo,
  type Exec,
  installApk,
  openDevice,
  POLL_MS,
  startGate,
} from './adb.ts';
import type { BudgetMode, CompareOutcome } from './compare.ts';
import type { GateDevice, GateTarget } from './gate-device.ts';
import { appleSimDevice } from './simctl.ts';

const EMULATOR_HOST = '10.0.2.2:7878';
const STALL_BUDGET_MS = 100;
/** Absolute XMLTV guide import budget in milliseconds (5,000 ch × 7d `< 60 s`, `#25`). */
export const GUIDE_DURATION_BUDGET_MS = 60_000;
const DURATION_TOLERANCE = 1.1;
const DURATION_SLACK_MS = 2000;
const WAIT_MS = { large: 3 * 60_000, huge: 10 * 60_000 } as const;

/** Measured numbers of one import gate run (the `ELV_GATE_IMPORT` line without its failure variant). */
export interface ImportResult {
  account: string;
  batch: number;
  maxBody: number;
  rows: number;
  durationMs: number;
  maxStallMs: number;
  guideDurationMs?: number;
  guideProgrammes?: number;
  guideMatchedChannels?: number;
  guideMaxStallMs?: number;
  guideError?: string;
}

/** The simulator the gate talks to: started for the run, or an already running one that is left alone. */
export interface SimControl {
  running?(): Promise<boolean>;
  ensure(): Promise<{ reused: boolean; reset?(): Promise<void>; stop(): Promise<void> }>;
}

/** Options of {@link runImportGate}. */
export interface ImportGateOptions {
  exec: Exec;
  sim: SimControl;
  target?: GateTarget;
  avd?: string;
  build?: boolean;
  app?: string;
  deviceName?: string;
  device?: GateDevice;
  /** `large` or `huge` (default `large`). */
  account?: string;
  batch?: number;
  /** Per-response body cap in KiB. */
  maxBody?: number;
  /** Also run streaming XMLTV guide import (`guide=1`, `#25`) and check `< 60 s` budget. */
  guide?: boolean;
  /** Number of runs; the result is the median per metric (default 3, like the list gate; a first run is often slow). */
  runs?: number;
  root?: string;
  adb?: string;
  onRun?: (run: ImportResult) => void;
  /** Progress messages, for example that a running simulator is reused. */
  onNote?: (note: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * The last well-formed `ELV_GATE_IMPORT {json}` line in a logcat dump: the metrics, `{ error }` for a failed import,
 * or undefined when there is none.
 */
export function parseImportLine(logcat: string): ImportResult | { error: string } | undefined {
  let found: ImportResult | { error: string } | undefined;
  for (const line of logcat.split(/\r?\n/)) {
    const tag = 'ELV_GATE_IMPORT {';
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const v = JSON.parse(line.slice(at + tag.length - 1, end + 1)) as Record<string, unknown>;
      if (typeof v.error === 'string') {
        found = { error: v.error };
      } else if (
        typeof v.account === 'string' &&
        isNumber(v.batch) &&
        isNumber(v.maxBody) &&
        isNumber(v.rows) &&
        isNumber(v.durationMs) &&
        isNumber(v.maxStallMs)
      ) {
        found = {
          account: v.account,
          batch: v.batch,
          maxBody: v.maxBody,
          rows: v.rows,
          durationMs: v.durationMs,
          maxStallMs: v.maxStallMs,
          ...(isNumber(v.guideDurationMs) ? { guideDurationMs: v.guideDurationMs } : {}),
          ...(isNumber(v.guideProgrammes) ? { guideProgrammes: v.guideProgrammes } : {}),
          ...(isNumber(v.guideMatchedChannels)
            ? { guideMatchedChannels: v.guideMatchedChannels }
            : {}),
          ...(isNumber(v.guideMaxStallMs) ? { guideMaxStallMs: v.guideMaxStallMs } : {}),
          ...(typeof v.guideError === 'string' ? { guideError: v.guideError } : {}),
        };
      }
    } catch {
      // a truncated or foreign line: keep the previous one
    }
  }
  return found;
}

/**
 * Compares an import run with the baseline: the row count must match, the duration may grow at most 10 % (plus 2 s
 * slack), and for `large` the max stall must stay under 100 ms (a warning with `budgets: 'warn'`). `huge` is
 * report-only: every finding is a warning (a known stall tracked in #76).
 */
export function compareImport(
  result: ImportResult,
  baseline: ImportResult | undefined,
  opts: { budgets?: BudgetMode } = {},
): CompareOutcome {
  const failures: string[] = [];
  const warnings: string[] = [];
  const reportOnly = result.account !== 'large';
  const flag = (text: string, soft = false) => {
    if (reportOnly) warnings.push(`${text} (report-only for ${result.account})`);
    else if (soft) warnings.push(`${text} (--budgets warn: reported only)`);
    else failures.push(text);
  };

  if (baseline === undefined) {
    warnings.push('no baseline: only the absolute stall budget was checked');
  } else if (
    baseline.account !== result.account ||
    baseline.batch !== result.batch ||
    baseline.maxBody !== result.maxBody
  ) {
    flag(
      `not comparable: ${result.account}/${result.batch}/${result.maxBody} KiB, baseline has ${baseline.account}/${baseline.batch}/${baseline.maxBody} KiB`,
    );
  } else {
    if (result.rows !== baseline.rows) {
      flag(`rows ${result.rows} differ from the baseline ${baseline.rows}`);
    }
    const max = Math.max(
      baseline.durationMs * DURATION_TOLERANCE,
      baseline.durationMs + DURATION_SLACK_MS,
    );
    if (result.durationMs > max) {
      flag(
        `duration ${result.durationMs} ms exceeds the limit ${Math.round(max)} ms (baseline ${baseline.durationMs} ms)`,
      );
    }
  }
  if (result.maxStallMs > STALL_BUDGET_MS) {
    flag(
      `max stall ${result.maxStallMs} ms exceeds the absolute budget of ${STALL_BUDGET_MS} ms`,
      opts.budgets === 'warn',
    );
  }
  if (result.guideError !== undefined) {
    flag(`guide import failed: ${result.guideError}`);
  }
  if (result.guideDurationMs !== undefined) {
    if (result.guideDurationMs > GUIDE_DURATION_BUDGET_MS) {
      flag(
        `guide duration ${result.guideDurationMs} ms exceeds the absolute budget of ${GUIDE_DURATION_BUDGET_MS} ms`,
        opts.budgets === 'warn',
      );
    }
    if (result.guideProgrammes !== undefined && result.guideProgrammes <= 0) {
      flag('guide imported 0 programmes');
    }
    if (result.guideMaxStallMs !== undefined && result.guideMaxStallMs > STALL_BUDGET_MS) {
      flag(
        `guide max stall ${result.guideMaxStallMs} ms exceeds the absolute budget of ${STALL_BUDGET_MS} ms`,
        opts.budgets === 'warn',
      );
    }
  }
  return { ok: failures.length === 0, failures, warnings };
}

/** Median of a non-empty list, rounded to 0.01. */
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value * 100) / 100;
};

/** Output of {@link runImportGate}: measured metrics plus target device metadata. */
export interface ImportGateOutput {
  device: Record<string, string>;
  result: ImportResult;
}

/**
 * Builds (optional) and installs the development app on the target device, starts the stream simulator (or reuses a
 * running one), opens `elviptv://gate/import` `runs` times (default 3) and returns the median duration and stall
 * alongside target device metadata. The simulator it started is stopped afterwards, also on failure. Every wait has a
 * timeout; failures throw a one-line `Error`.
 */
export async function runImportGate(opts: ImportGateOptions): Promise<ImportGateOutput> {
  const account = opts.account ?? 'large';
  if (account !== 'large' && account !== 'huge') {
    throw new Error(`gate: the account is large or huge, not "${account}"`);
  }
  const target = opts.target ?? 'android-tv';
  const { exec } = opts;
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const batch = opts.batch ?? 5000;
  const maxBody = opts.maxBody ?? 4096;
  const runs = Math.max(1, opts.runs ?? 3);
  const guide = opts.guide === true;
  const timeoutMs = WAIT_MS[account] + (guide ? GUIDE_DURATION_BUDGET_MS : 0);
  const guideQuery = guide ? '&guide=1' : '';

  if (opts.build === true && target === 'android-tv') await buildApk(exec, root, adb);
  const sim = await opts.sim.ensure();
  let gateDevice: GateDevice | undefined;
  try {
    if (sim.reused) opts.onNote?.('simulator already running on port 7878: reusing it');
    await sim.reset?.();

    const useUnifiedDevice = target !== 'android-tv' || opts.device !== undefined;
    const done: ImportResult[] = [];
    let deviceMeta: Record<string, string>;

    if (useUnifiedDevice) {
      if (opts.device !== undefined) {
        gateDevice = opts.device;
      } else if (target === 'android-tv') {
        gateDevice = await androidGateDevice(exec, {
          adb,
          root,
          sleep,
          ...(opts.avd === undefined ? {} : { avd: opts.avd }),
        });
      } else {
        if (opts.app === undefined || opts.app === '') {
          throw new Error(`gate: --target ${target} requires --app <path/to/App.app>`);
        }
        gateDevice = await appleSimDevice(exec, {
          platform: target,
          app: opts.app,
          ...(opts.deviceName === undefined ? {} : { device: opts.deviceName }),
        });
      }
      await gateDevice.install();
      const url = `elviptv://gate/import?host=${gateDevice.simHost}&account=${account}&batch=${batch}&maxBody=${maxBody}${guideQuery}`;
      for (let i = 0; i < runs; i++) {
        await gateDevice.start(url);
        let runResult: ImportResult | undefined;
        for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
          const line = parseImportLine(await gateDevice.readLog());
          if (line !== undefined) {
            if ('error' in line) throw new Error(`gate: the import failed: ${line.error}`);
            runResult = line;
            break;
          }
          await sleep(POLL_MS);
        }
        if (runResult === undefined) {
          throw new Error(
            `gate: no ELV_GATE_IMPORT line within ${Math.round(timeoutMs / 1000)} s; the run did not finish`,
          );
        }
        done.push(runResult);
        opts.onRun?.(runResult);
      }
      deviceMeta = await gateDevice.describe();
    } else {
      const url = `elviptv://gate/import?host=${EMULATOR_HOST}&account=${account}&batch=${batch}&maxBody=${maxBody}${guideQuery}`;
      const device = await openDevice(exec, adb, opts.avd);
      await installApk(exec, adb, device.serial, root);

      const waitForLine = async (): Promise<ImportResult> => {
        for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
          const line = parseImportLine(
            (await device.dev('logcat', '-d', '-s', 'ReactNativeJS:V')).output,
          );
          if (line !== undefined) {
            if ('error' in line) throw new Error(`gate: the import failed: ${line.error}`);
            return line;
          }
          await sleep(POLL_MS);
        }
        throw new Error(
          `gate: no ELV_GATE_IMPORT line within ${Math.round(timeoutMs / 1000)} s; the run did not finish`,
        );
      };

      for (let i = 0; i < runs; i++) {
        await startGate(device, sleep, url);
        const run = await waitForLine();
        done.push(run);
        opts.onRun?.(run);
      }
      deviceMeta = await deviceInfo(exec, adb, device.serial);
    }

    const first = done[0] as ImportResult;
    const guideDurations = done.map((r) => r.guideDurationMs).filter(isNumber);
    const guideStalls = done.map((r) => r.guideMaxStallMs).filter(isNumber);
    return {
      device: deviceMeta,
      result: {
        ...first,
        durationMs: median(done.map((r) => r.durationMs)),
        maxStallMs: median(done.map((r) => r.maxStallMs)),
        ...(guideDurations.length === done.length
          ? { guideDurationMs: median(guideDurations) }
          : {}),
        ...(guideStalls.length === done.length ? { guideMaxStallMs: median(guideStalls) } : {}),
      },
    };
  } finally {
    try {
      await gateDevice?.close();
    } finally {
      await sim.stop();
    }
  }
}
