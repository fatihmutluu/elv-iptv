import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  hexToBytes,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from './encoding';

describe('encoding utilities', () => {
  it('round-trips UTF-8 across ASCII, accented Latin, Turkish, CJK, and emoji', () => {
    const samples = [
      '',
      'hello world',
      'Şifre ve Eşitleme — Türkçe ğüşıöç',
      '日本語テスト',
      '📺🎬🚀🔒',
      'mix: café + 🎬 + ğ',
    ];
    for (const sample of samples) {
      const encoded = utf8Encode(sample);
      const native = new TextEncoder().encode(sample);
      expect(encoded).toEqual(native);
      expect(utf8ByteLength(sample)).toBe(native.byteLength);
      expect(utf8Decode(encoded)).toBe(sample);
    }
  });

  it('replaces unpaired surrogates and malformed UTF-8 bytes with U+FFFD', () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    expect(utf8Decode(utf8Encode(loneHigh))).toBe('\ufffd');
    expect(utf8Decode(utf8Encode(loneLow))).toBe('\ufffd');
    // Overlong 2-byte, invalid continuation, invalid 4-byte > U+10FFFF
    expect(utf8Decode(new Uint8Array([0xc0, 0xaf]))).toBe('\ufffd\ufffd');
    expect(utf8Decode(new Uint8Array([0xe0, 0x80, 0xaf]))).toBe('\ufffd\ufffd\ufffd');
    expect(utf8Decode(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))).toContain('\ufffd');
    expect(utf8Decode(new Uint8Array([0xc2, 0x20]))).toBe('\ufffd ');
  });

  it('round-trips base64url for all remainder lengths and rejects invalid input', () => {
    for (let len = 0; len <= 37; len += 1) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) bytes[i] = (i * 37 + 19) & 0xff;
      const encoded = base64UrlEncode(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(base64UrlDecode(encoded)).toEqual(bytes);
    }
    // Supports optional valid padding
    expect(base64UrlDecode('Zg==')).toEqual(utf8Encode('f'));
    expect(base64UrlDecode('Zm8=')).toEqual(utf8Encode('fo'));
    expect(() => base64UrlDecode('a')).toThrow();
    expect(() => base64UrlDecode('ab=')).toThrow();
    expect(() => base64UrlDecode('abc==')).toThrow();
    expect(() => base64UrlDecode('ab+c')).toThrow();
  });

  it('round-trips hex and base32 and compares bytes in constant time', () => {
    const raw = new Uint8Array([0x00, 0x0f, 0x10, 0xab, 0xcd, 0xef, 0xff]);
    const hex = bytesToHex(raw);
    expect(hex).toBe('000f10abcdefff');
    expect(hexToBytes(hex)).toEqual(raw);
    expect(hexToBytes('000F10ABCDEFFF')).toEqual(raw);
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();

    const recovery15 = new Uint8Array(15).map((_, i) => (i * 17 + 3) & 0xff);
    const b32 = base32Encode(recovery15);
    expect(b32).toHaveLength(24);
    expect(base32Decode(b32)).toEqual(recovery15);
    expect(
      base32Decode(`${b32.slice(0, 8)}-${b32.slice(8, 16)} ${b32.slice(16).toLowerCase()}`),
    ).toEqual(recovery15);
    expect(() => base32Decode('INVALID1!')).toThrow();

    expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    expect(constantTimeEqual(raw, new Uint8Array(raw))).toBe(true);
    const mutated = new Uint8Array(raw);
    mutated[6] = 0xfe;
    expect(constantTimeEqual(raw, mutated)).toBe(false);
    expect(constantTimeEqual(raw, raw.subarray(0, 6))).toBe(false);
  });
});
