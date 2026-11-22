import type { Decompressor, Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { decodeMaybeGzip } from './gzip-stream';
import { type M3uBatch, scanM3u } from './m3u';
import { chunksOf, utf8 } from './test-chunks';
import { collect as collectXmltv, guide, gunzipper, gzip, whole } from './xmltv-test-helpers';
import type { Raw } from './xtream-records';
import { streamXtreamRecords } from './xtream-stream';

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function collectM3u(bytes: Uint8Array, sizes?: readonly number[]) {
  const gen = scanM3u(chunksOf(bytes, sizes ?? [bytes.length]));
  const batches: M3uBatch[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done)
      return { batches, entries: batches.flatMap((b) => b.entries), result: step.value };
    batches.push(step.value);
  }
}

async function collectXtream(body: AsyncIterable<Uint8Array>, batchSize = 50) {
  const gen = streamXtreamRecords(body, { batchSize });
  const batches: Raw[][] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { batches, result: step.value };
    batches.push(step.value);
  }
}

async function collectGzip(
  body: AsyncIterable<Uint8Array>,
  opts: { decompressor?: Decompressor; maxDecompressedBytes?: number },
): Promise<{ totalBytes: number; result: Result<void> }> {
  const gen = decodeMaybeGzip(body, opts);
  let totalBytes = 0;
  for (;;) {
    const step = await gen.next();
    if (step.done) return { totalBytes, result: step.value };
    totalBytes += step.value.length;
  }
}

function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function assertNoProtoPollution(): void {
  const clean = {} as Record<string, unknown>;
  expect(clean.polluted).toBeUndefined();
  expect(clean.x).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty('polluted');
  expect(Object.prototype).not.toHaveProperty('x');
}

