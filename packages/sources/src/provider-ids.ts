const PROVIDER_IMDB_ID_RE = /^tt\d{5,10}$/i;
const PROVIDER_TMDB_ID_RE = /^[1-9]\d{0,9}$/;

/**
 * Validates and normalizes a provider-supplied IMDb title ID (`tt` + 5–10 digits, lowercased).
 * Returns `null` for missing, non-string, malformed, or unsafe values.
 */
export function normalizeProviderImdbId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!PROVIDER_IMDB_ID_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Validates and normalizes a provider-supplied TMDB numeric ID (positive integer, 1–10 digits).
 * Rejects `0`, negative numbers, floats, leading zeros, non-numeric text, or unsafe strings.
 */
export function normalizeProviderTmdbId(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) return null;
    const text = String(raw);
    return PROVIDER_TMDB_ID_RE.test(text) ? text : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!PROVIDER_TMDB_ID_RE.test(trimmed)) return null;
  return trimmed;
}

/** Returns the first valid normalized provider IMDb ID from `candidates`, or `undefined`. */
export function firstProviderImdbId(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const id = normalizeProviderImdbId(candidate);
    if (id !== null) return id;
  }
  return undefined;
}

/** Returns the first valid normalized provider TMDB ID from `candidates`, or `undefined`. */
export function firstProviderTmdbId(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const id = normalizeProviderTmdbId(candidate);
    if (id !== null) return id;
  }
  return undefined;
}
