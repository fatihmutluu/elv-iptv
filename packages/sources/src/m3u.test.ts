import { describe, expect, it } from 'vitest';
import { type M3uEntry, type M3uHeader, scanM3u } from './m3u';
import type { ScanStats } from './stats';
import { chunksOf, everySplit, randomSplits, utf8 } from './test-chunks';

interface Scan {
  entries: M3uEntry[];
  header?: M3uHeader;
  stats?: ScanStats;
  batches: number[];
}

async function collect(
  chunks: AsyncIterable<Uint8Array>,
  opts?: { batchSize?: number; baseUrl?: string | undefined },
): Promise<Scan> {
  const out: Scan = { entries: [], batches: [] };
  for await (const batch of scanM3u(chunks, opts)) {
    out.entries.push(...batch.entries);
    out.batches.push(batch.entries.length);
    if (batch.header) out.header = batch.header;
    if (batch.stats) out.stats = batch.stats;
  }
  return out;
}

/** Scans `text` whole, then through every two-chunk split, and requires identical results. */
async function scan(text: string, opts?: { baseUrl?: string | undefined }): Promise<Scan> {
  const bytes = utf8(text);
  const whole = await collect(chunksOf(bytes, [bytes.length]), opts);
  for (const split of everySplit(bytes)) {
    const got = await collect(split, opts);
    expect({ ...got, batches: [] }).toEqual({ ...whole, batches: [] });
  }
  return whole;
}

const one = async (text: string): Promise<M3uEntry> => {
  const result = await scan(text);
  expect(result.entries).toHaveLength(1);
  return result.entries[0] as M3uEntry;
};

describe('scanM3u header', () => {
  it('collects HTTP(S) guide urls from url-tvg, x-tvg-url, and tvg-url while rejecting unsafe schemes (M3U-4)', async () => {
    const r = await scan(
      '#EXTM3U url-tvg="http://a.example/epg.xml,https://b.example/epg.xml.gz" x-tvg-url="https://c.example/epg.xml" tvg-url="http://d.example/guide.xml file:///etc/passwd javascript:alert(1) bare-token" cache=500\n#EXTINF:-1,A\nhttp://h.example/1\n',
    );
    expect(r.header?.guideUrls).toEqual([
      'http://a.example/epg.xml',
      'https://b.example/epg.xml.gz',
      'https://c.example/epg.xml',
      'http://d.example/guide.xml',
    ]);
    expect(r.header?.attrs).toEqual({ cache: '500' });
    expect(r.entries).toHaveLength(1);
  });

  it('parses entries when #EXTM3U is missing', async () => {
    const r = await scan('#EXTINF:-1,A\nhttp://h.example/1\n');
    expect(r.entries[0]?.name).toBe('A');
    expect(r.header).toEqual({ present: false, guideUrls: [], attrs: {} });
  });
});

