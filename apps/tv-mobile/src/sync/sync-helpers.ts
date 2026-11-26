import { type PreferencesPatch, redactText, type SecretStore } from '@elv/domain';
import { generateLanPairingToken } from '@elv/lan-pairing';
import {
  base64UrlDecode,
  base64UrlEncode,
  type SyncClockPort,
  type SyncHttpPort,
  type VaultCryptoPort,
  type VaultSnapshot,
} from '@elv/sync';

export const SESSION_SECRET_KEY = 'elv.sync.session.v1';
export const VAULT_KEY_BYTES = 32;
export const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
export const FEEDBACK_LOG_TAIL_LINES = 25;

/** Builds a SecureStore-safe per-account key recording whether initial preferences were applied once. */
export function initialPrefsAppliedKey(userId: string): string {
  return `elv.sync.initprefs.v1.${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Lifecycle state of the optional E2EE sync account session (`#26`). */
type SyncAccountStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'syncing';

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
type FeedbackCategoryId =
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

/** Redacted device metadata attached to telemetry envelopes and opt-in feedback diagnostics. */
interface TvMobileDeviceMeta {
  readonly platform: string;
  readonly appVersion: string;
  readonly locale?: string;
  readonly osVersion?: string;
}

/** Minimal preferences snapshot read by the tv-mobile sync runtime. */
interface TvMobileSyncPreferences {
  readonly telemetryOptIn?: boolean;
  readonly syncServerUrl?: string;
}

/** Minimal Fetch signature accepted by `createTvMobileSyncPorts`. */
export type SyncFetchFn = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

/** Options for `createTvMobileSyncPorts`. */
export interface CreateTvMobileSyncPortsOptions {
  readonly secretStore: SecretStore;
  readonly fetchFn?: SyncFetchFn;
  readonly getServerUrl: () => string;
  readonly getDeviceMeta: () => TvMobileDeviceMeta;
  readonly getRecentLogs?: (maxLines?: number) => Promise<readonly string[]> | readonly string[];
  readonly getPreferences?: () => TvMobileSyncPreferences | undefined;
  readonly crypto?: VaultCryptoPort;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly clock?: SyncClockPort;
  readonly kdfIterations?: number;
  readonly flushIntervalMs?: number;
  readonly getLocalSnapshot?: () => Promise<VaultSnapshot> | VaultSnapshot;
  readonly applyMergedSnapshot?: (snapshot: VaultSnapshot) => Promise<void> | void;
  readonly getSyncablePreferences?: () => Readonly<Record<string, unknown>> | undefined;
  readonly applyInitialPreferences?: (patch: PreferencesPatch) => Promise<void> | void;
  readonly subscribeAppState?: (listener: (state: string) => void) => () => void;
  readonly onTelemetryOptInChange?: (enabled: boolean) => void;
}

/** Runtime ports bundle returned by `createTvMobileSyncPorts`. */
export interface TvMobileSyncPorts {
  readonly syncAccount: SyncAccountPort;
  readonly telemetry: TelemetryPort;
  readonly feedback: FeedbackPort;
  hydrate(): Promise<void>;
  dispose(): void;
}

export interface PersistedSessionRecord {
  readonly userId: string;
  readonly email: string;
  readonly refreshToken: string;
  readonly vaultKeyB64: string;
  readonly lastSyncedAtIso: string | null;
  readonly lastRevision: number;
}

export const SIGNED_OUT_STATE: SyncAccountState = Object.freeze({
  status: 'signed_out',
  email: null,
  lastSyncedAtIso: null,
  pendingRecoveryCode: null,
  errorCode: null,
});

const LAN_TOKEN_HEX_RE = /^[0-9a-f]{48}$/i;
const LAN_TOKEN_BYTES = 24;

/**
 * Cryptographic byte generator for Hermes / React Native:
 * 1. Uses `globalThis.crypto.getRandomValues` when present.
 * 2. Falls back to `@elv/lan-pairing`'s native `generateLanPairingToken()` (`java.security.SecureRandom`
 *    on Android / `SecRandomCopyBytes` on Apple iOS/tvOS, 48 hex chars = 24 bytes per call).
 * 3. Throws fail-closed if neither CSPRNG is available.
 */
export function defaultCsprngBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`Invalid CSPRNG byte length: ${String(length)}`);
  }
  const out = new Uint8Array(length);
  if (length === 0) return out;

  const cryptoApi = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(out);
    return out;
  }

  const chunks = Math.ceil(length / LAN_TOKEN_BYTES);
  let offset = 0;
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    const hex = generateLanPairingToken();
    if (typeof hex !== 'string' || !LAN_TOKEN_HEX_RE.test(hex)) {
      throw new Error(
        'CSPRNG unavailable: neither globalThis.crypto.getRandomValues nor native @elv/lan-pairing CSPRNG is available',
      );
    }
    for (let i = 0; i < LAN_TOKEN_BYTES && offset < length; i += 1) {
      out[offset] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      offset += 1;
    }
  }
  return out;
}

