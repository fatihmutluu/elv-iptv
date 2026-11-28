const MIN_DICT_BYTES = 4096;
const FLUSH_SLICE_BYTES = 64 * 1024;
const PROB_INIT = 1024;

/** Minimal async byte-reader port consumed by {@link Lzma2Decoder}. */
export interface XzByteReader {
  readByte(): Promise<number>;
  readExact(n: number): Promise<Uint8Array>;
}

interface LenDecoder {
  choice: Uint16Array;
  low: Uint16Array;
  mid: Uint16Array;
  high: Uint16Array;
}

function createLenDecoder(): LenDecoder {
  return {
    choice: new Uint16Array(2).fill(PROB_INIT),
    low: new Uint16Array(16 * 8).fill(PROB_INIT),
    mid: new Uint16Array(16 * 8).fill(PROB_INIT),
    high: new Uint16Array(256).fill(PROB_INIT),
  };
}

function resetLenDecoder(d: LenDecoder): void {
  d.choice.fill(PROB_INIT);
  d.low.fill(PROB_INIT);
  d.mid.fill(PROB_INIT);
  d.high.fill(PROB_INIT);
}

/** Clean-room streaming LZMA2 + LZMA1 range decoder with lazy, bounded sliding dictionary. */
export class Lzma2Decoder {
  private dict: Uint8Array | undefined;
  private readonly dictSize: number;
  private readonly acquireDict: (size: number) => Uint8Array;
  private dictPos = 0;
  private flushStart = 0;
  private dictFull = false;
  private totalOut = 0;
  private lowPos = 0;
  private needDictReset = true;
  private needProps = true;

  private lc = 0;
  private lpMask = 0;
  private pbMask = 0;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;

  private litProbs = new Uint16Array(0);
  private readonly isMatch = new Uint16Array(12 * 16);
  private readonly isRep = new Uint16Array(12);
  private readonly isRepG0 = new Uint16Array(12);
  private readonly isRepG1 = new Uint16Array(12);
  private readonly isRepG2 = new Uint16Array(12);
  private readonly isRep0Long = new Uint16Array(12 * 16);
  private readonly posSlot = new Uint16Array(4 * 64);
  private readonly posSpecial = new Uint16Array(115);
  private readonly posAlign = new Uint16Array(16);
  private readonly matchLen = createLenDecoder();
  private readonly repLen = createLenDecoder();

  constructor(dictSize: number, acquireDict?: (size: number) => Uint8Array) {
    this.dictSize = Math.max(MIN_DICT_BYTES, dictSize);
    this.acquireDict = acquireDict ?? ((size) => new Uint8Array(size));
  }

  private ensureDict(): Uint8Array {
    this.dict ??= this.acquireDict(this.dictSize);
    return this.dict;
  }

  private resetDict(): void {
    this.dictPos = 0;
    this.flushStart = 0;
    this.dictFull = false;
    this.totalOut = 0;
    this.lowPos = 0;
  }

  private resetProps(propsByte: number): void {
    if (propsByte > 224) throw new Error('xz: invalid LZMA props');
    const lc = propsByte % 9;
    const rem = Math.floor(propsByte / 9);
    const lp = rem % 5;
    const pb = Math.floor(rem / 5);
    if (lc + lp > 4 || pb > 4) throw new Error('xz: invalid LZMA lc/lp/pb');
    this.lc = lc;
    this.lpMask = (1 << lp) - 1;
    this.pbMask = (1 << pb) - 1;
    this.litProbs = new Uint16Array(0x300 << (lc + lp));
  }

  private resetState(): void {
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
    this.litProbs.fill(PROB_INIT);
    this.isMatch.fill(PROB_INIT);
    this.isRep.fill(PROB_INIT);
    this.isRepG0.fill(PROB_INIT);
    this.isRepG1.fill(PROB_INIT);
    this.isRepG2.fill(PROB_INIT);
    this.isRep0Long.fill(PROB_INIT);
    this.posSlot.fill(PROB_INIT);
    this.posSpecial.fill(PROB_INIT);
    this.posAlign.fill(PROB_INIT);
    resetLenDecoder(this.matchLen);
    resetLenDecoder(this.repLen);
  }

  private flushDict(out: Uint8Array[]): void {
    if (this.dict !== undefined && this.dictPos > this.flushStart) {
      out.push(this.dict.slice(this.flushStart, this.dictPos));
      this.flushStart = this.dictPos;
    }
  }

