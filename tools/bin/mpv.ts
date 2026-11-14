import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fetchRuntime, verifyDirectory, verifyRuntime } from '../src/mpv/fetch.ts';
import { parseLock } from '../src/mpv/lock.ts';
import { realDeps } from '../src/mpv/real-deps.ts';
import { findRepoRoot } from '../src/root.ts';

const USAGE = 'usage: pnpm mpv fetch [--force] | pnpm mpv verify [--dir <folder>]';

const slash = (p: string): string => p.replaceAll(String.fromCharCode(92), '/');

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { force: { type: 'boolean', default: false }, dir: { type: 'string' } },
  });
  const command = positionals[0];
  if (command !== 'fetch' && command !== 'verify') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const root = slash(findRepoRoot(import.meta.dirname));
  const deps = realDeps((line) => process.stdout.write(`${line}\n`), root);
  if (values.dir !== undefined) {
    if (command !== 'verify') {
      process.stderr.write(`${USAGE}\n`);
      process.exit(2);
    }
    const verdict = await verifyDirectory(slash(resolve(values.dir)), deps);
    process.stdout.write(`mpv: FFmpeg configuration: ${verdict.ffmpegConfig}\n`);
    process.stdout.write(`mpv: mpv build options: ${verdict.mpvOptions}\n`);
    return;
  }
  const lock = parseLock(
    JSON.parse(readFileSync(join(root, 'apps/desktop/mpv-runtime.lock.json'), 'utf8')),
  );
  const opts = { root, platform: process.platform, arch: process.arch, lock };
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
