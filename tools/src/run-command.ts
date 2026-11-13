import { parseArgs } from 'node:util';
import type { PrebuildStamp } from './prebuild-stamp.ts';

/** Platforms `pnpm run:app` can launch or build. */
export type Target =
  | 'android'
  | 'android-tv'
  | 'fire-tv'
  | 'ios'
  | 'tvos'
  | 'windows'
  | 'macos'
  | 'linux';

const TARGETS: readonly Target[] = [
  'android',
  'android-tv',
  'fire-tv',
  'ios',
  'tvos',
  'windows',
  'macos',
  'linux',
];

/** Options for {@link buildRunCommand}. */
export interface RunOptions {
  target: Target;
  action: 'run' | 'build';
  variant: 'development' | 'production';
  devEnv: Record<string, string>;
}

/** A process to spawn. `cwd` is relative to the repository root. */
export interface RunCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** Parsed `pnpm run:app` arguments, or the one-line error to print. */
export type RunArgs = ({ ok: true } & Omit<RunOptions, 'devEnv'>) | { ok: false; error: string };

const TV_TARGETS: readonly Target[] = ['android-tv', 'fire-tv', 'tvos'];
const DESKTOP_HOSTS: Partial<Record<Target, string>> = {
  windows: 'win32',
  macos: 'darwin',
  linux: 'linux',
};
const STORES: Partial<Record<Target, string>> = { 'fire-tv': 'amazon' };
const MOBILE_APP_DIR = 'apps/tv-mobile';
const USAGE = `usage: pnpm run:app <${TARGETS.join('|')}> [build] [--production]`;

const nativePlatform = (target: Target): 'android' | 'ios' | null => {
  if (target in DESKTOP_HOSTS) return null;
  return target === 'ios' || target === 'tvos' ? 'ios' : 'android';
};

/** Parses `pnpm run:app` arguments (without the node and script entries). */
export function parseRunArgs(argv: string[]): RunArgs {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { production: { type: 'boolean' } },
    });
    const [target, action = 'run'] = positionals;
    if (!TARGETS.includes(target as Target) || (action !== 'run' && action !== 'build')) {
      return { ok: false, error: USAGE };
    }
    const variant = values.production === true ? 'production' : 'development';
    return { ok: true, target: target as Target, action, variant };
  } catch (error) {
    // node:util parseArgs adds a multi-sentence hint after the first sentence.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `run:app: ${message.split('. ')[0]}. ${USAGE}` };
  }
}

/**
 * Returns a one-line refusal when `target` is a desktop target for another operating system
 * than `platform` (a `process.platform` value): electron-builder cannot build it reliably here.
 */
export function hostError(target: Target, platform: string): string | null {
  const host = DESKTOP_HOSTS[target];
  if (host === undefined || host === platform) return null;
  return `run:app: the ${target} target runs and builds only on ${host} hosts, not on ${platform}; CI builds every desktop target`;
}

/** The generated native folder (repository-relative) and the stamp a target needs, or null on desktop. */
export function nativeProject(
  opts: Pick<RunOptions, 'target' | 'variant'>,
): { dir: string; stamp: PrebuildStamp } | null {
  const platform = nativePlatform(opts.target);
  if (platform === null) return null;
  return {
    dir: `${MOBILE_APP_DIR}/${platform}`,
    stamp: { target: opts.target, variant: opts.variant, store: STORES[opts.target] ?? 'default' },
  };
}

function baseEnv(opts: Omit<RunOptions, 'action'>): Record<string, string> {
  const env: Record<string, string> = { APP_VARIANT: opts.variant };
  if (opts.variant === 'development') {
    for (const [key, value] of Object.entries(opts.devEnv)) {
      if (key.startsWith('DEV_')) env[key] = value;
    }
  }
  if (nativePlatform(opts.target) === null) return env;
  if (TV_TARGETS.includes(opts.target)) env.EXPO_TV = '1';
  const store = STORES[opts.target];
  if (store !== undefined) env.STORE = store;
  return env;
}

/**
 * The `expo prebuild` command that deletes and regenerates a target's native folder.
 * `EXPO_NO_GIT_STATUS` stops the clean step from prompting about a dirty working tree.
 */
export function buildPrebuildCommand(opts: Omit<RunOptions, 'action'>): RunCommand {
  const platform = nativePlatform(opts.target);
  if (platform === null) throw new Error(`${opts.target} has no native project to prebuild`);
  return {
    command: 'pnpm',
    args: ['exec', 'expo', 'prebuild', '--clean', '--platform', platform, '--no-install'],
    env: { ...baseEnv(opts), EXPO_NO_GIT_STATUS: '1' },
    cwd: MOBILE_APP_DIR,
  };
}

/**
 * Maps a target to the command that runs or builds it. `DEV_*` entries of `devEnv` are
 * forwarded through the environment in development builds only and never appear in argv.
 */
export function buildRunCommand(opts: RunOptions): RunCommand {
  const env = baseEnv(opts);
  const platform = nativePlatform(opts.target);

  if (platform === null) {
    const script = opts.action === 'run' ? 'dev' : 'build';
    return {
      command: 'pnpm',
      args: ['--filter', '@elv/desktop', 'run', script],
      env,
      cwd: '.',
    };
  }

  if (opts.action === 'build') return buildPrebuildCommand(opts);
  const args = ['exec', 'expo', `run:${platform}`];
  if (opts.variant === 'production') {
    args.push(
      ...(platform === 'android' ? ['--variant', 'release'] : ['--configuration', 'Release']),
    );
  }
  return { command: 'pnpm', args, env, cwd: MOBILE_APP_DIR };
}

const MANAGED_KEYS = ['APP_VARIANT', 'EXPO_TV', 'STORE'];

/**
 * Environment for the spawned process: the parent environment without any `DEV_*` key or
 * variant-controlling key, plus the command's own env. Credentials therefore come only
 * from `.env.local` (via `cmd.env`) and only in development.
 */
export function buildProcessEnv(
  parent: Record<string, string | undefined>,
  cmd: RunCommand,
  variant: RunOptions['variant'],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || key.startsWith('DEV_') || MANAGED_KEYS.includes(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(cmd.env)) {
    if (variant === 'production' && key.startsWith('DEV_')) continue;
    env[key] = value;
  }
  return env;
}
