import { describe, expect, it } from 'vitest';
import { createGzipMemberFramer } from './gzip-member-splitter';
import { randomSplits, utf8 } from './test-chunks';
import { gzip } from './xmltv-test-helpers';

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC32_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

class BitWriter {
  private bytes: number[] = [];
  private buf = 0;
  private cnt = 0;

  writeLsb(val: number, bits: number): void {
    for (let i = 0; i < bits; i++) {
      this.buf |= ((val >>> i) & 1) << this.cnt++;
      if (this.cnt === 8) {
        this.bytes.push(this.buf);
        this.buf = 0;
        this.cnt = 0;
      }
    }
  }

  writeMsb(val: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.buf |= ((val >>> i) & 1) << this.cnt++;
      if (this.cnt === 8) {
        this.bytes.push(this.buf);
        this.buf = 0;
        this.cnt = 0;
      }
    }
  }

  align(): void {
    if (this.cnt > 0) {
      this.bytes.push(this.buf);
      this.buf = 0;
      this.cnt = 0;
    }
  }

  writeByte(b: number): void {
    this.align();
    this.bytes.push(b & 0xff);
  }

  finish(): Uint8Array {
    this.align();
    return new Uint8Array(this.bytes);
  }
}

interface HeaderFlags {
  fextra?: Uint8Array;
  fname?: string;
  fcomment?: string;
  fhcrc?: boolean;
  ftext?: boolean;
}

function buildGzipMember(
  deflate: Uint8Array,
  plain: Uint8Array,
  flags: HeaderFlags = {},
): Uint8Array {
  let flg = 0;
  if (flags.ftext) flg |= 0x01;
  if (flags.fhcrc) flg |= 0x02;
  if (flags.fextra !== undefined) flg |= 0x04;
  if (flags.fname !== undefined) flg |= 0x08;
  if (flags.fcomment !== undefined) flg |= 0x10;

  const hdrParts: Uint8Array[] = [new Uint8Array([0x1f, 0x8b, 0x08, flg, 0, 0, 0, 0, 0, 0xff])];
  if (flags.fextra !== undefined) {
    const xlen = flags.fextra.length;
    hdrParts.push(new Uint8Array([xlen & 0xff, (xlen >>> 8) & 0xff]), flags.fextra);
  }
  if (flags.fname !== undefined) hdrParts.push(utf8(flags.fname), new Uint8Array([0]));
  if (flags.fcomment !== undefined) hdrParts.push(utf8(flags.fcomment), new Uint8Array([0]));
  let hdr = concatBytes(hdrParts);
  if (flags.fhcrc) {
    const hc = crc32(hdr) & 0xffff;
    hdr = concatBytes([hdr, new Uint8Array([hc & 0xff, (hc >>> 8) & 0xff])]);
  }
  const c = crc32(plain);
  const sz = plain.length >>> 0;
  const trailer = new Uint8Array([
    c & 0xff,
    (c >>> 8) & 0xff,
    (c >>> 16) & 0xff,
    (c >>> 24) & 0xff,
    sz & 0xff,
    (sz >>> 8) & 0xff,
    (sz >>> 16) & 0xff,
    (sz >>> 24) & 0xff,
  ]);
  return concatBytes([hdr, deflate, trailer]);
}

function buildStoredMember(blocks: readonly Uint8Array[], flags?: HeaderFlags): Uint8Array {
  const bw = new BitWriter();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as Uint8Array;
    bw.writeLsb(i === blocks.length - 1 ? 1 : 0, 1);
    bw.writeLsb(0, 2);
    bw.align();
    const len = b.length;
    const nlen = len ^ 0xffff;
    bw.writeByte(len & 0xff);
    bw.writeByte((len >>> 8) & 0xff);
    bw.writeByte(nlen & 0xff);
    bw.writeByte((nlen >>> 8) & 0xff);
    for (let j = 0; j < b.length; j++) bw.writeByte(b[j] as number);
  }
  return buildGzipMember(bw.finish(), concatBytes(blocks), flags);
}