  private putByte(b: number, out: Uint8Array[]): void {
    const dict = this.ensureDict();
    dict[this.dictPos++] = b;
    this.totalOut += 1;
    this.lowPos = (this.lowPos + 1) & 0x0f;
    if (this.dictPos === this.dictSize) {
      this.flushDict(out);
      this.dictFull = true;
      this.dictPos = 0;
      this.flushStart = 0;
    } else if (this.dictPos - this.flushStart >= FLUSH_SLICE_BYTES) {
      this.flushDict(out);
    }
  }

  private getDictByte(dist: number): number {
    const avail = this.dictFull ? this.dictSize : this.dictPos;
    if (dist >= avail) throw new Error('xz: match distance exceeds dictionary history');
    let idx = this.dictPos - dist - 1;
    if (idx < 0) idx += this.dictSize;
    return (this.dict as Uint8Array)[idx] as number;
  }

  private decodeLzmaChunk(comp: Uint8Array, uncompSize: number): Uint8Array[] {
    if (comp.length < 5 || comp[0] !== 0) {
      throw new Error('xz: corrupt LZMA range coder header');
    }
    let inPos = 5;
    let rcRange = 0xffffffff;
    let rcCode =
      (((comp[1] as number) << 24) |
        ((comp[2] as number) << 16) |
        ((comp[3] as number) << 8) |
        (comp[4] as number)) >>>
      0;

    const readIn = (): number => {
      if (inPos >= comp.length) throw new Error('xz: truncated LZMA2 compressed chunk');
      return comp[inPos++] as number;
    };

    const decodeBit = (probs: Uint16Array, idx: number): number => {
      const prob = probs[idx] as number;
      const bound = (rcRange >>> 11) * prob;
      let bit: number;
      if (rcCode < bound) {
        rcRange = bound;
        probs[idx] = prob + ((2048 - prob) >>> 5);
        bit = 0;
      } else {
        rcRange = (rcRange - bound) >>> 0;
        rcCode = (rcCode - bound) >>> 0;
        probs[idx] = prob - (prob >>> 5);
        bit = 1;
      }
      if (rcRange < 0x01000000) {
        rcRange = (rcRange << 8) >>> 0;
        rcCode = ((rcCode << 8) | readIn()) >>> 0;
      }
      return bit;
    };

    const decodeDirectBits = (numBits: number): number => {
      let result = 0;
      for (let i = 0; i < numBits; i++) {
        rcRange >>>= 1;
        let bit = 0;
        if (rcCode >= rcRange) {
          rcCode = (rcCode - rcRange) >>> 0;
          bit = 1;
        }
        result = (result << 1) | bit;
        if (rcRange < 0x01000000) {
          rcRange = (rcRange << 8) >>> 0;
          rcCode = ((rcCode << 8) | readIn()) >>> 0;
        }
      }
      return result;
    };

    const decodeBitTree = (probs: Uint16Array, offset: number, numBits: number): number => {
      let sym = 1;
      for (let i = 0; i < numBits; i++) {
        sym = (sym << 1) | decodeBit(probs, offset + sym);
      }
      return sym - (1 << numBits);
    };

    const decodeReverseBitTree = (probs: Uint16Array, offset: number, numBits: number): number => {
      let m = 1;
      let sym = 0;
      for (let i = 0; i < numBits; i++) {
        const bit = decodeBit(probs, offset + m);
        m = (m << 1) | bit;
        sym |= bit << i;
      }
      return sym;
    };

    const decodeLen = (d: LenDecoder, posState: number): number => {
      if (decodeBit(d.choice, 0) === 0) return decodeBitTree(d.low, posState << 3, 3);
      if (decodeBit(d.choice, 1) === 0) return 8 + decodeBitTree(d.mid, posState << 3, 3);
      return 16 + decodeBitTree(d.high, 0, 8);
    };

    const out: Uint8Array[] = [];
    let remaining = uncompSize;
    while (remaining > 0) {
      const posState = this.lowPos & this.pbMask;
      if (decodeBit(this.isMatch, (this.state << 4) + posState) === 0) {
        const prevByte = this.totalOut === 0 ? 0 : this.getDictByte(0);
        const litState = ((this.lowPos & this.lpMask) << this.lc) + (prevByte >>> (8 - this.lc));
        const litOffset = litState * 0x300;
        let sym = 1;
        if (this.state >= 7) {
          let matchByte = this.getDictByte(this.rep0);
          while (sym < 0x100) {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte = (matchByte << 1) & 0xff;
            const bit = decodeBit(this.litProbs, litOffset + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | bit;
            if (matchBit !== bit) {
              while (sym < 0x100) {
                sym = (sym << 1) | decodeBit(this.litProbs, litOffset + sym);
              }
              break;
            }
          }
        } else {
          while (sym < 0x100) {
            sym = (sym << 1) | decodeBit(this.litProbs, litOffset + sym);
          }
        }
        this.putByte(sym & 0xff, out);
        remaining -= 1;
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
        continue;
      }

      let len: number;
      if (decodeBit(this.isRep, this.state) === 0) {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = 2 + decodeLen(this.matchLen, posState);
        this.state = this.state < 7 ? 7 : 10;
        const lenState = len - 2 < 4 ? len - 2 : 3;
        const slot = decodeBitTree(this.posSlot, lenState << 6, 6);
        if (slot < 4) {
          this.rep0 = slot;
        } else {
          const numDirect = (slot >>> 1) - 1;
          let dist = (2 | (slot & 1)) << numDirect;
          if (slot < 14) {
            dist += decodeReverseBitTree(this.posSpecial, dist - slot, numDirect);
          } else {
            dist +=
              (decodeDirectBits(numDirect - 4) << 4) + decodeReverseBitTree(this.posAlign, 0, 4);
          }
          this.rep0 = dist >>> 0;
        }
      } else {
        if (decodeBit(this.isRepG0, this.state) === 0) {
          if (decodeBit(this.isRep0Long, (this.state << 4) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11;
            this.putByte(this.getDictByte(this.rep0), out);
            remaining -= 1;
            continue;
          }
        } else {
          let dist: number;
          if (decodeBit(this.isRepG1, this.state) === 0) {
            dist = this.rep1;
          } else {
            if (decodeBit(this.isRepG2, this.state) === 0) {
              dist = this.rep2;
            } else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = 2 + decodeLen(this.repLen, posState);
        this.state = this.state < 7 ? 8 : 11;
      }

      if (len > remaining) throw new Error('xz: match overflows LZMA2 chunk');
      for (let i = 0; i < len; i++) {
        this.putByte(this.getDictByte(this.rep0), out);
      }
      remaining -= len;
    }

    if (rcCode !== 0 || inPos !== comp.length) {
      throw new Error('xz: corrupt LZMA2 chunk termination');
    }
    this.flushDict(out);
    return out;
  }

  async *decodeBlock(reader: XzByteReader): AsyncGenerator<Uint8Array> {
    for (;;) {
      const ctrl = await reader.readByte();
      if (ctrl === 0x00) return;

      if (ctrl === 0x01 || ctrl === 0x02) {
        if (ctrl === 0x01) {
          this.resetDict();
          this.needDictReset = false;
        } else if (this.needDictReset) {
          throw new Error('xz: uncompressed chunk missing dictionary reset');
        }
        const szBytes = await reader.readExact(2);
        const uncompSize = (((szBytes[0] as number) << 8) | (szBytes[1] as number)) + 1;
        const raw = await reader.readExact(uncompSize);
        const out: Uint8Array[] = [];
        for (let i = 0; i < raw.length; i++) {
          this.putByte(raw[i] as number, out);
        }
        this.flushDict(out);
        for (const slice of out) yield slice;
        continue;
      }

      if (ctrl < 0x80) throw new Error(`xz: invalid LZMA2 control byte 0x${ctrl.toString(16)}`);

      const mode = (ctrl >>> 5) & 3;
      const hdr = await reader.readExact(4);
      const uncompSize =
        (((ctrl & 0x1f) << 16) | ((hdr[0] as number) << 8) | (hdr[1] as number)) + 1;
      const compSize = (((hdr[2] as number) << 8) | (hdr[3] as number)) + 1;

      if (mode === 3) {
        this.resetDict();
        this.needDictReset = false;
      } else if (this.needDictReset) {
        throw new Error('xz: LZMA2 chunk missing dictionary reset');
      }
      if (mode >= 2) {
        const propsByte = await reader.readByte();
        this.resetProps(propsByte);
        this.resetState();
        this.needProps = false;
      } else {
        if (this.needProps) throw new Error('xz: LZMA2 chunk missing properties');
        if (mode === 1) this.resetState();
      }

      const comp = await reader.readExact(compSize);
      const slices = this.decodeLzmaChunk(comp, uncompSize);
      for (const slice of slices) yield slice;
    }
  }
}