describe('XMLTV hostile inputs', () => {
  it('ignores XXE external entities and billion-laughs entity expansion', async () => {
    const xxe =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE tv [\n` +
      `  <!ENTITY xxe SYSTEM "file:///etc/passwd">\n` +
      `  <!ENTITY lol "lol">\n` +
      `  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\n` +
      `  <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">\n` +
      `]>\n` +
      `<tv><programme start="20260101000000" channel="c">` +
      `<title>&xxe; &lol9;</title></programme></tv>`;
    const r = await collectXmltv(whole(xxe));
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.programmes).toHaveLength(1);
    expect(r.programmes[0]?.title).toBe('&xxe; &lol9;');
    expect(r.programmes[0]?.title).not.toContain('root:');
  });

  it('bounds 500-level deep nesting with MAX_OPEN and still extracts fields', async () => {
    const deep = `${'<a>'.repeat(500)}<title>Deep Safe</title>${'</a>'.repeat(500)}`;
    const xml = guide(
      `<programme start="20260101000000" channel="c">${deep}</programme>` +
        `<programme start="20260101010000" channel="c"><title>After</title></programme>`,
    );
    const t0 = performance.now();
    const r = await collectXmltv(whole(xml));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.programmes.map((p) => p.title)).toEqual(['Deep Safe', 'After']);
  });

  it('scans 1.5 MiB repeated unclosed comments, CDATA, PIs, DOCTYPEs, and closers in linear O(N) time', async () => {
    const targetBytes = Math.floor(1.5 * 1024 * 1024);
    const patterns = ['<!--', '<![CDATA[', '<?', '<!DOCTYPE ', '<!DOCTYPE a [', '</'];
    for (const pat of patterns) {
      const repeated = pat.repeat(Math.ceil(targetBytes / pat.length));
      const payload = utf8(repeated);

      const t0 = performance.now();
      const single = await collectXmltv(chunksOf(payload, [payload.length]));
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(single.result).toEqual({ ok: true, value: undefined });

      const t1 = performance.now();
      const streamed = await collectXmltv(chunksOf(payload, [8192]));
      expect(performance.now() - t1).toBeLessThan(2000);
      expect(streamed.result).toEqual({ ok: true, value: undefined });
    }
  });

  it('stays linear on malformed <! declarations with trailing brackets/quotes and 1 KiB chunked long open tags', async () => {
    const base = Math.ceil((1 << 20) / 3) + 1500;
    for (const tail of ['[[x]>', '"x>']) {
      const bangPayload = utf8(`${'<!a'.repeat(base)}${tail}`);
      const t0 = performance.now();
      const rBang = await collectXmltv(chunksOf(bangPayload, [bangPayload.length]));
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(rBang.result).toEqual({ ok: true, value: undefined });

      const doctypeCount = Math.ceil((1 << 20) / 12) + 500;
      const docPayload = utf8(`${'<!DOCTYPE a '.repeat(doctypeCount)}${tail}`);
      const t1 = performance.now();
      const rDoc = await collectXmltv(chunksOf(docPayload, [docPayload.length]));
      expect(performance.now() - t1).toBeLessThan(1000);
      expect(rDoc.result).toEqual({ ok: true, value: undefined });
    }

    const longTag = utf8(`<a${'x'.repeat(512 * 1024)}`);
    const t2 = performance.now();
    const rTag = await collectXmltv(chunksOf(longTag, [1024]));
    expect(performance.now() - t2).toBeLessThan(500);
    expect(rTag.result).toEqual({ ok: true, value: undefined });

    const longDecl = utf8(`<!DOCTYPE a [[x]>${'x'.repeat(512 * 1024)}`);
    const t3 = performance.now();
    const rDecl = await collectXmltv(chunksOf(longDecl, [1024]));
    expect(performance.now() - t3).toBeLessThan(500);
    expect(rDecl.result).toEqual({ ok: true, value: undefined });
  });

  it('recovers a valid programme after oversized unclosed markup and handles chunked valid comments/CDATA', async () => {
    const trailing =
      '<programme start="20260101000000" channel="c"><title>Recovered</title></programme>';
    const afterBigUnclosed = `<!--${'x'.repeat((1 << 20) + 128)}${trailing}`;
    const r1 = await collectXmltv(whole(afterBigUnclosed));
    expect(r1.result).toEqual({ ok: true, value: undefined });
    expect(r1.programmes.map((p) => p.title)).toEqual(['Recovered']);

    const chunkedValid = guide(
      `<!-- split comment -->` +
        `<programme start="20260101000000" channel="c"><title><![CDATA[Split <CDATA>]]></title></programme>`,
    );
    const r2 = await collectXmltv(chunksOf(utf8(chunkedValid), [1]));
    expect(r2.result).toEqual({ ok: true, value: undefined });
    expect(r2.programmes.map((p) => p.title)).toEqual(['Split <CDATA>']);

    // Repeated nested DOCTYPE brackets with trailing ]> stay linear O(N)
    const doctypeStorm = `${'<!DOCTYPE a ['.repeat(50_000)}]>${trailing}`;
    const t0 = performance.now();
    const r3 = await collectXmltv(whole(doctypeStorm));
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r3.result).toEqual({ ok: true, value: undefined });

    // Backtracking cache safety: attribute containing valid comment before an oversized unclosed comment
    const backtrack = `<programme a="<!--ok-->" start="20260101000000" channel="c"><!--${'y'.repeat((1 << 20) + 64)}${trailing}`;
    const r4 = await collectXmltv(whole(backtrack));
    expect(r4.programmes.map((p) => p.title)).toEqual(['Recovered']);

    // Repeated malformed `<!-->` inside <title> must stay linear in readText
    const inTitle = guide(
      `<programme start="20260101000000" channel="c"><title>${'<!-->'.repeat(40_000)}Clean</title></programme>`,
    );
    const t1 = performance.now();
    const r5 = await collectXmltv(whole(inTitle));
    expect(performance.now() - t1).toBeLessThan(1500);
    expect(r5.programmes.map((p) => p.title)).toEqual(['Clean']);
  });

  it('handles malformed numeric entities, NUL bytes, and truncated UTF-8 without throwing', async () => {
    const xml = guide(
      `<programme start="20260101000000" channel="c">` +
        `<title>A &#0; &#xD800; &#x110000; &#999999999999999; \x00 B</title>` +
        `</programme>`,
    );
    const raw = concatBytes([
      utf8(xml.slice(0, xml.indexOf('</title>'))),
      new Uint8Array([0x00, 0xc3, 0xe2, 0x82, 0xf0, 0x9f]),
      utf8(xml.slice(xml.indexOf('</title>'))),
    ]);
    const r = await collectXmltv(chunksOf(raw, [7]));
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.programmes).toHaveLength(1);
    const title = r.programmes[0]?.title ?? '';
    expect(title).toContain('&#0;');
    expect(title).toContain('&#xD800;');
    expect(title).toContain('&#x110000;');
    expect(title).toContain('&#999999999999999;');
    expect(title).toContain('\ufffd');
  });
});

