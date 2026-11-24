const RLI = '\u2067';
const PDI = '\u2069';
const LRI = '\u2066';
const FSI = '\u2068';
const LRM = 0x200e;
const RLM = 0x200f;
const ALM = 0x061c;

const NUMERIC_PARENS_RE = /^[\d\s\-–—/.,:+]+$/;
const SPEAKER_PREFIX_RE =
  /^(?:([-–—])\s+)?([A-Z][A-Z0-9.'#-]{0,20}(?:\s+[A-Z0-9][A-Z0-9.'#-]{0,20}){0,2}):(?:\s+|$)/;
const LONE_DASH_RE = /^[-–—]$/;
const MULTI_SPACE_RE = /[ \t]{2,}/g;

function isRtlScriptCodePoint(cp: number): boolean {
  if (cp < 0x05be) return false;
  // Hebrew
  if (
    cp === 0x05be ||
    cp === 0x05c0 ||
    cp === 0x05c3 ||
    cp === 0x05c6 ||
    (cp >= 0x05d0 && cp <= 0x05ea) ||
    (cp >= 0x05ef && cp <= 0x05f4)
  ) {
    return true;
  }
  // Arabic (excluding Arabic-Indic digits 0660-0669 / 06F0-06F9 and combining marks)
  if (
    cp === 0x0608 ||
    cp === 0x060b ||
    cp === 0x060d ||
    (cp >= 0x061b && cp <= 0x064a) ||
    (cp >= 0x066d && cp <= 0x066f) ||
    (cp >= 0x0671 && cp <= 0x06d5) ||
    cp === 0x06e5 ||
    cp === 0x06e6 ||
    cp === 0x06ee ||
    cp === 0x06ef ||
    (cp >= 0x06fa && cp <= 0x06ff)
  ) {
    return true;
  }
  // Syriac, Arabic Supplement, Thaana, N'Ko
  if (
    (cp >= 0x0700 && cp <= 0x070d) ||
    cp === 0x0710 ||
    (cp >= 0x0712 && cp <= 0x072f) ||
    (cp >= 0x074d && cp <= 0x07a5) ||
    cp === 0x07b1 ||
    (cp >= 0x07c0 && cp <= 0x07ea) ||
    cp === 0x07f4 ||
    cp === 0x07f5 ||
    cp === 0x07fa
  ) {
    return true;
  }
  // Samaritan, Mandaic, Syriac Supplement, Arabic Extended-B & Extended-A
  if ((cp >= 0x0800 && cp <= 0x0897) || (cp >= 0x08a0 && cp <= 0x08c9)) {
    return true;
  }
  // Hebrew & Arabic Presentation Forms (excluding U+FEFF BOM)
  if (
    cp === 0xfb1d ||
    (cp >= 0xfb1f && cp <= 0xfb28) ||
    (cp >= 0xfb2a && cp <= 0xfd3d) ||
    (cp >= 0xfd50 && cp <= 0xfdfc) ||
    (cp >= 0xfe70 && cp <= 0xfefc)
  ) {
    return true;
  }
  // Arabic Mathematical Alphabetic Symbols
  return cp >= 0x1ee00 && cp <= 0x1eeff;
}

function isStrongLtrCodePoint(cp: number): boolean {
  if ((cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a)) return true;
  if (cp < 0x00c0) return false;
  if (cp === LRM) return true;
  if (
    (cp >= 0x00c0 && cp <= 0x00d6) ||
    (cp >= 0x00d8 && cp <= 0x00f6) ||
    (cp >= 0x00f8 && cp <= 0x02af) ||
    (cp >= 0x0370 && cp <= 0x058f) ||
    (cp >= 0x0900 && cp <= 0x1fff) ||
    (cp >= 0x2c00 && cp <= 0x2fef) ||
    (cp >= 0x3040 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff21 && cp <= 0xff3a) ||
    (cp >= 0xff41 && cp <= 0xff5a) ||
    (cp >= 0xff66 && cp <= 0xffdc)
  ) {
    return true;
  }
  return false;
}

function firstStrongDirection(line: string): 'rtl' | 'ltr' | null {
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    if (cp === RLM || cp === ALM || isRtlScriptCodePoint(cp)) return 'rtl';
    if (isStrongLtrCodePoint(cp)) return 'ltr';
  }
  return null;
}

function isAlreadyRtlIsolated(line: string): boolean {
  if (!line.startsWith(RLI) || !line.endsWith(PDI)) return false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === RLI || ch === LRI || ch === FSI) {
      depth += 1;
    } else if (ch === PDI) {
      depth -= 1;
      if (depth === 0 && i < line.length - 1) return false;
    }
  }
  return depth === 0;
}

