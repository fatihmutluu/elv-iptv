import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const config = resolve(here, '..', '..', '.dependency-cruiser.cjs');
const bin = resolve(
  here,
  '..',
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

/** One dependency-cruiser violation. */
export interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

/** Cruises `cwd` with the repository's real rule set and returns every violation. */
export function cruise(cwd: string): Violation[] {
  const r = spawnSync(
    process.execPath,
    [bin, '--config', config, '--output-type', 'json', '--no-cache', '.'],
    { cwd, encoding: 'utf8' },
  );
  const report = JSON.parse(r.stdout) as { summary: { violations: Violation[] } };
  return report.summary.violations;
}
