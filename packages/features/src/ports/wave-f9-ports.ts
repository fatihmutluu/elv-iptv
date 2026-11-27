/**
 * Wave F9 & Wave P9 feature ports for E2EE Sync Account, Automatic Background Sync,
 * Bidirectional X25519 QR/8-Digit Pairing (`#26`, `#510`), Unified Diagnostics &
 * Performance Telemetry (`#458`, `#509`), and Settings feedback submission (`#458`).
 * Structural types keep `@elv/features` decoupled from app-specific crypto/storage adapters.
 */

/** Lifecycle state of the optional E2EE sync account session (`#26`, `#510`). */
export type SyncAccountStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'syncing';

/** Background automatic sync indicator state (`#510`). */
export type AutoSyncState = 'idle' | 'syncing' | 'pending' | 'offline';

/** Read-only snapshot of the current E2EE sync account state (`#26`, `#510`). */
export interface SyncAccountState {
  readonly status: SyncAccountStatus;
  readonly email: string | null;
  readonly lastSyncedAtIso: string | null;
  readonly pendingRecoveryCode: string | null;
  readonly errorCode: string | null;
  readonly autoSyncState?: AutoSyncState;
}

/** Active legacy universal QR device pairing session (`#26`, payload strictly <= 213 UTF-8 bytes). */
export interface SyncQrPairingSession {
  readonly pairingId: string;
  readonly code: string;
  readonly qrUri: string;
  readonly expiresAtMs: number;
  readonly status: 'pending' | 'claimed' | 'expired';
}

/** Resolved 5-case bidirectional account transfer direction (`#510`). */
export type PairingDirection =
  | 'neither_signed_in'
  | 'responder_to_host'
  | 'host_to_responder'
  | 'same_account'
  | 'different_accounts';

/** Role of the local device inside a bidirectional X25519 pairing handshake (`#510`). */
export type BidirectionalPairingRole = 'host' | 'responder';

/** Lifecycle state of a bidirectional X25519 pairing session (`#510`). */
export type BidirectionalPairingStatus =
  | 'pending'
  | 'responder_joined'
  | 'awaiting_sas'
  | 'waiting_approval'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'locked';

/** UI-ready snapshot of an active bidirectional X25519 pairing session (`#510`). */
export interface BidirectionalPairingSnapshot {
  readonly pairingId: string;
  readonly role: BidirectionalPairingRole;
  readonly code: string;
  readonly qrUri?: string;
  readonly expiresAtMs: number;
  readonly status: BidirectionalPairingStatus;
  readonly sas: string | null;
  readonly direction: PairingDirection | null;
  readonly localMaskedEmail: string | null;
  readonly peerMaskedEmail: string | null;
  readonly errorCode?: string | null;
}

/** Result of an auth, sync, pairing, or permanent account deletion call (`#26`, `#510`). */
export interface SyncActionResult {
  readonly ok: boolean;
  readonly recoveryCode?: string;
  readonly errorCode?: string;
}

/** Pluggable native camera QR scanner port for mobile/tablet pairing (`#510`). */
export interface QrScannerPort {
  isSupported(): boolean;
  scanQrCode(): Promise<string | null>;
}

/** Supported third-party OAuth providers when store credentials are configured (`#513`). */
export type OAuthProviderId = 'google' | 'apple';

/** App-supplied E2EE sync, authentication, bidirectional X25519 pairing, and deletion port (`#26`, `#510`, `#513`). */
export interface SyncAccountPort {
  getState(): SyncAccountState;
  subscribe(listener: (state: SyncAccountState) => void): () => void;
  /** Checks whether an account already exists for `email`, gracefully returning `'unknown'` on failure. */
  checkEmail?(email: string): Promise<'exists' | 'not_found' | 'unknown'>;
  /** Configured OAuth providers available on this build (empty until store OAuth keys are enabled). */
  readonly supportedOAuthProviders?: readonly OAuthProviderId[];
  /** Starts OAuth sign-in for a configured provider (`#513`). */
  signInWithOAuth?(provider: OAuthProviderId): Promise<SyncActionResult>;
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
  /** Automatic background sync lifecycle hooks (`#510`, `[1.44]`). */
  /** Marks vault state dirty for the 3-minute heartbeat and pause/exit flush without triggering a 3s debounce push. */
  markSyncDirty?(): void;
  notifySyncDirty?(): void;
  notifyPlaybackPause?(): void;
  notifyPlaybackExitOrSwitch?(): void;
  setViewingActive?(active: boolean): void;
  /** Bidirectional X25519 + 8-digit code pairing hooks (`#510`, `[1.45]`). */
  startBidirectionalPairing?(): Promise<BidirectionalPairingSnapshot>;
  joinBidirectionalPairing?(codeOrUri: string): Promise<BidirectionalPairingSnapshot>;
  pollBidirectionalPairing?(pairingId: string): Promise<BidirectionalPairingSnapshot>;
  confirmBidirectionalPairing?(
    pairingId: string,
    chosenDirection?: 'host_to_responder' | 'responder_to_host',
  ): Promise<SyncActionResult>;
  cancelBidirectionalPairing?(pairingId: string): Promise<void>;
}

/** Structured, strictly redacted media decode failure metadata for `#458` / `#509` telemetry. */
export interface TelemetryMediaDecodeFailure {
  readonly engine: string;
  readonly container?: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly errorCode: string;
  readonly hdrFormat?: string;
  readonly isLive: boolean;
}

/** App-supplied unified opt-in diagnostics, crash, and performance telemetry port (`#458`, `#509`). */
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
  recordStartup?(durationMs: number, coldStart: boolean): void;
  recordPlaybackStart?(meta: {
    readonly engine: string;
    readonly ttffMs: number;
    readonly isLive: boolean;
    readonly container?: string;
    readonly videoCodec?: string;
  }): void;
  recordPlaybackRebuffer?(meta: {
    readonly engine: string;
    readonly durationMs: number;
    readonly isLive: boolean;
  }): void;
  recordCatalogImport?(meta: {
    readonly sourceKind: string;
    readonly stage: string;
    readonly durationMs: number;
    readonly itemCount: number;
    readonly success: boolean;
    readonly errorCode?: string;
  }): void;
  recordSqliteSlowOp?(meta: { readonly op: string; readonly durationMs: number }): void;
  recordFrameJank?(meta: {
    readonly screen: string;
    readonly droppedFrames: number;
    readonly maxFrameMs: number;
  }): void;
  recordJsStall?(meta: { readonly screen: string; readonly durationMs: number }): void;
  recordMemoryPressure?(meta: {
    readonly level: 'moderate' | 'critical';
    readonly usedMb?: number;
  }): void;
  recordAppCrash?(meta: {
    readonly errorName: string;
    readonly stackSig: string;
    readonly screen?: string;
    readonly fatal: boolean;
    readonly uptimeMs?: number;
  }): void;
  recordUnhandledError?(meta: {
    readonly errorName: string;
    readonly stackSig: string;
    readonly screen?: string;
    readonly source?: string;
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