export function createFetchHttpPort(fetchFn: SyncFetchFn): SyncHttpPort {
  return {
    async request(req) {
      const res = await fetchFn(req.url, {
        method: req.method,
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      return { status: res.status, bodyText: await res.text() };
    },
  };
}

export function parsePersistedSession(raw: string | undefined): PersistedSessionRecord | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (
      typeof rec.userId !== 'string' ||
      rec.userId.length === 0 ||
      typeof rec.email !== 'string' ||
      rec.email.length === 0 ||
      typeof rec.refreshToken !== 'string' ||
      rec.refreshToken.length === 0 ||
      typeof rec.vaultKeyB64 !== 'string' ||
      rec.vaultKeyB64.length === 0
    ) {
      return null;
    }
    if (base64UrlDecode(rec.vaultKeyB64).length !== VAULT_KEY_BYTES) return null;
    return {
      userId: rec.userId,
      email: rec.email,
      refreshToken: rec.refreshToken,
      vaultKeyB64: rec.vaultKeyB64,
      lastSyncedAtIso: typeof rec.lastSyncedAtIso === 'string' ? rec.lastSyncedAtIso : null,
      lastRevision:
        typeof rec.lastRevision === 'number' &&
        Number.isInteger(rec.lastRevision) &&
        rec.lastRevision >= 0
          ? rec.lastRevision
          : 0,
    };
  } catch {
    return null;
  }
}

const IPV6_BODY =
  '(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,7}:' +
  '|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}' +
  '|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}' +
  '|:(?::[0-9a-fA-F]{1,4}){1,7}' +
  '|::ffff:(?:(?:25[0-5]|2[0-4]\\d|1?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d\\d?))';
const IPV6_BRACKET_RE = new RegExp(`\\[${IPV6_BODY}(?:%[^\\s\\]]+)?\\](?::\\d{1,5})?`, 'gi');
const IPV6_BARE_RE = new RegExp(
  `(^|[\\s"'(=:,])${IPV6_BODY}(?:%[^\\s"'),;]+)?(?=$|[\\s"'),;/])`,
  'gi',
);
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)(?::\d{1,5})?\b/g;

/**
 * Strips all URI schemes, `file:` references, credentials, auth headers/tokens, private OS paths,
 * IPv6 addresses, and IPv4 addresses BEFORE delegating to `@elv/domain`'s `redactText()`.
 */
export function redactDiagnosticsLine(line: string): string {
  const preStripped = line
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .replace(/file:\S+/gi, '[redacted]')
    .replace(/(^|[\s"'(=])[^\s/:@]{1,128}:[^\s/:@]{1,128}@[^\s/:@]+/g, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]')
    .replace(/\bauthorization\s*[:=]\s*\S+(?:\s+\S+)?/gi, '[redacted]')
    .replace(
      /\b(?:password|passwd|access_token|refresh_token|api_key)\s*[:=]\s*\S+/gi,
      '[redacted]',
    )
    .replace(
      /(^|[\s"'(=:])\/(?:Users|home|var|tmp|private|data|storage)\/[^\s"'<>)]*/g,
      '$1[redacted]',
    )
    .replace(/(^|[\s"'(=:])[A-Za-z]:\\[^\s"'<>)]*/g, '$1[redacted]')
    .replace(/(^|[\s"'(=:])\\\\[A-Za-z0-9_.-]+\\[^\s"'<>)]*/g, '$1[redacted]')
    .replace(IPV6_BRACKET_RE, '[redacted]')
    .replace(IPV6_BARE_RE, '$1[redacted]')
    .replace(IPV4_RE, '[redacted]');
  return redactText(preStripped);
}

/** Returns `true` when an `@elv/sync` error represents an expired/unauthorized bearer token (401). */
export function isAuthTokenExpiredError(error: {
  readonly category?: string;
  readonly code: string;
  readonly detail?: string;
}): boolean {
  if (error.category === 'auth') {
    return (
      error.code === 'unauthorized' ||
      error.code === 'http-401' ||
      error.code === 'token_expired' ||
      error.code === 'invalid_token'
    );
  }
  return (
    error.code === 'auth' &&
    (error.detail === 'unauthorized' || error.detail === 'http-401' || error.detail === undefined)
  );
}

export function errorCodeFrom(error: { readonly code: string; readonly detail?: string }): string {
  return error.detail !== undefined && error.detail.length > 0 ? error.detail : error.code;
}

export function generateSessionId(randomBytes: (length: number) => Uint8Array): string {
  return `s_${base64UrlEncode(randomBytes(12))}`;
}
