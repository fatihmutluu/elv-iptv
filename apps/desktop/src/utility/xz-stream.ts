import { createHash } from 'node:crypto';
import { openAsyncIterator } from '@elv/domain';
import { Lzma2Decoder, type XzByteReader } from './xz-lzma2.ts';

const XZ_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const XZ_FOOTER_MAGIC_0 = 0x59;
const XZ_FOOTER_MAGIC_1 = 0x5a;
const FILTER_ID_DELTA = 0x03;
const FILTER_ID_LZMA2 = 0x21;
/** Maximum LZMA2 dictionary size permitted (64 MiB) to bound memory on untrusted streams. */
export const MAX_XZ_DICT_BYTES = 64 * 1024 * 1024;
const MIN_XZ_DICT_BYTES = 4096;
const MAX_XZ_BLOCKS = 4_096;
const MAX_CONSECUTIVE_EMPTY_BLOCKS = 8;
const MAX_XZ_STREAM_PADDING_BYTES = 65_536;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
{
  const POLY = 0xc96c5795d7870f42n;
  for (let i = 0; i < 256; i++) {
    let c = BigInt(i);
    for (let k = 0; k < 8; k++) c = (c & 1n) !== 0n ? (c >> 1n) ^ POLY : c >> 1n;
    CRC64_LO[i] = Number(c & 0xffffffffn) >>> 0;
    CRC64_HI[i] = Number((c >> 32n) & 0xffffffffn) >>> 0;
  }
}

function crc32Update(crc: number, buf: Uint8Array, off = 0, len = buf.length - off): number {
  let c = crc >>> 0;
  const end = off + len;
  for (let i = off; i < end; i++) {
    c = (CRC32_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return c >>> 0;
}

function crc32Of(buf: Uint8Array, off = 0, len = buf.length - off): number {
  return (crc32Update(0xffffffff, buf, off, len) ^ 0xffffffff) >>> 0;
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (
    ((buf[off] as number) |
      ((buf[off + 1] as number) << 8) |
      ((buf[off + 2] as number) << 16) |
      ((buf[off + 3] as number) << 24)) >>>
    0
  );
}

interface CheckHasher {
  readonly size: number;
  update(chunk: Uint8Array): void;
  digest(): Uint8Array;
}

function createCheckHasher(checkType: number): CheckHasher {
  if (checkType === 0x00) {
    return { size: 0, update() {}, digest: () => new Uint8Array(0) };
  }
  if (checkType === 0x01) {
    let crc = 0xffffffff;
    return {
      size: 4,
      update(chunk) {
        crc = crc32Update(crc, chunk);
      },
      digest() {
        const v = (crc ^ 0xffffffff) >>> 0;
        return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
      },
    };
  }
  if (checkType === 0x04) {
    let lo = 0xffffffff;
    let hi = 0xffffffff;
    return {
      size: 8,
      update(chunk) {
        for (let i = 0; i < chunk.length; i++) {
          const idx = (lo ^ (chunk[i] as number)) & 0xff;
          lo = (((lo >>> 8) | (hi << 24)) ^ (CRC64_LO[idx] as number)) >>> 0;
          hi = ((hi >>> 8) ^ (CRC64_HI[idx] as number)) >>> 0;
        }
      },
      digest() {
        const outLo = ~lo >>> 0;
        const outHi = ~hi >>> 0;
        return new Uint8Array([
          outLo & 0xff,
          (outLo >>> 8) & 0xff,
          (outLo >>> 16) & 0xff,
          (outLo >>> 24) & 0xff,
          outHi & 0xff,
          (outHi >>> 8) & 0xff,
          (outHi >>> 16) & 0xff,
          (outHi >>> 24) & 0xff,
        ]);
      },
    };
  }
  if (checkType === 0x0a) {
    const hash = createHash('sha256');
    return {
      size: 32,
      update(chunk) {
        hash.update(chunk);
      },
      digest() {
        const d = hash.digest();
        return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      },
    };
  }
  throw new Error(`xz: unsupported check type 0x${checkType.toString(16)}`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

class AsyncByteReader implements XzByteReader {
  private readonly it: AsyncIterator<Uint8Array>;
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private eof = false;
  private closed = false;
  totalRead = 0;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.it = openAsyncIterator(chunks);
  }

  private async fill(): Promise<boolean> {
    while (this.pos >= this.buf.length) {
      if (this.eof) return false;
      const step = await this.it.next();
      if (step.done) {
        this.eof = true;
        return false;
      }
      if (step.value.length > 0) {
        this.buf = step.value;
        this.pos = 0;
        return true;
      }
    }
    return true;
  }

  async peekByte(): Promise<number | undefined> {
    if (!(await this.fill())) return undefined;
    return this.buf[this.pos];
  }

  async readByte(): Promise<number> {
    if (!(await this.fill())) throw new Error('xz: unexpected EOF');
    this.totalRead += 1;
    return this.buf[this.pos++] as number;
  }

  async readExact(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);
    if (this.pos + n <= this.buf.length) {
      const view = this.buf.subarray(this.pos, this.pos + n);
      this.pos += n;
      this.totalRead += n;
      return view;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      if (!(await this.fill())) throw new Error('xz: unexpected EOF');
      const avail = this.buf.length - this.pos;
      const take = Math.min(n - filled, avail);
      out.set(this.buf.subarray(this.pos, this.pos + take), filled);
      this.pos += take;
      filled += take;
      this.totalRead += take;
    }
    return out;
  }

  async readVarint(crcOut?: { crc: number }): Promise<number> {
    let val = 0n;
    for (let i = 0; i < 9; i++) {
      const b = await this.readByte();
      if (crcOut !== undefined) {
        crcOut.crc = (CRC32_TABLE[(crcOut.crc ^ b) & 0xff] as number) ^ (crcOut.crc >>> 8);
      }
      val |= BigInt(b & 0x7f) << BigInt(i * 7);
      if ((b & 0x80) === 0) {
        if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('xz: varint exceeds safe integer');
        }
        return Number(val);
      }
    }
    throw new Error('xz: invalid varint');
  }

  async close(): Promise<void> {
    if (this.closed || this.eof) return;
    this.closed = true;
    try {
      await this.it.return?.();
    } catch {
      // Upstream close errors ignored during teardown.
    }
  }
}

function parseVarintFromBuffer(buf: Uint8Array, posRef: { pos: number }, end: number): number {
  let val = 0n;
  for (let i = 0; i < 9; i++) {
    if (posRef.pos >= end) throw new Error('xz: truncated varint in block header');
    const b = buf[posRef.pos++] as number;
    val |= BigInt(b & 0x7f) << BigInt(i * 7);
    if ((b & 0x80) === 0) {
      if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('xz: varint exceeds safe integer');
      }
      return Number(val);
    }
  }
  throw new Error('xz: invalid varint in block header');
}

