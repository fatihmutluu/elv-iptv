import { redactText } from '@elv/domain';

/** Sanitized hardware and runtime profile attached to opt-in telemetry batches (`#509`). */
export interface DeviceTechnicalProfile {
  readonly osVersion?: string;
  readonly formFactor?: string;
  readonly arch?: string;
  readonly ramBucket?: string;
  readonly gpu?: string;
  readonly resolution?: string;
  readonly locale?: string;
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_STACK_SIG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+>;-]{0,127}$/;
const SAFE_DISPLAY_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/+()-]{0,63}$/;
const FOUR_PART_OS_VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

const IPV4_DETECT_RE = /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^0-9])/;
const IPV4_REPLACE_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)(?::\d{1,5})?\b/g;

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

const MULTI_LABEL_HOSTNAME_RE = /[a-z0-9-]+\.[a-z0-9-]+\.[a-z]{2,}/i;
const COMMON_TLD_HOSTNAME_RE = /[a-z0-9-]+\.(?:com|net|org|tv|io|xyz|me|cc|live|stream|example)\b/i;
const FORBIDDEN_PATTERNS_RE =
  /(:\/\/|@|\\|\/Users\/|\/home\/|\/data\/|\/etc\/|\/var\/|\/tmp\/|\/private\/|\/storage\/|bearer\s|basic\s|authorization|cookie|passwd|password|secret|token=|api_key|apikey)/i;

