import { base64UrlDecode } from './crypto.ts';
import type { ValidationResult } from './validation.ts';

/** Maximum invalid pairing attempts per session before permanent lockout (423). */
export const MAX_PAIR_ATTEMPTS = 3;

const PAIR_AUTH_STATES = ['signed_in', 'signed_out'] as const;

/** Union of valid pairing authentication states. */
export type PairAuthState = (typeof PAIR_AUTH_STATES)[number];

const PAIR_DIRECTIONS = [
  'neither_signed_in',
  'responder_to_host',
  'host_to_responder',
  'same_account',
  'different_accounts',
] as const;

/** Union of valid bidirectional pairing directions. */
export type PairDirection = (typeof PAIR_DIRECTIONS)[number];

/** Validated bidirectional `POST /v1/pair/create` body. */
export interface PairCreateV2Input {
  readonly hostPublicKey: string;
  readonly hostAuthState: PairAuthState;
  readonly hostMaskedEmail: string | null;
  readonly hostEmailHash: string | null;
}

/** Validated Phase-1 `POST /v1/pair/respond` body (metadata & X25519 key exchange only, never payloads). */
interface PairRespondInput {
  readonly code: string;
  readonly responderPublicKey: string;
  readonly responderAuthState: PairAuthState;
  readonly responderMaskedEmail: string | null;
  readonly responderEmailHash: string | null;
  readonly direction: PairDirection;
}

/** Validated Phase-2 post-SAS `POST /v1/pair/transfer` body. */
interface PairTransferInput {
  readonly pairingId: string;
  readonly direction: 'responder_to_host' | 'different_accounts';
  readonly encryptedPayload: string;
  readonly iv: string;
}

/** Validated `POST /v1/pair/approve` body. */
interface PairApproveInput {
  readonly pairingId: string;
  readonly direction: PairDirection | null;
  readonly encryptedPayload: string | null;
  readonly iv: string | null;
  readonly reject: boolean;
}

/** Validated `POST /v1/pair/cancel` body. */
interface PairCancelInput {
  readonly pairingId: string;
}

const PAIR_CODE_V2_RE = /^\d{8}$/;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const X25519_KEY_BYTES = 32;
const AUTH_STATE_SET = new Set<string>(PAIR_AUTH_STATES);
const DIRECTION_SET = new Set<string>(PAIR_DIRECTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

function validatePairCodeV2(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string' || !PAIR_CODE_V2_RE.test(raw)) {
    return { ok: false, error: 'invalid_pair_code' };
  }
  return { ok: true, value: raw };
}

function validateX25519PublicKey(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_public_key' };
  const decoded = base64UrlDecode(raw);
  if (!decoded || decoded.length !== X25519_KEY_BYTES) {
    return { ok: false, error: 'invalid_public_key' };
  }
  let nonZero = 0;
  for (let i = 0; i < decoded.length; i += 1) {
    nonZero |= decoded[i] ?? 0;
  }
  if (nonZero === 0) {
    return { ok: false, error: 'invalid_public_key_zero' };
  }
  return { ok: true, value: raw };
}

function validatePairAuthState(raw: unknown): ValidationResult<PairAuthState> {
  if (typeof raw !== 'string' || !AUTH_STATE_SET.has(raw)) {
    return { ok: false, error: 'invalid_auth_state' };
  }
  return { ok: true, value: raw as PairAuthState };
}

function validateMaskedEmail(raw: unknown): ValidationResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_masked_email' };
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 128) {
    return { ok: false, error: 'invalid_masked_email' };
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return { ok: false, error: 'invalid_masked_email' };
    }
  }
  if (trimmed.includes('://')) return { ok: false, error: 'invalid_masked_email' };
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0 || atIdx !== trimmed.lastIndexOf('@') || atIdx >= trimmed.length - 1) {
    return { ok: false, error: 'invalid_masked_email' };
  }
  if (!trimmed.includes('*')) return { ok: false, error: 'invalid_masked_email' };
  return { ok: true, value: trimmed };
}

