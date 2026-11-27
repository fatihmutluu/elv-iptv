const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Default PBKDF2 iterations for server-side verifier storage hashing (Cloudflare Workers safe max). */
export const DEFAULT_VERIFIER_HASH_ITERATIONS = 100_000;

/** Default access token lifetime in seconds (15 minutes). */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;

/** Default refresh token lifetime in seconds (30 days). */
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/** Default QR pairing session lifetime in seconds (5 minutes). */
export const PAIR_SESSION_TTL_SEC = 5 * 60;

const MIN_JWT_SECRET_BYTES = 16;

/** Validates that `jwtSecret` has at least 16 non-whitespace characters/bytes. */
export function assertValidJwtSecret(secret: string): void {
  const trimmed = typeof secret === 'string' ? secret.trim() : '';
  if (
    trimmed.length < MIN_JWT_SECRET_BYTES ||
    encoder.encode(trimmed).byteLength < MIN_JWT_SECRET_BYTES
  ) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} non-whitespace characters/bytes.`,
    );
  }
}

const PAIRING_CODE_MODULO = 100_000_000;
const PAIRING_CODE_REJECTION_LIMIT =
  Math.floor(0x1_0000_0000 / PAIRING_CODE_MODULO) * PAIRING_CODE_MODULO;
const HEX_RE = /^[0-9a-fA-F]+$/;

/** Verified claims extracted from an HS256 JWT access token. */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly iat: number;
  readonly exp: number;
}

/** Encodes raw bytes into unpadded base64url. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Decodes a strict unpadded base64url string into bytes, returning null on invalid input. */
export function base64UrlDecode(input: string): Uint8Array | null {
  if (input.length === 0 || input.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    if (base64UrlEncode(out) !== input) return null;
    return out;
  } catch {
    return null;
  }
}

/** Encodes a UTF-8 string into unpadded base64url. */
function encodeUtf8Base64Url(value: string): string {
  return base64UrlEncode(encoder.encode(value));
}

/** Decodes a base64url string into UTF-8 text, returning null on invalid base64url. */
function decodeUtf8Base64Url(value: string): string | null {
  const bytes = base64UrlDecode(value);
  if (!bytes) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Generates `length` cryptographically random bytes using Web Crypto. */
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Generates a URL-safe base64url random token backed by `byteLength` random bytes. */
export function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(randomBytes(byteLength));
}

/** Generates a random opaque record identifier. */
export function randomId(): string {
  return crypto.randomUUID();
}

/** Generates an 8-digit numeric pairing code ("00000000"-"99999999") with rejection-sampled zero modulo bias. */
export function randomPairingCode(): string {
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    const value = buf[0] ?? 0;
    if (value < PAIRING_CODE_REJECTION_LIMIT) {
      return String(value % PAIRING_CODE_MODULO).padStart(8, '0');
    }
  }
}

/** Constant-time byte array equality check. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Computes SHA-256 of UTF-8 input and returns raw 32 bytes. */
async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return new Uint8Array(digest);
}

/** Computes SHA-256 of UTF-8 input and returns 64-char lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256Bytes(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

/** Constant-time equality comparison for non-empty hexadecimal strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const normA = a.toLowerCase();
  const normB = b.toLowerCase();
  const validHex = normA.length > 0 && normB.length > 0 && HEX_RE.test(normA) && HEX_RE.test(normB);
  const maxLen = Math.max(normA.length, normB.length);
  let diff = normA.length ^ normB.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (normA.charCodeAt(i) || 0) ^ (normB.charCodeAt(i) || 0);
  }
  return validHex && diff === 0;
}

/** Computes SHA-256 of UTF-8 input and returns unpadded base64url. */
export async function sha256Base64Url(input: string): Promise<string> {
  return base64UrlEncode(await sha256Bytes(input));
}

/** Constant-time string equality check via SHA-256 digests so string length is not leaked. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return timingSafeEqual(hashA, hashB);
}

async function derivePbkdf2Sha256(
  secret: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const saltBuffer = new Uint8Array(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Hashes a client-derived `authVerifier` with a fresh 16-byte random salt via PBKDF2-SHA256. */
export async function hashAuthVerifier(
  authVerifier: string,
  iterations = DEFAULT_VERIFIER_HASH_ITERATIONS,
): Promise<{ readonly hash: string; readonly salt: string; readonly iterations: number }> {
  const saltBytes = randomBytes(16);
  const derived = await derivePbkdf2Sha256(authVerifier, saltBytes, iterations);
  return {
    hash: base64UrlEncode(derived),
    salt: base64UrlEncode(saltBytes),
    iterations,
  };
}

/** Constant-time verification of a client `authVerifier` against a stored salted PBKDF2-SHA256 hash. */
export async function verifyAuthVerifier(
  authVerifier: string,
  saltBase64Url: string,
  iterations: number,
  expectedHashBase64Url: string,
): Promise<boolean> {
  const saltBytes = base64UrlDecode(saltBase64Url);
  const expectedBytes = base64UrlDecode(expectedHashBase64Url);
  if (!saltBytes || !expectedBytes || iterations < 1) return false;
  const derived = await derivePbkdf2Sha256(authVerifier, saltBytes, iterations);
  return timingSafeEqual(derived, expectedBytes);
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

/** Signs an HMAC-SHA256 JWT access token with a default 15-minute TTL. */
export async function signAccessToken(
  subject: { readonly sub: string; readonly email: string },
  secret: string,
  nowSec: number,
  ttlSec = ACCESS_TOKEN_TTL_SEC,
): Promise<string> {
  const headerPart = encodeUtf8Base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: AccessTokenClaims = {
    sub: subject.sub,
    email: subject.email,
    iat: nowSec,
    exp: nowSec + ttlSec,
  };
  const payloadPart = encodeUtf8Base64Url(JSON.stringify(claims));
  const signingInput = `${headerPart}.${payloadPart}`;
  const sig = await hmacSha256(secret, signingInput);
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

/** Verifies an HS256 JWT access token in constant time and checks expiration. */
export async function verifyAccessToken(
  token: string,
  secret: string,
  nowSec: number,
): Promise<AccessTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  if (!headerPart || !payloadPart || !sigPart) return null;

  const sigBytes = base64UrlDecode(sigPart);
  if (!sigBytes) return null;

  const expectedSig = await hmacSha256(secret, `${headerPart}.${payloadPart}`);
  if (!timingSafeEqual(sigBytes, expectedSig)) return null;

  const headerText = decodeUtf8Base64Url(headerPart);
  const payloadText = decodeUtf8Base64Url(payloadPart);
  if (!headerText || !payloadText) return null;

  try {
    const header = JSON.parse(headerText) as { alg?: unknown; typ?: unknown };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const payload = JSON.parse(payloadText) as {
      sub?: unknown;
      email?: unknown;
      iat?: unknown;
      exp?: unknown;
    };
    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.length === 0 ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    if (payload.exp <= nowSec) return null;
    return {
      sub: payload.sub,
      email: payload.email,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
