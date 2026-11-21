import type { Decompressor } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { type M3uBatch, type M3uEntry, scanM3u } from './m3u';
import { MAX_INLINE_LOGO_BYTES, parseExtinf } from './m3u-attrs';
import { chunksOf, randomSplits, utf8 } from './test-chunks';
import { gunzipper, gzip } from './xmltv-test-helpers';

async function run(text: string, opts?: { baseUrl?: string }) {
  const bytes = utf8(text);
  const gen = scanM3u(chunksOf(bytes, [bytes.length]), opts);
  const batches: M3uBatch[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { batches, result: r.value };
    batches.push(r.value);
  }
}

const one = async (text: string, opts?: { baseUrl?: string }): Promise<M3uEntry> => {
  const { batches, result } = await run(text, opts);
  expect(result.ok).toBe(true);
  const all = batches.flatMap((b) => b.entries);
  expect(all).toHaveLength(1);
  return all[0] as M3uEntry;
};

describe('M3U URL, directive & header hardening', () => {
  it('strips launcher tokens (ffmpeg, ffrt, auto, solution) before URL parsing (#198)', async () => {
    for (const prefix of ['ffmpeg ', 'ffrt ', 'ffrt3 ', 'auto ', 'solution ', 'FFMPEG  ']) {
      const e = await one(`#EXTINF:-1,Chan\n${prefix}http://h.example/live/1.ts\n`);
      expect(e.url).toBe('http://h.example/live/1.ts');
      expect(e.kindHint).toBe('live');
    }
  });

  it('parses pipe-delimited stream headers cleanly BEFORE kindOf() (#120)', async () => {
    const e = await one(
      '#EXTINF:-1,Movie\nhttp://cdn.example/files/film.mkv|User-Agent=Mozilla%2F5.0%20(TV)&Referer=https://site.example/&Cookie=sid%3D1&X-Bad%20Name=drop\n',
    );
    expect(e.url).toBe('http://cdn.example/files/film.mkv');
    expect(e.kindHint).toBe('movie');
    expect(e.headers).toEqual({
      userAgent: 'Mozilla/5.0 (TV)',
      referer: 'https://site.example/',
      other: { cookie: 'sid=1' },
    });
  });

  it('parses KODIPROP inputstream.adaptive.stream_headers and sanitizes all header sources (#270, #286, #139)', async () => {
    const e = await one(
      [
        '#EXTINF:-1,Stream',
        '#EXTVLCOPT--http-reconnect=true',
        '#EXTVLCOPT:http-user-agent=VlcUA\0\x07Injected: 1',
        '#EXTHTTP:{"X-Token":"abc\\r\\ndef","Bad Header":"nope"}',
        '#KODIPROP:inputstream.adaptive.stream_headers=Referer=https://kodi.example/%0d%0aEvil:1&Authorization=Bearer%20xyz',
        'http://h.example/live/1.m3u8',
        '',
      ].join('\n'),
    );
    expect(e.headers).toEqual({
      userAgent: 'VlcUAInjected: 1',
      referer: 'https://kodi.example/Evil:1',
      other: {
        'x-token': 'abcdef',
        authorization: 'Bearer xyz',
      },
    });
    expect(e.extra['http-reconnect']).toBe('true');
  });

  it('supports ch-number, channel-id, logo fallbacks, rejects bad chno, strips sentinel tvg-id, and parses Sat>IP numbers (#120, #252, #289)', async () => {
    const a = await one(
      '#EXTINF:-1 channel-id="epg.1" logo="http://img/1.png" ch-number="42",Channel One\nhttp://h.example/1.ts\n',
    );
    expect(a).toMatchObject({
      tvgId: 'epg.1',
      tvgLogo: 'http://img/1.png',
      chno: 42,
    });

    for (const badChno of ['0', '-5', 'Infinity', '-Infinity']) {
      const b = await one(`#EXTINF:-1 tvg-chno="${badChno}",Test\nhttp://h.example/1.ts\n`);
      expect(b.chno).toBeUndefined();
    }

    for (const sentinel of ['(no tvg-id)', 'no tvg-id', 'null', 'NULL', 'none', 'N/A']) {
      const s = await one(`#EXTINF:-1 tvg-id="${sentinel}",Test\nhttp://h.example/1.ts\n`);
      expect(s.tvgId).toBeUndefined();
    }

    // Conservative Sat>IP leading channel number
    const sat = await one('#EXTINF:-1,84. Das Erste HD\nhttp://h.example/84.ts\n');
    expect(sat.chno).toBe(84);
    expect(sat.name).toBe('Das Erste HD');

    // Must NEVER break numeric channel names like "24 TV", "360", or "100.5 FM"
    for (const keep of ['24 TV', '360', '100.5 FM']) {
      const k = await one(`#EXTINF:-1,${keep}\nhttp://h.example/live.ts\n`);
      expect(k.chno).toBeUndefined();
      expect(k.name).toBe(keep);
    }
  });

  it('splits whitespace and .xmlhttp concatenated url-tvg headers (#173)', async () => {
    const { batches } = await run(
      '#EXTM3U url-tvg="http://a.example/epg.xml http://b.example/epg.xml.gzhttps://c.example/guide.xml"\n#EXTINF:-1,A\nhttp://h.example/1\n',
    );
    expect(batches.at(-1)?.header?.guideUrls).toEqual([
      'http://a.example/epg.xml',
      'http://b.example/epg.xml.gz',
      'https://c.example/guide.xml',
    ]);
  });

  it('rejects HLS media/master manifests with source-format/hls-manifest (#252)', async () => {
    const media = await run(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:10.0,\nseg100.ts\n',
      { baseUrl: 'http://cdn.example/live/index.m3u8' },
    );
    expect(media.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'hls-manifest' },
    });

    const master = await run('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n720p/index.m3u8\n', {
      baseUrl: 'http://cdn.example/live/master.m3u8',
    });
    expect(master.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'hls-manifest' },
    });
  });

  it('sniffs captive-portal HTML/JS pages and improves kindOf() for /vod/, /film/, /movies/, SxxExx, channel= (#164)', async () => {
    const portal = await run(
      "<!doctype html>\n<html><script>\nlocation.href='login'\nhttps://portal.local/captive\n</script></html>\n",
      { baseUrl: 'http://panel.example/get.php' },
    );
    expect(portal.batches.flatMap((b) => b.entries)).toEqual([]);

    expect(
      (await one('#EXTINF:-1,Inception\nhttp://cdn.example/vod/123/index.m3u8\n')).kindHint,
    ).toBe('movie');
    expect((await one('#EXTINF:-1,Avatar\nhttp://cdn.example/movies/99\n')).kindHint).toBe('movie');
    expect((await one('#EXTINF:-1,Dune\nhttp://cdn.example/film/77\n')).kindHint).toBe('movie');
    expect(
      (await one('#EXTINF:-1,Show S02E05 Pilot\nhttp://cdn.example/vod/show.mkv\n')).kindHint,
    ).toBe('episode');
    expect((await one('#EXTINF:-1,News\nhttp://cdn.example/play?channel=101\n')).kindHint).toBe(
      'live',
    );
  });

  it('preserves exact percent-encoding casing (%2f / %3a) in stream URLs (#180)', async () => {
    const url = 'http://cdn.example/live/play?path=%2flive%2fch1%3ahd&sig=AbCdEf';
    const e = await one(`#EXTINF:-1,Signed\n${url}\n`);
    expect(e.url).toBe(url);
  });
});

