import { APP_PACKAGE, buildApk, type Exec, openDevice, POLL_MS } from './adb.ts';
import type { BudgetMode, CompareOutcome } from './compare.ts';
import { resolveGateDevice } from './contract-gate.ts';
import type { GateDevice, GateTarget } from './gate-device.ts';
import { type FrameStats, parseGfxinfo } from './gfxinfo.ts';
import { crashFailures } from './player-judge.ts';

const EPG_TIMEOUT_MS = 180_000;
const EPG_KEY_BUDGET_MS = 100;
const EPG_JANK_BUDGET_PCT = 5;

/** Parsed payload of `ELV_GATE {"gate":"epg",...}`. */
export interface EpgGateLine {
  readonly gate: 'epg';
  readonly channels: number;
  readonly days: number;
  readonly totalEstimatedProgrammes: number;
  readonly steps: number;
  readonly keyToHighlightP50Ms: number;
  readonly keyToHighlightP95Ms: number;
  readonly keyToHighlightMaxMs: number;
  readonly maxJsTaskMs: number;
  readonly framesOver16Ms: number;
  readonly focusContinuityOk: boolean;
  readonly passed: boolean;
}

/** Options of {@link runEpgGate}. */
export interface EpgGateOptions {
  exec: Exec;
  target?: GateTarget;
  avd?: string;
  build?: boolean;
  app?: string;
  deviceName?: string;
  device?: GateDevice;
  channels?: number;
  days?: number;
  moves?: number;
  budgets?: BudgetMode;
  root?: string;
  adb?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Output of {@link runEpgGate}. */
export interface EpgGateOutput {
  device: Record<string, string>;
  line: EpgGateLine;
  frames?: FrameStats;
  crashes: string[];
  outcome: CompareOutcome;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function toEpgLine(value: unknown): EpgGateLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.gate !== 'epg' ||
    !isNumber(v.channels) ||
    !isNumber(v.days) ||
    !isNumber(v.totalEstimatedProgrammes) ||
    !isNumber(v.steps) ||
    !isNumber(v.keyToHighlightP50Ms) ||
    !isNumber(v.keyToHighlightP95Ms) ||
    !isNumber(v.keyToHighlightMaxMs) ||
    !isNumber(v.maxJsTaskMs) ||
    !isNumber(v.framesOver16Ms) ||
    typeof v.focusContinuityOk !== 'boolean' ||
    typeof v.passed !== 'boolean'
  ) {
    return undefined;
  }
  return {
    gate: 'epg',
    channels: v.channels,
    days: v.days,
    totalEstimatedProgrammes: v.totalEstimatedProgrammes,
    steps: v.steps,
    keyToHighlightP50Ms: v.keyToHighlightP50Ms,
    keyToHighlightP95Ms: v.keyToHighlightP95Ms,
    keyToHighlightMaxMs: v.keyToHighlightMaxMs,
    maxJsTaskMs: v.maxJsTaskMs,
    framesOver16Ms: v.framesOver16Ms,
    focusContinuityOk: v.focusContinuityOk,
    passed: v.passed,
  };
}

/** Extracts the last well-formed `ELV_GATE {"gate":"epg",...}` line from a log dump. */
export function parseEpgGateLine(log: string): EpgGateLine | undefined {
  let found: EpgGateLine | undefined;
  const tag = 'ELV_GATE {';
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(at + tag.length - 1, end + 1));
      found = toEpgLine(parsed) ?? found;
    } catch {
      // truncated or unrelated line
    }
  }
  return found;
}

/** Judges an EPG proof gate run against focus continuity, `< 100 ms` key-to-highlight, and frame jank budgets. */
export function judgeEpgGate(
  line: EpgGateLine,
  opts: {
    readonly frames?: FrameStats;
    readonly crashes?: readonly string[];
    readonly budgets?: BudgetMode;
  } = {},
): CompareOutcome {
  const failures: string[] = [];
  const warnings: string[] = [];
  const soft = opts.budgets === 'warn';
  const flag = (msg: string, canWarn: boolean) => {
    if (canWarn && soft) warnings.push(`${msg} (--budgets warn: reported only)`);
    else failures.push(msg);
  };

  if (line.steps <= 0) {
    failures.push('epg gate: 0 navigation steps recorded');
  }
  if (!line.focusContinuityOk) {
    failures.push('epg gate: focus continuity failed during scripted virtualization/recycling');
  }
  if (line.keyToHighlightP95Ms >= EPG_KEY_BUDGET_MS) {
    flag(
      `key-to-highlight p95 ${line.keyToHighlightP95Ms} ms exceeds budget < ${EPG_KEY_BUDGET_MS} ms`,
      true,
    );
  }
  if (line.keyToHighlightMaxMs >= EPG_KEY_BUDGET_MS) {
    flag(
      `key-to-highlight max ${line.keyToHighlightMaxMs} ms exceeds budget < ${EPG_KEY_BUDGET_MS} ms`,
      true,
    );
  }
  if (opts.frames !== undefined && opts.frames.jankyPercent > EPG_JANK_BUDGET_PCT) {
    flag(
      `janky frames ${opts.frames.jankyPercent}% exceeds budget <= ${EPG_JANK_BUDGET_PCT}%`,
      true,
    );
  }
  failures.push(...crashFailures(opts.crashes ?? []));
  return { ok: failures.length === 0, failures, warnings };
}

/**
 * Installs the development app on Android TV (`adb` + `dumpsys gfxinfo`) or tvOS (`simctl`),
 * launches `elviptv://gate/epg`, waits for `ELV_GATE {"gate":"epg",...}`, and judges budgets.
 */
export async function runEpgGate(opts: EpgGateOptions): Promise<EpgGateOutput> {
  const target = opts.target ?? 'android-tv';
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const channels = opts.channels ?? 1000;
  const days = opts.days ?? 7;
  const moves = opts.moves ?? 220;

  if (opts.build === true && target === 'android-tv') await buildApk(opts.exec, root, adb);
  const device = await resolveGateDevice({
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

  try {
    await device.install();
    const startedAt = now();
    const url = `elviptv://gate/epg?channels=${channels}&days=${days}&moves=${moves}&auto=1`;
    await device.start(url, { resetFrames: true });

    for (let waited = 0; waited <= EPG_TIMEOUT_MS; waited += POLL_MS) {
      const line = parseEpgGateLine(await device.readLog());
      if (line !== undefined) {
        let frames: FrameStats | undefined;
        if (target === 'android-tv' && opts.device === undefined) {
          const adbDev = await openDevice(opts.exec, adb, opts.avd);
          const gfx = await adbDev.dev('shell', 'dumpsys', 'gfxinfo', APP_PACKAGE);
          frames = parseGfxinfo(gfx.output);
        }
        await device.stop();
        await sleep(POLL_MS);
        const crashes = await device.crashesSince(startedAt);
        const info = await device.describe();
        const outcome = judgeEpgGate(line, {
          ...(frames !== undefined ? { frames } : {}),
          crashes,
          ...(opts.budgets !== undefined ? { budgets: opts.budgets } : {}),
        });
        return {
          device: info,
          line,
          ...(frames !== undefined ? { frames } : {}),
          crashes,
          outcome,
        };
      }
      await sleep(POLL_MS);
    }
    throw new Error(
      `gate: no ELV_GATE epg line within ${Math.round(EPG_TIMEOUT_MS / 1000)} s; the run did not finish`,
    );
  } finally {
    await device.close();
  }
}
