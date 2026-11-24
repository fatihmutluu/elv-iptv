const REPLACEMENT = 0xfffd;
const SLICE = 4096;
/** Reusable code-unit buffer for synchronous leaf `decodeUtf8` calls (eliminates millions of GC arrays on Hermes). */
const UTF8_SCRATCH: number[] = [];

/**
 * Decodes bytes[start, end) as UTF-8 with U+FFFD for invalid sequences, without `TextDecoder`.
 * A leading byte order mark is kept as U+FEFF; scanners strip it themselves.
 */
export function decodeUtf8(bytes: Uint8Array, start = 0, end: number = bytes.length): string {
  const limit = Math.min(end, bytes.length);
  let i = Math.max(start, 0);
  if (i >= limit) return '';

  // Pure-ASCII fast path: zero closures, zero per-call arrays, zero per-byte function calls.
  let scan = i;
  while (scan < limit && (bytes[scan] as number) < 0x80) scan++;
  if (scan === limit) {
    const len = limit - i;
    if (len <= SLICE) {
      UTF8_SCRATCH.length = len;
      for (let k = 0; k < len; k++) UTF8_SCRATCH[k] = bytes[i + k] as number;
      return String.fromCharCode.apply(null, UTF8_SCRATCH);
    }
    let fast = '';
    while (i < limit) {
      const chunk = Math.min(limit - i, SLICE);
      UTF8_SCRATCH.length = chunk;
      for (let k = 0; k < chunk; k++) UTF8_SCRATCH[k] = bytes[i + k] as number;
      fast += String.fromCharCode.apply(null, UTF8_SCRATCH);
      i += chunk;
    }
    return fast;
  }

  let out = '';
  let count = 0;
  while (i < limit) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      UTF8_SCRATCH[count++] = b;
      if (count >= SLICE) {
        UTF8_SCRATCH.length = count;
        out += String.fromCharCode.apply(null, UTF8_SCRATCH);
        count = 0;
      }
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      cp = b & 0x0f;
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      cp = b & 0x07;
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
    } else {
      UTF8_SCRATCH[count++] = REPLACEMENT;
      if (count >= SLICE) {
        UTF8_SCRATCH.length = count;
        out += String.fromCharCode.apply(null, UTF8_SCRATCH);
        count = 0;
      }
      i++;
      continue;
    }
    i++;
    let ok = true;
    for (let k = 0; k < need; k++) {
      const c = i < limit ? (bytes[i] as number) : -1;
      if (c < lower || c > upper) {
        ok = false;
        break;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (c & 0x3f);
      i++;
    }
    const resolved = ok ? cp : REPLACEMENT;
    if (resolved >= 0x10000) {
      const v = resolved - 0x10000;
      UTF8_SCRATCH[count++] = 0xd800 + (v >> 10);
      UTF8_SCRATCH[count++] = 0xdc00 + (v & 0x3ff);
    } else {
      UTF8_SCRATCH[count++] = resolved;
    }
    if (count >= SLICE) {
      UTF8_SCRATCH.length = count;
      out += String.fromCharCode.apply(null, UTF8_SCRATCH);
      count = 0;
    }
  }
  if (count > 0) {
    UTF8_SCRATCH.length = count;
    out += String.fromCharCode.apply(null, UTF8_SCRATCH);
  }
  return out;
}

/** Bytes accumulator with amortized O(1) append and consume-from-front. */
export class ByteBuffer {
  private data = new Uint8Array(1024);
  private head = 0;
  private tail = 0;

  /** Adds `chunk` after the unconsumed bytes. */
  append(chunk: Uint8Array): void {
    const live = this.tail - this.head;
    if (this.tail + chunk.length > this.data.length) {
      const needed = live + chunk.length;
      if (needed <= this.data.length * 0.75) {
        this.data.copyWithin(0, this.head, this.tail);
      } else {
        let size = this.data.length * 2;
        while (size < needed) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.data.subarray(this.head, this.tail));
        this.data = next;
      }
      this.head = 0;
      this.tail = live;
    }
    this.data.set(chunk, this.tail);
    this.tail += chunk.length;
  }

  /** Unconsumed bytes; valid only until the next `append`. */
  get view(): Uint8Array {
    return this.data.subarray(this.head, this.tail);
  }

  /** Drops `n` bytes from the front. */
  consume(n: number): void {
    this.head = Math.min(this.head + n, this.tail);
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
    }
  }

  /** Number of unconsumed bytes. */
  get length(): number {
    return this.tail - this.head;
  }
}
