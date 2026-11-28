import { openAsyncIterator } from '@elv/domain';
import { decodeCodepageSlice, type SingleByteCodepage } from './codepages';
import { decodeUtf8 } from './utf8';

const ARABIC_COMMON_HIGH = new Set([0xe1, 0xe3, 0xe4, 0xe5, 0xe6, 0xec, 0xed]);
const ARABIC_NON_LETTER_HIGH = new Set([
  0xd7, 0xe0, 0xe2, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xee, 0xef, 0xf4, 0xf7, 0xf9, 0xfb, 0xfc,
]);
const ARABIC_SPECIFIC_BYTES = new Set([0x81, 0x8d, 0x8e, 0x90, 0x98]);
const CYRILLIC_UPPER_VOWELS = new Set([0xc0, 0xc5, 0xc8, 0xce, 0xd3, 0xdf]);
const CYRILLIC_COMMON_VOWELS = new Set([
  0xa8, 0xaa, 0xaf, 0xb2, 0xb3, 0xb8, 0xba, 0xbf, 0xc0, 0xc5, 0xc8, 0xce, 0xd3, 0xdb, 0xdf, 0xe0,
  0xe5, 0xe8, 0xee, 0xf3, 0xfb, 0xff,
]);
const CYRILLIC_RARE_EY = new Set([0xdd, 0xde, 0xfd, 0xfe]);
const CYRILLIC_NO_START = new Set([0xda, 0xdc, 0xfa, 0xfc]);
const CYRILLIC_SPECIFIC_BYTES = new Set([0xa8, 0xaa, 0xaf, 0xb2, 0xb3, 0xb8]);
const SHARED_EXTRA_BYTES = new Set([0xba, 0xbf]);

