const NUMERIC_PAREN_RE = /^\d+(?:[.,:/\-–—]\d+)*%?$/;
const BIDI_CHARS_RE = /[\u2066-\u2069\u202A-\u202E\u200E\u200F]/g;
const LINE_PREFIX_RE =
  /^([\u2066-\u2069\u202A-\u202E\u200E\u200F]*(?:[-–—]\s*)?[\u2066-\u2069\u202A-\u202E\u200E\u200F]*)([^:\r\n]{1,40}):(?=\s|$)(.*)$/;
const HAS_UPPER_RE = /\p{Lu}/u;
const HAS_LOWER_RE = /\p{Ll}/u;
const SPEAKER_ALLOWED_RE = /^[\p{Lu}\p{Mn}\p{Nd}\s.'’\-&/]+$/u;
const LONE_DASH_OR_MUSIC_RE = /^[\s\-–—♪♫♬♩]*$/;

function stripBalancedAnnotations(input: string): string {
  const spans: Array<{ readonly start: number; readonly end: number }> = [];
  const stack: Array<{ readonly ch: '[' | '('; readonly index: number }> = [];

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '[' || ch === '(') {
      stack.push({ ch, index: i });
    } else if (ch === ']' || ch === ')') {
      const wanted = ch === ']' ? '[' : '(';
      let matchIdx = -1;
      for (let j = stack.length - 1; j >= 0; j -= 1) {
        if (stack[j]?.ch === wanted) {
          matchIdx = j;
          break;
        }
      }
      if (matchIdx === -1) continue;
      const open = stack[matchIdx];
      stack.length = matchIdx;
      if (open === undefined) continue;
      const inner = input.slice(open.index + 1, i).trim();
      if (ch === ')' && NUMERIC_PAREN_RE.test(inner)) {
        continue;
      }
      spans.push({ start: open.index, end: i + 1 });
    }
  }

  if (spans.length === 0) return input;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }

  let out = '';
  let cursor = 0;
  for (const span of merged) {
    out += input.slice(cursor, span.start);
    cursor = span.end;
  }
  out += input.slice(cursor);
  return out;
}

function isUppercaseSpeakerLabel(rawLabel: string): boolean {
  const cleaned = rawLabel.replace(BIDI_CHARS_RE, '').trim();
  if (cleaned.length === 0) return false;
  if (!HAS_UPPER_RE.test(cleaned) || HAS_LOWER_RE.test(cleaned)) return false;
  return SPEAKER_ALLOWED_RE.test(cleaned);
}

function cleanLine(rawLine: string): string | undefined {
  let line = rawLine.replace(/[ \t]{2,}/g, ' ').trim();
  const match = LINE_PREFIX_RE.exec(line);
  if (match !== null) {
    const prefix = match[1] ?? '';
    const candidate = match[2] ?? '';
    const rest = (match[3] ?? '').trimStart();
    if (isUppercaseSpeakerLabel(candidate)) {
      line = `${prefix}${rest}`.replace(/[ \t]{2,}/g, ' ').trim();
    }
  }
  const visible = line.replace(BIDI_CHARS_RE, '').trim();
  if (visible.length === 0 || LONE_DASH_OR_MUSIC_RE.test(visible)) {
    return undefined;
  }
  return line;
}

/**
 * Strips SDH / hearing-impaired annotations (`[...]`, `(...)`, uppercase speaker labels, and lone
 * music-symbol lines) from subtitle cue text while preserving numeric/year parentheticals,
 * mixed-case prose, timestamps, URLs, RTL uncased text, and dialogue dashes (`#310`).
 * Returns `''` when the entire cue becomes empty so renderers can suppress blank cue boxes.
 */
export function stripSdhAnnotations(text: string): string {
  if (text.length === 0) return '';
  const withoutBrackets = stripBalancedAnnotations(text);
  const lines = withoutBrackets.split(/\r?\n/);
  const kept: string[] = [];
  for (const rawLine of lines) {
    const cleaned = cleanLine(rawLine);
    if (cleaned !== undefined) kept.push(cleaned);
  }
  return kept.join('\n');
}
