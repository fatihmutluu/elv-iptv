import type { ElvError } from '@elv/domain';

const HTTP_CODE_RE = /^http-(\d{3})$/i;
const SAFE_DETAIL_HTTP_RE =
  /(?:^|[\s,(;])(?:http(?:\/1\.[01]|\/2)?\s+|status\s*[=:]\s*)(\d{3})(?:$|[\s),;])/i;
const STACK_FRAME_RE = /(?:[\r\n]|\bat\s+\S+\s*\(|file:\/\/|webpack:\/\/|node_modules|:\d+:\d+)/i;
const RAW_CLASS_RE =
  /(?:\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Throwable|Failure)\b|\bError\s*:|\bSQLITE_[A-Z_]+\b|\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|ERR_[A-Z_]+)\b|\b(?:java\.|android\.|androidx\.|com\.google\.|org\.media3\.|mpv_error)\S*)/;
const URL_OR_CREDENTIAL_RE =
  /(?:https?:\/\/|rtmps?:\/\/|rtsps?:\/\/|[?&](?:username|user|password|pass|token|auth|key|secret|sig)=|[^\s/:]+:[^\s/@]+@|\bBearer\s+\S+)/i;
const MAX_SAFE_DETAIL_LEN = 120;

function parseErrorHttpStatus(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : undefined;
}

/**
 * Extracts a numeric HTTP error status (`400..599`) from `error.code` (e.g. `http-403`) or safe
 * `detail` status patterns (`HTTP 503`, `status=429`), ignoring URL ports/paths (`#63`).
 */
export function extractHttpStatus(error: ElvError): number | undefined {
  const fromCode = HTTP_CODE_RE.exec(error.code.trim());
  if (fromCode?.[1] !== undefined) {
    return parseErrorHttpStatus(fromCode[1]);
  }
  const detail = error.detail;
  if (detail === undefined || detail.trim().length === 0) return undefined;
  const fromDetail = SAFE_DETAIL_HTTP_RE.exec(detail);
  return fromDetail?.[1] !== undefined ? parseErrorHttpStatus(fromDetail[1]) : undefined;
}

/**
 * Rejects any raw stack trace, JS/native class name (`TypeError`, `AbortError`, `SQLITE_ERROR`,
 * `ExoPlaybackException`), URL, or credential so internal details can never leak onto UI (`#63`).
 */
export function sanitizeErrorDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SAFE_DETAIL_LEN) return undefined;
  if (STACK_FRAME_RE.test(trimmed)) return undefined;
  if (RAW_CLASS_RE.test(trimmed)) return undefined;
  if (URL_OR_CREDENTIAL_RE.test(trimmed)) return undefined;
  return trimmed.replace(/\s+/g, ' ');
}