/**
 * Returns `true` when `text` contains any strong right-to-left script character
 * (Arabic, Hebrew, Syriac, Thaana, N'Ko, or Hebrew/Arabic presentation forms).
 */
export function containsRtlText(text: string): boolean {
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    if (isRtlScriptCodePoint(cp)) return true;
  }
  return false;
}

/**
 * Splits `text` on `\n` and wraps lines whose first strong directional character
 * is RTL in Unicode Right-to-Left Isolate (`\u2067...\u2069`) without double-wrapping.
 * LTR-first and neutral-only lines are left untouched.
 */
export function isolateBidiLines(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0 || isAlreadyRtlIsolated(line)) continue;
    if (firstStrongDirection(line) === 'rtl') {
      lines[i] = `${RLI}${line}${PDI}`;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : text;
}

function stripBracketSdh(line: string): string {
  let open = line.indexOf('[');
  if (open === -1) return line;
  const parts: string[] = [];
  let pos = 0;
  while (open !== -1) {
    const close = line.indexOf(']', open + 1);
    if (close === -1) break;
    if (open > pos) parts.push(line.slice(pos, open));
    pos = close + 1;
    open = line.indexOf('[', pos);
  }
  if (pos === 0) return line;
  if (pos < line.length) parts.push(line.slice(pos));
  return parts.join('');
}

function stripParenSdh(line: string): string {
  let open = line.indexOf('(');
  if (open === -1) return line;
  const parts: string[] = [];
  let pos = 0;
  while (open !== -1) {
    const close = line.indexOf(')', open + 1);
    if (close === -1) break;
    const inner = line.slice(open + 1, close).trim();
    if (inner.length > 0 && NUMERIC_PARENS_RE.test(inner)) {
      parts.push(line.slice(pos, close + 1));
    } else if (open > pos) {
      parts.push(line.slice(pos, open));
    }
    pos = close + 1;
    open = line.indexOf('(', pos);
  }
  if (pos === 0) return line;
  if (pos < line.length) parts.push(line.slice(pos));
  return parts.join('');
}

function stripSdhSingleLine(line: string): string {
  let cleaned = stripParenSdh(stripBracketSdh(line));
  cleaned = cleaned.replace(MULTI_SPACE_RE, ' ').trim();

  const speakerMatch = SPEAKER_PREFIX_RE.exec(cleaned);
  if (speakerMatch) {
    const dash = speakerMatch[1];
    const speaker = speakerMatch[2] ?? '';
    if (speaker.length >= 2) {
      const rest = cleaned.slice(speakerMatch[0].length).trim();
      cleaned = dash && rest.length > 0 ? `${dash} ${rest}` : rest;
    }
  }

  cleaned = cleaned.replace(MULTI_SPACE_RE, ' ').trim();
  if (LONE_DASH_RE.test(cleaned)) return '';
  return cleaned;
}

/**
 * Strips opt-in SDH annotations (`[...]`, non-numeric `(...)`, and uppercase `SPEAKER:` prefixes)
 * while preserving `- ` dialogue dashes and numeric parentheticals such as `(2024)`.
 */
export function stripSdhSubtitleLine(text: string): string {
  if (text.length === 0) return '';
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const cleaned = stripSdhSingleLine(line);
    if (cleaned.length > 0) kept.push(cleaned);
  }
  return kept.join('\n');
}
