import { resolve } from 'node:path';
import { fetchFfmpegMedia3, verifyDirectory, verifyInstalled } from '../src/ffmpeg-media3/fetch.ts';
import { createRealFetchDeps } from '../src/ffmpeg-media3/real-deps.ts';
import { findRepoRoot } from '../src/root.ts';

function usage(): string {
  return [
    'Usage:',
    '  pnpm ffmpeg-media3 fetch [--force]',
    '  pnpm ffmpeg-media3 verify [--dir <bundle-folder>]',
  ].join('\n');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || !command) {
    console.log(usage());
    if (!command) process.exitCode = 1;
    return;
  }

  const root = findRepoRoot(process.cwd());
  const deps = createRealFetchDeps(root);

  if (command === 'fetch') {
    let force = false;
    for (const arg of rest) {
      if (arg === '--force') force = true;
      else throw new Error(`Unknown flag "${arg}".\n${usage()}`);
    }
    await fetchFfmpegMedia3({ force }, deps);
    return;
  }

  if (command === 'verify') {
    let dir: string | null = null;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === '--dir') {
        const next = rest[i + 1];
        if (!next) throw new Error('--dir requires a folder path');
        dir = resolve(process.cwd(), next);
        i += 1;
      } else {
        throw new Error(`Unknown flag "${arg}".\n${usage()}`);
      }
    }
    if (dir !== null) {
      verifyDirectory(dir);
      console.log(`ffmpeg-media3: verified directory ${dir}.`);
    } else {
      verifyInstalled(deps);
    }
    return;
  }

  throw new Error(`Unknown subcommand "${command}".\n${usage()}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
