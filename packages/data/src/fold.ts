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