function isAsciiLetter(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

function isScriptRunByte(b: number): boolean {
  return (
    b >= 0xc0 ||
    CYRILLIC_SPECIFIC_BYTES.has(b) ||
    ARABIC_SPECIFIC_BYTES.has(b) ||
    SHARED_EXTRA_BYTES.has(b)
  );
}

function isTurkishSpecificByte(b: number): boolean {
  return b === 0xd0 || b === 0xdd || b === 0xde || b === 0xf0 || b === 0xfd || b === 0xfe;
}

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

function detectSingleByteCodepage(
  bytes: Uint8Array,
  start: number,
  end: number,
): SingleByteCodepage {
  let turkishHits = 0;
  let attachedLatinHighBytes = 0;
  let unattachedCoreBytes = 0;
  let maxUnattachedCoreRun = 0;
  let arabicCommonHighHits = 0;
  let arabicSpecificHits = 0;
  let cp1251Score = 0;
  let cp1256Score = 0;

  let i = start;
  while (i < end) {
    const b = bytes[i] as number;
    if (isTurkishSpecificByte(b)) turkishHits++;
    if (!isScriptRunByte(b)) {
      i++;
      continue;
    }
    const runStart = i;
    const touchedBefore = runStart > start && isAsciiLetter(bytes[runStart - 1] as number);
    let coreBytes = 0;
    while (i < end && isScriptRunByte(bytes[i] as number)) {
      const cur = bytes[i] as number;
      if (i > runStart && isTurkishSpecificByte(cur)) turkishHits++;
      if (cur >= 0xc0) coreBytes++;
      i++;
    }
    const runEnd = i;
    const touchedAfter = runEnd < end && isAsciiLetter(bytes[runEnd] as number);
    if (touchedBefore || touchedAfter) {
      attachedLatinHighBytes += coreBytes;
      continue;
    }

    // Require >= 3 core (>= 0xC0) bytes so punctuation runs like "¿¿¿" or "ººº" never flip codepages.
    if (coreBytes < 3) continue;
    unattachedCoreBytes += coreBytes;
    if (coreBytes > maxUnattachedCoreRun) maxUnattachedCoreRun = coreBytes;

    const runLen = runEnd - runStart;
    let commonCyrillicVowels = 0;
    let rareCyrillicEyCount = 0;
    const firstByte = bytes[runStart] as number;
    if (CYRILLIC_NO_START.has(firstByte)) cp1251Score -= 12;
    if (
      runLen >= 2 &&
      firstByte >= 0xc0 &&
      firstByte <= 0xdf &&
      (bytes[runStart + 1] as number) >= 0xe0
    ) {
      cp1251Score += 6;
    }

    for (let k = runStart; k < runEnd; k++) {
      const cur = bytes[k] as number;
      const prev = k > runStart ? (bytes[k - 1] as number) : -1;
      const next = k + 1 < runEnd ? (bytes[k + 1] as number) : -1;

      if (CYRILLIC_COMMON_VOWELS.has(cur)) commonCyrillicVowels++;
      if (CYRILLIC_RARE_EY.has(cur)) rareCyrillicEyCount++;

      if (cur >= 0xc0) {
        cp1251Score += CYRILLIC_RARE_EY.has(cur) ? 1 : 3;
        if (cur <= 0xdf) {
          if (CYRILLIC_UPPER_VOWELS.has(cur)) cp1251Score += 2;
          if (prev >= 0xe0 && prev <= 0xff) cp1251Score -= 10;
          else if (prev >= 0xc0 && prev <= 0xdf && next >= 0xe0 && next <= 0xff) cp1251Score -= 4;
        } else if (prev >= 0xe0 && prev <= 0xff) {
          cp1251Score += 2;
        }
      } else if (CYRILLIC_SPECIFIC_BYTES.has(cur)) {
        cp1251Score += 4;
      } else if (SHARED_EXTRA_BYTES.has(cur)) {
        cp1251Score += 1;
      } else if (cur === 0x98) {
        cp1251Score -= 20;
      }

      if (cur >= 0xc1 && cur <= 0xdf && cur !== 0xd7) {
        cp1256Score += 2;
      } else if (ARABIC_COMMON_HIGH.has(cur)) {
        arabicCommonHighHits++;
        cp1256Score += 5;
      } else if (ARABIC_NON_LETTER_HIGH.has(cur)) {
        cp1256Score -= 8;
      } else if (ARABIC_SPECIFIC_BYTES.has(cur)) {
        arabicSpecificHits++;
        cp1256Score += 6;
      } else if (CYRILLIC_SPECIFIC_BYTES.has(cur)) {
        cp1256Score -= 6;
      } else if (cur === 0xfd || cur === 0xfe) {
        cp1256Score -= 4;
      } else if (
        cur === 0xc0 ||
        (cur >= 0xf0 && cur <= 0xf6) ||
        cur === 0xf8 ||
        cur === 0xfa ||
        cur === 0xff
      ) {
        cp1256Score += 1;
      }

      if ((prev === 0xc7 && cur === 0xe1) || (prev === 0xe1 && cur === 0xc7)) {
        cp1256Score += 6;
      }
    }

    if (rareCyrillicEyCount >= 2 && rareCyrillicEyCount * 2 >= runLen) {
      cp1251Score -= 15;
    }
    if (runLen <= 3 && commonCyrillicVowels === 0) {
      cp1251Score -= 10;
    }
  }

  if (arabicCommonHighHits === 0 && arabicSpecificHits === 0 && unattachedCoreBytes < 8) {
    cp1256Score = Math.min(cp1256Score, 0);
  }
  const latinPenalty = attachedLatinHighBytes * 6;
  cp1251Score -= latinPenalty;
  cp1256Score -= latinPenalty;

  const hasEnoughUnattached =
    maxUnattachedCoreRun >= 3 &&
    (attachedLatinHighBytes === 0 || unattachedCoreBytes >= attachedLatinHighBytes * 2);
  if (hasEnoughUnattached && Math.max(cp1251Score, cp1256Score) >= 8) {
    return cp1256Score > cp1251Score ? 'windows-1256' : 'windows-1251';
  }
  return turkishHits > 0 ? 'windows-1254' : 'windows-1252';
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
 * and automatic legacy `Windows-1251`, `Windows-1256`, `Windows-1254`, and `CP1252` fallback
 * when invalid UTF-8 bytes appear.
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
  return decodeCodepageSlice(
    bytes,
    bodyStart,
    end,
    detectSingleByteCodepage(bytes, bodyStart, end),
  );
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
