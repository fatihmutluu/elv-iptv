import { concatBytes, constantTimeEqual } from './encoding';
import type { VaultCryptoPort } from './ports';

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA_W = new Uint32Array(64);

function sha256Compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4;
    SHA_W[i] =
      (((block[j] ?? 0) << 24) |
        ((block[j + 1] ?? 0) << 16) |
        ((block[j + 2] ?? 0) << 8) |
        (block[j + 3] ?? 0)) >>>
      0;
  }
  for (let i = 16; i < 64; i += 1) {
    const w15 = SHA_W[i - 15] ?? 0;
    const w2 = SHA_W[i - 2] ?? 0;
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    SHA_W[i] = ((SHA_W[i - 16] ?? 0) + s0 + (SHA_W[i - 7] ?? 0) + s1) >>> 0;
  }

  let a = state[0] ?? 0;
  let b = state[1] ?? 0;
  let c = state[2] ?? 0;
  let d = state[3] ?? 0;
  let e = state[4] ?? 0;
  let f = state[5] ?? 0;
  let g = state[6] ?? 0;
  let h = state[7] ?? 0;

  for (let i = 0; i < 64; i += 1) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + S1 + ch + (SHA256_K[i] ?? 0) + (SHA_W[i] ?? 0)) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state[0] = ((state[0] ?? 0) + a) >>> 0;
  state[1] = ((state[1] ?? 0) + b) >>> 0;
  state[2] = ((state[2] ?? 0) + c) >>> 0;
  state[3] = ((state[3] ?? 0) + d) >>> 0;
  state[4] = ((state[4] ?? 0) + e) >>> 0;
  state[5] = ((state[5] ?? 0) + f) >>> 0;
  state[6] = ((state[6] ?? 0) + g) >>> 0;
  state[7] = ((state[7] ?? 0) + h) >>> 0;
}

function sha256Finalize(
  initialState: Uint32Array,
  prefixBytes: number,
  data: Uint8Array,
  out: Uint8Array,
): void {
  const state = new Uint32Array(initialState);
  let offset = 0;
  while (offset + 64 <= data.length) {
    sha256Compress(state, data, offset);
    offset += 64;
  }
  const rem = data.length - offset;
  const pad = new Uint8Array(rem < 56 ? 64 : 128);
  pad.set(data.subarray(offset), 0);
  pad[rem] = 0x80;
  const totalBits = (prefixBytes + data.length) * 8;
  const hi = Math.floor(totalBits / 0x100000000);
  const lo = totalBits >>> 0;
  const end = pad.length;
  pad[end - 8] = (hi >>> 24) & 0xff;
  pad[end - 7] = (hi >>> 16) & 0xff;
  pad[end - 6] = (hi >>> 8) & 0xff;
  pad[end - 5] = hi & 0xff;
  pad[end - 4] = (lo >>> 24) & 0xff;
  pad[end - 3] = (lo >>> 16) & 0xff;
  pad[end - 2] = (lo >>> 8) & 0xff;
  pad[end - 1] = lo & 0xff;

  sha256Compress(state, pad, 0);
  if (pad.length === 128) sha256Compress(state, pad, 64);

  for (let i = 0; i < 8; i += 1) {
    const word = state[i] ?? 0;
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  }
}

/** FIPS 180-4 SHA-256 digest (32 bytes). */
export function sha256(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  sha256Finalize(SHA256_IV, 0, data, out);
  return out;
}

interface HmacSha256Context {
  readonly innerState: Uint32Array;
  readonly outerState: Uint32Array;
}

function prepareHmacSha256(key: Uint8Array): HmacSha256Context {
  const keyBlock = new Uint8Array(64);
  if (key.length > 64) {
    keyBlock.set(sha256(key), 0);
  } else {
    keyBlock.set(key, 0);
  }
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const kb = keyBlock[i] ?? 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  const innerState = new Uint32Array(SHA256_IV);
  const outerState = new Uint32Array(SHA256_IV);
  sha256Compress(innerState, ipad, 0);
  sha256Compress(outerState, opad, 0);
  return { innerState, outerState };
}

