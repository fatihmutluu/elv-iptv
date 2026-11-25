import { describe, expect, it, vi } from 'vitest';
import { base64UrlDecode, base64UrlEncode } from './encoding';
import { createPureJsVaultCryptoPort, createWebCryptoVaultPort } from './pure-crypto';
import {
  createNewVaultBundle,
  decryptVaultSnapshot,
  deriveAuthVerifier,
  encryptVaultSnapshot,
  formatRecoveryCode,
  isValidKdfIterations,
  MAX_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  normalizeRecoveryCode,
  unlockVaultWithPassword,
  unlockVaultWithRecoveryCode,
} from './vault-crypto';
import {
  createEmptyVaultSnapshot,
  encodeEpisodeBitfield,
  mergeVaultSnapshots,
  type VaultSnapshot,
} from './vault-merge';

const TEST_ITERATIONS = MIN_KDF_ITERATIONS;

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
    const crypto = createWebCryptoVaultPort(globalThis.crypto.subtle, (arr) =>
      globalThis.crypto.getRandomValues(arr),
    );
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
    const crypto = createWebCryptoVaultPort(globalThis.crypto.subtle, (arr) =>
      globalThis.crypto.getRandomValues(arr),
    );
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

  it('enforces KDF iteration bounds [MIN_KDF_ITERATIONS, MAX_KDF_ITERATIONS] across all vault KDF entrypoints', async () => {
    expect(MIN_KDF_ITERATIONS).toBe(100_000);
    expect(MAX_KDF_ITERATIONS).toBe(5_000_000);
    expect(isValidKdfIterations(MIN_KDF_ITERATIONS)).toBe(true);
    expect(isValidKdfIterations(MAX_KDF_ITERATIONS)).toBe(true);
    expect(isValidKdfIterations(MIN_KDF_ITERATIONS - 1)).toBe(false);
    expect(isValidKdfIterations(MAX_KDF_ITERATIONS + 1)).toBe(false);
    expect(isValidKdfIterations(100_000.5)).toBe(false);
    expect(isValidKdfIterations(Number.NaN)).toBe(false);
    expect(isValidKdfIterations(Number.POSITIVE_INFINITY)).toBe(false);

    const crypto = createPureJsVaultCryptoPort(seededRandom(41));
    const deriveSpy = vi.spyOn(crypto, 'deriveKeyPbkdf2');
    const recoveryCode = formatRecoveryCode(new Uint8Array(15).fill(0x22));

    for (const badIter of [
      0,
      -10,
      1,
      MIN_KDF_ITERATIONS - 1,
      MAX_KDF_ITERATIONS + 1,
      1_000_000_000,
      100_000.25,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        deriveAuthVerifier(crypto, 'alice@example.com', 'password-1234', badIter),
      ).rejects.toThrow(/KDF iterations/);
      await expect(
        createNewVaultBundle(crypto, 'alice@example.com', 'password-1234', badIter),
      ).rejects.toThrow(/KDF iterations/);
      await expect(
        unlockVaultWithPassword(crypto, 'password-1234', {
          kdfSalt: 'c2FsdA',
          kdfIterations: badIter,
          wrappedVaultKey: 'v1.aaaa.bbbb',
        }),
      ).rejects.toThrow(/KDF iterations/);
      await expect(
        unlockVaultWithRecoveryCode(crypto, recoveryCode, {
          kdfSalt: 'c2FsdA',
          kdfIterations: badIter,
          recoveryWrappedVaultKey: 'v1.aaaa.bbbb',
        }),
      ).rejects.toThrow(/KDF iterations/);
    }
    expect(deriveSpy).not.toHaveBeenCalled();
  });

  it('validates all VaultSnapshot collection fields in decryptVaultSnapshot so mergeVaultSnapshots never throws', async () => {
    const crypto = createPureJsVaultCryptoPort(seededRandom(61));
    const vaultKey = new Uint8Array(32).fill(0x42);
    const valid = createEmptyVaultSnapshot(1_700_000_000_000);

    const validBlob = await encryptVaultSnapshot(crypto, vaultKey, 'usr_1', 1, valid);
    const decryptedValid = await decryptVaultSnapshot(crypto, vaultKey, 'usr_1', 1, validBlob);
    expect(mergeVaultSnapshots(decryptedValid, createEmptyVaultSnapshot(0))).toEqual(valid);

    const collectionKeys = [
      'sources',
      'favorites',
      'hiddenChannels',
      'pinnedChannels',
      'customGroups',
      'collections',
      'watchProgress',
      'watchedEpisodesBitfields',
    ] as const;

    for (const key of collectionKeys) {
      const broken = { ...valid, [key]: { notAnArray: true } } as unknown as VaultSnapshot;
      const blob = await encryptVaultSnapshot(crypto, vaultKey, 'usr_1', 2, broken);
      await expect(decryptVaultSnapshot(crypto, vaultKey, 'usr_1', 2, blob)).rejects.toThrow(
        /Invalid vault snapshot structure/,
      );
    }

    const malformedPayloads: unknown[] = [
      null,
      [],
      { ...valid, schemaVersion: 99 },
      { ...valid, updatedAt: 'not-a-number' },
      { ...valid, sources: [null] },
      { ...valid, favorites: [{ updatedAt: 1 }] },
      { ...valid, watchedEpisodesBitfields: [{ seriesKey: 's1', updatedAt: 1 }] },
    ];
    for (const malformed of malformedPayloads) {
      const blob = await encryptVaultSnapshot(
        crypto,
        vaultKey,
        'usr_1',
        3,
        malformed as VaultSnapshot,
      );
      await expect(decryptVaultSnapshot(crypto, vaultKey, 'usr_1', 3, blob)).rejects.toThrow(
        /Invalid vault snapshot/,
      );
    }
  });
});
