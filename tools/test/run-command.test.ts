import { describe, expect, it } from 'vitest';
import {
  buildPrebuildCommand,
  buildProcessEnv,
  buildRunCommand,
  hostError,
  nativeProject,
  parseRunArgs,
  type Target,
} from '../src/run-command.ts';

const devEnv = { DEV_HOST: 'http://h.example', DEV_USER: 'u', OTHER: 'ignored' };
const base = { action: 'run', variant: 'development', devEnv } as const;

describe('buildRunCommand', () => {
  it('never carries DEV_ values in production', () => {
    const targets: Target[] = ['android', 'android-tv', 'fire-tv', 'ios', 'tvos', 'windows'];
    for (const target of targets) {
      for (const action of ['run', 'build'] as const) {
        const r = buildRunCommand({ target, action, variant: 'production', devEnv });
        expect(Object.keys(r.env).filter((k) => k.startsWith('DEV_'))).toEqual([]);
        expect(JSON.stringify(r)).not.toContain('h.example');
        expect(r.env.APP_VARIANT).toBe('production');
      }
    }
  });

  it('passes only DEV_ keys in development, as env and never as argv', () => {
    const r = buildRunCommand({ ...base, target: 'android' });
    expect(r.env.DEV_HOST).toBe('http://h.example');
    expect(r.env.DEV_USER).toBe('u');
    expect(r.env.OTHER).toBeUndefined();
    expect(r.args.join(' ')).not.toContain('h.example');
    expect(r.env.APP_VARIANT).toBe('development');
  });

  it('sets STORE=amazon only for fire-tv', () => {
    expect(buildRunCommand({ ...base, target: 'fire-tv' }).env.STORE).toBe('amazon');
    expect(buildRunCommand({ ...base, target: 'android-tv' }).env.STORE).toBeUndefined();
    expect(buildRunCommand({ ...base, target: 'android' }).env.STORE).toBeUndefined();
  });

  it('sets EXPO_TV=1 for TV targets only', () => {
    for (const target of ['android-tv', 'fire-tv', 'tvos'] as const) {
      expect(buildRunCommand({ ...base, target }).env.EXPO_TV).toBe('1');
    }
    for (const target of ['android', 'ios', 'windows'] as const) {
      expect(buildRunCommand({ ...base, target }).env.EXPO_TV).toBeUndefined();
    }
  });

  it('maps native targets to expo from the app directory', () => {
    const android = buildRunCommand({ ...base, target: 'android' });
    expect(android.command).toBe('pnpm');
    expect(android.args).toEqual(['exec', 'expo', 'run:android']);
    expect(android.cwd).toBe('apps/tv-mobile');
    expect(buildRunCommand({ ...base, target: 'tvos' }).args).toContain('run:ios');
  });

  it('uses release configuration for production runs', () => {
    const android = buildRunCommand({ ...base, variant: 'production', target: 'android' });
    expect(android.args).toContain('--variant');
    const ios = buildRunCommand({ ...base, variant: 'production', target: 'ios' });
    expect(ios.args).toContain('--configuration');
  });

  it('regenerates native projects from scratch for the build action', () => {
    const r = buildRunCommand({ ...base, action: 'build', target: 'android-tv' });
    expect(r.args).toEqual([
      'exec',
      'expo',
      'prebuild',
      '--clean',
      '--platform',
      'android',
      '--no-install',
    ]);
    expect(r.env.EXPO_NO_GIT_STATUS).toBe('1');
  });

  it('routes desktop targets through the desktop app scripts', () => {
    for (const target of ['windows', 'macos', 'linux'] as const) {
      const dev = buildRunCommand({ ...base, target });
      expect(dev.args).toEqual(['--filter', '@elv/desktop', 'run', 'dev']);
      expect(dev.cwd).toBe('.');
      const build = buildRunCommand({ ...base, action: 'build', target });
      expect(build.args).toEqual(['--filter', '@elv/desktop', 'run', 'build']);
    }
  });
});

