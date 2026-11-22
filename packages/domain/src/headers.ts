const RFC7230_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ANY_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HTTP_SCHEME_RE = /^https?:\/\//i;
const DIGITS_RE = /^[0-9]+$/;
const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443 };
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
]);

/** Sets a header entry on `out` safely without triggering `Object.prototype.__proto__` mutation. */
export function setSafeHeader(out: Record<string, string>, name: string, value: string): void {
  if (name === '__proto__') {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    out[name] = value;
  }
}

function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates and trims an HTTP header field name against RFC 7230 token characters.
 * Returns `undefined` when empty or containing whitespace, delimiters, or control characters.
 */
export function sanitizeHeaderName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0 || !RFC7230_TOKEN_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Strips CR, LF, NUL, and ASCII control characters (`0x00–0x1F`, `0x7F`) from a header value
 * and trims surrounding whitespace so untrusted playlist headers cannot crash HTTP stacks or
 * inject extra fields.
 */
export function sanitizeHeaderValue(value: string): string {
  let cleaned = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    cleaned += value[i];
  }
  return cleaned.trim();
}

/**
 * Returns a fresh header record containing only valid RFC 7230 header names and non-empty
 * control-character-free header values. Safe against `__proto__` and `Object.prototype` keys.
 */
export function sanitizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  for (const key of Object.keys(headers)) {
    const raw = headers[key];
    if (typeof raw !== 'string') continue;
    const cleanName = sanitizeHeaderName(key);
    if (cleanName === undefined) continue;
    const cleanValue = sanitizeHeaderValue(raw);
    if (cleanValue.length === 0) continue;
    setSafeHeader(out, cleanName, cleanValue);
  }
  return out;
}

/**
 * Pure RFC 3986 HTTP(S) origin parser (`scheme://host[:port]`). Accepts only `http` and `https`,
 * normalizes scheme and host to lowercase, strips default ports (`http:80`, `https:443`), ignores
 * userinfo/path/query/fragment, and returns `undefined` for non-HTTP(S), relative, or malformed URLs.
 */
export function originOf(url: string): string | undefined {
  const sep = url.indexOf('://');
  if (sep <= 0) return undefined;
  const scheme = url.slice(0, sep).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return undefined;

  const authStart = sep + 3;
  let authEnd = url.length;
  for (let i = authStart; i < url.length; i++) {
    const ch = url[i];
    if (ch === '/' || ch === '\\' || ch === '?' || ch === '#') {
      authEnd = i;
      break;
    }
  }
  const authority = url.slice(authStart, authEnd);
  if (authority.length === 0) return undefined;

  const atIdx = authority.lastIndexOf('@');
  const hostPort = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  if (hostPort.length === 0 || hasControlOrSpace(hostPort)) return undefined;

  let host: string;
  let portPart: string;
  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']');
    if (closeIdx <= 1) return undefined;
    host = hostPort.slice(0, closeIdx + 1).toLowerCase();
    portPart = hostPort.slice(closeIdx + 1);
    if (portPart.length > 0 && !portPart.startsWith(':')) return undefined;
  } else {
    const colonIdx = hostPort.indexOf(':');
    host = (colonIdx === -1 ? hostPort : hostPort.slice(0, colonIdx)).toLowerCase();
    if (host.length === 0 || host.includes('[') || host.includes(']')) return undefined;
    portPart = colonIdx === -1 ? '' : hostPort.slice(colonIdx);
  }

  let port = '';
  if (portPart.length > 1) {
    const rawPort = portPart.slice(1);
    if (!DIGITS_RE.test(rawPort)) return undefined;
    const portNum = Number(rawPort);
    if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65_535) return undefined;
    if (DEFAULT_PORTS[scheme] !== portNum) port = String(portNum);
  }

  return port.length > 0 ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}

/** Returns `true` when both URLs have valid, identical normalized origins. */
export function sameOrigin(a: string, b: string): boolean {
  const oa = originOf(a);
  return oa !== undefined && oa === originOf(b);
}

