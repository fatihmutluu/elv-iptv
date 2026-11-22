import {
  type AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
  withAndroidStyles,
} from 'expo/config-plugins';

/** Options for {@link withAndroidDisplay}. */
export interface AndroidDisplayPluginOptions {
  /** True when building for Android TV / Fire TV (`EXPO_TV=1`); skips PiP and cutout mutations. */
  readonly isTv?: boolean;
}

const PIP_CONFIG_CHANGES = ['smallestScreenSize', 'screenLayout'] as const;
const CUTOUT_STYLE_ITEM_NAME = 'android:windowLayoutInDisplayCutoutMode';
const CUTOUT_SHORT_EDGES = 'shortEdges';

function mergeConfigChanges(existing: string | undefined): string {
  const parts = (existing ?? '')
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const required of PIP_CONFIG_CHANGES) {
    if (!parts.includes(required)) parts.push(required);
  }
  return parts.join('|');
}

/**
 * Enables `android:supportsPictureInPicture="true"` and merges `smallestScreenSize|screenLayout`
 * into `MainActivity`'s `android:configChanges` for non-TV Android builds (`#266`).
 */
export function applyAndroidDisplayManifest(
  manifest: AndroidConfig.Manifest.AndroidManifest,
  isTv: boolean,
): AndroidConfig.Manifest.AndroidManifest {
  if (isTv) return manifest;
  const application = manifest.manifest.application?.[0];
  const activities = application?.activity ?? [];
  const mainActivity =
    activities.find(
      (activity) =>
        activity.$?.['android:name'] === '.MainActivity' ||
        activity.$?.['android:name']?.endsWith('.MainActivity'),
    ) ?? activities[0];
  if (mainActivity === undefined) return manifest;
  mainActivity.$['android:supportsPictureInPicture'] = 'true';
  mainActivity.$['android:configChanges'] = mergeConfigChanges(
    mainActivity.$['android:configChanges'],
  );
  return manifest;
}

/**
 * Adds `<item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>` to `AppTheme`
 * in `styles.xml` for non-TV Android builds (`#255`).
 */
export function applyAndroidDisplayStyles(
  styles: AndroidConfig.Resources.ResourceXML,
  isTv: boolean,
): AndroidConfig.Resources.ResourceXML {
  if (isTv) return styles;
  const styleList = styles.resources?.style ?? [];
  const appTheme = styleList.find((style) => style.$?.name === 'AppTheme');
  if (appTheme === undefined) return styles;
  appTheme.item ??= [];
  const existing = appTheme.item.find((item) => item.$?.name === CUTOUT_STYLE_ITEM_NAME);
  if (existing !== undefined) {
    existing._ = CUTOUT_SHORT_EDGES;
  } else {
    appTheme.item.push({ $: { name: CUTOUT_STYLE_ITEM_NAME }, _: CUTOUT_SHORT_EDGES });
  }
  return styles;
}

/**
 * Expo config plugin configuring Android mobile PiP (`#266`) and `shortEdges` display cutout
 * mode (`#255`) while leaving Android TV / Fire TV manifests and styles completely untouched.
 */
export const withAndroidDisplay: ConfigPlugin<AndroidDisplayPluginOptions | undefined> = (
  config,
  props,
) => {
  const isTv = props?.isTv === true;
  if (isTv) return config;
  const withManifest = withAndroidManifest(config, (cfg) => {
    applyAndroidDisplayManifest(cfg.modResults, false);
    return cfg;
  });
  return withAndroidStyles(withManifest, (cfg) => {
    applyAndroidDisplayStyles(cfg.modResults, false);
    return cfg;
  });
};
