import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fetchRuntime, verifyRuntime } from '../src/mpv/fetch.ts';
import { parseLock } from '../src/mpv/lock.ts';
import { realDeps } from '../src/mpv/real-deps.ts';
import { findRepoRoot } from '../src/root.ts';

const USAGE = 'usage: pnpm mpv fetch [--force] | pnpm mpv verify';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { force: { type: 'boolean', default: false } },
  });
  const command = positionals[0];
  if (command !== 'fetch' && command !== 'verify') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const root = findRepoRoot(import.meta.dirname);
  const lock = parseLock(
    JSON.parse(readFileSync(join(root, 'apps/desktop/mpv-runtime.lock.json'), 'utf8')),
  );
  const slashed = root.replaceAll(String.fromCharCode(92), '/');
  const deps = realDeps((line) => process.stdout.write(`${line}\n`), slashed);
  const opts = {
    root: slashed,
    platform: process.platform,
    arch: process.arch,
    lock,
  };
  const result =
    command === 'fetch'
      ? await fetchRuntime({ ...opts, force: values.force }, deps)
      : await verifyRuntime(opts, deps);
  if (result.status === 'unsupported') {
    process.stdout.write(`mpv: ${result.key} has no pinned runtime yet; nothing to do\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
