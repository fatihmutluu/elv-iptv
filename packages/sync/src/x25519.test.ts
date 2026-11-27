import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from './encoding';
import {
  generateX25519KeyPair,
  HKDF_SHA256_MAX_OUTPUT_BYTES,
  hkdfExpand,
  hkdfExtract,
  hkdfSha256,
  isAllZeroBytes,
  X25519_BASEPOINT,
  X25519_KEY_BYTES,
  x25519,
  x25519PublicKey,
} from './x25519';

function seededRandom(seed = 12345): (len: number) => Uint8Array {
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

describe('RFC 7748 X25519 pure-JS Curve25519', () => {
  it('passes official RFC 7748 §6.1 Alice/Bob Diffie-Hellman test vectors', () => {
    const alicePriv = hexToBytes(
      '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
    );
    const alicePubExpected = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
    const bobPriv = hexToBytes('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    const bobPubExpected = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
    const sharedExpected = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

    const alicePrivCopy = new Uint8Array(alicePriv);
    const bobPrivCopy = new Uint8Array(bobPriv);

    const alicePub = x25519PublicKey(alicePriv);
    const bobPub = x25519PublicKey(bobPriv);
    expect(bytesToHex(alicePub)).toBe(alicePubExpected);
    expect(bytesToHex(bobPub)).toBe(bobPubExpected);

    // Must not mutate input key buffers
    expect(alicePriv).toEqual(alicePrivCopy);
    expect(bobPriv).toEqual(bobPrivCopy);

    const sharedAlice = x25519(alicePriv, bobPub);
    const sharedBob = x25519(bobPriv, alicePub);
    expect(bytesToHex(sharedAlice)).toBe(sharedExpected);
    expect(bytesToHex(sharedBob)).toBe(sharedExpected);
  });

  it('passes official RFC 7748 §5.2 scalar multiplication and iterated u=9 vectors (1x and 1000x)', () => {
    const s1 = hexToBytes('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
    const u1 = hexToBytes('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
    expect(bytesToHex(x25519(s1, u1))).toBe(
      'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
    );

    const s2 = hexToBytes('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d');
    const u2 = hexToBytes('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493');
    expect(bytesToHex(x25519(s2, u2))).toBe(
      '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957',
    );

    // Iterated k = u = 9
    let k: Uint8Array = new Uint8Array(X25519_BASEPOINT);
    let u: Uint8Array = new Uint8Array(X25519_BASEPOINT);
    let next = x25519(k, u);
    u = k;
    k = next;
    expect(bytesToHex(k)).toBe('422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079');

    for (let i = 1; i < 1000; i += 1) {
      next = x25519(k, u);
      u = k;
      k = next;
    }
    expect(bytesToHex(k)).toBe('684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51');
  }, 60_000);

  it('rejects small-order points (all-zero shared secret) and invalid key lengths', () => {
    const validPriv = hexToBytes(
      '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
    );
    const smallOrderPoints = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
      '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const hex of smallOrderPoints) {
      expect(() => x25519(validPriv, hexToBytes(hex))).toThrow(/all zeros|low-order/i);
    }

    expect(() => x25519(new Uint8Array(31), X25519_BASEPOINT)).toThrow(/32 bytes/);
    expect(() => x25519(validPriv, new Uint8Array(33))).toThrow(/32 bytes/);
    expect(() => x25519PublicKey(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(isAllZeroBytes(new Uint8Array(32))).toBe(true);
    expect(isAllZeroBytes(X25519_BASEPOINT)).toBe(false);
  });

  it('generates valid ephemeral keypairs that complete a symmetric DH exchange', () => {
    const rng = seededRandom(42);
    const kpA = generateX25519KeyPair(rng);
    const kpB = generateX25519KeyPair(rng);

    expect(kpA.privateKey).toHaveLength(X25519_KEY_BYTES);
    expect(kpA.publicKey).toHaveLength(X25519_KEY_BYTES);
    expect(kpB.privateKey).toHaveLength(X25519_KEY_BYTES);
    expect(kpB.publicKey).toHaveLength(X25519_KEY_BYTES);
    expect(kpA.publicKey).not.toEqual(kpB.publicKey);
    expect(x25519(kpA.privateKey, kpB.publicKey)).toEqual(x25519(kpB.privateKey, kpA.publicKey));
  });
});

describe('RFC 5869 HKDF-SHA256', () => {
  it('passes official RFC 5869 Appendix A Test Case 1', () => {
    const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const salt = hexToBytes('000102030405060708090a0b0c');
    const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');

    const prk = hkdfExtract(salt, ikm);
    expect(bytesToHex(prk)).toBe(
      '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
    );
    const okm = hkdfExpand(prk, info, 42);
    expect(bytesToHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
    expect(hkdfSha256(ikm, salt, info, 42)).toEqual(okm);
  });

  it('passes official RFC 5869 Appendix A Test Case 2 (longer inputs and outputs)', () => {
    const seq = (start: number, count: number): Uint8Array => {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) out[i] = (start + i) & 0xff;
      return out;
    };
    const ikm = seq(0x00, 80);
    const salt = seq(0x60, 80);
    const info = seq(0xb0, 80);

    const prk = hkdfExtract(salt, ikm);
    expect(bytesToHex(prk)).toBe(
      '06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244',
    );
    const okm = hkdfExpand(prk, info, 82);
    expect(bytesToHex(okm)).toBe(
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
    );
    expect(hkdfSha256(ikm, salt, info, 82)).toEqual(okm);
  });

  it('passes official RFC 5869 Appendix A Test Case 3 (zero-length / omitted salt and info) and guards bounds', () => {
    const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const expectedPrk = '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04';
    const expectedOkm =
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8';

    expect(bytesToHex(hkdfExtract(new Uint8Array(0), ikm))).toBe(expectedPrk);
    expect(bytesToHex(hkdfExtract(undefined, ikm))).toBe(expectedPrk);
    expect(bytesToHex(hkdfSha256(ikm, undefined, undefined, 42))).toBe(expectedOkm);

    const prk = hkdfExtract(undefined, ikm);
    expect(() => hkdfExpand(new Uint8Array(16), undefined, 32)).toThrow(/PRK/);
    expect(() => hkdfExpand(prk, undefined, 0)).toThrow(/length/);
    expect(() => hkdfExpand(prk, undefined, HKDF_SHA256_MAX_OUTPUT_BYTES + 1)).toThrow(/length/);
    expect(() => hkdfExpand(prk, undefined, 1.5)).toThrow(/length/);
  });
});
