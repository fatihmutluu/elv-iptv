import { decodeEntities } from './entities';

export interface RawSubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

const TIMECODE_LINE_RE =
  /^\s*(\d{1,3}:\d{2}(?::\d{2})?(?:[.,:]\d+)?)\s*(?:-+>|—>|–>)\s*(\d{1,3}:\d{2}(?::\d{2})?(?:[.,:]\d+)?)(?:\s+.*)?$/;
const LIKELY_TIMECODE_START_RE = /^\s*\d{1,3}:\d{2}/;
const CLOCK_TOKEN_RE = /^(\d{1,3}):(\d{2})(?::(\d{2}))?(?:[.,:](\d+))?$/;
const VTT_SKIP_BLOCK_RE = /^(?:NOTE|STYLE|REGION)(?:\s|$)/;
const PURE_INDEX_RE = /^\d+$/;
const SINGLE_SRT_VTT_TAG_RE =
  /^<\/[a-zA-Z][a-zA-Z0-9._:-]*\s*>$|^<[a-zA-Z][a-zA-Z0-9._:-]*(?:\s[^<>]*)?\/?>$|^<\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?>$/;
const NBSP_RE = /&nbsp;/gi;

const ASS_SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const ASS_FORMAT_RE = /^\s*Format\s*:\s*(.*)$/i;
const ASS_DIALOGUE_RE = /^\s*Dialogue\s*:\s*(.*)$/i;
const ASS_DRAWING_TAG_RE = /\\p(\d+)/g;
const ASS_NEWLINE_RE = /\\[Nn]/g;
const ASS_HARD_SPACE_RE = /\\h/g;
const DEFAULT_ASS_FIELDS = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
];

const SINGLE_XML_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9._:-]*(?:\s[^<>]*)?\/?>$/;
const TTML_CLOCK_RE = /^(\d{1,3}):(\d{2}):(\d{2})(?:(?:\.(\d+))|(?::(\d{1,3})(?:\.(\d+))?))?$/;
const TTML_OFFSET_RE = /^(\d+(?:\.\d+)?)(ms|h|m|s|f|t)$/;
const RAW_WS_RE = /[\t\n]+/g;
const MULTI_SPACE_RE = / {2,}/g;

function isLikelyTimecodeLine(line: string): boolean {
  return (
    LIKELY_TIMECODE_START_RE.test(line) &&
    (line.includes('->') || line.includes('—>') || line.includes('–>'))
  );
}

function parseFractionMs(frac: string | undefined): number {
  if (!frac) return 0;
  return Number.parseInt(frac.slice(0, 3).padEnd(3, '0'), 10);
}

/** Parses an SRT/VTT/ASS clock token (`[HH:]MM:SS[.,:frac]`) into milliseconds or `null`. */
function parseClockTimeMs(raw: string): number | null {
  const match = CLOCK_TOKEN_RE.exec(raw.trim());
  if (!match) return null;
  const first = Number.parseInt(match[1] ?? '', 10);
  const second = Number.parseInt(match[2] ?? '', 10);
  const thirdRaw = match[3];
  const ms = parseFractionMs(match[4]);

  if (thirdRaw !== undefined) {
    const third = Number.parseInt(thirdRaw, 10);
    if (second >= 60 || third >= 60) return null;
    return ((first * 60 + second) * 60 + third) * 1000 + ms;
  }
  if (second >= 60) return null;
  return (first * 60 + second) * 1000 + ms;
}

const BR_TOKEN_RE = /^<br\s*\/?>$/i;

