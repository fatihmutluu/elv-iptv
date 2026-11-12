import { parseArgs } from 'node:util';
import { buildChecks } from '../src/checks.ts';
import { findRepoRoot } from '../src/root.ts';
import { formatReport, runChecks } from '../src/runner.ts';

const { values } = parseArgs({
  options: { only: { type: 'string' }, json: { type: 'boolean', default: false } },
});

const root = findRepoRoot(process.cwd());
const report = await runChecks(buildChecks(root), { only: values.only });

if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(formatReport(report));
}
process.exitCode = report.failed === 0 ? 0 : 1;
