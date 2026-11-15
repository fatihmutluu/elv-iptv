import { rm } from 'node:fs/promises';
import { activeChildren } from '../src/sim/media.ts';

const CHILD_WAIT_MS = 5000;

/**
 * Removes a media test cache folder. Waits (up to 5 s) for FFmpeg children to exit first, because on
 * Windows a child that still reads `loop.ts` makes the removal fail with EPERM or EBUSY.
 */
export async function removeCache(dir: string): Promise<void> {
  if (dir === '') return;
  const until = Date.now() + CHILD_WAIT_MS;
  while (activeChildren() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