/** Strips HTML, WebVTT, and inline ASS override tags in O(N) linear time and decodes entities. */
function stripSrtVttMarkup(text: string): string {
  let nextOpenAngle = text.indexOf('<');
  let nextOpenBrace = text.indexOf('{\\');
  if (nextOpenAngle === -1 && nextOpenBrace === -1) {
    return decodeEntities(text.replace(NBSP_RE, ' '));
  }
  const parts: string[] = [];
  let segStart = 0;
  let nextAngleClose = -2;
  let nextBraceClose = -2;

  while (nextOpenAngle !== -1 || nextOpenBrace !== -1) {
    if (nextOpenAngle !== -1 && (nextOpenBrace === -1 || nextOpenAngle < nextOpenBrace)) {
      const i = nextOpenAngle;
      if (nextAngleClose !== -1 && nextAngleClose <= i) {
        nextAngleClose = text.indexOf('>', i + 1);
      }
      if (nextAngleClose === -1) {
        nextOpenAngle = -1;
        continue;
      }
      nextOpenAngle = text.indexOf('<', i + 1);
      if (nextOpenAngle !== -1 && nextOpenAngle < nextAngleClose) {
        continue;
      }
      const token = text.slice(i, nextAngleClose + 1);
      if (BR_TOKEN_RE.test(token)) {
        if (i > segStart) parts.push(text.slice(segStart, i));
        parts.push('\n');
        segStart = nextAngleClose + 1;
        if (nextOpenBrace !== -1 && nextOpenBrace < segStart) {
          nextOpenBrace = text.indexOf('{\\', segStart);
        }
        continue;
      }
      if (SINGLE_SRT_VTT_TAG_RE.test(token)) {
        if (i > segStart) parts.push(text.slice(segStart, i));
        segStart = nextAngleClose + 1;
        if (nextOpenBrace !== -1 && nextOpenBrace < segStart) {
          nextOpenBrace = text.indexOf('{\\', segStart);
        }
      }
      continue;
    }

    const i = nextOpenBrace;
    if (nextBraceClose !== -1 && nextBraceClose <= i + 1) {
      nextBraceClose = text.indexOf('}', i + 2);
    }
    if (nextBraceClose === -1) {
      nextOpenBrace = -1;
      continue;
    }
    if (i > segStart) parts.push(text.slice(segStart, i));
    segStart = nextBraceClose + 1;
    nextOpenBrace = text.indexOf('{\\', segStart);
    if (nextOpenAngle !== -1 && nextOpenAngle < segStart) {
      nextOpenAngle = text.indexOf('<', segStart);
    }
  }

  if (segStart === 0) {
    return decodeEntities(text.replace(NBSP_RE, ' '));
  }
  if (segStart < text.length) parts.push(text.slice(segStart));
  return decodeEntities(parts.join('').replace(NBSP_RE, ' '));
}

function finalizeSrtVttCue(
  cues: RawSubtitleCue[],
  warnings: string[],
  startMs: number,
  endMs: number,
  lines: string[],
): void {
  if (endMs <= startMs) {
    warnings.push('non-positive-duration');
    return;
  }
  const rawText = lines.join('\n').trim();
  if (rawText.length === 0) return;
  cues.push({ startMs, endMs, text: stripSrtVttMarkup(rawText) });
}

