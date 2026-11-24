/** Validated IPTV source payload submitted by a phone during local LAN QR pairing (`#50`). */
export type LanPairingSourcePayload =
  | {
      readonly kind: 'm3u';
      readonly name: string;
      readonly url: string;
      readonly guideUrl?: string;
    }
  | {
      readonly kind: 'xtream';
      readonly name: string;
      readonly server: string;
      readonly username: string;
      readonly password: string;
      readonly guideUrl?: string;
    };

/** Active ephemeral LAN pairing session metadata returned by the host listener (`#50`). */
export interface LanPairingSession {
  readonly url: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly expiresAtMs: number;
}

/**
 * Platform port for starting and stopping the local LAN pairing HTTP endpoint (`#50`).
 * Implemented in Electron main process (`apps/desktop`) and via `@elv/lan-pairing` (`apps/tv-mobile`).
 */
export interface LanPairingPort {
  /** Whether this host platform supports running a local LAN pairing endpoint. */
  isSupported(): boolean;
  /** Starts an ephemeral single-use LAN pairing session and returns the QR URL & expiry. */
  startSession(opts?: { readonly locale?: 'en' | 'tr' }): Promise<LanPairingSession>;
  /** Stops any active pairing listener immediately. */
  stopSession(): Promise<void>;
  /** Subscribes to validated source payloads submitted from a paired phone. */
  onPayloadReceived(listener: (payload: LanPairingSourcePayload) => void): () => void;
}