async function runStream(
  chunks: AsyncIterable<Uint8Array>,
  opts?: {
    baseUrl?: string;
    batchSize?: number;
    decompressor?: Decompressor;
    maxDecompressedBytes?: number;
  },
) {
  const gen = scanM3u(chunks, opts);
  const batches: M3uBatch[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { batches, result: r.value };
    batches.push(r.value);
  }
}

describe('M3U inline base64 logo survival (#169)', () => {
  it('survives a multi-megabyte (> 1 MiB) inline data: tvg-logo without overflowing MAX_LINE', async () => {
    const hugeLogo = `data:image/png;base64,${'A'.repeat(2_100_000)}`;
    const text =
      `#EXTM3U\n` +
      `#EXTINF:-1 tvg-id="ch.1" tvg-logo="${hugeLogo}" group-title="News",Channel One\n` +
      `http://cdn.example/live/1.ts\n` +
      `#EXTINF:-1 tvg-id="ch.2",Channel Two\n` +
      `http://cdn.example/live/2.ts\n`;
    const bytes = utf8(text);

    for (const stream of [
      chunksOf(bytes, [bytes.length]),
      randomSplits(bytes, 13, 65_536),
      chunksOf(bytes, [33, 7, 11, 4090, 20, 500_000, bytes.length]),
    ]) {
      const { batches, result } = await runStream(stream);
      expect(result.ok).toBe(true);
      const entries = batches.flatMap((b) => b.entries);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        name: 'Channel One',
        url: 'http://cdn.example/live/1.ts',
        tvgId: 'ch.1',
        groups: ['News'],
      });
      expect(entries[0]?.tvgLogo).toBeUndefined();
      expect(entries[1]).toMatchObject({
        name: 'Channel Two',
        url: 'http://cdn.example/live/2.ts',
        tvgId: 'ch.2',
      });
      expect(batches.at(-1)?.stats?.warnings).toEqual([{ code: 'inline-logo-stripped', line: 2 }]);
    }
  });

  it('strips > 4096-byte inline data: logos for tvg-logo and single-quoted LOGO (case-insensitive, with BOM)', async () => {
    const tenKb = `DATA:image/jpeg;base64,${'B'.repeat(10_000)}`;
    const text =
      `\uFEFF#EXTINF:-1 LOGO='${tenKb}' tvg-id="c1" group-title="Sports",Match HD\n` +
      `http://cdn.example/live/match.ts\n` +
      `#EXTINF:-1 TVG-LOGO="data:image/png;base64,${'C'.repeat(MAX_INLINE_LOGO_BYTES + 1)}",Second\n` +
      `http://cdn.example/live/second.ts\n`;
    const bytes = utf8(text);

    for (const stream of [chunksOf(bytes, [bytes.length]), randomSplits(bytes, 42, 17)]) {
      const { batches, result } = await runStream(stream);
      expect(result.ok).toBe(true);
      const entries = batches.flatMap((b) => b.entries);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        name: 'Match HD',
        tvgId: 'c1',
        groups: ['Sports'],
        url: 'http://cdn.example/live/match.ts',
      });
      expect(entries[0]?.tvgLogo).toBeUndefined();
      expect(entries[1]).toMatchObject({
        name: 'Second',
        url: 'http://cdn.example/live/second.ts',
      });
      expect(entries[1]?.tvgLogo).toBeUndefined();
      expect(batches.at(-1)?.stats?.warnings).toEqual([
        { code: 'inline-logo-stripped', line: 1 },
        { code: 'inline-logo-stripped', line: 3 },
      ]);
    }
  });

  it('keeps small (<= 4096 byte) inline data: logos and normal http(s):// logos untouched', async () => {
    const exactPrefix = 'data:image/png;base64,';
    const exactLogo = exactPrefix + 'D'.repeat(MAX_INLINE_LOGO_BYTES - exactPrefix.length);
    expect(exactLogo.length).toBe(MAX_INLINE_LOGO_BYTES);
    const longHttpLogo = `https://img.example/logos/${'x'.repeat(6000)}.png`;
    const text =
      `#EXTINF:-1 tvg-logo="${exactLogo}",Small Data\nhttp://cdn.example/1.ts\n` +
      `#EXTINF:-1 tvg-logo="${longHttpLogo}",Long Http\nhttp://cdn.example/2.ts\n`;
    const { batches, result } = await run(text);
    expect(result.ok).toBe(true);
    const entries = batches.flatMap((b) => b.entries);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.tvgLogo).toBe(exactLogo);
    expect(entries[1]?.tvgLogo).toBe(longHttpLogo);
    expect(batches.at(-1)?.stats?.warnings).toEqual([]);
  });

  it('caps oversized inline data: logos in parseExtinf directly as defense-in-depth', () => {
    const over = `data:image/png;base64,${'E'.repeat(10_000)}`;
    const issues = { rawQuote: false, inlineLogoStripped: false };
    const e = parseExtinf(`-1 tvg-logo="${over}" group-title="G",Direct`, issues);
    expect(e.tvgLogo).toBeUndefined();
    expect(e.name).toBe('Direct');
    expect(e.groups).toEqual(['G']);
    expect(issues.inlineLogoStripped).toBe(true);

    const issuesSmall = { rawQuote: false, inlineLogoStripped: false };
    const small = parseExtinf('-1 logo="data:image/png;base64,AAAA",Small', issuesSmall);
    expect(small.tvgLogo).toBe('data:image/png;base64,AAAA');
    expect(issuesSmall.inlineLogoStripped).toBe(false);
  });

  it('still triggers line-too-long on non-data lines exceeding MAX_LINE', async () => {
    const hugeHttp = `http://img.example/${'z'.repeat(1_100_000)}.png`;
    const text =
      `#EXTINF:-1 tvg-logo="${hugeHttp}",DropMe\n` +
      `#EXTINF:-1,KeepMe\n` +
      `http://cdn.example/keep.ts\n`;
    const { batches, result } = await run(text);
    expect(result.ok).toBe(true);
    const entries = batches.flatMap((b) => b.entries);
    expect(entries.map((e) => e.name)).toEqual(['KeepMe']);
    expect(batches.at(-1)?.stats?.warnings).toEqual([{ code: 'line-too-long', line: 1 }]);
  });

  it('handles unterminated oversized data: logo without overflowing MAX_LINE', async () => {
    const text =
      `#EXTINF:-1 tvg-id="u1" tvg-logo="data:image/png;base64,${'F'.repeat(1_200_000)}\n` +
      `http://cdn.example/u1.ts\n` +
      `#EXTINF:-1,After\n` +
      `http://cdn.example/after.ts\n`;
    const { batches, result } = await run(text);
    expect(result.ok).toBe(true);
    const entries = batches.flatMap((b) => b.entries);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.tvgId).toBe('u1');
    expect(entries[0]?.tvgLogo).toBeUndefined();
    expect(entries[1]?.name).toBe('After');
    expect(batches.at(-1)?.stats?.warnings).toEqual([{ code: 'inline-logo-stripped', line: 1 }]);
  });
});