function validateEmailHash(raw: unknown): ValidationResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !SHA256_HEX_RE.test(raw)) {
    return { ok: false, error: 'invalid_email_hash' };
  }
  return { ok: true, value: raw.toLowerCase() };
}

function validatePairDirection(raw: unknown): ValidationResult<PairDirection> {
  if (typeof raw !== 'string' || !DIRECTION_SET.has(raw)) {
    return { ok: false, error: 'invalid_direction' };
  }
  return { ok: true, value: raw as PairDirection };
}

function validateOptionalCiphertextPair(
  rawPayload: unknown,
  rawIv: unknown,
): ValidationResult<{ readonly encryptedPayload: string | null; readonly iv: string | null }> {
  const hasPayload = rawPayload !== undefined && rawPayload !== null;
  const hasIv = rawIv !== undefined && rawIv !== null;
  if (!hasPayload && !hasIv) {
    return { ok: true, value: { encryptedPayload: null, iv: null } };
  }
  if (!hasPayload || !hasIv) {
    return { ok: false, error: 'incomplete_encrypted_payload' };
  }
  const encryptedPayload = boundedString(rawPayload, 16, 32_768);
  if (!encryptedPayload) return { ok: false, error: 'invalid_encrypted_payload' };
  const iv = boundedString(rawIv, 12, 64);
  if (!iv) return { ok: false, error: 'invalid_iv' };
  return { ok: true, value: { encryptedPayload, iv } };
}

/** Validates bidirectional v2 `POST /v1/pair/create` body. */
export function validatePairCreateV2Input(raw: unknown): ValidationResult<PairCreateV2Input> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const pkRes = validateX25519PublicKey(raw.hostPublicKey);
  if (!pkRes.ok) return pkRes;
  const authRes = validatePairAuthState(raw.hostAuthState);
  if (!authRes.ok) return authRes;
  const emailRes = validateMaskedEmail(raw.hostMaskedEmail);
  if (!emailRes.ok) return emailRes;
  const hashRes = validateEmailHash(raw.hostEmailHash);
  if (!hashRes.ok) return hashRes;

  if (authRes.value === 'signed_out' && (emailRes.value !== null || hashRes.value !== null)) {
    return { ok: false, error: 'unexpected_email_for_signed_out' };
  }
  return {
    ok: true,
    value: {
      hostPublicKey: pkRes.value,
      hostAuthState: authRes.value,
      hostMaskedEmail: emailRes.value,
      hostEmailHash: hashRes.value,
    },
  };
}

/** Validates `POST /v1/pair/lookup` body (`{ code }`). */
export function validatePairLookupInput(raw: unknown): ValidationResult<string> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  return validatePairCodeV2(raw.code);
}

/** Extracts a syntactically valid 8-digit code from a raw `/v1/pair/respond` body before full validation. */
export function extractRespondCode(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const res = validatePairCodeV2(raw.code);
  return res.ok ? res.value : null;
}

/** Validates Phase-1 `POST /v1/pair/respond` body fields, strictly forbidding any pre-SAS payload. */
export function validatePairRespondInput(raw: unknown): ValidationResult<PairRespondInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const codeRes = validatePairCodeV2(raw.code);
  if (!codeRes.ok) return codeRes;
  if (
    (raw.encryptedPayload !== undefined && raw.encryptedPayload !== null) ||
    (raw.iv !== undefined && raw.iv !== null)
  ) {
    return { ok: false, error: 'pre_sas_payload_forbidden' };
  }
  const pkRes = validateX25519PublicKey(raw.responderPublicKey);
  if (!pkRes.ok) return pkRes;
  const authRes = validatePairAuthState(raw.responderAuthState);
  if (!authRes.ok) return authRes;
  const emailRes = validateMaskedEmail(raw.responderMaskedEmail);
  if (!emailRes.ok) return emailRes;
  const hashRes = validateEmailHash(raw.responderEmailHash);
  if (!hashRes.ok) return hashRes;
  const dirRes = validatePairDirection(raw.direction);
  if (!dirRes.ok) return dirRes;

  if (authRes.value === 'signed_out' && (emailRes.value !== null || hashRes.value !== null)) {
    return { ok: false, error: 'unexpected_email_for_signed_out' };
  }
  return {
    ok: true,
    value: {
      code: codeRes.value,
      responderPublicKey: pkRes.value,
      responderAuthState: authRes.value,
      responderMaskedEmail: emailRes.value,
      responderEmailHash: hashRes.value,
      direction: dirRes.value,
    },
  };
}

