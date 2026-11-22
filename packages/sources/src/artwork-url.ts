/** Maximum byte/char length kept for inline `data:` artwork attributes (`#169`, `#428`). */
export const MAX_INLINE_LOGO_BYTES = 4096;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects ASCII control characters in artwork URLs
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const HTTP_SCHEME_RE = /^https?:\/\//i;
const DATA_SCHEME_RE = /^data:/i;
const DATA_IMAGE_RE = /^data:image\/([a-z0-9][a-z0-9.+-]*)(?:;[^,]*)?,/i;

/** Result of validating an artwork URL (`tvg-logo`, XMLTV `<icon src>`, Xtream `stream_icon`/`cover`). */
export interface ArtworkUrlResult {
  url?: string;
  oversizedData?: boolean;
}

function hasValidHttpHost(url: string, schemePrefixLen: number): boolean {
  const afterScheme = url.slice(schemePrefixLen);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.length === 0) return false;
  if (hostPort.startsWith('[')) {
    const closeBracket = hostPort.indexOf(']');
    if (closeBracket <= 1) return false;
    const host = hostPort.slice(1, closeBracket);
    return !/\s/.test(host);
  }
  const colon = hostPort.indexOf(':');
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  return host.length > 0 && !/\s/.test(host);
}

/**
 * Validates and trims an artwork URL (`#428`). Allows only `http://` / `https://` URLs with a
 * non-empty host, or bounded (`<= MAX_INLINE_LOGO_BYTES`) non-SVG `data:image/*` URIs.
 * Rejects control characters, unsafe schemes (`javascript:`, `file:`, `ftp:`, `content:`),
 * SVG/HTML `data:` URIs, protocol-relative (`//`), and relative/schemeless paths.
 */
export function sanitizeArtworkUrl(raw: string): ArtworkUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || CONTROL_CHAR_RE.test(trimmed)) return {};

  const httpMatch = HTTP_SCHEME_RE.exec(trimmed);
  if (httpMatch !== null) {
    return hasValidHttpHost(trimmed, httpMatch[0].length) ? { url: trimmed } : {};
  }

  if (DATA_SCHEME_RE.test(trimmed)) {
    if (trimmed.length > MAX_INLINE_LOGO_BYTES) return { oversizedData: true };
    const imageMatch = DATA_IMAGE_RE.exec(trimmed);
    if (imageMatch === null) return {};
    const subtype = (imageMatch[1] ?? '').toLowerCase();
    if (subtype === 'svg' || subtype.includes('svg')) return {};
    return { url: trimmed };
  }

  return {};
}