function runHmacSha256(ctx: HmacSha256Context, message: Uint8Array, out: Uint8Array): void {
  const innerHash = new Uint8Array(32);
  sha256Finalize(ctx.innerState, 64, message, innerHash);
  sha256Finalize(ctx.outerState, 64, innerHash, out);
}

/** RFC 2104 HMAC-SHA256 (32 bytes). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const ctx = prepareHmacSha256(key);
  const out = new Uint8Array(32);
  runHmacSha256(ctx, message, out);
  return out;
}

/** RFC 2898 / RFC 6070 PBKDF2-HMAC-SHA256 key derivation. */
export function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  lengthBytes: number,
): Uint8Array {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('PBKDF2 iterations must be a positive integer');
  }
  if (!Number.isInteger(lengthBytes) || lengthBytes < 1) {
    throw new Error('PBKDF2 lengthBytes must be a positive integer');
  }
  const ctx = prepareHmacSha256(password);
  const blocks = Math.ceil(lengthBytes / 32);
  const derived = new Uint8Array(blocks * 32);
  const saltBlock = new Uint8Array(salt.length + 4);
  saltBlock.set(salt, 0);
  const u = new Uint8Array(32);
  const t = new Uint8Array(32);

  for (let blockIdx = 1; blockIdx <= blocks; blockIdx += 1) {
    saltBlock[salt.length] = (blockIdx >>> 24) & 0xff;
    saltBlock[salt.length + 1] = (blockIdx >>> 16) & 0xff;
    saltBlock[salt.length + 2] = (blockIdx >>> 8) & 0xff;
    saltBlock[salt.length + 3] = blockIdx & 0xff;

    runHmacSha256(ctx, saltBlock, u);
    t.set(u, 0);
    for (let iter = 1; iter < iterations; iter += 1) {
      runHmacSha256(ctx, u, u);
      for (let j = 0; j < 32; j += 1) {
        t[j] = (t[j] ?? 0) ^ (u[j] ?? 0);
      }
    }
    derived.set(t, (blockIdx - 1) * 32);
  }
  return derived.slice(0, lengthBytes);
}

// FIPS 197 AES S-Box
const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const AES_RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function subWord(w: number): number {
  return (
    (((AES_SBOX[(w >>> 24) & 0xff] ?? 0) << 24) |
      ((AES_SBOX[(w >>> 16) & 0xff] ?? 0) << 16) |
      ((AES_SBOX[(w >>> 8) & 0xff] ?? 0) << 8) |
      (AES_SBOX[w & 0xff] ?? 0)) >>>
    0
  );
}

function aesExpandKey(key: Uint8Array): { readonly rk: Uint8Array; readonly nr: number } {
  if (key.length !== 16 && key.length !== 32) {
    throw new Error('AES key must be 16 or 32 bytes');
  }
  const nk = key.length >> 2;
  const nr = nk + 6;
  const words = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i += 1) {
    words[i] =
      (((key[i * 4] ?? 0) << 24) |
        ((key[i * 4 + 1] ?? 0) << 16) |
        ((key[i * 4 + 2] ?? 0) << 8) |
        (key[i * 4 + 3] ?? 0)) >>>
      0;
  }
  for (let i = nk; i < words.length; i += 1) {
    let temp = words[i - 1] ?? 0;
    if (i % nk === 0) {
      const rot = ((temp << 8) | (temp >>> 24)) >>> 0;
      temp = (subWord(rot) ^ ((AES_RCON[i / nk] ?? 0) << 24)) >>> 0;
    } else if (nk > 6 && i % nk === 4) {
      temp = subWord(temp);
    }
    words[i] = ((words[i - nk] ?? 0) ^ temp) >>> 0;
  }
  const rk = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? 0;
    rk[i * 4] = (w >>> 24) & 0xff;
    rk[i * 4 + 1] = (w >>> 16) & 0xff;
    rk[i * 4 + 2] = (w >>> 8) & 0xff;
    rk[i * 4 + 3] = w & 0xff;
  }
  return { rk, nr };
}

function xtime(b: number): number {
  return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
}

