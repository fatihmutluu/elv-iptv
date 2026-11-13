import { decodeUtf8 } from './utf8';
import {
  BANG,
  findClose,
  findTagEnd,
  GT,
  INCOMPLETE,
  LT,
  nameEnd,
  QUESTION,
  type Resume,
  readAttrs,
  readText,
  SLASH,
  skipMarkup,
  startsWith,
} from './xml-tokens';
import type { XmltvChannel, XmltvProgramme } from './xmltv-types';

const SRC = ['src'] as const;

const is = (body: Uint8Array, at: number, len: number, name: string): boolean =>
  len === name.length && startsWith(body, at, name);

const NO_ATTR: (string | undefined)[] = [undefined];

/**
 * Reads the children of one `<programme>` (`target` is a programme) or `<channel>` body. Only the elements
 * that become fields are decoded. Other elements are tracked on a small stack of open names so that, for
 * example, the `<icon>` inside a `<rating>` is not mistaken for the programme icon; work stays linear
 * because no element is ever searched for its closing tag unless it becomes a field. The first `title`, `sub-title`,
 * `desc`, `episode-num` and `icon` win. Returns false when a wanted element or markup is not closed.
 */
export function parseChildren(
  body: Uint8Array,
  target: XmltvProgramme | XmltvChannel,
  isProgramme: boolean,
): boolean {
  const res: Resume = { at: 0 };
  const open = new OpenStack();
  const prog = isProgramme ? (target as XmltvProgramme) : undefined;
  const chan = isProgramme ? undefined : (target as XmltvChannel);
  let haveTitle = false;
  let i = 0;
  for (;;) {
    const lt = body.indexOf(LT, i);
    const b1 = lt < 0 ? undefined : body[lt + 1];
    if (b1 === undefined) return true;
    if (b1 === SLASH) {
      closeUnknown(body, lt + 2, open);
      i = lt + 2;
      continue;
    }
    if (b1 === BANG || b1 === QUESTION) {
      const e = skipMarkup(body, lt);
      if (e < 0) return false;
      i = e;
      continue;
    }
    const tagEnd = findTagEnd(body, lt);
    if (tagEnd < 0) return false;
    const ns = lt + 1;
    const len = nameEnd(body, ns) - ns;
    const selfClosing = body[tagEnd - 2] === SLASH;

    if (is(body, ns, len, 'icon')) {
      if (open.starts.length === 0 && (prog ? prog.icon === undefined : chan?.icon === undefined)) {
        readAttrs(body, ns + len, tagEnd - 1, SRC, NO_ATTR);
        const src = NO_ATTR[0];
        if (src) {
          if (prog) prog.icon = src;
          else if (chan) chan.icon = src;
        }
      }
      if (!selfClosing) open.push(ns, len);
      i = tagEnd;
      continue;
    }
    if (!isWanted(body, ns, len, isProgramme)) {
      if (!selfClosing) open.push(ns, len);
      i = tagEnd;
      continue;
    }

    let close = tagEnd;
    let next = tagEnd;
    if (!selfClosing) {
      close = findClose(body, tagEnd, decodeUtf8(body, ns, ns + len), false, res);
      if (close === INCOMPLETE) return false;
      const gt = body.indexOf(GT, close);
      if (gt < 0) return false;
      next = gt + 1;
    }
    i = next;
    if (selfClosing) continue;

    if (chan) {
      if (is(body, ns, len, 'display-name')) {
        const t = readText(body, tagEnd, close);
        if (t) chan.names.push(t);
      }
    } else if (prog) {
      if (is(body, ns, len, 'title')) {
        if (!haveTitle) {
          haveTitle = true;
          prog.title = readText(body, tagEnd, close);
        }
      } else if (is(body, ns, len, 'category')) {
        const t = readText(body, tagEnd, close);
        if (t) prog.categories.push(t);
      } else if (is(body, ns, len, 'desc')) {
        if (prog.desc === undefined) setText(body, tagEnd, close, (t) => (prog.desc = t));
      } else if (is(body, ns, len, 'sub-title')) {
        if (prog.subTitle === undefined) setText(body, tagEnd, close, (t) => (prog.subTitle = t));
      } else if (is(body, ns, len, 'episode-num')) {
        if (prog.episodeNum === undefined)
          setText(body, tagEnd, close, (t) => (prog.episodeNum = t));
      }
    }
  }
}

function setText(body: Uint8Array, start: number, end: number, set: (text: string) => void): void {
  const t = readText(body, start, end);
  if (t) set(t);
}

function isWanted(body: Uint8Array, at: number, len: number, isProgramme: boolean): boolean {
  if (!isProgramme) return is(body, at, len, 'display-name');
  return (
    is(body, at, len, 'title') ||
    is(body, at, len, 'sub-title') ||
    is(body, at, len, 'desc') ||
    is(body, at, len, 'category') ||
    is(body, at, len, 'episode-num')
  );
}

const MAX_OPEN = 64;
const LOOKBACK = 8;

/** Names of unknown elements that are open at the current position (bounded; matched by byte offsets). */
class OpenStack {
  starts: number[] = [];
  lens: number[] = [];

  push(start: number, len: number): void {
    if (this.starts.length >= MAX_OPEN) return;
    this.starts.push(start);
    this.lens.push(len);
  }
}

/** Pops the innermost of the last few open names that equals the closing tag name at `at`. */
function closeUnknown(body: Uint8Array, at: number, open: OpenStack): void {
  const len = nameEnd(body, at) - at;
  const floor = Math.max(0, open.starts.length - LOOKBACK);
  for (let k = open.starts.length - 1; k >= floor; k--) {
    const start = open.starts[k] as number;
    if (open.lens[k] !== len) continue;
    let same = true;
    for (let j = 0; j < len; j++) {
      if (body[start + j] !== body[at + j]) {
        same = false;
        break;
      }
    }
    if (same) {
      open.starts.length = k;
      open.lens.length = k;
      return;
    }
  }
}