describe('M3U guide URL splitting & inline backup URLs (#173)', () => {
  it('splits .xml/http, .gz/http, and semicolon-delimited url-tvg / x-tvg-url headers', async () => {
    const header =
      '#EXTM3U ' +
      'url-tvg="https://a.example/epg.xml/https://b.example/epg.xml;http://c.example/epg.xml.gz/http://d.example/epg.gz" ' +
      'x-tvg-url="https://e.example/1.XML/HTTPS://f.example/2.xml; https://proxy.example/fetch/https://origin.example/3.xml"\n';
    const { batches } = await run(`${header}#EXTINF:-1,A\nhttp://h.example/1\n`);
    expect(batches.at(-1)?.header?.guideUrls).toEqual([
      'https://a.example/epg.xml',
      'https://b.example/epg.xml',
      'http://c.example/epg.xml.gz',
      'http://d.example/epg.gz',
      'https://e.example/1.XML',
      'HTTPS://f.example/2.xml',
      'https://proxy.example/fetch/https://origin.example/3.xml',
    ]);
  });

  it('splits inline #http/#https/#rtmp/#rtmps/#rtsp/#rtsps backup URLs into entry.backupUrls', async () => {
    const e = await one(
      '#EXTINF:-1,Live 1\n' +
        'http://primary.example/live/1.ts#http://backup1.example/live/1.ts#rtmp://backup2.example/live/1\n',
    );
    expect(e.url).toBe('http://primary.example/live/1.ts');
    expect(e.backupUrls).toEqual([
      'http://backup1.example/live/1.ts',
      'rtmp://backup2.example/live/1',
    ]);
    expect(e.nonHttp).toBe(false);
    expect(e.kindHint).toBe('live');

    const allSchemes = await one(
      '#EXTINF:-1,All\n' +
        'https://p.example/1.m3u8#HTTPS://b1.example/1.m3u8#rtmps://b2.example/a#rtsp://b3.example/b#RTSPS://b4.example/c\n',
    );
    expect(allSchemes.url).toBe('https://p.example/1.m3u8');
    expect(allSchemes.backupUrls).toEqual([
      'HTTPS://b1.example/1.m3u8',
      'rtmps://b2.example/a',
      'rtsp://b3.example/b',
      'RTSPS://b4.example/c',
    ]);
  });

  it('preserves normal URL fragments untouched with backupUrls undefined', async () => {
    for (const url of [
      'http://h.example/v.mp4#t=10',
      'http://h.example/stream.m3u8#chapter1',
      'http://h.example/stream.m3u8#http_not_scheme',
    ]) {
      const e = await one(`#EXTINF:-1,Frag\n${url}\n`);
      expect(e.url).toBe(url);
      expect(e.backupUrls).toBeUndefined();
    }

    const mixed = await one(
      '#EXTINF:-1,Mixed\nhttp://p.example/v.mp4#t=10#http://b.example/v.mp4#t=20\n',
    );
    expect(mixed.url).toBe('http://p.example/v.mp4#t=10');
    expect(mixed.backupUrls).toEqual(['http://b.example/v.mp4#t=20']);
    expect(mixed.kindHint).toBe('movie');
  });

  it('handles pipe headers, launcher prefixes, and relative primary URLs alongside backup URLs', async () => {
    const withPipes = await one(
      '#EXTINF:-1,Piped\n' +
        'ffmpeg http://p.example/live/1.ts|User-Agent=ElvTV/1&Referer=https://site.example/#http://b1.example/1.ts|User-Agent=Ignored#https://b2.example/2.ts\n',
    );
    expect(withPipes.url).toBe('http://p.example/live/1.ts');
    expect(withPipes.backupUrls).toEqual(['http://b1.example/1.ts', 'https://b2.example/2.ts']);
    expect(withPipes.headers).toEqual({
      userAgent: 'ElvTV/1',
      referer: 'https://site.example/',
      other: {},
    });

    const rel = await one('#EXTINF:-1,Rel\nlive/1.ts#http://backup.example/live/1.ts\n', {
      baseUrl: 'http://cdn.example/list.m3u',
    });
    expect(rel.url).toBe('http://cdn.example/live/1.ts');
    expect(rel.backupUrls).toEqual(['http://backup.example/live/1.ts']);
  });
});

