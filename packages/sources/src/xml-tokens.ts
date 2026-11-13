import { decodeEntities } from './entities';
import { decodeUtf8 } from './utf8';

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

const isSpace = (b: number): boolean => b === 32 || b === 9 || b === 10 || b === 13;

/** True when `text` (ASCII) occurs at `at`. */
export function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text.charCodeAt(k)) return false;
  return true;
}

/** First index of the ASCII sequence at or after `from`, or -1. */
function indexOfSeq(bytes: Uint8Array, from: number, seq: string): number {
  const first = seq.charCodeAt(0);
  let i = bytes.indexOf(first, from);
  while (i >= 0) {
    if (startsWith(bytes, i, seq)) return i;
    i = bytes.indexOf(first, i + 1);
  }
  return -1;
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

/**
 * For a `<` at `at` that starts a comment, CDATA section, processing instruction or declaration (with an
 * internal subset), the index after it; `INCOMPLETE` when it is not finished; `NOT_MARKUP` otherwise.
 */
export function skipMarkup(bytes: Uint8Array, at: number): number {
  const b1 = bytes[at + 1];
  if (b1 === QUESTION) {
    const e = indexOfSeq(bytes, at + 2, '?>');
    return e < 0 ? INCOMPLETE : e + 2;
  }
  if (b1 !== BANG) return NOT_MARKUP;
  if (at + 3 >= bytes.length) return INCOMPLETE;
  if (startsWith(bytes, at, '<!--')) {
    const e = indexOfSeq(bytes, at + 4, '-->');
    return e < 0 ? INCOMPLETE : e + 3;
  }
  if (startsWith(bytes, at, '<![CDATA[')) {
    const e = indexOfSeq(bytes, at + 9, ']]>');
    return e < 0 ? INCOMPLETE : e + 3;
  }
  let depth = 0;
  let quote = 0;
  for (let i = at + 2; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (quote !== 0) {
      if (b === quote) quote = 0;
    } else if (b === DQUOTE || b === SQUOTE) quote = b;
    else if (b === OPEN_BRACKET) depth++;
    else if (b === CLOSE_BRACKET) depth--;
    else if (b === GT && depth <= 0) return i + 1;
  }
  return INCOMPLETE;
}

/**
 * Index after the `>` that ends the open tag starting at `at`, honoring quoted values. A raw `<` before the
 * end means the tag is malformed (`BROKEN`); running out of bytes gives `INCOMPLETE`.
 */
export function findTagEnd(bytes: Uint8Array, at: number): number {
  let quote = 0;
  for (let i = at + 1; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === LT) return BROKEN;
    if (quote !== 0) {
      if (b === quote) quote = 0;
    } else if (b === DQUOTE || b === SQUOTE) quote = b;
    else if (b === GT) return i + 1;
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
      const e = skipMarkup(bytes, i);
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
        values[n] = decodeEntities(decodeUtf8(bytes, vs, ve));
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

/** Decodes element text: entities resolved, CDATA kept literal, nested tags and comments dropped, trimmed. */
export function readText(bytes: Uint8Array, start: number, end: number): string {
  const view = bytes.subarray(start, end);
  if (view.indexOf(LT) < 0) return decodeEntities(decodeUtf8(view)).trim();
  let out = '';
  let i = 0;
  while (i < view.length) {
    const lt = view.indexOf(LT, i);
    if (lt < 0) {
      out += decodeEntities(decodeUtf8(view, i));
      break;
    }
    out += decodeEntities(decodeUtf8(view, i, lt));
    if (startsWith(view, lt, '<![CDATA[')) {
      const e = indexOfSeq(view, lt + 9, ']]>');
      if (e < 0) {
        out += decodeUtf8(view, lt + 9);
        break;
      }
      out += decodeUtf8(view, lt + 9, e);
      i = e + 3;
    } else {
      const m = skipMarkup(view, lt);
      if (m > 0) i = m;
      else {
        const gt = view.indexOf(GT, lt);
        if (gt < 0) break;
        i = gt + 1;
      }
    }
  }
  return out.trim();
}