describe('Gzip hostile inputs', () => {
  it('aborts a gzip bomb exceeding maxDecompressedBytes before OOM and closes upstream', async () => {
    const compressible = new Uint8Array(2 * 1024 * 1024);
    const compressed = await gzip(compressible);
    expect(compressed.length).toBeLessThan(16 * 1024);

    let upstreamClosed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < compressed.length; i += 256) {
          yield compressed.subarray(i, Math.min(compressed.length, i + 256));
        }
      } finally {
        upstreamClosed = true;
      }
    }

    const r = await collectGzip(source(), {
      decompressor: gunzipper,
      maxDecompressedBytes: 32 * 1024,
    });
    expect(r.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
    expect(r.totalBytes).toBeLessThanOrEqual(32 * 1024);
    expect(upstreamClosed).toBe(true);
  });

  it('rejects truncated multi-member gzip streams and trailing garbage bytes', async () => {
    const m1 = await gzip(utf8('member-one'));
    const m2 = await gzip(utf8('member-two'));

    const truncatedMulti = concatBytes([m1, m2.subarray(0, m2.length - 6)]);
    const r1 = await collectGzip(chunksOf(truncatedMulti, [13]), { decompressor: gunzipper });
    expect(r1.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-corrupt' },
    });

    const trailingGarbage = concatBytes([m1, new Uint8Array([0xde, 0xad, 0xbe, 0xef])]);
    const r2 = await collectGzip(chunksOf(trailingGarbage, [7]), { decompressor: gunzipper });
    expect(r2.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-corrupt' },
    });
  });
});

