/** Request payload for launching an external Android video player (`#406`). */
export interface ExternalPlayerRequest {
  readonly url: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly startPositionMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chooserTitle?: string;
  readonly packageName?: string;
}

/** Normalized playback return result from an external Android video player (`#406`). */
export interface ExternalPlayerResult {
  readonly launched: boolean;
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly completed: boolean;
}

const MAX_INT32_MS = 2_147_483_647;
const MAX_TEXT_LENGTH = 256;
const SAFE_MIME_RE = /^[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+)$/;
const SAFE_PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function hasControlChars(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stripControlChars(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    out += raw[i];
  }
  return out.trim();
}

function isAllowedExternalUrl(raw: string): boolean {
  if (hasControlChars(raw)) return false;
  const trimmed = raw.trim();
  const sep = trimmed.indexOf('://');
  if (sep <= 0) return false;
  const scheme = trimmed.slice(0, sep).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return false;
  const rest = trimmed.slice(sep + 3);
  return rest.length > 0 && rest[0] !== '/' && rest[0] !== '\\';
}

/** Validates and normalizes an {@link ExternalPlayerRequest} for the Android native bridge (`#406`). */
export function normalizeExternalPlayerRequest(
  request: ExternalPlayerRequest,
): Record<string, unknown> | null {
  if (typeof request.url !== 'string' || !isAllowedExternalUrl(request.url)) return null;
  const out: Record<string, unknown> = {
    url: request.url.trim(),
  };

  if (typeof request.mimeType === 'string') {
    const mime = stripControlChars(request.mimeType).split(';')[0]?.trim().toLowerCase() ?? '';
    if (mime.length > 0 && mime.length <= 128 && SAFE_MIME_RE.test(mime)) {
      out.mimeType = mime;
    }
  }

  if (typeof request.title === 'string') {
    const title = stripControlChars(request.title).slice(0, MAX_TEXT_LENGTH);
    if (title.length > 0) out.title = title;
  }

  if (typeof request.startPositionMs === 'number' && Number.isFinite(request.startPositionMs)) {
    out.startPositionMs = Math.max(0, Math.min(MAX_INT32_MS, Math.round(request.startPositionMs)));
  }

  if (
    typeof request.headers === 'object' &&
    request.headers !== null &&
    !Array.isArray(request.headers)
  ) {
    const cleanHeaders: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v !== 'string' || hasControlChars(k) || hasControlChars(v)) continue;
      const key = k.trim();
      if (key.length === 0) continue;
      cleanHeaders[key] = v;
      count += 1;
    }
    if (count > 0) out.headers = cleanHeaders;
  }

  if (typeof request.chooserTitle === 'string') {
    const chooserTitle = stripControlChars(request.chooserTitle).slice(0, MAX_TEXT_LENGTH);
    if (chooserTitle.length > 0) out.chooserTitle = chooserTitle;
  }

  if (typeof request.packageName === 'string' && !hasControlChars(request.packageName)) {
    const pkg = request.packageName.trim();
    if (pkg.length > 0 && pkg.length <= 128 && SAFE_PACKAGE_RE.test(pkg)) {
      out.packageName = pkg;
    }
  }

  return out;
}

/** Normalizes a raw native `launchExternalPlayer` result payload safely (`#406`). */
export function normalizeExternalPlayerResult(raw: unknown): ExternalPlayerResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as {
    launched?: unknown;
    positionMs?: unknown;
    durationMs?: unknown;
    completed?: unknown;
  };
  const durationMs =
    typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs > 0
      ? Math.round(r.durationMs)
      : null;
  const rawPos =
    typeof r.positionMs === 'number' && Number.isFinite(r.positionMs) && r.positionMs >= 0
      ? Math.round(r.positionMs)
      : null;
  const positionMs = rawPos !== null && durationMs !== null ? Math.min(rawPos, durationMs) : rawPos;
  return {
    launched: Boolean(r.launched),
    positionMs,
    durationMs,
    completed: Boolean(r.completed),
  };
}