/** Parses SRT or WebVTT text using a tolerant timecode-line-anchored scanner. */
export function parseSrtOrVtt(
  content: string,
  format: 'srt' | 'vtt',
  warnings: string[],
): RawSubtitleCue[] {
  const lines = content.split('\n');
  const cues: RawSubtitleCue[] = [];

  let i = 0;
  // Skip optional WEBVTT header block up to first blank line or timecode line.
  if (format === 'vtt' || /^WEBVTT(?:[\s-]|$)/.test(lines[0] ?? '')) {
    if (/^WEBVTT(?:[\s-]|$)/.test(lines[0] ?? '')) {
      i = 1;
      while (i < lines.length) {
        const line = lines[i] ?? '';
        if (line.trim().length === 0) {
          i += 1;
          break;
        }
        if (TIMECODE_LINE_RE.test(line) || isLikelyTimecodeLine(line)) break;
        i += 1;
      }
    }
  }

  let activeStartMs: number | null = null;
  let activeEndMs: number | null = null;
  let cueLines: string[] = [];
  let sawBlank = false;
  let pendingAfterBlank: string[] = [];

  const flushActive = (followedByTimecode: boolean): void => {
    if (activeStartMs === null || activeEndMs === null) return;
    if (cueLines.length === 0 && !followedByTimecode && pendingAfterBlank.length > 0) {
      cueLines = pendingAfterBlank;
    } else if (
      followedByTimecode &&
      !sawBlank &&
      cueLines.length > 1 &&
      PURE_INDEX_RE.test((cueLines[cueLines.length - 1] ?? '').trim())
    ) {
      cueLines.pop();
    }
    finalizeSrtVttCue(cues, warnings, activeStartMs, activeEndMs, cueLines);
    activeStartMs = null;
    activeEndMs = null;
    cueLines = [];
    sawBlank = false;
    pendingAfterBlank = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      if (activeStartMs !== null) {
        sawBlank = true;
        pendingAfterBlank = [];
      }
      i += 1;
      continue;
    }

    if ((activeStartMs === null || sawBlank) && VTT_SKIP_BLOCK_RE.test(trimmed)) {
      if (activeStartMs !== null) flushActive(true);
      i += 1;
      while (i < lines.length) {
        const nextLine = lines[i] ?? '';
        if (nextLine.trim().length === 0) {
          i += 1;
          break;
        }
        if (TIMECODE_LINE_RE.test(nextLine) || isLikelyTimecodeLine(nextLine)) break;
        i += 1;
      }
      continue;
    }

    const tcMatch = TIMECODE_LINE_RE.exec(line);
    if (tcMatch) {
      flushActive(true);
      const startMs = parseClockTimeMs(tcMatch[1] ?? '');
      const endMs = parseClockTimeMs(tcMatch[2] ?? '');
      if (startMs === null || endMs === null) {
        warnings.push('malformed-timecode');
      } else {
        activeStartMs = startMs;
        activeEndMs = endMs;
      }
      i += 1;
      continue;
    }

    if (isLikelyTimecodeLine(line)) {
      flushActive(true);
      warnings.push('malformed-timecode');
      i += 1;
      continue;
    }

    if (activeStartMs !== null) {
      if (sawBlank) {
        pendingAfterBlank.push(line);
      } else {
        cueLines.push(line);
      }
    }
    i += 1;
  }

  flushActive(false);
  return cues;
}

function stripAssOverridesAndDrawings(text: string): string {
  let out = '';
  let inDrawing = false;
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) {
      if (!inDrawing) out += text.slice(i);
      break;
    }
    if (!inDrawing && open > i) {
      out += text.slice(i, open);
    }
    const close = text.indexOf('}', open + 1);
    const block = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);

    ASS_DRAWING_TAG_RE.lastIndex = 0;
    let drawMatch = ASS_DRAWING_TAG_RE.exec(block);
    while (drawMatch !== null) {
      const level = Number.parseInt(drawMatch[1] ?? '0', 10);
      inDrawing = level > 0;
      drawMatch = ASS_DRAWING_TAG_RE.exec(block);
    }

    if (close === -1) break;
    i = close + 1;
  }

  return out.replace(ASS_NEWLINE_RE, '\n').replace(ASS_HARD_SPACE_RE, ' ');
}

function splitAssDialogueFields(raw: string, fieldCount: number, textIdx: number): string[] | null {
  if (fieldCount <= 0 || textIdx < 0 || textIdx >= fieldCount) return null;
  const result = new Array<string>(fieldCount);

  // Split fields strictly before `textIdx` from the left.
  let leftPos = 0;
  for (let col = 0; col < textIdx; col++) {
    const comma = raw.indexOf(',', leftPos);
    if (comma === -1) return null;
    result[col] = raw.slice(leftPos, comma);
    leftPos = comma + 1;
  }

  // Split fields strictly after `textIdx` from the right so commas inside `Text` stay intact.
  let rightPos = raw.length;
  for (let col = fieldCount - 1; col > textIdx; col--) {
    const comma = raw.lastIndexOf(',', rightPos - 1);
    if (comma === -1 || comma < leftPos) return null;
    result[col] = raw.slice(comma + 1, rightPos);
    rightPos = comma;
  }

  result[textIdx] = raw.slice(leftPos, rightPos);
  return result;
}

