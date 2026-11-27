import { type AndroidConfig, type ConfigPlugin, withAndroidManifest } from 'expo/config-plugins';

/** Options for {@link withAndroidCameraFeature}. */
export interface AndroidCameraFeaturePluginOptions {
  /** True when building for Android TV / Fire TV (`EXPO_TV=1`); skips camera feature injection. */
  readonly isTv?: boolean;
}

const CAMERA_HARDWARE_FEATURE = 'android.hardware.camera';

/**
 * Declares `<uses-feature android:name="android.hardware.camera" android:required="false" />`
 * idempotently in `AndroidManifest.xml` for non-TV Android builds so tablets and Chromebooks
 * without a camera remain eligible on app stores (`#510`).
 */
export function applyAndroidCameraFeatureManifest(
  manifest: AndroidConfig.Manifest.AndroidManifest,
  isTv: boolean,
): AndroidConfig.Manifest.AndroidManifest {
  if (isTv) return manifest;
  const features = manifest.manifest['uses-feature'] ?? [];
  const existing = features.find((entry) => entry.$?.['android:name'] === CAMERA_HARDWARE_FEATURE);
  if (existing !== undefined) {
    existing.$['android:required'] = 'false';
  } else {
    features.push({
      $: {
        'android:name': CAMERA_HARDWARE_FEATURE,
        'android:required': 'false',
      },
    });
  }
  manifest.manifest['uses-feature'] = features;
  return manifest;
}

/**
 * Expo config plugin marking `android.hardware.camera` optional (`required="false"`) on handheld
 * Android builds while leaving Android TV / Fire OS manifests untouched (`#510`).
 */
export const withAndroidCameraFeature: ConfigPlugin<
  AndroidCameraFeaturePluginOptions | undefined
> = (config, props) => {
  const isTv = props?.isTv === true;
  if (isTv) return config;
  return withAndroidManifest(config, (cfg) => {
    applyAndroidCameraFeatureManifest(cfg.modResults, false);
    return cfg;
  });
};
