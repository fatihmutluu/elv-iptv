import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import { type Exec, resolveAdb } from './adb.ts';
import { type BudgetMode, baselineTargetRefusal, type CompareOutcome } from './compare.ts';
import type { GateTarget } from './gate-device.ts';
import {
  comparePlayer,
  type FaultReport,
  type PlayerResult,
  type PlayerStreamKind,
  runPlayerGate,
  type SoakReport,
} from './player-gate.ts';
import { crashFailures } from './player-judge.ts';
import { localSim } from './sim-control.ts';

/** The usage line of `pnpm gate player`. */
export const PLAYER_USAGE =
  'usage: pnpm gate player [--target android-tv|tvos|ios] [--avd elv_tv] [--build] [--app <.app>] [--device <name>] [--channels 1001,1002,...] [--stream ts|hls|vod] [--rate 0.5] [--soak <min>] [--stress] [--runs 3] [--zaps 30] [--faults] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]';

const DEFAULT_BASELINES: Readonly<Record<GateTarget, string>> = {
  'android-tv': 'docs/learned/gates/player-android-tv.json',
  tvos: 'docs/learned/gates/player-tvos-sim.json',
  ios: 'docs/learned/gates/player-ios-sim.json',
};

const TARGETS: ReadonlySet<string> = new Set(['android-tv', 'tvos', 'ios']);
const STREAMS: ReadonlySet<string> = new Set(['ts', 'hls', 'vod']);

/** Parsed command line values of `pnpm gate player`. */
export interface PlayerCli {
  target?: string;
  avd?: string;
  build?: boolean;
  app?: string;
  device?: string;
  channels?: string;
  stream?: string;
  rate?: string;
  soak?: string;
  stress?: boolean;
  runs?: string;
  zaps?: string;
  faults?: boolean;
  baseline?: string;
  budgets?: string;
  out?: string;
  'write-baseline'?: boolean;
}

interface Baseline {
  device: Record<string, string>;
  build: string;
  commit: string;
  date: string;
  result: PlayerResult;
}

const ms = (value: number | null): string => (value === null ? 'n/a' : `${value} ms`);

const summary = (r: PlayerResult): string =>
  `gate player: ${r.zaps} zaps, cold ${ms(r.ttffColdMs)}, warm p50 ${ms(r.ttffWarmMs.p50)} p95 ${ms(r.ttffWarmMs.p95)}, zap p50/p95/max ${ms(r.zapMs.p50)}/${ms(r.zapMs.p95)}/${ms(r.zapMs.max)}, surfaces ${r.surfaceCreated}, stale ${r.staleEventsApplied}, limit responses ${r.limitResponses}, overlap ${r.overlapMs} ms`;

const soakSummary = (s: SoakReport): string => {
  const b = s.line.soak;
  const mem =
    s.memory.firstMb !== null && s.memory.lastMb !== null
      ? `, memory ${s.memory.firstMb}->${s.memory.lastMb} MB`
      : '';
  return `gate player: soak ${s.minutes} min (${s.stream}), cold ${ms(s.line.ttffColdMs)}, played ${ms(b?.playedMs ?? null)}, advanced ${ms(b?.positionAdvancedMs ?? null)}, stalls ${b?.stalls ?? 0}, ended ${b?.ended ?? false}${mem}`;
};

const faultSummary = (f: FaultReport): string =>
  `gate player: fault ${f.fault}: ${f.line.faultOutcome ?? 'no outcome'}, limit responses ${f.limitResponses}, overlap ${f.overlapMs} ms${f.failures.length === 0 ? '' : ' (FAILED)'}`;

function parseIntIn(
  text: string | undefined,
  min: number,
  max: number,
): number | undefined | 'bad' {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) return 'bad';
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : 'bad';
}

function parseChannels(text: string | undefined): readonly string[] | undefined | 'bad' {
  if (text === undefined) return undefined;
  const parts = text.split(',');
  return parts.length >= 1 && parts.length <= 20 && parts.every((p) => /^\d{1,9}$/.test(p))
    ? parts
    : 'bad';
}

