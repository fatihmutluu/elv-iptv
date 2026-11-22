const COUNTRY_CODE_TOKEN = /^[A-Z]{2}$/;
const CURATED_TAG_TOKENS: ReadonlySet<string> = new Set([
  '4K',
  '8K',
  'UHD',
  'FHD',
  'HD',
  'SD',
  'RAW',
  'VIP',
  'HEVC',
  'H265',
  'H.265',
  'H264',
  'HDR',
  'HDR10',
  'DV',
  'MULTI',
  'DUAL',
  'SUB',
  'DUB',
  'VOD',
  'LIVE',
  'NEW',
  'TOP',
  'ULTRA',
  'LOW',
  'BACKUP',
  '1080P',
  '720P',
  '2160P',
  '60FPS',
  '50FPS',
]);

const LEADING_BRACKET_RE = /^\[([^\]]{1,24})\]\s*(?:[-–—:|/•·]\s*)?/;
const LEADING_DELIMITED_RE =
  /^([A-Za-z0-9.]{2,10}(?:\s+[A-Za-z0-9.]{2,10})?)\s*(?:([|:])\s*|\s+[-–—]\s+|[-–—]\s+)/;
const TRAILING_COUNTRY_RE = /\s*[([]([A-Z]{2})[)\]]\s*$/;
const TRAILING_COUNTRY_BEFORE_YEAR_RE = /\s*[([]([A-Z]{2})[)\]](\s*\((?:19|20)\d{2}\))\s*$/;

function isCuratedTagAtom(atom: string): boolean {
  if (COUNTRY_CODE_TOKEN.test(atom)) return true;
  return CURATED_TAG_TOKENS.has(atom.toUpperCase());
}

function isCuratedPrefixGroup(rawGroup: string): boolean {
  const atoms = rawGroup
    .trim()
    .split(/[\s/+-]+/)
    .filter(Boolean);
  return atoms.length > 0 && atoms.every(isCuratedTagAtom);
}

const UPPERCASE_ONLY_CURATED_WORDS: ReadonlySet<string> = new Set([
  'LIVE',
  'NEW',
  'TOP',
  'RAW',
  'LOW',
  'ULTRA',
  'SUB',
  'DUB',
  'DUAL',
  'MULTI',
  'BACKUP',
  'VIP',
]);

function isCuratedDelimitedPrefix(rawPrefix: string): boolean {
  const atoms = rawPrefix.trim().split(/\s+/).filter(Boolean);
  if (atoms.length === 0) return false;
  return atoms.every((atom) => {
    if (COUNTRY_CODE_TOKEN.test(atom)) return true;
    const upper = atom.toUpperCase();
    // Require uppercase for 2-letter alphabetic tags and ambiguous dictionary words
    // so title-case titles like "It: Chapter Two", "Live: From New York", and "Top: Secret" stay intact
    if (
      (atom.length === 2 && /^[A-Za-z]{2}$/.test(atom)) ||
      UPPERCASE_ONLY_CURATED_WORDS.has(upper)
    ) {
      return CURATED_TAG_TOKENS.has(upper) && atom === upper;
    }
    return CURATED_TAG_TOKENS.has(upper);
  });
}

/**
 * Cleans provider prefix/suffix clutter from a catalog display title (`#194`) while preserving
 * trailing `(YYYY)` release years (e.g. `Cosmic Drift (2024)`) and leading numeric titles
 * (`2001: A Space Odyssey`, `2001. A Space Odyssey`, `1917`).
 *
 * Strips leading curated prefix tags (`[TR]`, `TR |`, `UK:`, `FHD |`, `4K -`, `RAW |`, `VIP |`)
 * and trailing 2-letter uppercase country codes (`(TR)`, `(US)`, `[UK]`). Never returns an empty
 * string for a non-empty input.
 */
export function cleanDisplayTitle(raw: string): string {
  const original = raw.trim().replace(/\s+/g, ' ');
  if (original === '') return '';

  let current = original;

  for (;;) {
    const bracketMatch = LEADING_BRACKET_RE.exec(current);
    if (bracketMatch !== null && isCuratedPrefixGroup(bracketMatch[1] ?? '')) {
      const rest = current.slice(bracketMatch[0].length).trim();
      if (rest === '') break;
      current = rest;
      continue;
    }

    const delimMatch = LEADING_DELIMITED_RE.exec(current);
    if (delimMatch !== null && isCuratedDelimitedPrefix(delimMatch[1] ?? '')) {
      const rest = current.slice(delimMatch[0].length).trim();
      if (rest === '') break;
      current = rest;
      continue;
    }

    break;
  }

  for (;;) {
    if (TRAILING_COUNTRY_RE.test(current)) {
      const next = current.replace(TRAILING_COUNTRY_RE, '').trim();
      if (next !== '') {
        current = next;
        continue;
      }
    }
    if (TRAILING_COUNTRY_BEFORE_YEAR_RE.test(current)) {
      const next = current.replace(TRAILING_COUNTRY_BEFORE_YEAR_RE, '$2').trim();
      if (next !== '') {
        current = next;
        continue;
      }
    }
    break;
  }

  return current === '' ? original : current;
}