function aesEncryptBlock(rk: Uint8Array, nr: number, input: Uint8Array, out: Uint8Array): void {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) s[i] = (input[i] ?? 0) ^ (rk[i] ?? 0);

  const tmp = new Uint8Array(16);
  for (let round = 1; round <= nr; round += 1) {
    // SubBytes + ShiftRows
    tmp[0] = AES_SBOX[s[0] ?? 0] ?? 0;
    tmp[1] = AES_SBOX[s[5] ?? 0] ?? 0;
    tmp[2] = AES_SBOX[s[10] ?? 0] ?? 0;
    tmp[3] = AES_SBOX[s[15] ?? 0] ?? 0;
    tmp[4] = AES_SBOX[s[4] ?? 0] ?? 0;
    tmp[5] = AES_SBOX[s[9] ?? 0] ?? 0;
    tmp[6] = AES_SBOX[s[14] ?? 0] ?? 0;
    tmp[7] = AES_SBOX[s[3] ?? 0] ?? 0;
    tmp[8] = AES_SBOX[s[8] ?? 0] ?? 0;
    tmp[9] = AES_SBOX[s[13] ?? 0] ?? 0;
    tmp[10] = AES_SBOX[s[2] ?? 0] ?? 0;
    tmp[11] = AES_SBOX[s[7] ?? 0] ?? 0;
    tmp[12] = AES_SBOX[s[12] ?? 0] ?? 0;
    tmp[13] = AES_SBOX[s[1] ?? 0] ?? 0;
    tmp[14] = AES_SBOX[s[6] ?? 0] ?? 0;
    tmp[15] = AES_SBOX[s[11] ?? 0] ?? 0;

    const rOff = round * 16;
    if (round < nr) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = tmp[c] ?? 0;
        const a1 = tmp[c + 1] ?? 0;
        const a2 = tmp[c + 2] ?? 0;
        const a3 = tmp[c + 3] ?? 0;
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[c] = a0 ^ t ^ xtime(a0 ^ a1) ^ (rk[rOff + c] ?? 0);
        s[c + 1] = a1 ^ t ^ xtime(a1 ^ a2) ^ (rk[rOff + c + 1] ?? 0);
        s[c + 2] = a2 ^ t ^ xtime(a2 ^ a3) ^ (rk[rOff + c + 2] ?? 0);
        s[c + 3] = a3 ^ t ^ xtime(a3 ^ a0) ^ (rk[rOff + c + 3] ?? 0);
      }
    } else {
      for (let i = 0; i < 16; i += 1) {
        out[i] = (tmp[i] ?? 0) ^ (rk[rOff + i] ?? 0);
      }
    }
  }
}

function ghashMul(y: Uint8Array, h: Uint8Array): void {
  let z0 = 0;
  let z1 = 0;
  let z2 = 0;
  let z3 = 0;
  let v0 = (((h[0] ?? 0) << 24) | ((h[1] ?? 0) << 16) | ((h[2] ?? 0) << 8) | (h[3] ?? 0)) >>> 0;
  let v1 = (((h[4] ?? 0) << 24) | ((h[5] ?? 0) << 16) | ((h[6] ?? 0) << 8) | (h[7] ?? 0)) >>> 0;
  let v2 = (((h[8] ?? 0) << 24) | ((h[9] ?? 0) << 16) | ((h[10] ?? 0) << 8) | (h[11] ?? 0)) >>> 0;
  let v3 = (((h[12] ?? 0) << 24) | ((h[13] ?? 0) << 16) | ((h[14] ?? 0) << 8) | (h[15] ?? 0)) >>> 0;

  for (let i = 0; i < 16; i += 1) {
    const byte = y[i] ?? 0;
    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((byte >>> bit) & 1) {
        z0 = (z0 ^ v0) >>> 0;
        z1 = (z1 ^ v1) >>> 0;
        z2 = (z2 ^ v2) >>> 0;
        z3 = (z3 ^ v3) >>> 0;
      }
      const lsb = v3 & 1;
      v3 = ((v3 >>> 1) | ((v2 & 1) << 31)) >>> 0;
      v2 = ((v2 >>> 1) | ((v1 & 1) << 31)) >>> 0;
      v1 = ((v1 >>> 1) | ((v0 & 1) << 31)) >>> 0;
      v0 = (v0 >>> 1) >>> 0;
      if (lsb !== 0) v0 = (v0 ^ 0xe1000000) >>> 0;
    }
  }
  const words = [z0, z1, z2, z3];
  for (let i = 0; i < 4; i += 1) {
    const w = words[i] ?? 0;
    y[i * 4] = (w >>> 24) & 0xff;
    y[i * 4 + 1] = (w >>> 16) & 0xff;
    y[i * 4 + 2] = (w >>> 8) & 0xff;
    y[i * 4 + 3] = w & 0xff;
  }
}