/**
 * Returns `true` when `headers` contains a non-empty `Authorization`, `Proxy-Authorization`,
 * `Cookie`, `X-Api-Key`, or `X-Auth-Token` header.
 */
export function hasCredentialHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  if (headers === undefined) return false;
  for (const key of Object.keys(headers)) {
    const raw = headers[key];
    if (typeof raw !== 'string') continue;
    const cleanName = sanitizeHeaderName(key);
    if (cleanName === undefined) continue;
    if (!CREDENTIAL_HEADER_NAMES.has(cleanName.toLowerCase())) continue;
    if (sanitizeHeaderValue(raw).length > 0) return true;
  }
  return false;
}

/**
 * Returns sanitized headers for `targetUrl`, stripping `Authorization`, `Proxy-Authorization`,
 * `Cookie`, `X-Api-Key`, and `X-Auth-Token` whenever `targetUrl` is not exact-origin with `initialUrl`.
 */
export function scopeCredentialHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  initialUrl: string,
  targetUrl: string,
): Record<string, string> {
  const sanitized = sanitizeHeaders(headers);
  if (sameOrigin(initialUrl, targetUrl)) return sanitized;
  const scoped: Record<string, string> = {};
  for (const key of Object.keys(sanitized)) {
    if (CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())) continue;
    const value = sanitized[key];
    if (value !== undefined) setSafeHeader(scoped, key, value);
  }
  return scoped;
}

/**
 * Pure RFC 3986 HTTP(S) redirect target resolver (`Location` relative to `baseUrl`).
 * Rejects empty, malformed, or non-HTTP(S) schemes (`javascript:`, `file:`, `data:`).
 */
export function resolveRedirectUrl(baseUrl: string, rawLocation: string): string | undefined {
  const loc = sanitizeHeaderValue(rawLocation);
  if (loc.length === 0) return undefined;
  if (ANY_SCHEME_RE.test(loc)) {
    return HTTP_SCHEME_RE.test(loc) && originOf(loc) !== undefined ? loc : undefined;
  }
  const baseOrigin = originOf(baseUrl);
  if (baseOrigin === undefined) return undefined;
  const baseScheme = baseOrigin.slice(0, baseOrigin.indexOf('://'));
  if (loc.startsWith('//')) {
    const candidate = `${baseScheme}:${loc}`;
    return HTTP_SCHEME_RE.test(candidate) && originOf(candidate) !== undefined
      ? candidate
      : undefined;
  }
  const afterScheme = baseUrl.indexOf('://') + 3;
  let pathStart = baseUrl.length;
  for (let i = afterScheme; i < baseUrl.length; i++) {
    const ch = baseUrl[i];
    if (ch === '/' || ch === '?' || ch === '#') {
      pathStart = i;
      break;
    }
  }
  const tail = baseUrl.slice(pathStart);
  const hashIdx = tail.indexOf('#');
  const pathAndQuery = hashIdx === -1 ? tail : tail.slice(0, hashIdx);
  const qIdx = pathAndQuery.indexOf('?');
  const basePath = qIdx === -1 ? pathAndQuery : pathAndQuery.slice(0, qIdx);
  if (loc.startsWith('/')) return `${baseOrigin}${loc}`;
  if (loc.startsWith('?')) return `${baseOrigin}${basePath || '/'}${loc}`;
  if (loc.startsWith('#')) return `${baseOrigin}${pathAndQuery || '/'}${loc}`;

  const sufIdx = loc.search(/[?#]/);
  const relPath = sufIdx === -1 ? loc : loc.slice(0, sufIdx);
  const suffix = sufIdx === -1 ? '' : loc.slice(sufIdx);
  const lastSlash = basePath.lastIndexOf('/');
  const baseDir = lastSlash === -1 ? '/' : basePath.slice(0, lastSlash + 1);
  const segments: string[] = [];
  for (const seg of `${baseDir}${relPath}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  const trailing =
    segments.length > 0 &&
    (relPath.endsWith('/') || relPath.endsWith('/.') || relPath.endsWith('/..'))
      ? '/'
      : '';
  return `${baseOrigin}/${segments.join('/')}${trailing}${suffix}`;
}
