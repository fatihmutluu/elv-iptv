import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import { deviceInfo, type Exec, findDevice, resolveAdb } from './adb.ts';
import { type BudgetMode, baselineTargetRefusal } from './compare.ts';
import {
  comparePlayer,
  type FaultReport,
  type PlayerResult,
  runPlayerGate,
} from './player-gate.ts';
import { localSim } from './sim-control.ts';

/** The usage line of `pnpm gate player`. */
export const PLAYER_USAGE =
  'usage: pnpm gate player [--avd elv_tv] [--build] [--runs 3 (default)] [--zaps 30] [--faults] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]';
const DEFAULT_BASELINE = 'docs/learned/gates/player-android-tv.json';

/** Parsed command line values of `pnpm gate player`. */
export interface PlayerCli {
  avd?: string;
  build?: boolean;
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

const faultSummary = (f: FaultReport): string =>
  `gate player: fault ${f.fault}: ${f.line.faultOutcome ?? 'no outcome'}${f.failures.length === 0 ? '' : ' (FAILED)'}`;

/** Runs `pnpm gate player` and returns the process exit code; usage errors are returned as code 2. */
export async function playerMain(values: PlayerCli, root: string): Promise<number> {
  const bad = (message: string): number => {
    process.stderr.write(`gate: ${message}. ${PLAYER_USAGE}\n`);
    return 2;
  };
  const count = (text: string | undefined): number | undefined | 'bad' => {
    if (text === undefined) return undefined;
    const n = Number(text);
    return Number.isInteger(n) && n >= 1 ? n : 'bad';
  };
  const runs = count(values.runs);
  const zaps = count(values.zaps);
  if (runs === 'bad' || zaps === 'bad') return bad('--runs and --zaps need a positive integer');
  const budgets = (values.budgets ?? 'fail') as BudgetMode;
  if (budgets !== 'fail' && budgets !== 'warn') return bad('--budgets is fail or warn');

  const baselineName = values.baseline ?? DEFAULT_BASELINE;
  const baselinePath = resolve(root, baselineName);
  if (values['write-baseline'] === true) {
    const refusal = baselineTargetRefusal(budgets, baselinePath, resolve(root, DEFAULT_BASELINE));
    if (refusal !== undefined) return bad(refusal);
  }

  const adb = resolveAdb(process.env, process.platform);
  const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });
  let output: Awaited<ReturnType<typeof runPlayerGate>>;
  try {
    output = await runPlayerGate({
      exec,
      sim: localSim,
      adb,
      root,
      ...(values.avd === undefined ? {} : { avd: values.avd }),
      ...(values.build === true ? { build: true } : {}),
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
  const { result, faults } = output;
  const faultFailures = faults.flatMap((f) => f.failures);
  const faultWarnings = faults.flatMap((f) => f.warnings);

  const device = await deviceInfo(exec, adb, await findDevice(exec, adb, values.avd));
  const commit = (await exec('git', ['rev-parse', '--short', 'HEAD'])).output.trim();

  if (values['write-baseline'] === true) {
    const own = comparePlayer(result, result, { budgets });
    const failures = [...own.failures, ...faultFailures];
    if (failures.length > 0) return bad(`refusing to write a baseline: ${failures.join('; ')}`);
    const dirty = (
      await exec('git', ['status', '--porcelain', '--', 'apps', 'packages', 'modules'])
    ).output.trim();
    if (dirty !== '') {
      return bad(
        'refusing to write a baseline from uncommitted app or package changes; commit them first so the commit field names what was measured',
      );
    }
    const baseline: Baseline = {
      device,
      build: 'development variant, release APK (JS bundled, debug-signed)',
      commit,
      date: new Date().toISOString().slice(0, 10),
      result,
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`gate: baseline written to ${baselineName}\n${summary(result)}\n`);
    return 0;
  }

  const found = existsSync(baselinePath);
  const baseline = found
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline).result
    : undefined;
  const outcome = comparePlayer(result, baseline, { budgets });
  if (!found && values.baseline === undefined) {
    outcome.failures.unshift(`no baseline at ${baselineName}; run with --write-baseline`);
  }
  outcome.failures.push(...faultFailures);
  outcome.warnings.push(...faultWarnings);
  outcome.ok = outcome.failures.length === 0;

  const outPath = resolve(root, values.out ?? 'gate-player.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ device, commit, baseline: found ? baselineName : null, ...output, outcome }, null, 2)}\n`,
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
