/** Platform-agnostic cryptographic primitives required for zero-knowledge E2EE sync. */
export interface VaultCryptoPort {
  /** Returns `length` cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;
  /** Computes SHA-256 digest (32 bytes). */
  sha256(data: Uint8Array): Promise<Uint8Array>;
  /** Derives `lengthBytes` via PBKDF2-HMAC-SHA256. */
  deriveKeyPbkdf2(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    lengthBytes: number,
  ): Promise<Uint8Array>;
  /**
   * Encrypts `plaintext` with AES-GCM (128-bit or 256-bit `key`) and optional `aad`.
   * Returns `ciphertext || 16-byte authentication tag`.
   */
  encryptAesGcm(
    key: Uint8Array,
    iv: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<Uint8Array>;
  /**
   * Decrypts `ciphertext` (`ciphertext || 16-byte authentication tag`) with AES-GCM and optional `aad`.
   * Rejects if authentication fails.
   */
  decryptAesGcm(
    key: Uint8Array,
    iv: Uint8Array,
    ciphertext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<Uint8Array>;
}

/** HTTP request descriptor passed to {@link SyncHttpPort}. */
export interface SyncHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** HTTP response returned by {@link SyncHttpPort}. */
export interface SyncHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

/** Minimal HTTP transport port used by `@elv/sync` clients and telemetry/feedback uploaders. */
export interface SyncHttpPort {
  request(req: SyncHttpRequest): Promise<SyncHttpResponse>;
}

/** Monotonic/wall-clock port returning current epoch milliseconds for deterministic testing. */
export interface SyncClockPort {
  now(): number;
}
