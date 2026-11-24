import type { XmlEncoding } from './codepages';
import { decodeEntities } from './entities';
import { decodeXmlBytes } from './xmltv-meta';

export const LT = 0x3c;
export const GT = 0x3e;
export const SLASH = 0x2f;
export const BANG = 0x21;
export const QUESTION = 0x3f;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const EQ = 0x3d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const DASH = 0x2d;
const MAX_DECL_DEPTH = 8;
const DECL_KEYWORDS = ['DOCTYPE', 'ENTITY', 'ELEMENT', 'ATTLIST', 'NOTATION'] as const;

/** Result of a finder that ran out of bytes; `Resume.at` then says where to continue next time. */
export const INCOMPLETE = -1;
/** Result of a finder that met malformed markup or the start of a sibling element. */
export const BROKEN = -2;
/** Result of `skipMarkup` for a `<` that does not start a comment, CDATA, PI or declaration. */
const NOT_MARKUP = -3;

/** Out parameter for finders: the offset from which a retry on more bytes can safely resume. */
export interface Resume {
  at: number;
}

/** Streaming resume state for `findTagEnd`: offset relative to `<` (`at`) and open quote byte. */
export interface TagResume {
  at: number;
  quote: number;
}

/** Streaming resume state for `skipMarkup` declarations: offset relative to `<`, bracket depth, and quote byte. */
export interface DeclResume {
  at: number;
  depth: number;
  quote: number;
}

interface ScanHint {
  from: number;
  to: number;
  hit: number;
}

/**
 * Per-buffer search hint cache for `skipMarkup` / `findGt` so repeated unclosed markup introducers
 * (`<!--`, `<![CDATA[`, `<?`, `<!DOCTYPE`, `</`) scan in strictly linear O(N) time instead of O(N^2).
 */
export interface MarkupScanCache {
  comment: ScanHint;
  cdata: ScanHint;
  pi: ScanHint;
  gt: ScanHint;
  dquote: ScanHint;
  squote: ScanHint;
}

const emptyHint = (): ScanHint => ({ from: 0, to: 0, hit: -1 });

/** Creates an empty {@link MarkupScanCache} for one streaming XML buffer. */
export function createMarkupScanCache(): MarkupScanCache {
  return {
    comment: emptyHint(),
    cdata: emptyHint(),
    pi: emptyHint(),
    gt: emptyHint(),
    dquote: emptyHint(),
    squote: emptyHint(),
  };
}

function shiftHint(hint: ScanHint, by: number): void {
  if (hint.hit >= 0) {
    if (hint.hit < by) {
      hint.from = 0;
      hint.to = 0;
      hint.hit = -1;
    } else {
      hint.from = hint.from <= by ? 0 : hint.from - by;
      hint.hit -= by;
      hint.to = hint.hit;
    }
    return;
  }
  if (hint.to <= by) {
    hint.from = 0;
    hint.to = 0;
  } else {
    hint.from = hint.from <= by ? 0 : hint.from - by;
    hint.to -= by;
  }
}

/** Shifts cached search hints left by `consumed` bytes after consuming from the buffer front. */
export function shiftMarkupCache(cache: MarkupScanCache, consumed: number): void {
  if (consumed <= 0) return;
  shiftHint(cache.comment, consumed);
  shiftHint(cache.cdata, consumed);
  shiftHint(cache.pi, consumed);
  shiftHint(cache.gt, consumed);
  shiftHint(cache.dquote, consumed);
  shiftHint(cache.squote, consumed);
}

const isSpace = (b: number): boolean => b === 32 || b === 9 || b === 10 || b === 13;

/** True when `b` can start an XML tag name (`[A-Za-z_:]`), closing tag (`/`), declaration/comment (`!`), or PI (`?`). */
export function isMarkupStart(b: number | undefined): boolean {
  if (b === undefined) return false;
  return (
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0x5f ||
    b === 0x3a ||
    b === SLASH ||
    b === BANG ||
    b === QUESTION
  );
}

/** True when `text` (ASCII) occurs at `at`. */
export function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text.charCodeAt(k)) return false;
  return true;
}

/** First index of the ASCII sequence starting in [from, stopStart), or -1. */
function indexOfSeqBefore(bytes: Uint8Array, from: number, stopStart: number, seq: string): number {
  const first = seq.charCodeAt(0);
  const limit = Math.min(stopStart, bytes.length - seq.length + 1);
  let i = bytes.indexOf(first, from);
  while (i >= 0 && i < limit) {
    if (startsWith(bytes, i, seq)) return i;
    i = bytes.indexOf(first, i + 1);
  }
  return -1;
}

