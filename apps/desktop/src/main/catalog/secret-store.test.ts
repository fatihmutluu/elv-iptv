import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CipherPort,
  createAesGcmTestCipher,
  createEncryptedFileSecretStore,
  createSafeStorageCipher,
  createWindowsLocalStateDurabilityCheck,
  type SafeStorageLike,
  SecretDecryptError,
  SecretStoreUnavailableError,
} from './secret-store.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-secrets-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSafeStorageCipher', () => {
  function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
    return {
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      encryptStringAsync: vi.fn(async (plain: string) =>
        Buffer.from(plain.split('').reverse().join(''), 'utf8'),
      ),
      decryptStringAsync: vi.fn(async (enc: Buffer) => ({
        shouldReEncrypt: false,
        result: enc.toString('utf8').split('').reverse().join(''),
      })),
      getSelectedStorageBackend: () => 'gnome_libsecret',
      ...overrides,
    };
  }

  it('encrypts and decrypts via Electron async safeStorage on win32, darwin and linux keyring', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const ss = fakeSafeStorage({
        getSelectedStorageBackend: () => (platform === 'linux' ? 'kwallet6' : 'unknown'),
      });
      const cipher = createSafeStorageCipher(ss, platform);
      expect(await cipher.isAvailable()).toBe(true);
      const encrypted = await cipher.encrypt('my-xtream-password');
      expect(Buffer.from(encrypted).includes(Buffer.from('my-xtream-password'))).toBe(false);
      expect(await cipher.decrypt(encrypted)).toBe('my-xtream-password');
    }
  });

  it('fails closed when isAsyncEncryptionAvailable resolves false', async () => {
    const ss = fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false });
    const cipher = createSafeStorageCipher(ss, 'win32');
    expect(await cipher.isAvailable()).toBe(false);
    await expect(cipher.encrypt('secret')).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    await expect(cipher.decrypt(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
  });

  it('fails closed on Linux when backend is basic_text or unknown', async () => {
    for (const backend of ['basic_text', 'unknown']) {
      const ss = fakeSafeStorage({ getSelectedStorageBackend: () => backend });
      const cipher = createSafeStorageCipher(ss, 'linux');
      expect(await cipher.isAvailable()).toBe(false);
      await expect(cipher.encrypt('secret')).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    }
  });
});

describe('createAesGcmTestCipher', () => {
  it('encrypts with random AES-256-GCM key, hides plaintext, and rejects tampered ciphertext', async () => {
    const cipherA = createAesGcmTestCipher();
    const cipherB = createAesGcmTestCipher();
    expect(await cipherA.isAvailable()).toBe(true);

    const secret = 'p@ssw0rd-İğüşöçı-token-998877';
    const ct = await cipherA.encrypt(secret);
    expect(Buffer.from(ct).includes(Buffer.from('p@ssw0rd'))).toBe(false);
    expect(Buffer.from(ct).includes(Buffer.from('998877'))).toBe(false);
    expect(await cipherA.decrypt(ct)).toBe(secret);

    await expect(cipherB.decrypt(ct)).rejects.toThrow();
    const tampered = new Uint8Array(ct);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    await expect(cipherA.decrypt(tampered)).rejects.toThrow();
  });
});

