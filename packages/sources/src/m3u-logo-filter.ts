import { MAX_INLINE_LOGO_BYTES } from './m3u-attrs';

const LF = 10;
const CR = 13;
const TAB = 9;
const SPACE = 32;
const DQUOTE = 34;
const HASH = 35;
const SQUOTE = 39;
const COMMA = 44;
const EQUALS = 61;
const BACKSLASH = 92;

const MAX_LINE = 1 << 20;

const EXTINF_UPPER = [0x23, 0x45, 0x58, 0x54, 0x49, 0x4e, 0x46, 0x3a] as const; // #EXTINF:
const DATA_LOWER = [0x64, 0x61, 0x74, 0x61, 0x3a] as const; // data:
const LOGO_LOWER = [0x6c, 0x6f, 0x67, 0x6f] as const; // logo
const TVG_LOGO_LOWER = [0x74, 0x76, 0x67, 0x2d, 0x6c, 0x6f, 0x67, 0x6f] as const; // tvg-logo

const BOM_0 = 0;
const BOM_1 = 1;
const BOM_2 = 2;
const LEAD_WS = 3;
const EXTINF_PREFIX = 4;
const PASSTHROUGH = 5;
const DISCARD = 6;
const ATTR_SPACE = 7;
const ATTR_KEY = 8;
const ATTR_VAL_START = 9;
const ATTR_QUOTED = 10;
const ATTR_BARE = 11;
const LOGO_PREFIX = 12;
const LOGO_DATA_BUF = 13;
const LOGO_DATA_SKIP = 14;