function findCached(
  bytes: Uint8Array,
  start: number,
  hint: ScanHint | undefined,
  tailOverlap: number,
  scan: (from: number, stop: number) => number,
): number {
  const len = bytes.length;
  if (hint === undefined) return scan(start, len);
  const safeEnd = Math.max(start, len - tailOverlap);
  if (hint.hit >= 0) {
    if (start >= hint.from && start <= hint.hit) return hint.hit;
    if (start < hint.from) {
      const head = scan(start, hint.from);
      hint.from = start;
      if (head >= 0) {
        hint.hit = head;
        hint.to = head;
      }
      return hint.hit;
    }
  } else if (hint.to > hint.from) {
    if (start >= hint.from && start <= hint.to) {
      const idx = scan(hint.to, len);
      if (idx >= 0) {
        hint.hit = idx;
        hint.to = idx;
        return idx;
      }
      if (safeEnd > hint.to) hint.to = safeEnd;
      return -1;
    }
    if (start < hint.from) {
      const head = scan(start, hint.from);
      if (head >= 0) {
        hint.from = start;
        hint.hit = head;
        hint.to = head;
        return head;
      }
      const tail = scan(hint.to, len);
      hint.from = start;
      if (tail >= 0) {
        hint.hit = tail;
        hint.to = tail;
        return tail;
      }
      hint.to = Math.max(hint.to, safeEnd);
      return -1;
    }
  }
  const idx = scan(start, len);
  hint.from = start;
  hint.hit = idx;
  hint.to = idx >= 0 ? idx : safeEnd;
  return idx;
}

function findByte(bytes: Uint8Array, start: number, byte: number, hint?: ScanHint): number {
  return findCached(bytes, start, hint, 0, (from, stop) =>
    stop === bytes.length ? bytes.indexOf(byte, from) : bytes.subarray(0, stop).indexOf(byte, from),
  );
}

function findSeq(bytes: Uint8Array, start: number, seq: string, hint?: ScanHint): number {
  return findCached(bytes, start, hint, seq.length - 1, (from, stop) =>
    indexOfSeqBefore(bytes, from, stop, seq),
  );
}

/** First index of `>` at or after `from`, or -1, reusing `cache` to stay O(N) on unclosed tags. */
export function findGt(bytes: Uint8Array, from: number, cache?: MarkupScanCache): number {
  return findByte(bytes, from, GT, cache?.gt);
}

/**
 * Compares the element name at `at` with `name`: 1 when it matches and is followed by a name terminator,
 * 0 when it does not, -1 when the buffer ends before the answer is known.
 */
export function matchName(bytes: Uint8Array, at: number, name: string): number {
  for (let k = 0; k < name.length; k++) {
    if (at + k >= bytes.length) return -1;
    if (bytes[at + k] !== name.charCodeAt(k)) return 0;
  }
  const after = at + name.length;
  if (after >= bytes.length) return -1;
  const b = bytes[after] as number;
  return b === GT || b === SLASH || isSpace(b) ? 1 : 0;
}

/** End of the name that starts at `at`. */
export function nameEnd(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b === GT || b === SLASH || isSpace(b)) break;
    i++;
  }
  return i;
}

function matchExactOrPrefix(bytes: Uint8Array, start: number, text: string): number {
  for (let k = 0; k < text.length; k++) {
    if (start + k >= bytes.length) return -1;
    if (bytes[start + k] !== text.charCodeAt(k)) return 0;
  }
  return 1;
}

