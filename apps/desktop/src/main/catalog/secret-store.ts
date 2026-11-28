import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretStore } from '@elv/domain';

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const STORE_VERSION = 1;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Thrown when OS-backed encryption is unavailable or falls back to plaintext storage. */
export class SecretStoreUnavailableError extends Error {
  constructor() {
    super('OS secret encryption is unavailable');
    this.name = 'SecretStoreUnavailableError';
  }
}

/**
 * Thrown when an existing ciphertext in `secrets.json` cannot be decrypted (e.g. OS key rotated
 * or lost after a crash before Chromium flushed `Local State`).
 */
export class SecretDecryptError extends Error {
  readonly code = 'storage/secret-key-rotated' as const;
  readonly key: string;

  constructor(key: string) {
    super('Stored secret could not be decrypted after OS encryption key change');
    this.name = 'SecretDecryptError';
    this.key = key;
  }
}

/** Options for {@link createWindowsLocalStateDurabilityCheck}. */
export interface WindowsLocalStateDurabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly maxWaitMs?: number;
  readonly initialDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

type LocalStateKeyStatus = 'ok' | 'missing' | 'corrupt' | 'no-key';

const BASE64_KEY_RE = /^[A-Za-z0-9+/=]+$/;

async function inspectPersistedOsCryptKey(localStatePath: string): Promise<LocalStateKeyStatus> {
  let raw: string;
  try {
    raw = await readFile(localStatePath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'corrupt';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'corrupt';
  const osCrypt = (parsed as Record<string, unknown>)['os_crypt'];
  if (typeof osCrypt !== 'object' || osCrypt === null) return 'no-key';
  const encryptedKey = (osCrypt as Record<string, unknown>)['encrypted_key'];
  if (typeof encryptedKey !== 'string') return 'no-key';
  const trimmed = encryptedKey.trim();
  return trimmed.length > 0 && BASE64_KEY_RE.test(trimmed) ? 'ok' : 'no-key';
}

/**
 * Returns a memoized durability hook verifying that Chromium's `<userData>/Local State` parses
 * cleanly and contains a persisted `os_crypt.encrypted_key` on Windows (`win32`) with bounded
 * adaptive backoff (default 2000 ms). Immediate no-op on non-Windows platforms.
 */
export function createWindowsLocalStateDurabilityCheck(
  localStatePath: string,
  opts?: WindowsLocalStateDurabilityOptions,
): () => Promise<void> {
  const platform = opts?.platform ?? process.platform;
  const maxWaitMs = Math.max(0, Math.floor(opts?.maxWaitMs ?? 2_000));
  const initialDelayMs = Math.max(1, Math.floor(opts?.initialDelayMs ?? 25));
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let confirmed = false;

  return async (): Promise<void> => {
    if (platform !== 'win32' || confirmed) return;
    let status = await inspectPersistedOsCryptKey(localStatePath);
    if (status === 'ok') {
      confirmed = true;
      return;
    }
    let elapsed = 0;
    let delay = initialDelayMs;
    while (elapsed < maxWaitMs) {
      const waitMs = Math.min(delay, maxWaitMs - elapsed);
      await sleep(waitMs);
      elapsed += waitMs;
      status = await inspectPersistedOsCryptKey(localStatePath);
      if (status === 'ok') {
        confirmed = true;
        return;
      }
      delay = Math.min(delay * 2, maxWaitMs);
    }
    const reason =
      status === 'corrupt'
        ? 'Local State JSON corrupt or truncated'
        : status === 'missing'
          ? 'Local State file not yet created'
          : 'os_crypt.encrypted_key not yet persisted';
    opts?.log?.(`secret-store: Windows ${reason}`);
  };
}

/** Encryption primitive injected into {@link createEncryptedFileSecretStore}. */
export interface CipherPort {
  isAvailable(): Promise<boolean>;
  encrypt(plainText: string): Promise<Uint8Array>;
  decrypt(cipherText: Uint8Array): Promise<string>;
}

/** Subset of Electron 45's `safeStorage` used by {@link createSafeStorageCipher}. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
  getSelectedStorageBackend?(): string;
}

/**
 * Adapts Electron's async `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux)
 * to {@link CipherPort}. Fails closed when encryption is unavailable or when Linux selects `basic_text`.
 */
export function createSafeStorageCipher(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): CipherPort {
  const isAvailable = async (): Promise<boolean> => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  };

  return {
    isAvailable,
    async encrypt(plainText) {
      if (!(await isAvailable())) throw new SecretStoreUnavailableError();
      const buf = await safeStorage.encryptStringAsync(plainText);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async decrypt(cipherText) {
      if (!(await isAvailable())) throw new SecretStoreUnavailableError();
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(cipherText));
      return result;
    },
  };
}

/**
 * Ephemeral in-memory-key AES-256-GCM cipher for unit tests and unpackaged headless CI (`--elv-test-cipher`).
 * Never used in packaged builds.
 */
export function createAesGcmTestCipher(): CipherPort {
  const key = randomBytes(32);
  return {
    isAvailable: async () => true,
    async encrypt(plainText) {
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return new Uint8Array(Buffer.concat([iv, tag, body]));
    },
    async decrypt(cipherText) {
      if (cipherText.byteLength < GCM_IV_BYTES + GCM_TAG_BYTES) {
        throw new Error('ciphertext too short');
      }
      const buf = Buffer.from(cipherText.buffer, cipherText.byteOffset, cipherText.byteLength);
      const iv = buf.subarray(0, GCM_IV_BYTES);
      const tag = buf.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
      const body = buf.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('secret key must match [A-Za-z0-9._-]+');
}

async function readEntries(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== STORE_VERSION) return {};
    const entries = record['entries'];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
      if (KEY_PATTERN.test(k) && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEntriesAtomically(
  filePath: string,
  entries: Record<string, string>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  const payload = `${JSON.stringify({ version: STORE_VERSION, entries }, null, 2)}\n`;
  try {
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmpPath, 0o600).catch(() => undefined);
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Persists encrypted secrets in `filePath` (`0o600`, temp-file + `fsync` + atomic `rename`) over {@link CipherPort}.
 * Operations run sequentially on one promise queue; secret values are never logged or written in plaintext.
 */
export function createEncryptedFileSecretStore(opts: {
  filePath: string;
  cipher: CipherPort;
  localStatePath?: string;
  ensureOsKeyDurable?: () => Promise<void>;
  log?: (line: string) => void;
}): SecretStore {
  const { filePath, cipher } = opts;
  const ensureOsKeyDurable =
    opts.ensureOsKeyDurable ??
    (opts.localStatePath !== undefined
      ? createWindowsLocalStateDurabilityCheck(
          opts.localStatePath,
          opts.log ? { log: opts.log } : undefined,
        )
      : undefined);
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    async get(key) {
      assertKey(key);
      return enqueue(async () => {
        const entries = await readEntries(filePath);
        if (!Object.hasOwn(entries, key)) return undefined;
        const encoded = entries[key];
        if (encoded === undefined) return undefined;
        if (!(await cipher.isAvailable())) throw new SecretStoreUnavailableError();
        try {
          return await cipher.decrypt(new Uint8Array(Buffer.from(encoded, 'base64')));
        } catch (error) {
          if (error instanceof SecretStoreUnavailableError) throw error;
          throw new SecretDecryptError(key);
        }
      });
    },

    async set(key, value) {
      assertKey(key);
      return enqueue(async () => {
        const encrypted = await cipher.encrypt(value);
        const verified = await cipher.decrypt(encrypted);
        if (verified !== value) {
          throw new Error('Secret encryption round-trip verification failed');
        }
        if (ensureOsKeyDurable !== undefined) {
          await ensureOsKeyDurable();
        }
        const entries = await readEntries(filePath);
        entries[key] = Buffer.from(encrypted).toString('base64');
        await writeEntriesAtomically(filePath, entries);
      });
    },

    async delete(key) {
      assertKey(key);
      return enqueue(async () => {
        const entries = await readEntries(filePath);
        if (!Object.hasOwn(entries, key)) return;
        delete entries[key];
        await writeEntriesAtomically(filePath, entries);
      });
    },
  };
}
