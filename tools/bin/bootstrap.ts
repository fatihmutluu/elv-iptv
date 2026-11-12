import { spawnSync } from 'node:child_process';
import { versionAtLeast } from '../src/bootstrap.ts';
import { commandLine } from '../src/exec.ts';
import { findRepoRoot } from '../src/root.ts';

const root = findRepoRoot(process.cwd());
const problems: string[] = [];

function run(command: string, args: string[], inherit = false) {
  return spawnSync(commandLine(command, args), {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
}

if (!versionAtLeast(process.versions.node, '24.0.0')) {
  problems.push(`Node ${process.versions.node} is too old; pnpm provisions Node 24 via devEngines`);
}

const pnpmVersion = run('pnpm', ['--version']).stdout?.trim() ?? '';
if (!versionAtLeast(pnpmVersion, '12.18.0')) {
  problems.push(`pnpm ${pnpmVersion || 'missing'} found; need >= 12.18.0 (npm i -g pnpm@12)`);
}

if (problems.length === 0) {
  const steps: [string, string[]][] = [
    ['pnpm', ['install', '--reporter=silent']],
    ['pnpm', ['exec', 'lefthook', 'install']],
  ];
  for (const [command, args] of steps) {
    const r = run(command, args, true);
    if (r.status !== 0) problems.push(`${command} ${args.join(' ')} failed`);
  }
}

if (run('gitleaks', ['version']).status !== 0) {
  problems.push(
    'gitleaks is not installed (winget install gitleaks.gitleaks | brew install gitleaks); the pre-commit hook needs it',
  );
}

if (problems.length > 0) {
  process.stderr.write(`bootstrap: ${problems.length} problem(s)\n- ${problems.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('bootstrap: ok\n');
}
