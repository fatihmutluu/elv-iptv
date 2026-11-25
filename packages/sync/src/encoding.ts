const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64URL_DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i += 1) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const BASE32_DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE32_ALPHABET.length; i += 1) {
    table[BASE32_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const HEX_CHARS = '0123456789abcdef';

/** Returns the exact UTF-8 byte length of a string without allocating. */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Pure hand-written UTF-8 encoder safe across Hermes, Node, and Workers. */
export function utf8Encode(input: string): Uint8Array {
  const out = new Uint8Array(utf8ByteLength(input));
  let offset = 0;
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code <= 0x7f) {
      out[offset++] = code;
    } else if (code <= 0x7ff) {
      out[offset++] = 0xc0 | (code >> 6);
      out[offset++] = 0x80 | (code & 0x3f);
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
        out[offset++] = 0xf0 | (code >> 18);
        out[offset++] = 0x80 | ((code >> 12) & 0x3f);
        out[offset++] = 0x80 | ((code >> 6) & 0x3f);
        out[offset++] = 0x80 | (code & 0x3f);
        i += 1;
      } else {
        out[offset++] = 0xef;
        out[offset++] = 0xbf;
        out[offset++] = 0xbd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      out[offset++] = 0xef;
      out[offset++] = 0xbf;
      out[offset++] = 0xbd;
    } else {
      out[offset++] = 0xe0 | (code >> 12);
      out[offset++] = 0x80 | ((code >> 6) & 0x3f);
      out[offset++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/** Pure hand-written UTF-8 decoder safe across Hermes, Node, and Workers. */
export function utf8Decode(bytes: Uint8Array): string {
  const chars: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    if (b0 <= 0x7f) {
      chars.push(String.fromCharCode(b0));
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf && i + 1 < bytes.length) {
      const b1 = bytes[i + 1] ?? 0;
      if ((b1 & 0xc0) === 0x80) {
        chars.push(String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f)));
        i += 2;
      } else {
        chars.push('\ufffd');
        i += 1;
      }
    } else if (b0 >= 0xe0 && b0 <= 0xef && i + 2 < bytes.length) {
      const b1 = bytes[i + 1] ?? 0;
      const b2 = bytes[i + 2] ?? 0;
      const validSecond =
        (b1 & 0xc0) === 0x80 && (b0 !== 0xe0 || b1 >= 0xa0) && (b0 !== 0xed || b1 <= 0x9f);
      if (validSecond && (b2 & 0xc0) === 0x80) {
        const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        chars.push(String.fromCharCode(cp));
        i += 3;
      } else {
        chars.push('\ufffd');
        i += 1;
      }
    } else if (b0 >= 0xf0 && b0 <= 0xf4 && i + 3 < bytes.length) {
      const b1 = bytes[i + 1] ?? 0;
      const b2 = bytes[i + 2] ?? 0;
      const b3 = bytes[i + 3] ?? 0;
      const validSecond =
        (b1 & 0xc0) === 0x80 && (b0 !== 0xf0 || b1 >= 0x90) && (b0 !== 0xf4 || b1 <= 0x8f);
      if (validSecond && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
        const cp =
          (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) - 0x10000;
        chars.push(String.fromCharCode(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff)));
        i += 4;
      } else {
        chars.push('\ufffd');
        i += 1;
      }
    } else {
      chars.push('\ufffd');
      i += 1;
    }
  }
  return chars.join('');
}

/** Encodes raw bytes to unpadded RFC 4648 base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      B64URL_ALPHABET.charAt((n >> 18) & 0x3f) +
      B64URL_ALPHABET.charAt((n >> 12) & 0x3f) +
      B64URL_ALPHABET.charAt((n >> 6) & 0x3f) +
      B64URL_ALPHABET.charAt(n & 0x3f);
  }
  const rem = len - i;
  if (rem === 1) {
    const b0 = bytes[i] ?? 0;
    out += B64URL_ALPHABET.charAt(b0 >> 2) + B64URL_ALPHABET.charAt((b0 & 0x03) << 4);
  } else if (rem === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    out +=
      B64URL_ALPHABET.charAt(b0 >> 2) +
      B64URL_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4)) +
      B64URL_ALPHABET.charAt((b1 & 0x0f) << 2);
  }
  return out;
}

/** Decodes an RFC 4648 base64url string (unpadded or validly padded) into bytes. */
export function base64UrlDecode(input: string): Uint8Array {
  let str = input;
  if (str.endsWith('==')) {
    if (str.length % 4 !== 0) throw new Error('Invalid base64url padding');
    str = str.slice(0, -2);
  } else if (str.endsWith('=')) {
    if (str.length % 4 !== 0) throw new Error('Invalid base64url padding');
    str = str.slice(0, -1);
  }
  const rem = str.length % 4;
  if (rem === 1) throw new Error('Invalid base64url length');

  const byteLen = (str.length >> 2) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(byteLen);
  let outIdx = 0;

  const lookup = (idx: number): number => {
    const ch = str.charCodeAt(idx);
    const v = ch < 128 ? (B64URL_DECODE_TABLE[ch] ?? -1) : -1;
    if (v < 0) throw new Error('Invalid base64url character');
    return v;
  };

  let i = 0;
  for (; i + 3 < str.length; i += 4) {
    const n = (lookup(i) << 18) | (lookup(i + 1) << 12) | (lookup(i + 2) << 6) | lookup(i + 3);
    out[outIdx++] = (n >> 16) & 0xff;
    out[outIdx++] = (n >> 8) & 0xff;
    out[outIdx++] = n & 0xff;
  }
  if (rem === 2) {
    const a = lookup(i);
    const b = lookup(i + 1);
    out[outIdx++] = (a << 2) | (b >> 4);
  } else if (rem === 3) {
    const a = lookup(i);
    const b = lookup(i + 1);
    const c = lookup(i + 2);
    out[outIdx++] = (a << 2) | (b >> 4);
    out[outIdx++] = ((b & 0x0f) << 4) | (c >> 2);
  }
  return out;
}

/** Encodes bytes to lowercase hexadecimal string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    out += HEX_CHARS.charAt(b >> 4) + HEX_CHARS.charAt(b & 0x0f);
  }
  return out;
}

/** Decodes a hexadecimal string into raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = parseHexNibble(hex.charCodeAt(i * 2));
    const lo = parseHexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) throw new Error('Invalid hex character');
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function parseHexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/** Encodes bytes to unpadded RFC 4648 uppercase base32 (`A-Z`, `2-7`). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET.charAt((value >>> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 0x1f);
  }
  return out;
}

/** Decodes RFC 4648 base32 (case-insensitive, ignoring optional hyphens/spaces) into bytes. */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/[\s-]+/g, '').toUpperCase();
  const out = new Uint8Array(Math.floor((cleaned.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let outIdx = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const code = cleaned.charCodeAt(i);
    const v = code < 128 ? (BASE32_DECODE_TABLE[code] ?? -1) : -1;
    if (v < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (value >>> bits) & 0xff;
    }
  }
  return out.subarray(0, outIdx);
}

/** Concatenates multiple `Uint8Array` chunks into a single contiguous array. */
export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Constant-time byte comparison to prevent timing side-channels on MACs/tags/hashes. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
