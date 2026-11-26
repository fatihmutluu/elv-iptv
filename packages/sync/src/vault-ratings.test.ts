import { describe, expect, it } from 'vitest';
import { createPureJsVaultCryptoPort } from './pure-crypto';
import { decryptVaultSnapshot, encryptVaultSnapshot } from './vault-crypto';
import {
  createEmptyVaultSnapshot,
  mergeVaultSnapshots,
  type SyncRatingRecord,
  type VaultSnapshot,
} from './vault-merge';

describe('E2EE Sync Vault — ratings support', () => {
  it('omits ratings when both inputs omit it and merges LWW + tombstones deterministically', () => {
    const emptyA = createEmptyVaultSnapshot(100);
    const emptyB = createEmptyVaultSnapshot(200);
    const mergedEmpty = mergeVaultSnapshots(emptyA, emptyB);
    expect('ratings' in mergedEmpty).toBe(false);

    const r1Old: SyncRatingRecord = {
      key: 's1:movie:1',
      sourceId: 's1',
      kind: 'movie',
      value: 'like',
      title: 'Dune',
      year: 2021,
      rating: 8.3,
      updatedAt: 100,
    };
    const r1New: SyncRatingRecord = {
      ...r1Old,
      value: 'dislike',
      updatedAt: 200,
    };
    const r2Deleted: SyncRatingRecord = {
      key: 's1:series:2',
      sourceId: 's1',
      kind: 'series',
      value: 'like',
      title: 'Dark',
      updatedAt: 300,
      deleted: true,
    };
    const r2Old: SyncRatingRecord = {
      key: 's1:series:2',
      sourceId: 's1',
      kind: 'series',
      value: 'like',
      title: 'Dark',
      updatedAt: 150,
    };

    const local: VaultSnapshot = { ...emptyA, ratings: [r1Old, r2Old] };
    const remote: VaultSnapshot = { ...emptyB, ratings: [r1New, r2Deleted] };

    const mergedLR = mergeVaultSnapshots(local, remote);
    const mergedRL = mergeVaultSnapshots(remote, local);
    expect(mergedLR).toEqual(mergedRL);
    expect(mergedLR.ratings).toEqual([r1New, r2Deleted]);
  });

  it('encrypts/decrypts snapshots with ratings, stays backward-compatible without ratings, and rejects invalid rating entries', async () => {
    let seed = 1;
    const crypto = createPureJsVaultCryptoPort((len) => {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        seed = (seed * 31 + 17) & 0xff;
        out[i] = seed;
      }
      return out;
    });
    const vaultKey = crypto.randomBytes(32);

    // Backward-compatible: missing ratings field still decrypts cleanly
    const legacyBlob = await encryptVaultSnapshot(
      crypto,
      vaultKey,
      'user-1',
      1,
      createEmptyVaultSnapshot(100),
    );
    const legacyDecrypted = await decryptVaultSnapshot(crypto, vaultKey, 'user-1', 1, legacyBlob);
    expect(legacyDecrypted.ratings).toBeUndefined();

    // Valid ratings round-trip
    const withRatings: VaultSnapshot = {
      ...createEmptyVaultSnapshot(200),
      ratings: [
        {
          key: 's1:movie:1',
          sourceId: 's1',
          kind: 'movie',
          value: 'like',
          title: 'Dune',
          logo: 'https://cdn.example/dune.jpg',
          year: 2021,
          rating: 8.3,
          updatedAt: 200,
        },
        {
          key: 's1:series:2',
          sourceId: 's1',
          kind: 'series',
          value: 'dislike',
          title: 'Dark',
          updatedAt: 250,
          deleted: true,
        },
      ],
    };
    const blob = await encryptVaultSnapshot(crypto, vaultKey, 'user-1', 2, withRatings);
    const decrypted = await decryptVaultSnapshot(crypto, vaultKey, 'user-1', 2, blob);
    expect(decrypted.ratings).toEqual(withRatings.ratings);

    // Rejects Live TV kind or invalid rating value inside decrypted vault
    const invalidKind = {
      ...createEmptyVaultSnapshot(300),
      ratings: [
        {
          key: 's1:live:1',
          sourceId: 's1',
          kind: 'live',
          value: 'like',
          title: 'News',
          updatedAt: 300,
        },
      ],
    } as unknown as VaultSnapshot;
    const badBlob = await encryptVaultSnapshot(crypto, vaultKey, 'user-1', 3, invalidKind);
    await expect(decryptVaultSnapshot(crypto, vaultKey, 'user-1', 3, badBlob)).rejects.toThrow(
      'Invalid vault snapshot structure',
    );
  });
});
