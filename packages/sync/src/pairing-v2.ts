import { elvError, err, ok, originOf, type Result } from '@elv/domain';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  constantTimeEqual,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from './encoding';
import { aes256GcmDecrypt, aes256GcmEncrypt, sha256 } from './pure-crypto';
import { normalizeSyncEmail } from './vault-crypto';
import { hkdfExpand, hkdfExtract, isAllZeroBytes, X25519_KEY_BYTES } from './x25519';

/** E2EE credential handoff payload transferred during device pairing. */
export interface QrPairingPayload {
  readonly email: string;
  readonly refreshToken: string;
  readonly vaultKeyB64: string;
}

/** Hard byte ceiling matching `@elv/ui-kit` QR encoder capacity (`MAX_QR_PAYLOAD_BYTES`). */
export const MAX_SYNC_QR_BYTES = 213;

/** Exact 8-digit numeric pairing code pattern (`#510`). */
export const PAIR_CODE_RE = /^\d{8}$/;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PAIR_SCHEME_PREFIX = 'elviptv://pair?';
const AES_GCM_IV_BYTES = 12;
const VAULT_KEY_BYTES = 32;
const MAX_MASKED_EMAIL_LENGTH = 128;

/** Input parameters for building a bidirectional X25519 pairing QR URI. */
export interface BidirectionalPairingQrParams {
  readonly code: string;
  readonly hostPublicKeyB64Url: string;
  readonly origin?: string;
}

/** Parsed result of scanning a bidirectional pairing QR URI or entering an 8-digit manual code. */
export type ParsedPairingQrOrCode =
  | { readonly kind: 'code'; readonly code: string }
  | {
      readonly kind: 'qr';
      readonly code: string;
      readonly hostPublicKeyB64Url: string;
      readonly origin?: string;
    };

/** Canonical transcript binding both ephemeral X25519 public keys and the 8-digit pairing code. */
export interface PairingTranscript {
  readonly code: string;
  readonly hostPublicKey: Uint8Array;
  readonly responderPublicKey: Uint8Array;
}

/** Transcript-bound 4-digit SAS and domain-separated directional AES-256-GCM transfer keys. */
export interface PairingSessionKeys {
  readonly sas: string;
  readonly hostToResponderKey: Uint8Array;
  readonly responderToHostKey: Uint8Array;
  readonly aad: Uint8Array;
}

/** Encrypted transfer envelope sent across the zero-knowledge pairing relay. */
export interface EncryptedPairingTransfer {
  readonly ciphertext: string;
  readonly iv: string;
}

/** Options for {@link encryptPairingTransfer}. */
export interface EncryptPairingTransferOptions {
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly iv?: Uint8Array;
}

/** Auth state descriptor used to deterministically resolve bidirectional pairing direction. */
export interface PairingParticipantAuth {
  readonly signedIn: boolean;
  readonly emailHash?: string | null;
}

/** Five deterministic account-direction outcomes for bidirectional single-QR pairing (`#510`). */
export type PairingDirection =
  | 'neither_signed_in'
  | 'responder_to_host'
  | 'host_to_responder'
  | 'same_account'
  | 'different_accounts';

/** Strips spaces and dashes from a raw pairing code and validates exact 8 numeric digits. */
export function normalizePairingCode(raw: string): string | null {
  const cleaned = raw.replace(/[\s-]+/g, '');
  return PAIR_CODE_RE.test(cleaned) ? cleaned : null;
}

/**
 * Privacy-masks an email address so the full local part is never exposed over pairing metadata:
 * e.g. `fatih@example.com` -> `f***@example.com`, `a@b.co` -> `*@b.co`.
 */
export function maskEmail(email: string): string {
  const normalized = normalizeSyncEmail(email);
  const at = normalized.indexOf('@');
  if (at <= 0 || at === normalized.length - 1 || normalized.indexOf('@', at + 1) !== -1) {
    return '***';
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (domain.length === 0) return '***';
  const maskedLocal = local.length <= 1 ? '*' : `${local.charAt(0)}***`;
  const result = `${maskedLocal}@${domain}`;
  if (result.length <= MAX_MASKED_EMAIL_LENGTH) return result;
  const maxDomainLen = Math.max(1, MAX_MASKED_EMAIL_LENGTH - maskedLocal.length - 1);
  return `${maskedLocal}@${domain.slice(0, maxDomainLen)}`;
}

/** Computes lowercase 64-char hex SHA-256 of a normalized email for privacy-preserving account comparison. */
export function hashPairingEmail(email: string): string {
  return bytesToHex(sha256(utf8Encode(normalizeSyncEmail(email))));
}

function decodePublicKeyB64Url(pkB64Url: string): Uint8Array | null {
  try {
    const bytes = base64UrlDecode(pkB64Url);
    if (bytes.length !== X25519_KEY_BYTES || isAllZeroBytes(bytes)) return null;
    return bytes;
  } catch {
    return null;
  }
}

function normalizeHttpsOrigin(origin: string): string | null {
  const trimmed = origin.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('\\')) return null;
  if (!trimmed.toLowerCase().startsWith('https://')) return null;
  const afterScheme = trimmed.slice('https://'.length);
  const slashIdx = afterScheme.indexOf('/');
  const authority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  if (authority.length === 0 || authority.includes('@')) return null;
  if (slashIdx !== -1 && afterScheme.slice(slashIdx).replace(/\/+$/, '').length > 0) {
    return null;
  }
  const normalized = originOf(trimmed);
  return normalized?.startsWith('https://') ? normalized : null;
}