function parseRate(text: string | undefined): number | undefined | 'bad' {
  if (text === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return 'bad';
  const n = Number(text);
  return Number.isFinite(n) && n >= 0.05 && n <= 5 ? n : 'bad';
}

/** Runs `pnpm gate player` and returns the process exit code; usage errors are returned as code 2. */
export async function playerMain(values: PlayerCli, root: string): Promise<number> {
  const bad = (message: string): number => {
    process.stderr.write(`gate: ${message}. ${PLAYER_USAGE}\n`);
    return 2;
  };
  const target = (values.target ?? 'android-tv') as GateTarget;
  if (!TARGETS.has(target)) return bad('--target is android-tv, tvos or ios');
  const stream = (values.stream ?? 'ts') as PlayerStreamKind;
  if (!STREAMS.has(stream)) return bad('--stream is ts, hls or vod');
  const channels = parseChannels(values.channels);
  if (channels === 'bad')
    return bad('--channels is 1 to 20 numeric stream ids separated by commas');
  const rate = parseRate(values.rate);
  if (rate === 'bad') return bad('--rate is a number between 0.05 and 5');
  const runs = parseIntIn(values.runs, 1, 100);
  const zaps = parseIntIn(values.zaps, 1, 200);
  if (runs === 'bad' || zaps === 'bad') return bad('--runs and --zaps need a positive integer');
  const soak = parseIntIn(values.soak, 1, 180);
  if (soak === 'bad') return bad('--soak is an integer from 1 to 180 minutes');
  if (soak !== undefined && values.stress === true)
    return bad('--soak and --stress are mutually exclusive');
  const budgets = (values.budgets ?? 'fail') as BudgetMode;
  if (budgets !== 'fail' && budgets !== 'warn') return bad('--budgets is fail or warn');

  if (values['write-baseline'] === true) {
    if (soak !== undefined || values.stress === true) {
      return bad('--write-baseline is for standard zap runs, not --soak or --stress');
    }
    if (values.faults !== true) {
      return bad(
        'a baseline needs --faults: it may only record a build whose fault handling passed in the same session',
      );
    }
    if (stream !== 'ts' || channels !== undefined) {
      return bad('a baseline records the default live TS channel set only');
    }
  }
  if (target !== 'android-tv' && (values.app === undefined || values.app === '')) {
    return bad(`--target ${target} requires --app <.app>`);
  }
  if (target !== 'android-tv' && values.build === true) {
    return bad('--build is Android-only; pass the built .app bundle via --app');
  }

  const defaultBaseline = DEFAULT_BASELINES[target];
  const baselineName = values.baseline ?? defaultBaseline;
  const baselinePath = resolve(root, baselineName);
  if (values['write-baseline'] === true) {
    const refusal = baselineTargetRefusal(budgets, baselinePath, resolve(root, defaultBaseline));
    if (refusal !== undefined) return bad(refusal);
  }

  const adb = resolveAdb(process.env, process.platform);
  const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });
  let output: Awaited<ReturnType<typeof runPlayerGate>>;
  try {
    output = await runPlayerGate({
      exec,
      sim: localSim,
      target,
      adb,
      root,
      stream,
      ...(values.avd === undefined ? {} : { avd: values.avd }),
      ...(values.build === true ? { build: true } : {}),
      ...(values.app === undefined ? {} : { app: values.app }),
      ...(values.device === undefined ? {} : { deviceName: values.device }),
      ...(channels === undefined ? {} : { channels }),
      ...(rate === undefined ? {} : { rate }),
      ...(soak === undefined ? {} : { soak }),
      ...(values.stress === true ? { stress: true } : {}),
      ...(values.faults === true ? { faults: true } : {}),
      ...(runs === undefined ? {} : { runs }),
      ...(zaps === undefined ? {} : { zaps }),
      onRun: (r) => process.stdout.write(`run: ${summary(r)}\n`),
      onFault: (f) => process.stdout.write(`${faultSummary(f)}\n`),
      onNote: (n) => process.stdout.write(`gate player: ${n}\n`),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const { device, result, faults, runs: perRun } = output;
  const commit = (await exec('git', ['rev-parse', '--short', 'HEAD'])).output.trim();
  const outPath = resolve(root, values.out ?? 'gate-player.json');

  if (output.soak !== undefined || output.stress !== undefined) {
    const verdict = output.soak?.verdict ??
      output.stress?.verdict ?? { failures: [], warnings: [] };
    const outcome: CompareOutcome = { ok: verdict.failures.length === 0, ...verdict };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify({ commit, ...output, outcome }, null, 2)}\n`);
    const head = output.soak !== undefined ? soakSummary(output.soak) : summary(result);
    const lines = [
      head,
      ...outcome.failures.map((f) => `FAIL: ${f}`),
      ...outcome.warnings.map((w) => `warn: ${w}`),
      `gate player: ${outcome.ok ? 'passed' : 'FAILED'} (details in ${outPath})`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return outcome.ok ? 0 : 1;
  }

  const faultFailures = [...faults.flatMap((f) => f.failures), ...crashFailures(output.crashes)];
  const faultWarnings = faults.flatMap((f) => f.warnings);

  if (values['write-baseline'] === true) {
    const own = comparePlayer(result, result, { budgets, runs: perRun });
    const failures = [...own.failures, ...faultFailures];
    if (failures.length > 0) return bad(`refusing to write a baseline: ${failures.join('; ')}`);
    for (const w of [...own.warnings, ...faultWarnings]) process.stdout.write(`warn: ${w}\n`);
    const dirty = (
      await exec('git', ['status', '--porcelain', '--', 'apps', 'packages', 'modules'])
    ).output.trim();
    if (dirty !== '') {
      return bad(
        'refusing to write a baseline from uncommitted app or package changes; commit them first so the commit field names what was measured',
      );
    }
    const buildDesc =
      target === 'android-tv'
        ? 'development variant, release APK (JS bundled, debug-signed)'
        : 'development variant, release simulator app (JS bundled, ad-hoc signed)';
    const baseline: Baseline = {
      device,
      build: buildDesc,
      commit,
      date: new Date().toISOString().slice(0, 10),
      result,
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`gate: baseline written to ${baselineName}\n${summary(result)}\n`);
    return 0;
  }

  const customProbe = values.baseline === undefined && (stream !== 'ts' || channels !== undefined);
  const found = !customProbe && existsSync(baselinePath);
  const baseline = found
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline).result
    : undefined;
  const outcome = comparePlayer(result, baseline, { budgets, runs: perRun });
  if (!found && values.baseline === undefined && !customProbe) {
    outcome.failures.unshift(`no baseline at ${baselineName}; run with --write-baseline`);
  }
  outcome.failures.push(...faultFailures);
  outcome.warnings.push(...faultWarnings);
  outcome.ok = outcome.failures.length === 0;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ commit, baseline: found ? baselineName : null, ...output, outcome }, null, 2)}\n`,
  );
  const lines = [
    summary(result),
    ...faults.map(faultSummary),
    ...outcome.failures.map((f) => `FAIL: ${f}`),
    ...outcome.warnings.map((w) => `warn: ${w}`),
    `gate player: ${outcome.ok ? 'passed' : 'FAILED'} (details in ${outPath})`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return outcome.ok ? 0 : 1;
}
