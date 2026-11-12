import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDevEnv } from '../src/env.ts';
import { commandLine } from '../src/exec.ts';
import { findRepoRoot } from '../src/root.ts';
import { buildRunCommand, TARGETS, type Target } from '../src/run-command.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { production: { type: 'boolean', default: false } },
});

const [target, action = 'run'] = positionals;
const usage = `usage: pnpm run:app <${TARGETS.join('|')}> [build] [--production]`;
if (!TARGETS.includes(target as Target) || (action !== 'run' && action !== 'build')) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const root = findRepoRoot(process.cwd());
const cmd = buildRunCommand({
  target: target as Target,
  action,
  variant: values.production ? 'production' : 'development',
  devEnv: loadDevEnv(resolve(root, '.env.local')),
});

const result = spawnSync(commandLine(cmd.command, cmd.args), {
  cwd: resolve(root, cmd.cwd),
  env: { ...process.env, ...cmd.env },
  shell: true,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
