import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from './encoding';
import {
  aes256GcmDecrypt,
  aes256GcmEncrypt,
  createPureJsVaultCryptoPort,
  createWebCryptoVaultPort,
  hmacSha256,
  pbkdf2Sha256,
  sha256,
} from './pure-crypto';

function deterministicRandom(seed = 1): (len: number) => Uint8Array {
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

describe('pure-crypto standard test vectors', () => {
  it('matches official FIPS 180-4 SHA-256 vectors', () => {
    expect(bytesToHex(sha256(utf8Encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(bytesToHex(sha256(utf8Encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      bytesToHex(sha256(utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // Multi-block input (> 64 bytes)
    expect(
      bytesToHex(
        sha256(
          utf8Encode(
            'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
          ),
        ),
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('matches official RFC 4231 HMAC-SHA256 vectors (short and >64-byte key)', () => {
    // RFC 4231 Test Case 1
    expect(bytesToHex(hmacSha256(hexToBytes('0b'.repeat(20)), utf8Encode('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    // RFC 4231 Test Case 6 (131-byte key > block size)
    expect(
      bytesToHex(
        hmacSha256(
          hexToBytes('aa'.repeat(131)),
          utf8Encode('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });

  it('matches official RFC 6070 / PBKDF2-HMAC-SHA256 test vectors', () => {
    expect(bytesToHex(pbkdf2Sha256(utf8Encode('password'), utf8Encode('salt'), 1, 32))).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    );
    expect(bytesToHex(pbkdf2Sha256(utf8Encode('password'), utf8Encode('salt'), 2, 32))).toBe(
      'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43',
    );
    expect(bytesToHex(pbkdf2Sha256(utf8Encode('password'), utf8Encode('salt'), 4096, 32))).toBe(
      'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
    );
    // Multi-block derived key (40 bytes)
    expect(
      bytesToHex(
        pbkdf2Sha256(
          utf8Encode('passwordPASSWORDpassword'),
          utf8Encode('saltSALTsaltSALTsaltSALTsaltSALTsalt'),
          4096,
          40,
        ),
      ),
    ).toBe('348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9');
    expect(() => pbkdf2Sha256(utf8Encode('p'), utf8Encode('s'), 0, 32)).toThrow();
    expect(() => pbkdf2Sha256(utf8Encode('p'), utf8Encode('s'), 1, 0)).toThrow();
  });

  it('matches official NIST SP 800-38D AES-256-GCM test vectors (Test Cases 13, 14, 15, 16, 17)', () => {
    // Test Case 13: zero key, zero 96-bit IV, empty PT, empty AAD
    const tc13 = aes256GcmEncrypt(
      hexToBytes('00'.repeat(32)),
      hexToBytes('00'.repeat(12)),
      new Uint8Array(0),
    );
    expect(bytesToHex(tc13)).toBe('530f8afbc74536b9a963b4f1c4cb738b');
    expect(
      aes256GcmDecrypt(hexToBytes('00'.repeat(32)), hexToBytes('00'.repeat(12)), tc13),
    ).toEqual(new Uint8Array(0));

    // Test Case 14: zero key, zero 96-bit IV, 16-byte zero PT, empty AAD
    const tc14 = aes256GcmEncrypt(
      hexToBytes('00'.repeat(32)),
      hexToBytes('00'.repeat(12)),
      hexToBytes('00'.repeat(16)),
    );
    expect(bytesToHex(tc14.subarray(0, 16))).toBe('cea7403d4d606b6e074ec5d3baf39d18');
    expect(bytesToHex(tc14.subarray(16))).toBe('d0d1c8a799996bf0265b98b5d48ab919');

    // Test Case 15: non-zero key, 96-bit IV, 60-byte PT, empty AAD
    const key15 = hexToBytes('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
    const iv15 = hexToBytes('cafebabefacedbaddecaf888');
    const pt15 = hexToBytes(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255',
    );
    const tc15 = aes256GcmEncrypt(key15, iv15, pt15);
    expect(bytesToHex(tc15.subarray(0, 64))).toBe(
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad',
    );
    expect(bytesToHex(tc15.subarray(64))).toBe('b094dac5d93471bdec1a502270e3cc6c');
    expect(aes256GcmDecrypt(key15, iv15, tc15)).toEqual(pt15);

    // Test Case 16: non-zero key, 96-bit IV, 60-byte PT, 20-byte AAD
    const pt16 = hexToBytes(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    );
    const aad16 = hexToBytes('feedfacedeadbeeffeedfacedeadbeefabaddad2');
    const tc16 = aes256GcmEncrypt(key15, iv15, pt16, aad16);
    expect(bytesToHex(tc16.subarray(0, 60))).toBe(
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662',
    );
    expect(bytesToHex(tc16.subarray(60))).toBe('76fc6ece0f4e1768cddf8853bb2d551b');
    expect(aes256GcmDecrypt(key15, iv15, tc16, aad16)).toEqual(pt16);

    // Test Case 17: non-96-bit IV (64-bit) with AAD
    const iv17 = hexToBytes('cafebabefacedbad');
    const tc17 = aes256GcmEncrypt(key15, iv17, pt16, aad16);
    expect(bytesToHex(tc17.subarray(0, 60))).toBe(
      'c3762df1ca787d32ae47c13bf19844cbaf1ae14d0b976afac52ff7d79bba9de0feb582d33934a4f0954cc2363bc73f7862ac430e64abe499f47c9b1f',
    );
    expect(bytesToHex(tc17.subarray(60))).toBe('3a337dbf46a792c45e454913fe2ea8f2');
    expect(aes256GcmDecrypt(key15, iv17, tc17, aad16)).toEqual(pt16);

    // Reject tampered tag, tampered AAD, short ciphertext, wrong key size
    const tampered = new Uint8Array(tc16);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => aes256GcmDecrypt(key15, iv15, tampered, aad16)).toThrow(/authentication failed/i);
    expect(() => aes256GcmDecrypt(key15, iv15, tc16, utf8Encode('wrong-aad'))).toThrow(
      /authentication failed/i,
    );
    expect(() => aes256GcmDecrypt(key15, iv15, new Uint8Array(15))).toThrow(/too short/i);
    expect(() => aes256GcmEncrypt(new Uint8Array(16), iv15, pt16)).toThrow(/32-byte/i);
    expect(() => aes256GcmDecrypt(new Uint8Array(16), iv15, tc16)).toThrow(/32-byte/i);
  });

  it('cross-operates identically between pureJs and webCrypto ports (AES-128 & AES-256, PBKDF2, SHA-256)', async () => {
    const purePort = createPureJsVaultCryptoPort(deterministicRandom(42));
    const webPort = createWebCryptoVaultPort(globalThis.crypto.subtle, (arr) =>
      globalThis.crypto.getRandomValues(arr),
    );

    const msg = utf8Encode('ELV IPTV zero-knowledge vault payload 🔒 — Türkçe');
    const aad = utf8Encode('elv-vault-blob-v1|usr_123|7');

    // SHA-256 parity
    expect(await purePort.sha256(msg)).toEqual(await webPort.sha256(msg));

    // PBKDF2-SHA256 parity
    const salt = webPort.randomBytes(16);
    const dkPure = await purePort.deriveKeyPbkdf2(utf8Encode('s3cr3t-passphrase!'), salt, 1000, 32);
    const dkWeb = await webPort.deriveKeyPbkdf2(utf8Encode('s3cr3t-passphrase!'), salt, 1000, 32);
    expect(dkPure).toEqual(dkWeb);

    // AES-256-GCM cross-test
    const key256 = webPort.randomBytes(32);
    const iv256 = webPort.randomBytes(12);
    const ctPure = await purePort.encryptAesGcm(key256, iv256, msg, aad);
    const ctWeb = await webPort.encryptAesGcm(key256, iv256, msg, aad);
    expect(ctPure).toEqual(ctWeb);
    expect(utf8Decode(await webPort.decryptAesGcm(key256, iv256, ctPure, aad))).toBe(
      utf8Decode(msg),
    );
    expect(utf8Decode(await purePort.decryptAesGcm(key256, iv256, ctWeb, aad))).toBe(
      utf8Decode(msg),
    );

    // AES-128-GCM cross-test (used by QR ephemeral 16-byte key)
    const key128 = webPort.randomBytes(16);
    const iv128 = webPort.randomBytes(12);
    const ct128Pure = await purePort.encryptAesGcm(key128, iv128, msg);
    const ct128Web = await webPort.encryptAesGcm(key128, iv128, msg);
    expect(ct128Pure).toEqual(ct128Web);
    expect(await webPort.decryptAesGcm(key128, iv128, ct128Pure)).toEqual(msg);
    expect(await purePort.decryptAesGcm(key128, iv128, ct128Web)).toEqual(msg);
  });
});
