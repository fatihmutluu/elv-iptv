import { createHash } from 'node:crypto';
import { scanXmltv } from '@elv/sources';
import { describe, expect, it } from 'vitest';
import { createNodeGzipDecompressor } from './node-gzip-decompressor.ts';
import { MAX_XZ_DICT_BYTES, unxzStream } from './xz-stream.ts';

function fromBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function* chunked(data: Uint8Array, sizes: readonly number[]): AsyncGenerator<Uint8Array> {
  let off = 0;
  let idx = 0;
  while (off < data.length) {
    const sz = sizes[idx % sizes.length] ?? data.length;
    idx += 1;
    yield data.subarray(off, Math.min(data.length, off + sz));
    off += sz;
  }
}

async function drain(iter: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of iter) parts.push(c);
  return Buffer.concat(parts);
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

// Real XZ payloads generated via Python 3.12 stdlib `lzma` (Format 1.0.4)
const FIXTURES = {
  crc64: {
    plain: 'Hello XZ crc64!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! repeated text repeated text 1234567890',
    xz: '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4ABSAC9dACQZSZhvEBIFe7/1FVVsYzON7fa3P7unrl9jcQ1sCFwOY8XJVM7YcJCOVCSy3Hm/AABt61cp/oQurAABS1OrI2nBH7bzfQEAAAAABFla',
  },
  crc32: {
    plain: 'Hello XZ crc32!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! repeated text repeated text 1234567890',
    xz: '/Td6WFoAAAFpIt42AgAhARYAAAB0L+Wj4ABSAC9dACQZSZhvEBIFe7/1FVVnyNmagO3IQbs1et1SuqI10+CeRVLJXqmJA8CEUY4xp5zsAACSxhETAAFHU6ds3G2QQpkNAQAAAAABWVo=',
  },
  sha256: {
    plain: 'Hello XZ sha256!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! repeated text repeated text 1234567890',
    xz: '/Td6WFoAAArh+wyhAgAhARYAAAB0L+Wj4ABTADBdACQZSZhvEBIFe8CALo8GHns4v5hzllqmkJj3U+em80e1ZYDv7xgNglCphG7kXy0HgQAYeqJtkEFPL3h0coKlM/AnEk0RlBioX4ggwNGLr/9njQABZFRljhFNGJtLmgEAAAAAClla',
  },
  none: {
    plain: 'Hello XZ none!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! repeated text repeated text 1234567890',
    xz: '/Td6WFoAAAD/EtlBAgAhARYAAAB0L+Wj4ABRAC5dACQZSZhvEBIFe8BUyvffJf0VgWWQneuuOsIlbQRCY5fBP2AtTImQ7UUZokNwZIAAAAAAAUJSdKisZwZynnoBAAAAAABZWg==',
  },
  xmltv: {
    plainLen: 10690,
    plainSha256: '467d47eaa3c73a153e4c1c97ebe72e2ffc8143dd94b8ea62e646d0596e5192f1',
    xz: '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4CnBAmxdAB4Py4cR2M5mkQ+DHsr9ezPUf+m32igxdiVmIE0qCW1q9ylwODDnzB1WF8gtusj0ux96viMBDwloFnz6kwFWM14W9yoImAxv/Ozw6VDnBs7j2TchaZWGjrXcoS0VuaUWu193t5kLJWjQoBly5jLbGNpxjmE8uLVVtMgFi7fmLYW8mTOr4wJIwyyOdAHYA+2X4TXN+tHgKV93nRcDAS3Io3djoMAbfHongc/fZGqQCMbjreDs0nIqwGRJK8k1zXWbc9iJsQpTZjJayQxdn2c2mWzi+1M9buT0D9opIwTy68PRfPQwNhLh8BkVuF7jkb0CitiCsSeBzfZcNjeutfOKofKByAPW00zfxcH0WVE0+ltpjSYGb+GZpb8wUVn6n8OFMZ6SnLmm2JsOhYKPnn16BTFgejbOy/RJlx0MVczYbWrVazf8D1zOH4TKNT0He7a/rEy69FSGBkHF30lR5o0j2u5s7YzYZKEccQNzveK0LqcbWuRE3kP1y7imDgfFQi+rR6HHDvuG9VrKoazLU6DO4Sw/FirxNKYEz4o4lXqxeg+riVftMq4hFhYmP+fxUm2t3VROrITBPFHySHXn9vCs8N0rmJzBXFpMbqTi9+DWMJ80+rjyi9oVA2giDi+hIkzF+inlHhkzRpaSdF0mAc6IV1YncUQdklyXsaIWi8XW8N0ELWDhfcNI1I1KFaEGTG3BXuaTkk6rODYYkQq06N7ysW0oMI1BhHcC5WNJR3M6n9z+3ijiA6QG2308GSKBs+pFdIsTvg6/brTnGyHPCo7GAbAzdQbod65/NDc8SDpc7st4WPoM42og/mebnGUCAJK75NbGPRyAAAGIBcJTAAB8e+hLscRn+wIAAAAABFla',
  },
  concat: {
    plain:
      '<tv><channel id="1"><display-name>One</display-name></channel><channel id="2"><display-name>Two</display-name></channel></tv>',
    xz: '/Td6WFoAAAFpIt42AgAhARYAAAB0L+Wj4AA9ADNdAB4dCsPg978Q0cMd0om+3sQquGQyKL/mE/HQ3Os8xITYrnNWzfPSu/9Wjrj3MX46fcg7AAAA99IxywABSz5OPmrykEKZDQEAAAAAAVlaAAAAAP03elhaAAAE5ta0RgIAIQEWAAAAdC/lo+AAPgAzXQAeGMkGJB9HAsvqpq0V/hd+OrDNqdXbZX2J0WYZmDrBG5z1unmtmhx6qPJUc8gjGvJeQAAAAKW6r2Ez3/89AAFPP9zLAeEftvN9AQAAAAAEWVoAAAAA',
  },
  uncomp: {
    plainLen: 2048,
    plainSha256: 'cb16a90386170bd51549d77b216f6dc5b303f131e473ecca5530dd4d65daa2a1',
    xz: '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',
  },
  delta: {
    plainLen: 512,
    plainSha256: 'bd7f86fe64d3e62c5a4f664267563d57995661dc2029bd67eff9ee7c6272f869',
    xz: '/Td6WFoAAAFpIt42AgEDAQMhARS77n8S4AH/AAxdAAAA6oTiFoBUpfKrAABmyKVRAAEkgAQAAAA4tOxhPjANiwIAAAAAAVla',
  },
  empty: {
    plain: '',
    xz: '/Td6WFoAAATm1rRGAAAAABzfRCEftvN9AQAAAAAEWVo=',
  },
} as const;