describe('createEncryptedFileSecretStore', () => {
  it('persists encrypted secrets atomically across instances with zero plaintext on disk', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    const cipher = createAesGcmTestCipher();

    const store1 = createEncryptedFileSecretStore({ filePath, cipher });
    expect(await store1.get('source.src_1.xtream')).toBeUndefined();

    const xtreamPayload = JSON.stringify({
      server: 'http://provider.example:8080',
      username: 'alice_secret_user',
      password: 'super_secret_password_42',
    });
    await store1.set('source.src_1.xtream', xtreamPayload);
    await store1.set('source.src_1.urlvars', JSON.stringify({ tok: 'bearer_tok_xyz987' }));

    const rawBytes = readFileSync(filePath);
    for (const needle of [
      'alice_secret_user',
      'super_secret_password_42',
      'bearer_tok_xyz987',
      'provider.example',
    ]) {
      expect(rawBytes.includes(Buffer.from(needle, 'utf8'))).toBe(false);
      expect(rawBytes.includes(Buffer.from(needle, 'utf16le'))).toBe(false);
    }
    expect(readdirSync(dir)).toEqual(['secrets.json']);

    const store2 = createEncryptedFileSecretStore({ filePath, cipher });
    expect(await store2.get('source.src_1.xtream')).toBe(xtreamPayload);
    expect(await store2.get('source.src_1.urlvars')).toBe('{"tok":"bearer_tok_xyz987"}');

    await store2.delete('source.src_1.xtream');
    await store2.delete('source.missing.xtream');
    expect(await store2.get('source.src_1.xtream')).toBeUndefined();
    expect(await store2.get('source.src_1.urlvars')).toBe('{"tok":"bearer_tok_xyz987"}');
  });

  it('supports profile.<id>.pin keys without writing raw PIN or hash in plaintext on disk (#31)', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    const cipher = createAesGcmTestCipher();
    const store = createEncryptedFileSecretStore({ filePath, cipher });

    const pinHash =
      'v1:00112233445566778899aabbccddeeff:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    await store.set('profile.p_kids_1.pin', pinHash);
    expect(await store.get('profile.p_kids_1.pin')).toBe(pinHash);

    const rawBytes = readFileSync(filePath);
    expect(rawBytes.includes(Buffer.from(pinHash, 'utf8'))).toBe(false);
    expect(rawBytes.includes(Buffer.from('00112233445566778899aabbccddeeff', 'utf8'))).toBe(false);

    await store.delete('profile.p_kids_1.pin');
    expect(await store.get('profile.p_kids_1.pin')).toBeUndefined();
  });

  it('serializes concurrent writes without losing entries or leaving temp files', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    const cipher = createAesGcmTestCipher();
    const store = createEncryptedFileSecretStore({ filePath, cipher });

    await Promise.all(
      Array.from({ length: 15 }, (_, i) => store.set(`source.s_${i}.playlist`, `http://h/${i}`)),
    );
    for (let i = 0; i < 15; i += 1) {
      expect(await store.get(`source.s_${i}.playlist`)).toBe(`http://h/${i}`);
    }
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });

  it('rejects invalid secret keys on get, set and delete', async () => {
    const dir = makeTempDir();
    const store = createEncryptedFileSecretStore({
      filePath: join(dir, 'secrets.json'),
      cipher: createAesGcmTestCipher(),
    });
    for (const badKey of ['', '../escape', 'has space', 'a/b', 'a:b']) {
      await expect(store.get(badKey)).rejects.toThrow(/secret key/);
      await expect(store.set(badKey, 'v')).rejects.toThrow(/secret key/);
      await expect(store.delete(badKey)).rejects.toThrow(/secret key/);
    }
  });

  it('fails closed without creating secrets.json when cipher is unavailable', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    let available = false;
    const base = createAesGcmTestCipher();
    const cipher: CipherPort = {
      isAvailable: async () => available,
      encrypt: async (plain) => {
        if (!available) throw new SecretStoreUnavailableError();
        return base.encrypt(plain);
      },
      decrypt: async (ct) => {
        if (!available) throw new SecretStoreUnavailableError();
        return base.decrypt(ct);
      },
    };
    const store = createEncryptedFileSecretStore({ filePath, cipher });

    await expect(store.set('source.s1.xtream', 'secret')).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
    expect(existsSync(filePath)).toBe(false);

    available = true;
    await store.set('source.s1.xtream', 'secret');
    expect(await store.get('source.s1.xtream')).toBe('secret');

    available = false;
    await expect(store.get('source.s1.xtream')).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it('throws SecretDecryptError without overwriting ciphertext when entry ciphertext is corrupt or OS key rotated', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    const cipherA = createAesGcmTestCipher();
    const cipherB = createAesGcmTestCipher();
    const storeA = createEncryptedFileSecretStore({ filePath, cipher: cipherA });

    // Corrupted JSON file still recovers cleanly on next write
    writeFileSync(filePath, '{not-json');
    expect(await storeA.get('source.s1.xtream')).toBeUndefined();

    await storeA.set('source.s1.xtream', 'fresh-value');
    expect(await storeA.get('source.s1.xtream')).toBe('fresh-value');
    const savedBeforeRotation = readFileSync(filePath, 'utf8');

    // Simulating OS key rotation (new cipher key) throws SecretDecryptError and preserves ciphertext on disk
    const storeB = createEncryptedFileSecretStore({ filePath, cipher: cipherB });
    await expect(storeB.get('source.s1.xtream')).rejects.toSatisfy((err: unknown) => {
      return err instanceof SecretDecryptError && err.code === 'storage/secret-key-rotated';
    });
    expect(readFileSync(filePath, 'utf8')).toBe(savedBeforeRotation);

    // Corrupted entry ciphertext also throws SecretDecryptError and preserves file content
    const corruptPayload = JSON.stringify({
      version: 1,
      entries: { 'source.s1.xtream': 'bm90LWEtdmFsaWQtY2lwaGVydGV4dA==' },
    });
    writeFileSync(filePath, corruptPayload);
    await expect(storeA.get('source.s1.xtream')).rejects.toBeInstanceOf(SecretDecryptError);
    expect(readFileSync(filePath, 'utf8')).toBe(corruptPayload);

    // Explicit user re-save still recovers cleanly
    await storeA.set('source.s1.xtream', 're-entered-value');
    expect(await storeA.get('source.s1.xtream')).toBe('re-entered-value');
  });

  it('verifies round-trip decryption and optional ensureOsKeyDurable before writing secrets.json', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');

    // Broken cipher returning wrong plaintext on decrypt must abort before writing secrets.json
    const brokenCipher: CipherPort = {
      isAvailable: async () => true,
      encrypt: async () => new Uint8Array([1, 2, 3]),
      decrypt: async () => 'wrong-plaintext',
    };
    const brokenStore = createEncryptedFileSecretStore({ filePath, cipher: brokenCipher });
    await expect(brokenStore.set('source.s1.xtream', 'expected')).rejects.toThrow(/round-trip/i);
    expect(existsSync(filePath)).toBe(false);

    // ensureOsKeyDurable hook runs before writing secrets.json
    const order: string[] = [];
    const base = createAesGcmTestCipher();
    const orderedStore = createEncryptedFileSecretStore({
      filePath,
      cipher: {
        isAvailable: () => base.isAvailable(),
        encrypt: async (p) => {
          order.push('encrypt');
          return base.encrypt(p);
        },
        decrypt: async (ct) => {
          order.push('decrypt-verify');
          return base.decrypt(ct);
        },
      },
      ensureOsKeyDurable: async () => {
        expect(existsSync(filePath)).toBe(false);
        order.push('durable-check');
      },
    });
    await orderedStore.set('source.s1.xtream', 'secret-val');
    expect(order).toEqual(['encrypt', 'decrypt-verify', 'durable-check']);
    expect(existsSync(filePath)).toBe(true);
  });

  it('createWindowsLocalStateDurabilityCheck verifies os_crypt.encrypted_key on win32 with bounded backoff and no-ops on non-win32', async () => {
    const dir = makeTempDir();
    const localStatePath = join(dir, 'Local State');

    // Non-win32 is an immediate no-op without waiting
    const nonWinSleep = vi.fn(async () => undefined);
    const macCheck = createWindowsLocalStateDurabilityCheck(localStatePath, {
      platform: 'darwin',
      sleep: nonWinSleep,
    });
    await macCheck();
    expect(nonWinSleep).not.toHaveBeenCalled();

    // Win32 polls until Local State appears with os_crypt.encrypted_key, then caches durability
    let polls = 0;
    const sleepCalls: number[] = [];
    const winCheck = createWindowsLocalStateDurabilityCheck(localStatePath, {
      platform: 'win32',
      maxWaitMs: 250,
      initialDelayMs: 25,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        polls += 1;
        if (polls === 2) {
          writeFileSync(
            localStatePath,
            JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEk=' } }),
            'utf8',
          );
        }
      },
    });
    await winCheck();
    expect(sleepCalls).toEqual([25, 50]);
    // Cached after verified durable — zero extra waits
    await winCheck();
    expect(sleepCalls).toEqual([25, 50]);

    // Bounded wait when Local State never flushes: logs warning and returns cleanly without blocking forever
    const missingDir = makeTempDir();
    const missingSleep: number[] = [];
    const logs: string[] = [];
    const missingCheck = createWindowsLocalStateDurabilityCheck(join(missingDir, 'Local State'), {
      platform: 'win32',
      maxWaitMs: 100,
      initialDelayMs: 25,
      sleep: async (ms) => {
        missingSleep.push(ms);
      },
      log: (line) => logs.push(line),
    });
    await missingCheck();
    expect(missingSleep.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(missingDir);

    // Corrupt/truncated Local State JSON logs explicit warning and stays unconfirmed until repaired
    const corruptDir = makeTempDir();
    const corruptPath = join(corruptDir, 'Local State');
    writeFileSync(corruptPath, '{"os_crypt": {"encrypted_key":', 'utf8');
    const corruptLogs: string[] = [];
    const corruptCheck = createWindowsLocalStateDurabilityCheck(corruptPath, {
      platform: 'win32',
      maxWaitMs: 20,
      initialDelayMs: 10,
      sleep: async () => undefined,
      log: (line) => corruptLogs.push(line),
    });
    await corruptCheck();
    expect(corruptLogs).toHaveLength(1);
    expect(corruptLogs[0]).toMatch(/parse|corrupt|truncated/i);
    expect(corruptLogs[0]).not.toContain(corruptDir);

    // Repair Local State -> subsequent check confirms durability without logging another warning
    writeFileSync(corruptPath, JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEk=' } }), 'utf8');
    await corruptCheck();
    expect(corruptLogs).toHaveLength(1);
  });

  it('rethrows non-ENOENT readFile errors instead of treating unreadable secrets.json as empty', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    mkdirSync(filePath);

    const store = createEncryptedFileSecretStore({
      filePath,
      cipher: createAesGcmTestCipher(),
    });

    await expect(store.get('source.s1.xtream')).rejects.toThrow();
    await expect(store.set('source.s1.xtream', 'value')).rejects.toThrow();
    await expect(store.delete('source.s1.xtream')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });
});
