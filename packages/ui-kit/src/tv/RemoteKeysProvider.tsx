import { createContext, type ReactElement, type ReactNode } from 'react';
import type { AndroidKeySource } from './android-keys';

/** The injected raw native key source (Android TV / tvOS), or `null` when the app has none. */
export const RemoteKeysContext = createContext<AndroidKeySource | null>(null);

/**
 * Supplies the raw native remote key source (`ElvRemoteKeys`) to `useTvKeySource` on Android TV and tvOS.
 * The composition root passes the native module's source via the `android` prop (kept backwards-compatible for
 * existing callers); `null` (or no provider) keeps the `TVEventHandler` fallback path.
 */
export function RemoteKeysProvider(props: {
  android: AndroidKeySource | null;
  children: ReactNode;
}): ReactElement {
  return (
    <RemoteKeysContext.Provider value={props.android}>{props.children}</RemoteKeysContext.Provider>
  );
}