describe('M3U hostile inputs', () => {
  it('resists prototype pollution in #EXTHTTP and keeps null-prototype header maps', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1,Proto Test',
      '#EXTHTTP:{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"x":1}},"X-Ok":"1"}',
      '#EXTHTTP:{"__proto__":"yes","constructor":"bad","prototype":"bad"}',
      'https://stream.example/live/1.ts',
      '',
    ].join('\n');
    const r = await collectM3u(utf8(playlist));
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.entries).toHaveLength(1);
    expect(Object.getPrototypeOf(r.entries[0]?.headers.other)).toBeNull();
    expect(r.entries[0]?.headers.other['x-ok']).toBe('1');
    assertNoProtoPollution();
  });

  it('strips CRLF header injection in #EXTVLCOPT and #EXTHTTP', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1,CRLF Test',
      '#EXTVLCOPT:http-user-agent=SafeUA\rX-Evil: 1',
      '#EXTVLCOPT:http-referrer=https://ref.example/\x00Injected',
      '#EXTHTTP:{"User-Agent":"UA\\r\\nX-Injected: yes","X-Custom":"val\\r\\nEvil: 2"}',
      'https://stream.example/live/2.ts',
      '',
    ].join('\n');
    const r = await collectM3u(utf8(playlist));
    expect(r.result).toEqual({ ok: true, value: undefined });
    const h = r.entries[0]?.headers;
    expect(h?.userAgent).not.toMatch(/[\r\n]/);
    expect(h?.referer).not.toMatch(/[\r\n\0]/);
    expect(h?.other['x-custom']).not.toMatch(/[\r\n]/);
    expect(h?.other['x-injected']).toBeUndefined();
  });

  it('rejects SVG, javascript:, file:, and >4 KiB data: artwork URLs', async () => {
    const bigDataLogo = `data:image/png;base64,${'A'.repeat(5000)}`;
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-logo="data:image/svg+xml,<svg onload=alert(1)/>",Svg',
      'https://stream.example/1.ts',
      '#EXTINF:-1 tvg-logo="javascript:alert(1)",Js',
      'https://stream.example/2.ts',
      '#EXTINF:-1 tvg-logo="file:///etc/passwd",File',
      'https://stream.example/3.ts',
      `#EXTINF:-1 tvg-logo="${bigDataLogo}",Huge`,
      'https://stream.example/4.ts',
      '',
    ].join('\n');
    const r = await collectM3u(utf8(playlist), [128]);
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.entries).toHaveLength(4);
    for (const entry of r.entries) {
      expect(entry.tvgLogo).toBeUndefined();
    }
    const warnings = r.batches.at(-1)?.stats?.warnings.map((w) => w.code) ?? [];
    expect(warnings).toContain('inline-logo-stripped');
  });

  it('bounds a 2 MiB single line without newline and recovers for later lines', async () => {
    const hugeLine = `#EXTINF:-1,${'A'.repeat(2 * 1024 * 1024)}`;
    const playlist = `${hugeLine}\n#EXTINF:-1,Good\nhttps://stream.example/ok.ts\n`;
    const r = await collectM3u(utf8(playlist), [16 * 1024]);
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.entries.map((e) => e.name)).toEqual(['Good']);
    const warnings = r.batches.at(-1)?.stats?.warnings.map((w) => w.code) ?? [];
    expect(warnings).toContain('line-too-long');
  });

  it('flags file:// stream URLs as nonHttp and rejects javascript: URLs as not-a-url', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1,Local File',
      'file:///etc/passwd',
      '#EXTINF:-1,JS Scheme',
      'javascript:alert(1)',
      '',
    ].join('\n');
    const r = await collectM3u(utf8(playlist));
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.url).toBe('file:///etc/passwd');
    expect(r.entries[0]?.nonHttp).toBe(true);
    const warnings = r.batches.at(-1)?.stats?.warnings.map((w) => w.code) ?? [];
    expect(warnings).toContain('not-a-url');
  });
});

