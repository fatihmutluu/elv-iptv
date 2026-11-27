import { concatBytes } from './encoding';
import { hmacSha256 } from './pure-crypto';

/** Exact byte length of X25519 private keys, public keys, and shared secrets (RFC 7748). */
export const X25519_KEY_BYTES = 32;

/** Standard Curve25519 generator u-coordinate `u = 9` in little-endian 32-byte encoding. */
export const X25519_BASEPOINT: Uint8Array = (() => {
  const base = new Uint8Array(X25519_KEY_BYTES);
  base[0] = 9;
  return base;
})();

/** Ephemeral X25519 private/public key pair. */
export interface X25519KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** SHA-256 hash output length in bytes used by HKDF-SHA256 (RFC 5869). */
export const HKDF_SHA256_HASH_LEN = 32;

/** Maximum output byte length permitted by RFC 5869 HKDF-SHA256 (`255 * HashLen`). */
export const HKDF_SHA256_MAX_OUTPUT_BYTES = 255 * HKDF_SHA256_HASH_LEN;

const GF_A24 = (() => {
  const f = new Float64Array(16);
  // a24 = (486662 - 2) / 4 = 121665 = 0x1db41 = 1 * 65536 + 0xdb41
  f[0] = 0xdb41;
  f[1] = 1;
  return f;
})();

/** Constant-time check returning `true` when every byte in `bytes` is `0x00`. */
export function isAllZeroBytes(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    acc |= bytes[i] ?? 0;
  }
  return acc === 0;
}

function gfAdd(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i] = (a[i] ?? 0) + (b[i] ?? 0);
  }
}

function gfSub(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i] = (a[i] ?? 0) - (b[i] ?? 0);
  }
}

function car25519(o: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    const val = (o[i] ?? 0) + 65536;
    const carry = Math.floor(val / 65536);
    const nextIdx = i < 15 ? i + 1 : 0;
    const wrapFactor = i === 15 ? 38 : 1;
    o[nextIdx] = (o[nextIdx] ?? 0) + (carry - 1) * wrapFactor;
    o[i] = val - carry * 65536;
  }
}

function sel25519(p: Float64Array, q: Float64Array, swapBit: number): void {
  const mask = ~(swapBit - 1);
  for (let i = 0; i < 16; i += 1) {
    const pi = p[i] ?? 0;
    const qi = q[i] ?? 0;
    const diff = mask & (pi ^ qi);
    p[i] = pi ^ diff;
    q[i] = qi ^ diff;
  }
}

function gfMul(o: Float64Array, a: Float64Array, b: Float64Array): void {
  const t = new Float64Array(31);
  for (let i = 0; i < 16; i += 1) {
    const ai = a[i] ?? 0;
    for (let j = 0; j < 16; j += 1) {
      t[i + j] = (t[i + j] ?? 0) + ai * (b[j] ?? 0);
    }
  }
  for (let i = 0; i < 15; i += 1) {
    t[i] = (t[i] ?? 0) + 38 * (t[i + 16] ?? 0);
  }
  for (let i = 0; i < 16; i += 1) {
    o[i] = t[i] ?? 0;
  }
  car25519(o);
  car25519(o);
}

function gfSq(o: Float64Array, a: Float64Array): void {
  gfMul(o, a, a);
}

function inv25519(o: Float64Array, input: Float64Array): void {
  const c = new Float64Array(16);
  for (let i = 0; i < 16; i += 1) c[i] = input[i] ?? 0;
  for (let a = 253; a >= 0; a -= 1) {
    gfSq(c, c);
    if (a !== 2 && a !== 4) {
      gfMul(c, c, input);
    }
  }
  for (let i = 0; i < 16; i += 1) o[i] = c[i] ?? 0;
}

function unpack25519(o: Float64Array, bytes: Uint8Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i] = (bytes[2 * i] ?? 0) + ((bytes[2 * i + 1] ?? 0) << 8);
  }
  // RFC 7748 §5: mask the most significant bit of u-coordinates.
  o[15] = (o[15] ?? 0) & 0x7fff;
}

function pack25519(out: Uint8Array, n: Float64Array): void {
  const t = new Float64Array(16);
  const m = new Float64Array(16);
  for (let i = 0; i < 16; i += 1) t[i] = n[i] ?? 0;
  car25519(t);
  car25519(t);
  car25519(t);

  for (let round = 0; round < 2; round += 1) {
    m[0] = (t[0] ?? 0) - 0xffed;
    for (let i = 1; i < 15; i += 1) {
      const prev = m[i - 1] ?? 0;
      m[i] = (t[i] ?? 0) - 0xffff - ((prev >> 16) & 1);
      m[i - 1] = prev & 0xffff;
    }
    const prev14 = m[14] ?? 0;
    m[15] = (t[15] ?? 0) - 0x7fff - ((prev14 >> 16) & 1);
    const borrow = ((m[15] ?? 0) >> 16) & 1;
    m[14] = prev14 & 0xffff;
    sel25519(t, m, 1 - borrow);
  }

  for (let i = 0; i < 16; i += 1) {
    const limb = t[i] ?? 0;
    out[2 * i] = limb & 0xff;
    out[2 * i + 1] = (limb >> 8) & 0xff;
  }
}

/**
 * Pure-JS constant-time RFC 7748 X25519 scalar multiplication over GF(2^255 - 19).
 * Validates exact 32-byte key lengths and rejects all-zero shared secrets from low-order points
 * per RFC 7748 §6.1. Compatible with Hermes, Node, browsers, and Cloudflare Workers.
 */
