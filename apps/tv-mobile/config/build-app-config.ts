import type { ExpoConfig } from 'expo/config';
import { withAccessibilityFonts } from './with-accessibility-fonts.ts';
import { withAetherFrameworks } from './with-aether-frameworks.ts';
import { withAndroidDisplay } from './with-android-display.ts';

/** The build environment (`process.env` when Expo loads `app.config.ts`). */
export type Env = Readonly<Record<string, string | undefined>>;

const STORES = ['play', 'amazon', 'appstore', 'direct'] as const;
type Store = (typeof STORES)[number];

/** Normalized development source seed embedded into native debug `app.config` assets only (#10). */
export type DevSeedPayload =
  | {
      readonly kind: 'xtream';
      readonly name: string;
      readonly server: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly kind: 'm3u';
      readonly name: string;
      readonly playlistUrl: string;
      readonly guideUrl?: string;
    };

/** Inputs that do not come from the environment: the package version, build time, and native debug embed flag. */
export interface BuildOptions {
  version: string;
  now: Date;
  embedDevSeed?: boolean;
}

const APP_ID = 'io.github.fatihmutluu.elviptv';
const MIN_ANDROID_SDK = 28;
const MIN_APPLE_OS = '18.0';
const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];

function parseStore(value: string | undefined): Store {
  if (value === undefined || value === '') return 'direct';
  const store = STORES.find((s) => s === value);
  if (store === undefined) {
    throw new Error(`STORE must be one of ${STORES.join('|')}, got "${value}"`);
  }
  return store;
}

function defaultHostName(rawUrl: string, fallback: string): string {
  try {
    return new URL(rawUrl).host || fallback;
  } catch {
    return fallback;
  }
}

function parseDevSeedEnv(env: Env): DevSeedPayload | undefined {
  const server = (env.DEV_XTREAM_SERVER ?? env.DEV_XTREAM_URL ?? '').trim();
  const username = (env.DEV_XTREAM_USERNAME ?? '').trim();
  const password = (env.DEV_XTREAM_PASSWORD ?? '').trim();
  if (server !== '' && username !== '' && password !== '') {
    const customName = (env.DEV_XTREAM_NAME ?? env.DEV_SOURCE_NAME ?? '').trim();
    return {
      kind: 'xtream',
      name: customName !== '' ? customName : defaultHostName(server, 'Dev Xtream'),
      server,
      username,
      password,
    };
  }

  const playlistUrl = (env.DEV_M3U_URL ?? '').trim();
  if (playlistUrl !== '') {
    const customName = (env.DEV_M3U_NAME ?? env.DEV_SOURCE_NAME ?? '').trim();
    const guideUrl = (env.DEV_M3U_GUIDE_URL ?? env.DEV_GUIDE_URL ?? '').trim();
    return {
      kind: 'm3u',
      name: customName !== '' ? customName : defaultHostName(playlistUrl, 'Dev M3U'),
      playlistUrl,
      ...(guideUrl !== '' ? { guideUrl } : {}),
    };
  }

  return undefined;
}

/**
 * Returns `true` only when Expo Constants' native asset script (`expo-constants/scripts/getAppConfig.js`)
 * is invoked in debug/development mode by Gradle (`createDebugExpoConfig`, `argv[6] === 'development'`)
 * or Xcode (`Bundle Expo Config`, `argv[6] === 'development'` or legacy `argv[5] === 'true'`).
 * Returns `false` for Metro (`@expo/cli`), `expo prebuild`, and Release builds (`argv[6] === 'production'`)
 * so `DEV_*` credentials never enter Metro's HTTP manifest or JS bundle over the LAN (#10).
 */
export function isNativeDebugConfigEmbed(argv: readonly string[]): boolean {
  const script = (argv[1] ?? '').replace(/\\/g, '/');
  const isGetAppConfig =
    script === 'expo-constants/scripts/getAppConfig.js' ||
    script.endsWith('/expo-constants/scripts/getAppConfig.js');
  const isDebugConfigMode =
    argv[6] === 'development' || (argv[6] === undefined && argv[5] === 'true');
  return isGetAppConfig && isDebugConfigMode;
}

/** Builds the Expo config from the build environment; `extra.seed` is embedded only in native debug builds. */
export function buildAppConfig(env: Env, options: BuildOptions): ExpoConfig {
  const development = env.APP_VARIANT === 'development';
  const tv = env.EXPO_TV === '1' || env.EXPO_TV === 'true';
  const id = development ? `${APP_ID}.dev` : APP_ID;
  const seed = development && options.embedDevSeed === true ? parseDevSeedEnv(env) : undefined;

  const plugins: NonNullable<ExpoConfig['plugins']> = [
    [
      'expo-build-properties',
      {
        android: { minSdkVersion: MIN_ANDROID_SDK, usesCleartextTraffic: true },
        ios: { deploymentTarget: MIN_APPLE_OS },
      },
    ],
  ];
  if (tv) {
    plugins.push([
      '@react-native-tvos/config-tv',
      {
        isTV: true,
        tvosDeploymentTarget: MIN_APPLE_OS,
        androidTVBanner: './assets/tv-banner.png',
        appleTVImages: {
          icon: './assets/tvos-icon-1280x768.png',
          iconSmall: './assets/tvos-icon-small-400x240.png',
          iconSmall2x: './assets/tvos-icon-small-800x480.png',
          topShelf: './assets/tvos-top-shelf-1920x720.png',
          topShelf2x: './assets/tvos-top-shelf-3840x1440.png',
          topShelfWide: './assets/tvos-top-shelf-wide-2320x720.png',
          topShelfWide2x: './assets/tvos-top-shelf-wide-4640x1440.png',
        },
      },
    ]);
  }

  // `@expo/config-types` omits `ConfigPlugin` functions from `ExpoConfig['plugins']`; `@expo/config-plugins` runs them.
  plugins.push(withAetherFrameworks as unknown as NonNullable<ExpoConfig['plugins']>[number]);
  plugins.push(withAccessibilityFonts as unknown as NonNullable<ExpoConfig['plugins']>[number]);
  plugins.push([withAndroidDisplay, { isTv: tv }] as unknown as NonNullable<
    ExpoConfig['plugins']
  >[number]);

  return {
    name: development ? 'ELV IPTV Dev' : 'ELV IPTV',
    slug: 'elv-iptv',
    version: options.version,
    orientation: 'default',
    scheme: 'elviptv',
    icon: './assets/icon.png',
    android: {
      package: id,
      blockedPermissions: [...BLOCKED_ANDROID_PERMISSIONS],
      predictiveBackGestureEnabled: false,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0b0e14',
      },
    },
    ios: {
      bundleIdentifier: id,
      supportsTablet: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSBonjourServices: ['_airplay._tcp'],
        NSLocalNetworkUsageDescription:
          'ELV IPTV discovers AirPlay receivers on your local network to match supported audio formats.',
        // Users bring plain-HTTP providers. Never add NSAllowsLocalNetworking here: when both keys are
        // present Apple ignores NSAllowsArbitraryLoads, so plain HTTP is blocked again.
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      },
    },
    plugins,
    extra: {
      store: parseStore(env.STORE),
      build: {
        commit: env.GITHUB_SHA ?? 'local',
        branch: env.GITHUB_REF_NAME ?? 'local',
        run: env.GITHUB_RUN_NUMBER ?? 'local',
        builtAt: options.now.toISOString(),
      },
      ...(development ? { gate: true } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
}