function ghashUpdate(y: Uint8Array, h: Uint8Array, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const blockLen = Math.min(16, data.length - offset);
    for (let i = 0; i < blockLen; i += 1) {
      y[i] = (y[i] ?? 0) ^ (data[offset + i] ?? 0);
    }
    ghashMul(y, h);
    offset += blockLen;
  }
}

function writeU64Be(target: Uint8Array, offset: number, bits: number): void {
  const hi = Math.floor(bits / 0x100000000);
  const lo = bits >>> 0;
  target[offset] = (hi >>> 24) & 0xff;
  target[offset + 1] = (hi >>> 16) & 0xff;
  target[offset + 2] = (hi >>> 8) & 0xff;
  target[offset + 3] = hi & 0xff;
  target[offset + 4] = (lo >>> 24) & 0xff;
  target[offset + 5] = (lo >>> 16) & 0xff;
  target[offset + 6] = (lo >>> 8) & 0xff;
  target[offset + 7] = lo & 0xff;
}

function inc32(counter: Uint8Array): void {
  const n =
    ((((counter[12] ?? 0) << 24) |
      ((counter[13] ?? 0) << 16) |
      ((counter[14] ?? 0) << 8) |
      (counter[15] ?? 0)) +
      1) >>>
    0;
  counter[12] = (n >>> 24) & 0xff;
  counter[13] = (n >>> 16) & 0xff;
  counter[14] = (n >>> 8) & 0xff;
  counter[15] = n & 0xff;
}

function buildJ0(h: Uint8Array, iv: Uint8Array): Uint8Array {
  if (iv.length === 0) throw new Error('AES-GCM IV must not be empty');
  const j0 = new Uint8Array(16);
  if (iv.length === 12) {
    j0.set(iv, 0);
    j0[15] = 1;
    return j0;
  }
  ghashUpdate(j0, h, iv);
  const lenBlock = new Uint8Array(16);
  writeU64Be(lenBlock, 8, iv.length * 8);
  ghashUpdate(j0, h, lenBlock);
  return j0;
}

function gctr(rk: Uint8Array, nr: number, icb: Uint8Array, input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  const cb = new Uint8Array(icb);
  const keystream = new Uint8Array(16);
  let offset = 0;
  while (offset < input.length) {
    aesEncryptBlock(rk, nr, cb, keystream);
    const n = Math.min(16, input.length - offset);
    for (let i = 0; i < n; i += 1) {
      out[offset + i] = (input[offset + i] ?? 0) ^ (keystream[i] ?? 0);
    }
    inc32(cb);
    offset += n;
  }
  return out;
}

function computeGcmTag(
  rk: Uint8Array,
  nr: number,
  h: Uint8Array,
  j0: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const s = new Uint8Array(16);
  if (aad.length > 0) ghashUpdate(s, h, aad);
  if (ciphertext.length > 0) ghashUpdate(s, h, ciphertext);
  const lenBlock = new Uint8Array(16);
  writeU64Be(lenBlock, 0, aad.length * 8);
  writeU64Be(lenBlock, 8, ciphertext.length * 8);
  ghashUpdate(s, h, lenBlock);
  const mask = new Uint8Array(16);
  aesEncryptBlock(rk, nr, j0, mask);
  for (let i = 0; i < 16; i += 1) s[i] = (s[i] ?? 0) ^ (mask[i] ?? 0);
  return s;
}

function aesGcmEncryptAny(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const { rk, nr } = aesExpandKey(key);
  const h = new Uint8Array(16);
  aesEncryptBlock(rk, nr, new Uint8Array(16), h);
  const j0 = buildJ0(h, iv);
  const cb = new Uint8Array(j0);
  inc32(cb);
  const ciphertext = gctr(rk, nr, cb, plaintext);
  const tag = computeGcmTag(rk, nr, h, j0, aad ?? new Uint8Array(0), ciphertext);
  return concatBytes(ciphertext, tag);
}

