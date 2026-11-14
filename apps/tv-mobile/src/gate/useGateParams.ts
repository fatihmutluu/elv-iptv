import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Linking, Platform, Settings } from 'react-native';
import { type ImportParams, parseImportUrl } from './import/route';
import { type GateParams, parseGateUrl } from './routes';

/** A gate screen and its parameters. */
export type GateRoute =
  | { name: 'list'; params: GateParams }
  | { name: 'import'; params: ImportParams };

function parseRoute(url: string | null): GateRoute | undefined {
  const list = parseGateUrl(url);
  if (list !== undefined) return { name: 'list', params: list };
  const imported = parseImportUrl(url);
  return imported === undefined ? undefined : { name: 'import', params: imported };
}

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
 * The gate route from the `-gateUrl` launch argument (iOS, tvOS), else from the URL that opened the app, or from a
 * URL that arrived later; `undefined` when there is none. Always `undefined` (nothing is read and no listener is added)
 * unless the build carries the gate flag.
 */
export function useGateRoute(): GateRoute | undefined {
  const [params, setParams] = useState<GateRoute | undefined>(() =>
    isGateBuild() ? parseRoute(launchArgumentUrl()) : undefined,
  );
  useEffect(() => {
    if (!isGateBuild()) return;
    let alive = true;
    void Linking.getInitialURL().then((url) => {
      const parsed = parseRoute(url ?? null);
      if (alive && parsed !== undefined) setParams((current) => current ?? parsed);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => {
      const parsed = parseRoute(url);
      if (parsed !== undefined) setParams(parsed);
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return params;
}
