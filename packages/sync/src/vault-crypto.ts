import {
  base32Decode,
  base32Encode,
  base64UrlDecode,
  base64UrlEncode,
  utf8Decode,
  utf8Encode,
} from './encoding';
import type { VaultCryptoPort } from './ports';
import { VAULT_SCHEMA_VERSION, type VaultSnapshot } from './vault-merge';

/** Default PBKDF2-HMAC-SHA256 iteration count for client-side auth verifier and vault KEK. */
export const DEFAULT_KDF_ITERATIONS = 210_000;

/** Minimum allowed KDF iteration count accepted for vault unlock and registration. */
export const MIN_KDF_ITERATIONS = 100_000;

/** Maximum allowed KDF iteration count accepted for vault unlock and registration (DoS guard). */
export const MAX_KDF_ITERATIONS = 5_000_000;

/** Returns true when `iterations` is a safe integer within `[MIN_KDF_ITERATIONS, MAX_KDF_ITERATIONS]`. */
export function isValidKdfIterations(iterations: unknown): iterations is number {
  return (
    typeof iterations === 'number' &&
    Number.isSafeInteger(iterations) &&
    iterations >= MIN_KDF_ITERATIONS &&
    iterations <= MAX_KDF_ITERATIONS
  );
}

function assertValidKdfIterations(iterations: number): void {
  if (!isValidKdfIterations(iterations)) {
    throw new Error(
      `KDF iterations must be a safe integer between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`,
    );
  }
}

const VAULT_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const KDF_SALT_BYTES = 16;
const RECOVERY_ENTROPY_BYTES = 15;
const WRAP_PREFIX = 'v1.';

/** Public KDF and wrapped-key metadata stored on the sync server (zero plaintext secrets). */
export interface VaultKeyMetadata {
  readonly kdfSalt: string;
  readonly kdfIterations: number;
  readonly wrappedVaultKey: string;
  readonly recoveryWrappedVaultKey: string;
}

/** Newly created zero-knowledge registration bundle; `recoveryCode` and `vaultKey` never leave the device. */
export interface NewVaultBundle extends VaultKeyMetadata {
  readonly authVerifier: string;
  readonly recoveryCode: string;
  readonly vaultKey: Uint8Array;
}

/** Opaque AES-256-GCM encrypted vault payload sent to and retrieved from the sync server. */
export interface EncryptedVaultBlob {
  readonly ciphertext: string;
  readonly iv: string;
}

/** Normalizes an email address for deterministic zero-knowledge verifier derivation. */
export function normalizeSyncEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Formats 15 random bytes (120 bits) into a 24-character `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` base32 recovery code. */
export function formatRecoveryCode(entropy: Uint8Array): string {
  if (entropy.length !== RECOVERY_ENTROPY_BYTES) {
    throw new Error('Recovery entropy must be exactly 15 bytes');
  }
  const raw = base32Encode(entropy);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    groups.push(raw.slice(i, i + 4));
  }
  return groups.join('-');
}

/** Normalizes and validates a user-entered 24-character base32 recovery code. */
export function normalizeRecoveryCode(code: string): string {
  const stripped = code.replace(/[\s-]+/g, '').toUpperCase();
  if (stripped.length !== 24) {
    throw new Error('Invalid recovery code length');
  }
  const decoded = base32Decode(stripped);
  if (decoded.length !== RECOVERY_ENTROPY_BYTES) {
    throw new Error('Invalid recovery code');
  }
  return formatRecoveryCode(decoded);
}

/**
 * Derives the zero-knowledge authentication verifier sent to the sync server:
 * `base64url(PBKDF2-SHA256("elv-auth-v1|" + email.trim().toLowerCase(), password, iterations, 32))`.
 * The raw password never leaves the device.
 */
export async function deriveAuthVerifier(
  crypto: VaultCryptoPort,
  email: string,
  password: string,
  iterations = DEFAULT_KDF_ITERATIONS,
): Promise<string> {
  assertValidKdfIterations(iterations);
  const normalized = normalizeSyncEmail(email);
  if (normalized.length === 0) throw new Error('Email must not be empty');
  if (password.length === 0) throw new Error('Password must not be empty');
  const salt = utf8Encode(`elv-auth-v1|${normalized}`);
  const derived = await crypto.deriveKeyPbkdf2(utf8Encode(password), salt, iterations, 32);
  return base64UrlEncode(derived);
}

