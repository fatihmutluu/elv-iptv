import { webcrypto } from 'node:crypto';
import { redactText } from '@elv/domain';
import {
  base64UrlDecode,
  createWebCryptoVaultPort,
  type SyncHttpPort,
  type VaultCryptoPort,
} from '@elv/sync';
import type { SyncAccountStateIpc } from '../../shared/sync-ipc.ts';

export const SESSION_SECRET_KEY = 'elv.sync.session.v1';
export const VAULT_KEY_BYTES = 32;
export const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
export const FEEDBACK_LOG_TAIL_LINES = 25;

/** Minimal Fetch signature accepted by `createDesktopSyncService`. */
export type DesktopSyncFetchFn = (
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

export interface PersistedSessionRecord {
  readonly userId: string;
  readonly email: string;
  readonly refreshToken: string;
  readonly vaultKeyB64: string;
  readonly lastSyncedAtIso: string | null;
  readonly lastRevision: number;
}

export const SIGNED_OUT_STATE: SyncAccountStateIpc = Object.freeze({
  status: 'signed_out',
  email: null,
  lastSyncedAtIso: null,
  pendingRecoveryCode: null,
  errorCode: null,
});

export function createNodeWebCryptoPort(): VaultCryptoPort {
  return createWebCryptoVaultPort(webcrypto.subtle as unknown as SubtleCrypto, (arr) =>
    webcrypto.getRandomValues(arr),
  );
}

export function createFetchHttpPort(fetchFn: DesktopSyncFetchFn): SyncHttpPort {
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

export function errorCodeFrom(error: { readonly code: string; readonly detail?: string }): string {
  return error.detail !== undefined && error.detail.length > 0 ? error.detail : error.code;
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