function buildFixedHuffmanMember(flags?: HeaderFlags): { member: Uint8Array; plain: Uint8Array } {
  const bw = new BitWriter();
  // bfinal=1, btype=1 (fixed Huffman)
  bw.writeLsb(1, 1);
  bw.writeLsb(1, 2);
  // Write 10 distinct literals ('A'..'J'), then length+distance backreference with extra bits
  const plainBytes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const ch = 65 + i;
    plainBytes.push(ch);
    bw.writeMsb(0x30 + ch, 8);
  }
  // Literal > 143 (9-bit fixed code: 0x190 + (200 - 144))
  plainBytes.push(200);
  bw.writeMsb(0x190 + (200 - 144), 9);
  // Length 3 (sym 257, 0 extra bits) + distance 1 (code 0, 0 extra bits)
  bw.writeMsb(257 - 256, 7);
  bw.writeMsb(0, 5);
  for (let i = 0; i < 3; i++) plainBytes.push(plainBytes[plainBytes.length - 1] as number);
  // Length 19 (sym 268, 1 extra bit = 0) + distance 10 (code 6, 2 extra bits = 1)
  bw.writeMsb(268 - 256, 7);
  bw.writeLsb(0, 1);
  bw.writeMsb(6, 5);
  bw.writeLsb(1, 2);
  for (let i = 0; i < 19; i++) plainBytes.push(plainBytes[plainBytes.length - 10] as number);
  // Length 258 (sym 285, 8-bit fixed code 0xc5, 0 extra bits) + distance 1 (code 0)
  bw.writeMsb(0xc0 + (285 - 280), 8);
  bw.writeMsb(0, 5);
  for (let i = 0; i < 258; i++) plainBytes.push(plainBytes[plainBytes.length - 1] as number);
  // EOB 256 (7-bit code 0)
  bw.writeMsb(0, 7);
  const plain = new Uint8Array(plainBytes);
  return { member: buildGzipMember(bw.finish(), plain, flags), plain };
}

function feedSplit(
  input: Uint8Array,
  chunkSizes: readonly number[],
): { taken: Uint8Array; rest: Uint8Array | undefined; done: boolean; invalid: boolean } {
  const framer = createGzipMemberFramer();
  const taken: Uint8Array[] = [];
  let at = 0;
  let idx = 0;
  let rest: Uint8Array | undefined;
  let done = false;
  let invalid = false;

  while (at < input.length) {
    const size = chunkSizes[idx % chunkSizes.length] as number;
    idx++;
    const slice = input.subarray(at, Math.min(input.length, at + size));
    at += slice.length;
    const r = framer.feed(slice);
    if (r.take.length > 0) taken.push(r.take);
    if (r.invalid) {
      invalid = true;
      break;
    }
    if (r.done) {
      done = true;
      rest = r.rest
        ? concatBytes([r.rest, input.subarray(at)])
        : at < input.length
          ? input.subarray(at)
          : undefined;
      break;
    }
  }
  return { taken: concatBytes(taken), rest, done, invalid };
}