function aesGcmDecryptAny(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (ciphertextWithTag.length < 16) {
    throw new Error('AES-GCM ciphertext too short');
  }
  const { rk, nr } = aesExpandKey(key);
  const h = new Uint8Array(16);
  aesEncryptBlock(rk, nr, new Uint8Array(16), h);
  const j0 = buildJ0(h, iv);
  const split = ciphertextWithTag.length - 16;
  const ciphertext = ciphertextWithTag.subarray(0, split);
  const tag = ciphertextWithTag.subarray(split);
  const expectedTag = computeGcmTag(rk, nr, h, j0, aad ?? new Uint8Array(0), ciphertext);
  if (!constantTimeEqual(tag, expectedTag)) {
    throw new Error('AES-GCM authentication failed');
  }
  const cb = new Uint8Array(j0);
  inc32(cb);
  return gctr(rk, nr, cb, ciphertext);
}

/** NIST SP 800-38D AES-256-GCM encryption returning `ciphertext || 16-byte tag`. */
export function aes256GcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key');
  return aesGcmEncryptAny(key, iv, plaintext, aad);
}

/** NIST SP 800-38D AES-256-GCM decryption verifying the 16-byte authentication tag. */
export function aes256GcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key');
  return aesGcmDecryptAny(key, iv, ciphertextWithTag, aad);
}

/** Creates a pure-JS {@link VaultCryptoPort} identical across Hermes, Node, and Workers. */
export function createPureJsVaultCryptoPort(
  randomBytes: (length: number) => Uint8Array,
): VaultCryptoPort {
  return {
    randomBytes,
    async sha256(data) {
      return sha256(data);
    },
    async deriveKeyPbkdf2(password, salt, iterations, lengthBytes) {
      return pbkdf2Sha256(password, salt, iterations, lengthBytes);
    },
    async encryptAesGcm(key, iv, plaintext, aad) {
      return aesGcmEncryptAny(key, iv, plaintext, aad);
    },
    async decryptAesGcm(key, iv, ciphertext, aad) {
      return aesGcmDecryptAny(key, iv, ciphertext, aad);
    },
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Creates a {@link VaultCryptoPort} backed by Web Crypto `SubtleCrypto`. */
export function createWebCryptoVaultPort(
  subtle: SubtleCrypto,
  getRandomValues: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
): VaultCryptoPort {
  return {
    randomBytes(length: number): Uint8Array {
      const out = new Uint8Array(new ArrayBuffer(length));
      if (length > 0) getRandomValues(out);
      return out;
    },
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = await subtle.digest('SHA-256', toArrayBuffer(data));
      return new Uint8Array(digest);
    },
    async deriveKeyPbkdf2(
      password: Uint8Array,
      salt: Uint8Array,
      iterations: number,
      lengthBytes: number,
    ): Promise<Uint8Array> {
      const baseKey = await subtle.importKey('raw', toArrayBuffer(password), 'PBKDF2', false, [
        'deriveBits',
      ]);
      const bits = await subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: toArrayBuffer(salt),
          iterations,
        },
        baseKey,
        lengthBytes * 8,
      );
      return new Uint8Array(bits);
    },
    async encryptAesGcm(
      key: Uint8Array,
      iv: Uint8Array,
      plaintext: Uint8Array,
      aad?: Uint8Array,
    ): Promise<Uint8Array> {
      const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, [
        'encrypt',
      ]);
      const params: AesGcmParams =
        aad !== undefined
          ? { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) }
          : { name: 'AES-GCM', iv: toArrayBuffer(iv) };
      const out = await subtle.encrypt(params, cryptoKey, toArrayBuffer(plaintext));
      return new Uint8Array(out);
    },
    async decryptAesGcm(
      key: Uint8Array,
      iv: Uint8Array,
      ciphertext: Uint8Array,
      aad?: Uint8Array,
    ): Promise<Uint8Array> {
      const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, [
        'decrypt',
      ]);
      const params: AesGcmParams =
        aad !== undefined
          ? { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) }
          : { name: 'AES-GCM', iv: toArrayBuffer(iv) };
      const out = await subtle.decrypt(params, cryptoKey, toArrayBuffer(ciphertext));
      return new Uint8Array(out);
    },
  };
}