/**
 * Builds a bidirectional X25519 pairing QR URI (`elviptv://pair?c=<8digits>&pk=<pk>` or
 * `https://<host>/pair?c=<8digits>&pk=<pk>`), strictly enforcing {@link MAX_SYNC_QR_BYTES} (213 B).
 */
export function encodeBidirectionalPairingQr(params: BidirectionalPairingQrParams): string {
  const code = normalizePairingCode(params.code);
  if (code === null) {
    throw new Error('Pairing code must be exactly 8 numeric digits');
  }
  const pkBytes = decodePublicKeyB64Url(params.hostPublicKeyB64Url);
  if (pkBytes === null) {
    throw new Error('X25519 host public key must be 32 non-zero base64url bytes');
  }
  const canonicalPk = base64UrlEncode(pkBytes);
  let uri: string;
  if (params.origin !== undefined && params.origin.trim().length > 0) {
    const cleanOrigin = normalizeHttpsOrigin(params.origin);
    if (cleanOrigin === null) {
      throw new Error('Universal Link pairing origin must be a valid https:// origin');
    }
    uri = `${cleanOrigin}/pair?c=${code}&pk=${canonicalPk}`;
  } else {
    uri = `${PAIR_SCHEME_PREFIX}c=${code}&pk=${canonicalPk}`;
  }

  if (utf8ByteLength(uri) > MAX_SYNC_QR_BYTES) {
    throw new Error(`Pairing QR URI exceeds ${MAX_SYNC_QR_BYTES} UTF-8 bytes`);
  }
  return uri;
}

function parseQueryParams(query: string): Result<{ readonly code: string; readonly pk: string }> {
  const hashIdx = query.indexOf('#');
  const cleanQuery = hashIdx === -1 ? query : query.slice(0, hashIdx);

  let rawCode: string | undefined;
  let rawPk: string | undefined;
  for (const part of cleanQuery.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return err(elvError('source-format', 'invalid-qr-param'));
    const k = part.slice(0, eq);
    let v: string;
    try {
      v = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return err(elvError('source-format', 'invalid-qr-encoding'));
    }
    if (k === 'c') rawCode = v;
    else if (k === 'pk') rawPk = v;
  }

  if (rawCode === undefined || !PAIR_CODE_RE.test(rawCode)) {
    return err(elvError('source-format', 'invalid-qr-code'));
  }
  if (rawPk === undefined) {
    return err(elvError('source-format', 'invalid-qr-key'));
  }
  const pkBytes = decodePublicKeyB64Url(rawPk);
  if (pkBytes === null) {
    return err(elvError('source-format', 'invalid-qr-key'));
  }
  return ok({ code: rawCode, pk: base64UrlEncode(pkBytes) });
}

/**
 * Parses a bidirectional pairing QR URI (`elviptv://pair?...` or `https://<host>/pair?...`)
 * OR a manually entered 8-digit code (`1234 5678` / `1234-5678` / `12345678`).
 * Rejects non-HTTPS web origins, wrong paths, malformed codes, and all-zero X25519 keys.
 */
