import { type PlayDeepLinkTarget, parsePlayDeepLink } from '@elv/features';
import { useCallback, useEffect, useState } from 'react';
import { Linking } from 'react-native';

/** Pending production `elviptv://play` deep-link state exposed by {@link usePlayDeepLink}. */
export interface PlayDeepLinkState {
  readonly pendingDeepLink: PlayDeepLinkTarget | null;
  readonly clearPendingDeepLink: () => void;
}

/**
 * Listens for production `elviptv://play?key=...` deep links from Android TV Home Screen
 * preview channels (`#273`) via `Linking.getInitialURL()` and `Linking.addEventListener('url', ...)`.
 * Strictly parses incoming URLs through {@link parsePlayDeepLink} and ignores non-play links.
 */
export function usePlayDeepLink(): PlayDeepLinkState {
  const [pendingDeepLink, setPendingDeepLink] = useState<PlayDeepLinkTarget | null>(null);

  useEffect(() => {
    let alive = true;
    let receivedRuntimeEvent = false;

    void Linking.getInitialURL().then(
      (url) => {
        if (!alive || receivedRuntimeEvent) return;
        const parsed = parsePlayDeepLink(url);
        if (parsed !== null) {
          setPendingDeepLink((current) => current ?? parsed);
        }
      },
      () => undefined,
    );

    const subscription = Linking.addEventListener('url', ({ url }) => {
      const parsed = parsePlayDeepLink(url);
      if (parsed !== null) {
        receivedRuntimeEvent = true;
        setPendingDeepLink(parsed);
      }
    });

    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  const clearPendingDeepLink = useCallback(() => {
    setPendingDeepLink(null);
  }, []);

  return { pendingDeepLink, clearPendingDeepLink };
}
