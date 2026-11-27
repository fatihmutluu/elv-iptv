import { parsePairingQrOrCode } from '@elv/sync';
import { useCallback, useEffect, useState } from 'react';
import { Linking } from 'react-native';

/** Pending pairing deep-link state exposed by {@link usePairDeepLink}. */
export interface PairDeepLinkState {
  readonly pendingPairUri: string | null;
  readonly clearPendingPairUri: () => void;
}

/**
 * Validates an incoming OS deep link (`elviptv://pair?c=...&pk=...` or `https://<host>/pair?c=...&pk=...`)
 * using `@elv/sync`'s strict parser (`#510`). Returns the trimmed URI or `null` when unrelated/invalid.
 */
export function parseIncomingPairDeepLink(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = parsePairingQrOrCode(trimmed);
  return parsed.ok && parsed.value.kind === 'qr' ? trimmed : null;
}

/**
 * Listens for bidirectional pairing deep links (`elviptv://pair?...` and Universal/App Links
 * `https://<host>/pair?...`) via `Linking.getInitialURL()` and `Linking.addEventListener('url', ...)`.
 */
export function usePairDeepLink(): PairDeepLinkState {
  const [pendingPairUri, setPendingPairUri] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let receivedRuntimeEvent = false;

    void Linking.getInitialURL().then(
      (url) => {
        if (!alive || receivedRuntimeEvent) return;
        const valid = parseIncomingPairDeepLink(url);
        if (valid !== null) {
          setPendingPairUri((current) => current ?? valid);
        }
      },
      () => undefined,
    );

    const subscription = Linking.addEventListener('url', ({ url }) => {
      const valid = parseIncomingPairDeepLink(url);
      if (valid !== null) {
        receivedRuntimeEvent = true;
        setPendingPairUri(valid);
      }
    });

    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  const clearPendingPairUri = useCallback(() => {
    setPendingPairUri(null);
  }, []);

  return { pendingPairUri, clearPendingPairUri };
}
