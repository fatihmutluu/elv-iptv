import { type ConfigPlugin, type InfoPlist, withInfoPlist } from 'expo/config-plugins';

/** Options for {@link withIosExternalDisplay}. */
export interface IosExternalDisplayPluginOptions {
  /** True when building for tvOS (`EXPO_TV=1`); skips `UIApplicationSceneManifest` injection. */
  readonly isTv?: boolean;
}

/** Objective-C runtime class name of the primary iOS/iPadOS `UIWindowSceneDelegate` bridging Expo `AppDelegate` (`#258`). */
export const IOS_PRIMARY_SCENE_DELEGATE_CLASS = 'AetherPrimaryWindowSceneDelegate';

/** Objective-C runtime class name of the dedicated non-interactive external display `UIWindowSceneDelegate` (`#258`). */
export const IOS_EXTERNAL_DISPLAY_SCENE_DELEGATE_CLASS = 'AetherExternalDisplaySceneDelegate';

const PRIMARY_SCENE_ROLE = 'UIWindowSceneSessionRoleApplication';
const EXTERNAL_DISPLAY_SCENE_ROLE = 'UIWindowSceneSessionRoleExternalDisplayNonInteractive';
const PRIMARY_SCENE_CONFIG_NAME = 'Default Configuration';
const EXTERNAL_DISPLAY_SCENE_CONFIG_NAME = 'External Display Configuration';

type SceneConfigEntry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Adds `UIApplicationSceneManifest` declaring both `UIWindowSceneSessionRoleApplication`
 * (`AetherPrimaryWindowSceneDelegate`) and `UIWindowSceneSessionRoleExternalDisplayNonInteractive`
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

  upsertSceneRoleEntry(
    existingConfigurations,
    PRIMARY_SCENE_ROLE,
    PRIMARY_SCENE_CONFIG_NAME,
    IOS_PRIMARY_SCENE_DELEGATE_CLASS,
  );
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