function matchDeclKeyword(bytes: Uint8Array, start: number): number {
  const len = bytes.length;
  if (start >= len) return -1;
  let partial = false;
  for (let k = 0; k < DECL_KEYWORDS.length; k++) {
    const kw = DECL_KEYWORDS[k] as string;
    let matched = true;
    for (let j = 0; j < kw.length; j++) {
      if (start + j >= len) {
        partial = true;
        matched = false;
        break;
      }
      let b = bytes[start + j] as number;
      if (b >= 0x61 && b <= 0x7a) b -= 32;
      if (b !== kw.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const after = start + kw.length;
    if (after >= len) return -1;
    const b = bytes[after] as number;
    if (isSpace(b) || b === GT || b === OPEN_BRACKET) return 1;
  }
  return partial ? -1 : 0;
}

function resetDeclResume(resume: DeclResume | undefined): void {
  if (resume === undefined) return;
  resume.at = 0;
  resume.depth = 0;
  resume.quote = 0;
}

/**
 * For a `<` at `at` that starts a comment, CDATA section, processing instruction or declaration (with an
 * internal subset), the index after it; `INCOMPLETE` when it is not finished; `NOT_MARKUP` otherwise.
 */
export function skipMarkup(
  bytes: Uint8Array,
  at: number,
  cache?: MarkupScanCache,
  declResume?: DeclResume,
): number {
  const b1 = bytes[at + 1];
  if (b1 === QUESTION) {
    const e = findSeq(bytes, at + 2, '?>', cache?.pi);
    return e < 0 ? INCOMPLETE : e + 2;
  }
  if (b1 !== BANG) return NOT_MARKUP;
  if (at + 2 >= bytes.length) return INCOMPLETE;
  const b2 = bytes[at + 2];
  if (b2 === DASH) {
    const m = matchExactOrPrefix(bytes, at, '<!--');
    if (m < 0) return INCOMPLETE;
    if (m === 0) return NOT_MARKUP;
    const e = findSeq(bytes, at + 4, '-->', cache?.comment);
    return e < 0 ? INCOMPLETE : e + 3;
  }
  if (b2 === OPEN_BRACKET) {
    const m = matchExactOrPrefix(bytes, at, '<![CDATA[');
    if (m < 0) return INCOMPLETE;
    if (m === 0) return NOT_MARKUP;
    const e = findSeq(bytes, at + 9, ']]>', cache?.cdata);
    return e < 0 ? INCOMPLETE : e + 3;
  }
  const kw = matchDeclKeyword(bytes, at + 2);
  if (kw < 0) return INCOMPLETE;
  if (kw === 0) {
    resetDeclResume(declResume);
    return NOT_MARKUP;
  }
  const resuming = declResume !== undefined && declResume.at > 0;
  let depth = resuming ? declResume.depth : 0;
  let quote = resuming ? declResume.quote : 0;
  let i = resuming ? at + declResume.at : at + 2;
  while (i < bytes.length) {
    if (quote !== 0) {
      const close = findByte(bytes, i, quote, quote === DQUOTE ? cache?.dquote : cache?.squote);
      if (close < 0) {
        if (declResume !== undefined) {
          declResume.at = bytes.length - at;
          declResume.depth = depth;
          declResume.quote = quote;
        }
        return INCOMPLETE;
      }
      quote = 0;
      i = close + 1;
      continue;
    }
    const b = bytes[i] as number;
    if (b === DQUOTE || b === SQUOTE) {
      quote = b;
      i++;
    } else if (b === LT && depth <= 0) {
      resetDeclResume(declResume);
      return NOT_MARKUP;
    } else if (b === OPEN_BRACKET) {
      depth++;
      if (depth > MAX_DECL_DEPTH) {
        resetDeclResume(declResume);
        return NOT_MARKUP;
      }
      i++;
    } else if (b === CLOSE_BRACKET) {
      depth--;
      i++;
    } else if (b === GT && depth <= 0) {
      resetDeclResume(declResume);
      return i + 1;
    } else {
      i++;
    }
  }
  if (declResume !== undefined) {
    declResume.at = bytes.length - at;
    declResume.depth = depth;
    declResume.quote = quote;
  }
  return INCOMPLETE;
}

/**
 * Index after the `>` that ends the open tag starting at `at`, honoring quoted values. A raw `<` before the
 * end means the tag is malformed (`BROKEN`); running out of bytes gives `INCOMPLETE`.
 */
export function findTagEnd(bytes: Uint8Array, at: number, resume?: TagResume): number {
  const resuming = resume !== undefined && resume.at > 0;
  let quote = resuming ? resume.quote : 0;
  const start = resuming ? at + resume.at : at + 1;
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === LT) {
      if (resume !== undefined) {
        resume.at = 0;
        resume.quote = 0;
      }
      return BROKEN;
    }
    if (quote !== 0) {
      if (b === quote) quote = 0;
    } else if (b === DQUOTE || b === SQUOTE) quote = b;
    else if (b === GT) {
      if (resume !== undefined) {
        resume.at = 0;
        resume.quote = 0;
      }
      return i + 1;
    }
  }
  if (resume !== undefined) {
    resume.at = bytes.length - at;
    resume.quote = quote;
  }
  return INCOMPLETE;
}

/**
 * Finds the `<` of `</name>` at or after `from`, skipping comments and CDATA. With `stopAtSibling`, the start
 * of another `<programme` or `<channel` returns `BROKEN` because the element being searched is unclosed.
 */
export function findClose(
  bytes: Uint8Array,
  from: number,
  name: string,
  stopAtSibling: boolean,
  out: Resume,
  cache?: MarkupScanCache,
  declResume?: DeclResume,
): number {
  let i = bytes.indexOf(LT, from);
  while (i >= 0) {
    const b1 = bytes[i + 1];
    if (b1 === undefined) break;
    if (b1 === SLASH) {
      const m = matchName(bytes, i + 2, name);
      if (m === 1) return i;
      if (m < 0) break;
    } else if (b1 === BANG || b1 === QUESTION) {
      const e = skipMarkup(bytes, i, cache, declResume);
      if (e === INCOMPLETE) break;
      if (e > 0) {
        i = bytes.indexOf(LT, e);
        continue;
      }
    } else if (stopAtSibling) {
      const m = matchName(bytes, i + 1, 'programme');
      const c = m === 0 ? matchName(bytes, i + 1, 'channel') : m;
      if (c === 1) return BROKEN;
      if (c < 0) break;
    }
    i = bytes.indexOf(LT, i + 1);
  }
  out.at = i < 0 ? bytes.length : i;
  return INCOMPLETE;
}

