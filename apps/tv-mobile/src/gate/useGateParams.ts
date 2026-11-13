import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { type GateParams, parseGateUrl } from './routes';

/** Whether this build carries the gate flag (`extra.gate`, set only for the development variant). */
function isGateBuild(): boolean {
  return Constants.expoConfig?.extra?.gate === true;
}

/**
 * The gate parameters from the URL that opened the app or arrived later, or `undefined`. Always `undefined` (and no
 * listener is added) unless the build carries the gate flag.
 */
export function useGateParams(): GateParams | undefined {
  const [params, setParams] = useState<GateParams | undefined>(undefined);
  useEffect(() => {
    if (!isGateBuild()) return;
    let alive = true;
    void Linking.getInitialURL().then((url) => {
      const parsed = parseGateUrl(url ?? null);
      if (alive && parsed !== undefined) setParams(parsed);
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
