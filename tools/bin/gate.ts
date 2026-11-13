import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exec as run } from '../src/exec.ts';
import {
  baselineRefusal,
  type CompareOutcome,
  compareToBaseline,
  type GateResult,
} from '../src/gates/compare.ts';
import {
  deviceInfo,
  type Exec,
  findDevice,
  resolveAdb,
  runListGate,
} from '../src/gates/list-gate.ts';
import { findRepoRoot } from '../src/root.ts';

const USAGE =
  'usage: pnpm gate list [--avd elv_tv] [--build] [--runs 3 (default)] [--real-keys 60] [--ci] [--out file] [--write-baseline]';
const BASELINE = 'docs/learned/gates/list-android-tv.json';

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

let parsed: ReturnType<typeof parseCli>;
function parseCli() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      avd: { type: 'string' },
      build: { type: 'boolean' },
      runs: { type: 'string' },
      'real-keys': { type: 'string' },
      ci: { type: 'boolean' },
      out: { type: 'string' },
      'write-baseline': { type: 'boolean' },
    },
  });
}
try {
  parsed = parseCli();
} catch (error) {
  fail(`gate: ${(error as Error).message.split('. ')[0]}. ${USAGE}`, 2);
}
const { values, positionals } = parsed;
if (positionals[0] !== 'list' || positionals.length !== 1) fail(USAGE, 2);

const count = (name: string, text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) fail(`gate: --${name} needs a positive integer. ${USAGE}`, 2);
  return n;
};
const runs = count('runs', values.runs) ?? 3;
const realKeys = count('real-keys', values['real-keys']);

const root = findRepoRoot(process.cwd());
const adb = resolveAdb(process.env, process.platform);
const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });

interface Baseline {
  device: Record<string, string>;
  build: string;
  commit: string;
  date: string;
  result: GateResult;
}

const result = await runListGate({
  exec,
  adb,
  root,
  ...(values.avd === undefined ? {} : { avd: values.avd }),
  ...(values.build === true ? { build: true } : {}),
  runs,
  ...(realKeys === undefined ? {} : { realKeys }),
  onRun: (run) => console.log(`run: ${summary(run)}`),
}).catch((error: Error) => fail(error.message));

const device = await deviceInfo(exec, adb, await findDevice(exec, adb, values.avd));
const commit = (await exec('git', ['rev-parse', '--short', 'HEAD'])).output.trim();
const baselinePath = resolve(root, BASELINE);

if (values['write-baseline'] === true) {
  const refusal = baselineRefusal(result);
  if (refusal !== undefined) fail(`gate: ${refusal}`);
  const dirty = (
    await exec('git', ['status', '--porcelain', '--', 'apps', 'packages', 'modules'])
  ).output.trim();
  if (dirty !== '')
    fail(
      'gate: refusing to write a baseline from uncommitted app or package changes; commit them first so the commit field names what was measured',
    );
  const baseline: Baseline = {
    device,
    build: 'development variant, release APK (JS bundled, debug-signed)',
    commit,
    date: new Date().toISOString().slice(0, 10),
    result,
  };
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`gate: baseline written to ${BASELINE}\n${summary(result)}\n`);
  process.exit(0);
}

let outcome: CompareOutcome;
if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  outcome = compareToBaseline(result, baseline.result);
} else {
  outcome = {
    ok: false,
    failures: [`no baseline at ${BASELINE}; run with --write-baseline`],
    warnings: [],
  };
}

const outPath = resolve(
  root,
  values.out ?? (values.ci === true ? 'gate-artifacts/gate-list.json' : 'gate-list.json'),
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ device, commit, result, outcome }, null, 2)}\n`);

const note = (kind: 'error' | 'warning', text: string) =>
  values.ci === true
    ? `::${kind}::gate list: ${text}`
    : `${kind === 'error' ? 'FAIL' : 'warn'}: ${text}`;
const lines = [
  summary(result),
  ...outcome.failures.map((f) => note('error', f)),
  ...outcome.warnings.map((w) => note('warning', w)),
  `gate list: ${outcome.ok ? 'passed' : 'FAILED'} (details in ${outPath})`,
];
process.stdout.write(`${lines.join('\n')}\n`);
process.exitCode = outcome.ok ? 0 : 1;

function summary(r: GateResult): string {
  const k = r.metrics.keyToHighlightMs;
  const real =
    r.realKeys === undefined
      ? ''
      : `; real keys p95 ${r.realKeys.p95} ms max ${r.realKeys.max} ms losses ${r.realKeys.losses}`;
  return (
    `gate list: ${r.metrics.items} items, ${r.metrics.moves} moves, losses ${r.metrics.losses}, ` +
    `key-to-highlight p50/p95/max ${k.p50}/${k.p95}/${k.max} ms, JS gap ${r.metrics.maxJsGapMs} ms, frame stall ${r.metrics.maxFrameStallMs ?? 'n/a'} ms, ` +
    `frames ${r.frames.totalFrames} janky ${r.frames.jankyPercent}% (legacy ${r.frames.legacyJankyPercent ?? 'n/a'}%)${real}`
  );
}
