const RFC7230_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
    if (cleanName === '__proto__') {
      Object.defineProperty(out, cleanName, {
        value: cleanValue,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[cleanName] = cleanValue;
    }
  }
  return out;
}