/**
 * Reads the attributes in bytes[from, to) (after the element name, before `>`) and stores the decoded value
 * of each wanted name in `values` (same order as `names`); unwanted attributes are skipped undecoded.
 */
export function readAttrs(
  bytes: Uint8Array,
  from: number,
  to: number,
  names: readonly string[],
  values: (string | undefined)[],
  encoding: XmlEncoding = 'utf-8',
): void {
  values.fill(undefined);
  let i = from;
  while (i < to) {
    while (i < to && (isSpace(bytes[i] as number) || bytes[i] === SLASH)) i++;
    const nameStart = i;
    while (i < to) {
      const b = bytes[i] as number;
      if (b === EQ || b === SLASH || isSpace(b)) break;
      i++;
    }
    const nameStop = i;
    while (i < to && isSpace(bytes[i] as number)) i++;
    if (i >= to || bytes[i] !== EQ) continue;
    i++;
    while (i < to && isSpace(bytes[i] as number)) i++;
    const q = bytes[i];
    let vs = i;
    let ve: number;
    if (q === DQUOTE || q === SQUOTE) {
      vs = i + 1;
      ve = bytes.indexOf(q, vs);
      if (ve < 0 || ve > to) ve = to;
      i = ve + 1;
    } else {
      while (i < to && !isSpace(bytes[i] as number)) i++;
      ve = i;
    }
    for (let n = 0; n < names.length; n++) {
      const want = names[n] as string;
      if (
        values[n] === undefined &&
        nameStop - nameStart === want.length &&
        startsWith(bytes, nameStart, want)
      ) {
        values[n] = decodeEntities(decodeXmlBytes(bytes, vs, ve, encoding));
        break;
      }
    }
  }
}

/** Number of line feeds in bytes[0, end). */
export function countLf(bytes: Uint8Array, end: number): number {
  const head = bytes.subarray(0, end);
  let n = 0;
  let i = head.indexOf(10);
  while (i >= 0) {
    n++;
    i = head.indexOf(10, i + 1);
  }
  return n;
}

function isNestedBrTag(bytes: Uint8Array, lt: number): boolean {
  const b1 = bytes[lt + 1];
  const b2 = bytes[lt + 2];
  const b3 = bytes[lt + 3];
  if (b1 === undefined || b2 === undefined || b3 === undefined) return false;
  if ((b1 | 32) !== 0x62 || (b2 | 32) !== 0x72) return false;
  return b3 === GT || b3 === SLASH || isSpace(b3);
}

/** Decodes element text: entities resolved, CDATA kept literal, nested tags and comments dropped, trimmed. */
export function readText(
  bytes: Uint8Array,
  start: number,
  end: number,
  encoding: XmlEncoding = 'utf-8',
): string {
  const firstLt = bytes.indexOf(LT, start);
  if (firstLt < 0 || firstLt >= end) {
    return decodeEntities(decodeXmlBytes(bytes, start, end, encoding)).trim();
  }
  const view = bytes.subarray(start, end);
  let out = '';
  let i = 0;
  let cache: MarkupScanCache | undefined;
  while (i < view.length) {
    const lt = view.indexOf(LT, i);
    if (lt < 0) {
      out += decodeEntities(decodeXmlBytes(view, i, view.length, encoding));
      break;
    }
    out += decodeEntities(decodeXmlBytes(view, i, lt, encoding));
    if (!isMarkupStart(view[lt + 1])) {
      out += '<';
      i = lt + 1;
      continue;
    }
    if (startsWith(view, lt, '<![CDATA[')) {
      const e = indexOfSeqBefore(view, lt + 9, view.length, ']]>');
      if (e < 0) {
        out += decodeXmlBytes(view, lt + 9, view.length, encoding);
        break;
      }
      out += decodeXmlBytes(view, lt + 9, e, encoding);
      i = e + 3;
    } else {
      const b1 = view[lt + 1];
      if (b1 === BANG || b1 === QUESTION) cache ??= createMarkupScanCache();
      const m = skipMarkup(view, lt, cache);
      if (m > 0) i = m;
      else {
        const gt = view.indexOf(GT, lt);
        if (gt < 0) break;
        if (
          isNestedBrTag(view, lt) &&
          out.length > 0 &&
          !out.endsWith(' ') &&
          gt + 1 < view.length &&
          !isSpace(view[gt + 1] as number)
        ) {
          out += ' ';
        }
        i = gt + 1;
      }
    }
  }
  return out.trim();
}
