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
  it('injects UIApplicationSceneManifest with Expo SceneDelegate fallback and external display role when manifest is absent', () => {
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
    expect(IOS_PRIMARY_SCENE_DELEGATE_CLASS).toBe('$(PRODUCT_MODULE_NAME).SceneDelegate');
    expect(IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS).toBe('AetherExternalDisplaySceneDelegate');
  });

  it('preserves Expo SDK 58 SceneDelegate and unrelated scene manifest entries without overwriting primary scene', () => {
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
              UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
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
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ]);
    expect(configs.UIWindowSceneSessionRoleExternalDisplayNonInteractive).toEqual([
      {
        UISceneConfigurationName: 'External Display Configuration',
        UISceneDelegateClassName: 'AetherExternalDisplaySceneDelegate',
      },
    ]);
  });

  it('preserves custom primary scene delegates while repairing legacy AetherPrimaryWindowSceneDelegate entries', () => {
    const customPlist: InfoPlist = {
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Custom Main',
              UISceneDelegateClassName: 'CustomAppSceneDelegate',
            },
          ],
        },
      },
    };
    applyIosExternalDisplayInfoPlist(customPlist, false);
    const customConfigs = (customPlist.UIApplicationSceneManifest as Record<string, unknown>)
      .UISceneConfigurations as Record<string, unknown[]>;
    expect(customConfigs.UIWindowSceneSessionRoleApplication).toEqual([
      {
        UISceneConfigurationName: 'Custom Main',
        UISceneDelegateClassName: 'CustomAppSceneDelegate',
      },
    ]);

    const legacyPlist: InfoPlist = {
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: 'AetherPrimaryWindowSceneDelegate',
            },
          ],
        },
      },
    };
    applyIosExternalDisplayInfoPlist(legacyPlist, false);
    const legacyConfigs = (legacyPlist.UIApplicationSceneManifest as Record<string, unknown>)
      .UISceneConfigurations as Record<string, unknown[]>;
    expect(legacyConfigs.UIWindowSceneSessionRoleApplication).toEqual([
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
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