describe('scanM3u entries', () => {
  it('maps every known attribute', async () => {
    const e = await one(
      '#EXTINF:12.5 tvg-id="id1" tvg-name="N" tvg-logo="http://l.example/a.png" tvg-chno="7" tvg-shift="-2" group-title="A;B" radio="true",Name\nhttp://h.example/1\n',
    );
    expect(e).toMatchObject({
      name: 'Name',
      url: 'http://h.example/1',
      duration: 12.5,
      tvgId: 'id1',
      tvgName: 'N',
      tvgLogo: 'http://l.example/a.png',
      chno: 7,
      shiftHours: -2,
      groups: ['A', 'B'],
      radio: true,
      kindHint: 'live',
      nonHttp: false,
    });
  });

  it('uses #EXTGRP only when group-title is absent', async () => {
    expect((await one('#EXTINF:-1,A\n#EXTGRP:G\nhttp://h.example/1\n')).groups).toEqual(['G']);
    expect(
      (await one('#EXTINF:-1 group-title="T",A\n#EXTGRP:G\nhttp://h.example/1\n')).groups,
    ).toEqual(['T']);
  });

  it('takes the name after the first comma outside quotes', async () => {
    const e = await one(
      '#EXTINF:-1 tvg-name="A, B" group-title="X,Y",Channel "Q", With, Commas\nhttp://h.example/1\n',
    );
    expect(e.name).toBe('Channel "Q", With, Commas');
    expect(e.tvgName).toBe('A, B');
    expect(e.groups).toEqual(['X,Y']);
  });

  it('accepts unquoted values, any key case and keeps unknown keys', async () => {
    const e = await one(
      '#EXTINF:-1 TVG-ID=abc xui-id="9" stray tvg-logo=\'http://img.example/q.png\' =x,N\nhttp://h.example/1\n',
    );
    expect(e.tvgId).toBe('abc');
    expect(e.tvgLogo).toBe('http://img.example/q.png');
    expect(e.extra).toEqual({ 'xui-id': '9' });
    expect(e.name).toBe('N');
  });

  it('handles an unterminated quote, a missing duration and a bad duration', async () => {
    const a = await one('#EXTINF:-1 tvg-name="oops\nhttp://h.example/1\n');
    expect(a.tvgName).toBe('oops');
    expect(a.name).toBe('oops');
    const b = await one('#EXTINF: tvg-id=x,N\nhttp://h.example/1\n');
    expect(b).toMatchObject({ duration: -1, tvgId: 'x', name: 'N' });
    const c = await one('#EXTINF:abc,N\nhttp://h.example/1\n');
    expect(c.duration).toBe(-1);
  });

  it('ignores empty and non-numeric values for typed fields', async () => {
    const e = await one(
      '#EXTINF:-1 tvg-id="" tvg-chno="x" tvg-shift="" timeshift="" group-title="",N\nhttp://h.example/1\n',
    );
    expect(e.tvgId).toBeUndefined();
    expect(e.chno).toBeUndefined();
    expect(e.shiftHours).toBeUndefined();
    expect(e.timeshiftDays).toBeUndefined();
    expect(e.groups).toEqual([]);
    expect(e.radio).toBe(false);
  });

  it('parses catch-up and time-shift attributes', async () => {
    const e = await one(
      '#EXTINF:-1 catchup="append" catchup-source="?utc={utc}" catchup-days="3" timeshift="10" tvg-rec="3",N\nhttp://h.example/1\n',
    );
    expect(e.catchup).toEqual({ type: 'append', source: '?utc={utc}', days: 3 });
    expect(e.timeshiftDays).toBe(10);
    expect(e.recordDays).toBe(3);
    const d = await one('#EXTINF:-1 catchup-days="2",N\nhttp://h.example/1\n');
    expect(d.catchup).toEqual({ type: 'default', days: 2 });
  });

  it('keeps a bare URL line as an entry named after the URL', async () => {
    const e = await one('http://h.example/live/1\n');
    expect(e).toMatchObject({ name: 'http://h.example/live/1', duration: -1 });
  });
});

describe('scanM3u directives', () => {
  it('reads VLC options and EXTHTTP headers', async () => {
    const e = await one(
      '#EXTINF:-1,A\n#EXTVLCOPT:http-user-agent=UA\n#EXTVLCOPT:http-referrer=R\n#EXTVLCOPT:other=1\n#EXTVLCOPT:novalue\nhttp://h.example/1\n',
    );
    expect(e.headers).toEqual({ userAgent: 'UA', referer: 'R', other: {} });
    const f = await one('#EXTINF:-1,A\n#EXTVLCOPT:http-referer=R2\nhttp://h.example/1\n');
    expect(f.headers.referer).toBe('R2');
    const g = await one(
      '#EXTINF:-1,A\n#EXTHTTP:{"User-Agent":"U2","X-A":"b","n":1}\nhttp://h.example/1\n',
    );
    expect(g.headers).toEqual({ userAgent: 'U2', other: { 'x-a': 'b', n: '1' } });
    const h = await one('#EXTINF:-1,A\n#EXTHTTP:{"Referer":"R3"}\nhttp://h.example/1\n');
    expect(h.headers.referer).toBe('R3');
  });

  it('ignores null, empty and non-primitive header values in EXTVLCOPT and EXTHTTP', async () => {
    const e = await one(
      [
        '#EXTINF:-1,A',
        '#EXTVLCOPT:http-user-agent=   ',
        '#EXTVLCOPT:http-referrer=',
        '#EXTHTTP:{"User-Agent":null,"Referer":"  ","X-Null":null,"X-Empty":"","X-Obj":{},"X-Ok":" yes "}',
        'http://h.example/1',
        '',
      ].join('\n'),
    );
    expect(e.headers).toEqual({ other: { 'x-ok': 'yes' } });
  });

  it('warns on malformed EXTHTTP and keeps the entry', async () => {
    for (const bad of ['{nope', '[1]', '"s"', 'null']) {
      const r = await scan(`#EXTINF:-1,A\n#EXTHTTP:${bad}\nhttp://h.example/1\n`);
      expect(r.entries).toHaveLength(1);
      expect(r.stats?.warnings).toEqual([{ code: 'exthttp-malformed', line: 2 }]);
    }
  });

  it('collects KODIPROP lines and ignores session data and unknown lines', async () => {
    const r = await scan(
      '#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID="x",VALUE="y"\n#EXTINF:-1,A\n#KODIPROP:inputstream=adaptive\n#KODIPROP:license_type=clearkey\n#KODIPROP:k=a=b\n#KODIPROP:bare\n#COMMENT\nhttp://h.example/1\n',
    );
    expect(r.entries[0]?.kodiProps).toEqual({
      inputstream: 'adaptive',
      license_type: 'clearkey',
      k: 'a=b',
    });
    expect(r.entries).toHaveLength(1);
  });

  it('ignores directives that have no pending EXTINF', async () => {
    const r = await scan('#EXTGRP:G\n#EXTVLCOPT:http-user-agent=U\n#EXTHTTP:{}\n#KODIPROP:a=b\n');
    expect(r.entries).toEqual([]);
    expect(r.stats?.warnings).toEqual([]);
  });
});

