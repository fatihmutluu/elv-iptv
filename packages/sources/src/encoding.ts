import { openAsyncIterator } from '@elv/domain';
import { decodeUtf8 } from './utf8';

/** CP1252 / Windows-1254 shared 0x80–0x9F table (undefined bytes map to U+FFFD). */
const C1_TABLE: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

const WIN1254_OVERRIDES = new Map<number, number>([
  [0x8e, 0xfffd],
  [0x9e, 0xfffd],
  [0xd0, 0x011e], // Ğ
  [0xdd, 0x0130], // İ
  [0xde, 0x015e], // Ş
  [0xf0, 0x011f], // ğ
  [0xfd, 0x0131], // ı
  [0xfe, 0x015f], // ş
]);

function isValidUtf8(bytes: Uint8Array, start: number, end: number): boolean {
  let i = start;
  while (i < end) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
    } else {
      return false;
    }
    if (i + need >= end) return false;
    i++;
    for (let k = 0; k < need; k++) {
      const c = bytes[i] as number;
      if (c < lower || c > upper) return false;
      lower = 0x80;
      upper = 0xbf;
      i++;
    }
  }
  return true;
}

function prefersWindows1254(bytes: Uint8Array, start: number, end: number): boolean {
  let turkishHits = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    if (b === 0xd0 || b === 0xdd || b === 0xde || b === 0xf0 || b === 0xfd || b === 0xfe) {
      turkishHits++;
    }
  }
  return turkishHits > 0;
}

function decodeSingleByte(bytes: Uint8Array, start: number, end: number, turkish: boolean): string {
  const units: number[] = [];
  let out = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    let cp = b;
    if (b >= 0x80 && b <= 0x9f) {
      cp = (turkish ? WIN1254_OVERRIDES.get(b) : undefined) ?? C1_TABLE[b - 0x80] ?? 0xfffd;
    } else if (turkish) {
      cp = WIN1254_OVERRIDES.get(b) ?? b;
    }
    units.push(cp);
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

function decodeUtf16Units(bytes: Uint8Array, start: number, end: number, le: boolean): string {
  const units: number[] = [];
  let out = '';
  let i = start;
  while (i + 1 < end) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] as number;
    units.push(le ? b0 | (b1 << 8) : (b0 << 8) | b1);
    i += 2;
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (i < end) units.push(0xfffd);
  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

function decodeUtf32Units(bytes: Uint8Array, start: number, end: number, le: boolean): string {
  const units: number[] = [];
  let out = '';
  let i = start;
  while (i + 3 < end) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] as number;
    const b2 = bytes[i + 2] as number;
    const b3 = bytes[i + 3] as number;
    const cp = le
      ? (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
      : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      units.push(0xfffd);
    } else if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      units.push(cp);
    }
    i += 4;
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (i < end) units.push(0xfffd);
  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

/**
 * Pure text decoder supporting UTF-8 (with BOM strip), UTF-16LE/BE BOM, UTF-32LE/BE BOM,
 * and automatic Turkish `Windows-1254` / Western `CP1252` fallback when invalid UTF-8 bytes appear.
 */