describe('Xtream JSON hostile inputs', () => {
  it('rejects 5000-level nested arrays without stack overflow and closes upstream early', async () => {
    const deep = `${'['.repeat(5000)}1${']'.repeat(5000)}`;
    const bytes = utf8(deep);
    let chunksRead = 0;
    let closed = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let offset = 0;
        return {
          async next() {
            if (offset >= bytes.length) return { done: true, value: undefined };
            chunksRead++;
            const next = bytes.subarray(offset, Math.min(bytes.length, offset + 128));
            offset += 128;
            return { done: false, value: next };
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const r = await collectXtream(body);
    expect(r.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
    expect(chunksRead).toBeLessThan(3);
    expect(closed).toBe(true);
  });

  it('rejects a 2 MiB single composite element without buffering unbounded memory', async () => {
    const prefix = utf8('[{"stream_id":1,"blob":"');
    const pad = utf8('x'.repeat(32 * 1024));
    const suffix = utf8('"}]');
    let chunksRead = 0;
    let closed = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = 0;
        return {
          async next() {
            chunksRead++;
            if (sent === 0) {
              sent++;
              return { done: false, value: prefix };
            }
            if (sent <= 64) {
              sent++;
              return { done: false, value: pad };
            }
            if (sent === 65) {
              sent++;
              return { done: false, value: suffix };
            }
            return { done: true, value: undefined };
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const r = await collectXtream(body);
    expect(r.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
    expect(chunksRead).toBeLessThanOrEqual(35);
    expect(closed).toBe(true);
  });

  it('rejects deeply nested objects under both numeric and non-numeric keys without stack overflow', async () => {
    const deepObj = `${'{"a":'.repeat(500)}1${'}'.repeat(500)}`;
    const rNonNum = await collectXtream(chunksOf(utf8(deepObj), [64]));
    expect(rNonNum.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });

    const deepNum = `{"0":${deepObj}}`;
    const rNum = await collectXtream(chunksOf(utf8(deepNum), [64]));
    expect(rNum.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
  });

  it('bounds oversized object keys, strings, and primitives, and handles broken escapes & trailing commas', async () => {
    const bigKey = utf8(`{"${'k'.repeat(70 * 1024)}":{}}`);
    expect((await collectXtream(chunksOf(bigKey, [4096]))).result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });

    const bigStr = utf8(`["${'s'.repeat(70 * 1024)}"]`);
    expect((await collectXtream(chunksOf(bigStr, [4096]))).result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });

    const bigPrim = utf8(`[${'9'.repeat(70 * 1024)}]`);
    expect((await collectXtream(chunksOf(bigPrim, [4096]))).result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });

    const broken = utf8('[{"stream_id":1,"name":"Bad \\q \\x41 \\u12 \\uD800 \\\\ trailing",},]');
    const r = await collectXtream(chunksOf(broken, [5]));
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.batches.flat()).toHaveLength(1);
  });
});

describe('Deterministic seeded mutation fuzzer', () => {
  const m3uSeed = utf8(
    '#EXTM3U url-tvg="https://epg.example/g.xml"\n' +
      '#EXTINF:-1 tvg-id="c1" tvg-logo="https://img.example/1.png",Chan 1\n' +
      '#EXTHTTP:{"User-Agent":"TV"}\n' +
      'https://stream.example/live/1.ts\n',
  );
  const xmltvSeed = utf8(
    '<?xml version="1.0"?><tv><channel id="c1"><display-name>C1</display-name></channel>' +
      '<programme start="20260101000000" channel="c1"><title><![CDATA[Show]]></title></programme></tv>',
  );
  const xtreamSeed = utf8(
    '[{"stream_id":1,"name":"Ch 1","nested":{"a":[1,2]}},{"stream_id":2,"name":"Ch 2"}]',
  );
  const tokens = [
    utf8('<!--'),
    utf8('<![CDATA['),
    utf8('<?'),
    utf8('<!DOCTYPE '),
    utf8('</'),
    utf8('{"__proto__":{"polluted":"yes"}}'),
    utf8('[[[['),
    utf8('{"a":'),
    utf8('\\uD800'),
    utf8('\r\nX-Injected: 1'),
    new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0xc3]),
  ];

  function mutate(seed: Uint8Array, nextRand: () => number): Uint8Array {
    const out = new Uint8Array(seed);
    const edits = 1 + (nextRand() % 6);
    for (let e = 0; e < edits; e++) {
      const idx = nextRand() % Math.max(1, out.length);
      out[idx] = nextRand() & 0xff;
    }
    const mode = nextRand() % 4;
    if (mode === 0) {
      const cut = nextRand() % Math.max(1, out.length);
      return out.subarray(0, cut);
    }
    if (mode === 1) {
      const tok = tokens[nextRand() % tokens.length] as Uint8Array;
      const at = nextRand() % (out.length + 1);
      return concatBytes([out.subarray(0, at), tok, out.subarray(at)]);
    }
    if (mode === 2) {
      return concatBytes([out, out]);
    }
    return out;
  }

  it('survives 120 mutated payloads across M3U, XMLTV, and Xtream parsers with zero throws or prototype pollution', async () => {
    const nextRand = makePrng(0x5e_ed_12_34);
    const t0 = performance.now();

    for (let i = 0; i < 40; i++) {
      const chunkSz = 1 + (nextRand() % 31);

      const m3uPayload = mutate(m3uSeed, nextRand);
      const m3uRes = await collectM3u(m3uPayload, [chunkSz]);
      expect(typeof m3uRes.result.ok).toBe('boolean');

      const xmlPayload = mutate(xmltvSeed, nextRand);
      const xmlRes = await collectXmltv(chunksOf(xmlPayload, [chunkSz]));
      expect(typeof (xmlRes.result as Result<void>).ok).toBe('boolean');

      const xtreamPayload = mutate(xtreamSeed, nextRand);
      const xtreamRes = await collectXtream(chunksOf(xtreamPayload, [chunkSz]));
      expect(typeof xtreamRes.result.ok).toBe('boolean');
    }

    expect(performance.now() - t0).toBeLessThan(3000);
    assertNoProtoPollution();
  });
});
