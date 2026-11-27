import type { ExpoConfig } from 'expo/config';
import type { AndroidConfig } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';
import {
  applyAndroidCameraFeatureManifest,
  withAndroidCameraFeature,
} from './with-android-camera-feature.ts';

type UsesFeatureEntry = NonNullable<
  AndroidConfig.Manifest.AndroidManifest['manifest']['uses-feature']
>[number];

function makeManifest(usesFeature?: UsesFeatureEntry[]): AndroidConfig.Manifest.AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      queries: [],
      ...(usesFeature !== undefined ? { 'uses-feature': usesFeature } : {}),
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [{ $: { 'android:name': '.MainActivity' } }],
        },
      ],
    },
  };
}

describe('withAndroidCameraFeature', () => {
  it('injects android.hardware.camera with required=false idempotently when isTv=false', () => {
    const manifest = makeManifest();
    applyAndroidCameraFeatureManifest(manifest, false);
    applyAndroidCameraFeatureManifest(manifest, false);

    const features = manifest.manifest['uses-feature'] ?? [];
    const cameraFeatures = features.filter(
      (entry) => entry.$?.['android:name'] === 'android.hardware.camera',
    );
    expect(cameraFeatures).toHaveLength(1);
    expect(cameraFeatures[0]?.$['android:required']).toBe('false');
  });

  it('normalizes an existing android.hardware.camera uses-feature entry to required=false', () => {
    const manifest = makeManifest([
      { $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' } },
      { $: { 'android:name': 'android.hardware.touchscreen', 'android:required': 'false' } },
    ]);
    applyAndroidCameraFeatureManifest(manifest, false);

    const features = manifest.manifest['uses-feature'] ?? [];
    expect(features).toHaveLength(2);
    expect(features[0]?.$).toEqual({
      'android:name': 'android.hardware.camera',
      'android:required': 'false',
    });
  });

  it('leaves AndroidManifest and config untouched when isTv=true', () => {
    const manifest = makeManifest();
    applyAndroidCameraFeatureManifest(manifest, true);
    expect(manifest.manifest['uses-feature']).toBeUndefined();

    const tvConfig: ExpoConfig = { name: 'ELV IPTV', slug: 'elv-iptv' };
    const tvResult = withAndroidCameraFeature(tvConfig, { isTv: true }) as ExpoConfig & {
      mods?: { android?: { manifest?: unknown } };
    };
    expect(tvResult.mods).toBeUndefined();

    const mobileConfig: ExpoConfig = { name: 'ELV IPTV', slug: 'elv-iptv' };
    const mobileResult = withAndroidCameraFeature(mobileConfig, { isTv: false }) as ExpoConfig & {
      mods?: { android?: { manifest?: unknown } };
    };
    expect(mobileResult.mods?.android?.manifest).toBeDefined();
  });
});
