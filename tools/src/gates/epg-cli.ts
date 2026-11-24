import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec as run } from '../exec.ts';
import { type Exec, resolveAdb } from './adb.ts';
import type { BudgetMode } from './compare.ts';
import { type EpgGateLine, runEpgGate } from './epg-gate.ts';
import type { GateTarget } from './gate-device.ts';

/** Usage line of `pnpm gate epg`. */
export const EPG_USAGE =
  'usage: pnpm gate epg [--target android-tv|tvos] [--avd elv_tv] [--build] [--app <.app>] [--device <name>] [--channels 1000] [--days 7] [--moves 220] [--budgets fail|warn] [--out file]';

/** Parsed command line values of `pnpm gate epg`. */
export interface EpgCli {
  target?: string;
  avd?: string;
  build?: boolean;
  app?: string;
  device?: string;
  channels?: string;
  days?: string;
  moves?: string;
  budgets?: string;
  out?: string;
}

const summary = (line: EpgGateLine): string =>
  `gate epg: ${line.channels} ch × ${line.days}d (~${line.totalEstimatedProgrammes} progs), ${line.steps} steps, ` +
  `key-to-highlight p50/p95/max ${line.keyToHighlightP50Ms}/${line.keyToHighlightP95Ms}/${line.keyToHighlightMaxMs} ms, ` +
  `maxJsTask ${line.maxJsTaskMs} ms, >16ms frames ${line.framesOver16Ms}, continuity ${line.focusContinuityOk ? 'ok' : 'FAILED'}`;

/** Runs `pnpm gate epg` and returns the process exit code (2 on usage errors). */
export async function epgMain(values: EpgCli, root: string): Promise<number> {
  const bad = (message: string): number => {
    process.stderr.write(`gate: ${message}. ${EPG_USAGE}\n`);
    return 2;
  };
  const count = (text: string | undefined): number | undefined | 'bad' => {
    if (text === undefined) return undefined;
    const n = Number(text);
    return Number.isInteger(n) && n >= 1 ? n : 'bad';
  };
  const target = (values.target ?? 'android-tv') as GateTarget;
  if (target !== 'android-tv' && target !== 'tvos') {
    return bad('--target is android-tv or tvos');
  }
  const channels = count(values.channels);
  const days = count(values.days);
  const moves = count(values.moves);
  if (channels === 'bad' || days === 'bad' || moves === 'bad') {
    return bad('--channels, --days and --moves need a positive integer');
  }
  const budgets = (values.budgets ?? 'fail') as BudgetMode;
  if (budgets !== 'fail' && budgets !== 'warn') {
    return bad('--budgets is fail or warn');
  }

  const adb = resolveAdb(process.env, process.platform);
  const exec: Exec = (command, args, opts) => run(command, args, { cwd: root, ...opts });
  try {
    const out = await runEpgGate({
      exec,
      target,
      adb,
      root,
      budgets,
      ...(values.avd === undefined ? {} : { avd: values.avd }),
      ...(values.build === true ? { build: true } : {}),
      ...(values.app === undefined ? {} : { app: values.app }),
      ...(values.device === undefined ? {} : { deviceName: values.device }),
      ...(channels === undefined ? {} : { channels }),
      ...(days === undefined ? {} : { days }),
      ...(moves === undefined ? {} : { moves }),
    });

    const outPath = resolve(root, values.out ?? `gate-epg-${target}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
    const lines = [
      summary(out.line),
      ...out.outcome.failures.map((f) => `FAIL: ${f}`),
      ...out.outcome.warnings.map((w) => `warn: ${w}`),
      `gate epg: ${out.outcome.ok ? 'passed' : 'FAILED'} (details in ${outPath})`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return out.outcome.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
