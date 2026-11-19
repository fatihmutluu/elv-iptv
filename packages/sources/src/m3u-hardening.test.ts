import { describe, expect, it } from 'vitest';
import { type M3uBatch, type M3uEntry, scanM3u } from './m3u';
import { chunksOf, utf8 } from './test-chunks';

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