function toLowerAscii(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

function toUpperAscii(b: number): number {
  return b >= 97 && b <= 122 ? b - 32 : b;
}

function isLogoAttrKey(buf: Uint8Array, len: number): boolean {
  if (len === 4) {
    for (let k = 0; k < 4; k++) {
      if (buf[k] !== LOGO_LOWER[k]) return false;
    }
    return true;
  }
  if (len === 8) {
    for (let k = 0; k < 8; k++) {
      if (buf[k] !== TVG_LOGO_LOWER[k]) return false;
    }
    return true;
  }
  return false;
}

/**
 * Streaming O(1)-memory M3U line accumulator that strips oversized inline `data:` `tvg-logo` / `logo`
 * attribute payloads (> 4096 bytes) on `#EXTINF:` lines before `MAX_LINE` (1 MiB) can overflow.
 */
export class M3uLineAccumulator {
  private data = new Uint8Array(1024);
  private len = 0;
  private hasBytes = false;
  private tooLong = false;
  private inlineLogoStripped = false;
  private skipLf = false;
  private state = BOM_0;
  private prefixIdx = 0;
  private readonly keyBuf = new Uint8Array(8);
  private keyLen = 0;
  private isLogoKey = false;
  private quoteByte = DQUOTE;
  private quotedEscaped = false;
  private dataStart = 0;
  private dataLen = 0;

  /** Feeds bytes from `chunk` starting at `offset`, invoking callbacks per completed line until `canContinue()` is false. */
  feed(
    chunk: Uint8Array,
    startOffset: number,
    onLine: (bytes: Uint8Array, start: number, end: number, inlineLogoStripped: boolean) => void,
    onTooLong: () => void,
    canContinue: () => boolean,
  ): number {
    let offset = startOffset;
    const total = chunk.length;
    while (offset < total && canContinue()) {
      if (this.skipLf) {
        if (chunk[offset] === LF) offset++;
        this.skipLf = false;
        if (offset >= total) break;
      }
      let eol = offset;
      while (eol < total) {
        const b = chunk[eol] as number;
        if (b === LF || b === CR) break;
        eol++;
      }
      if (eol > offset) this.ingestSegment(chunk, offset, eol);
      if (eol >= total) {
        offset = total;
        break;
      }
      this.emitLine(onLine, onTooLong);
      offset = eol + 1;
      if (chunk[eol] === CR) {
        if (offset < total) {
          if (chunk[offset] === LF) offset++;
        } else {
          this.skipLf = true;
        }
      }
    }
    return offset;
  }

  /** Flushes any trailing unterminated line at EOF. */
  flush(
    onLine: (bytes: Uint8Array, start: number, end: number, inlineLogoStripped: boolean) => void,
    onTooLong: () => void,
  ): void {
    if (this.hasBytes) this.emitLine(onLine, onTooLong);
  }

  private emitLine(
    onLine: (bytes: Uint8Array, start: number, end: number, inlineLogoStripped: boolean) => void,
    onTooLong: () => void,
  ): void {
    if (this.state === LOGO_DATA_SKIP) {
      this.pushByteUnchecked(this.quoteByte);
      if (this.len > MAX_LINE) this.tooLong = true;
    } else if (
      (this.state === LOGO_DATA_BUF || this.state === LOGO_PREFIX) &&
      this.len > MAX_LINE
    ) {
      this.tooLong = true;
    }
    if (this.tooLong) onTooLong();
    else onLine(this.data, 0, this.len, this.inlineLogoStripped);
    this.len = 0;
    this.hasBytes = false;
    this.tooLong = false;
    this.inlineLogoStripped = false;
    this.quotedEscaped = false;
    this.state = LEAD_WS;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }

  private pushByteUnchecked(b: number): void {
    this.ensure(1);
    this.data[this.len++] = b;
  }

  private pushByteChecked(b: number): boolean {
    if (this.len + 1 > MAX_LINE) {
      this.markTooLong();
      return false;
    }
    this.pushByteUnchecked(b);
    return true;
  }

  private pushSliceUnchecked(chunk: Uint8Array, start: number, end: number): void {
    const span = end - start;
    this.ensure(span);
    this.data.set(chunk.subarray(start, end), this.len);
    this.len += span;
  }

  private markTooLong(): void {
    this.tooLong = true;
    this.len = 0;
    this.state = DISCARD;
  }

  private ingestSegment(chunk: Uint8Array, start: number, end: number): void {
    this.hasBytes = true;
    let i = start;
    while (i < end) {
      const st = this.state;
      if (st === DISCARD) return;
      if (st === PASSTHROUGH) {
        if (this.len + (end - i) > MAX_LINE) {
          this.markTooLong();
          return;
        }
        this.pushSliceUnchecked(chunk, i, end);
        return;
      }
      if (st === LOGO_DATA_SKIP) {
        const close = chunk.indexOf(this.quoteByte, i);
        if (close < 0 || close >= end) return;
        if (!this.pushByteChecked(this.quoteByte)) return;
        this.state = ATTR_SPACE;
        i = close + 1;
        continue;
      }
      if (st === LOGO_DATA_BUF) {
        const close = chunk.indexOf(this.quoteByte, i);
        if (close >= 0 && close < end) {
          const valSpan = close - i;
          if (this.dataLen + valSpan <= MAX_INLINE_LOGO_BYTES) {
            this.pushSliceUnchecked(chunk, i, close + 1);
            if (this.len > MAX_LINE) {
              this.markTooLong();
              return;
            }
          } else {
            this.len = this.dataStart;
            this.inlineLogoStripped = true;
            if (!this.pushByteChecked(this.quoteByte)) return;
          }
          this.state = ATTR_SPACE;
          i = close + 1;
          continue;
        }
        const span = end - i;
        if (this.dataLen + span <= MAX_INLINE_LOGO_BYTES) {
          this.pushSliceUnchecked(chunk, i, end);
          this.dataLen += span;
        } else {
          this.len = this.dataStart;
          this.inlineLogoStripped = true;
          this.state = LOGO_DATA_SKIP;
        }
        return;
      }
      if (st === ATTR_QUOTED) {
        let stop = end;
        let closed = false;
        for (let p = i; p < end; p++) {
          const cur = chunk[p] as number;
          if (this.quotedEscaped) {
            this.quotedEscaped = false;
            continue;
          }
          if (cur === BACKSLASH) {
            this.quotedEscaped = true;
            continue;
          }
          if (cur === this.quoteByte) {
            stop = p + 1;
            closed = true;
            break;
          }
        }
        if (this.len + (stop - i) > MAX_LINE) {
          this.markTooLong();
          return;
        }
        this.pushSliceUnchecked(chunk, i, stop);
        if (closed) this.state = ATTR_SPACE;
        i = stop;
        continue;
      }
      const b = chunk[i++] as number;
      if (st === LOGO_PREFIX) {
        this.pushByteUnchecked(b);
        if (b === this.quoteByte) {
          if (this.len > MAX_LINE) {
            this.markTooLong();
            return;
          }
          this.state = ATTR_SPACE;
        } else if (toLowerAscii(b) === DATA_LOWER[this.prefixIdx]) {
          this.prefixIdx++;
          if (this.prefixIdx === DATA_LOWER.length) {
            this.dataLen = DATA_LOWER.length;
            this.state = LOGO_DATA_BUF;
          }
        } else {
          if (this.len > MAX_LINE) {
            this.markTooLong();
            return;
          }
          this.quotedEscaped = b === BACKSLASH;
          this.state = ATTR_QUOTED;
        }
        continue;
      }
      if (!this.pushByteChecked(b)) return;
      this.stepByte(st, b);
    }
  }

  private stepByte(st: number, b: number): void {
    switch (st) {
      case BOM_0:
        if (b === 0xef) {
          this.state = BOM_1;
          return;
        }
        this.stepLeadWs(b);
        return;
      case BOM_1:
        this.state = b === 0xbb ? BOM_2 : PASSTHROUGH;
        return;
      case BOM_2:
        this.state = b === 0xbf ? LEAD_WS : PASSTHROUGH;
        return;
      case LEAD_WS:
        this.stepLeadWs(b);
        return;
      case EXTINF_PREFIX:
        if (toUpperAscii(b) === EXTINF_UPPER[this.prefixIdx]) {
          this.prefixIdx++;
          if (this.prefixIdx === EXTINF_UPPER.length) this.state = ATTR_SPACE;
        } else {
          this.state = PASSTHROUGH;
        }
        return;
      case ATTR_SPACE:
        if (b > SPACE && b !== COMMA) {
          this.keyBuf[0] = toLowerAscii(b);
          this.keyLen = 1;
          this.state = ATTR_KEY;
        }
        return;
      case ATTR_KEY:
        if (b === EQUALS) {
          this.isLogoKey = isLogoAttrKey(this.keyBuf, this.keyLen);
          this.state = ATTR_VAL_START;
        } else if (b <= SPACE || b === COMMA) {
          this.state = ATTR_SPACE;
        } else if (this.keyLen < 8) {
          this.keyBuf[this.keyLen++] = toLowerAscii(b);
        } else {
          this.keyLen = 9;
        }
        return;
      case ATTR_VAL_START:
        if (b === DQUOTE || b === SQUOTE) {
          this.quoteByte = b;
          if (this.isLogoKey) {
            this.dataStart = this.len;
            this.prefixIdx = 0;
            this.state = LOGO_PREFIX;
          } else {
            this.state = ATTR_QUOTED;
          }
        } else if (b <= SPACE || b === COMMA) {
          this.state = ATTR_SPACE;
        } else {
          this.state = ATTR_BARE;
        }
        return;
      default:
        // ATTR_BARE
        if (b <= SPACE || b === COMMA) this.state = ATTR_SPACE;
    }
  }

  private stepLeadWs(b: number): void {
    if (b === SPACE || b === TAB) {
      this.state = LEAD_WS;
    } else if (b === HASH) {
      this.prefixIdx = 1;
      this.state = EXTINF_PREFIX;
    } else {
      this.state = PASSTHROUGH;
    }
  }
}