describe('xz-stream & createNodeGzipDecompressor().unxz (EPG-1)', () => {
  it('decodes CRC64, CRC32, SHA-256, None, empty, uncompressed, Delta+LZMA2, and concatenated padded streams', async () => {
    expect(MAX_XZ_DICT_BYTES).toBe(64 * 1024 * 1024);
    const decompressor = createNodeGzipDecompressor();
    expect(decompressor.unxz).toBeTypeOf('function');

    for (const key of ['crc64', 'crc32', 'sha256', 'none', 'concat', 'empty'] as const) {
      const wire = fromBase64(FIXTURES[key].xz);
      for (const sizes of [[wire.length], [1, 1, 1], [3, 7, 11]]) {
        const out = await drain(
          decompressor.unxz?.(chunked(wire, sizes)) ?? unxzStream(chunked(wire, sizes)),
        );
        expect(out.toString('utf8')).toBe(FIXTURES[key].plain);
      }
    }

    for (const key of ['xmltv', 'uncomp', 'delta'] as const) {
      const wire = fromBase64(FIXTURES[key].xz);
      const out = await drain(unxzStream(chunked(wire, [17, 29, 64])));
      expect(out.length).toBe(FIXTURES[key].plainLen);
      expect(sha256Hex(out)).toBe(FIXTURES[key].plainSha256);
    }
  });

  it('streams a real .xml.xz guide end-to-end through scanXmltv and createNodeGzipDecompressor', async () => {
    const wire = fromBase64(FIXTURES.xmltv.xz);
    const channels: string[] = [];
    const programmes: string[] = [];
    const gen = scanXmltv(chunked(wire, [13, 31]), {
      decompressor: createNodeGzipDecompressor(),
    });
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value).toEqual({ ok: true, value: undefined });
        break;
      }
      for (const ch of step.value.channels) channels.push(ch.id);
      for (const p of step.value.programmes) programmes.push(p.title);
    }
    expect(channels).toHaveLength(40);
    expect(channels[0]).toBe('ch0');
    // Fixture index 23 wraps stop hour to 00:00 (stop < start), so scanXmltv drops that 1 invalid programme
    expect(programmes).toHaveLength(39);
    expect(programmes.at(-1)).toBe('Show Number 39');
  });

  it('rejects truncated, bit-flipped checksum, trailing garbage, and oversized dictionary streams', async () => {
    const valid = fromBase64(FIXTURES.crc64.xz);

    // Truncated mid-stream
    await expect(
      drain(unxzStream(chunked(valid.subarray(0, valid.length - 6), [16]))),
    ).rejects.toThrow();

    // Bit-flipped CRC64 block check
    const badCheck = new Uint8Array(valid);
    badCheck[badCheck.length - 28] = (badCheck[badCheck.length - 28] as number) ^ 0xff;
    await expect(drain(unxzStream(chunked(badCheck, [32])))).rejects.toThrow();

    // Trailing non-zero garbage after valid stream
    const trailingGarbage = Buffer.concat([valid, Buffer.from([0x01, 0x02, 0x03, 0x04])]);
    await expect(drain(unxzStream(chunked(trailingGarbage, [64])))).rejects.toThrow();

    // Unaligned trailing NUL padding (2 bytes instead of multiple of 4)
    const unalignedPad = Buffer.concat([valid, Buffer.from([0x00, 0x00])]);
    await expect(drain(unxzStream(chunked(unalignedPad, [64])))).rejects.toThrow();

    // Oversized LZMA2 dictionary (> 64 MiB: prop 40 = 4 GiB) crafted block header with valid CRC32
    const streamHeader = valid.subarray(0, 12);
    // Block header: size=2 -> (2+1)*4 = 12 bytes: [0x02, flags=0x00 (1 filter), id=0x21, propSize=0x01, prop=40, pad 0,0,0, crc32(4)]
    const hdrBody = new Uint8Array([0x02, 0x00, 0x21, 0x01, 40, 0x00, 0x00, 0x00]);
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of hdrBody) crc = (crcTable[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const hugeDictStream = Buffer.concat([
      streamHeader,
      hdrBody,
      Buffer.from([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff]),
    ]);
    await expect(drain(unxzStream(chunked(hugeDictStream, [32])))).rejects.toThrow(
      /dictionary size/i,
    );
  });

  it('cancels upstream iterator cleanly on early consumer return()', async () => {
    const wire = fromBase64(FIXTURES.xmltv.xz);
    let closed = false;
    async function* slowSource(): AsyncGenerator<Uint8Array> {
      try {
        yield wire;
        for (;;) {
          yield new Uint8Array([0x00, 0x00, 0x00, 0x00]);
        }
      } finally {
        closed = true;
      }
    }
    const it = unxzStream(slowSource())[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value.length).toBeGreaterThan(0);
    await it.return?.(undefined);
    expect(closed).toBe(true);
  });

  it('rejects 20 consecutive empty 64 MiB-dict blocks without allocating gigabytes and bounds stream padding (B3)', async () => {
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
    const crc32Buf = (data: Uint8Array): Buffer => {
      let c = 0xffffffff;
      for (const b of data) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
      c = (c ^ 0xffffffff) >>> 0;
      return Buffer.from([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]);
    };

    // Stream Header with CHECK_NONE (0x00)
    const flags = new Uint8Array([0x00, 0x00]);
    const streamHeader = Buffer.concat([
      Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      flags,
      crc32Buf(flags),
    ]);
    // Empty block declaring 64 MiB dict (prop = 28 -> (2 | 0) << (14 + 11) = 64 MiB), LZMA2 EOP (0x00), 3 pad bytes
    const hdrBody = new Uint8Array([0x02, 0x00, 0x21, 0x01, 28, 0x00, 0x00, 0x00]);
    const emptyBlock = Buffer.concat([
      hdrBody,
      crc32Buf(hdrBody),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);
    const twentyEmptyBlocks = Buffer.concat([
      streamHeader,
      ...Array.from({ length: 20 }, () => emptyBlock),
    ]);
    const startMs = Date.now();
    await expect(drain(unxzStream(chunked(twentyEmptyBlocks, [64])))).rejects.toThrow(
      /empty blocks/i,
    );
    expect(Date.now() - startMs).toBeLessThan(2_000);

    // > 64 KiB of trailing 0x00 stream padding fails fast
    const valid = fromBase64(FIXTURES.crc64.xz);
    async function* infiniteTrailingZeros(): AsyncGenerator<Uint8Array> {
      yield valid;
      const zeros = new Uint8Array(4096);
      for (;;) yield zeros;
    }
    await expect(drain(unxzStream(infiniteTrailingZeros()))).rejects.toThrow(/padding/i);
  });
});
