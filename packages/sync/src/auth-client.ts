import { elvError, err, ok, type Result } from '@elv/domain';
import type { SyncHttpPort, VaultCryptoPort } from './ports';
import {
  createNewVaultBundle,
  DEFAULT_KDF_ITERATIONS,
  decryptVaultSnapshot,
  deriveAuthVerifier,
  encryptVaultSnapshot,
  isValidKdfIterations,
  MAX_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  normalizeSyncEmail,
  unlockVaultWithPassword,
  type VaultKeyMetadata,
} from './vault-crypto';
import type { VaultSnapshot } from './vault-merge';

/** Supported third-party OAuth providers when store credentials are configured (`#513`). */
export type OAuthProviderId = 'google' | 'apple';

/** Supported authentication provider identifiers (Apple Guideline 4.8 OAuth-ready seam). */
export type AuthProviderId = 'email-password' | OAuthProviderId;

/** Result of checking whether an email already has a sync account (`#513`). */
export type EmailCheckResult = 'exists' | 'not_found' | 'unknown';

/** Pluggable auth provider adapter seam for future Apple/Google OAuth alongside email+password. */
export interface AuthProviderAdapter {
  readonly id: AuthProviderId;
  readonly enabled: boolean;
  authenticate?(options?: { readonly signal?: AbortSignal }): Promise<Result<SyncSession>>;
}

/** Minimum required password length for sync account creation. */
export const MIN_SYNC_PASSWORD_LENGTH = 6;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Validation error codes returned by {@link validateSignupInput}. */
export type SignupValidationError = 'invalid_email' | 'weak_password' | 'password_mismatch';

/** Authenticated sync user identity returned by the server. */
export interface SyncUser {
  readonly id: string;
  readonly email: string;
}

/** Active authenticated E2EE sync session held on-device. */
export interface SyncSession {
  readonly user: SyncUser;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly vaultKey: Uint8Array;
  readonly vaultMeta?: VaultKeyMetadata;
}

/** Result returned by {@link SyncAuthClient.register}. */
export interface RegisterResult {
  readonly session: SyncSession;
  readonly recoveryCode: string;
}

/** Result returned by {@link SyncAuthClient.refresh}. */
export interface RefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user?: SyncUser;
}

/** Result returned by {@link SyncAuthClient.issuePairRefreshToken}. */
export interface PairRefreshTokenResult {
  readonly refreshToken: string;
}

/** Result returned by {@link SyncAuthClient.pullVault}. */
export interface PullVaultResult {
  readonly revision: number;
  readonly snapshot: VaultSnapshot | null;
  readonly updatedAt: number | null;
}

/** Result returned by {@link SyncAuthClient.pushVault}. */
export type PushVaultResult =
  | { readonly status: 'ok'; readonly revision: number; readonly updatedAt: number }
  | { readonly status: 'conflict'; readonly currentRevision: number };

/** Options for {@link createSyncAuthClient}. */
export interface SyncAuthClientOptions {
  readonly baseUrl: string;
  readonly http: SyncHttpPort;
  readonly crypto: VaultCryptoPort;
  readonly kdfIterations?: number;
}

