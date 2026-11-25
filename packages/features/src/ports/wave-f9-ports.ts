/**
 * Wave F9 feature ports for E2EE Sync Account & Universal QR Pairing (`#26`),
 * opt-in runtime telemetry (`#458`), and Settings feedback submission (`#458`).
 * Structural types keep `@elv/features` decoupled from app-specific crypto/storage adapters.
 */

/** Lifecycle state of the optional E2EE sync account session (`#26`). */
export type SyncAccountStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'syncing';

/** Read-only snapshot of the current E2EE sync account state (`#26`). */
export interface SyncAccountState {
  readonly status: SyncAccountStatus;
  readonly email: string | null;
  readonly lastSyncedAtIso: string | null;
  readonly pendingRecoveryCode: string | null;
  readonly errorCode: string | null;
}

/** Active universal QR device pairing session (`#26`, payload strictly <= 213 UTF-8 bytes). */
export interface SyncQrPairingSession {
  readonly pairingId: string;
  readonly code: string;
  readonly qrUri: string;
  readonly expiresAtMs: number;
  readonly status: 'pending' | 'claimed' | 'expired';
}

/** Result of an auth, sync, pairing, or permanent account deletion call (`#26`). */
export interface SyncActionResult {
  readonly ok: boolean;
  readonly recoveryCode?: string;
  readonly errorCode?: string;
}

/** App-supplied E2EE sync, authentication, universal QR pairing, and permanent deletion port (`#26`). */
export interface SyncAccountPort {
  getState(): SyncAccountState;
  subscribe(listener: (state: SyncAccountState) => void): () => void;
  signIn(email: string, password: string): Promise<SyncActionResult>;
  register(email: string, password: string, confirmPassword: string): Promise<SyncActionResult>;
  acknowledgeRecoveryCode(): void;
  syncNow(): Promise<SyncActionResult>;
  signOut(): Promise<void>;
  /** Permanently erases server-side account, vault, and sessions (Apple 5.1.1(v) / Google Play). */
  deleteAccount(password: string): Promise<SyncActionResult>;
  createQrPairing(): Promise<SyncQrPairingSession>;
  pollQrPairing(pairingId: string): Promise<'pending' | 'claimed' | 'expired'>;
  claimQrPairing(codeOrUri: string): Promise<SyncActionResult>;
}

/** Structured, strictly redacted media decode failure metadata for `#458` / `#70` telemetry. */
export interface TelemetryMediaDecodeFailure {
  readonly engine: string;
  readonly container?: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly errorCode: string;
  readonly hdrFormat?: string;
  readonly isLive: boolean;
}

/** App-supplied opt-in runtime performance, stability, and codec telemetry port (`#458`). */
export interface TelemetryPort {
  isOptedIn(): boolean;
  setOptIn(enabled: boolean): void;
  queuedCount(): number;
  getPayloadPreviewJson(): string;
  recordScreenTransition(screen: string, durationMs: number): void;
  recordMediaDecodeFailure(meta: TelemetryMediaDecodeFailure): void;
  recordPlaybackError(meta: {
    readonly engine: string;
    readonly errorCode: string;
    readonly isLive: boolean;
  }): void;
  flush(): Promise<void>;
}

/** Allowed user feedback categories in Settings (`#458`). */
export type FeedbackCategoryId =
  | 'playback_issue'
  | 'channel_epg'
  | 'ui_remote'
  | 'sync_account'
  | 'feature_request'
  | 'other';

/** Feedback submission payload from Settings (`#458`). */
export interface FeedbackSubmitInput {
  readonly category: FeedbackCategoryId;
  readonly message: string;
  readonly includeDiagnostics: boolean;
}

/** App-supplied feedback submission port (`#458`). */
export interface FeedbackPort {
  submit(input: FeedbackSubmitInput): Promise<{
    readonly ok: boolean;
    readonly id?: string;
    readonly errorCode?: string;
  }>;
}