/** Parses ASS/SSA subtitles using the dynamic `[Events]` `Format:` column order. */
export function parseAss(content: string, warnings: string[]): RawSubtitleCue[] {
  const cues: RawSubtitleCue[] = [];
  let inEvents = false;
  let sawAnySection = false;
  let fields: string[] | null = null;
  let warnedMissingFormat = false;

  for (const line of content.split('\n')) {
    const sectionMatch = ASS_SECTION_RE.exec(line);
    if (sectionMatch) {
      sawAnySection = true;
      const sectionName = (sectionMatch[1] ?? '').trim().toLowerCase();
      inEvents = sectionName === 'events';
      continue;
    }

    if (sawAnySection && !inEvents) continue;

    const formatMatch = ASS_FORMAT_RE.exec(line);
    if (formatMatch) {
      fields = (formatMatch[1] ?? '')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0);
      continue;
    }

    const dialogueMatch = ASS_DIALOGUE_RE.exec(line);
    if (!dialogueMatch) continue;

    if (!fields) {
      fields = DEFAULT_ASS_FIELDS;
      if (!warnedMissingFormat) {
        warnings.push('missing-ass-format');
        warnedMissingFormat = true;
      }
    }

    const startIdx = fields.indexOf('start');
    const endIdx = fields.indexOf('end');
    const textIdx = fields.indexOf('text');
    if (startIdx === -1 || endIdx === -1 || textIdx === -1) {
      warnings.push('malformed-ass-format');
      continue;
    }

    const cols = splitAssDialogueFields(dialogueMatch[1] ?? '', fields.length, textIdx);
    if (!cols) {
      warnings.push('malformed-dialogue');
      continue;
    }

    const startMs = parseClockTimeMs(cols[startIdx] ?? '');
    const endMs = parseClockTimeMs(cols[endIdx] ?? '');
    if (startMs === null || endMs === null) {
      warnings.push('malformed-timecode');
      continue;
    }
    if (endMs <= startMs) {
      warnings.push('non-positive-duration');
      continue;
    }

    const text = stripAssOverridesAndDrawings(cols[textIdx] ?? '');
    if (text.trim().length > 0) {
      cues.push({ startMs, endMs, text });
    }
  }

  return cues;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isXmlPrefixChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2d
  );
}

function isXmlAttrNameChar(code: number): boolean {
  return isXmlPrefixChar(code) || code === 0x3a;
}

function isXmlTagBoundary(code: number): boolean {
  return Number.isNaN(code) || code === 0x3e || code === 0x2f || isAsciiWhitespace(code);
}

function matchesAsciiLower(content: string, start: number, targetLower: string): boolean {
  if (start + targetLower.length > content.length) return false;
  for (let k = 0; k < targetLower.length; k += 1) {
    let ch = content.charCodeAt(start + k);
    if (ch >= 0x41 && ch <= 0x5a) ch += 32;
    if (ch !== targetLower.charCodeAt(k)) return false;
  }
  return true;
}

function matchPrefixedTagName(content: string, start: number, localNameLower: string): number {
  if (
    matchesAsciiLower(content, start, localNameLower) &&
    isXmlTagBoundary(content.charCodeAt(start + localNameLower.length))
  ) {
    return start + localNameLower.length;
  }
  let j = start;
  while (j < content.length && isXmlPrefixChar(content.charCodeAt(j))) {
    j += 1;
  }
  if (j > start && content.charCodeAt(j) === 0x3a /* : */) {
    const localStart = j + 1;
    if (
      matchesAsciiLower(content, localStart, localNameLower) &&
      isXmlTagBoundary(content.charCodeAt(localStart + localNameLower.length))
    ) {
      return localStart + localNameLower.length;
    }
  }
  return -1;
}

