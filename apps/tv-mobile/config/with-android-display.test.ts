import type { ExpoConfig } from 'expo/config';
import type { AndroidConfig } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';
import {
  applyAndroidDisplayManifest,
  applyAndroidDisplayStyles,
  withAndroidDisplay,
} from './with-android-display.ts';

function makeManifest(configChanges?: string): AndroidConfig.Manifest.AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      queries: [],
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [
            {
              $: {
                'android:name': '.MainActivity',
                ...(configChanges !== undefined ? { 'android:configChanges': configChanges } : {}),
              },
            },
          ],
        },
      ],
    },
  };
}

function makeStyles(
  existingItems: Array<{ $: { name: string }; _: string }> = [],
): AndroidConfig.Resources.ResourceXML {
  return {
    resources: {
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
          item: existingItems,
        },
      ],
    },
  };
}

describe('withAndroidDisplay (#255, #266)', () => {
  it('enables PiP, merges smallestScreenSize|screenLayout, and sets shortEdges cutout mode when isTv=false', () => {
    const manifest = makeManifest('keyboard|keyboardHidden|orientation|screenSize|uiMode');
    applyAndroidDisplayManifest(manifest, false);
    applyAndroidDisplayManifest(manifest, false); // idempotent

    const mainActivity = manifest.manifest.application?.[0]?.activity?.[0];
    expect(mainActivity?.$['android:supportsPictureInPicture']).toBe('true');
    const tokens = (mainActivity?.$['android:configChanges'] ?? '').split('|');
    expect(tokens).toEqual([
      'keyboard',
      'keyboardHidden',
      'orientation',
      'screenSize',
      'uiMode',
      'smallestScreenSize',
      'screenLayout',
    ]);

    const styles = makeStyles([{ $: { name: 'android:enforceNavigationBarContrast' }, _: 'true' }]);
    applyAndroidDisplayStyles(styles, false);
    applyAndroidDisplayStyles(styles, false); // idempotent

    const appTheme = styles.resources.style?.[0];
    const cutoutItems = (appTheme?.item ?? []).filter(
      (item) => item.$.name === 'android:windowLayoutInDisplayCutoutMode',
    );
    expect(cutoutItems).toHaveLength(1);
    expect(cutoutItems[0]?._).toBe('shortEdges');
  });

  it('overwrites an existing cutout mode item to shortEdges and handles missing configChanges', () => {
    const manifest = makeManifest();
    applyAndroidDisplayManifest(manifest, false);
    const mainActivity = manifest.manifest.application?.[0]?.activity?.[0];
    expect(mainActivity?.$['android:configChanges']).toBe('smallestScreenSize|screenLayout');

    const styles = makeStyles([
      { $: { name: 'android:windowLayoutInDisplayCutoutMode' }, _: 'default' },
    ]);
    applyAndroidDisplayStyles(styles, false);
    const cutoutItems = (styles.resources.style?.[0]?.item ?? []).filter(
      (item) => item.$.name === 'android:windowLayoutInDisplayCutoutMode',
    );
    expect(cutoutItems).toHaveLength(1);
    expect(cutoutItems[0]?._).toBe('shortEdges');
  });

  it('makes NO PiP or cutout modifications when isTv=true', () => {
    const manifest = makeManifest('keyboard|orientation|screenSize');
    applyAndroidDisplayManifest(manifest, true);
    const mainActivity = manifest.manifest.application?.[0]?.activity?.[0];
    expect(mainActivity?.$['android:supportsPictureInPicture']).toBeUndefined();
    expect(mainActivity?.$['android:configChanges']).toBe('keyboard|orientation|screenSize');

    const styles = makeStyles();
    applyAndroidDisplayStyles(styles, true);
    expect(styles.resources.style?.[0]?.item ?? []).toEqual([]);

    const tvConfig: ExpoConfig = { name: 'ELV IPTV', slug: 'elv-iptv' };
    const tvResult = withAndroidDisplay(tvConfig, { isTv: true }) as ExpoConfig & {
      mods?: { android?: { manifest?: unknown; styles?: unknown } };
    };
    expect(tvResult.mods).toBeUndefined();

    const mobileConfig: ExpoConfig = { name: 'ELV IPTV', slug: 'elv-iptv' };
    const mobileResult = withAndroidDisplay(mobileConfig, { isTv: false }) as ExpoConfig & {
      mods?: { android?: { manifest?: unknown; styles?: unknown } };
    };
    expect(mobileResult.mods?.android?.manifest).toBeDefined();
    expect(mobileResult.mods?.android?.styles).toBeDefined();
  });
});
