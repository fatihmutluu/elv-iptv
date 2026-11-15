import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import { type Exec, resolveAdb } from './adb.ts';
import { runContractGate } from './contract-gate.ts';
import type { GateTarget } from './gate-device.ts';
import { localSim } from './sim-control.ts';

/** The usage line of `pnpm gate contract`. */
export const CONTRACT_USAGE =
  'usage: pnpm gate contract [--target android-tv|tvos|ios] [--avd elv_tv] [--build] [--app <.app>] [--device <name>] [--out file]';

/** Parsed command line values of `pnpm gate contract`. */
export interface ContractCli {
  target?: string;
  avd?: string;
  build?: boolean;
  app?: string;
  device?: string;
  out?: string;
}

const TARGETS: ReadonlySet<string> = new Set(['android-tv', 'tvos', 'ios']);

/** Runs `pnpm gate contract` and returns the process exit code; usage errors return code 2. */
export async function contractMain(values: ContractCli, root: string): Promise<number> {
  const bad = (message: string): number => {
    process.stderr.write(`gate: ${message}. ${CONTRACT_USAGE}\n`);
    return 2;
  };
  const target = (values.target ?? 'android-tv') as GateTarget;
  if (!TARGETS.has(target)) return bad('--target is android-tv, tvos or ios');
  if (target !== 'android-tv' && (values.app === undefined || values.app === '')) {
    return bad(`--target ${target} requires --app <.app>`);
  }
  if (target !== 'android-tv' && values.build === true) {
    return bad(`--build is Android-only; pass the built .app bundle via --app`);
  }

  const adb = resolveAdb(process.env, process.platform);
  const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });
  let output: Awaited<ReturnType<typeof runContractGate>>;
  try {
    output = await runContractGate({
      exec,
      sim: localSim,
      target,
      adb,
      root,
      ...(values.avd === undefined ? {} : { avd: values.avd }),
      ...(values.build === true ? { build: true } : {}),
      ...(values.app === undefined ? {} : { app: values.app }),
      ...(values.device === undefined ? {} : { deviceName: values.device }),
      onNote: (n) => process.stdout.write(`gate contract: ${n}\n`),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  if (values.out !== undefined) {
    const outPath = resolve(root, values.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  const { line, outcome } = output;
  const lines = [
    `gate contract: ${line.passed} passed, ${line.failed.length} failed`,
    ...outcome.failures.map((f) => `FAIL: ${f}`),
    `gate contract: ${outcome.ok ? 'passed' : 'FAILED'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return outcome.ok ? 0 : 1;
}
