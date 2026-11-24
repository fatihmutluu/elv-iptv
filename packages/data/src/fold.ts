const LEADING_ARTICLE = /^(?:the|a|an|bir)\s+(.+)$/;
const CAMEL_LOWER_UPPER_RE = /(\p{Ll})(\p{Lu})/gu;
const CAMEL_ACRONYM_WORD_RE = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;
const LETTER_DIGIT_RE = /(\p{L})(\p{N})/gu;
const DIGIT_LETTER_RE = /(\p{N})(\p{L})/gu;

const ENGLISH_NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const ASCII_NON_ALNUM_RE = /[^a-z0-9]+/g;

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Folds text for case-, accent- and punctuation-insensitive matching: explicit Turkish lower-casing
 * (`İ` to `i`, `I` to `ı`, then `ı` to `i`), combining marks removed after NFD, `ß` to `ss`, and every run of
 * non-letters and non-digits collapsed to one space. Pure and locale-independent.
 */
export function foldText(text: string): string {
  if (isAscii(text)) {
    return text.toLowerCase().replace(ASCII_NON_ALNUM_RE, ' ').trim();
  }
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
 * Folds text for fuzzy EPG channel-name matching (`#194`): inserts word boundaries on CamelCase
 * and letter/digit transitions (`NewsOne` -> `news 1`, `SportsTV2` -> `sports tv 2`), folds via
 * {@link foldText} (preserving Turkish `İ`/`ı`/`ş`/`ğ`/`ü`/`ö`/`ç`), and maps standalone English
 * number words (`zero`..`nine`) to digits (`0`..`9`). Pure and idempotent.
 */
export function foldGuideMatchText(input: string): string {
  const segmented = input
    .normalize('NFC')
    .replace(CAMEL_LOWER_UPPER_RE, '$1 $2')
    .replace(CAMEL_ACRONYM_WORD_RE, '$1 $2')
    .replace(LETTER_DIGIT_RE, '$1 $2')
    .replace(DIGIT_LETTER_RE, '$1 $2');
  const folded = foldText(segmented);
  if (folded === '') return '';
  return folded
    .split(' ')
    .map((token) =>
      Object.hasOwn(ENGLISH_NUMBER_WORDS, token) ? (ENGLISH_NUMBER_WORDS[token] as string) : token,
    )
    .join(' ');
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
