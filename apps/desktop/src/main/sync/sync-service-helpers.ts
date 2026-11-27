import { webcrypto } from 'node:crypto';
import { normalizeSyncServerUrl, redactText, type SecretStore } from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  createEmptyVaultSnapshot,
  createWebCryptoVaultPort,
  decryptVaultSnapshot,
  encryptVaultSnapshot,
  type SyncHttpPort,
  type SyncSession,
  submitFeedback,
  type VaultCryptoPort,
  type VaultSnapshot,
} from '@elv/sync';
import type { AutoSyncStateIpc, SyncAccountStateIpc } from '../../shared/sync-ipc.ts';

export const SESSION_SECRET_KEY = 'elv.sync.session.v1';
const SERVER_URL_SECRET_KEY = 'elv.sync.server_url.v1';
export const VAULT_BASELINE_SECRET_KEY = 'sync.vault.baseline.v2';
export const VAULT_KEY_BYTES = 32;
export const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const FEEDBACK_LOG_TAIL_LINES = 25;

/** Safely invokes each listener in a snapshot of `listeners`, isolating subscriber exceptions. */
export function broadcastToListeners<T>(
  listeners: ReadonlySet<(value: T) => void>,
  value: T,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // Isolate subscriber callback errors.
    }
  }
}

/** Manages normalized sync/ELV server URL state, `SecretStore` persistence, and change subscribers (`#511`). */
export interface ServerUrlController {
  get(): string;
  hydrate(): Promise<string>;
  set(nextUrl: string): string;
  subscribe(listener: (url: string) => void): () => void;
  clearListeners(): void;
}

