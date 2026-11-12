import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Finds the repository root: the nearest ancestor holding `pnpm-workspace.yaml`. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no pnpm-workspace.yaml found above ${start}`);
    }
    dir = parent;
  }
}
