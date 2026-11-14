import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Linking, Platform, Settings } from 'react-native';
import { type GateParams, parseGateUrl } from './routes';

/** `NSUserDefaults` key of the launch argument `-gateUrl <url>` (`xcrun simctl launch <udid> <bundle id> -gateUrl …`). */
const LAUNCH_ARGUMENT = 'gateUrl';

/** Whether this build carries the gate flag (`extra.gate`, set only for the development variant). */
function isGateBuild(): boolean {
  return Constants.expoConfig?.extra?.gate === true;
}

/**
 * The `-gateUrl` launch argument on iOS and tvOS, where launch arguments land in `NSUserDefaults`. A launch skips the
 * confirmation prompt that `simctl openurl` shows on tvOS. `null` elsewhere or when the settings module is missing.
 */
function launchArgumentUrl(): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const value: unknown = Settings.get(LAUNCH_ARGUMENT);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The gate parameters from the `-gateUrl` launch argument (iOS, tvOS), else from the URL that opened the app, or from a
 * URL that arrived later; `undefined` when there is none. Always `undefined` (nothing is read and no listener is added)
 * unless the build carries the gate flag.
 */
export function useGateParams(): GateParams | undefined {
  const [params, setParams] = useState<GateParams | undefined>(() =>
    isGateBuild() ? parseGateUrl(launchArgumentUrl()) : undefined,
  );
  useEffect(() => {
    if (!isGateBuild()) return;
    let alive = true;
    void Linking.getInitialURL().then((url) => {
      const parsed = parseGateUrl(url ?? null);
      if (alive && parsed !== undefined) setParams((current) => current ?? parsed);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => {
      const parsed = parseGateUrl(url);
      if (parsed !== undefined) setParams(parsed);
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return params;
}