describe('buildProcessEnv', () => {
  const parent = {
    PATH: '/bin',
    DEV_HOST: 'http://shell.example',
    DEV_SHELL_ONLY: 'x',
    EXPO_TV: '1',
    STORE: 'amazon',
  };

  it('drops every parent DEV_ key in production', () => {
    const cmd = buildRunCommand({ ...base, variant: 'production', target: 'android' });
    const env = buildProcessEnv(parent, cmd, 'production');
    expect(Object.keys(env).filter((k) => k.startsWith('DEV_'))).toEqual([]);
    expect(env.PATH).toBe('/bin');
    expect(env.APP_VARIANT).toBe('production');
  });

  it('keeps only .env.local DEV_ values in development', () => {
    const cmd = buildRunCommand({ ...base, target: 'android' });
    const env = buildProcessEnv(parent, cmd, 'development');
    expect(env.DEV_HOST).toBe('http://h.example');
    expect(env.DEV_SHELL_ONLY).toBeUndefined();
  });

  it('does not inherit variant-controlling keys from the shell', () => {
    const cmd = buildRunCommand({ ...base, target: 'android' });
    const env = buildProcessEnv(parent, cmd, 'development');
    expect(env.EXPO_TV).toBeUndefined();
    expect(env.STORE).toBeUndefined();
  });

  it('skips undefined parent values', () => {
    const cmd = buildRunCommand({ ...base, target: 'android' });
    expect('X' in buildProcessEnv({ X: undefined }, cmd, 'development')).toBe(false);
  });
});

describe('buildPrebuildCommand', () => {
  it('cleans and regenerates the platform folder with the target env', () => {
    const r = buildPrebuildCommand({ ...base, target: 'fire-tv' });
    expect(r.cwd).toBe('apps/tv-mobile');
    expect(r.args).toEqual([
      'exec',
      'expo',
      'prebuild',
      '--clean',
      '--platform',
      'android',
      '--no-install',
    ]);
    expect(r.env).toMatchObject({ EXPO_TV: '1', STORE: 'amazon', EXPO_NO_GIT_STATUS: '1' });
    expect(buildPrebuildCommand({ ...base, target: 'tvos' }).args).toContain('ios');
  });

  it('keeps DEV_ values out of production prebuilds', () => {
    const r = buildPrebuildCommand({ ...base, variant: 'production', target: 'ios' });
    expect(Object.keys(r.env).filter((k) => k.startsWith('DEV_'))).toEqual([]);
  });

  it('refuses desktop targets, which have no native project', () => {
    expect(() => buildPrebuildCommand({ ...base, target: 'windows' })).toThrow(/no native project/);
  });
});

describe('nativeProject', () => {
  it('maps phone and TV targets to the shared platform folder and a stamp', () => {
    expect(nativeProject({ target: 'android-tv', variant: 'development' })).toEqual({
      dir: 'apps/tv-mobile/android',
      stamp: { target: 'android-tv', variant: 'development', store: 'default' },
    });
    expect(nativeProject({ target: 'fire-tv', variant: 'production' })?.stamp.store).toBe('amazon');
    expect(nativeProject({ target: 'tvos', variant: 'development' })?.dir).toBe(
      'apps/tv-mobile/ios',
    );
  });

  it('returns null for desktop targets', () => {
    expect(nativeProject({ target: 'macos', variant: 'development' })).toBeNull();
  });
});

describe('parseRunArgs', () => {
  it('reads the target, the optional action and the production flag', () => {
    expect(parseRunArgs(['android'])).toEqual({
      ok: true,
      target: 'android',
      action: 'run',
      variant: 'development',
    });
    expect(parseRunArgs(['tvos', 'build', '--production'])).toEqual({
      ok: true,
      target: 'tvos',
      action: 'build',
      variant: 'production',
    });
  });

  it('turns an unknown flag into a one-line error with the usage', () => {
    const r = parseRunArgs(['android', '--prod']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("'--prod'");
    expect(r.error).toContain('usage: pnpm run:app');
    expect(r.error).not.toContain('\n');
  });

  it.each([[[]], [['nope']], [['android', 'deploy']]])('rejects %j with the usage', (argv) => {
    const r = parseRunArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^usage: pnpm run:app </);
  });
});

describe('hostError', () => {
  it('refuses a desktop target on another operating system in one line', () => {
    const message = hostError('linux', 'win32');
    expect(message).toContain('linux');
    expect(message).toContain('win32');
    expect(message).not.toContain('\n');
    expect(hostError('macos', 'linux')).not.toBeNull();
    expect(hostError('windows', 'darwin')).not.toBeNull();
  });

  it('accepts each desktop target on its own host and leaves native targets alone', () => {
    expect(hostError('windows', 'win32')).toBeNull();
    expect(hostError('macos', 'darwin')).toBeNull();
    expect(hostError('linux', 'linux')).toBeNull();
    expect(hostError('android', 'win32')).toBeNull();
    expect(hostError('ios', 'linux')).toBeNull();
  });
});