describe('scanM3u framing', () => {
  const body = (eol: string): string =>
    `#EXTM3U${eol}#EXTINF:-1 tvg-id="a",One${eol}http://h.example/1${eol}${eol}#EXTINF:-1,Zwei é 日本${eol}http://h.example/2${eol}`;

  it('treats LF, CRLF, lone CR and a BOM alike', async () => {
    const lf = await scan(body('\n'));
    expect(lf.entries.map((e) => e.name)).toEqual(['One', 'Zwei é 日本']);
    for (const text of [body('\r\n'), body('\r'), `﻿${body('\n')}`]) {
      const got = await scan(text);
      expect(got.entries).toEqual(lf.entries);
      expect(got.header).toEqual(lf.header);
    }
  });

  it('counts lines once for CRLF', async () => {
    const r = await scan(body('\r\n'));
    expect(r.stats).toMatchObject({ lines: 6, entries: 2, skipped: 0 });
  });

  it('drops a final EXTINF without URL with one warning', async () => {
    const r = await scan('#EXTINF:-1,A\nhttp://h.example/1\n#EXTINF:-1,B');
    expect(r.entries.map((e) => e.name)).toEqual(['A']);
    expect(r.stats?.warnings).toEqual([{ code: 'extinf-without-url', line: 3 }]);
    expect(r.stats?.skipped).toBe(1);
  });

  it('drops an EXTINF followed by another EXTINF', async () => {
    const r = await scan('#EXTINF:-1,A\n#EXTINF:-1,B\nhttp://h.example/1\n');
    expect(r.entries.map((e) => e.name)).toEqual(['B']);
    expect(r.stats?.skipped).toBe(1);
  });

  it('keeps a final URL without newline', async () => {
    const r = await scan('#EXTINF:-1,A\nhttp://h.example/1');
    expect(r.entries[0]?.url).toBe('http://h.example/1');
  });

  it('handles empty input', async () => {
    const r = await collect(chunksOf(new Uint8Array(0), []));
    expect(r.entries).toEqual([]);
    expect(r.batches).toEqual([0]);
    expect(r.stats).toMatchObject({ lines: 0, entries: 0 });
  });

  it('trims spaces around lines', async () => {
    const r = await scan('  #EXTINF:-1,A  \n\t http://h.example/1 \t\n');
    expect(r.entries[0]).toMatchObject({ name: 'A', url: 'http://h.example/1' });
  });

  it('skips an over-long line and resumes at the next one', async () => {
    const long = `#EXTINF:-1 x="${'a'.repeat(1_100_000)}",A`;
    const text = `${long}\n#EXTINF:-1,B\nhttp://h.example/1\n`;
    const got = await collect(randomSplits(utf8(text), 7, 200_000));
    expect(got.entries.map((e) => e.name)).toEqual(['B']);
    expect(got.stats?.warnings).toEqual([{ code: 'line-too-long', line: 1 }]);
    const bytes = utf8(text);
    const whole = await collect(chunksOf(bytes, [bytes.length]));
    expect(whole.entries).toEqual(got.entries);
    expect(whole.stats).toEqual(got.stats);
  });
});

describe('scanM3u urls', () => {
  const hint = async (url: string, baseUrl?: string): Promise<M3uEntry> => {
    const r = await scan(`#EXTINF:-1,A\n${url}\n`, { baseUrl });
    return r.entries[0] as M3uEntry;
  };

  it.each([
    ['http://h.example/movie/u/p/1.mkv', 'movie'],
    ['http://h.example/series/u/p/2.mp4', 'episode'],
    ['http://h.example/live/u/p/3.ts', 'live'],
    ['http://h.example/live/u/p/3.mp4', 'live'],
    ['https://h.example/x.mp4', 'movie'],
    ['https://h.example/x.MKV?token=1', 'movie'],
    ['https://h.example/x.m3u8', 'live'],
    ['https://h.example/dir.v/x', 'live'],
    ['https://h.example/x', 'live'],
    ['https://h.example', 'live'],
    ['udp://@239.0.0.1:1234', 'live'],
  ])('hints %s as %s', async (url, kind) => {
    expect((await hint(url)).kindHint).toBe(kind);
  });

  it('flags non-HTTP schemes', async () => {
    expect(await hint('udp://@239.0.0.1:1234')).toMatchObject({
      nonHttp: true,
      url: 'udp://239.0.0.1:1234',
    });
    expect((await hint('rtmp://h.example/a')).nonHttp).toBe(true);
    expect((await hint('HTTPS://h.example/a')).nonHttp).toBe(false);
  });

  it('resolves relative URLs against baseUrl and keeps them otherwise', async () => {
    const base = 'http://h.example/playlists/a.m3u?x=1#f';
    expect((await hint('relative/5.ts', base)).url).toBe(
      'http://h.example/playlists/relative/5.ts',
    );
    expect((await hint('/abs/6.ts', base)).url).toBe('http://h.example/abs/6.ts');
    expect((await hint('//other.example/7.ts', base)).url).toBe('http://other.example/7.ts');
    expect((await hint('http://k.example/8.ts', base)).url).toBe('http://k.example/8.ts');
    expect((await hint('relative/5.ts', 'not a url')).url).toBe('relative/5.ts');
    expect((await hint('r.ts', 'http://h.example')).url).toBe('http://h.example/r.ts');
    expect((await hint('r.ts', 'http://h.example?q=1')).url).toBe('http://h.example/r.ts');
  });
});

