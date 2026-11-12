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

export const TARGETS: readonly Target[] = [
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

const TV_TARGETS: readonly Target[] = ['android-tv', 'fire-tv', 'tvos'];
const DESKTOP_TARGETS: readonly Target[] = ['windows', 'macos', 'linux'];
const MOBILE_APP_DIR = 'apps/tv-mobile';

/**
 * Maps a target to the command that runs or builds it. `DEV_*` entries of `devEnv` are
 * forwarded through the environment in development builds only and never appear in argv.
 */
export function buildRunCommand(opts: RunOptions): RunCommand {
  const env: Record<string, string> = { APP_VARIANT: opts.variant };
  if (opts.variant === 'development') {
    for (const [key, value] of Object.entries(opts.devEnv)) {
      if (key.startsWith('DEV_')) env[key] = value;
    }
  }

  if (DESKTOP_TARGETS.includes(opts.target)) {
    const script = opts.action === 'run' ? 'dev' : 'build';
    return {
      command: 'pnpm',
      args: ['--filter', '@elv/desktop', 'run', script],
      env,
      cwd: '.',
    };
  }

  if (TV_TARGETS.includes(opts.target)) env.EXPO_TV = '1';
  if (opts.target === 'fire-tv') env.STORE = 'amazon';

  const platform = opts.target === 'ios' || opts.target === 'tvos' ? 'ios' : 'android';
  const production = opts.variant === 'production';
  let args: string[];
  if (opts.action === 'build') {
    args = ['exec', 'expo', 'prebuild', '--platform', platform, '--no-install'];
  } else {
    args = ['exec', 'expo', `run:${platform}`];
    if (production) {
      args.push(
        ...(platform === 'android' ? ['--variant', 'release'] : ['--configuration', 'Release']),
      );
    }
  }
  return { command: 'pnpm', args, env, cwd: MOBILE_APP_DIR };
}
