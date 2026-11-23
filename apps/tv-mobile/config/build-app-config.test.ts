import { describe, expect, it } from 'vitest';
import {
  type BuildOptions,
  buildAppConfig,
  type Env,
  isNativeDebugConfigEmbed,
} from './build-app-config';
import { withAccessibilityFonts } from './with-accessibility-fonts.ts';
import { withAetherFrameworks } from './with-aether-frameworks.ts';
import { withAndroidDisplay } from './with-android-display.ts';

const baseOptions: BuildOptions = { version: '1.2.3', now: new Date('2026-11-13T00:00:00Z') };
const build = (env: Env, overrides: Partial<BuildOptions> = {}) =>
  buildAppConfig(env, { ...baseOptions, ...overrides });

function pluginOptions(env: Env, name: string): Record<string, unknown> | undefined {
  for (const plugin of build(env).plugins ?? []) {
    if (Array.isArray(plugin) && plugin[0] === name) return plugin[1] as Record<string, unknown>;
  }
  return undefined;
}

describe('isNativeDebugConfigEmbed (#10)', () => {
  it('returns true for real Gradle Android debug and Xcode iOS debug getAppConfig.js invocations', () => {
    // Gradle Android Debug (expo-constants@58.0.16 passes argv[5]="false", argv[6]="development")
    expect(
      isNativeDebugConfigEmbed([
        '/usr/local/bin/node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/repo/apps/tv-mobile/android/app/build/generated/assets/createDebugExpoConfig',
        'android',
        'false',
        'development',
      ]),
    ).toBe(true);

    // Windows Gradle Android Debug path separators
    expect(
      isNativeDebugConfigEmbed([
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\repo\\node_modules\\.pnpm\\expo-constants@58.0.16\\node_modules\\expo-constants\\scripts\\getAppConfig.js',
        'C:\\repo\\apps\\tv-mobile',
        'C:\\repo\\apps\\tv-mobile\\android\\app\\build\\generated\\assets\\createDebugExpoConfig',
        'android',
        'false',
        'development',
      ]),
    ).toBe(true);

    // Xcode iOS/tvOS Debug (get-app-config-ios.sh passes argv[5]="true", argv[6]="development")
    expect(
      isNativeDebugConfigEmbed([
        '/usr/local/bin/node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/Users/dev/Library/Developer/Xcode/DerivedData/App/EXConstants.bundle',
        'app.config',
        'true',
        'development',
      ]),
    ).toBe(true);

    // Legacy 6-arg debug fallback (argv[6] === undefined && argv[5] === 'true')
    expect(
      isNativeDebugConfigEmbed([
        '/usr/local/bin/node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/repo/out',
        'app.config',
        'true',
      ]),
    ).toBe(true);
  });

  it('returns false for Gradle Android release, Xcode iOS release, Metro, and expo prebuild', () => {
    // Gradle Android Release (argv[5]="false", argv[6]="production")
    expect(
      isNativeDebugConfigEmbed([
        'node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/repo/apps/tv-mobile/android/app/build/generated/assets/createReleaseExpoConfig',
        'android',
        'false',
        'production',
      ]),
    ).toBe(false);

    // Xcode iOS/tvOS Release (argv[5]="false", argv[6]="production")
    expect(
      isNativeDebugConfigEmbed([
        'node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/Users/dev/Library/Developer/Xcode/DerivedData/App/EXConstants.bundle',
        'app.config',
        'false',
        'production',
      ]),
    ).toBe(false);

    // Even if argv[5] were "true", explicit "production" in argv[6] must be rejected
    expect(
      isNativeDebugConfigEmbed([
        'node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/repo/out',
        'app.config',
        'true',
        'production',
      ]),
    ).toBe(false);

    expect(
      isNativeDebugConfigEmbed(['node', '/repo/node_modules/@expo/cli/build/bin/cli', 'start']),
    ).toBe(false);

    expect(
      isNativeDebugConfigEmbed(['node', '/repo/node_modules/expo/bin/cli', 'prebuild', '--clean']),
    ).toBe(false);

    expect(
      isNativeDebugConfigEmbed([
        'node',
        '/repo/node_modules/expo-constants/scripts/getAppConfig.js',
        '/repo/apps/tv-mobile',
        '/repo/out',
        'app.config',
        'false',
      ]),
    ).toBe(false);

    expect(isNativeDebugConfigEmbed([])).toBe(false);
  });
});

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

  it.each([
    { APP_VARIANT: 'development', STORE: 'direct', EXPO_TV: undefined },
    { APP_VARIANT: 'production', STORE: 'play', EXPO_TV: undefined },
    { APP_VARIANT: 'production', STORE: 'amazon', EXPO_TV: '1' },
    { APP_VARIANT: 'production', STORE: 'appstore', EXPO_TV: '1' },
    { APP_VARIANT: undefined, STORE: undefined, EXPO_TV: undefined },
  ])(
    'allows plain HTTP for user-supplied sources across every variant, target, and store (%o)',
    (env) => {
      const config = build(env);
      const buildProps = pluginOptions(env, 'expo-build-properties') as {
        android?: Record<string, unknown>;
        ios?: Record<string, unknown>;
      };
      expect(buildProps).toMatchObject({
        android: { minSdkVersion: 28, usesCleartextTraffic: true },
        ios: { deploymentTarget: '18.0' },
      });
      expect(buildProps.android).not.toHaveProperty('networkSecurityConfig');
      expect(config.ios?.infoPlist?.NSAppTransportSecurity).toEqual({
        NSAllowsArbitraryLoads: true,
      });
      expect(config.ios?.infoPlist?.NSBonjourServices).toEqual(['_airplay._tcp']);
      expect(config.ios?.infoPlist?.NSLocalNetworkUsageDescription).toBe(
        'ELV IPTV discovers AirPlay receivers on your local network to match supported audio formats.',
      );
      expect(config.ios?.infoPlist?.NSAppTransportSecurity).not.toHaveProperty(
        'NSAllowsLocalNetworking',
      );
      expect(config.ios?.infoPlist?.NSAppTransportSecurity).not.toHaveProperty(
        'NSExceptionDomains',
      );
      const custom = (config.plugins ?? []).some(
        (p) =>
          (typeof p === 'function' && p !== withAetherFrameworks && p !== withAccessibilityFonts) ||
          (Array.isArray(p) && typeof p[0] === 'function' && p[0] !== withAndroidDisplay),
      );
      expect(custom).toBe(false);
    },
  );

  it('wires withAndroidDisplay with isTv matching EXPO_TV (#255, #266)', () => {
    expect(build({}).plugins).toContainEqual([withAndroidDisplay, { isTv: false }]);
    expect(build({ EXPO_TV: '1' }).plugins).toContainEqual([withAndroidDisplay, { isTv: true }]);
  });

  it.each(['development', 'production', undefined])(
    'blocks legacy external storage permissions and disables Android predictive back (variant %s)',
    (variant) => {
      const config = build({ APP_VARIANT: variant });
      expect(config.android?.blockedPermissions).toEqual([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ]);
      expect(config.android?.predictiveBackGestureEnabled).toBe(false);
    },
  );

  it.each([
    { APP_VARIANT: 'development', EXPO_TV: '1' },
    { APP_VARIANT: 'development', EXPO_TV: undefined },
    { APP_VARIANT: 'production', EXPO_TV: '1' },
    { APP_VARIANT: 'production', EXPO_TV: undefined },
  ])(
    'wires the AetherEngine frameworks and accessibility fonts plugins in every variant (%o)',
    (env) => {
      const plugins = build(env).plugins;
      expect(plugins).toContain(withAetherFrameworks);
      expect(plugins).toContain(withAccessibilityFonts);
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

  it('includes UIBackgroundModes audio only on iOS/iPadOS mobile builds and omits it on tvOS (#413)', () => {
    expect(build({}).ios?.infoPlist?.UIBackgroundModes).toEqual(['audio']);
    expect(build({ APP_VARIANT: 'development' }).ios?.infoPlist?.UIBackgroundModes).toEqual([
      'audio',
    ]);
    expect(build({ EXPO_TV: '1' }).ios?.infoPlist).not.toHaveProperty('UIBackgroundModes');
    expect(build({ EXPO_TV: 'true' }).ios?.infoPlist).not.toHaveProperty('UIBackgroundModes');
    expect(build({ APP_VARIANT: 'development', EXPO_TV: '1' }).ios?.infoPlist).not.toHaveProperty(
      'UIBackgroundModes',
    );
  });

  it('records the store, defaulting to direct, and rejects unknown stores', () => {
    expect(build({}).extra?.store).toBe('direct');
    expect(build({ STORE: 'amazon' }).extra?.store).toBe('amazon');
    expect(() => build({ STORE: 'huawei' })).toThrow('STORE must be one of');
  });

  it('includes Fire OS voice command permission only on TV or Amazon store builds (#132)', () => {
    const voicePermission = 'com.amazon.permission.media.session.voicecommandcontrol';
    expect(build({ EXPO_TV: '1', STORE: 'play' }).android?.permissions).toContain(voicePermission);
    expect(build({ EXPO_TV: 'true', STORE: 'direct' }).android?.permissions).toContain(
      voicePermission,
    );
    expect(build({ STORE: 'amazon' }).android?.permissions).toContain(voicePermission);
    expect(build({ EXPO_TV: '1', STORE: 'amazon' }).android?.permissions).toContain(
      voicePermission,
    );

    expect(build({ STORE: 'play' }).android?.permissions).toBeUndefined();
    expect(build({}).android?.permissions).toBeUndefined();
    expect(
      build({ STORE: 'direct', APP_VARIANT: 'development' }).android?.permissions,
    ).toBeUndefined();
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

  it('omits extra.dev in all variants and embeds extra.seed only for development + embedDevSeed (#10)', () => {
    const xtreamEnv: Env = {
      DEV_XTREAM_SERVER: 'http://127.0.0.1:7878',
      DEV_XTREAM_USERNAME: 'demo',
      DEV_XTREAM_PASSWORD: 'demo',
    };

    // Metro / prebuild (embedDevSeed omitted or false) -> zero credentials in extra!
    const metroDev = build({ ...xtreamEnv, APP_VARIANT: 'development' });
    expect(metroDev.extra).not.toHaveProperty('dev');
    expect(metroDev.extra).not.toHaveProperty('seed');
    expect(JSON.stringify(metroDev)).not.toContain('DEV_');
    expect(JSON.stringify(metroDev)).not.toContain('127.0.0.1:7878');

    const explicitFalse = build(
      { ...xtreamEnv, APP_VARIANT: 'development' },
      { embedDevSeed: false },
    );
    expect(explicitFalse.extra).not.toHaveProperty('dev');
    expect(explicitFalse.extra).not.toHaveProperty('seed');

    // Production never embeds extra.seed even if embedDevSeed were passed
    for (const variant of ['production', undefined]) {
      const prodConfig = build({ ...xtreamEnv, APP_VARIANT: variant }, { embedDevSeed: true });
      expect(prodConfig.extra).not.toHaveProperty('dev');
      expect(prodConfig.extra).not.toHaveProperty('seed');
      expect(JSON.stringify(prodConfig)).not.toContain('DEV_');
      expect(JSON.stringify(prodConfig)).not.toContain('127.0.0.1:7878');
    }

    // Native debug app.config embed (APP_VARIANT=development + embedDevSeed: true)
    const debugEmbed = build({ ...xtreamEnv, APP_VARIANT: 'development' }, { embedDevSeed: true });
    expect(debugEmbed.extra).not.toHaveProperty('dev');
    expect(debugEmbed.extra?.seed).toEqual({
      kind: 'xtream',
      name: '127.0.0.1:7878',
      server: 'http://127.0.0.1:7878',
      username: 'demo',
      password: 'demo',
    });
    expect(JSON.stringify(debugEmbed)).not.toContain('DEV_');

    // M3U fallback when DEV_XTREAM_* is absent
    const m3uEmbed = build(
      {
        APP_VARIANT: 'development',
        DEV_M3U_NAME: 'Local Sim M3U',
        DEV_M3U_URL: 'http://127.0.0.1:7878/playlists/demo.m3u8',
        DEV_M3U_GUIDE_URL: 'http://127.0.0.1:7878/xmltv.xml',
      },
      { embedDevSeed: true },
    );
    expect(m3uEmbed.extra?.seed).toEqual({
      kind: 'm3u',
      name: 'Local Sim M3U',
      playlistUrl: 'http://127.0.0.1:7878/playlists/demo.m3u8',
      guideUrl: 'http://127.0.0.1:7878/xmltv.xml',
    });
  });
});