const URL_STRIP_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi;
const FILE_STRIP_RE = /\bfile:[^\s'"<>)\]]+/gi;
const WIN_HOME_STRIP_RE = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\s'"<>)\]]+/gi;
const WIN_DRIVE_STRIP_RE = /\b[A-Za-z]:\\[^\s'"<>)\]]+/g;
const UNC_PATH_STRIP_RE = /\\\\[A-Za-z0-9_.-]+\\[^\s'"<>)\]]+/g;
const POSIX_PATH_STRIP_RE =
  /(^|[\s"'(=:|,])\/(?:Users|home|var|tmp|private|data|storage)\/[^\s'"<>)\]]+/g;
const CRED_AT_HOST_RE = /(^|[\s"'(=:|,])[^\s/:@]{1,128}:[^\s/:@]{1,128}@[^\s/:@"'<>)\]]+/g;
const EMAIL_STRIP_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
const AUTH_BEARER_STRIP_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_HEADER_STRIP_RE =
  /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)\s*[:=]\s*[^\r\n|]+/gi;
const SECRET_KV_STRIP_RE =
  /\b(?:password|passwd|secret|token|access_token|refresh_token|api_key|apikey|auth_token|jwt)\s*[:=]\s*[^\s&'";,)|]+/gi;

function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += input.charAt(i);
    } else {
      out += ' ';
    }
  }
  return out;
}

/**
 * Strips Windows/POSIX user home paths, URLs, `user:pass@` credentials, emails, IPv4/IPv6
 * addresses, and auth headers/tokens from arbitrary diagnostic strings before safe token
 * or signature extraction (`#509`).
 */
export function redactDiagnosticText(input: string, maxLen = 128): string {
  const limit = Number.isInteger(maxLen) && maxLen > 0 ? maxLen : 128;
  const pass1 = input
    .replace(URL_STRIP_RE, '[redacted-url]')
    .replace(FILE_STRIP_RE, '[redacted-path]')
    .replace(WIN_HOME_STRIP_RE, '[redacted-path]')
    .replace(WIN_DRIVE_STRIP_RE, '[redacted-path]')
    .replace(UNC_PATH_STRIP_RE, '[redacted-path]')
    .replace(POSIX_PATH_STRIP_RE, '$1[redacted-path]')
    .replace(CRED_AT_HOST_RE, '$1[redacted-cred]')
    .replace(EMAIL_STRIP_RE, '[redacted-email]')
    .replace(AUTH_HEADER_STRIP_RE, '[redacted-auth]')
    .replace(AUTH_BEARER_STRIP_RE, '[redacted-token]')
    .replace(SECRET_KV_STRIP_RE, '[redacted-secret]')
    .replace(IPV6_BRACKET_REPLACE_RE, '[redacted-ip]')
    .replace(IPV6_BARE_REPLACE_RE, '$1[redacted-ip]')
    .replace(IPV4_REPLACE_RE, '[redacted-ip]');
  const pass2 = redactText(pass1);
  const collapsed = stripControlChars(pass2).replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}

/** Validates a strict single-token telemetry identifier (double-redacted, zero PII/URLs/IPs). */
export function sanitizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (
    FORBIDDEN_PATTERNS_RE.test(trimmed) ||
    IPV4_DETECT_RE.test(trimmed) ||
    IPV6_DETECT_RE.test(trimmed) ||
    MULTI_LABEL_HOSTNAME_RE.test(trimmed) ||
    COMMON_TLD_HOSTNAME_RE.test(trimmed)
  ) {
    return null;
  }
  const firstRedacted = redactText(trimmed);
  const secondRedacted = redactDiagnosticText(firstRedacted, 64);
  if (firstRedacted !== trimmed || secondRedacted !== trimmed) return null;
  if (!SAFE_TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validates a telemetry error name token, normalizing safe slash-delimited `ElvError` codes
 * (`category/code` -> `category.code`) after rejecting URLs, paths, IPs, credentials, and hostnames.
 */
export function sanitizeErrorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('//') ||
    FORBIDDEN_PATTERNS_RE.test(trimmed) ||
    IPV4_DETECT_RE.test(trimmed) ||
    IPV6_DETECT_RE.test(trimmed) ||
    MULTI_LABEL_HOSTNAME_RE.test(trimmed) ||
    COMMON_TLD_HOSTNAME_RE.test(trimmed)
  ) {
    return null;
  }
  if (redactText(trimmed) !== trimmed || redactDiagnosticText(trimmed, 64) !== trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\//g, '.');
  if (
    FORBIDDEN_PATTERNS_RE.test(normalized) ||
    IPV4_DETECT_RE.test(normalized) ||
    !SAFE_TOKEN_RE.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Validates an optional strict telemetry token. */
export function sanitizeOptionalToken(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return sanitizeToken(value);
}

/** Validates a compact, path-free stack signature (e.g. `PlayerScreen.tsx:142` or `a1b2c3d4`). */
export function sanitizeStackSig(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (
    FORBIDDEN_PATTERNS_RE.test(trimmed) ||
    IPV4_DETECT_RE.test(trimmed) ||
    IPV6_DETECT_RE.test(trimmed) ||
    MULTI_LABEL_HOSTNAME_RE.test(trimmed) ||
    COMMON_TLD_HOSTNAME_RE.test(trimmed)
  ) {
    return null;
  }
  if (redactText(trimmed) !== trimmed || redactDiagnosticText(trimmed, 128) !== trimmed) {
    return null;
  }
  if (!SAFE_STACK_SIG_RE.test(trimmed)) return null;
  return trimmed;
}

function sanitizeDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (
    FORBIDDEN_PATTERNS_RE.test(trimmed) ||
    IPV4_DETECT_RE.test(trimmed) ||
    IPV6_DETECT_RE.test(trimmed) ||
    MULTI_LABEL_HOSTNAME_RE.test(trimmed) ||
    COMMON_TLD_HOSTNAME_RE.test(trimmed)
  ) {
    return undefined;
  }
  if (redactText(trimmed) !== trimmed || redactDiagnosticText(trimmed, 64) !== trimmed) {
    return undefined;
  }
  if (!SAFE_DISPLAY_LABEL_RE.test(trimmed)) return undefined;
  return trimmed;
}

function sanitizeOsVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (FOUR_PART_OS_VERSION_RE.test(trimmed)) {
    return trimmed;
  }
  return sanitizeDisplayLabel(trimmed);
}

/** Sanitizes a {@link DeviceTechnicalProfile}, stripping any field with unsafe characters or PII. */
export function sanitizeDeviceProfile(raw: unknown): DeviceTechnicalProfile | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const osVersion = sanitizeOsVersion(rec.osVersion);
  const formFactor = sanitizeToken(rec.formFactor) ?? undefined;
  const arch = sanitizeToken(rec.arch) ?? undefined;
  const ramBucket = sanitizeToken(rec.ramBucket) ?? undefined;
  const gpu = sanitizeDisplayLabel(rec.gpu);
  const resolution = sanitizeToken(rec.resolution) ?? undefined;
  const locale = sanitizeToken(rec.locale) ?? undefined;

  const out: {
    osVersion?: string;
    formFactor?: string;
    arch?: string;
    ramBucket?: string;
    gpu?: string;
    resolution?: string;
    locale?: string;
  } = {};
  if (osVersion !== undefined) out.osVersion = osVersion;
  if (formFactor !== undefined) out.formFactor = formFactor;
  if (arch !== undefined) out.arch = arch;
  if (ramBucket !== undefined) out.ramBucket = ramBucket;
  if (gpu !== undefined) out.gpu = gpu;
  if (resolution !== undefined) out.resolution = resolution;
  if (locale !== undefined) out.locale = locale;
  return Object.keys(out).length > 0 ? out : undefined;
}
