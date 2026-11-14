import { describe, expect, it } from 'vitest';
import { buildAppConfig, type Env } from './build-app-config';

const options = { version: '1.2.3', now: new Date('2026-11-13T00:00:00Z') };
const build = (env: Env) => buildAppConfig(env, options);

function pluginOptions(env: Env, name: string): Record<string, unknown> | undefined {
  for (const plugin of build(env).plugins ?? []) {
    if (Array.isArray(plugin) && plugin[0] === name) return plugin[1] as Record<string, unknown>;
  }
  return undefined;
}

describe('buildAppConfig', () => {
  it('builds the production identity by default', () => {
    const config = build({});
    expect(config.name).toBe('ELV IPTV');
    expect(config.android?.package).toBe('io.github.fatihmutluu.elviptv');
    expect(config.ios?.bundleIdentifier).toBe('io.github.fatihmutluu.elviptv');
    expect(config.version).toBe('1.2.3');
  });

  it('builds the development identity', () => {
    const config = build({ APP_VARIANT: 'development' });
    expect(config.name).toBe('ELV IPTV Dev');
    expect(config.android?.package).toBe('io.github.fatihmutluu.elviptv.dev');
    expect(config.ios?.bundleIdentifier).toBe('io.github.fatihmutluu.elviptv.dev');
  });

  it.each(['development', 'production', undefined])(
    'allows plain HTTP for user-supplied sources on every platform (variant %s)',
    (variant) => {
      const env = { APP_VARIANT: variant };
      const config = build(env);
      expect(pluginOptions(env, 'expo-build-properties')).toMatchObject({
        android: { minSdkVersion: 28, usesCleartextTraffic: true },
        ios: { deploymentTarget: '18.0' },
      });
      expect(config.ios?.infoPlist?.NSAppTransportSecurity).toEqual({
        NSAllowsArbitraryLoads: true,
      });
      expect(config.ios?.infoPlist?.NSAppTransportSecurity).not.toHaveProperty(
        'NSAllowsLocalNetworking',
      );
      const custom = (config.plugins ?? []).some(
        (p) => typeof p === 'function' || (Array.isArray(p) && typeof p[0] === 'function'),
      );
      expect(custom).toBe(false);
    },
  );

  it('adds the TV plugin only when EXPO_TV is set', () => {
    expect(pluginOptions({}, '@react-native-tvos/config-tv')).toBeUndefined();
    expect(pluginOptions({ EXPO_TV: '1' }, '@react-native-tvos/config-tv')).toMatchObject({
      isTV: true,
      tvosDeploymentTarget: '18.0',
      androidTVBanner: './assets/tv-banner.png',
    });
  });

  it('records the store, defaulting to direct, and rejects unknown stores', () => {
    expect(build({}).extra?.store).toBe('direct');
    expect(build({ STORE: 'amazon' }).extra?.store).toBe('amazon');
    expect(() => build({ STORE: 'huawei' })).toThrow('STORE must be one of');
  });

  it('records build metadata', () => {
    const env = { GITHUB_SHA: 'abc', GITHUB_REF_NAME: 'main', GITHUB_RUN_NUMBER: '7' };
    expect(build(env).extra?.build).toEqual({
      commit: 'abc',
      branch: 'main',
      run: '7',
      builtAt: '2026-11-13T00:00:00.000Z',
    });
    expect(build({}).extra?.build).toMatchObject({ commit: 'local', branch: 'local' });
  });

  it('registers the deep link scheme everywhere but the gate flag only in development', () => {
    for (const variant of ['production', 'development', undefined]) {
      expect(build({ APP_VARIANT: variant }).scheme).toBe('elviptv');
    }
    expect(build({ APP_VARIANT: 'development' }).extra?.gate).toBe(true);
    for (const variant of ['production', undefined]) {
      const config = build({ APP_VARIANT: variant });
      expect(config.extra).not.toHaveProperty('gate');
      expect(JSON.stringify(config)).not.toContain('gate');
    }
  });

  it('exposes DEV_ values in development only', () => {
    const env = { DEV_XTREAM_URL: 'http://x', DEV_XTREAM_PASS: 'secret', OTHER: 'no' };
    expect(build({ ...env, APP_VARIANT: 'development' }).extra?.dev).toEqual({
      DEV_XTREAM_URL: 'http://x',
      DEV_XTREAM_PASS: 'secret',
    });
    for (const variant of ['production', undefined]) {
      const config = build({ ...env, APP_VARIANT: variant });
      expect(config.extra).not.toHaveProperty('dev');
      expect(JSON.stringify(config)).not.toContain('DEV_');
      expect(JSON.stringify(config)).not.toContain('secret');
    }
  });
});
