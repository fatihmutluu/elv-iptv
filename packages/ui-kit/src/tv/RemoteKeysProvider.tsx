import { createContext, type ReactElement, type ReactNode } from 'react';
import type { AndroidKeySource } from './android-keys';

/** The injected raw Android key source, or `null` when the app has none. */
export const RemoteKeysContext = createContext<AndroidKeySource | null>(null);

/**
 * Supplies the raw Android remote key source to `useTvKeySource`. The composition root passes the native module's
 * source on Android; `null` (or no provider) keeps the `TVEventHandler` path. Ignored on tvOS.
 */
export function RemoteKeysProvider(props: {
  android: AndroidKeySource | null;
  children: ReactNode;
}): ReactElement {
  return (
    <RemoteKeysContext.Provider value={props.android}>{props.children}</RemoteKeysContext.Provider>
  );
}