describe('M3U gzip decompression & bomb ceiling (#169)', () => {
  it('transparently decompresses 0x1f 0x8b gzip M3U streams including split magic bytes', async () => {
    const m3u =
      '#EXTM3U url-tvg="http://epg.example/guide.xml"\n' +
      '#EXTINF:-1 tvg-id="c1" group-title="News",Gzip Channel\n' +
      'http://cdn.example/live/1.ts\n';
    const gz = await gzip(utf8(m3u));
    const { batches, result } = await runStream(chunksOf(gz, [1, 1, 7, gz.length]), {
      decompressor: gunzipper,
    });
    expect(result.ok).toBe(true);
    const entries = batches.flatMap((b) => b.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'Gzip Channel',
      tvgId: 'c1',
      groups: ['News'],
      url: 'http://cdn.example/live/1.ts',
    });
    expect(batches.at(-1)?.header?.guideUrls).toEqual(['http://epg.example/guide.xml']);
  });

  it('decompresses multi-member concatenated .gz M3U streams completely', async () => {
    const part1 = await gzip(utf8('#EXTM3U\n#EXTINF:-1,One\nhttp://cdn.example/1.ts\n'));
    const part2 = await gzip(utf8('#EXTINF:-1,Two\nhttp://cdn.example/2.ts\n'));
    const combined = new Uint8Array(part1.length + part2.length);
    combined.set(part1, 0);
    combined.set(part2, part1.length);

    const { batches, result } = await runStream(chunksOf(combined, [3, 5, 11, combined.length]), {
      decompressor: gunzipper,
    });
    expect(result.ok).toBe(true);
    expect(batches.flatMap((b) => b.entries).map((e) => e.name)).toEqual(['One', 'Two']);
  });

  it('returns source-format/gzip-unsupported when gzip M3U has no decompressor', async () => {
    const gz = await gzip(utf8('#EXTM3U\n#EXTINF:-1,One\nhttp://cdn.example/1.ts\n'));
    const { batches, result } = await runStream(chunksOf(gz, [gz.length]));
    expect(result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-unsupported' },
    });
    expect(batches.some((b) => b.done)).toBe(false);
  });

  it('enforces maxDecompressedBytes ceiling on gzipped M3U streams (gzip bomb protection)', async () => {
    let body = '#EXTM3U\n';
    for (let i = 0; i < 100; i++) body += `#EXTINF:-1,Chan ${i}\nhttp://cdn.example/${i}.ts\n`;
    const gz = await gzip(utf8(body));
    const { batches, result } = await runStream(chunksOf(gz, [gz.length]), {
      decompressor: gunzipper,
      maxDecompressedBytes: 512,
    });
    expect(result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'too-large' },
    });
    expect(batches.some((b) => b.done)).toBe(false);
  });

  it('returns source-format/gzip-corrupt on corrupt gzip M3U payloads', async () => {
    const corrupt = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);
    const { batches, result } = await runStream(chunksOf(corrupt, [corrupt.length]), {
      decompressor: gunzipper,
    });
    expect(result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-corrupt' },
    });
    expect(batches.some((b) => b.done)).toBe(false);
  });

  it('scans @@asyncIterator inputs and gzip decompressors when Symbol.asyncIterator is undefined', async () => {
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

    const m3uBytes = utf8('#EXTM3U\n#EXTINF:-1,Hermes Channel\nhttp://cdn.example/hermes.ts\n');
    const asyncGenProto = Object.getPrototypeOf(
      Object.getPrototypeOf((async function* () {})()),
    ) as Record<string, unknown>;
    asyncGenProto['@@asyncIterator'] = function (this: unknown) {
      return this;
    };
    (globalThis as { Symbol: typeof Symbol }).Symbol = FakeSymbol;
    try {
      const plainGen = scanM3u(babelChunks([m3uBytes]));
      const plainStep = await plainGen.next();
      expect(!plainStep.done && plainStep.value.entries[0]?.name).toBe('Hermes Channel');

      const gzHeader = new Uint8Array([0x1f, 0x8b, 0x08]);
      const gzGen = scanM3u(babelChunks([gzHeader]), {
        decompressor: {
          gunzip: () => babelChunks([m3uBytes]),
        },
      });
      const gzStep = await gzGen.next();
      expect(!gzStep.done && gzStep.value.entries[0]?.name).toBe('Hermes Channel');
    } finally {
      (globalThis as { Symbol: typeof Symbol }).Symbol = OriginalSymbol;
      delete asyncGenProto['@@asyncIterator'];
    }
  });
});

