import type { LanPairingPort, LanPairingSession, LanPairingSourcePayload } from '@elv/features';
import {
  addLanPairingSubmissionListener,
  generateLanPairingToken,
  isLanPairingNativeAvailable,
  type LanPairingSubmissionEvent,
  type LanPairingSubscription,
  startLanPairingServer,
  stopLanPairingServer,
} from '@elv/lan-pairing';
import {
  isValidPairingToken,
  LAN_PAIRING_MAX_BODY_BYTES,
  LAN_PAIRING_MAX_FAILED_ATTEMPTS,
  LAN_PAIRING_TTL_MS,
  parseLanPairingPayload,
  renderLanPairingHtml,
} from '@elv/sources';

const TOKEN_BYTE_LENGTH = 24;

function generateSessionToken(): string {
  const nativeToken = generateLanPairingToken();
  if (nativeToken !== null && isValidPairingToken(nativeToken)) {
    return nativeToken;
  }

  const cryptoObj = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
    cryptoObj.getRandomValues(bytes);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) {
      hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
    }
    return hex;
  }

  throw new Error('Cryptographically secure random generator is unavailable for LAN pairing');
}

/**
 * Creates the mobile/TV {@link LanPairingPort} backed by `@elv/lan-pairing` (`#50`).
 * Generates a 192-bit single-use token, renders the self-contained pairing form, validates
 * incoming phone submissions via `parseLanPairingPayload`, and never logs raw bodies or secrets.
 */
export function createMobileLanPairingPort(): LanPairingPort {
  const listeners = new Set<(payload: LanPairingSourcePayload) => void>();
  let nativeSub: LanPairingSubscription | null = null;
  let sessionSeq = 0;

  const detachNativeSubscription = (): void => {
    if (nativeSub !== null) {
      const current = nativeSub;
      nativeSub = null;
      current.remove();
    }
  };

  const dispatchPayload = (payload: LanPairingSourcePayload): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(payload);
      } catch {
        // Isolate throwing subscribers without logging payload contents.
      }
    }
  };

  return {
    isSupported(): boolean {
      return isLanPairingNativeAvailable();
    },

    async startSession(opts?: { readonly locale?: 'en' | 'tr' }): Promise<LanPairingSession> {
      if (!isLanPairingNativeAvailable()) {
        throw new Error('LAN pairing is unavailable on this platform');
      }

      const mySeq = ++sessionSeq;
      const token = generateSessionToken();
      const locale = opts?.locale === 'tr' ? 'tr' : 'en';
      const html = renderLanPairingHtml({ token, locale });

      detachNativeSubscription();
      const sub = addLanPairingSubmissionListener((event: LanPairingSubmissionEvent) => {
        if (nativeSub !== sub || sessionSeq !== mySeq) return;
        const parsed = parseLanPairingPayload(event.body, event.contentType);
        if (!parsed.ok) return;
        detachNativeSubscription();
        void stopLanPairingServer().catch(() => undefined);
        dispatchPayload(parsed.value);
      });
      nativeSub = sub;

      try {
        const info = await startLanPairingServer({
          token,
          html,
          ttlMs: LAN_PAIRING_TTL_MS,
          maxBodyBytes: LAN_PAIRING_MAX_BODY_BYTES,
          maxFailedAttempts: LAN_PAIRING_MAX_FAILED_ATTEMPTS,
        });
        if (sessionSeq !== mySeq) {
          detachNativeSubscription();
          await stopLanPairingServer().catch(() => undefined);
          throw new Error('LAN pairing session was cancelled');
        }
        return {
          url: info.url,
          token,
          host: info.host,
          port: info.port,
          expiresAtMs: info.expiresAtMs,
        };
      } catch (error) {
        if (nativeSub === sub) {
          detachNativeSubscription();
        }
        throw error;
      }
    },

    async stopSession(): Promise<void> {
      sessionSeq += 1;
      detachNativeSubscription();
      await stopLanPairingServer();
    },

    onPayloadReceived(listener: (payload: LanPairingSourcePayload) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
