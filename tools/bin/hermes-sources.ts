import { parseArgs } from 'node:util';
import { findRepoRoot } from '../src/root.ts';
import { runHermesSources } from './hermes/runner.ts';

const USAGE =
  'usage: node tools/bin/hermes-sources.ts [--benchmark small|large] [--require-runtime] [--hermes-bin <path>]';

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    benchmark: { type: 'string' },
    'require-runtime': { type: 'boolean' },
    'hermes-bin': { type: 'string' },
  },
});

const benchmark = (parsed.values.benchmark ?? 'large') as 'small' | 'large';
if (benchmark !== 'small' && benchmark !== 'large') {
  process.stderr.write(`hermes-sources: --benchmark must be small or large.\n${USAGE}\n`);
  process.exit(2);
}

const report = await runHermesSources({
  root: findRepoRoot(process.cwd()),
  benchmark,
  requireRuntime: parsed.values['require-runtime'] === true,
  ...(parsed.values['hermes-bin'] ? { hermesBin: parsed.values['hermes-bin'] } : {}),
});

if (!report.executed || !report.result) {
  process.stdout.write(
    `hermes-sources: compiled ${report.compiledBytes} bytes via hermesc (hermes runtime not on PATH; skipped VM execution)\n`,
  );
  process.exit(0);
}

const { m3u, xmltv } = report.result;
process.stdout.write(
  `${[
    `hermes-sources: runtime=${report.result.runtime}, hermesc=${report.compiledBytes} B, assertions=${report.result.assertionsPassed}, polyfills=[${report.result.polyfillsNeeded.join(', ')}]`,
    `  M3U (${report.result.benchmarkProfile}): ${m3u.entries} entries, ${(m3u.bytes / (1024 * 1024)).toFixed(2)} MiB in ${m3u.ms} ms -> ${m3u.mbPerSec} MiB/s (${m3u.itemsPerSec} entries/s)`,
    `  XMLTV (${report.result.benchmarkProfile}): ${xmltv.channels} channels, ${xmltv.programmes} programmes, ${(xmltv.bytes / (1024 * 1024)).toFixed(2)} MiB in ${xmltv.ms} ms -> ${xmltv.mbPerSec} MiB/s (${xmltv.itemsPerSec} programmes/s)`,
  ].join('\n')}\n`,
);