/** Zero-knowledge sync authentication and encrypted vault HTTP client. */
export interface SyncAuthClient {
  checkEmail(email: string, signal?: AbortSignal): Promise<EmailCheckResult>;
  register(
    email: string,
    password: string,
    confirmPassword: string,
    signal?: AbortSignal,
  ): Promise<Result<RegisterResult>>;
  login(email: string, password: string, signal?: AbortSignal): Promise<Result<SyncSession>>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<Result<RefreshResult>>;
  issuePairRefreshToken(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<Result<PairRefreshTokenResult>>;
  logout(refreshToken: string, accessToken?: string, signal?: AbortSignal): Promise<Result<void>>;
  deleteAccount(
    accessToken: string,
    email: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly deleted: true }>>;
  pullVault(session: SyncSession, signal?: AbortSignal): Promise<Result<PullVaultResult>>;
  pushVault(
    session: SyncSession,
    expectedRevision: number,
    snapshot: VaultSnapshot,
    signal?: AbortSignal,
  ): Promise<Result<PushVaultResult>>;
}

/** Validates signup email, password strength (`>= 10` chars), and password confirmation. */
export function validateSignupInput(
  email: string,
  password: string,
  confirmPassword: string,
): Result<{ readonly email: string; readonly password: string }, SignupValidationError> {
  const normalizedEmail = normalizeSyncEmail(email);
  if (
    normalizedEmail.length === 0 ||
    normalizedEmail.length > 254 ||
    !EMAIL_RE.test(normalizedEmail)
  ) {
    return err('invalid_email');
  }
  if (password.length < MIN_SYNC_PASSWORD_LENGTH) {
    return err('weak_password');
  }
  if (password !== confirmPassword) {
    return err('password_mismatch');
  }
  return ok({ email: normalizedEmail, password });
}

function parseJsonBody(bodyText: string): Record<string, unknown> | null {
  if (bodyText.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isSyncUser(value: unknown): value is SyncUser {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === 'string' && rec.id.length > 0 && typeof rec.email === 'string';
}

function isVaultMeta(value: unknown): value is VaultKeyMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.kdfSalt === 'string' &&
    rec.kdfSalt.length > 0 &&
    isValidKdfIterations(rec.kdfIterations) &&
    typeof rec.wrappedVaultKey === 'string' &&
    rec.wrappedVaultKey.length > 0 &&
    typeof rec.recoveryWrappedVaultKey === 'string' &&
    rec.recoveryWrappedVaultKey.length > 0
  );
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function mapHttpError(status: number, body: Record<string, unknown> | null) {
  const serverCode = typeof body?.error === 'string' ? body.error : undefined;
  if (status === 401 || status === 403) {
    return elvError('auth', serverCode ?? `http-${status}`);
  }
  if (status === 409) {
    return elvError('auth', serverCode ?? 'conflict');
  }
  return elvError('network', serverCode ?? `http-${status}`);
}

/** Creates a zero-knowledge {@link SyncAuthClient} talking to an ELV sync server. */
export function createSyncAuthClient(options: SyncAuthClientOptions): SyncAuthClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const iterations = options.kdfIterations ?? DEFAULT_KDF_ITERATIONS;
  if (!isValidKdfIterations(iterations)) {
    throw new Error(
      `kdfIterations must be a safe integer between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`,
    );
  }

  const jsonRequest = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    accessToken?: string,
    signal?: AbortSignal,
  ) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken !== undefined && accessToken.length > 0) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    try {
      const res = await options.http.request({
        method,
        url: `${baseUrl}${path}`,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      return ok({ status: res.status, body: parseJsonBody(res.bodyText) });
    } catch {
      return err(elvError('network', 'request-failed'));
    }
  };

  return {
    async checkEmail(email, signal) {
      const normalizedEmail = normalizeSyncEmail(email);
      if (
        normalizedEmail.length === 0 ||
        normalizedEmail.length > 254 ||
        !EMAIL_RE.test(normalizedEmail)
      ) {
        return 'unknown';
      }
      const res = await jsonRequest(
        'POST',
        '/v1/auth/check-email',
        { email: normalizedEmail },
        undefined,
        signal,
      );
      if (!res.ok) return 'unknown';
      const { status, body } = res.value;
      if (status !== 200 || body === null || typeof body.exists !== 'boolean') {
        return 'unknown';
      }
      return body.exists ? 'exists' : 'not_found';
    },

    async register(email, password, confirmPassword, signal) {
      const valid = validateSignupInput(email, password, confirmPassword);
      if (!valid.ok) return err(elvError('auth', valid.error));

      const bundle = await createNewVaultBundle(
        options.crypto,
        valid.value.email,
        valid.value.password,
        iterations,
      );
      const res = await jsonRequest(
        'POST',
        '/v1/auth/register',
        {
          email: valid.value.email,
          authVerifier: bundle.authVerifier,
          kdfSalt: bundle.kdfSalt,
          kdfIterations: bundle.kdfIterations,
          wrappedVaultKey: bundle.wrappedVaultKey,
          recoveryWrappedVaultKey: bundle.recoveryWrappedVaultKey,
        },
        undefined,
        signal,
      );
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status < 200 || status >= 300) {
        return err(mapHttpError(status, body));
      }
      if (
        body === null ||
        !isSyncUser(body.user) ||
        typeof body.accessToken !== 'string' ||
        typeof body.refreshToken !== 'string'
      ) {
        return err(elvError('network', 'invalid-register-response'));
      }
      const vaultMeta: VaultKeyMetadata = {
        kdfSalt: bundle.kdfSalt,
        kdfIterations: bundle.kdfIterations,
        wrappedVaultKey: bundle.wrappedVaultKey,
        recoveryWrappedVaultKey: bundle.recoveryWrappedVaultKey,
      };
      return ok({
        recoveryCode: bundle.recoveryCode,
        session: {
          user: body.user,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          vaultKey: bundle.vaultKey,
          vaultMeta,
        },
      });
    },

    async login(email, password, signal) {
      const normalizedEmail = normalizeSyncEmail(email);
      if (normalizedEmail.length === 0 || !EMAIL_RE.test(normalizedEmail)) {
        return err(elvError('auth', 'invalid_email'));
      }
      if (password.length === 0) {
        return err(elvError('auth', 'invalid_credentials'));
      }
      const authVerifier = await deriveAuthVerifier(
        options.crypto,
        normalizedEmail,
        password,
        iterations,
      );
      const res = await jsonRequest(
        'POST',
        '/v1/auth/login',
        { email: normalizedEmail, authVerifier },
        undefined,
        signal,
      );
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status < 200 || status >= 300) {
        return err(mapHttpError(status, body));
      }
      if (
        body === null ||
        !isSyncUser(body.user) ||
        typeof body.accessToken !== 'string' ||
        typeof body.refreshToken !== 'string' ||
        !isVaultMeta(body.vaultMeta)
      ) {
        return err(elvError('network', 'invalid-login-response'));
      }
      try {
        const vaultKey = await unlockVaultWithPassword(options.crypto, password, body.vaultMeta);
        return ok({
          user: body.user,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          vaultKey,
          vaultMeta: body.vaultMeta,
        });
      } catch {
        return err(elvError('auth', 'vault-unlock-failed'));
      }
    },

    async refresh(refreshToken, signal) {
      const res = await jsonRequest(
        'POST',
        '/v1/auth/refresh',
        { refreshToken },
        undefined,
        signal,
      );
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status < 200 || status >= 300) return err(mapHttpError(status, body));
      if (
        body === null ||
        typeof body.accessToken !== 'string' ||
        typeof body.refreshToken !== 'string'
      ) {
        return err(elvError('network', 'invalid-refresh-response'));
      }
      return ok({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        ...(isSyncUser(body.user) ? { user: body.user } : {}),
      });
    },

    async issuePairRefreshToken(accessToken, signal) {
      if (accessToken.trim().length === 0) {
        return err(elvError('auth', 'missing-access-token'));
      }
      const res = await jsonRequest('POST', '/v1/auth/pair-token', {}, accessToken, signal);
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status < 200 || status >= 300) return err(mapHttpError(status, body));
      if (
        body === null ||
        typeof body.refreshToken !== 'string' ||
        body.refreshToken.length === 0
      ) {
        return err(elvError('network', 'invalid-pair-token-response'));
      }
      return ok({ refreshToken: body.refreshToken });
    },

    async logout(refreshToken, accessToken, signal) {
      const res = await jsonRequest(
        'POST',
        '/v1/auth/logout',
        { refreshToken },
        accessToken,
        signal,
      );
      if (!res.ok) return res;
      if (res.value.status < 200 || res.value.status >= 300) {
        return err(mapHttpError(res.value.status, res.value.body));
      }
      return ok(undefined);
    },

    async deleteAccount(accessToken, email, password, signal) {
      const normalizedEmail = normalizeSyncEmail(email);
      if (normalizedEmail.length === 0 || password.length === 0) {
        return err(elvError('auth', 'invalid_credentials'));
      }
      const authVerifier = await deriveAuthVerifier(
        options.crypto,
        normalizedEmail,
        password,
        iterations,
      );
      const res = await jsonRequest(
        'DELETE',
        '/v1/auth/account',
        { authVerifier },
        accessToken,
        signal,
      );
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status < 200 || status >= 300) return err(mapHttpError(status, body));
      return ok({ deleted: true });
    },

    async pullVault(session, signal) {
      const res = await jsonRequest('GET', '/v1/vault', undefined, session.accessToken, signal);
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status < 200 || status >= 300) return err(mapHttpError(status, body));
      if (body === null || typeof body.revision !== 'number') {
        return err(elvError('network', 'invalid-vault-response'));
      }
      const updatedAt = parseTimestampMs(body.updatedAt);
      if (body.ciphertext === null || body.iv === null) {
        return ok({ revision: body.revision, snapshot: null, updatedAt });
      }
      if (typeof body.ciphertext !== 'string' || typeof body.iv !== 'string') {
        return err(elvError('network', 'invalid-vault-response'));
      }
      try {
        const snapshot = await decryptVaultSnapshot(
          options.crypto,
          session.vaultKey,
          session.user.id,
          body.revision,
          { ciphertext: body.ciphertext, iv: body.iv },
        );
        return ok({ revision: body.revision, snapshot, updatedAt });
      } catch {
        return err(elvError('auth', 'vault-decrypt-failed'));
      }
    },

    async pushVault(session, expectedRevision, snapshot, signal) {
      const targetRevision = expectedRevision + 1;
      const blob = await encryptVaultSnapshot(
        options.crypto,
        session.vaultKey,
        session.user.id,
        targetRevision,
        snapshot,
      );
      const res = await jsonRequest(
        'PUT',
        '/v1/vault',
        {
          expectedRevision,
          ciphertext: blob.ciphertext,
          iv: blob.iv,
        },
        session.accessToken,
        signal,
      );
      if (!res.ok) return res;
      const { status, body } = res.value;
      if (status === 409) {
        const currentRevision =
          typeof body?.currentRevision === 'number' ? body.currentRevision : expectedRevision;
        return ok({ status: 'conflict', currentRevision });
      }
      if (status < 200 || status >= 300) return err(mapHttpError(status, body));
      if (body === null || typeof body.revision !== 'number') {
        return err(elvError('network', 'invalid-vault-push-response'));
      }
      return ok({
        status: 'ok',
        revision: body.revision,
        updatedAt: parseTimestampMs(body.updatedAt) ?? 0,
      });
    },
  };
}
