import type { ExpoConfig } from 'expo/config';
import type { InfoPlist } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';
import {
  applyIosExternalDisplayInfoPlist,
  IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS,
  IOS_PRIMARY_SCENE_DELEGATE_CLASS,
  withIosExternalDisplay,
} from './with-ios-external-display.ts';

describe('withIosExternalDisplay (#258)', () => {
  it('injects UIApplicationSceneManifest with both primary and external display scene roles when isTv=false', () => {
    const plist: InfoPlist = {
      ITSAppUsesNonExemptEncryption: false,
    };

    applyIosExternalDisplayInfoPlist(plist, false);
    applyIosExternalDisplayInfoPlist(plist, false); // idempotent

    expect(plist.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(plist.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: IOS_PRIMARY_SCENE_DELEGATE_CLASS,
          },
        ],
        UIWindowSceneSessionRoleExternalDisplayNonInteractive: [
          {
            UISceneConfigurationName: 'External Display Configuration',
            UISceneDelegateClassName: IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS,
          },
        ],
      },
    });
    expect(IOS_PRIMARY_SCENE_DELEGATE_CLASS).toBe('AetherPrimaryWindowSceneDelegate');
    expect(IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS).toBe('AetherExternalDisplaySceneDelegate');
  });

  it('preserves unrelated scene manifest entries without duplicating ELV scene configurations', () => {
    const plist: InfoPlist = {
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: true,
        UISceneConfigurations: {
          CPTemplateApplicationSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'CarPlay',
              UISceneDelegateClassName: 'CarPlaySceneDelegate',
            },
          ],
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: 'LegacySceneDelegate',
            },
          ],
        },
      },
    };

    applyIosExternalDisplayInfoPlist(plist, false);

    const manifest = plist.UIApplicationSceneManifest as Record<string, unknown>;
    const configs = manifest.UISceneConfigurations as Record<string, unknown[]>;
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(false);
    expect(configs.CPTemplateApplicationSceneSessionRoleApplication).toEqual([
      {
        UISceneConfigurationName: 'CarPlay',
        UISceneDelegateClassName: 'CarPlaySceneDelegate',
      },
    ]);
    expect(configs.UIWindowSceneSessionRoleApplication).toEqual([
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: 'AetherPrimaryWindowSceneDelegate',
      },
    ]);
    expect(configs.UIWindowSceneSessionRoleExternalDisplayNonInteractive).toEqual([
      {
        UISceneConfigurationName: 'External Display Configuration',
        UISceneDelegateClassName: 'AetherExternalDisplaySceneDelegate',
      },
    ]);
  });

  it('leaves UIApplicationSceneManifest absent and config untouched when isTv=true', () => {
    const plist: InfoPlist = {
      ITSAppUsesNonExemptEncryption: false,
    };

    applyIosExternalDisplayInfoPlist(plist, true);
    expect(plist).not.toHaveProperty('UIApplicationSceneManifest');

    const tvConfig: ExpoConfig = { name: 'ELV IPTV', slug: 'elv-iptv' };
    const tvResult = withIosExternalDisplay(tvConfig, { isTv: true }) as ExpoConfig & {
      mods?: { ios?: { infoPlist?: unknown } };
    };
    expect(tvResult.mods).toBeUndefined();

    const iosConfig: ExpoConfig = { name: 'ELV IPTV', slug: 'elv-iptv' };
    const iosResult = withIosExternalDisplay(iosConfig, { isTv: false }) as ExpoConfig & {
      mods?: { ios?: { infoPlist?: unknown } };
    };
    expect(iosResult.mods?.ios?.infoPlist).toBeDefined();
  });
});
