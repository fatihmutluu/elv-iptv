import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode } from './encoding';
import { createPureJsVaultCryptoPort, createWebCryptoVaultPort } from './pure-crypto';
import {
  createNewVaultBundle,
  decryptVaultSnapshot,
  deriveAuthVerifier,
  encryptVaultSnapshot,
  formatRecoveryCode,
  normalizeRecoveryCode,
  unlockVaultWithPassword,
  unlockVaultWithRecoveryCode,
} from './vault-crypto';
import { createEmptyVaultSnapshot, encodeEpisodeBitfield, type VaultSnapshot } from './vault-merge';

// Fast iteration count for unit tests; production default is 210_000.
const TEST_ITERATIONS = 1_000;

function seededRandom(seed = 99): (len: number) => Uint8Array {
  let state = seed >>> 0;
  return (len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

describe('vault-crypto zero-knowledge lifecycle', () => {
  it('derives deterministic email-normalized auth verifiers without sending password', async () => {
    const crypto = createPureJsVaultCryptoPort(seededRandom(1));
    const v1 = await deriveAuthVerifier(
      crypto,
      'User@Example.COM ',
      'correct-horse-battery',
      TEST_ITERATIONS,
    );
    const v2 = await deriveAuthVerifier(
      crypto,
      'user@example.com',
      'correct-horse-battery',
      TEST_ITERATIONS,
    );
    const v3 = await deriveAuthVerifier(
      crypto,
      'other@example.com',
      'correct-horse-battery',
      TEST_ITERATIONS,
    );
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
    expect(base64UrlDecode(v1)).toHaveLength(32);

    await expect(deriveAuthVerifier(crypto, '   ', 'pass', TEST_ITERATIONS)).rejects.toThrow();
    await expect(deriveAuthVerifier(crypto, 'a@b.c', '', TEST_ITERATIONS)).rejects.toThrow();
  });

  it('creates vault bundle and unlocks identically via password or recovery code across ports', async () => {
    const pureCrypto = createPureJsVaultCryptoPort(seededRandom(7));
    const webCrypto = createWebCryptoVaultPort(globalThis.crypto.subtle, (arr) =>
      globalThis.crypto.getRandomValues(arr),
    );

    const bundle = await createNewVaultBundle(
      pureCrypto,
      'alice@example.com',
      'my-strong-password-123',
      TEST_ITERATIONS,
    );
    expect(bundle.vaultKey).toHaveLength(32);
    expect(bundle.recoveryCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
    expect(normalizeRecoveryCode(bundle.recoveryCode.toLowerCase().replace(/-/g, ' '))).toBe(
      bundle.recoveryCode,
    );

    // Unlock on a different device using WebCrypto!
    const unlockedByPass = await unlockVaultWithPassword(
      webCrypto,
      'my-strong-password-123',
      bundle,
    );
    expect(unlockedByPass).toEqual(bundle.vaultKey);

    const unlockedByRecovery = await unlockVaultWithRecoveryCode(
      webCrypto,
      bundle.recoveryCode.toLowerCase(),
      bundle,
    );
    expect(unlockedByRecovery).toEqual(bundle.vaultKey);

    // Wrong password and wrong recovery code fail cleanly
    await expect(
      unlockVaultWithPassword(webCrypto, 'wrong-password-123', bundle),
    ).rejects.toThrow();
    await expect(
      unlockVaultWithRecoveryCode(
        webCrypto,
        formatRecoveryCode(new Uint8Array(15).fill(0x55)),
        bundle,
      ),
    ).rejects.toThrow();
    expect(() => normalizeRecoveryCode('SHORT')).toThrow();
    expect(() => formatRecoveryCode(new Uint8Array(10))).toThrow();
  });

  it('encrypts and decrypts snapshots and rejects tampered AAD, revision, userId, or tag', async () => {
    const crypto = createPureJsVaultCryptoPort(seededRandom(21));
    const bundle = await createNewVaultBundle(
      crypto,
      'bob@example.com',
      'another-strong-password',
      TEST_ITERATIONS,
    );

    const snapshot: VaultSnapshot = {
      ...createEmptyVaultSnapshot(1_700_000_000_000),
      sources: [
        {
          id: 'src-1',
          kind: 'xtream',
          name: 'Home TV',
          url: 'https://provider.invalid:8443',
          username: 'bob',
          password: 'super-secret-provider-password',
          updatedAt: 1_700_000_000_000,
        },
      ],
      watchedEpisodesBitfields: [
        {
          seriesKey: 'series-1',
          bitsB64: encodeEpisodeBitfield([0, 3, 5]),
          updatedAt: 1_700_000_000_000,
        },
      ],
    };

    const blob = await encryptVaultSnapshot(crypto, bundle.vaultKey, 'usr_abc', 4, snapshot);
    // Ciphertext must never leak plaintext secrets
    expect(blob.ciphertext).not.toContain('super-secret-provider-password');
    expect(blob.ciphertext).not.toContain('provider.invalid');

    const decrypted = await decryptVaultSnapshot(crypto, bundle.vaultKey, 'usr_abc', 4, blob);
    expect(decrypted).toEqual(snapshot);

    // Wrong userId or revision (AAD mismatch) must fail
    await expect(
      decryptVaultSnapshot(crypto, bundle.vaultKey, 'usr_other', 4, blob),
    ).rejects.toThrow();
    await expect(
      decryptVaultSnapshot(crypto, bundle.vaultKey, 'usr_abc', 5, blob),
    ).rejects.toThrow();

    // Tampered auth tag must fail
    const rawCt = base64UrlDecode(blob.ciphertext);
    rawCt[rawCt.length - 1] = (rawCt[rawCt.length - 1] ?? 0) ^ 0xff;
    await expect(
      decryptVaultSnapshot(crypto, bundle.vaultKey, 'usr_abc', 4, {
        iv: blob.iv,
        ciphertext: base64UrlEncode(rawCt),
      }),
    ).rejects.toThrow();

    // Bad IV length or bad key length fail cleanly
    await expect(
      decryptVaultSnapshot(crypto, bundle.vaultKey, 'usr_abc', 4, {
        iv: base64UrlEncode(new Uint8Array(8)),
        ciphertext: blob.ciphertext,
      }),
    ).rejects.toThrow();
    await expect(
      encryptVaultSnapshot(crypto, new Uint8Array(16), 'usr_abc', 4, snapshot),
    ).rejects.toThrow();
  });
});
