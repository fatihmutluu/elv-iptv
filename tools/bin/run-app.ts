import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadDevEnv } from '../src/env.ts';
import { commandLine } from '../src/exec.ts';
import { planPrebuild, readStamp, STAMP_FILE, writeStamp } from '../src/prebuild-stamp.ts';
import { findRepoRoot } from '../src/root.ts';
import {
  buildPrebuildCommand,
  buildProcessEnv,
  buildRunCommand,
  hostError,
  nativeProject,
  parseRunArgs,
  type RunCommand,
  type RunOptions,
} from '../src/run-command.ts';

const args = parseRunArgs(process.argv.slice(2));
if (!args.ok) {
  process.stderr.write(`${args.error}\n`);
  process.exit(2);
}
const refusal = hostError(args.target, process.platform);
if (refusal !== null) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

const root = findRepoRoot(process.cwd());
const opts: RunOptions = {
  target: args.target,
  action: args.action,
  variant: args.variant,
  devEnv: loadDevEnv(resolve(root, '.env.local')),
};

function spawn(cmd: RunCommand): number {
  const result = spawnSync(commandLine(cmd.command, cmd.args), {
    cwd: resolve(root, cmd.cwd),
    env: buildProcessEnv(process.env, cmd, opts.variant),
    shell: true,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

const native = nativeProject(opts);
const stampPath = native === null ? null : resolve(root, native.dir, STAMP_FILE);

if (native !== null && stampPath !== null && opts.action === 'run') {
  const plan = planPrebuild(native.stamp, readStamp(stampPath));
  if (plan.clean) {
    const status = spawn(buildPrebuildCommand(opts));
    if (status !== 0) process.exit(status);
    writeStamp(stampPath, plan.stamp);
  }
}

const status = spawn(buildRunCommand(opts));
if (native !== null && stampPath !== null && opts.action === 'build' && status === 0) {
  writeStamp(stampPath, native.stamp);
}
process.exitCode = status;
