import { originOf, sanitizeHeaderName, sanitizeHeaderValue, setSafeHeader } from './headers';

const DEFAULT_MAX_COOKIES = 128;
const COOKIE_PAIR_START_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/;
const MAX_AGE_RE = /^-?\d+$/;

/** Options for {@link createCookieJar}. */
export interface CookieJarOptions {
  /** Maximum number of cookies retained in memory (default `128`). */
  maxCookies?: number;
  /** Clock returning epoch milliseconds for expiration checks (default `Date.now`). */
  now?: () => number;
}

/** Bounded, in-memory, exact-origin RFC 6265 cookie jar. Never persisted to disk or SQLite. */
export interface CookieJar {
  /** Parses and stores one or more `Set-Cookie` headers strictly under `originOf(url)`. */
  store(url: string, setCookieHeaders: string | readonly string[] | undefined): void;
  /** Returns a `Cookie` header value matching exact origin, path, and `Secure` constraints. */
  headerFor(url: string): string | undefined;
  /** Drops all stored cookies. */
  clear(): void;
  /** Current number of stored cookies. */
  readonly size: number;
}

interface StoredCookie {
  readonly origin: string;
  readonly path: string;
  readonly name: string;
  readonly value: string;
  readonly secure: boolean;
  readonly expiresAt: number | undefined;
  readonly createdAt: number;
}

function extractPath(url: string): string {
  const sep = url.indexOf('://');
  if (sep < 0) return '/';
  const authStart = sep + 3;
  let pathStart = url.length;
  for (let i = authStart; i < url.length; i++) {
    const ch = url[i];
    if (ch === '/' || ch === '?' || ch === '#') {
      pathStart = i;
      break;
    }
  }
  const tail = url.slice(pathStart);
  const endIdx = tail.search(/[?#]/);
  const path = endIdx === -1 ? tail : tail.slice(0, endIdx);
  return path.startsWith('/') ? path : '/';
}

/** RFC 6265 §5.1.4 default-path algorithm. */
function defaultPathOf(url: string): string {
  const uriPath = extractPath(url);
  const lastSlash = uriPath.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : uriPath.slice(0, lastSlash);
}

/** RFC 6265 §5.1.4 path-match algorithm. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/**
 * Splits a comma-joined `Set-Cookie` header string into individual cookies without splitting
 * commas inside RFC 6265 / RFC 7231 `Expires=` HTTP dates or double-quoted values.
 */
function splitSetCookieHeader(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch !== ',' || inQuotes) continue;
    let j = i + 1;
    while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
    let k = j;
    while (k < raw.length && raw[k] !== ';' && raw[k] !== ',') k++;
    if (COOKIE_PAIR_START_RE.test(raw.slice(j, k))) {
      const piece = raw.slice(start, i).trim();
      if (piece.length > 0) out.push(piece);
      start = i + 1;
    }
  }
  const tail = raw.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Creates a bounded in-memory per-origin RFC 6265 cookie jar.
 * Keys cookies strictly by exact `originOf(url)` (`scheme://host[:port]`), ignoring `Domain`
 * widening attributes, enforcing `Path`, `Secure`, `Max-Age` (precedence over `Expires`),
 * and evicting expired or oldest entries beyond `maxCookies`.
 */
export function createCookieJar(options?: CookieJarOptions): CookieJar {
  const rawMax = options?.maxCookies;
  const maxCookies =
    rawMax === undefined || !Number.isFinite(rawMax)
      ? DEFAULT_MAX_COOKIES
      : Math.max(1, Math.floor(rawMax));
  const now = options?.now ?? Date.now;
  const cookies = new Map<string, StoredCookie>();
  let seq = 0;

  const purgeExpired = (nowMs: number): void => {
    for (const [key, entry] of cookies) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= nowMs) {
        cookies.delete(key);
      }
    }
  };

  const storeOne = (origin: string, defPath: string, rawHeader: string, nowMs: number): void => {
    const parts = rawHeader.split(';');
    const first = parts[0];
    if (first === undefined) return;
    const eqIdx = first.indexOf('=');
    if (eqIdx <= 0) return;

    const name = sanitizeHeaderName(first.slice(0, eqIdx));
    if (name === undefined) return;
    const value = sanitizeHeaderValue(first.slice(eqIdx + 1));

    let path = defPath;
    let secure = false;
    let hasMaxAge = false;
    let maxAgeExpiresAt: number | undefined;
    let expiresHeaderAt: number | undefined;

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i]?.trim();
      if (!attr) continue;
      const attrEq = attr.indexOf('=');
      const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
      const attrVal = attrEq === -1 ? '' : attr.slice(attrEq + 1).trim();

      if (attrName === 'secure') {
        secure = true;
      } else if (attrName === 'path') {
        path = attrVal.startsWith('/') ? attrVal : defPath;
      } else if (attrName === 'max-age') {
        if (MAX_AGE_RE.test(attrVal)) {
          const delta = Number(attrVal);
          if (Number.isFinite(delta)) {
            hasMaxAge = true;
            maxAgeExpiresAt = delta <= 0 ? Number.NEGATIVE_INFINITY : nowMs + delta * 1000;
          }
        }
      } else if (attrName === 'expires') {
        const parsed = Date.parse(attrVal);
        if (Number.isFinite(parsed)) {
          expiresHeaderAt = parsed;
        }
      }
      // `Domain` is intentionally ignored to prevent cross-origin widening.
    }

    const expiresAt = hasMaxAge ? maxAgeExpiresAt : expiresHeaderAt;
    const key = `${origin}\0${path}\0${name}`;
    if (expiresAt !== undefined && expiresAt <= nowMs) {
      cookies.delete(key);
      return;
    }

    cookies.delete(key);
    cookies.set(key, {
      origin,
      path,
      name,
      value,
      secure,
      expiresAt,
      createdAt: ++seq,
    });

    if (cookies.size > maxCookies) {
      purgeExpired(nowMs);
      while (cookies.size > maxCookies) {
        const oldestKey = cookies.keys().next().value;
        if (oldestKey === undefined) break;
        cookies.delete(oldestKey);
      }
    }
  };

  return {
    store(url, setCookieHeaders) {
      if (setCookieHeaders === undefined) return;
      const origin = originOf(url);
      if (origin === undefined) return;
      const defPath = defaultPathOf(url);
      const nowMs = now();
      const headers =
        typeof setCookieHeaders === 'string'
          ? splitSetCookieHeader(setCookieHeaders)
          : setCookieHeaders;
      for (const h of headers) {
        if (h.length > 0) storeOne(origin, defPath, h, nowMs);
      }
    },

    headerFor(url) {
      const origin = originOf(url);
      if (origin === undefined) return undefined;
      const isHttps = origin.startsWith('https://');
      const reqPath = extractPath(url);
      const nowMs = now();
      const matched: StoredCookie[] = [];

      for (const [key, entry] of cookies) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= nowMs) {
          cookies.delete(key);
          continue;
        }
        if (entry.origin !== origin) continue;
        if (entry.secure && !isHttps) continue;
        if (!pathMatches(reqPath, entry.path)) continue;
        matched.push(entry);
      }

      if (matched.length === 0) return undefined;
      matched.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
      return matched.map((c) => `${c.name}=${c.value}`).join('; ');
    },

    clear() {
      cookies.clear();
    },

    get size() {
      return cookies.size;
    },
  };
}