describe('M3U multicast udp://@ and rtp://@ normalization (#267)', () => {
  it('strips leading @ from udp://@ and rtp://@ primary and backup URLs', async () => {
    const udp = await one('#EXTINF:-1,Multicast 1\nudp://@239.0.0.1:1234\n');
    expect(udp.url).toBe('udp://239.0.0.1:1234');
    expect(udp.nonHttp).toBe(true);
    expect(udp.kindHint).toBe('live');

    const rtp = await one('#EXTINF:-1,Multicast 2\nRTP://@239.0.0.2:5004/live?iface=eth0\n');
    expect(rtp.url).toBe('RTP://239.0.0.2:5004/live?iface=eth0');
    expect(rtp.nonHttp).toBe(true);
    expect(rtp.kindHint).toBe('live');

    const ipv6 = await one('#EXTINF:-1,IPv6\nUDP://@[ff02::1]:1234\n');
    expect(ipv6.url).toBe('UDP://[ff02::1]:1234');

    const withBackups = await one(
      '#EXTINF:-1,With Backups\nudp://@239.1.1.1:1234#rtp://@239.1.1.2:5004#http://fallback.example/1.ts\n',
    );
    expect(withBackups.url).toBe('udp://239.1.1.1:1234');
    expect(withBackups.backupUrls).toEqual([
      'rtp://239.1.1.2:5004',
      'http://fallback.example/1.ts',
    ]);
  });

  it('preserves already-normalized multicast, userinfo, and HTTP URLs untouched', async () => {
    const plain = await one('#EXTINF:-1,Plain\nudp://239.0.0.1:1234\n');
    expect(plain.url).toBe('udp://239.0.0.1:1234');

    const userInfo = await one('#EXTINF:-1,User\nudp://user@239.0.0.1:1234\n');
    expect(userInfo.url).toBe('udp://user@239.0.0.1:1234');

    const httpAt = await one('#EXTINF:-1,Http\nhttp://@host.example/live.ts\n');
    expect(httpAt.url).toBe('http://@host.example/live.ts');
  });
});
