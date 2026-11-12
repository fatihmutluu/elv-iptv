import { describe, expect, it } from 'vitest';
import { buildRunCommand, type Target } from '../src/run-command.ts';

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

  it('generates native projects for the build action', () => {
    const r = buildRunCommand({ ...base, action: 'build', target: 'android-tv' });
    expect(r.args.slice(0, 3)).toEqual(['exec', 'expo', 'prebuild']);
    expect(r.args).toContain('android');
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
