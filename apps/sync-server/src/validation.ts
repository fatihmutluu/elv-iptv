/** Allowlisted runtime telemetry event kinds accepted by `/v1/telemetry`. */
const TELEMETRY_EVENT_KINDS = [
  'startup',
  'screen_transition',
  'frame_jank',
  'js_stall',
  'memory_pressure',
  'playback_start',
  'playback_rebuffer',
  'playback_error',
  'media_decode_failure',
  'sqlite_slow_op',
  'app_crash',
  'unhandled_error',
  'catalog_import',
] as const;

/** Union of allowlisted telemetry event kinds. */
type TelemetryEventKind = (typeof TELEMETRY_EVENT_KINDS)[number];

/** Allowlisted user feedback categories accepted by `/v1/feedback`. */
export const FEEDBACK_CATEGORIES = [
  'playback_issue',
  'channel_epg',
  'ui_remote',
  'sync_account',
  'feature_request',
  'other',
] as const;

/** Union of allowlisted feedback categories. */
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const TELEMETRY_KIND_SET = new Set<string>(TELEMETRY_EVENT_KINDS);
const FEEDBACK_CATEGORY_SET = new Set<string>(FEEDBACK_CATEGORIES);

/** Body size caps in bytes. */
export const BODY_LIMITS = {
  auth: 64 * 1024,
  pair: 64 * 1024,
  vault: 4 * 1024 * 1024,
  telemetry: 256 * 1024,
  feedback: 64 * 1024,
  accountDeletion: 16 * 1024,
  elvMatch: 256 * 1024,
} as const;

/** Error thrown when an incoming HTTP body exceeds its route cap. */
export class PayloadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Payload exceeds ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** Validated registration payload. */
export interface RegisterInput {
  readonly email: string;
  readonly authVerifier: string;
  readonly kdfSalt: string;
  readonly kdfIterations: number;
  readonly wrappedVaultKey: string;
  readonly recoveryWrappedVaultKey: string;
}

/** Validated login payload. */
export interface LoginInput {
  readonly email: string;
  readonly authVerifier: string;
}

/** Validated pairing claim payload. */
export interface PairClaimInput {
  readonly code: string;
  readonly encryptedPayload: string;
  readonly iv: string;
}

/** Validated vault PUT payload. */
export interface VaultPutInput {
  readonly expectedRevision: number;
  readonly ciphertext: string;
  readonly iv: string;
}

/** Validated sanitized technical device profile attached to telemetry events. */
interface ValidatedDeviceProfile {
  readonly osVersion?: string;
  readonly formFactor?: string;
  readonly arch?: string;
  readonly ramBucket?: string;
  readonly gpu?: string;
  readonly resolution?: string;
  readonly locale?: string;
}

/** Validated sanitized telemetry event ready for storage. */
export interface ValidatedTelemetryEvent {
  readonly eventTs: string;
  readonly sessionId: string;
  readonly kind: TelemetryEventKind;
  readonly appVersion: string;
  readonly platform: string;
  readonly osVersion: string | null;
  readonly formFactor: string | null;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  readonly deviceProfileJson: string | null;
}

/** Validated feedback submission ready for storage. */
export interface ValidatedFeedbackInput {
  readonly category: FeedbackCategory;
  readonly message: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly locale: string | null;
  readonly diagnosticsJson: string | null;
}

/** Validated public account-deletion request payload. */
export interface AccountDeletionInput {
  readonly email: string;
  readonly note: string | null;
}

