import { findFfmpeg } from '../sim/media.ts';
import { androidGateDevice, buildApk, type Exec, POLL_MS } from './adb.ts';
import type { GateDevice, GateTarget } from './gate-device.ts';
import type { SimControl } from './import-gate.ts';
import { ACCOUNT, crashFailures } from './player-judge.ts';
import { appleSimDevice } from './simctl.ts';

const CONTRACT_TIMEOUT_MS = 180_000;

interface ContractFailure {
  name: string;
  message: string;
}

/** Parsed payload of `ELV_GATE_CONTRACT {json}`. */
export interface ContractLine {
  passed: number;
  failed: ContractFailure[];
}

/** Verdict of an engine-contract gate run. */
export interface ContractVerdict {
  ok: boolean;
  failures: string[];
}

/** Options of {@link runContractGate}. */
export interface ContractGateOptions {
  exec: Exec;
  sim: SimControl;
  target?: GateTarget;
  avd?: string;
  build?: boolean;
  app?: string;
  deviceName?: string;
  device?: GateDevice;
  root?: string;
  adb?: string;
  ffmpeg?: () => string | null;
  now?: () => number;
  onNote?: (note: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Output of {@link runContractGate}. */
export interface ContractGateOutput {
  device: Record<string, string>;
  line: ContractLine;
  crashes: string[];
  outcome: ContractVerdict;
}

function readContract(value: unknown): ContractLine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.passed !== 'number' || !Number.isInteger(v.passed) || v.passed < 0) return undefined;
  if (!Array.isArray(v.failed)) return undefined;
  const failed: ContractFailure[] = [];
  for (const item of v.failed) {
    if (typeof item !== 'object' || item === null) return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== 'string' || typeof entry.message !== 'string') return undefined;
    failed.push({ name: entry.name, message: entry.message });
  }
  return { passed: v.passed, failed };
}

/** The last well-formed `ELV_GATE_CONTRACT {json}` line in a log dump, or undefined when there is none. */
export function parseContractLine(log: string): ContractLine | undefined {
  let found: ContractLine | undefined;
  const tag = 'ELV_GATE_CONTRACT {';
  for (const line of log.split(/\r?\n/)) {
    const at = line.indexOf(tag);
    const end = line.lastIndexOf('}');
    if (at < 0 || end < at) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(at + tag.length - 1, end + 1));
      found = readContract(parsed) ?? found;
    } catch {
      // a truncated or foreign line: keep the previous one
    }
  }
  return found;
}

/** Judges the contract line and any crash reports left by the run. */
export function judgeContract(
  line: ContractLine,
  crashes: readonly string[] = [],
): ContractVerdict {
  const failures = line.failed.map((f) => `${f.name}: ${f.message}`);
  if (line.passed === 0 && line.failed.length === 0) failures.push('contract: 0 cases ran');
  failures.push(...crashFailures(crashes));
  return { ok: failures.length === 0, failures };
}

const NO_FFMPEG =
  'gate: FFmpeg not found: set FFMPEG_PATH or install FFmpeg; the simulator needs it for live streams';

/** Opens the target's {@link GateDevice} when no test double was injected. */
export async function resolveGateDevice(opts: {
  exec: Exec;
  target: GateTarget;
  adb: string;
  root: string;
  avd?: string;
  app?: string;
  deviceName?: string;
  device?: GateDevice;
  sleep: (ms: number) => Promise<void>;
}): Promise<GateDevice> {
  if (opts.device !== undefined) return opts.device;
  if (opts.target === 'android-tv') {
    return androidGateDevice(opts.exec, {
      adb: opts.adb,
      root: opts.root,
      sleep: opts.sleep,
      ...(opts.avd === undefined ? {} : { avd: opts.avd }),
    });
  }
  if (opts.app === undefined || opts.app === '') {
    throw new Error(`gate: --target ${opts.target} requires --app <path/to/App.app>`);
  }
  return appleSimDevice(opts.exec, {
    platform: opts.target,
    app: opts.app,
    ...(opts.deviceName === undefined ? {} : { device: opts.deviceName }),
  });
}

/**
 * Installs the development app, ensures the stream simulator (reusing a running one without requiring local FFmpeg),
 * opens `elviptv://gate/contract` with the device's `simHost` and waits at most 180 s for `ELV_GATE_CONTRACT`.
 */
export async function runContractGate(opts: ContractGateOptions): Promise<ContractGateOutput> {
  const lookup = opts.ffmpeg ?? findFfmpeg;
  if (lookup() === null && opts.sim.running !== undefined && !(await opts.sim.running())) {
    throw new Error(NO_FFMPEG);
  }
  const target = opts.target ?? 'android-tv';
  const adb = opts.adb ?? 'adb';
  const root = opts.root ?? '.';
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

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
    await device.install();
    const startedAt = now();
    const url = `elviptv://gate/contract?host=${device.simHost}&account=${ACCOUNT}`;
    await device.start(url);
    for (let waited = 0; waited <= CONTRACT_TIMEOUT_MS; waited += POLL_MS) {
      const line = parseContractLine(await device.readLog());
      if (line !== undefined) {
        await device.stop();
        await sleep(POLL_MS);
        const crashes = await device.crashesSince(startedAt);
        const info = await device.describe();
        return { device: info, line, crashes, outcome: judgeContract(line, crashes) };
      }
      await sleep(POLL_MS);
    }
    throw new Error(
      `gate: no ELV_GATE_CONTRACT line within ${Math.round(CONTRACT_TIMEOUT_MS / 1000)} s; the run did not finish`,
    );
  } finally {
    try {
      await device?.close();
    } finally {
      await sim.stop();
    }
  }
}
