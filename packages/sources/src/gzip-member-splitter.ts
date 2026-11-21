const NEED_MORE = -1;
const INVALID_SYM = -2;
const GZIP_HDR = [0x1f, 0x8b, 0x08];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const OFFSETS = new Uint16Array(16);

type Tree = { c: Uint16Array; s: Uint16Array; m: number };
const makeTree = (n: number): Tree => ({ c: new Uint16Array(16), s: new Uint16Array(n), m: 0 });

function buildTree(lens: Uint8Array, off: number, n: number, tree: Tree, kind: 0 | 1 | 2): boolean {
  const { c: counts, s: symbols } = tree;
  counts.fill(0);
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const l = lens[off + i] as number;
    if (l === 0) continue;
    counts[l] = (counts[l] as number) + 1;
    if (l > maxLen) maxLen = l;
  }
  tree.m = maxLen;
  if (maxLen === 0) return kind === 2;
  let left = 1;
  for (let l = 1, sum = 0; l <= maxLen; l++) {
    const cnt = counts[l] as number;
    left = (left << 1) - cnt;
    if (left < 0) return false;
    OFFSETS[l] = sum;
    sum += cnt;
  }
  if (left > 0 && (kind === 0 || maxLen !== 1)) return false;
  for (let i = 0; i < n; i++) {
    const l = lens[off + i] as number;
    if (l === 0) continue;
    const idx = OFFSETS[l] as number;
    symbols[idx] = i;
    OFFSETS[l] = idx + 1;
  }
  return true;
}

const FIXED_LIT = makeTree(288);
const FIXED_DIST = makeTree(32);
const fixedLitLens = new Uint8Array(288);
fixedLitLens.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
buildTree(fixedLitLens, 0, 288, FIXED_LIT, 1);
buildTree(new Uint8Array(32).fill(5), 0, 32, FIXED_DIST, 2);

/** Result returned by {@link GzipMemberFramer.feed} for one compressed input chunk. */
interface GzipFramerResult {
  /** Bytes belonging to the current gzip member (or the full chunk when `invalid` is true). */
  take: Uint8Array;
  /** Unconsumed bytes following the member's 8-byte trailer, if any. */
  rest: Uint8Array | undefined;
  /** True once the current member's RFC 1952 trailer has been completely consumed. */
  done: boolean;
  /** True when the framing state machine detected an RFC 1952 or RFC 1951 syntax error. */
  invalid: boolean;
}

/** Incremental, O(1)-memory RFC 1952 + RFC 1951 gzip member boundary framer. */
export interface GzipMemberFramer {
  /** Feeds the next compressed chunk and returns the exact member slice and any trailing remainder. */
  feed(chunk: Uint8Array): GzipFramerResult;
}

const out = (take: Uint8Array, rest?: Uint8Array, done = false, invalid = false) => ({
  take,
  rest,
  done,
  invalid,
});

/**
 * Creates a streaming RFC 1952 + RFC 1951 gzip member framer that locates the exact final byte of one
 * gzip member without decompressing output or retaining a sliding window.
 */