describe('createGzipMemberFramer', () => {
  it('frames stored blocks (empty, single, multi-block) and all RFC 1952 header flags across 1-byte chunks', () => {
    const trailing = utf8('NEXT_BYTES');
    const emptyStored = buildStoredMember([new Uint8Array(0)], {
      fextra: new Uint8Array(0),
      ftext: true,
    });
    const multiStored = buildStoredMember([utf8('hello '), utf8('stored world!')], {
      fextra: utf8('ABCD'),
      fname: 'epg.xml',
      fcomment: 'xmltv guide',
      fhcrc: true,
    });

    for (const member of [emptyStored, multiStored]) {
      const combined = concatBytes([member, trailing]);
      for (const sizes of [[combined.length], [1], [2, 3, 5]]) {
        const res = feedSplit(combined, sizes);
        expect(res.done).toBe(true);
        expect(res.invalid).toBe(false);
        expect(res.taken).toEqual(member);
        expect(res.rest).toEqual(trailing);
      }
    }
  });

  it('frames fixed Huffman (BTYPE=1) blocks with literal, length, and distance extra bits at every split', () => {
    const { member } = buildFixedHuffmanMember({ fname: 'fixed.bin', fhcrc: true });
    const trailing = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const combined = concatBytes([member, trailing]);

    for (const sizes of [[combined.length], [1], [3, 1, 7]]) {
      const res = feedSplit(combined, sizes);
      expect(res.done).toBe(true);
      expect(res.invalid).toBe(false);
      expect(res.taken).toEqual(member);
      expect(res.rest).toEqual(trailing);
    }
  });

  it('frames real dynamic Huffman (BTYPE=2) gzip streams across whole, 1-byte, and random splits', async () => {
    const payload = utf8(
      Array.from(
        { length: 400 },
        (_, i) =>
          `<programme start="20260101000000" channel="ch${i % 12}"><title>Show ${i}</title></programme>\n`,
      ).join(''),
    );
    const member = await gzip(payload);
    // Confirm CompressionStream actually emitted a BTYPE=2 dynamic Huffman block
    expect(((member[10] as number) >>> 1) & 3).toBe(2);

    const trailing = utf8('TAIL');
    const combined = concatBytes([member, trailing]);
    for (const sizes of [[combined.length], [1], [2, 5, 11]]) {
      const res = feedSplit(combined, sizes);
      expect(res.done).toBe(true);
      expect(res.invalid).toBe(false);
      expect(res.taken).toEqual(member);
      expect(res.rest).toEqual(trailing);
    }

    const framer = createGzipMemberFramer();
    const pieces: Uint8Array[] = [];
    let rest: Uint8Array | undefined;
    let done = false;
    for await (const c of randomSplits(combined, 1337, 17)) {
      if (done) {
        rest = rest ? concatBytes([rest, c]) : c;
        continue;
      }
      const r = framer.feed(c);
      if (r.take.length > 0) pieces.push(r.take);
      expect(r.invalid).toBe(false);
      if (r.done) {
        done = true;
        rest = r.rest;
      }
    }
    expect(done).toBe(true);
    expect(concatBytes(pieces)).toEqual(member);
    expect(rest).toEqual(trailing);
  });

  it('frames empty dynamic Huffman block (single-symbol litTree + empty distTree) and repeat codes 16/17/18', () => {
    // Complete clenTree: sym 0, 1, 16, 18 all length 2 -> canonical codes 0='00', 1='01', 16='10', 18='11'
    const bw = new BitWriter();
    bw.writeLsb(1, 1);
    bw.writeLsb(2, 2);
    bw.writeLsb(0, 5); // nLit = 257
    bw.writeLsb(0, 5); // nDist = 1
    bw.writeLsb(14, 4); // nClen = 18 (covers CLEN_ORDER[17] = sym 1)
    const clenLens = new Array<number>(18).fill(0);
    clenLens[0] = 2; // sym 16
    clenLens[2] = 2; // sym 18
    clenLens[3] = 2; // sym 0
    clenLens[17] = 2; // sym 1
    for (const l of clenLens) bw.writeLsb(l, 3);
    // 138 zeros (sym 18) + 115 zeros (sym 18) + 3 zeros (sym 16) = 256 zeros
    bw.writeMsb(3, 2);
    bw.writeLsb(127, 7);
    bw.writeMsb(3, 2);
    bw.writeLsb(104, 7);
    bw.writeMsb(2, 2);
    bw.writeLsb(0, 2);
    // lit 256 -> len 1 (single-symbol litTree), dist 0 -> len 0 (empty distTree)
    bw.writeMsb(1, 2);
    bw.writeMsb(0, 2);
    // Emit lit 256 -> single-symbol code '0' (1 bit)
    bw.writeMsb(0, 1);

    const member = buildGzipMember(bw.finish(), new Uint8Array(0));
    const res = feedSplit(concatBytes([member, utf8('OK')]), [1]);
    expect(res.done).toBe(true);
    expect(res.invalid).toBe(false);
    expect(res.taken).toEqual(member);
    expect(res.rest).toEqual(utf8('OK'));
  });

  it('handles empty chunks, post-done calls, and post-invalid calls gracefully', () => {
    const member = buildStoredMember([utf8('hi')]);
    const framer = createGzipMemberFramer();
    expect(framer.feed(new Uint8Array(0))).toEqual({
      take: new Uint8Array(0),
      rest: undefined,
      done: false,
      invalid: false,
    });
    const rDone = framer.feed(member);
    expect(rDone.done).toBe(true);
    expect(rDone.rest).toBeUndefined();
    const afterEmpty = framer.feed(new Uint8Array(0));
    expect(afterEmpty).toEqual({
      take: new Uint8Array(0),
      rest: undefined,
      done: true,
      invalid: false,
    });
    const afterExtra = framer.feed(utf8('more'));
    expect(afterExtra).toEqual({
      take: new Uint8Array(0),
      rest: utf8('more'),
      done: true,
      invalid: false,
    });

    const badFramer = createGzipMemberFramer();
    const rBad1 = badFramer.feed(new Uint8Array([0x00, 0x01]));
    expect(rBad1.invalid).toBe(true);
    expect(rBad1.take).toEqual(new Uint8Array([0x00, 0x01]));
    const rBad2 = badFramer.feed(utf8('passthrough'));
    expect(rBad2.invalid).toBe(true);
    expect(rBad2.take).toEqual(utf8('passthrough'));
  });

  it('flags invalid RFC 1952 headers and RFC 1951 blocks as invalid: true', () => {
    const expectInvalid = (bytes: Uint8Array) => {
      const r = feedSplit(bytes, [1]);
      expect(r.invalid).toBe(true);
      expect(r.done).toBe(false);
    };

    // Bad ID1, ID2, CM, reserved FLG bits (0xe0)
    expectInvalid(new Uint8Array([0x00, 0x8b, 0x08, 0x00]));
    expectInvalid(new Uint8Array([0x1f, 0x00, 0x08, 0x00]));
    expectInvalid(new Uint8Array([0x1f, 0x8b, 0x09, 0x00]));
    expectInvalid(new Uint8Array([0x1f, 0x8b, 0x08, 0x20]));

    // Reserved BTYPE=3
    const btype3 = buildGzipMember(new Uint8Array([0x07]), new Uint8Array(0));
    expectInvalid(btype3);

    // Stored block with bad NLEN
    const badStored = buildGzipMember(
      new Uint8Array([0x01, 0x02, 0x00, 0x00, 0x00, 0x41, 0x42]),
      new Uint8Array(0),
    );
    expectInvalid(badStored);

    // Fixed Huffman invalid literal symbol 286 (8-bit code 0xc6)
    const bwBadLit = new BitWriter();
    bwBadLit.writeLsb(1, 1);
    bwBadLit.writeLsb(1, 2);
    bwBadLit.writeMsb(0xc0 + (286 - 280), 8);
    expectInvalid(buildGzipMember(bwBadLit.finish(), new Uint8Array(0)));

    // Fixed Huffman invalid distance symbol 30 (after length 257)
    const bwBadDist = new BitWriter();
    bwBadDist.writeLsb(1, 1);
    bwBadDist.writeLsb(1, 2);
    bwBadDist.writeMsb(257 - 256, 7);
    bwBadDist.writeMsb(30, 5);
    expectInvalid(buildGzipMember(bwBadDist.finish(), new Uint8Array(0)));

    // Dynamic Huffman: HLIT > 286 (HLIT = 30 -> nLit = 287)
    const bwBadHlit = new BitWriter();
    bwBadHlit.writeLsb(1, 1);
    bwBadHlit.writeLsb(2, 2);
    bwBadHlit.writeLsb(30, 5);
    bwBadHlit.writeLsb(0, 5);
    bwBadHlit.writeLsb(0, 4);
    expectInvalid(buildGzipMember(bwBadHlit.finish(), new Uint8Array(0)));

    // Dynamic Huffman: oversubscribed clen tree (three symbols with length 1)
    const bwOverClen = new BitWriter();
    bwOverClen.writeLsb(1, 1);
    bwOverClen.writeLsb(2, 2);
    bwOverClen.writeLsb(0, 5);
    bwOverClen.writeLsb(0, 5);
    bwOverClen.writeLsb(0, 4); // nClen = 4
    bwOverClen.writeLsb(1, 3);
    bwOverClen.writeLsb(1, 3);
    bwOverClen.writeLsb(1, 3);
    bwOverClen.writeLsb(0, 3);
    expectInvalid(buildGzipMember(bwOverClen.finish(), new Uint8Array(0)));

    // Dynamic Huffman: incomplete clen tree (only 1 symbol of length 1)
    const bwIncClen = new BitWriter();
    bwIncClen.writeLsb(1, 1);
    bwIncClen.writeLsb(2, 2);
    bwIncClen.writeLsb(0, 5);
    bwIncClen.writeLsb(0, 5);
    bwIncClen.writeLsb(0, 4);
    bwIncClen.writeLsb(1, 3);
    bwIncClen.writeLsb(0, 3);
    bwIncClen.writeLsb(0, 3);
    bwIncClen.writeLsb(0, 3);
    expectInvalid(buildGzipMember(bwIncClen.finish(), new Uint8Array(0)));

    // Dynamic Huffman: repeat code 16 at index 0
    const bwRep0 = new BitWriter();
    bwRep0.writeLsb(1, 1);
    bwRep0.writeLsb(2, 2);
    bwRep0.writeLsb(0, 5);
    bwRep0.writeLsb(0, 5);
    bwRep0.writeLsb(0, 4); // nClen = 4: [16, 17, 18, 0]
    bwRep0.writeLsb(1, 3); // sym 16 -> len 1 ('0')
    bwRep0.writeLsb(1, 3); // sym 17 -> len 1 ('1')
    bwRep0.writeLsb(0, 3);
    bwRep0.writeLsb(0, 3);
    bwRep0.writeMsb(0, 1); // sym 16 at dynIdx=0 -> invalid!
    expectInvalid(buildGzipMember(bwRep0.finish(), new Uint8Array(0)));

    // Dynamic Huffman: repeat code 18 overflowing nLit + nDist (258)
    const bwRepOver = new BitWriter();
    bwRepOver.writeLsb(1, 1);
    bwRepOver.writeLsb(2, 2);
    bwRepOver.writeLsb(0, 5); // 257
    bwRepOver.writeLsb(0, 5); // 1 -> total 258
    bwRepOver.writeLsb(0, 4); // [16, 17, 18, 0]
    bwRepOver.writeLsb(0, 3);
    bwRepOver.writeLsb(1, 3); // sym 17 -> '0'
    bwRepOver.writeLsb(1, 3); // sym 18 -> '1'
    bwRepOver.writeLsb(0, 3);
    // 138 + 138 = 276 > 258 -> overflow!
    bwRepOver.writeMsb(1, 1);
    bwRepOver.writeLsb(127, 7);
    bwRepOver.writeMsb(1, 1);
    bwRepOver.writeLsb(127, 7);
    expectInvalid(buildGzipMember(bwRepOver.finish(), new Uint8Array(0)));

    // Dynamic Huffman: missing EOB symbol 256 (all 258 code lengths = 0 via 18 + 18)
    const bwNoEob = new BitWriter();
    bwNoEob.writeLsb(1, 1);
    bwNoEob.writeLsb(2, 2);
    bwNoEob.writeLsb(0, 5);
    bwNoEob.writeLsb(0, 5);
    bwNoEob.writeLsb(0, 4);
    bwNoEob.writeLsb(0, 3);
    bwNoEob.writeLsb(1, 3); // sym 17 -> '0'
    bwNoEob.writeLsb(1, 3); // sym 18 -> '1'
    bwNoEob.writeLsb(0, 3);
    bwNoEob.writeMsb(1, 1);
    bwNoEob.writeLsb(127, 7); // 138
    bwNoEob.writeMsb(1, 1);
    bwNoEob.writeLsb(109, 7); // 120 -> total 258 zeros (codeLens[256] === 0!)
    expectInvalid(buildGzipMember(bwNoEob.finish(), new Uint8Array(0)));

    // Dynamic Huffman: backreference when distTree is empty (maxLen === 0)
    const bwEmptyDist = new BitWriter();
    bwEmptyDist.writeLsb(1, 1);
    bwEmptyDist.writeLsb(2, 2);
    bwEmptyDist.writeLsb(1, 5); // nLit = 258 (includes 257)
    bwEmptyDist.writeLsb(0, 5); // nDist = 1
    bwEmptyDist.writeLsb(14, 4); // nClen = 18
    const cl2 = new Array<number>(18).fill(0);
    cl2[0] = 2; // sym 16
    cl2[2] = 2; // sym 18
    cl2[3] = 2; // sym 0
    cl2[17] = 2; // sym 1
    for (const l of cl2) bwEmptyDist.writeLsb(l, 3);
    // 256 zeros: 138 + 115 + 3 (via 16)
    bwEmptyDist.writeMsb(3, 2);
    bwEmptyDist.writeLsb(127, 7);
    bwEmptyDist.writeMsb(3, 2);
    bwEmptyDist.writeLsb(104, 7);
    bwEmptyDist.writeMsb(2, 2);
    bwEmptyDist.writeLsb(0, 2);
    // lit 256 -> len 1 ('0'), lit 257 -> len 1 ('1')
    bwEmptyDist.writeMsb(1, 2);
    bwEmptyDist.writeMsb(1, 2);
    // dist 0 -> len 0 (empty distTree)
    bwEmptyDist.writeMsb(0, 2);
    // Emit lit 257 ('1') -> tries to decode from empty distTree -> invalid!
    bwEmptyDist.writeMsb(1, 1);
    expectInvalid(buildGzipMember(bwEmptyDist.finish(), new Uint8Array(0)));
  });
});