/** Validation result wrapper. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_DATE_MS = 8.64e15;
const MAX_DELETION_NOTE_LENGTH = 500;

const IPV6_BODY =
  '(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,7}:' +
  '|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}' +
  '|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}' +
  '|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}' +
  '|:(?::[0-9a-fA-F]{1,4}){1,7}' +
  '|::ffff:(?:(?:25[0-5]|2[0-4]\\d|1?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d\\d?))';

const IPV6_DETECT_RE = new RegExp(`(?:^|[\\s"'(\\[=:,])${IPV6_BODY}(?=$|[\\s"'\\])},;/%])`, 'i');
const IPV6_BRACKET_REPLACE_RE = new RegExp(
  `\\[${IPV6_BODY}(?:%[^\\s\\]]+)?\\](?::\\d{1,5})?`,
  'gi',
);
const IPV6_BARE_REPLACE_RE = new RegExp(
  `(^|[\\s"'(=:,])${IPV6_BODY}(?:%[^\\s"'),;]+)?(?=$|[\\s"'),;/])`,
  'gi',
);

const SENSITIVE_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: 'url_scheme', re: /(?:[a-z][a-z0-9+.-]*:\/\/|file:\S)/i },
  { label: 'uri_credentials', re: /[^\s/:@]{1,128}:[^\s/:@]{1,128}@[^\s/:@]+/ },
  {
    label: 'auth_secret',
    re: /\b(?:authorization|bearer\s+[A-Za-z0-9._~+/=-]{8,}|password\s*=|passwd\s*=|access_token\s*=|refresh_token\s*=)/i,
  },
  {
    label: 'private_file_path',
    re: /(?:^|[\s"'(=:])(?:\/(?:Users|home|var|tmp|private|data|storage)\/|[A-Za-z]:\\|\\\\[A-Za-z0-9_.-]+\\)/,
  },
  {
    label: 'ipv4_address',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)\b/,
  },
  {
    label: 'ipv6_address',
    re: IPV6_DETECT_RE,
  },
  {
    label: 'email_address',
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,}\b/,
  },
];

/** Defense-in-depth server-side scrubber stripping URLs, credentials, paths, emails, and IPs from feedback text. */
function redactFeedbackMessage(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .replace(/\bfile:\S+/gi, '[redacted]')
    .replace(/(^|[\s"'(=])[^\s/:@]{1,128}:[^\s/:@]{1,128}@[^\s/:@]+/g, '$1[redacted]')
    .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,}\b/g, '[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]')
    .replace(/\bauthorization\s*[:=]\s*\S+(?:\s+\S+)?/gi, '[redacted]')
    .replace(
      /\b(?:password|passwd|access_token|refresh_token|api_key)\s*[:=]\s*\S+/gi,
      '[redacted]',
    )
    .replace(
      /(^|[\s"'(=:])\/(?:Users|home|var|tmp|private|data|storage)\/[^\s"'<>)]+/g,
      '$1[redacted]',
    )
    .replace(/(^|[\s"'(=:])[A-Za-z]:\\[^\s"'<>)]+/g, '$1[redacted]')
    .replace(/(^|[\s"'(=:])\\\\[A-Za-z0-9_.-]+\\[^\s"'<>)]+/g, '$1[redacted]')
    .replace(IPV6_BRACKET_REPLACE_RE, '[redacted]')
    .replace(IPV6_BARE_REPLACE_RE, '$1[redacted]')
    .replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)(?::\d{1,5})?\b/g,
      '[redacted]',
    );
}

const FOUR_PART_OS_VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;
const MAX_TELEMETRY_UPTIME_MS = 31_536_000_000;

/** Recursively scans a value for URLs, credentials, authorization tokens, private file paths, or IPs. */
function findSensitivePattern(
  value: unknown,
  depth = 0,
  allowOsVersionQuad = false,
  keyName?: string,
): string | null {
  if (depth > 8) return 'nesting_too_deep';
  if (typeof value === 'string') {
    const skipIpv4 =
      allowOsVersionQuad && keyName === 'osVersion' && FOUR_PART_OS_VERSION_RE.test(value.trim());
    for (const pattern of SENSITIVE_PATTERNS) {
      if (skipIpv4 && pattern.label === 'ipv4_address') continue;
      if (pattern.re.test(value)) return pattern.label;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSensitivePattern(item, depth + 1, allowOsVersionQuad);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const keyHit = findSensitivePattern(k, depth + 1, allowOsVersionQuad);
      if (keyHit) return keyHit;
      const valHit = findSensitivePattern(v, depth + 1, allowOsVersionQuad, k);
      if (valHit) return valHit;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/** Validates and normalizes an email address (lowercase, trimmed, <= 254 chars). */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254 || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

/** Reads an HTTP request body while strictly enforcing `maxBytes`. */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declaredLen = request.headers.get('content-length');
  if (declaredLen !== null) {
    const parsed = Number(declaredLen);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Reads and parses a bounded JSON request body. */
export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<ValidationResult<unknown>> {
  const text = await readBoundedText(request, maxBytes);
  if (text.trim().length === 0) {
    return { ok: false, error: 'empty_body' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

/** Validates `POST /v1/auth/register` input. */
export function validateRegisterInput(raw: unknown): ValidationResult<RegisterInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const email = normalizeEmail(raw.email);
  if (!email) return { ok: false, error: 'invalid_email' };
  const authVerifier = nonEmptyString(raw.authVerifier, 16, 512);
  if (!authVerifier) return { ok: false, error: 'invalid_auth_verifier' };
  const kdfSalt = nonEmptyString(raw.kdfSalt, 8, 256);
  if (!kdfSalt) return { ok: false, error: 'invalid_kdf_salt' };
  const kdfIterations = raw.kdfIterations;
  if (
    typeof kdfIterations !== 'number' ||
    !Number.isInteger(kdfIterations) ||
    kdfIterations < 100_000 ||
    kdfIterations > 5_000_000
  ) {
    return { ok: false, error: 'invalid_kdf_iterations' };
  }
  const wrappedVaultKey = nonEmptyString(raw.wrappedVaultKey, 16, 4096);
  if (!wrappedVaultKey) return { ok: false, error: 'invalid_wrapped_vault_key' };
  const recoveryWrappedVaultKey = nonEmptyString(raw.recoveryWrappedVaultKey, 16, 4096);
  if (!recoveryWrappedVaultKey) {
    return { ok: false, error: 'invalid_recovery_wrapped_vault_key' };
  }
  return {
    ok: true,
    value: {
      email,
      authVerifier,
      kdfSalt,
      kdfIterations,
      wrappedVaultKey,
      recoveryWrappedVaultKey,
    },
  };
}

/** Validates `POST /v1/auth/login` input. */
export function validateLoginInput(raw: unknown): ValidationResult<LoginInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const email = normalizeEmail(raw.email);
  const authVerifier = nonEmptyString(raw.authVerifier, 16, 512);
  if (!email || !authVerifier) return { ok: false, error: 'invalid_credentials' };
  return { ok: true, value: { email, authVerifier } };
}

/** Validates `POST /v1/auth/check-email` input and normalizes the email address. */
export function validateCheckEmailInput(raw: unknown): ValidationResult<string> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const email = normalizeEmail(raw.email);
  if (!email) return { ok: false, error: 'invalid_email' };
  return { ok: true, value: email };
}

/** Validates `POST /v1/auth/refresh` and `POST /v1/auth/logout` input. */
export function validateRefreshTokenInput(raw: unknown): ValidationResult<string> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const refreshToken = nonEmptyString(raw.refreshToken, 16, 512);
  if (!refreshToken) return { ok: false, error: 'invalid_refresh_token' };
  return { ok: true, value: refreshToken };
}

/** Validates `DELETE /v1/auth/account` re-verification input. */
export function validateDeleteAccountInput(raw: unknown): ValidationResult<string> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const authVerifier = nonEmptyString(raw.authVerifier, 16, 512);
  if (!authVerifier) return { ok: false, error: 'invalid_auth_verifier' };
  return { ok: true, value: authVerifier };
}

/** Validates legacy `POST /v1/pair/claim` input (supports 8-digit and legacy 12-char codes). */
export function validatePairClaimInput(raw: unknown): ValidationResult<PairClaimInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const rawCode = nonEmptyString(raw.code, 8, 12);
  if (!rawCode || !/^(?:\d{8}|[A-Za-z0-9]{12})$/.test(rawCode)) {
    return { ok: false, error: 'invalid_pair_code' };
  }
  const encryptedPayload = nonEmptyString(raw.encryptedPayload, 16, 32_768);
  if (!encryptedPayload) return { ok: false, error: 'invalid_encrypted_payload' };
  const iv = nonEmptyString(raw.iv, 12, 64);
  if (!iv) return { ok: false, error: 'invalid_iv' };
  return {
    ok: true,
    value: { code: rawCode.toUpperCase(), encryptedPayload, iv },
  };
}

/** Validates `PUT /v1/vault` input. */
export function validateVaultPutInput(raw: unknown): ValidationResult<VaultPutInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  if (
    typeof raw.expectedRevision !== 'number' ||
    !Number.isInteger(raw.expectedRevision) ||
    raw.expectedRevision < 0
  ) {
    return { ok: false, error: 'invalid_expected_revision' };
  }
  const ciphertext = nonEmptyString(raw.ciphertext, 16, 4 * 1024 * 1024);
  if (!ciphertext) return { ok: false, error: 'invalid_ciphertext' };
  const iv = nonEmptyString(raw.iv, 12, 64);
  if (!iv) return { ok: false, error: 'invalid_iv' };
  return {
    ok: true,
    value: { expectedRevision: raw.expectedRevision, ciphertext, iv },
  };
}

const ALLOWED_PAYLOAD_KEYS_BY_KIND: Readonly<Record<TelemetryEventKind, readonly string[]>> = {
  startup: ['durationMs', 'coldStart', 'phase'],
  screen_transition: ['screen', 'fromScreen', 'durationMs'],
  frame_jank: ['screen', 'droppedFrames', 'durationMs', 'jankCount'],
  js_stall: ['screen', 'durationMs', 'maxBlockMs'],
  memory_pressure: ['level', 'screen', 'usedMb'],
  playback_start: ['engine', 'durationMs', 'isLive', 'streamKind'],
  playback_rebuffer: ['engine', 'durationMs', 'rebufferCount', 'isLive'],
  playback_error: ['engine', 'errorCode', 'isLive', 'recoverable'],
  media_decode_failure: [
    'engine',
    'container',
    'videoCodec',
    'audioCodec',
    'errorCode',
    'hdrFormat',
    'isLive',
  ],
  sqlite_slow_op: ['operation', 'durationMs', 'rowCount'],
  app_crash: ['errorName', 'stackSig', 'screen', 'fatal', 'uptimeMs'],
  unhandled_error: ['errorName', 'stackSig', 'screen', 'source'],
  catalog_import: ['sourceKind', 'stage', 'durationMs', 'itemCount', 'success', 'errorCode'],
};

const ALLOWED_DEVICE_PROFILE_KEYS = new Set([
  'osVersion',
  'formFactor',
  'arch',
  'ramBucket',
  'gpu',
  'resolution',
  'locale',
]);

const EVENT_ENVELOPE_KEYS = new Set([
  'kind',
  'ts',
  'timestamp',
  'sessionId',
  'appVersion',
  'platform',
  'osVersion',
  'formFactor',
  'deviceProfile',
  'payload',
]);

function sanitizeDeviceProfile(
  rawProfile: unknown,
): ValidationResult<ValidatedDeviceProfile | null> {
  if (rawProfile === undefined || rawProfile === null) return { ok: true, value: null };
  if (!isRecord(rawProfile)) return { ok: false, error: 'invalid_device_profile' };

  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawProfile)) {
    if (!ALLOWED_DEVICE_PROFILE_KEYS.has(key)) {
      return { ok: false, error: `disallowed_device_profile_field:${key}` };
    }
    if (val === undefined || val === null) continue;
    const maxLen = key === 'gpu' ? 96 : 64;
    const clean = nonEmptyString(val, 1, maxLen);
    if (!clean) return { ok: false, error: `invalid_device_profile_field:${key}` };
    const hit = findSensitivePattern(clean, 0, key === 'osVersion', key);
    if (hit) return { ok: false, error: `sensitive_data:${hit}` };
    out[key] = clean;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? (out as ValidatedDeviceProfile) : null };
}

function sanitizeTelemetryPayload(
  kind: TelemetryEventKind,
  source: Record<string, unknown>,
): ValidationResult<Readonly<Record<string, string | number | boolean>>> {
  const allowedKeys = new Set(ALLOWED_PAYLOAD_KEYS_BY_KIND[kind]);
  const rawPayload = isRecord(source.payload) ? source.payload : source;
  const out: Record<string, string | number | boolean> = {};

  for (const [key, val] of Object.entries(rawPayload)) {
    if (rawPayload === source && EVENT_ENVELOPE_KEYS.has(key)) continue;
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `disallowed_field:${key}` };
    }
    if (val === undefined || val === null) continue;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.length > 128) return { ok: false, error: `field_too_long:${key}` };
      const hit = findSensitivePattern(trimmed);
      if (hit) return { ok: false, error: `sensitive_data:${hit}` };
      out[key] = trimmed;
    } else if (typeof val === 'number') {
      const minVal = key === 'uptimeMs' ? 0 : -1_000_000;
      const maxVal = key === 'uptimeMs' ? MAX_TELEMETRY_UPTIME_MS : 10_000_000;
      const num = finiteNumber(val, minVal, maxVal);
      if (num === null) return { ok: false, error: `invalid_number:${key}` };
      out[key] = num;
    } else if (typeof val === 'boolean') {
      out[key] = val;
    } else {
      return { ok: false, error: `invalid_field_type:${key}` };
    }
  }

  if (kind === 'media_decode_failure') {
    for (const reqKey of ['engine', 'container', 'videoCodec', 'audioCodec', 'errorCode']) {
      if (typeof out[reqKey] !== 'string' || out[reqKey].length === 0) {
        return { ok: false, error: `missing_required_field:${reqKey}` };
      }
    }
  }
  if (kind === 'app_crash' || kind === 'unhandled_error') {
    if (typeof out.errorName !== 'string' || out.errorName.length === 0) {
      return { ok: false, error: 'missing_required_field:errorName' };
    }
  }
  if (kind === 'catalog_import') {
    if (typeof out.sourceKind !== 'string' || out.sourceKind.length === 0) {
      return { ok: false, error: 'missing_required_field:sourceKind' };
    }
  }
  return { ok: true, value: out };
}

/** Validates a batch submitted to `POST /v1/telemetry` against strict allowlists and secret/URL bans. */
export function validateTelemetryBatch(
  raw: unknown,
  nowIso: string,
): ValidationResult<ValidatedTelemetryEvent[]> {
  if (!isRecord(raw) || !Array.isArray(raw.events)) {
    return { ok: false, error: 'events_array_required' };
  }
  if (raw.events.length === 0 || raw.events.length > 256) {
    return { ok: false, error: 'invalid_events_count' };
  }

  const rootSensitive = findSensitivePattern(raw, 0, true);
  if (rootSensitive) {
    return { ok: false, error: `sensitive_data:${rootSensitive}` };
  }

  const batchProfileRes = sanitizeDeviceProfile(raw.deviceProfile);
  if (!batchProfileRes.ok) return batchProfileRes;
  const batchProfile = batchProfileRes.value;
  const defaultDeviceProfileJson = batchProfile ? JSON.stringify(batchProfile) : null;

  const defaultSessionId = nonEmptyString(raw.sessionId, 4, 128);
  const defaultAppVersion = nonEmptyString(raw.appVersion, 1, 64);
  const defaultPlatform = nonEmptyString(raw.platform, 1, 64);
  const defaultOsVersion = nonEmptyString(raw.osVersion, 1, 64) ?? batchProfile?.osVersion ?? null;
  const defaultFormFactor =
    nonEmptyString(raw.formFactor, 1, 32) ?? batchProfile?.formFactor ?? null;

  const validated: ValidatedTelemetryEvent[] = [];
  for (const item of raw.events) {
    if (!isRecord(item)) return { ok: false, error: 'invalid_event_item' };
    if (typeof item.kind !== 'string' || !TELEMETRY_KIND_SET.has(item.kind)) {
      return { ok: false, error: 'disallowed_event_kind' };
    }
    const kind = item.kind as TelemetryEventKind;
    const itemProfileRes = sanitizeDeviceProfile(item.deviceProfile);
    if (!itemProfileRes.ok) return itemProfileRes;
    const itemProfile = itemProfileRes.value;
    const mergedProfile =
      batchProfile && itemProfile
        ? { ...batchProfile, ...itemProfile }
        : (itemProfile ?? batchProfile);
    const deviceProfileJson = mergedProfile
      ? JSON.stringify(mergedProfile)
      : defaultDeviceProfileJson;

    const sessionId = nonEmptyString(item.sessionId, 4, 128) ?? defaultSessionId;
    const appVersion = nonEmptyString(item.appVersion, 1, 64) ?? defaultAppVersion;
    const platform = nonEmptyString(item.platform, 1, 64) ?? defaultPlatform;
    if (!sessionId || !appVersion || !platform) {
      return { ok: false, error: 'missing_event_metadata' };
    }
    const osVersion =
      nonEmptyString(item.osVersion, 1, 64) ?? itemProfile?.osVersion ?? defaultOsVersion;
    const formFactor =
      nonEmptyString(item.formFactor, 1, 32) ?? itemProfile?.formFactor ?? defaultFormFactor;
    const rawTs = item.ts ?? item.timestamp;
    let eventTs = nowIso;
    if (rawTs !== undefined && rawTs !== null) {
      if (typeof rawTs === 'string') {
        const parsed = Date.parse(rawTs);
        if (Number.isNaN(parsed) || Math.abs(parsed) > MAX_DATE_MS) {
          return { ok: false, error: 'invalid_event_ts' };
        }
        eventTs = new Date(parsed).toISOString();
      } else if (typeof rawTs === 'number') {
        if (!Number.isFinite(rawTs) || Math.abs(rawTs) > MAX_DATE_MS) {
          return { ok: false, error: 'invalid_event_ts' };
        }
        eventTs = new Date(rawTs).toISOString();
      } else {
        return { ok: false, error: 'invalid_event_ts' };
      }
    }

    const payloadResult = sanitizeTelemetryPayload(kind, item);
    if (!payloadResult.ok) return payloadResult;

    validated.push({
      eventTs,
      sessionId,
      kind,
      appVersion,
      platform,
      osVersion,
      formFactor,
      payload: payloadResult.value,
      deviceProfileJson,
    });
  }
  return { ok: true, value: validated };
}

/** Validates `POST /v1/feedback` submissions. */
export function validateFeedbackInput(raw: unknown): ValidationResult<ValidatedFeedbackInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  if (typeof raw.category !== 'string' || !FEEDBACK_CATEGORY_SET.has(raw.category)) {
    return { ok: false, error: 'invalid_category' };
  }
  const rawMessage = nonEmptyString(raw.message, 1, 2_000);
  if (!rawMessage) return { ok: false, error: 'invalid_message' };
  const message = redactFeedbackMessage(rawMessage).trim();
  if (message.length === 0) return { ok: false, error: 'invalid_message' };
  const appVersion = nonEmptyString(raw.appVersion, 1, 64) ?? 'unknown';
  const platform = nonEmptyString(raw.platform, 1, 64) ?? 'unknown';
  const locale = nonEmptyString(raw.locale, 2, 32);

  let diagnosticsJson: string | null = null;
  if (raw.diagnostics !== undefined && raw.diagnostics !== null) {
    if (!isRecord(raw.diagnostics)) return { ok: false, error: 'invalid_diagnostics' };
    const hit = findSensitivePattern(raw.diagnostics);
    if (hit) return { ok: false, error: `sensitive_diagnostics:${hit}` };
    const serialized = JSON.stringify(raw.diagnostics);
    if (serialized.length > 16 * 1024) {
      return { ok: false, error: 'diagnostics_too_large' };
    }
    diagnosticsJson = serialized;
  }

  return {
    ok: true,
    value: {
      category: raw.category as FeedbackCategory,
      message,
      appVersion,
      platform,
      locale,
      diagnosticsJson,
    },
  };
}

/** Validates `POST /account-deletion` form or JSON payloads and clamps optional notes to 500 chars. */
export function validateAccountDeletionInput(raw: unknown): ValidationResult<AccountDeletionInput> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_body' };
  const email = normalizeEmail(raw.email);
  if (!email) return { ok: false, error: 'invalid_email' };
  let note: string | null = null;
  if (typeof raw.note === 'string') {
    const trimmed = raw.note.trim();
    if (trimmed.length > 0) {
      note = trimmed.slice(0, MAX_DELETION_NOTE_LENGTH);
    }
  }
  return { ok: true, value: { email, note } };
}
