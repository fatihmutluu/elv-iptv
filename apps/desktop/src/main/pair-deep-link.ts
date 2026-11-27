import { parsePairingQrOrCode } from '@elv/sync';

/**
 * Validates that `raw` is a well-formed bidirectional pairing QR deep-link URI
 * (`elviptv://pair?c=...&pk=...` or `https://<host>/pair?c=...&pk=...`, `#510`).
 */
export function isValidPairDeepLinkUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  const parsed = parsePairingQrOrCode(trimmed);
  return parsed.ok && parsed.value.kind === 'qr';
}

/** Extracts the first valid pairing deep-link URI from process/second-instance `argv`. */
export function extractPairDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (isValidPairDeepLinkUrl(arg)) return arg.trim();
  }
  return null;
}

/** Pending pairing deep-link queue delivered to the renderer on startup or live `open-url`/`second-instance`. */
export interface PendingPairDeepLinkQueue {
  enqueue(rawUrl: string): boolean;
  consume(): string | null;
  subscribe(listener: (uri: string) => void): () => void;
}

/** Creates an in-memory queue bridging Electron OS deep links to the renderer pairing flow. */
export function createPendingPairDeepLinkQueue(): PendingPairDeepLinkQueue {
  let pending: string | null = null;
  const listeners = new Set<(uri: string) => void>();

  return {
    enqueue(rawUrl: string): boolean {
      if (!isValidPairDeepLinkUrl(rawUrl)) return false;
      const uri = rawUrl.trim();
      if (listeners.size > 0) {
        for (const listener of [...listeners]) {
          try {
            listener(uri);
          } catch {
            // Isolate listener failures.
          }
        }
        return true;
      }
      pending = uri;
      return true;
    },

    consume(): string | null {
      const value = pending;
      pending = null;
      return value;
    },

    subscribe(listener: (uri: string) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