export function createGzipMemberFramer(): GzipMemberFramer {
  // States: 0=bytes 1=zstr 2=skip 3=blk 4=dhdr 5=dclen 6=dcodes 7=drep 8=lit 9=dist 10=extra 11=done 12=err
  const p = { state: 0, flg: 0, bfinal: 0, idx: 0, end: 4, mode: 0, acc: 0, rem: 0 };
  const bits = { buf: 0, cnt: 0 };
  const h = { code: 0, first: 0, idx: 0, len: 0 };
  const dyn = { nLit: 0, nDist: 0 };
  const clenLens = new Uint8Array(19);
  const codeLens = new Uint8Array(318);
  const clenTree = makeTree(19);
  const dynLit = makeTree(286);
  const dynDist = makeTree(32);
  let litTree = FIXED_LIT;
  let distTree = FIXED_DIST;

  const toBytes = (need: number, kind: number) => {
    p.end = need;
    p.mode = kind;
    p.idx = p.acc = 0;
    p.state = 0;
  };
  const advanceHeader = () => {
    if ((p.flg & 0x04) !== 0) {
      p.flg &= ~0x04;
      toBytes(2, 1);
    } else if ((p.flg & 0x18) !== 0) {
      p.flg &= (p.flg & 0x08) !== 0 ? ~0x08 : ~0x10;
      p.state = 1;
    } else if ((p.flg & 0x02) !== 0) {
      p.flg &= ~0x02;
      toSkip(2, 0);
    } else {
      bits.buf = bits.cnt = 0;
      p.state = 3;
    }
  };
  const finishBlock = () => {
    if (p.bfinal === 1) {
      bits.buf = bits.cnt = 0;
      toSkip(8, 2);
    } else p.state = 3;
  };
  const toSkip = (n: number, kind: number) => {
    if (n === 0) return kind === 0 ? advanceHeader() : finishBlock();
    p.rem = n;
    p.mode = kind;
    p.state = 2;
  };
  const toExtra = (n: number, next: number) => {
    p.rem = n;
    p.mode = next;
    p.state = n > 0 ? 10 : next;
  };

  return {
    feed(chunk: Uint8Array): GzipFramerResult {
      if (p.state === 12) return out(chunk, undefined, false, true);
      if (p.state === 11) return out(chunk.subarray(0, 0), chunk.length ? chunk : undefined, true);
      const len = chunk.length;
      if (len === 0) return out(chunk);
      let pos = 0;

      const fail = () => {
        p.state = 12;
        return out(chunk, undefined, false, true);
      };
      const readBits = (n: number): number => {
        while (bits.cnt < n) {
          if (pos >= len) return NEED_MORE;
          bits.buf |= (chunk[pos++] as number) << bits.cnt;
          bits.cnt += 8;
        }
        const v = bits.buf & ((1 << n) - 1);
        bits.buf >>>= n;
        bits.cnt -= n;
        return v;
      };
      const decode = (tree: Tree): number => {
        if (tree.m === 0) return INVALID_SYM;
        while (h.len < tree.m) {
          if (bits.cnt === 0) {
            if (pos >= len) return NEED_MORE;
            bits.buf = chunk[pos++] as number;
            bits.cnt = 8;
          }
          h.code = (h.code << 1) | (bits.buf & 1);
          bits.buf >>>= 1;
          bits.cnt--;
          const c = tree.c[++h.len] as number;
          const off = h.code - h.first;
          if (off < c) {
            const sym = tree.s[h.idx + off] as number;
            h.code = h.first = h.idx = h.len = 0;
            return sym;
          }
          h.idx += c;
          h.first = (h.first + c) << 1;
        }
        return INVALID_SYM;
      };

      loop: for (;;) {
        switch (p.state) {
          case 8: {
            const sym = decode(litTree);
            if (sym === NEED_MORE) break loop;
            if (sym < 0 || sym > 285) return fail();
            if (sym === 256) finishBlock();
            else if (sym > 256) toExtra(sym < 265 || sym === 285 ? 0 : (sym - 261) >> 2, 9);
            break;
          }
          case 9: {
            const d = decode(distTree);
            if (d === NEED_MORE) break loop;
            if (d < 0 || d >= 30) return fail();
            toExtra(d < 4 ? 0 : (d - 2) >> 1, 8);
            break;
          }
          case 10:
            if (readBits(p.rem) < 0) break loop;
            p.state = p.mode;
            break;
          case 2: {
            if (pos >= len) break loop;
            const n = Math.min(p.rem, len - pos);
            pos += n;
            p.rem -= n;
            if (p.rem > 0) break;
            if (p.mode < 2) {
              (p.mode === 0 ? advanceHeader : finishBlock)();
              break;
            }
            p.state = 11;
            return out(
              pos === len ? chunk : chunk.subarray(0, pos),
              pos < len ? chunk.subarray(pos) : undefined,
              true,
            );
          }
          case 0: {
            if (pos >= len) break loop;
            const b = chunk[pos++] as number;
            if (p.mode === 0 && p.idx < 3 && b !== GZIP_HDR[p.idx]) return fail();
            p.acc |= b << (p.idx * 8);
            if (++p.idx < p.end) break;
            if (p.mode === 0) {
              p.flg = (p.acc >>> 24) & 0xff;
              if ((p.flg & 0xe0) !== 0) return fail();
              toSkip(6, 0);
            } else if (p.mode === 1) toSkip(p.acc & 0xffff, 0);
            else {
              const slen = p.acc & 0xffff;
              if ((slen ^ 0xffff) !== ((p.acc >>> 16) & 0xffff)) return fail();
              toSkip(slen, 1);
            }
            break;
          }
          case 1: {
            const z = chunk.indexOf(0, pos);
            if (z < 0) break loop;
            pos = z + 1;
            advanceHeader();
            break;
          }
          case 3: {
            const hdr = readBits(3);
            if (hdr < 0) break loop;
            p.bfinal = hdr & 1;
            const btype = hdr >>> 1;
            if (btype === 0) {
              bits.buf = bits.cnt = 0;
              toBytes(4, 2);
            } else if (btype === 1) {
              litTree = FIXED_LIT;
              distTree = FIXED_DIST;
              p.state = 8;
            } else if (btype === 2) p.state = 4;
            else return fail();
            break;
          }
          case 4: {
            const v = readBits(14);
            if (v < 0) break loop;
            dyn.nLit = (v & 0x1f) + 257;
            dyn.nDist = ((v >>> 5) & 0x1f) + 1;
            p.end = ((v >>> 10) & 0x0f) + 4;
            if (dyn.nLit > 286) return fail();
            clenLens.fill(0);
            p.idx = 0;
            p.state = 5;
            break;
          }
          case 5: {
            if (p.idx < p.end) {
              const cl = readBits(3);
              if (cl < 0) break loop;
              clenLens[CLEN_ORDER[p.idx++] as number] = cl;
              break;
            }
            if (!buildTree(clenLens, 0, 19, clenTree, 0)) return fail();
            p.idx = 0;
            p.end = dyn.nLit + dyn.nDist;
            p.state = 6;
            break;
          }
          case 6: {
            if (p.idx < p.end) {
              const sym = decode(clenTree);
              if (sym === NEED_MORE) break loop;
              if (sym < 0) return fail();
              if (sym < 16) codeLens[p.idx++] = sym;
              else {
                if (sym === 16 && p.idx === 0) return fail();
                p.mode = sym;
                p.state = 7;
              }
              break;
            }
            if (codeLens[256] === 0) return fail();
            if (!buildTree(codeLens, 0, dyn.nLit, dynLit, 1)) return fail();
            if (!buildTree(codeLens, dyn.nLit, dyn.nDist, dynDist, 2)) return fail();
            litTree = dynLit;
            distTree = dynDist;
            p.state = 8;
            break;
          }
          case 7: {
            const e = readBits(p.mode === 16 ? 2 : p.mode === 17 ? 3 : 7);
            if (e < 0) break loop;
            const c = (p.mode === 18 ? 11 : 3) + e;
            if (p.idx + c > p.end) return fail();
            codeLens.fill(p.mode === 16 ? (codeLens[p.idx - 1] as number) : 0, p.idx, p.idx + c);
            p.idx += c;
            p.state = 6;
            break;
          }
        }
      }
      return out(chunk);
    },
  };
}
