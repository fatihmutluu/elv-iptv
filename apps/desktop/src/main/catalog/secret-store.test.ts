import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CipherPort,
  createAesGcmTestCipher,
  createEncryptedFileSecretStore,
  createSafeStorageCipher,
  type SafeStorageLike,
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

  it('treats corrupted JSON or corrupted entry ciphertext as missing and recovers on next write', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'secrets.json');
    const cipher = createAesGcmTestCipher();
    const store = createEncryptedFileSecretStore({ filePath, cipher });

    writeFileSync(filePath, '{not-json');
    expect(await store.get('source.s1.xtream')).toBeUndefined();

    await store.set('source.s1.xtream', 'fresh-value');
    expect(await store.get('source.s1.xtream')).toBe('fresh-value');

    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: { 'source.s1.xtream': 'bm90LWEtdmFsaWQtY2lwaGVydGV4dA==' },
      }),
    );
    expect(await store.get('source.s1.xtream')).toBeUndefined();
  });
});