export function x25519(scalar: Uint8Array, uCoord: Uint8Array): Uint8Array {
  if (scalar.length !== X25519_KEY_BYTES) {
    throw new Error(`X25519 scalar must be exactly ${X25519_KEY_BYTES} bytes`);
  }
  if (uCoord.length !== X25519_KEY_BYTES) {
    throw new Error(`X25519 u-coordinate must be exactly ${X25519_KEY_BYTES} bytes`);
  }

  const clamped = new Uint8Array(scalar);
  try {
    clamped[0] = (clamped[0] ?? 0) & 248;
    clamped[31] = ((clamped[31] ?? 0) & 127) | 64;

    const x1 = new Float64Array(16);
    unpack25519(x1, uCoord);

    const x2 = new Float64Array(16);
    const z2 = new Float64Array(16);
    const x3 = new Float64Array(16);
    const z3 = new Float64Array(16);
    x2[0] = 1;
    for (let i = 0; i < 16; i += 1) x3[i] = x1[i] ?? 0;
    z3[0] = 1;

    const a = new Float64Array(16);
    const aa = new Float64Array(16);
    const b = new Float64Array(16);
    const bb = new Float64Array(16);
    const e = new Float64Array(16);
    const c = new Float64Array(16);
    const d = new Float64Array(16);
    const da = new Float64Array(16);
    const cb = new Float64Array(16);
    const tmp = new Float64Array(16);

    let swap = 0;
    for (let bit = 254; bit >= 0; bit -= 1) {
      const kBit = ((clamped[bit >>> 3] ?? 0) >>> (bit & 7)) & 1;
      swap ^= kBit;
      sel25519(x2, x3, swap);
      sel25519(z2, z3, swap);
      swap = kBit;

      gfAdd(a, x2, z2);
      gfSq(aa, a);
      gfSub(b, x2, z2);
      gfSq(bb, b);
      gfSub(e, aa, bb);
      gfAdd(c, x3, z3);
      gfSub(d, x3, z3);
      gfMul(da, d, a);
      gfMul(cb, c, b);

      gfAdd(tmp, da, cb);
      gfSq(x3, tmp);
      gfSub(tmp, da, cb);
      gfSq(z3, tmp);
      gfMul(z3, z3, x1);

      gfMul(x2, aa, bb);
      gfMul(tmp, e, GF_A24);
      gfAdd(tmp, aa, tmp);
      gfMul(z2, e, tmp);
    }

    sel25519(x2, x3, swap);
    sel25519(z2, z3, swap);

    inv25519(z2, z2);
    gfMul(x2, x2, z2);

    const out = new Uint8Array(X25519_KEY_BYTES);
    pack25519(out, x2);

    if (isAllZeroBytes(out)) {
      throw new Error('X25519 shared secret is all zeros (low-order point)');
    }
    return out;
  } finally {
    clamped.fill(0);
  }
}

/** Derives the 32-byte X25519 public key corresponding to a 32-byte private key. */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519(privateKey, X25519_BASEPOINT);
}

/** Generates a fresh ephemeral X25519 key pair from a CSPRNG byte source. */
export function generateX25519KeyPair(randomBytes: (length: number) => Uint8Array): X25519KeyPair {
  const privateKey = randomBytes(X25519_KEY_BYTES);
  if (privateKey.length !== X25519_KEY_BYTES) {
    throw new Error(`CSPRNG must return ${X25519_KEY_BYTES} bytes for X25519 private key`);
  }
  const publicKey = x25519PublicKey(privateKey);
  return { privateKey, publicKey };
}

/** RFC 5869 §2.2 HKDF-Extract using HMAC-SHA256. */
export function hkdfExtract(salt: Uint8Array | undefined, ikm: Uint8Array): Uint8Array {
  const actualSalt =
    salt !== undefined && salt.length > 0 ? salt : new Uint8Array(HKDF_SHA256_HASH_LEN);
  return hmacSha256(actualSalt, ikm);
}

/** RFC 5869 §2.3 HKDF-Expand using HMAC-SHA256. */
export function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array {
  if (prk.length < HKDF_SHA256_HASH_LEN) {
    throw new Error(`HKDF-Expand PRK must be at least ${HKDF_SHA256_HASH_LEN} bytes`);
  }
  if (!Number.isInteger(length) || length < 1 || length > HKDF_SHA256_MAX_OUTPUT_BYTES) {
    throw new Error(
      `HKDF-Expand length must be an integer between 1 and ${HKDF_SHA256_MAX_OUTPUT_BYTES}`,
    );
  }
  const actualInfo = info ?? new Uint8Array(0);
  const blocks = Math.ceil(length / HKDF_SHA256_HASH_LEN);
  const okm = new Uint8Array(blocks * HKDF_SHA256_HASH_LEN);
  let prev: Uint8Array = new Uint8Array(0);
  const counter = new Uint8Array(1);

  for (let i = 1; i <= blocks; i += 1) {
    counter[0] = i;
    const stepInput = concatBytes(prev, actualInfo, counter);
    prev = hmacSha256(prk, stepInput);
    okm.set(prev, (i - 1) * HKDF_SHA256_HASH_LEN);
  }
  return okm.slice(0, length);
}

/** RFC 5869 HKDF-SHA256 (Extract followed by Expand). */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}
