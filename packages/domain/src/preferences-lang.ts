const MAX_PREF_LANG_LENGTH = 12;
const MAX_PREFERRED_LANGUAGES = 5;
const PREF_LANG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const UNDETERMINED_LANGS = new Set(['und', 'zxx', 'mul', 'mis', 'unknown']);

function normalizePrefLang(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PREF_LANG_LENGTH) return '';
  if (!PREF_LANG_PATTERN.test(trimmed)) return '';
  const lower = trimmed.toLowerCase();
  const primary = lower.split('-')[0] ?? lower;
  if (UNDETERMINED_LANGS.has(primary)) return '';
  return lower;
}

function normalizePrefLangList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const code = normalizePrefLang(item);
    if (code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_PREFERRED_LANGUAGES) break;
  }
  return Object.freeze(out);
}

export function resolveLangPair(
  rawList: unknown,
  rawSingle: unknown,
  fallbackList: readonly string[],
): { readonly list: readonly string[]; readonly first: string } {
  if (Array.isArray(rawList)) {
    const list = normalizePrefLangList(rawList);
    return { list, first: list[0] ?? '' };
  }
  const single = normalizePrefLang(rawSingle);
  const list = single.length > 0 ? Object.freeze([single]) : fallbackList;
  return { list, first: list[0] ?? '' };
}

export function resolveSerializedLangPair(
  rawList: readonly string[],
  rawSingle: string,
): { readonly list: readonly string[]; readonly first: string } {
  const list = normalizePrefLangList(rawList);
  if (list.length > 0) return { list, first: list[0] ?? '' };
  const single = normalizePrefLang(rawSingle);
  if (single.length > 0) return { list: Object.freeze([single]), first: single };
  return { list: Object.freeze([]), first: '' };
}

export function mergeLangPair(
  baseList: readonly string[],
  baseSingle: string,
  patchList: readonly string[] | undefined,
  patchSingle: string | undefined,
): { readonly list: readonly string[]; readonly first: string } {
  if (Array.isArray(patchList)) {
    const list = normalizePrefLangList(patchList);
    return { list, first: list[0] ?? '' };
  }
  if (typeof patchSingle === 'string') {
    const single = normalizePrefLang(patchSingle);
    return {
      list: single.length > 0 ? Object.freeze([single]) : Object.freeze([]),
      first: single,
    };
  }
  return { list: baseList, first: baseSingle };
}