/**
 * Merges a jar-computed `Cookie` header into a fresh copy of `headers` without mutating `headers`.
 * Jar cookies override same-name caller cookies while preserving non-conflicting caller pairs.
 */
export function mergeCookieHeader(
  headers: Record<string, string> | undefined,
  jarCookie: string | undefined,
): Record<string, string> | undefined {
  if (jarCookie === undefined || jarCookie.length === 0) return headers;
  if (headers === undefined) return { Cookie: jarCookie };

  const out: Record<string, string> = {};
  let existingKey: string | undefined;
  let existingVal: string | undefined;
  for (const key of Object.keys(headers)) {
    const val = headers[key];
    if (val === undefined) continue;
    if (key.toLowerCase() === 'cookie') {
      existingKey = key;
      existingVal = val;
    } else {
      setSafeHeader(out, key, val);
    }
  }

  if (existingVal === undefined || existingVal.trim().length === 0) {
    setSafeHeader(out, existingKey ?? 'Cookie', jarCookie);
    return out;
  }

  const jarNames = new Set<string>();
  for (const part of jarCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jarNames.add(part.slice(0, eq).trim());
  }

  const kept: string[] = [];
  for (const part of existingVal.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    const name = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (name.length > 0 && jarNames.has(name)) continue;
    kept.push(trimmed);
  }
  const merged = kept.length > 0 ? `${kept.join('; ')}; ${jarCookie}` : jarCookie;
  setSafeHeader(out, existingKey ?? 'Cookie', merged);
  return out;
}

/** Extracts `Set-Cookie` headers from a Fetch response via `getSetCookie()`, `get()`, or collected headers. */
export function extractSetCookies(
  raw: {
    get?(name: string): string | null;
    getSetCookie?(): string[];
  },
  collected: Readonly<Record<string, string>>,
): string | readonly string[] | undefined {
  if (typeof raw.getSetCookie === 'function') {
    const list = raw.getSetCookie();
    if (list.length > 0) return list;
  }
  if (typeof raw.get === 'function') {
    const single = raw.get('set-cookie');
    if (single !== null && single.length > 0) return single;
  }
  return collected['set-cookie'];
}
