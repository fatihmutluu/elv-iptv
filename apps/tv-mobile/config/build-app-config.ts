import type { ExpoConfig } from 'expo/config';
import { DEV_CLEARTEXT_HOSTS, withDevCleartext } from './with-dev-cleartext';

/** The build environment (`process.env` when Expo loads `app.config.ts`). */
export type Env = Readonly<Record<string, string | undefined>>;

const STORES = ['play', 'amazon', 'appstore', 'direct'] as const;
type Store = (typeof STORES)[number];

/** Inputs that do not come from the environment: the package version and the build time. */
export interface BuildOptions {
  version: string;
  now: Date;
}

const APP_ID = 'io.github.fatihmutluu.elviptv';
const MIN_ANDROID_SDK = 28;
const MIN_APPLE_OS = '18.0';

function parseStore(value: string | undefined): Store {
  if (value === undefined || value === '') return 'direct';
  const store = STORES.find((s) => s === value);
  if (store === undefined) {
    throw new Error(`STORE must be one of ${STORES.join('|')}, got "${value}"`);
  }
  return store;
}

function devValues(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('DEV_') && value !== undefined) out[key] = value;
  }
  return out;
}

/** Builds the Expo config from the build environment; `DEV_*` values appear only in development. */
export function buildAppConfig(env: Env, options: BuildOptions): ExpoConfig {
  const development = env.APP_VARIANT === 'development';
  const tv = env.EXPO_TV === '1' || env.EXPO_TV === 'true';
  const id = development ? `${APP_ID}.dev` : APP_ID;

  const plugins: NonNullable<ExpoConfig['plugins']> = [
    [
      'expo-build-properties',
      {
        android: { minSdkVersion: MIN_ANDROID_SDK, usesCleartextTraffic: false },
        ios: { deploymentTarget: MIN_APPLE_OS },
      },
    ],
  ];
  // Expo accepts a plugin function in place of its module name, though its config type lists only strings.
  if (development) {
    plugins.push([withDevCleartext as unknown as string, { hosts: DEV_CLEARTEXT_HOSTS }]);
  }
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

  return {
    name: development ? 'ELV IPTV Dev' : 'ELV IPTV',
    slug: 'elv-iptv',
    version: options.version,
    orientation: 'default',
    scheme: 'elviptv',
    icon: './assets/icon.png',
    android: {
      package: id,
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
        ...(development ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
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
      ...(development ? { dev: devValues(env), gate: true } : {}),
    },
  };
}
