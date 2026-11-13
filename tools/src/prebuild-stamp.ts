import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** What a generated native project was made for. `pnpm run:app` keeps it inside the project. */
export interface PrebuildStamp {
  target: string;
  variant: string;
  store: string;
}

/** Stamp file name inside the generated `android/` or `ios/` folder (both are gitignored). */
export const STAMP_FILE = '.elv-prebuild.json';

/**
 * Decides whether the native project must be regenerated from scratch: `expo run:*` reuses an
 * existing folder as is, so a project without a stamp or made for another target, variant or
 * store would build the wrong app. `stamp` is what to write once the prebuild succeeds.
 */
export function planPrebuild(
  want: PrebuildStamp,
  existing: PrebuildStamp | null,
): { clean: boolean; stamp: PrebuildStamp } {
  const same =
    existing !== null &&
    existing.target === want.target &&
    existing.variant === want.variant &&
    existing.store === want.store;
  return { clean: !same, stamp: want };
}

/** Parses stamp file content; anything malformed returns null, which forces a clean prebuild. */
export function parseStamp(content: string): PrebuildStamp | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { target, variant, store } = value as Record<string, unknown>;
  if (typeof target !== 'string' || typeof variant !== 'string' || typeof store !== 'string') {
    return null;
  }
  return { target, variant, store };
}

/** Reads the stamp at `path`; null when the file is missing or not a stamp. */
export function readStamp(path: string): PrebuildStamp | null {
  return existsSync(path) ? parseStamp(readFileSync(path, 'utf8')) : null;
}

/** Writes `stamp` to `path`; the folder must exist (prebuild has just created it). */
export function writeStamp(path: string, stamp: PrebuildStamp): void {
  writeFileSync(path, `${JSON.stringify(stamp)}\n`);
}