interface ParsedBlockHeader {
  readonly headerSize: number;
  readonly compressedSize: number | undefined;
  readonly uncompressedSize: number | undefined;
  readonly dictSize: number;
  readonly deltaDist: number | undefined;
}

async function readBlockHeader(
  reader: AsyncByteReader,
  encodedHeaderSize: number,
): Promise<ParsedBlockHeader> {
  const headerSize = (encodedHeaderSize + 1) * 4;
  const rest = await reader.readExact(headerSize - 1);
  const full = new Uint8Array(headerSize);
  full[0] = encodedHeaderSize;
  full.set(rest, 1);

  const expectedCrc = readU32LE(full, headerSize - 4);
  if (crc32Of(full, 0, headerSize - 4) !== expectedCrc) {
    throw new Error('xz: block header CRC32 mismatch');
  }

  const end = headerSize - 4;
  const flags = full[1] as number;
  if ((flags & 0x3c) !== 0) throw new Error('xz: unsupported block header flags');
  const numFilters = (flags & 0x03) + 1;
  const hasCompSize = (flags & 0x40) !== 0;
  const hasUncompSize = (flags & 0x80) !== 0;
  const posRef = { pos: 2 };

  const compressedSize = hasCompSize ? parseVarintFromBuffer(full, posRef, end) : undefined;
  const uncompressedSize = hasUncompSize ? parseVarintFromBuffer(full, posRef, end) : undefined;

  let dictSize: number | undefined;
  let deltaDist: number | undefined;
  for (let i = 0; i < numFilters; i++) {
    const filterId = parseVarintFromBuffer(full, posRef, end);
    const propsSize = parseVarintFromBuffer(full, posRef, end);
    if (posRef.pos + propsSize > end) throw new Error('xz: filter properties overflow header');
    const isLast = i === numFilters - 1;
    if (filterId === FILTER_ID_LZMA2) {
      if (!isLast || propsSize !== 1) throw new Error('xz: invalid LZMA2 filter placement');
      const prop = full[posRef.pos++] as number;
      if (prop > 40) throw new Error('xz: invalid LZMA2 dict property');
      dictSize = prop === 40 ? 0xffffffff : (2 | (prop & 1)) * 2 ** (Math.floor(prop / 2) + 11);
      if (dictSize > MAX_XZ_DICT_BYTES) {
        throw new Error(`xz: dictionary size ${dictSize} exceeds limit`);
      }
    } else if (filterId === FILTER_ID_DELTA) {
      if (isLast || propsSize !== 1 || deltaDist !== undefined) {
        throw new Error('xz: unsupported delta filter configuration');
      }
      deltaDist = (full[posRef.pos++] as number) + 1;
    } else {
      throw new Error(`xz: unsupported filter id 0x${filterId.toString(16)}`);
    }
  }
  if (dictSize === undefined) throw new Error('xz: missing LZMA2 filter');
  while (posRef.pos < end) {
    if (full[posRef.pos++] !== 0) throw new Error('xz: non-zero block header padding');
  }
  return { headerSize, compressedSize, uncompressedSize, dictSize, deltaDist };
}

