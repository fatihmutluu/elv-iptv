import type { Decompressor } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  decodeMaybeGzip,
  type GzipStreamOptions,
} from './gzip-stream';
import { chunksOf, randomSplits, utf8 } from './test-chunks';
import { gunzipper, gzip } from './xmltv-test-helpers';

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function collectDecoded(
  chunks: AsyncIterable<Uint8Array>,
  opts?: GzipStreamOptions,
  delayMs = 0,
) {
  const out: Uint8Array[] = [];
  const gen = decodeMaybeGzip(chunks, opts);
  for (;;) {
    const step = await gen.next();
    if (step.done) return { chunks: out, bytes: concatBytes(out), result: step.value };
    out.push(step.value);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** Real streaming Web `DecompressionStream('gzip')` (single-member, lazy pull with backpressure). */
const streamingWebGunzipper: Decompressor = {
  async *gunzip(chunks) {
    const it = chunks[Symbol.asyncIterator]();
    let closed = false;
    const readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(controller) {
        try {
          const step = await it.next();
          if (step.done) {
            closed = true;
            controller.close();
          } else {
            controller.enqueue(step.value as Uint8Array<ArrayBuffer>);
          }
        } catch (e) {
          closed = true;
          controller.error(e);
        }
      },
      async cancel() {
        if (!closed) {
          closed = true;
          await it.return?.();
        }
      },
    });
    const reader = readable.pipeThrough(new DecompressionStream('gzip')).getReader();
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) return;
        yield step.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      if (!closed) {
        closed = true;
        await it.return?.();
      }
    }
  },
};