async function wrapKeyWithKek(
  crypto: VaultCryptoPort,
  kek: Uint8Array,
  vaultKey: Uint8Array,
  aadLabel: string,
): Promise<string> {
  const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
  const ct = await crypto.encryptAesGcm(kek, iv, vaultKey, utf8Encode(aadLabel));
  return `${WRAP_PREFIX}${base64UrlEncode(iv)}.${base64UrlEncode(ct)}`;
}

async function unwrapKeyWithKek(
  crypto: VaultCryptoPort,
  kek: Uint8Array,
  wrapped: string,
  aadLabel: string,
): Promise<Uint8Array> {
  if (!wrapped.startsWith(WRAP_PREFIX)) {
    throw new Error('Unsupported wrapped key format');
  }
  const body = wrapped.slice(WRAP_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1 || body.indexOf('.', dot + 1) !== -1) {
    throw new Error('Malformed wrapped key');
  }
  const iv = base64UrlDecode(body.slice(0, dot));
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new Error('Invalid wrapped key IV length');
  }
  const ciphertext = base64UrlDecode(body.slice(dot + 1));
  const vaultKey = await crypto.decryptAesGcm(kek, iv, ciphertext, utf8Encode(aadLabel));
  if (vaultKey.length !== VAULT_KEY_BYTES) {
    throw new Error('Unwrapped vault key has invalid length');
  }
  return vaultKey;
}

/**
 * Generates a fresh zero-knowledge vault registration bundle with:
 * - client-derived `authVerifier`
 * - random 32-byte `vaultKey` wrapped by a password-derived KEK
 * - 120-bit recovery code that independently wraps `vaultKey`
 */
export async function createNewVaultBundle(
  crypto: VaultCryptoPort,
  email: string,
  password: string,
  iterations = DEFAULT_KDF_ITERATIONS,
): Promise<NewVaultBundle> {
  assertValidKdfIterations(iterations);
  const kdfSalt = base64UrlEncode(crypto.randomBytes(KDF_SALT_BYTES));
  const vaultKey = crypto.randomBytes(VAULT_KEY_BYTES);
  const recoveryCode = formatRecoveryCode(crypto.randomBytes(RECOVERY_ENTROPY_BYTES));

  const authVerifier = await deriveAuthVerifier(crypto, email, password, iterations);
  const vaultKek = await crypto.deriveKeyPbkdf2(
    utf8Encode(password),
    utf8Encode(`elv-vault-v1|${kdfSalt}`),
    iterations,
    VAULT_KEY_BYTES,
  );
  const recoveryKek = await crypto.deriveKeyPbkdf2(
    utf8Encode(recoveryCode),
    utf8Encode(`elv-recovery-v1|${kdfSalt}`),
    iterations,
    VAULT_KEY_BYTES,
  );

  const wrappedVaultKey = await wrapKeyWithKek(
    crypto,
    vaultKek,
    vaultKey,
    `elv-wrap-v1|${kdfSalt}`,
  );
  const recoveryWrappedVaultKey = await wrapKeyWithKek(
    crypto,
    recoveryKek,
    vaultKey,
    `elv-recovery-wrap-v1|${kdfSalt}`,
  );

  return {
    authVerifier,
    kdfSalt,
    kdfIterations: iterations,
    wrappedVaultKey,
    recoveryCode,
    recoveryWrappedVaultKey,
    vaultKey,
  };
}

/** Unwraps the 32-byte `vaultKey` locally using the user's password and server-stored metadata. */
export async function unlockVaultWithPassword(
  crypto: VaultCryptoPort,
  password: string,
  meta: Pick<VaultKeyMetadata, 'kdfSalt' | 'kdfIterations' | 'wrappedVaultKey'>,
): Promise<Uint8Array> {
  assertValidKdfIterations(meta.kdfIterations);
  if (password.length === 0) throw new Error('Password must not be empty');
  const vaultKek = await crypto.deriveKeyPbkdf2(
    utf8Encode(password),
    utf8Encode(`elv-vault-v1|${meta.kdfSalt}`),
    meta.kdfIterations,
    VAULT_KEY_BYTES,
  );
  return unwrapKeyWithKek(crypto, vaultKek, meta.wrappedVaultKey, `elv-wrap-v1|${meta.kdfSalt}`);
}