export function parsePairingQrOrCode(input: string): Result<ParsedPairingQrOrCode> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return err(elvError('source-format', 'invalid-pairing-input'));
  }

  if (!trimmed.includes('://') && !trimmed.includes(':')) {
    const code = normalizePairingCode(trimmed);
    if (code !== null) {
      return ok({ kind: 'code', code });
    }
    return err(elvError('source-format', 'invalid-pairing-code'));
  }

  if (utf8ByteLength(trimmed) > MAX_SYNC_QR_BYTES) {
    return err(elvError('source-format', 'invalid-qr-uri'));
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith(PAIR_SCHEME_PREFIX)) {
    const parsed = parseQueryParams(trimmed.slice(PAIR_SCHEME_PREFIX.length));
    if (!parsed.ok) return parsed;
    return ok({ kind: 'qr', code: parsed.value.code, hostPublicKeyB64Url: parsed.value.pk });
  }

  if (lower.startsWith('https://')) {
    const qIdx = trimmed.indexOf('?');
    if (qIdx === -1) return err(elvError('source-format', 'invalid-qr-uri'));
    const base = trimmed.slice(0, qIdx);
    const afterScheme = base.slice('https://'.length);
    const slashIdx = afterScheme.indexOf('/');
    if (slashIdx <= 0) return err(elvError('source-format', 'invalid-qr-path'));
    const authority = afterScheme.slice(0, slashIdx);
    if (authority.includes('@') || authority.includes('\\')) {
      return err(elvError('source-format', 'invalid-qr-origin'));
    }
    const path = afterScheme.slice(slashIdx).replace(/\/+$/, '');
    if (path !== '/pair') {
      return err(elvError('source-format', 'invalid-qr-path'));
    }
    const cleanOrigin = originOf(base);
    if (cleanOrigin === undefined || !cleanOrigin.startsWith('https://')) {
      return err(elvError('source-format', 'invalid-qr-origin'));
    }
    const parsed = parseQueryParams(trimmed.slice(qIdx + 1));
    if (!parsed.ok) return parsed;
    return ok({
      kind: 'qr',
      code: parsed.value.code,
      hostPublicKeyB64Url: parsed.value.pk,
      origin: cleanOrigin,
    });
  }

  return err(elvError('source-format', 'invalid-qr-scheme'));
}

function buildCanonicalTranscriptString(transcript: PairingTranscript): string {
  const code = normalizePairingCode(transcript.code);
  if (code === null) {
    throw new Error('Pairing transcript code must be exactly 8 numeric digits');
  }
  if (
    transcript.hostPublicKey.length !== X25519_KEY_BYTES ||
    isAllZeroBytes(transcript.hostPublicKey)
  ) {
    throw new Error('hostPublicKey must be 32 non-zero bytes');
  }
  if (
    transcript.responderPublicKey.length !== X25519_KEY_BYTES ||
    isAllZeroBytes(transcript.responderPublicKey)
  ) {
    throw new Error('responderPublicKey must be 32 non-zero bytes');
  }
  return `elv-pair-v2|${code}|${base64UrlEncode(transcript.hostPublicKey)}|${base64UrlEncode(transcript.responderPublicKey)}`;
}

/** Builds the canonical UTF-8 AAD byte sequence binding `code`, `hostPublicKey`, and `responderPublicKey`. */
export function buildPairingTranscriptAad(transcript: PairingTranscript): Uint8Array {
  return utf8Encode(buildCanonicalTranscriptString(transcript));
}

/**
 * Derives the transcript-bound 4-digit SAS (`"0000"`–`"9999"`) and distinct domain-separated
 * directional AES-256-GCM keys (`hostToResponderKey`, `responderToHostKey`) via HKDF-SHA256.
 */
export function derivePairingSessionKeys(
  sharedSecret: Uint8Array,
  transcript: PairingTranscript,
): PairingSessionKeys {
  if (sharedSecret.length !== X25519_KEY_BYTES || isAllZeroBytes(sharedSecret)) {
    throw new Error('X25519 shared secret must be 32 non-zero bytes');
  }
  const transcriptStr = buildCanonicalTranscriptString(transcript);
  const aad = utf8Encode(transcriptStr);
  const prk = hkdfExtract(aad, sharedSecret);

  const sasBytes = hkdfExpand(prk, utf8Encode(`${transcriptStr}|sas`), 4);
  const sasInt =
    (((sasBytes[0] ?? 0) << 24) |
      ((sasBytes[1] ?? 0) << 16) |
      ((sasBytes[2] ?? 0) << 8) |
      (sasBytes[3] ?? 0)) >>>
    0;
  const sas = String(sasInt % 10_000).padStart(4, '0');

  const hostToResponderKey = hkdfExpand(prk, utf8Encode(`${transcriptStr}|host-to-responder`), 32);
  const responderToHostKey = hkdfExpand(prk, utf8Encode(`${transcriptStr}|responder-to-host`), 32);

  return { sas, hostToResponderKey, responderToHostKey, aad };
}

function defaultRandomBytes(length: number): Uint8Array {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.getRandomValues === 'function') {
    const out = new Uint8Array(length);
    cryptoObj.getRandomValues(out);
    return out;
  }
  throw new Error('CSPRNG randomBytes callback is required when globalThis.crypto is unavailable');
}