/** Creates a {@link ServerUrlController} that persists non-default custom URLs safely in `SecretStore`. */
export function createServerUrlController(
  secretStore: SecretStore,
  defaultServerUrl: string,
  onChange?: (serverUrl: string) => void,
): ServerUrlController {
  let current = defaultServerUrl;
  let explicitlySet = false;
  let persistChain: Promise<void> = Promise.resolve();
  const listeners = new Set<(url: string) => void>();

  const enqueuePersist = (op: () => Promise<void>): void => {
    persistChain = persistChain.then(op, op).catch(() => undefined);
  };

  const emit = (url: string): void => {
    try {
      onChange?.(url);
    } catch {
      // Isolate observer callback errors.
    }
    broadcastToListeners(listeners, url);
  };

  return {
    get: () => current,
    async hydrate(): Promise<string> {
      const raw = await secretStore.get(SERVER_URL_SECRET_KEY).catch(() => undefined);
      if (explicitlySet) return current;
      const trimmed = raw?.trim() ?? '';
      const normalized = trimmed.length > 0 ? normalizeSyncServerUrl(trimmed, '') : '';
      const next = normalized.length > 0 ? normalized : defaultServerUrl;
      if (next !== current) {
        current = next;
        emit(next);
      }
      return current;
    },
    set(rawUrl: string): string {
      explicitlySet = true;
      const trimmed = rawUrl.trim();
      const normalized = trimmed.length > 0 ? normalizeSyncServerUrl(trimmed, '') : '';
      const next = normalized.length > 0 ? normalized : defaultServerUrl;
      const changed = next !== current;
      current = next;
      if (normalized.length > 0 && normalized !== defaultServerUrl) {
        enqueuePersist(() => secretStore.set(SERVER_URL_SECRET_KEY, normalized));
      } else {
        enqueuePersist(() => secretStore.delete(SERVER_URL_SECRET_KEY));
      }
      if (changed) emit(next);
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearListeners(): void {
      listeners.clear();
    },
  };
}

/** Maps `@elv/sync` scheduler states onto the IPC auto-sync indicator state. */
export function mapSchedulerState(raw: 'idle' | 'syncing' | 'pending' | 'error'): AutoSyncStateIpc {
  return raw === 'error' ? 'offline' : raw;
}

/** Persists an authenticated sync session record strictly inside `SecretStore` (zero accessToken). */
export async function persistSessionRecord(
  secretStore: SecretStore,
  session: Pick<SyncSession, 'user' | 'refreshToken' | 'vaultKey'>,
  lastSyncedAtIso: string | null,
  revision: number,
): Promise<void> {
  const record: PersistedSessionRecord = {
    userId: session.user.id,
    email: session.user.email,
    refreshToken: session.refreshToken,
    vaultKeyB64: base64UrlEncode(session.vaultKey),
    lastSyncedAtIso,
    lastRevision: revision,
  };
  await secretStore.set(SESSION_SECRET_KEY, JSON.stringify(record));
}

/** Default Fetch adapter wrapping global `fetch` for Desktop main sync requests. */
export const defaultDesktopFetchFn: DesktopSyncFetchFn = (input, init) =>
  globalThis.fetch(input, {
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(init?.headers !== undefined ? { headers: { ...init.headers } } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  });

/** Encrypts and persists the last-synced vault snapshot baseline in `SecretStore` (`#510`). */
export async function persistVaultBaseline(
  secretStore: SecretStore,
  cryptoPort: VaultCryptoPort,
  session: Pick<SyncSession, 'user' | 'vaultKey'>,
  revision: number,
  snapshot: VaultSnapshot,
): Promise<void> {
  try {
    const safeRev = Number.isInteger(revision) && revision >= 0 ? revision : 0;
    const blob = await encryptVaultSnapshot(
      cryptoPort,
      session.vaultKey,
      session.user.id,
      safeRev,
      snapshot,
    );
    await secretStore.set(
      VAULT_BASELINE_SECRET_KEY,
      JSON.stringify({
        userId: session.user.id,
        revision: safeRev,
        ciphertext: blob.ciphertext,
        iv: blob.iv,
      }),
    );
  } catch {
    // Best-effort baseline persistence must never fail a committed vault sync.
  }
}

/** Decrypts the persisted vault baseline from `SecretStore`, falling back safely to an empty snapshot. */
export async function loadVaultBaseline(
  secretStore: SecretStore,
  cryptoPort: VaultCryptoPort,
  session: Pick<SyncSession, 'user' | 'vaultKey'>,
): Promise<VaultSnapshot> {
  try {
    const raw = await secretStore.get(VAULT_BASELINE_SECRET_KEY);
    if (raw === undefined || raw.length === 0) return createEmptyVaultSnapshot(0);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return createEmptyVaultSnapshot(0);
    }
    const rec = parsed as Record<string, unknown>;
    if (
      rec.userId !== session.user.id ||
      typeof rec.revision !== 'number' ||
      !Number.isInteger(rec.revision) ||
      rec.revision < 0 ||
      typeof rec.ciphertext !== 'string' ||
      typeof rec.iv !== 'string'
    ) {
      return createEmptyVaultSnapshot(0);
    }
    return await decryptVaultSnapshot(cryptoPort, session.vaultKey, session.user.id, rec.revision, {
      ciphertext: rec.ciphertext,
      iv: rec.iv,
    });
  } catch {
    return createEmptyVaultSnapshot(0);
  }
}

/** Builds a storage-safe per-account key recording whether initial preferences were applied once. */
export function initialPrefsAppliedKey(userId: string): string {
  return `elv.sync.initprefs.v1.${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Returns `true` when one-time initial preferences bootstrap was already applied for `userId`. */
export async function hasAppliedInitialPrefs(
  secretStore: SecretStore,
  userId: string,
): Promise<boolean> {
  const val = await secretStore.get(initialPrefsAppliedKey(userId)).catch(() => undefined);
  return val === '1';
}

/** Records that initial preferences bootstrap has been completed or skipped for `userId`. */
export async function markInitialPrefsApplied(
  secretStore: SecretStore,
  userId: string,
): Promise<void> {
  await secretStore.set(initialPrefsAppliedKey(userId), '1').catch(() => undefined);
}

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

/** Builds a redacted diagnostics payload and submits user feedback (`#458`). */
export async function submitDesktopFeedbackRequest(deps: {
  readonly serverUrl: string;
  readonly http: SyncHttpPort;
  readonly platform: string;
  readonly appVersion: string;
  readonly mpvVersion?: string;
  readonly readLogTail?: (maxLines: number) => Promise<readonly string[]>;
  readonly input: {
    readonly category:
      | 'playback_issue'
      | 'channel_epg'
      | 'ui_remote'
      | 'sync_account'
      | 'feature_request'
      | 'other';
    readonly message: string;
    readonly includeDiagnostics: boolean;
  };
}): Promise<{ readonly ok: boolean; readonly id?: string; readonly errorCode?: string }> {
  if (deps.serverUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
  let diagnostics: Record<string, string | number | boolean> | undefined;
  if (deps.input.includeDiagnostics) {
    const rawLogs = deps.readLogTail
      ? await deps.readLogTail(FEEDBACK_LOG_TAIL_LINES).catch(() => [] as readonly string[])
      : [];
    const logTail = rawLogs
      .slice(-FEEDBACK_LOG_TAIL_LINES)
      .map((line) => redactDiagnosticsLine(line))
      .join('\n');
    diagnostics = {
      platform: deps.platform,
      appVersion: deps.appVersion,
      ...(deps.mpvVersion !== undefined ? { mpvVersion: deps.mpvVersion } : {}),
      ...(logTail.length > 0 ? { logTail } : {}),
    };
  }
  const res = await submitFeedback({
    baseUrl: deps.serverUrl,
    http: deps.http,
    submission: {
      category: deps.input.category,
      message: deps.input.message,
      platform: deps.platform,
      appVersion: deps.appVersion,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    },
  });
  if (!res.ok) return { ok: false, errorCode: errorCodeFrom(res.error) };
  return { ok: true, id: res.value.id };
}