describe('scanM3u raw quotes inside attribute values', () => {
  it('starts the name after the first comma following the last quoted value', async () => {
    const r = await scan(
      '#EXTINF:-1 tvg-id="c1" tvg-name="Channel "Raw", Quote" group-title="G",Channel "Raw", Quote\nhttp://h.example/1\n',
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      name: 'Channel "Raw", Quote',
      url: 'http://h.example/1',
      tvgId: 'c1',
      groups: ['G'],
    });
    expect(r.entries[0]?.tvgName).toBeUndefined();
    expect(r.stats?.warnings).toEqual([{ code: 'attr-quote', line: 1 }]);
  });

  it('recovers from a raw quote in a middle attribute', async () => {
    const r = await scan(
      '#EXTINF:-1 tvg-id="a" tvg-name="x "y" z" tvg-chno="7" group-title="G;H",Name, Two\nhttp://h.example/2\n',
    );
    expect(r.entries[0]).toMatchObject({
      name: 'Name, Two',
      tvgId: 'a',
      chno: 7,
      groups: ['G', 'H'],
    });
    expect(r.entries[0]?.tvgName).toBeUndefined();
    expect(r.stats?.warnings).toEqual([{ code: 'attr-quote', line: 1 }]);
  });

  it('recovers from a raw quote with an inner comma inside the last attribute', async () => {
    const r = await scan(
      '#EXTINF:-1 tvg-id="c1" tvg-name="Channel "Raw", Quote",Channel "Raw", Quote\nhttp://h.example/4\n',
    );
    expect(r.entries[0]).toMatchObject({
      name: 'Channel "Raw", Quote',
      url: 'http://h.example/4',
      tvgId: 'c1',
    });
    expect(r.entries[0]?.tvgName).toBeUndefined();
    expect(r.stats?.warnings).toEqual([{ code: 'attr-quote', line: 1 }]);
  });

  it('does not warn for adjacent well-formed attributes or clean lines', async () => {
    const r = await scan('#EXTINF:-1 a="1"b="2" tvg-name="N",N\nhttp://h.example/3\n');
    expect(r.entries[0]).toMatchObject({ name: 'N', extra: { a: '1', b: '2' }, tvgName: 'N' });
    expect(r.stats?.warnings).toEqual([]);
  });
});

describe('scanM3u provider imdb_id & tmdb_id attributes (#511)', () => {
  it('extracts valid tvg-imdb, imdb-id, imdb_id, tmdb-id, and tmdb_id attributes', async () => {
    const a = await one(
      '#EXTINF:-1 tvg-imdb="TT1375666" tmdb-id="27205",Inception\nhttp://h.example/movie/1.mp4\n',
    );
    expect(a.providerImdbId).toBe('tt1375666');
    expect(a.providerTmdbId).toBe('27205');

    const b = await one(
      '#EXTINF:-1 imdb-id="tt0133093" tmdb_id="603",The Matrix\nhttp://h.example/movie/2.mkv\n',
    );
    expect(b.providerImdbId).toBe('tt0133093');
    expect(b.providerTmdbId).toBe('603');

    const c = await one(
      '#EXTINF:-1 imdb_id="tt0903747",Breaking Bad\nhttp://h.example/series/1.mp4\n',
    );
    expect(c.providerImdbId).toBe('tt0903747');
    expect(c.providerTmdbId).toBeUndefined();
  });

  it('rejects malformed, zero, or SQL-injection provider IDs cleanly', async () => {
    const bad = await one(
      '#EXTINF:-1 tvg-imdb="tt12; DROP TABLE" tmdb-id="0",Bad\nhttp://h.example/movie/3.mp4\n',
    );
    expect(bad.providerImdbId).toBeUndefined();
    expect(bad.providerTmdbId).toBeUndefined();
  });
});
