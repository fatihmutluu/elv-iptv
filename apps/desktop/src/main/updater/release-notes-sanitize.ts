/** Parsed SemVer 2.0.0 tuple produced by {@link parseSemver}. */
export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_MAX_LINES = 120;

const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const LEADING_ZERO_INT = /^0\d+$/;
const DIGITS_ONLY = /^\d+$/;

const DANGEROUS_BLOCK_TAGS = /<(script|style|iframe|svg|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENTS = /<!--[\s\S]*?-->/g;
const HTML_TAGS = /<\/?[A-Za-z][^>]*>/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]*)\)/g;
const DANGEROUS_SCHEME_INLINE = /\b(?:javascript|vbscript|data)\s*:/gi;

function stripControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09) {
      out += '  ';
      continue;
    }
    if (code === 0x0a) {
      out += '\n';
      continue;
    }
    if (code <= 0x1f || code === 0x7f) continue;
    out += text[i];
  }
  return out;
}

function isSafeMarkdownLinkUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

/**
 * Sanitizes untrusted release notes into safe plain text / light markdown by removing HTML tags,
 * script/iframe blocks, markdown image embeds, dangerous URI schemes (`javascript:`, `data:`,
 * `vbscript:`), and ASCII control characters, then enforcing strict line and character caps.
 */
export function sanitizeReleaseNotes(
  raw: unknown,
  maxChars = DEFAULT_MAX_CHARS,
  maxLines = DEFAULT_MAX_LINES,
): string {
  if (typeof raw !== 'string') return '';
  const charCap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : DEFAULT_MAX_CHARS;
  const lineCap = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : DEFAULT_MAX_LINES;
  if (charCap === 0) return '';

  let text = raw.replace(/\r\n?/g, '\n');
  text = stripControlChars(text);

  // Iteratively strip dangerous block elements so nested tag constructions cannot survive.
  let previous = '';
  while (previous !== text) {
    previous = text;
    text = text.replace(DANGEROUS_BLOCK_TAGS, '');
  }

  text = text.replace(HTML_COMMENTS, '');
  text = text.replace(HTML_TAGS, '');
  text = text.replace(MARKDOWN_IMAGE, '');
  text = text.replace(MARKDOWN_LINK, (_match, label: string, url: string) =>
    isSafeMarkdownLinkUrl(url) ? `${label} (${url.trim()})` : label,
  );
  text = text.replace(DANGEROUS_SCHEME_INLINE, '');

  const normalizedLines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalizedLines.length === 0) return '';

  let result = normalizedLines;
  const lines = result.split('\n');
  if (lines.length > lineCap) {
    result = `${lines.slice(0, lineCap).join('\n').trimEnd()}\n…`;
  }

  if (result.length > charCap) {
    if (charCap === 1) return '…';
    result = `${result.slice(0, charCap - 1).trimEnd()}…`;
  }

  return result;
}

/** Parses a strict SemVer 2.0.0 version string (`v?MAJOR.MINOR.PATCH[-prerelease][+build]`). */
export function parseSemver(raw: string): ParsedSemver | null {
  const trimmed = raw.trim();
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  const rawPre = match[4];
  if (rawPre === undefined) {
    return { major, minor, patch, prerelease: [] };
  }

  const prerelease = rawPre.split('.');
  for (const ident of prerelease) {
    if (ident.length === 0 || LEADING_ZERO_INT.test(ident)) return null;
  }
  return { major, minor, patch, prerelease };
}

function compareParsedSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const minLen = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < minLen; i++) {
    const ai = aPre[i] as string;
    const bi = bPre[i] as string;
    if (ai === bi) continue;
    const aNum = DIGITS_ONLY.test(ai);
    const bNum = DIGITS_ONLY.test(bi);
    if (aNum && bNum) {
      const an = Number(ai);
      const bn = Number(bi);
      if (an !== bn) return an > bn ? 1 : -1;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ai > bi ? 1 : -1;
  }

  if (aPre.length === bPre.length) return 0;
  return aPre.length > bPre.length ? 1 : -1;
}

/**
 * Compares two strict SemVer strings, returning `1` if `a > b`, `-1` if `a < b`, or `0` if equal.
 * Throws a `RangeError` if either input is not valid SemVer.
 */
export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  if (parsedA === null) throw new RangeError(`Invalid semver version: ${a}`);
  const parsedB = parseSemver(b);
  if (parsedB === null) throw new RangeError(`Invalid semver version: ${b}`);
  return compareParsedSemver(parsedA, parsedB);
}

/**
 * Returns `true` when `candidate` is strictly newer than `current` per SemVer 2.0.0.
 * Prerelease candidates are ignored unless `current` is also a prerelease build.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parsedCandidate = parseSemver(candidate);
  const parsedCurrent = parseSemver(current);
  if (parsedCandidate === null || parsedCurrent === null) return false;
  if (parsedCandidate.prerelease.length > 0 && parsedCurrent.prerelease.length === 0) {
    return false;
  }
  return compareParsedSemver(parsedCandidate, parsedCurrent) > 0;
}
