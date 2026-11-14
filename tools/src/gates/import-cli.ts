import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import { deviceInfo, type Exec, findDevice, resolveAdb } from './adb.ts';
import { type BudgetMode, baselineTargetRefusal } from './compare.ts';
import { compareImport, type ImportResult, runImportGate } from './import-gate.ts';
import { localSim } from './sim-control.ts';

/** The usage line of `pnpm gate import`. */
export const IMPORT_USAGE =
  'usage: pnpm gate import [--avd elv_tv] [--build] [--account large|huge] [--batch 5000] [--max-body 4096] [--runs 1] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]';
const DEFAULT_BASELINE = 'docs/learned/gates/import-android-tv.json';

/** Parsed command line values of `pnpm gate import`. */
export interface ImportCli {
  avd?: string;
  build?: boolean;
  account?: string;
  batch?: string;
  'max-body'?: string;
  runs?: string;
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
  result: ImportResult;
}

const summary = (r: ImportResult): string =>
  `gate import: ${r.account}, batch ${r.batch}, body cap ${r.maxBody} KiB, ${r.rows} rows, ${r.durationMs} ms, max stall ${r.maxStallMs} ms`;

/** Runs `pnpm gate import` and returns the process exit code; usage errors are returned as code 2. */
export async function importMain(values: ImportCli, root: string): Promise<number> {
  const bad = (message: string): number => {
    process.stderr.write(`gate: ${message}. ${IMPORT_USAGE}\n`);
    return 2;
  };
  const count = (text: string | undefined): number | undefined | 'bad' => {
    if (text === undefined) return undefined;
    const n = Number(text);
    return Number.isInteger(n) && n >= 1 ? n : 'bad';
  };
  const batch = count(values.batch);
  const maxBody = count(values['max-body']);
  const runs = count(values.runs);
  if (batch === 'bad' || maxBody === 'bad' || runs === 'bad') {
    return bad('--batch, --max-body and --runs need a positive integer');
  }
  const budgets = (values.budgets ?? 'fail') as BudgetMode;
  if (budgets !== 'fail' && budgets !== 'warn') return bad('--budgets is fail or warn');
  const account = values.account ?? 'large';
  if (account !== 'large' && account !== 'huge') return bad('--account is large or huge');

  const baselineName = values.baseline ?? DEFAULT_BASELINE;
  const baselinePath = resolve(root, baselineName);
  if (values['write-baseline'] === true) {
    if (account !== 'large') return bad('only the large account may become a baseline');
    const refusal = baselineTargetRefusal(budgets, baselinePath, resolve(root, DEFAULT_BASELINE));
    if (refusal !== undefined) return bad(refusal);
  }

  const adb = resolveAdb(process.env, process.platform);
  const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });
  let result: ImportResult;
  try {
    result = await runImportGate({
      exec,
      sim: localSim,
      adb,
      root,
      account,
      ...(values.avd === undefined ? {} : { avd: values.avd }),
      ...(values.build === true ? { build: true } : {}),
      ...(batch === undefined ? {} : { batch }),
      ...(maxBody === undefined ? {} : { maxBody }),
      ...(runs === undefined ? {} : { runs }),
      onRun: (r) =>
        process.stdout.write(`run: ${summary(r)}
`),
      onNote: (n) =>
        process.stdout.write(`gate import: ${n}
`),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const device = await deviceInfo(exec, adb, await findDevice(exec, adb, values.avd));
  const commit = (await exec('git', ['rev-parse', '--short', 'HEAD'])).output.trim();

  if (values['write-baseline'] === true) {
    const own = compareImport(result, result, { budgets });
    if (!own.ok) return bad(`refusing to write a baseline: ${own.failures.join('; ')}`);
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
  const outcome = compareImport(result, baseline, { budgets });
  if (!found && values.baseline === undefined && account === 'large') {
    outcome.failures.unshift(`no baseline at ${baselineName}; run with --write-baseline`);
    outcome.ok = false;
  }
  const outPath = resolve(root, values.out ?? 'gate-import.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ device, commit, baseline: found ? baselineName : null, result, outcome }, null, 2)}\n`,
  );
  const lines = [
    summary(result),
    ...outcome.failures.map((f) => `FAIL: ${f}`),
    ...outcome.warnings.map((w) => `warn: ${w}`),
    `gate import: ${outcome.ok ? 'passed' : 'FAILED'} (details in ${outPath})`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return outcome.ok ? 0 : 1;
}