function validateTransferPayload(payload: QrPairingPayload): void {
  if (
    typeof payload.email !== 'string' ||
    payload.email.trim().length === 0 ||
    typeof payload.refreshToken !== 'string' ||
    payload.refreshToken.length === 0 ||
    typeof payload.vaultKeyB64 !== 'string' ||
    payload.vaultKeyB64.length === 0
  ) {
    throw new Error('Invalid pairing transfer payload');
  }
  const vaultKey = base64UrlDecode(payload.vaultKeyB64);
  if (vaultKey.length !== VAULT_KEY_BYTES) {
    throw new Error('vaultKeyB64 must decode to 32 bytes');
  }
}

/** Encrypts a pairing credential handoff payload with AES-256-GCM bound to canonical transcript AAD. */
export function encryptPairingTransfer(
  key: Uint8Array,
  aad: Uint8Array,
  payload: QrPairingPayload,
  options?: EncryptPairingTransferOptions,
): EncryptedPairingTransfer {
  if (key.length !== 32) throw new Error('Pairing transfer key must be 32 bytes');
  if (aad.length === 0) throw new Error('Pairing transfer AAD must not be empty');
  validateTransferPayload(payload);

  const iv = options?.iv ?? (options?.randomBytes ?? defaultRandomBytes)(AES_GCM_IV_BYTES);
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new Error(`Pairing transfer IV must be exactly ${AES_GCM_IV_BYTES} bytes`);
  }

  const plaintext = utf8Encode(
    JSON.stringify({
      email: payload.email,
      refreshToken: payload.refreshToken,
      vaultKeyB64: payload.vaultKeyB64,
    }),
  );
  const ciphertext = aes256GcmEncrypt(key, iv, plaintext, aad);
  return {
    ciphertext: base64UrlEncode(ciphertext),
    iv: base64UrlEncode(iv),
  };
}

/** Decrypts and authenticates a bidirectional pairing credential handoff payload under AES-256-GCM + AAD. */
export function decryptPairingTransfer(
  key: Uint8Array,
  aad: Uint8Array,
  ciphertext: string | Uint8Array,
  iv: string | Uint8Array,
): QrPairingPayload {
  if (key.length !== 32) throw new Error('Pairing transfer key must be 32 bytes');
  if (aad.length === 0) throw new Error('Pairing transfer AAD must not be empty');

  const ivBytes = typeof iv === 'string' ? base64UrlDecode(iv) : iv;
  if (ivBytes.length !== AES_GCM_IV_BYTES) {
    throw new Error(`Pairing transfer IV must be exactly ${AES_GCM_IV_BYTES} bytes`);
  }
  const ctBytes = typeof ciphertext === 'string' ? base64UrlDecode(ciphertext) : ciphertext;
  const plaintext = aes256GcmDecrypt(key, ivBytes, ctBytes, aad);

  const parsed: unknown = JSON.parse(utf8Decode(plaintext));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid decrypted pairing transfer payload');
  }
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec.email !== 'string' ||
    typeof rec.refreshToken !== 'string' ||
    typeof rec.vaultKeyB64 !== 'string'
  ) {
    throw new Error('Invalid decrypted pairing transfer payload');
  }
  const result: QrPairingPayload = {
    email: rec.email,
    refreshToken: rec.refreshToken,
    vaultKeyB64: rec.vaultKeyB64,
  };
  validateTransferPayload(result);
  return result;
}

function normalizeEmailHash(hash: string | null | undefined): string | null {
  if (typeof hash !== 'string') return null;
  const normalized = hash.trim().toLowerCase();
  return SHA256_HEX_RE.test(normalized) ? normalized : null;
}

/**
 * Deterministically resolves the 5-case bidirectional pairing account matrix using
 * constant-time comparison of normalized SHA-256 email hashes (never raw emails).
 */
export function resolvePairingDirection(
  hostAuth: PairingParticipantAuth,
  responderAuth: PairingParticipantAuth,
): PairingDirection {
  if (!hostAuth.signedIn && !responderAuth.signedIn) return 'neither_signed_in';
  if (!hostAuth.signedIn && responderAuth.signedIn) return 'responder_to_host';
  if (hostAuth.signedIn && !responderAuth.signedIn) return 'host_to_responder';

  const hostHash = normalizeEmailHash(hostAuth.emailHash);
  const respHash = normalizeEmailHash(responderAuth.emailHash);
  if (hostHash === null || respHash === null) {
    return 'different_accounts';
  }
  return constantTimeEqual(utf8Encode(hostHash), utf8Encode(respHash))
    ? 'same_account'
    : 'different_accounts';
}