function parseXmlAttributes(attrSource: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  let i = 0;
  const len = attrSource.length;

  while (i < len) {
    while (i < len && !isXmlAttrNameChar(attrSource.charCodeAt(i))) {
      i += 1;
    }
    const nameStart = i;
    while (i < len && isXmlAttrNameChar(attrSource.charCodeAt(i))) {
      i += 1;
    }
    if (i === nameStart) break;
    const rawKey = attrSource.slice(nameStart, i).toLowerCase();

    while (i < len && isAsciiWhitespace(attrSource.charCodeAt(i))) {
      i += 1;
    }
    if (i >= len || attrSource.charCodeAt(i) !== 0x3d /* = */) continue;
    i += 1;

    while (i < len && isAsciiWhitespace(attrSource.charCodeAt(i))) {
      i += 1;
    }
    if (i >= len) break;
    const quoteCode = attrSource.charCodeAt(i);
    if (quoteCode !== 0x22 /* " */ && quoteCode !== 0x27 /* ' */) continue;
    const quote = quoteCode === 0x22 ? '"' : "'";
    const valStart = i + 1;
    const valEnd = attrSource.indexOf(quote, valStart);
    if (valEnd === -1) break;

    const value = attrSource.slice(valStart, valEnd);
    attrs[rawKey] = value;
    const colon = rawKey.indexOf(':');
    if (colon !== -1) {
      const localKey = rawKey.slice(colon + 1);
      if (!(localKey in attrs)) attrs[localKey] = value;
    }
    i = valEnd + 1;
  }

  return attrs;
}

function findTtmlRootAttrs(content: string): string | null {
  let pos = 0;
  let nextClose = -2;
  let nextOpen = -2;
  while (pos < content.length) {
    const open = content.indexOf('<', pos);
    if (open === -1) return null;
    const nameEnd = matchPrefixedTagName(content, open + 1, 'tt');
    if (nameEnd === -1) {
      pos = open + 1;
      continue;
    }
    if (nextClose !== -1 && nextClose < nameEnd) {
      nextClose = content.indexOf('>', nameEnd);
    }
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen <= open) {
      nextOpen = content.indexOf('<', open + 1);
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      pos = nextOpen;
      continue;
    }
    return content.slice(nameEnd, nextClose);
  }
  return null;
}

function findNextClosingP(content: string, from: number): { start: number; end: number } | null {
  let search = from;
  while (search < content.length) {
    const idx = content.indexOf('</', search);
    if (idx === -1) return null;
    const nameEnd = matchPrefixedTagName(content, idx + 2, 'p');
    if (nameEnd !== -1) {
      let gt = nameEnd;
      while (gt < content.length && isAsciiWhitespace(content.charCodeAt(gt))) {
        gt += 1;
      }
      if (content.charCodeAt(gt) === 0x3e /* > */) {
        return { start: idx, end: gt + 1 };
      }
    }
    search = idx + 2;
  }
  return null;
}

function stripTtmlBodyTags(body: string): string {
  const normalized = body.replace(RAW_WS_RE, ' ');
  if (!normalized.includes('<')) return normalized;

  const parts: string[] = [];
  let segStart = 0;
  let i = 0;
  let nextClose = -2;
  let nextOpen = -2;

  while (i < normalized.length) {
    const open = normalized.indexOf('<', i);
    if (open === -1) break;

    if (nextClose !== -1 && nextClose <= open) {
      nextClose = normalized.indexOf('>', open + 1);
    }
    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen <= open) {
      nextOpen = normalized.indexOf('<', open + 1);
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      i = nextOpen;
      continue;
    }

    if (matchPrefixedTagName(normalized, open + 1, 'br') !== -1) {
      if (open > segStart) parts.push(normalized.slice(segStart, open));
      parts.push('\n');
      i = nextClose + 1;
      segStart = i;
      continue;
    }

    const token = normalized.slice(open, nextClose + 1);
    if (SINGLE_XML_TAG_RE.test(token)) {
      if (open > segStart) parts.push(normalized.slice(segStart, open));
      i = nextClose + 1;
      segStart = i;
      continue;
    }

    i = nextClose + 1;
  }

  if (segStart === 0) return normalized;
  if (segStart < normalized.length) parts.push(normalized.slice(segStart));
  return parts.join('');
}