export function detectAndDecodeText(
  bytes: Uint8Array,
  rawStart = 0,
  rawEnd: number = bytes.length,
): string {
  const start = Math.max(0, rawStart);
  const end = Math.min(rawEnd, bytes.length);
  const len = end - start;
  if (len <= 0) return '';

  if (
    len >= 4 &&
    bytes[start] === 0xff &&
    bytes[start + 1] === 0xfe &&
    bytes[start + 2] === 0x00 &&
    bytes[start + 3] === 0x00
  ) {
    return decodeUtf32Units(bytes, start + 4, end, true);
  }
  if (
    len >= 4 &&
    bytes[start] === 0x00 &&
    bytes[start + 1] === 0x00 &&
    bytes[start + 2] === 0xfe &&
    bytes[start + 3] === 0xff
  ) {
    return decodeUtf32Units(bytes, start + 4, end, false);
  }
  if (len >= 2 && bytes[start] === 0xff && bytes[start + 1] === 0xfe) {
    return decodeUtf16Units(bytes, start + 2, end, true);
  }
  if (len >= 2 && bytes[start] === 0xfe && bytes[start + 1] === 0xff) {
    return decodeUtf16Units(bytes, start + 2, end, false);
  }

  let bodyStart = start;
  if (len >= 3 && bytes[start] === 0xef && bytes[start + 1] === 0xbb && bytes[start + 2] === 0xbf) {
    bodyStart += 3;
  }

  if (isValidUtf8(bytes, bodyStart, end)) {
    return decodeUtf8(bytes, bodyStart, end);
  }
  return decodeSingleByte(bytes, bodyStart, end, prefersWindows1254(bytes, bodyStart, end));
}

function encodeStringToUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Streams byte chunks unchanged unless a leading UTF-16LE/BE or UTF-32LE/BE BOM is present, in
 * which case chunks are incrementally transcoded to UTF-8 so byte-level line framing works cleanly.
 * Calls `onBom` whenever any leading UTF-8/UTF-16/UTF-32 BOM is detected.
 */
export async function* normalizeBomChunks(
  chunks: AsyncIterable<Uint8Array>,
  onBom?: () => void,
): AsyncGenerator<Uint8Array> {
  const it = openAsyncIterator(chunks);
  let head: Uint8Array = new Uint8Array(0);
  try {
    while (head.length < 4) {
      const step = await it.next();
      if (step.done) break;
      if (step.value.length === 0) continue;
      const combined = new Uint8Array(head.length + step.value.length);
      combined.set(head, 0);
      combined.set(step.value, head.length);
      head = combined;
    }
    if (head.length === 0) return;

    let width = 0;
    let le = true;
    let skip = 0;
    if (
      head.length >= 4 &&
      head[0] === 0xff &&
      head[1] === 0xfe &&
      head[2] === 0x00 &&
      head[3] === 0x00
    ) {
      width = 4;
      le = true;
      skip = 4;
    } else if (
      head.length >= 4 &&
      head[0] === 0x00 &&
      head[1] === 0x00 &&
      head[2] === 0xfe &&
      head[3] === 0xff
    ) {
      width = 4;
      le = false;
      skip = 4;
    } else if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
      width = 2;
      le = true;
      skip = 2;
    } else if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
      width = 2;
      le = false;
      skip = 2;
    }

    if (width === 0) {
      if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        onBom?.();
      }
      yield head;
      for (;;) {
        const step = await it.next();
        if (step.done) break;
        yield step.value;
      }
      return;
    }
    onBom?.();

    let carry: Uint8Array = head.subarray(skip);
    const decodeSlice = (buf: Uint8Array, end: number): Uint8Array =>
      encodeStringToUtf8(
        width === 2 ? decodeUtf16Units(buf, 0, end, le) : decodeUtf32Units(buf, 0, end, le),
      );

    for (;;) {
      let aligned = carry.length - (carry.length % width);
      if (width === 2 && aligned >= 2) {
        const b0 = carry[aligned - 2] as number;
        const b1 = carry[aligned - 1] as number;
        const lastUnit = le ? b0 | (b1 << 8) : (b0 << 8) | b1;
        if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) aligned -= 2;
      }
      if (aligned > 0) {
        yield decodeSlice(carry, aligned);
        carry = carry.subarray(aligned);
      }
      const step = await it.next();
      if (step.done) break;
      if (step.value.length === 0) continue;
      if (carry.length === 0) {
        carry = step.value;
      } else {
        const merged = new Uint8Array(carry.length + step.value.length);
        merged.set(carry, 0);
        merged.set(step.value, carry.length);
        carry = merged;
      }
    }
    if (carry.length > 0) {
      yield decodeSlice(carry, carry.length);
    }
  } finally {
    await it.return?.();
  }
}
