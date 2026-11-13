import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { utf8 } from './test-chunks';
import { ByteBuffer, decodeUtf8 } from './utf8';

const oracle = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('decodeUtf8', () => {
  it.each(['hello', 'İğüşöçı', 'مرحبا', '😀 a 🎉', ''])('matches TextDecoder for %s', (text) => {
    expect(decodeUtf8(utf8(text))).toBe(text);
  });

  it('matches TextDecoder for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => decodeUtf8(utf8(s)) === oracle(utf8(s))),
    );
  });

  it('matches TextDecoder for arbitrary bytes, including invalid ones', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (b) => decodeUtf8(b) === oracle(b)));
  });

  it('replaces invalid and truncated sequences with U+FFFD', () => {
    expect(decodeUtf8(Uint8Array.of(0x61, 0xff, 0x62))).toBe('a�b');
    expect(decodeUtf8(Uint8Array.of(0x61, 0xe2, 0x82))).toBe('a�');
    expect(decodeUtf8(Uint8Array.of(0xe2, 0x82, 0x61))).toBe('�a');
  });

  it('decodes a slice', () => {
    const bytes = utf8('abcİdef');
    expect(decodeUtf8(bytes, 1, 5)).toBe('bcİ');
    expect(decodeUtf8(bytes, 3)).toBe('İdef');
  });

  it('handles long inputs across internal slices', () => {
    const text = 'aş😀'.repeat(5000);
    expect(decodeUtf8(utf8(text))).toBe(text);
  });
});

describe('ByteBuffer', () => {
  it('keeps the unconsumed tail', () => {
    const buf = new ByteBuffer();
    buf.append(Uint8Array.of(1, 2, 3));
    buf.append(Uint8Array.of(4, 5));
    expect(buf.length).toBe(5);
    buf.consume(2);
    expect([...buf.view]).toEqual([3, 4, 5]);
    expect(buf.length).toBe(3);
    buf.consume(99);
    expect(buf.length).toBe(0);
    expect(buf.view.length).toBe(0);
  });

  it('survives growth and compaction', () => {
    const buf = new ByteBuffer();
    const expected: number[] = [];
    let n = 0;
    for (let round = 0; round < 500; round++) {
      const chunk = Uint8Array.from({ length: 1 + (round % 37) }, () => n++ & 0xff);
      expected.push(...chunk);
      buf.append(chunk);
      const drop = Math.min(expected.length, round % 29);
      buf.consume(drop);
      expected.splice(0, drop);
      expect(buf.length).toBe(expected.length);
    }
    expect([...buf.view]).toEqual(expected);
    buf.append(new Uint8Array(100_000));
    expect(buf.length).toBe(expected.length + 100_000);
  });
});