function parseTtmlTimeMs(raw: string, frameRate: number, tickRate: number): number | null {
  const trimmed = raw.trim();
  const offsetMatch = TTML_OFFSET_RE.exec(trimmed);
  if (offsetMatch) {
    const value = Number.parseFloat(offsetMatch[1] ?? '');
    const unit = offsetMatch[2];
    if (!Number.isFinite(value) || value < 0) return null;
    if (unit === 'ms') return Math.round(value);
    if (unit === 's') return Math.round(value * 1000);
    if (unit === 'm') return Math.round(value * 60_000);
    if (unit === 'h') return Math.round(value * 3_600_000);
    if (unit === 'f') return Math.round((value / frameRate) * 1000);
    if (unit === 't') return Math.round((value / tickRate) * 1000);
  }

  const clockMatch = TTML_CLOCK_RE.exec(trimmed);
  if (!clockMatch) return null;
  const hours = Number.parseInt(clockMatch[1] ?? '', 10);
  const minutes = Number.parseInt(clockMatch[2] ?? '', 10);
  const seconds = Number.parseInt(clockMatch[3] ?? '', 10);
  if (minutes >= 60 || seconds >= 60) return null;

  let ms = 0;
  if (clockMatch[4] !== undefined) {
    ms = parseFractionMs(clockMatch[4]);
  } else if (clockMatch[5] !== undefined) {
    const frames = Number.parseInt(clockMatch[5], 10);
    ms = Math.round((frames / frameRate) * 1000);
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

/** Parses TTML `<p>` subtitle cues supporting clock, frame-rate, and offset times in O(N) time. */
export function parseTtml(content: string, warnings: string[]): RawSubtitleCue[] {
  let frameRate = 30;
  let tickRate = 10_000_000;

  const rootAttrSource = findTtmlRootAttrs(content);
  if (rootAttrSource !== null) {
    const rootAttrs = parseXmlAttributes(rootAttrSource);
    const parsedFps = Number.parseFloat(rootAttrs.framerate ?? '');
    if (Number.isFinite(parsedFps) && parsedFps > 0) frameRate = parsedFps;
    const parsedTick = Number.parseFloat(rootAttrs.tickrate ?? '');
    if (Number.isFinite(parsedTick) && parsedTick > 0) tickRate = parsedTick;
  }

  const cues: RawSubtitleCue[] = [];
  let pos = 0;
  let nextClose = -2;
  let nextOpen = -2;

  while (pos < content.length) {
    const open = content.indexOf('<', pos);
    if (open === -1) break;
    const nameEnd = matchPrefixedTagName(content, open + 1, 'p');
    if (nameEnd === -1) {
      pos = open + 1;
      continue;
    }

    if (nextClose !== -1 && nextClose < nameEnd) {
      nextClose = content.indexOf('>', nameEnd);
    }
    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen <= open) {
      nextOpen = content.indexOf('<', open + 1);
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      pos = nextOpen;
      continue;
    }

    const openTagEnd = nextClose;
    if (openTagEnd > nameEnd && content.charCodeAt(openTagEnd - 1) === 0x2f /* / */) {
      pos = openTagEnd + 1;
      continue;
    }

    const closing = findNextClosingP(content, openTagEnd + 1);
    if (closing === null) break;

    const attrs = parseXmlAttributes(content.slice(nameEnd, openTagEnd));
    const body = content.slice(openTagEnd + 1, closing.start);
    pos = closing.end;

    if (attrs.begin === undefined) continue;
    const startMs = parseTtmlTimeMs(attrs.begin, frameRate, tickRate);
    let endMs: number | null = null;
    if (attrs.end !== undefined) {
      endMs = parseTtmlTimeMs(attrs.end, frameRate, tickRate);
    } else if (attrs.dur !== undefined) {
      const durMs = parseTtmlTimeMs(attrs.dur, frameRate, tickRate);
      if (startMs !== null && durMs !== null) endMs = startMs + durMs;
    }

    if (startMs === null || endMs === null) {
      warnings.push('malformed-timecode');
      continue;
    }
    if (endMs <= startMs) {
      warnings.push('non-positive-duration');
      continue;
    }

    const stripped = stripTtmlBodyTags(body);
    const decoded = decodeEntities(stripped.replace(NBSP_RE, ' '));
    const text = decoded
      .split('\n')
      .map((part) => part.replace(MULTI_SPACE_RE, ' ').trim())
      .filter((part) => part.length > 0)
      .join('\n');

    if (text.length > 0) {
      cues.push({ startMs, endMs, text });
    }
  }

  return cues;
}
