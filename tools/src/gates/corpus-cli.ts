import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import { type Exec, resolveAdb } from './adb.ts';
import { type CorpusTarget, runCorpusGate } from './corpus-gate.ts';
import { localSim } from './sim-control.ts';

/** The usage line of `pnpm gate corpus`. */
export const CORPUS_USAGE =
  'usage: pnpm gate corpus [--target android-tv|fire-os|android|tvos|ios|desktop] [--avd <name>] [--build] [--app <.app>] [--device <name>] [--burst <0..30>] [--sim <url>] [--out <file>]';

/** Parsed command line values of `pnpm gate corpus`. */
export interface CorpusCli {
  target?: string;
  avd?: string;
  build?: boolean;
  app?: string;
  device?: string;
  burst?: string;
  sim?: string;
  out?: string;
}

const TARGETS: ReadonlySet<string> = new Set([
  'android-tv',
  'fire-os',
  'android',
  'android-phone',
  'tvos',
  'ios',
  'desktop',
  'windows',
  'macos',
]);

/** Runs `pnpm gate corpus` and returns the process exit code; usage errors return code 2. */
export async function corpusMain(values: CorpusCli, root: string): Promise<number> {
  const bad = (message: string): number => {
    process.stderr.write(`gate: ${message}. ${CORPUS_USAGE}\n`);
    return 2;
  };
  const target = (values.target ?? 'android-tv') as CorpusTarget;
  if (!TARGETS.has(target)) {
    return bad('--target is android-tv, fire-os, android, tvos, ios or desktop');
  }
  if ((target === 'tvos' || target === 'ios') && (values.app === undefined || values.app === '')) {
    return bad(`--target ${target} requires --app <.app>`);
  }
  if ((target === 'tvos' || target === 'ios') && values.build === true) {
    return bad(
      '--build is not supported on Apple simulators; pass the built .app bundle via --app',
    );
  }
  let burst = 0;
  if (values.burst !== undefined) {
    const parsed = Number(values.burst);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 30) {
      return bad('--burst must be a number between 0 and 30');
    }
    burst = parsed;
  }

  const adb = resolveAdb(process.env, process.platform);
  const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });
  let output: Awaited<ReturnType<typeof runCorpusGate>>;
  try {
    output = await runCorpusGate({
      exec,
      sim: localSim,
      target,
      adb,
      root,
      burst,
      ...(values.avd === undefined ? {} : { avd: values.avd }),
      ...(values.build === true ? { build: true } : {}),
      ...(values.app === undefined ? {} : { app: values.app }),
      ...(values.device === undefined ? {} : { deviceName: values.device }),
      ...(values.sim === undefined ? {} : { simUrl: values.sim }),
      onNote: (n) => process.stdout.write(`gate corpus: ${n}\n`),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  if (values.out !== undefined) {
    const commitRes = await exec('git', ['rev-parse', '--short', 'HEAD']).catch(() => ({
      ok: false,
      output: 'local',
    }));
    const commit = commitRes.ok ? commitRes.output.trim() : 'local';
    const report = {
      commit,
      date: new Date().toISOString().slice(0, 10),
      ...output,
    };
    const outPath = resolve(root, values.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const { line, connections, outcome } = output;
  const lines = [
    `gate corpus (${target}): ${line.passed}/${line.total} passed, ${line.failed.length} failed, limitResponses ${connections.limitResponses}`,
    ...outcome.failures.map((f) => `FAIL: ${f}`),
    `gate corpus: ${outcome.ok ? 'passed' : 'FAILED'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return outcome.ok ? 0 : 1;
}
