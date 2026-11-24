import { describe, expect, it } from 'vitest';
import {
  fnv1a64Hex,
  hashCategoryRow,
  hashLiveRow,
  hashMovieRow,
  hashSeriesRow,
} from './content-hash';

describe('content-hash', () => {
  it('produces deterministic 16-character lowercase hex FNV-1a 64-bit digests', () => {
    const a = fnv1a64Hex(['News', 'news', 0]);
    const b = fnv1a64Hex(['News', 'news', 0]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('prevents field-boundary, null-vs-empty, and type-tag collisions', () => {
    expect(fnv1a64Hex(['ab', 'c'])).not.toBe(fnv1a64Hex(['a', 'bc']));
    expect(fnv1a64Hex(['', null])).not.toBe(fnv1a64Hex([null, '']));
    expect(fnv1a64Hex(['', ''])).not.toBe(fnv1a64Hex([null, null]));
    expect(fnv1a64Hex([1, '1'])).not.toBe(fnv1a64Hex(['1', 1]));
    // Both null and undefined represent SQL NULL and hash identically.
    expect(fnv1a64Hex([null, 'x'])).toBe(fnv1a64Hex([undefined, 'x']));
    // Signed zero normalizes identically to positive zero.
    expect(fnv1a64Hex([-0])).toBe(fnv1a64Hex([0]));
  });

  it('distinguishes non-ASCII / UTF-8 characters (Turkish, accented, emoji)', () => {
    const a = fnv1a64Hex(['İstanbul Haber']);
    const b = fnv1a64Hex(['Istanbul Haber']);
    const c = fnv1a64Hex(['Güneş 🎬']);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(c).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes category rows sensitively across name, nameFold, and position', () => {
    const base = hashCategoryRow({ name: 'News', nameFold: 'news', position: 0 });
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(hashCategoryRow({ name: 'News', nameFold: 'news', position: 0 })).toBe(base);
    expect(hashCategoryRow({ name: 'News HD', nameFold: 'news', position: 0 })).not.toBe(base);
    expect(hashCategoryRow({ name: 'News', nameFold: 'news hd', position: 0 })).not.toBe(base);
    expect(hashCategoryRow({ name: 'News', nameFold: 'news', position: 1 })).not.toBe(base);
  });

  it('hashes live rows sensitively across every persisted live column', () => {
    const input = {
      providerId: '101',
      num: 1,
      name: 'Channel 1',
      nameFold: 'channel 1',
      logo: 'http://img.example/1.png',
      guideId: 'ch1.tr',
      catchupDays: 3,
      catchupMode: 'append',
      catchupSourceTemplate: '{{c:src}}',
      urlTemplate: 'http://cdn.example/{{0}}/1.ts',
      headersJson: '{"userAgent":"ELV"}',
      backupUrlsJson: '["http://b.example/1.ts"]',
      epgShiftMs: 3_600_000,
    };
    const base = hashLiveRow(input);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(hashLiveRow({ ...input })).toBe(base);
    expect(hashLiveRow({ ...input, providerId: '102' })).not.toBe(base);
    expect(hashLiveRow({ ...input, num: 2 })).not.toBe(base);
    expect(hashLiveRow({ ...input, name: 'Channel 1 HD' })).not.toBe(base);
    expect(hashLiveRow({ ...input, logo: null })).not.toBe(base);
    expect(hashLiveRow({ ...input, guideId: 'ch2.tr' })).not.toBe(base);
    expect(hashLiveRow({ ...input, catchupDays: 7 })).not.toBe(base);
    expect(hashLiveRow({ ...input, catchupMode: 'flussonic' })).not.toBe(base);
    expect(hashLiveRow({ ...input, catchupSourceTemplate: null })).not.toBe(base);
    expect(hashLiveRow({ ...input, urlTemplate: 'http://cdn.example/{{0}}/2.ts' })).not.toBe(base);
    expect(hashLiveRow({ ...input, headersJson: null })).not.toBe(base);
    expect(hashLiveRow({ ...input, backupUrlsJson: null })).not.toBe(base);
    expect(hashLiveRow({ ...input, epgShiftMs: -3_600_000 })).not.toBe(base);
  });

  it('hashes movie rows sensitively across every persisted movie column', () => {
    const input = {
      providerId: '201',
      name: 'Film A',
      nameFold: 'film a',
      logo: 'http://img.example/a.png',
      rating: 7.5,
      year: 2025,
      extension: 'mkv',
      added: 1_700_000_000,
      urlTemplate: 'http://cdn.example/{{0}}/a.mkv',
      headersJson: null,
      backupUrlsJson: null,
    };
    const base = hashMovieRow(input);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(hashMovieRow({ ...input })).toBe(base);
    expect(hashMovieRow({ ...input, rating: 8.0 })).not.toBe(base);
    expect(hashMovieRow({ ...input, year: 2026 })).not.toBe(base);
    expect(hashMovieRow({ ...input, extension: 'mp4' })).not.toBe(base);
    expect(hashMovieRow({ ...input, added: 1_700_000_001 })).not.toBe(base);
    expect(hashMovieRow({ ...input, backupUrlsJson: '["http://b.example/a.mkv"]' })).not.toBe(base);
  });

  it('hashes series rows sensitively across every persisted series column', () => {
    const input = {
      providerId: '301',
      name: 'Show One',
      nameFold: 'show one',
      cover: 'http://img.example/s1.png',
      plot: 'A mystery unfolds.',
      rating: 8.7,
      year: 2026,
      lastModified: 1_700_000_500,
    };
    const base = hashSeriesRow(input);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(hashSeriesRow({ ...input })).toBe(base);
    expect(hashSeriesRow({ ...input, cover: null })).not.toBe(base);
    expect(hashSeriesRow({ ...input, plot: 'Updated synopsis.' })).not.toBe(base);
    expect(hashSeriesRow({ ...input, rating: 9.1 })).not.toBe(base);
    expect(hashSeriesRow({ ...input, year: 2025 })).not.toBe(base);
    expect(hashSeriesRow({ ...input, lastModified: 1_700_000_600 })).not.toBe(base);
  });

  it('matches the 64-bit BigInt FNV-1a specification across ASCII, UTF-8, emoji, numbers, and nulls', () => {
    const refFnv1a64 = (fields: readonly (string | number | null | undefined)[]): string => {
      let h = 0xcbf29ce484222325n;
      const feed = (bytes: Uint8Array) => {
        for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
      };
      const enc = new TextEncoder();
      for (const f of fields) {
        if (f === null || f === undefined) feed(new Uint8Array([0, 0]));
        else if (typeof f === 'number') {
          const text = String(Object.is(f, -0) ? 0 : f);
          feed(new Uint8Array([1]));
          feed(enc.encode(`${text.length}:${text}`));
          feed(new Uint8Array([0]));
        } else {
          feed(new Uint8Array([2]));
          feed(enc.encode(`${f.length}:`));
          feed(enc.encode(f));
          feed(new Uint8Array([0]));
        }
      }
      return h.toString(16).padStart(16, '0');
    };
    const vectors: readonly (readonly (string | number | null | undefined)[])[] = [
      [],
      [null, undefined, '', 0, -0],
      ['12345', 'İstanbul Şampiyonlar Ligi 🎬📺', 'istanbul sampiyonlar ligi', 7.85, 2026],
      ['A'.repeat(257), 'ÖÇŞİĞÜöçşığü', -42.5, 1_700_000_000, null],
    ];
    for (const v of vectors) {
      expect(fnv1a64Hex(v)).toBe(refFnv1a64(v));
    }
  });
});
