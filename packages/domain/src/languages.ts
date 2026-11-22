const ISO639_CANONICAL = new Map<string, string>([
  ['en', 'en'],
  ['eng', 'en'],
  ['tr', 'tr'],
  ['tur', 'tr'],
  ['de', 'de'],
  ['deu', 'de'],
  ['ger', 'de'],
  ['fr', 'fr'],
  ['fra', 'fr'],
  ['fre', 'fr'],
  ['es', 'es'],
  ['spa', 'es'],
  ['ar', 'ar'],
  ['ara', 'ar'],
  ['ru', 'ru'],
  ['rus', 'ru'],
  ['it', 'it'],
  ['ita', 'it'],
  ['pt', 'pt'],
  ['por', 'pt'],
  ['nl', 'nl'],
  ['nld', 'nl'],
  ['dut', 'nl'],
  ['pl', 'pl'],
  ['pol', 'pl'],
  ['zh', 'zh'],
  ['zho', 'zh'],
  ['chi', 'zh'],
  ['ja', 'ja'],
  ['jpn', 'ja'],
  ['ko', 'ko'],
  ['kor', 'ko'],
  ['fa', 'fa'],
  ['fas', 'fa'],
  ['per', 'fa'],
  ['el', 'el'],
  ['ell', 'el'],
  ['gre', 'el'],
  ['cs', 'cs'],
  ['ces', 'cs'],
  ['cze', 'cs'],
  ['ro', 'ro'],
  ['ron', 'ro'],
  ['rum', 'ro'],
  ['sv', 'sv'],
  ['swe', 'sv'],
  ['uk', 'uk'],
  ['ukr', 'uk'],
  ['ku', 'ku'],
  ['kur', 'ku'],
  ['az', 'az'],
  ['aze', 'az'],
  ['bg', 'bg'],
  ['bul', 'bg'],
  ['bs', 'bs'],
  ['bos', 'bs'],
  ['da', 'da'],
  ['dan', 'da'],
  ['fi', 'fi'],
  ['fin', 'fi'],
  ['he', 'he'],
  ['heb', 'he'],
  ['hi', 'hi'],
  ['hin', 'hi'],
  ['hr', 'hr'],
  ['hrv', 'hr'],
  ['hu', 'hu'],
  ['hun', 'hu'],
  ['id', 'id'],
  ['ind', 'id'],
  ['ms', 'ms'],
  ['msa', 'ms'],
  ['may', 'ms'],
  ['no', 'no'],
  ['nor', 'no'],
  ['nb', 'nb'],
  ['nob', 'nb'],
  ['nn', 'nn'],
  ['nno', 'nn'],
  ['sk', 'sk'],
  ['slk', 'sk'],
  ['slo', 'sk'],
  ['sl', 'sl'],
  ['slv', 'sl'],
  ['sr', 'sr'],
  ['srp', 'sr'],
  ['th', 'th'],
  ['tha', 'th'],
  ['vi', 'vi'],
  ['vie', 'vi'],
  ['sq', 'sq'],
  ['sqi', 'sq'],
  ['alb', 'sq'],
  ['mk', 'mk'],
  ['mkd', 'mk'],
  ['mac', 'mk'],
  ['ka', 'ka'],
  ['kat', 'ka'],
  ['geo', 'ka'],
  ['hy', 'hy'],
  ['hye', 'hy'],
  ['arm', 'hy'],
  ['is', 'is'],
  ['isl', 'is'],
  ['ice', 'is'],
  ['cy', 'cy'],
  ['cym', 'cy'],
  ['wel', 'cy'],
  ['eu', 'eu'],
  ['eus', 'eu'],
  ['baq', 'eu'],
  ['bo', 'bo'],
  ['bod', 'bo'],
  ['tib', 'bo'],
  ['my', 'my'],
  ['mya', 'my'],
  ['bur', 'my'],
  ['mi', 'mi'],
  ['mri', 'mi'],
  ['mao', 'mi'],
  ['bn', 'bn'],
  ['ben', 'bn'],
  ['ca', 'ca'],
  ['cat', 'ca'],
  ['gl', 'gl'],
  ['glg', 'gl'],
  ['ta', 'ta'],
  ['tam', 'ta'],
  ['te', 'te'],
  ['tel', 'te'],
  ['ur', 'ur'],
  ['urd', 'ur'],
]);

