import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import type { Exec } from './adb.ts';
import { type BudgetMode, baselineTargetRefusal } from './compare.ts';
import {
  compareDesktop,
  type DesktopFaultReport,
  type DesktopResult,
  type OrphanReport,
} from './desktop-compare.ts';
import {
  type DesktopGateOptions,
  type DesktopGateResult,
  defaultDesktopBaseline,
  runDesktopGate,
  systemDesktopDeps,
} from './desktop-gate.ts';

/** Usage line of `pnpm gate desktop`. */
export const DESKTOP_USAGE =
  'usage: pnpm gate desktop [--build] [--runs 3 (default)] [--zaps 30] [--faults] [--sim url] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]';

/** Parsed command-line options of `pnpm gate desktop`. */
export interface DesktopCli {
  build?: boolean;
  runs?: string;
  zaps?: string;
  faults?: boolean;
  sim?: string;
  baseline?: string;
  budgets?: string;
  out?: string;
  'write-baseline'?: boolean;
}

/** Injectable hooks for CLI tests. */
export interface DesktopCliIo {
  platform?: NodeJS.Platform;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  exec?: Exec;
  runGate?: (opts: DesktopGateOptions) => Promise<DesktopGateResult>;
}

interface Baseline {
  device: Record<string, string>;
  build: string;
  commit: string;
  date: string;
  result: DesktopResult;
}

const ms = (v: number | null): string => (v === null ? 'n/a' : `${v} ms`);

const summary = (r: DesktopResult): string =>
  `gate desktop: ${r.zaps} zaps, cold ${ms(r.ttffColdMs)}, warm p50 ${ms(r.ttffWarmMs.p50)} p95 ${ms(r.ttffWarmMs.p95)}, zap p50/p95/max ${ms(r.zapMs.p50)}/${ms(r.zapMs.p95)}/${ms(r.zapMs.max)}, spawns ${r.mpvSpawns}, surfaces ${r.surfaceCreated}, visible ${String(r.videoVisible)} (${r.distinct}), vod ${r.vod ? `${r.vod.playing}/${r.vod.seeked}` : 'skip'}, coalesceMax ${r.coalesceMaxMs} ms, limit ${r.limitResponses}, overlap ${r.overlapMs} ms`;

const faultSummary = (f: DesktopFaultReport): string =>
  `gate desktop: fault ${f.fault}: ${f.line.faultOutcome ?? 'no outcome'}, wedged ${f.line.engineWedged}, limit ${f.limitResponses}, overlap ${f.overlapMs} ms${f.failures.length === 0 ? '' : ' (FAILED)'}`;

const orphanSummary = (o: OrphanReport): string =>
  `gate desktop: orphan: ${o.ok ? `closed in ${ms(o.closeMs)}` : `FAILED (${o.failures.join('; ')})`}`;

/** Runs `pnpm gate desktop` and returns the exit code. */
export async function desktopMain(
  values: DesktopCli,
  root: string,
  io: DesktopCliIo = {},
): Promise<number> {
  const platform = io.platform ?? process.platform;
  const stdout = io.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s: string) => process.stderr.write(s));
  const bad = (message: string): number => {
    stderr(`gate: ${message}. ${DESKTOP_USAGE}\n`);
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

  if (values['write-baseline'] === true && values.faults !== true) {
    return bad(
      'a baseline needs --faults: it may only record a build whose fault handling and orphan guard passed in the same session',
    );
  }

  const defaultBase = defaultDesktopBaseline(platform);
  const baselineName = values.baseline ?? defaultBase;
  const baselinePath = resolve(root, baselineName);
  if (values['write-baseline'] === true) {
    const strictWindows = resolve(root, defaultDesktopBaseline('win32'));
    const refusal = baselineTargetRefusal(budgets, baselinePath, strictWindows);
    if (refusal !== undefined) return bad(refusal);
  }

  const exec: Exec =
    io.exec ?? ((command, args, opts) => run(command, args, { cwd: root, ...opts }));
  const runner =
    io.runGate ??
    ((opts: DesktopGateOptions) => runDesktopGate(opts, systemDesktopDeps(root, exec)));

  let output: DesktopGateResult;
  try {
    output = await runner({
      ...(values.build === true ? { build: true } : {}),
      ...(values.faults === true ? { faults: true } : {}),
      ...(values.sim === undefined ? {} : { simUrl: values.sim }),
      ...(runs === undefined ? {} : { runs }),
      ...(zaps === undefined ? {} : { zaps }),
      onRun: (r) => stdout(`run: ${summary(r)}\n`),
      onFault: (f) => stdout(`${faultSummary(f)}\n`),
      onOrphan: (o) => stdout(`${orphanSummary(o)}\n`),
      onNote: (n) => stdout(`gate desktop: ${n}\n`),
    });
  } catch (error) {
    stderr(`${(error as Error).message}\n`);
    return 1;
  }

  const { result, faults, runs: perRun, orphan } = output;
  const faultFailures = [
    ...faults.flatMap((f) => f.failures),
    ...(orphan === null ? [] : orphan.failures),
  ];
  const faultWarnings = faults.flatMap((f) => f.warnings);
  const commit = (await exec('git', ['rev-parse', '--short', 'HEAD'])).output.trim();
  const device = {
    platform,
    arch: arch(),
    release: release(),
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
  };

  if (values['write-baseline'] === true) {
    const own = compareDesktop(result, result, { budgets, runs: perRun });
    const failures = [...own.failures, ...faultFailures];
    if (failures.length > 0) return bad(`refusing to write a baseline: ${failures.join('; ')}`);
    for (const w of [...own.warnings, ...faultWarnings]) stdout(`warn: ${w}\n`);
    const dirty = (
      await exec('git', ['status', '--porcelain', '--', 'apps/desktop', 'packages'])
    ).output.trim();
    if (dirty !== '') {
      return bad(
        'refusing to write a baseline from uncommitted apps/desktop or package changes; commit them first so the commit field names what was measured',
      );
    }
    const baseline: Baseline = {
      device,
      build: 'unpackaged desktop bundle, pinned LGPL mpv 0.42.0',
      commit,
      date: new Date().toISOString().slice(0, 10),
      result,
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    stdout(`gate: baseline written to ${baselineName}\n${summary(result)}\n`);
    return 0;
  }

  const found = existsSync(baselinePath);
  const baseline = found
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline).result
    : undefined;
  const outcome = compareDesktop(result, baseline, { budgets, runs: perRun });
  if (!found && values.baseline === undefined) {
    outcome.failures.unshift(`no baseline at ${baselineName}; run with --write-baseline`);
  }
  outcome.failures.push(...faultFailures);
  outcome.warnings.push(...faultWarnings);
  outcome.ok = outcome.failures.length === 0;

  const outPath = resolve(root, values.out ?? 'gate-desktop.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ device, commit, baseline: found ? baselineName : null, ...output, outcome }, null, 2)}\n`,
  );
  const lines = [
    summary(result),
    ...faults.map(faultSummary),
    ...(orphan === null ? [] : [orphanSummary(orphan)]),
    ...outcome.failures.map((f) => `FAIL: ${f}`),
    ...outcome.warnings.map((w) => `warn: ${w}`),
    `gate desktop: ${outcome.ok ? 'passed' : 'FAILED'} (details in ${outPath})`,
  ];
  stdout(`${lines.join('\n')}\n`);
  return outcome.ok ? 0 : 1;
}
