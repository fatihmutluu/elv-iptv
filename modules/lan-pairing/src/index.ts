import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

const DEFAULT_MAX_BODY_BYTES = 16_384;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;

/** Options accepted by the native ephemeral LAN pairing HTTP server (`#50`). */
export interface LanPairingServerOptions {
  readonly token: string;
  readonly html: string;
  readonly ttlMs: number;
  readonly maxBodyBytes?: number;
  readonly maxFailedAttempts?: number;
}

/** Active native pairing server endpoint metadata returned by {@link startLanPairingServer}. */
export interface LanPairingServerInfo {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly expiresAtMs: number;
}

/** Raw HTTP POST submission forwarded by the native pairing server before closing. */
export interface LanPairingSubmissionEvent {
  readonly body: string;
  readonly contentType?: string;
}

/** Removable event subscription returned by {@link addLanPairingSubmissionListener}. */
export interface LanPairingSubscription {
  remove(): void;
}

interface NativeStartOptions {
  token: string;
  html: string;
  ttlMs: number;
  maxBodyBytes: number;
  maxFailedAttempts: number;
}

interface NativeLanPairingModule {
  generateToken?(): string;
  startServer(options: NativeStartOptions): Promise<LanPairingServerInfo>;
  stopServer(): Promise<void>;
  addListener(
    eventName: 'onSubmission',
    listener: (event: unknown) => void,
  ): LanPairingSubscription;
}

const native: NativeLanPairingModule | null =
  Platform.OS === 'web'
    ? null
    : requireOptionalNativeModule<NativeLanPairingModule>('ElvLanPairing');

function parseSubmissionEvent(raw: unknown): LanPairingSubmissionEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.body !== 'string') return null;
  if (typeof candidate.contentType === 'string' && candidate.contentType.length > 0) {
    return { body: candidate.body, contentType: candidate.contentType };
  }
  return { body: candidate.body };
}

/** Returns `true` when the native `ElvLanPairing` Expo module is linked on this platform. */
export function isLanPairingNativeAvailable(): boolean {
  return native !== null;
}

/**
 * Generates a 192-bit (24-byte) CSPRNG pairing token as 48 lowercase hex characters via native
 * `SecureRandom` (Android) or `SecRandomCopyBytes` (Apple). Returns `null` on web or when the
 * native module is unavailable.
 */
export function generateLanPairingToken(): string | null {
  if (native === null || typeof native.generateToken !== 'function') {
    return null;
  }
  const token = native.generateToken();
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Starts the ephemeral native LAN pairing HTTP server on a random free port.
 * Rejects on web or builds lacking the native module; callers should check {@link isLanPairingNativeAvailable} first.
 */
export async function startLanPairingServer(
  options: LanPairingServerOptions,
): Promise<LanPairingServerInfo> {
  if (native === null) {
    throw new Error('ElvLanPairing native module is unavailable on this platform');
  }
  return native.startServer({
    token: options.token,
    html: options.html,
    ttlMs: options.ttlMs,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxFailedAttempts: options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS,
  });
}

/** Stops any active native LAN pairing HTTP server; safe no-op when unavailable or stopped. */
export async function stopLanPairingServer(): Promise<void> {
  if (native === null) return;
  await native.stopServer();
}

/**
 * Subscribes to `onSubmission` payloads emitted when a phone submits the pairing form.
 * Returns a safe no-op subscription on web or when the native module is absent.
 */
export function addLanPairingSubmissionListener(
  listener: (event: LanPairingSubmissionEvent) => void,
): LanPairingSubscription {
  if (native === null) {
    return { remove: () => {} };
  }
  return native.addListener('onSubmission', (raw) => {
    const parsed = parseSubmissionEvent(raw);
    if (parsed !== null) listener(parsed);
  });
}