const LANGUAGE_LABEL_NAMES = new Map<string, string>([
  ['english', 'en'],
  ['turkish', 'tr'],
  ['türkçe', 'tr'],
  ['turkce', 'tr'],
  ['german', 'de'],
  ['deutsch', 'de'],
  ['french', 'fr'],
  ['français', 'fr'],
  ['francais', 'fr'],
  ['spanish', 'es'],
  ['español', 'es'],
  ['espanol', 'es'],
  ['castellano', 'es'],
  ['arabic', 'ar'],
  ['russian', 'ru'],
  ['italian', 'it'],
  ['italiano', 'it'],
  ['portuguese', 'pt'],
  ['português', 'pt'],
  ['portugues', 'pt'],
  ['dutch', 'nl'],
  ['nederlands', 'nl'],
  ['polish', 'pl'],
  ['polski', 'pl'],
  ['chinese', 'zh'],
  ['mandarin', 'zh'],
  ['cantonese', 'zh'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  ['persian', 'fa'],
  ['farsi', 'fa'],
  ['greek', 'el'],
  ['czech', 'cs'],
  ['romanian', 'ro'],
  ['swedish', 'sv'],
  ['ukrainian', 'uk'],
  ['kurdish', 'ku'],
  ['azerbaijani', 'az'],
  ['bulgarian', 'bg'],
  ['bosnian', 'bs'],
  ['danish', 'da'],
  ['finnish', 'fi'],
  ['hebrew', 'he'],
  ['hindi', 'hi'],
  ['croatian', 'hr'],
  ['hungarian', 'hu'],
  ['indonesian', 'id'],
  ['malay', 'ms'],
  ['norwegian', 'no'],
  ['slovak', 'sk'],
  ['slovenian', 'sl'],
  ['serbian', 'sr'],
  ['thai', 'th'],
  ['vietnamese', 'vi'],
  ['albanian', 'sq'],
  ['macedonian', 'mk'],
  ['georgian', 'ka'],
  ['armenian', 'hy'],
  ['icelandic', 'is'],
  ['welsh', 'cy'],
  ['basque', 'eu'],
  ['tibetan', 'bo'],
  ['burmese', 'my'],
  ['maori', 'mi'],
  ['bengali', 'bn'],
  ['catalan', 'ca'],
  ['galician', 'gl'],
  ['tamil', 'ta'],
  ['telugu', 'te'],
  ['urdu', 'ur'],
]);

const AMBIGUOUS_TWO_LETTER = new Set(['no', 'is', 'it', 'hi', 'id', 'my', 'he']);
const UNDETERMINED = new Set(['und', 'zxx', 'mul', 'mis', 'unknown']);
const PRIMARY_SUBTAG_RE = /^[a-z]{2,8}$/;
const LABEL_SPLIT_RE = /[\s[\](){},.;:/|\\+]+/;
const BCP47_TOKEN_RE = /^([a-z]{2,3})[-_]([a-z]{2}|[a-z]{4}|\d{3})(?:[-_][a-z0-9]{2,8})*$/;

/**
 * Normalizes an ISO 639-1, ISO 639-2(T/B), or BCP-47 language tag (such as `eng`, `deu`, `ger`,
 * `en-US`, or `pt_BR`) to its canonical lowercase primary code, or `undefined` when empty,
 * malformed, or undetermined (`und`, `zxx`, `mul`, `mis`, `unknown`).
 */
export function normalizeLanguageCode(code: string | null | undefined): string | undefined {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  if (trimmed.length === 0) return undefined;
  const primary = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? '';
  if (!PRIMARY_SUBTAG_RE.test(primary) || UNDETERMINED.has(primary)) return undefined;
  return ISO639_CANONICAL.get(primary) ?? primary;
}

/**
 * Extracts a canonical language code from a free-text track label using whole-word token
 * matching only (never substring matching, so `"es"` never matches `"Chinese"` or `"Japanese"`).
 * Intended as a fallback when a track's explicit language tag is absent or undetermined.
 */
export function extractLanguageCodeFromLabel(label: string | null | undefined): string | undefined {
  if (typeof label !== 'string') return undefined;
  const tokens = label
    .trim()
    .split(LABEL_SPLIT_RE)
    .filter((token) => token.length > 0 && token !== '-' && token !== '_');
  if (tokens.length === 0) return undefined;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const byName = LANGUAGE_LABEL_NAMES.get(lower);
    if (byName !== undefined) return byName;
  }

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const bcp = BCP47_TOKEN_RE.exec(lower);
    if (bcp) {
      const primary = bcp[1];
      const subtag = bcp[2];
      if (primary && !(primary === 'hi' && subtag === 'fi')) {
        const canonical = ISO639_CANONICAL.get(primary);
        if (canonical !== undefined) return canonical;
      }
      continue;
    }
    if (!/^[a-z]{2,3}$/.test(lower) || UNDETERMINED.has(lower)) continue;
    const canonical = ISO639_CANONICAL.get(lower);
    if (canonical === undefined) continue;
    if (lower.length === 3 || tokens.length === 1 || !AMBIGUOUS_TWO_LETTER.has(lower)) {
      return canonical;
    }
  }
  return undefined;
}

/**
 * Returns `true` when two language tags normalize to the same known canonical language code.
 * Undetermined or missing tags never match.
 */
export function sameLanguageCode(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const normA = normalizeLanguageCode(a);
  if (normA === undefined) return false;
  return normA === normalizeLanguageCode(b);
}