/**
 * Clean-room streaming XZ (Format 1.0.4) + LZMA2 decompressor with CRC32, CRC64, SHA-256, and
 * None integrity verification, concatenated multi-stream + padding support, optional Delta filter,
 * bounded 64 MiB dictionary ceiling, and immediate upstream cancellation on early consumer `.return()`.
 */
export async function* unxzStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = new AsyncByteReader(chunks);
  let reusableDict: Uint8Array | undefined;
  const acquireDict = (size: number): Uint8Array => {
    if (reusableDict !== undefined && reusableDict.length === size) return reusableDict;
    reusableDict = new Uint8Array(size);
    return reusableDict;
  };
  try {
    let streamsDecoded = 0;
    let totalBlocks = 0;
    let consecutiveEmptyBlocks = 0;
    let totalStreamPadBytes = 0;
    for (;;) {
      const peek = await reader.peekByte();
      if (peek === undefined) {
        if (streamsDecoded === 0) throw new Error('xz: empty stream');
        return;
      }
      if (streamsDecoded > 0 && peek === 0x00) {
        let padBytes = 0;
        while ((await reader.peekByte()) === 0x00) {
          await reader.readByte();
          padBytes += 1;
          totalStreamPadBytes += 1;
          if (totalStreamPadBytes > MAX_XZ_STREAM_PADDING_BYTES) {
            throw new Error('xz: stream padding exceeds limit');
          }
        }
        if (padBytes % 4 !== 0) throw new Error('xz: unaligned stream padding');
        if ((await reader.peekByte()) === undefined) return;
      }

      const header = await reader.readExact(12);
      if (!bytesEqual(header.subarray(0, 6), XZ_MAGIC)) {
        throw new Error('xz: invalid stream header magic');
      }
      const flag0 = header[6] as number;
      const flag1 = header[7] as number;
      if (flag0 !== 0x00 || (flag1 & 0xf0) !== 0) {
        throw new Error('xz: unsupported stream flags');
      }
      if (crc32Of(header, 6, 2) !== readU32LE(header, 8)) {
        throw new Error('xz: stream header CRC32 mismatch');
      }
      const checkType = flag1 & 0x0f;
      createCheckHasher(checkType);

      const records: Array<{ unpaddedSize: number; uncompressedSize: number }> = [];
      for (;;) {
        const indicator = await reader.readByte();
        if (indicator === 0x00) break;

        totalBlocks += 1;
        if (totalBlocks > MAX_XZ_BLOCKS) throw new Error('xz: block count exceeds limit');

        const blockHdr = await readBlockHeader(reader, indicator);
        const check = createCheckHasher(checkType);
        const targetDictSize =
          blockHdr.uncompressedSize !== undefined
            ? Math.min(blockHdr.dictSize, Math.max(MIN_XZ_DICT_BYTES, blockHdr.uncompressedSize))
            : blockHdr.dictSize;
        const decoder = new Lzma2Decoder(targetDictSize, acquireDict);
        const deltaHistory = blockHdr.deltaDist !== undefined ? new Uint8Array(256) : undefined;
        let deltaPos = 0;
        const deltaDist = blockHdr.deltaDist ?? 0;

        const compStart = reader.totalRead;
        let uncompBytes = 0;
        for await (const rawSlice of decoder.decodeBlock(reader)) {
          let slice = rawSlice;
          if (deltaHistory !== undefined) {
            const decoded = new Uint8Array(rawSlice.length);
            for (let i = 0; i < rawSlice.length; i++) {
              const out =
                ((rawSlice[i] as number) +
                  (deltaHistory[(deltaPos - deltaDist) & 0xff] as number)) &
                0xff;
              deltaHistory[deltaPos] = out;
              deltaPos = (deltaPos + 1) & 0xff;
              decoded[i] = out;
            }
            slice = decoded;
          }
          check.update(slice);
          uncompBytes += slice.length;
          if (slice.length > 0) yield slice;
        }
        const compBytes = reader.totalRead - compStart;
        if (blockHdr.compressedSize !== undefined && compBytes !== blockHdr.compressedSize) {
          throw new Error('xz: block compressed size mismatch');
        }
        if (blockHdr.uncompressedSize !== undefined && uncompBytes !== blockHdr.uncompressedSize) {
          throw new Error('xz: block uncompressed size mismatch');
        }
        if (uncompBytes === 0) {
          consecutiveEmptyBlocks += 1;
          if (consecutiveEmptyBlocks > MAX_CONSECUTIVE_EMPTY_BLOCKS) {
            throw new Error('xz: too many consecutive empty blocks');
          }
        } else {
          consecutiveEmptyBlocks = 0;
        }

        const padLen = (4 - (compBytes % 4)) % 4;
        for (let i = 0; i < padLen; i++) {
          if ((await reader.readByte()) !== 0) throw new Error('xz: non-zero block padding');
        }

        const storedCheck = await reader.readExact(check.size);
        if (!bytesEqual(storedCheck, check.digest())) {
          throw new Error('xz: block check mismatch');
        }
        records.push({
          unpaddedSize: blockHdr.headerSize + compBytes + check.size,
          uncompressedSize: uncompBytes,
        });
      }

      const indexStart = reader.totalRead - 1;
      const indexCrc = { crc: (CRC32_TABLE[0xff] as number) ^ (0xffffffff >>> 8) };
      const numRecords = await reader.readVarint(indexCrc);
      if (numRecords !== records.length) throw new Error('xz: index record count mismatch');
      for (let i = 0; i < numRecords; i++) {
        const unpadded = await reader.readVarint(indexCrc);
        const uncomp = await reader.readVarint(indexCrc);
        const rec = records[i];
        if (rec === undefined || rec.unpaddedSize !== unpadded || rec.uncompressedSize !== uncomp) {
          throw new Error('xz: index record mismatch');
        }
      }
      const indexDataLen = reader.totalRead - indexStart;
      const indexPadLen = (4 - (indexDataLen % 4)) % 4;
      for (let i = 0; i < indexPadLen; i++) {
        const b = await reader.readByte();
        if (b !== 0) throw new Error('xz: non-zero index padding');
        indexCrc.crc = (CRC32_TABLE[(indexCrc.crc ^ b) & 0xff] as number) ^ (indexCrc.crc >>> 8);
      }
      const storedIndexCrc = readU32LE(await reader.readExact(4), 0);
      if ((indexCrc.crc ^ 0xffffffff) >>> 0 !== storedIndexCrc) {
        throw new Error('xz: index CRC32 mismatch');
      }
      const indexTotalSize = reader.totalRead - indexStart;

      const footer = await reader.readExact(12);
      if (footer[10] !== XZ_FOOTER_MAGIC_0 || footer[11] !== XZ_FOOTER_MAGIC_1) {
        throw new Error('xz: invalid stream footer magic');
      }
      if (crc32Of(footer, 4, 6) !== readU32LE(footer, 0)) {
        throw new Error('xz: stream footer CRC32 mismatch');
      }
      const backwardSize = (readU32LE(footer, 4) + 1) * 4;
      if (backwardSize !== indexTotalSize) {
        throw new Error('xz: stream footer backward size mismatch');
      }
      if (footer[8] !== flag0 || footer[9] !== flag1) {
        throw new Error('xz: stream footer flags mismatch');
      }
      streamsDecoded += 1;
    }
  } finally {
    await reader.close();
  }
}
