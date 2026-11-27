import { type ConfigPlugin, type InfoPlist, withInfoPlist } from 'expo/config-plugins';

/** Options for {@link withIosExternalDisplay}. */
export interface IosExternalDisplayPluginOptions {
  /** True when building for tvOS (`EXPO_TV=1`); skips `UIApplicationSceneManifest` injection. */
  readonly isTv?: boolean;
}

/**
 * Default Expo SDK 58+ primary `UIWindowSceneDelegate` (`SceneDelegate.swift`, subclassing `ExpoAppSceneDelegate`).
 * `AppDelegate` no longer creates `window` or starts React Native under the iOS 27 scene-based life cycle, so the
 * primary `UIWindowSceneSessionRoleApplication` entry MUST keep Expo's `SceneDelegate` (`#258`).
 */
export const IOS_PRIMARY_SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';

/** Objective-C runtime class name of the dedicated non-interactive external display `UIWindowSceneDelegate` (`#258`). */
export const IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS = 'AetherExternalDisplaySceneDelegate';

const LEGACY_PRIMARY_SCENE_DELEGATE_CLASS = 'AetherPrimaryWindowSceneDelegate';
const PRIMARY_SCENE_ROLE = 'UIWindowSceneSessionRoleApplication';
const EXTERNAL_DISPLAY_SCENE_ROLE = 'UIWindowSceneSessionRoleExternalDisplayNonInteractive';
const PRIMARY_SCENE_CONFIG_NAME = 'Default Configuration';
const EXTERNAL_DISPLAY_SCENE_CONFIG_NAME = 'External Display Configuration';

type SceneConfigEntry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyDelegateClassName(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    typeof entry.UISceneDelegateClassName === 'string' &&
    entry.UISceneDelegateClassName.trim().length > 0
  );
}

function ensurePrimarySceneRoleEntry(configurations: Record<string, unknown>): void {
  const existingList = Array.isArray(configurations[PRIMARY_SCENE_ROLE])
    ? configurations[PRIMARY_SCENE_ROLE]
    : [];
  const repaired: unknown[] = existingList.map((item) => {
    if (isRecord(item) && item.UISceneDelegateClassName === LEGACY_PRIMARY_SCENE_DELEGATE_CLASS) {
      return {
        ...item,
        UISceneDelegateClassName: IOS_PRIMARY_SCENE_DELEGATE_CLASS,
      };
    }
    return item;
  });

  if (repaired.some(hasNonEmptyDelegateClassName)) {
    configurations[PRIMARY_SCENE_ROLE] = repaired;
    return;
  }

  configurations[PRIMARY_SCENE_ROLE] = [
    ...repaired,
    {
      UISceneConfigurationName: PRIMARY_SCENE_CONFIG_NAME,
      UISceneDelegateClassName: IOS_PRIMARY_SCENE_DELEGATE_CLASS,
    },
  ];
}

function upsertSceneRoleEntry(
  configurations: Record<string, unknown>,
  role: string,
  configName: string,
  delegateClassName: string,
): void {
  const existingList = Array.isArray(configurations[role]) ? configurations[role] : [];
  const nextEntry: SceneConfigEntry = {
    UISceneConfigurationName: configName,
    UISceneDelegateClassName: delegateClassName,
  };
  let replaced = false;
  const updated: unknown[] = existingList.map((item) => {
    if (
      isRecord(item) &&
      (item.UISceneConfigurationName === configName ||
        item.UISceneDelegateClassName === delegateClassName)
    ) {
      replaced = true;
      return { ...item, ...nextEntry };
    }
    return item;
  });
  if (!replaced) {
    updated.push(nextEntry);
  }
  configurations[role] = updated;
}

/**
 * Ensures `UIApplicationSceneManifest` preserves Expo's primary `UIWindowSceneSessionRoleApplication`
 * (`$(PRODUCT_MODULE_NAME).SceneDelegate`) while adding `UIWindowSceneSessionRoleExternalDisplayNonInteractive`
 * (`AetherExternalDisplaySceneDelegate`) to `Info.plist` for non-TV iOS/iPadOS builds (`#258`).
 */
export function applyIosExternalDisplayInfoPlist(infoPlist: InfoPlist, isTv: boolean): InfoPlist {
  if (isTv) return infoPlist;
  const existingManifest = isRecord(infoPlist.UIApplicationSceneManifest)
    ? { ...infoPlist.UIApplicationSceneManifest }
    : {};
  const existingConfigurations = isRecord(existingManifest.UISceneConfigurations)
    ? { ...existingManifest.UISceneConfigurations }
    : {};

  ensurePrimarySceneRoleEntry(existingConfigurations);
  upsertSceneRoleEntry(
    existingConfigurations,
    EXTERNAL_DISPLAY_SCENE_ROLE,
    EXTERNAL_DISPLAY_SCENE_CONFIG_NAME,
    IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS,
  );

  infoPlist.UIApplicationSceneManifest = {
    ...existingManifest,
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: existingConfigurations,
  };
  return infoPlist;
}

/**
 * Expo config plugin wiring iOS/iPadOS dedicated external `UIWindowScene` video output (`#258`)
 * while leaving tvOS builds completely untouched.
 */
export const withIosExternalDisplay: ConfigPlugin<IosExternalDisplayPluginOptions | undefined> = (
  config,
  props,
) => {
  const isTv = props?.isTv === true;
  if (isTv) return config;
  return withInfoPlist(config, (cfg) => {
    applyIosExternalDisplayInfoPlist(cfg.modResults, false);
    return cfg;
  });
};