/** Unwraps the 32-byte `vaultKey` locally using the user's offline 24-character recovery code. */
export async function unlockVaultWithRecoveryCode(
  crypto: VaultCryptoPort,
  recoveryCode: string,
  meta: Pick<VaultKeyMetadata, 'kdfSalt' | 'kdfIterations' | 'recoveryWrappedVaultKey'>,
): Promise<Uint8Array> {
  assertValidKdfIterations(meta.kdfIterations);
  const normalized = normalizeRecoveryCode(recoveryCode);
  const recoveryKek = await crypto.deriveKeyPbkdf2(
    utf8Encode(normalized),
    utf8Encode(`elv-recovery-v1|${meta.kdfSalt}`),
    meta.kdfIterations,
    VAULT_KEY_BYTES,
  );
  return unwrapKeyWithKek(
    crypto,
    recoveryKek,
    meta.recoveryWrappedVaultKey,
    `elv-recovery-wrap-v1|${meta.kdfSalt}`,
  );
}

function buildVaultBlobAad(userId: string, revision: number): Uint8Array {
  if (userId.length === 0) throw new Error('userId must not be empty');
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error('revision must be a non-negative integer');
  }
  return utf8Encode(`elv-vault-blob-v1|${userId}|${revision}`);
}

/** Encrypts a {@link VaultSnapshot} with AES-256-GCM bound to `(userId, revision)` via AAD. */
export async function encryptVaultSnapshot(
  crypto: VaultCryptoPort,
  vaultKey: Uint8Array,
  userId: string,
  revision: number,
  snapshot: VaultSnapshot,
): Promise<EncryptedVaultBlob> {
  if (vaultKey.length !== VAULT_KEY_BYTES) {
    throw new Error('vaultKey must be 32 bytes');
  }
  const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
  const aad = buildVaultBlobAad(userId, revision);
  const plaintext = utf8Encode(JSON.stringify(snapshot));
  const ciphertext = await crypto.encryptAesGcm(vaultKey, iv, plaintext, aad);
  return {
    ciphertext: base64UrlEncode(ciphertext),
    iv: base64UrlEncode(iv),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTombstoneItemArray(value: unknown, keyField: 'id' | 'key' | 'seriesKey'): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item)) return false;
    if (typeof item[keyField] !== 'string') return false;
    if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)) return false;
    if (keyField === 'seriesKey' && typeof item.bitsB64 !== 'string') return false;
  }
  return true;
}

/** Decrypts and authenticates an {@link EncryptedVaultBlob} bound to `(userId, revision)`. */
export async function decryptVaultSnapshot(
  crypto: VaultCryptoPort,
  vaultKey: Uint8Array,
  userId: string,
  revision: number,
  blob: EncryptedVaultBlob,
): Promise<VaultSnapshot> {
  if (vaultKey.length !== VAULT_KEY_BYTES) {
    throw new Error('vaultKey must be 32 bytes');
  }
  const iv = base64UrlDecode(blob.iv);
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new Error('Invalid vault blob IV length');
  }
  const ciphertext = base64UrlDecode(blob.ciphertext);
  const aad = buildVaultBlobAad(userId, revision);
  const plaintext = await crypto.decryptAesGcm(vaultKey, iv, ciphertext, aad);
  const parsed: unknown = JSON.parse(utf8Decode(plaintext));
  if (!isPlainObject(parsed) || parsed.schemaVersion !== VAULT_SCHEMA_VERSION) {
    throw new Error('Invalid vault snapshot schemaVersion');
  }
  if (
    typeof parsed.updatedAt !== 'number' ||
    !Number.isFinite(parsed.updatedAt) ||
    !isTombstoneItemArray(parsed.sources, 'id') ||
    !isTombstoneItemArray(parsed.favorites, 'key') ||
    !isTombstoneItemArray(parsed.hiddenChannels, 'key') ||
    !isTombstoneItemArray(parsed.pinnedChannels, 'key') ||
    !isTombstoneItemArray(parsed.customGroups, 'id') ||
    !isTombstoneItemArray(parsed.collections, 'id') ||
    !isTombstoneItemArray(parsed.watchProgress, 'key') ||
    !isTombstoneItemArray(parsed.watchedEpisodesBitfields, 'seriesKey')
  ) {
    throw new Error('Invalid vault snapshot structure');
  }
  return parsed as unknown as VaultSnapshot;
}