/** Validates Phase-2 post-SAS `POST /v1/pair/transfer` body fields. */
export function validatePairTransferInput(raw: unknown): ValidationResult<PairTransferInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const pairingId = boundedString(raw.pairingId, 8, 128);
  if (!pairingId) return { ok: false, error: 'invalid_pairing_id' };
  const dirRes = validatePairDirection(raw.direction);
  if (!dirRes.ok) return dirRes;
  if (dirRes.value !== 'responder_to_host' && dirRes.value !== 'different_accounts') {
    return { ok: false, error: 'invalid_transfer_direction' };
  }
  const encryptedPayload = boundedString(raw.encryptedPayload, 16, 32_768);
  if (!encryptedPayload) return { ok: false, error: 'invalid_encrypted_payload' };
  const iv = boundedString(raw.iv, 12, 64);
  if (!iv) return { ok: false, error: 'invalid_iv' };
  return {
    ok: true,
    value: {
      pairingId,
      direction: dirRes.value,
      encryptedPayload,
      iv,
    },
  };
}

/** Validates that the responder's declared pairing direction matches host & responder auth states. */
export function isDirectionConsistentWithAuthStates(
  direction: PairDirection,
  hostAuthState: PairAuthState,
  responderAuthState: PairAuthState,
): boolean {
  switch (direction) {
    case 'neither_signed_in':
      return hostAuthState === 'signed_out' && responderAuthState === 'signed_out';
    case 'responder_to_host':
      return hostAuthState === 'signed_out' && responderAuthState === 'signed_in';
    case 'host_to_responder':
      return hostAuthState === 'signed_in' && responderAuthState === 'signed_out';
    case 'same_account':
    case 'different_accounts':
      return hostAuthState === 'signed_in' && responderAuthState === 'signed_in';
  }
}

/** Validates `POST /v1/pair/approve` body. */
export function validatePairApproveInput(raw: unknown): ValidationResult<PairApproveInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const pairingId = boundedString(raw.pairingId, 8, 128);
  if (!pairingId) return { ok: false, error: 'invalid_pairing_id' };
  if (raw.reject !== undefined && typeof raw.reject !== 'boolean') {
    return { ok: false, error: 'invalid_reject_flag' };
  }
  const reject = raw.reject === true;
  let direction: PairDirection | null = null;
  if (raw.direction !== undefined && raw.direction !== null) {
    const dirRes = validatePairDirection(raw.direction);
    if (!dirRes.ok) return dirRes;
    direction = dirRes.value;
  } else if (!reject) {
    return { ok: false, error: 'invalid_direction' };
  }
  const cipherRes = validateOptionalCiphertextPair(raw.encryptedPayload, raw.iv);
  if (!cipherRes.ok) return cipherRes;
  if (reject && cipherRes.value.encryptedPayload !== null) {
    return { ok: false, error: 'unexpected_payload_on_reject' };
  }
  return {
    ok: true,
    value: {
      pairingId,
      direction,
      encryptedPayload: cipherRes.value.encryptedPayload,
      iv: cipherRes.value.iv,
      reject,
    },
  };
}

/** Validates `POST /v1/pair/cancel` body (`{ pairingId }`). */
export function validatePairCancelInput(raw: unknown): ValidationResult<PairCancelInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const pairingId = boundedString(raw.pairingId, 8, 128);
  if (!pairingId) return { ok: false, error: 'invalid_pairing_id' };
  return { ok: true, value: { pairingId } };
}
