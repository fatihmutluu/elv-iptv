const LEADING_ARTICLE = /^(?:the|a|an|bir)\s+(.+)$/;

/**
 * Folds text for case-, accent- and punctuation-insensitive matching: explicit Turkish lower-casing
 * (`İ` to `i`, `I` to `ı`, then `ı` to `i`), combining marks removed after NFD, `ß` to `ss`, and every run of
 * non-letters and non-digits collapsed to one space. Pure and locale-independent.
 */
export function foldText(text: string): string {
  return text
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Returns a folded sort key for alphabetical catalog ordering, stripping a leading folded article
 * (`the`, `a`, `an`, `bir`) followed by whitespace when a non-empty remainder exists.
 */
export function sortTitleKey(name: string): string {
  const folded = foldText(name);
  const match = LEADING_ARTICLE.exec(folded);
  return match?.[1] ?? folded;
}
