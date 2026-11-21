import { describe, expect, it } from 'vitest';
import { decodeLegacyCodepage } from './codepages';

const WIN1256_TABLE = (() => {
  const map = new Map<string, number>();
  const td = new TextDecoder('windows-1256');
  for (let b = 0x20; b <= 0xff; b++) {
    map.set(td.decode(new Uint8Array([b])), b);
  }
  return map;
})();

const ISO8859_6_TABLE = (() => {
  const map = new Map<string, number>();
  const td = new TextDecoder('iso-8859-6');
  for (let b = 0x20; b <= 0xff; b++) {
    if (b >= 0x80 && b <= 0x9f) continue;
    const ch = td.decode(new Uint8Array([b]));
    if (ch !== '\ufffd') map.set(ch, b);
  }
  return map;
})();

const WIN1254_TABLE = (() => {
  const map = new Map<string, number>();
  const td = new TextDecoder('windows-1254');
  for (let b = 0x20; b <= 0xff; b++) {
    const ch = td.decode(new Uint8Array([b]));
    if (ch !== '\ufffd') map.set(ch, b);
  }
  return map;
})();

const WIN1252_TABLE = (() => {
  const map = new Map<string, number>();
  const td = new TextDecoder('windows-1252');
  for (let b = 0x20; b <= 0xff; b++) {
    const ch = td.decode(new Uint8Array([b]));
    if (ch !== '\ufffd') map.set(ch, b);
  }
  return map;
})();

function encodeWith(text: string, table: Map<string, number>): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\t' || ch === '\n' || ch === '\r') {
      out[i] = ch.charCodeAt(0);
      continue;
    }
    const b = table.get(ch);
    if (b === undefined) throw new Error(`unencodable char ${ch}`);
    out[i] = b;
  }
  return out;
}

describe('decodeLegacyCodepage (#329)', () => {
  it('decodes Windows-1256 Arabic text with and without Arabic timezone hints', () => {
    const title = 'نشرة الأخبار المسائية';
    const bytes = encodeWith(title, WIN1256_TABLE);
    expect(decodeLegacyCodepage(bytes, 'Asia/Riyadh')).toBe(title);
    expect(decodeLegacyCodepage(bytes, 'Africa/Cairo')).toBe(title);
    expect(decodeLegacyCodepage(bytes, 'Asia/Dubai')).toBe(title);
    expect(decodeLegacyCodepage(bytes)).toBe(title);
  });

  it('decodes Windows-1256 specific Persian/Urdu and Arabic punctuation bytes', () => {
    const sample = 'پخش چهره ژاله؛ گزارش کافه، ہفتہ؟';
    const bytes = encodeWith(sample, WIN1256_TABLE);
    expect(decodeLegacyCodepage(bytes, 'Asia/Baghdad')).toBe(sample);
    expect(decodeLegacyCodepage(bytes)).toBe(sample);

    // Short 2-letter Arabic word mixed with ASCII under an Arabic timezone hint
    const mixed = 'TV حي';
    expect(decodeLegacyCodepage(encodeWith(mixed, WIN1256_TABLE), 'Asia/Qatar')).toBe(mixed);
  });

  it('decodes ISO-8859-6 Arabic text and distinguishes it from Windows-1256', () => {
    const film = 'فيلم وثائقي';
    expect(decodeLegacyCodepage(encodeWith(film, ISO8859_6_TABLE), 'Africa/Cairo')).toBe(film);
    expect(decodeLegacyCodepage(encodeWith(film, ISO8859_6_TABLE))).toBe(film);

    const news = 'الأخبار';
    expect(decodeLegacyCodepage(encodeWith(news, ISO8859_6_TABLE), 'Asia/Beirut')).toBe(news);
    expect(decodeLegacyCodepage(encodeWith(news, WIN1256_TABLE), 'Asia/Beirut')).toBe(news);
  });

  it('decodes Windows-1254 Turkish text via byte heuristics and Europe/Istanbul hint', () => {
    const title = 'Akşam Haberleri: İstanbul Öğle Bülteni';
    const bytes = encodeWith(title, WIN1254_TABLE);
    expect(decodeLegacyCodepage(bytes, 'Europe/Istanbul')).toBe(title);
    expect(decodeLegacyCodepage(bytes)).toBe(title);

    const short = 'Çağdaş Yaşam';
    expect(decodeLegacyCodepage(encodeWith(short, WIN1254_TABLE))).toBe(short);
  });

  it('decodes Windows-1252 Western Latin text including smart punctuation and currency', () => {
    const french = 'L’Écran — Café de Paris (10€)';
    expect(decodeLegacyCodepage(encodeWith(french, WIN1252_TABLE), 'Europe/Paris')).toBe(french);
    expect(decodeLegacyCodepage(encodeWith(french, WIN1252_TABLE))).toBe(french);

    const german = 'Überraschung in München';
    expect(decodeLegacyCodepage(encodeWith(german, WIN1252_TABLE))).toBe(german);
  });

  it('preserves allowed whitespace (tab, LF, CR) inside legacy text and handles >4 KiB payloads', () => {
    const multiline = 'Café\tde\nParis\r\nDirect';
    expect(decodeLegacyCodepage(encodeWith(multiline, WIN1252_TABLE))).toBe(multiline);

    const longText = 'Café de Paris '.repeat(400);
    expect(decodeLegacyCodepage(encodeWith(longText, WIN1252_TABLE))).toBe(longText);

    // Under Europe/Istanbul hint, CP1252-only Ž (0x8e) falls back cleanly from 1254 to 1252
    const czech = 'Život v Praze';
    expect(decodeLegacyCodepage(encodeWith(czech, WIN1252_TABLE), 'Europe/Istanbul')).toBe(czech);
  });

  it('rejects empty input, disallowed control bytes, UTF-16 BOM pairs, unmapped bytes and gibberish', () => {
    expect(decodeLegacyCodepage(new Uint8Array(0))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0x20, 0x20]))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0x00, 0x41, 0xe9]))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0x01, 0x02, 0x03]))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0x7f, 0x61, 0xe9]))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0xfe, 0xff]))).toBeUndefined();
    // 0x8f is unmapped in CP1252 and Windows-1254 — must never emit U+FFFD
    const withUnmapped = decodeLegacyCodepage(new Uint8Array([0x43, 0x61, 0x66, 0x8f, 0x65]));
    expect(withUnmapped).toBeUndefined();
    // Accidental base64 decode of plain ASCII words like "News" -> [0x35, 0xec, 0x2c] ("5ì,")
    expect(decodeLegacyCodepage(new Uint8Array([0x35, 0xec, 0x2c]))).toBeUndefined();
    expect(decodeLegacyCodepage(new Uint8Array([0x2e, 0x2b, 0xde]))).toBeUndefined();
    // Suspicious symbol soup ("2‹âxÆ±")
    expect(
      decodeLegacyCodepage(new Uint8Array([0x32, 0x8b, 0xe2, 0x78, 0xc6, 0xb1])),
    ).toBeUndefined();
  });
});