describe('decodeMaybeGzip', () => {
  it('exports DEFAULT_MAX_DECOMPRESSED_BYTES as 256 MiB', () => {
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(256 * 1024 * 1024);
  });

  it('replays non-gzip chunks unchanged with zero copies across empty, 1-byte, and split inputs', async () => {
    const c1 = new Uint8Array([0x1f]);
    const c2 = utf8('not-gzip');
    const c3 = utf8(' tail');
    async function* plain(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(0);
      yield c1;
      yield new Uint8Array(0);
      yield c2;
      yield c3;
    }
    const r = await collectDecoded(plain(), { decompressor: gunzipper });
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.chunks[0]).toBe(c1);
    expect(r.chunks[1]).toBe(c2);
    expect(r.chunks[2]).toBe(c3);

    const empty = await collectDecoded(chunksOf(new Uint8Array(0), []), {
      decompressor: gunzipper,
    });
    expect(empty.result).toEqual({ ok: true, value: undefined });
    expect(empty.bytes.length).toBe(0);

    const one = await collectDecoded(chunksOf(new Uint8Array([0x1f]), [1]), {
      decompressor: gunzipper,
    });
    expect(one.result).toEqual({ ok: true, value: undefined });
    expect(one.bytes).toEqual(new Uint8Array([0x1f]));
  });

  it('closes upstream and returns gzip-unsupported when no decompressor is supplied', async () => {
    const gz = await gzip(utf8('hello'));
    let closed = false;
    async function* src(): AsyncGenerator<Uint8Array> {
      try {
        yield gz.subarray(0, 1);
        yield gz.subarray(1, 2);
        yield gz.subarray(2);
      } finally {
        closed = true;
      }
    }
    const r = await collectDecoded(src());
    expect(r.chunks).toEqual([]);
    expect(r.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-unsupported' },
    });
    expect(closed).toBe(true);
  });

  it('enforces maxDecompressedBytes ceiling immediately and closes both decompressor and upstream', async () => {
    const exact = utf8('a'.repeat(100));
    const gzExact = await gzip(exact);
    const okRes = await collectDecoded(chunksOf(gzExact, [gzExact.length]), {
      decompressor: gunzipper,
      maxDecompressedBytes: 100,
    });
    expect(okRes.result).toEqual({ ok: true, value: undefined });
    expect(okRes.bytes).toEqual(exact);

    let upstreamClosed = false;
    let decompressorClosed = false;
    let yieldedFromBomb = 0;
    async function* bombSource(): AsyncGenerator<Uint8Array> {
      try {
        yield new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
        for (;;) {
          yield new Uint8Array(64);
        }
      } finally {
        upstreamClosed = true;
      }
    }
    const bombDecompressor: Decompressor = {
      async *gunzip(chunks) {
        const it = chunks[Symbol.asyncIterator]();
        try {
          await it.next();
          for (;;) {
            yieldedFromBomb++;
            yield new Uint8Array(400);
          }
        } finally {
          decompressorClosed = true;
        }
      },
    };
    const bombRes = await collectDecoded(bombSource(), {
      decompressor: bombDecompressor,
      maxDecompressedBytes: 1000,
    });
    expect(bombRes.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
    expect(bombRes.bytes.length).toBe(800);
    expect(yieldedFromBomb).toBe(3);
    expect(decompressorClosed).toBe(true);
    expect(upstreamClosed).toBe(true);
  });

  it('enforces cumulative maxDecompressedBytes across concatenated gzip members', async () => {
    const m1 = await gzip(utf8('x'.repeat(600)));
    const m2 = await gzip(utf8('y'.repeat(600)));
    const combined = concatBytes([m1, m2]);
    const r = await collectDecoded(chunksOf(combined, [64]), {
      decompressor: gunzipper,
      maxDecompressedBytes: 1000,
    });
    expect(r.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
  });

  it('decodes multi-member concatenated gzip with single-member gunzipper across chunk sizes', async () => {
    const p1 = utf8('<tv><channel id="1"><display-name>One</display-name></channel>');
    const p2 = utf8('<channel id="2"><display-name>Two</display-name></channel>');
    const p3 = utf8(
      '<programme start="20260101000000" channel="1"><title>Hi</title></programme></tv>',
    );
    const combined = concatBytes([await gzip(p1), await gzip(p2), await gzip(p3)]);
    const expected = concatBytes([p1, p2, p3]);

    for (const sizes of [[combined.length], [1, 1, 1], [2, 5, 7], [13, 29]]) {
      const r = await collectDecoded(chunksOf(combined, sizes), { decompressor: gunzipper });
      expect(r.result).toEqual({ ok: true, value: undefined });
      expect(r.bytes).toEqual(expected);
    }
    const rand = await collectDecoded(randomSplits(combined, 42, 19), { decompressor: gunzipper });
    expect(rand.result).toEqual({ ok: true, value: undefined });
    expect(rand.bytes).toEqual(expected);
  });

  it('decodes concatenated stored (BTYPE=0), fixed (BTYPE=1), and dynamic (BTYPE=2) members with all RFC 1952 header flags across 1-byte chunks', async () => {
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
    const crc32 = (data: Uint8Array): number => {
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) {
        c = (crcTable[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const trailerOf = (plain: Uint8Array): Uint8Array => {
      const c = crc32(plain);
      const sz = plain.length >>> 0;
      return new Uint8Array([
        c & 0xff,
        (c >>> 8) & 0xff,
        (c >>> 16) & 0xff,
        (c >>> 24) & 0xff,
        sz & 0xff,
        (sz >>> 8) & 0xff,
        (sz >>> 16) & 0xff,
        (sz >>> 24) & 0xff,
      ]);
    };

    // Member 1: Stored block (BTYPE=0) with FEXTRA + FNAME + FCOMMENT + FHCRC
    const p1 = utf8('STORED_MEMBER_ONE');
    const hdrBase = concatBytes([
      new Uint8Array([0x1f, 0x8b, 0x08, 0x1e, 0, 0, 0, 0, 0, 0xff]),
      new Uint8Array([0x04, 0x00, 0x45, 0x58, 0x54, 0x31]), // FEXTRA (4 bytes)
      utf8('guide.xml'),
      new Uint8Array([0]), // FNAME
      utf8('member 1'),
      new Uint8Array([0]), // FCOMMENT
    ]);
    const hcrc = crc32(hdrBase) & 0xffff;
    const len1 = p1.length;
    const nlen1 = len1 ^ 0xffff;
    const m1 = concatBytes([
      hdrBase,
      new Uint8Array([hcrc & 0xff, (hcrc >>> 8) & 0xff]), // FHCRC
      new Uint8Array([0x01, len1 & 0xff, len1 >>> 8, nlen1 & 0xff, nlen1 >>> 8]),
      p1,
      trailerOf(p1),
    ]);

    // Member 2: Fixed Huffman block (BTYPE=1) — small payload compressed by CompressionStream
    const p2 = utf8('FIXED_TWO');
    const m2 = await gzip(p2);
    expect(((m2[10] as number) >>> 1) & 3).toBe(1);

    // Member 3: Dynamic Huffman block (BTYPE=2) — varied XML payload compressed by CompressionStream
    const p3 = utf8(
      Array.from(
        { length: 200 },
        (_, i) =>
          `<programme start="20260101000000" channel="ch${i % 9}"><title>Dyn ${i}</title></programme>\n`,
      ).join(''),
    );
    const m3 = await gzip(p3);
    expect(((m3[10] as number) >>> 1) & 3).toBe(2);

    const combined = concatBytes([m1, m2, m3]);
    const expected = concatBytes([p1, p2, p3]);
    for (const sizes of [[combined.length], [1, 1, 1], [7, 13]]) {
      const r = await collectDecoded(chunksOf(combined, sizes), {
        decompressor: streamingWebGunzipper,
      });
      expect(r.result).toEqual({ ok: true, value: undefined });
      expect(r.bytes).toEqual(expected);
    }
  });

  it('decodes identical repeated members and empty concatenated members without dropping any member', async () => {
    const dup = utf8('REPEAT-MEMBER-PAYLOAD');
    const tail = utf8('FINAL-MEMBER');
    const repeated = concatBytes([await gzip(dup), await gzip(dup), await gzip(tail)]);
    const rDup = await collectDecoded(chunksOf(repeated, [7, 11]), { decompressor: gunzipper });
    expect(rDup.result).toEqual({ ok: true, value: undefined });
    expect(rDup.bytes).toEqual(concatBytes([dup, dup, tail]));

    const emptyFirst = concatBytes([await gzip(new Uint8Array(0)), await gzip(tail)]);
    const rEmptyFirst = await collectDecoded(chunksOf(emptyFirst, [5]), {
      decompressor: gunzipper,
    });
    expect(rEmptyFirst.result).toEqual({ ok: true, value: undefined });
    expect(rEmptyFirst.bytes).toEqual(tail);

    const emptyLast = concatBytes([await gzip(tail), await gzip(new Uint8Array(0))]);
    const rEmptyLast = await collectDecoded(chunksOf(emptyLast, [5]), {
      decompressor: gunzipper,
    });
    expect(rEmptyLast.result).toEqual({ ok: true, value: undefined });
    expect(rEmptyLast.bytes).toEqual(tail);
  });

  it('decodes multi-100KB concatenated gzip members with gunzipper and streaming DecompressionStream', async () => {
    const makeBlock = (prefix: string, count: number) =>
      utf8(
        Array.from(
          { length: count },
          (_, i) =>
            `<programme start="20260101000000" channel="c"><title>${prefix}-${i}</title></programme>\n`,
        ).join(''),
      );
    const b1 = makeBlock('alpha', 1800);
    const b2 = makeBlock('bravo', 1800);
    expect(b1.length).toBeGreaterThan(140_000);
    expect(b2.length).toBeGreaterThan(140_000);
    const combinedText = concatBytes([await gzip(b1), await gzip(b2)]);
    const rText = await collectDecoded(chunksOf(combinedText, [combinedText.length]), {
      decompressor: gunzipper,
    });
    expect(rText.result).toEqual({ ok: true, value: undefined });
    expect(rText.bytes).toEqual(concatBytes([b1, b2]));

    // Pseudo-random incompressible >100KB members through a streaming single-member DecompressionStream
    const makeIncompressible = (len: number, seed: number) => {
      const out = new Uint8Array(len);
      let s = seed >>> 0;
      for (let i = 0; i < len; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        out[i] = (s >>> 24) & 0xff;
      }
      return out;
    };
    const r1 = makeIncompressible(120_000, 1);
    const r2 = makeIncompressible(120_000, 2);
    const combinedBin = concatBytes([await gzip(r1), await gzip(r2)]);
    const rBin = await collectDecoded(chunksOf(combinedBin, [combinedBin.length]), {
      decompressor: streamingWebGunzipper,
    });
    expect(rBin.result).toEqual({ ok: true, value: undefined });
    expect(rBin.bytes).toEqual(concatBytes([r1, r2]));

    // Same 2x120KB incompressible stream with 5ms downstream backpressure between every output chunk
    const rBackpressure = await collectDecoded(
      chunksOf(combinedBin, [combinedBin.length]),
      { decompressor: streamingWebGunzipper },
      5,
    );
    expect(rBackpressure.result).toEqual({ ok: true, value: undefined });
    expect(rBackpressure.bytes).toEqual(concatBytes([r1, r2]));
  });

  it('decodes multi-member gzip when a single-member decompressor stops cleanly at member 1 EOF', async () => {
    const p1 = utf8('member-one-clean-eof');
    const p2 = utf8('member-two-follows');
    const m1 = await gzip(p1);
    const m2 = await gzip(p2);
    const combined = concatBytes([m1, m2]);

    const cleanStopping: Decompressor = {
      async *gunzip(chunks) {
        const it = chunks[Symbol.asyncIterator]();
        const collected: Uint8Array[] = [];
        let total = 0;
        // Stop right after reading enough bytes for one member (simulate single-member EOF without throw)
        for (;;) {
          const step = await it.next();
          if (step.done) break;
          collected.push(step.value);
          total += step.value.length;
          if (total >= m1.length) break;
        }
        const buf = concatBytes(collected);
        const first = buf.subarray(
          0,
          buf.length >= m1.length && buf[0] === m1[0] ? m1.length : buf.length,
        );
        const reader = new Blob([first as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('gzip'))
          .getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          yield r.value;
        }
      },
    };
    const r = await collectDecoded(chunksOf(combined, [m1.length, m2.length]), {
      decompressor: cleanStopping,
    });
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.bytes).toEqual(concatBytes([p1, p2]));
  });

  it('returns gzip-corrupt for truncated streams, non-gzip trailing junk, and corrupt second members', async () => {
    const m1 = await gzip(utf8('valid member one'));
    const m2 = await gzip(utf8('valid member two'));

    const truncated = m1.subarray(0, m1.length - 8);
    expect(
      (await collectDecoded(chunksOf(truncated, [truncated.length]), { decompressor: gunzipper }))
        .result,
    ).toEqual({ ok: false, error: { category: 'source-format', code: 'gzip-corrupt' } });

    const trailingJunk = concatBytes([m1, utf8('NOT_GZIP_GARBAGE')]);
    expect(
      (
        await collectDecoded(chunksOf(trailingJunk, [trailingJunk.length]), {
          decompressor: gunzipper,
        })
      ).result,
    ).toEqual({ ok: false, error: { category: 'source-format', code: 'gzip-corrupt' } });

    const singleByteJunk = concatBytes([m1, new Uint8Array([0x00])]);
    expect(
      (
        await collectDecoded(chunksOf(singleByteJunk, [1]), {
          decompressor: streamingWebGunzipper,
        })
      ).result,
    ).toEqual({ ok: false, error: { category: 'source-format', code: 'gzip-corrupt' } });

    const badSecond = concatBytes([m1, m2.subarray(0, m2.length - 8)]);
    expect(
      (await collectDecoded(chunksOf(badSecond, [badSecond.length]), { decompressor: gunzipper }))
        .result,
    ).toEqual({ ok: false, error: { category: 'source-format', code: 'gzip-corrupt' } });

    const badSecondCm = concatBytes([m1, new Uint8Array([0x1f, 0x8b, 0x09, 0x00])]);
    expect(
      (
        await collectDecoded(chunksOf(badSecondCm, [1]), {
          decompressor: streamingWebGunzipper,
        })
      ).result,
    ).toEqual({ ok: false, error: { category: 'source-format', code: 'gzip-corrupt' } });

    let upstreamClosed = false;
    async function* syncThrowSource(): AsyncGenerator<Uint8Array> {
      try {
        yield m1.subarray(0, 4);
        yield m1.subarray(4);
      } finally {
        upstreamClosed = true;
      }
    }
    const throwingDecompressor: Decompressor = {
      gunzip() {
        throw new Error('sync init failure');
      },
    };
    const syncRes = await collectDecoded(syncThrowSource(), {
      decompressor: throwingDecompressor,
    });
    expect(syncRes.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-corrupt' },
    });
    expect(upstreamClosed).toBe(true);
  });

  it('preserves upstream sourceError precedence over gzip-corrupt and closes resources on early return', async () => {
    const gz = await gzip(utf8('hello world'));
    const netErr = { category: 'network', code: 'aborted' };
    async function* failingGzip(): AsyncGenerator<Uint8Array> {
      yield gz.subarray(0, 12);
      throw netErr;
    }
    const r = await collectDecoded(failingGzip(), { decompressor: gunzipper });
    expect(r.result).toEqual({ ok: false, error: netErr });

    async function* failingBetweenMembers(): AsyncGenerator<Uint8Array> {
      yield gz;
      throw netErr;
    }
    const rBetween = await collectDecoded(failingBetweenMembers(), {
      decompressor: streamingWebGunzipper,
    });
    expect(rBetween.result).toEqual({ ok: false, error: netErr });

    let upstreamClosed = false;
    let decompressorClosed = false;
    async function* endlessGzip(): AsyncGenerator<Uint8Array> {
      try {
        yield new Uint8Array([0x1f, 0x8b, 0x08]);
        for (;;) yield new Uint8Array(16);
      } finally {
        upstreamClosed = true;
      }
    }
    const endlessDecompressor: Decompressor = {
      async *gunzip() {
        try {
          for (;;) yield utf8('chunk');
        } finally {
          decompressorClosed = true;
        }
      },
    };
    const gen = decodeMaybeGzip(endlessGzip(), { decompressor: endlessDecompressor });
    const first = await gen.next();
    expect(first.done).toBe(false);
    await gen.return({ ok: true, value: undefined });
    expect(decompressorClosed).toBe(true);
    expect(upstreamClosed).toBe(true);
  });

  it('supports @@asyncIterator when Symbol.asyncIterator is undefined', async () => {
    const OriginalSymbol = globalThis.Symbol;
    const FakeSymbol = Object.assign(
      ((description?: string | number) => OriginalSymbol(description)) as typeof Symbol,
      {
        for: OriginalSymbol.for.bind(OriginalSymbol),
        keyFor: OriginalSymbol.keyFor.bind(OriginalSymbol),
        asyncIterator: undefined as unknown as typeof Symbol.asyncIterator,
      },
    );
    const babelChunks = (items: Uint8Array[]): AsyncIterable<Uint8Array> => {
      let i = 0;
      const gen = {
        '@@asyncIterator'() {
          return gen;
        },
        next: async () =>
          i < items.length
            ? { done: false as const, value: items[i++] as Uint8Array }
            : { done: true as const, value: undefined },
      };
      return gen as unknown as AsyncIterable<Uint8Array>;
    };
    const asyncGenProto = Object.getPrototypeOf(
      Object.getPrototypeOf((async function* () {})()),
    ) as Record<string, unknown>;
    asyncGenProto['@@asyncIterator'] = function (this: unknown) {
      return this;
    };
    (globalThis as { Symbol: typeof Symbol }).Symbol = FakeSymbol;
    try {
      const plainBytes = utf8('plain-babel');
      const rPlain = await collectDecoded(babelChunks([plainBytes]));
      expect(rPlain.result).toEqual({ ok: true, value: undefined });
      expect(rPlain.bytes).toEqual(plainBytes);

      const gzHeader = new Uint8Array([0x1f, 0x8b, 0x08]);
      const rGz = await collectDecoded(babelChunks([gzHeader]), {
        decompressor: { gunzip: () => babelChunks([plainBytes]) },
      });
      expect(rGz.result).toEqual({ ok: true, value: undefined });
      expect(rGz.bytes).toEqual(plainBytes);
    } finally {
      (globalThis as { Symbol: typeof Symbol }).Symbol = OriginalSymbol;
      delete asyncGenProto['@@asyncIterator'];
    }
  });

  describe('XZ stream sniffing & decompression (EPG-1)', () => {
    const XZ_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

    it('replays short plain files (< 6 bytes) and partial-magic files unchanged without invoking unxz', async () => {
      for (const plain of [
        utf8(''),
        utf8('#EXT'),
        new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a]),
      ]) {
        let called = false;
        const r = await collectDecoded(chunksOf(plain, [1]), {
          decompressor: {
            gunzip: () => {
              throw new Error('unexpected gunzip');
            },
            unxz: async function* () {
              called = true;
              yield new Uint8Array(0);
            },
          },
        });
        expect(r.result).toEqual({ ok: true, value: undefined });
        expect(r.bytes).toEqual(plain);
        expect(called).toBe(false);
      }
    });

    it('closes upstream and returns xz-unsupported when decompressor or unxz is absent', async () => {
      const payload = concatBytes([XZ_MAGIC, utf8('rest')]);
      let closed = false;
      async function* src(): AsyncGenerator<Uint8Array> {
        try {
          for (let i = 0; i < payload.length; i++) yield payload.subarray(i, i + 1);
        } finally {
          closed = true;
        }
      }
      const r = await collectDecoded(src(), { decompressor: gunzipper });
      expect(r.chunks).toEqual([]);
      expect(r.result).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'xz-unsupported' },
      });
      expect(closed).toBe(true);
    });

    it('streams XZ payloads split across 1-byte chunks through unxz and enforces maxDecompressedBytes', async () => {
      const expected = utf8(
        '<tv><channel id="xz1"><display-name>XZ Guide</display-name></channel></tv>',
      );
      const wire = concatBytes([XZ_MAGIC, expected]);
      const fakeXz: Decompressor = {
        gunzip: gunzipper.gunzip,
        async *unxz(chunks) {
          let skipped = 0;
          for await (const c of chunks) {
            if (skipped < 6) {
              const need = 6 - skipped;
              if (c.length <= need) {
                skipped += c.length;
                continue;
              }
              skipped = 6;
              yield c.subarray(need);
            } else {
              yield c;
            }
          }
        },
      };

      const okRes = await collectDecoded(chunksOf(wire, [1, 2, 1, 3]), {
        decompressor: fakeXz,
      });
      expect(okRes.result).toEqual({ ok: true, value: undefined });
      expect(okRes.bytes).toEqual(expected);

      // Enforces maxDecompressedBytes with early upstream and decompressor cancellation
      let upstreamClosed = false;
      let decompressorClosed = false;
      async function* bombSource(): AsyncGenerator<Uint8Array> {
        try {
          yield XZ_MAGIC;
          for (;;) yield new Uint8Array(64);
        } finally {
          upstreamClosed = true;
        }
      }
      const bombDecompressor: Decompressor = {
        gunzip: gunzipper.gunzip,
        async *unxz(chunks) {
          const it = chunks[Symbol.asyncIterator]();
          try {
            await it.next();
            for (;;) yield new Uint8Array(400);
          } finally {
            decompressorClosed = true;
          }
        },
      };
      const bombRes = await collectDecoded(bombSource(), {
        decompressor: bombDecompressor,
        maxDecompressedBytes: 1000,
      });
      expect(bombRes.result).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'too-large' },
      });
      expect(bombRes.bytes.length).toBe(800);
      expect(decompressorClosed).toBe(true);
      expect(upstreamClosed).toBe(true);
    });

    it('returns xz-corrupt on corrupt/truncated XZ streams and preserves upstream network error precedence', async () => {
      const wire = concatBytes([XZ_MAGIC, new Uint8Array([0xff, 0xff, 0xff])]);
      const corruptDecompressor: Decompressor = {
        gunzip: gunzipper.gunzip,
        unxz(chunks) {
          return {
            [Symbol.asyncIterator]: () => ({
              async next() {
                for await (const _ of chunks) {
                  throw new Error('bad xz checksum');
                }
                return { done: true, value: undefined };
              },
            }),
          };
        },
      };
      const rCorrupt = await collectDecoded(chunksOf(wire, [2]), {
        decompressor: corruptDecompressor,
      });
      expect(rCorrupt.result).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'xz-corrupt' },
      });

      const syncThrowDecompressor: Decompressor = {
        gunzip: gunzipper.gunzip,
        unxz() {
          throw new Error('sync init fail');
        },
      };
      const rSync = await collectDecoded(chunksOf(wire, [6]), {
        decompressor: syncThrowDecompressor,
      });
      expect(rSync.result).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'xz-corrupt' },
      });

      const netErr = { category: 'network', code: 'aborted' };
      async function* failingUpstream(): AsyncGenerator<Uint8Array> {
        yield XZ_MAGIC;
        throw netErr;
      }
      const rNet = await collectDecoded(failingUpstream(), {
        decompressor: {
          gunzip: gunzipper.gunzip,
          async *unxz(chunks) {
            for await (const c of chunks) yield c;
          },
        },
      });
      expect(rNet.result).toEqual({ ok: false, error: netErr });
    });
  });
});
