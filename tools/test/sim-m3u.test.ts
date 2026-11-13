import { describe, expect, it } from 'vitest';
import { type Account, findAccount } from '../src/sim/accounts.ts';
import { buildCatalog, COMPAT_CASES, type CompatCase } from '../src/sim/catalog.ts';
import { type M3uOptions, m3uChunks, streamUrl } from '../src/sim/m3u.ts';

const BASE = 'http://127.0.0.1:8080';
const GUIDE = `${BASE}/xmltv.php`;
const demo = findAccount('demo', 'demo') as Account;
const compat = findAccount('compat', 'compat') as Account;

function opts(account: Account, extra: Partial<M3uOptions> = {}): M3uOptions {
  return { baseUrl: BASE, account, output: 'ts', guideUrl: GUIDE, variant: 'plain', ...extra };
}

function render(profile: 'small' | 'compat', account: Account, extra: Partial<M3uOptions> = {}) {
  return [...m3uChunks(buildCatalog(profile, 1), opts(account, extra))].join('');
}

/** Splits a playlist into entries: the EXTINF line, its directive lines, and the URL line. */
function entries(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXTINF')) current = [line];
    else if (current && line !== '' && !line.startsWith('# ')) {
      current.push(line);
      if (!line.startsWith('#')) {
        out.push(current);
        current = null;
      }
    }
  }
  return out;
}

const quirks = findAccount('quirks', 'quirks') as Account;

describe('quirks playlist', () => {
  const text = render('small', quirks);
  const lines = text.split('\r\n');

  it('uses CRLF throughout and a bare header', () => {
    expect(text.startsWith('#EXTM3U\r\n')).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(lines.filter((l) => l.startsWith('#EXT-X-SESSION-DATA:'))).toHaveLength(1);
    expect(text).not.toContain('url-tvg');
    expect(text).not.toContain('catchup');
  });

  it('puts xui-id on every entry, tvg-id on live only, timeshift on archive channels', () => {
    const infs = lines.filter((l) => l.startsWith('#EXTINF'));
    expect(infs).toHaveLength(50 + 30 + 30);
    expect(infs.every((l) => /xui-id="\d+"/.test(l))).toBe(true);
    expect(infs.slice(0, 50).some((l) => l.includes('tvg-id='))).toBe(true);
    expect(infs.slice(50).some((l) => l.includes('tvg-id='))).toBe(false);
    expect(infs.filter((l) => /timeshift="\d+"/.test(l)).length).toBeGreaterThan(0);
  });

  it('leaves the demo playlist without panel attributes', () => {
    const demoText = render('small', demo);
    expect(demoText).toContain('url-tvg=');
    expect(demoText).not.toContain('xui-id');
    expect(demoText).not.toContain('\r');
  });
});

const compatText = render('compat', compat);
const compatCatalog = buildCatalog('compat', 1);

function compatEntry(c: CompatCase): { lines: string[]; id: number } {
  const index = compatCatalog.live.findIndex((x) => x.compat === c);
  return {
    lines: entries(compatText)[index] as string[],
    id: (compatCatalog.live[index] as { id: number }).id,
  };
}

describe('streamUrl', () => {
  it('builds Xtream-style URLs', () => {
    expect(streamUrl(BASE, demo, 'live', 1001, 'ts')).toBe(`${BASE}/live/demo/demo/1001.ts`);
    expect(streamUrl(BASE, demo, 'movie', 5, 'mkv')).toBe(`${BASE}/movie/demo/demo/5.mkv`);
    expect(streamUrl(BASE, demo, 'series', 6, 'mp4')).toBe(`${BASE}/series/demo/demo/6.mp4`);
  });
});

describe('m3uChunks', () => {
  it('header carries url-tvg', () => {
    expect(render('small', demo).split('\n')[0]).toBe(`#EXTM3U url-tvg="${GUIDE}"`);
    expect(compatText.split('\n')[0]).toBe(`#EXTM3U url-tvg="${GUIDE}" x-tvg-url="${GUIDE}"`);
  });

  it('live entries', () => {
    const text = render('small', demo);
    expect(text).toContain(
      `#EXTINF:-1 tvg-id="ch1001" tvg-name="Channel 0001" tvg-logo="${BASE}/logos/9.png" tvg-chno="1" group-title="Live Group 01",Channel 0001\n${BASE}/live/demo/demo/1001.ts\n`,
    );
    expect(render('small', demo, { output: 'm3u8' })).toContain(
      `${BASE}/live/demo/demo/1001.m3u8\n`,
    );
  });

  it('vod and series entries', () => {
    const text = render('small', demo);
    expect(text).toContain(
      `group-title="Movie Group 01",Movie 0001\n${BASE}/movie/demo/demo/200001.mp4\n`,
    );
    expect(text).toContain(
      `group-title="Series Group 03",Series 0003 S01E02\n${BASE}/series/demo/demo/${400001 + 2 * 6 + 1}.mp4\n`,
    );
  });

  describe('compat renders every case', () => {
    const days = (t: string) => `catchup="${t}" catchup-days="3"`;
    const rows: [CompatCase, (l: string[], id: number) => void][] = [
      [
        'catchup-default',
        (l, id) =>
          expect(l[0]).toContain(
            `catchup="default" catchup-days="3" catchup-source="${BASE}/catchup/${id}.ts?case=default&start=\${start}&end=\${end}&utc=\${utc}&lutc=\${lutc}&ts=\${timestamp}&dur=\${duration}&off=\${offset}&u2={utc}&s2={start}&ymd={Y}-{m}-{d}"`,
          ),
      ],
      [
        'catchup-append',
        (l) =>
          expect(l[0]).toContain(
            'catchup="append" catchup-source="?case=append&utc={utc}&lutc={lutc}"',
          ),
      ],
      ['catchup-shift', (l) => expect(l[0]).toContain(days('shift'))],
      ['catchup-flussonic', (l) => expect(l[0]).toContain(days('flussonic'))],
      ['catchup-flussonic-hls', (l) => expect(l[0]).toContain(days('flussonic-hls'))],
      ['catchup-fs', (l) => expect(l[0]).toContain(days('fs'))],
      ['catchup-xc', (l) => expect(l[0]).toContain(days('xc'))],
      [
        'vlcopt-user-agent',
        (l) => expect(l.at(-2)).toBe('#EXTVLCOPT:http-user-agent=ELV-Compat-UA/1.0'),
      ],
      [
        'vlcopt-referrer',
        (l) => expect(l.at(-2)).toBe(`#EXTVLCOPT:http-referrer=${BASE}/referrer-check`),
      ],
      ['exthttp', (l) => expect(l.at(-2)).toBe('#EXTHTTP:{"User-Agent":"ELV-Compat-UA/2.0"}')],
      [
        'kodiprop-clearkey',
        (l) => {
          const props = l.filter((x) => x.startsWith('#KODIPROP:'));
          expect(props).toHaveLength(3);
          expect(props[0]).toBe('#KODIPROP:inputstream.adaptive.manifest_type=mpd');
          expect(props[1]).toBe('#KODIPROP:inputstream.adaptive.license_type=clearkey');
          expect(props[2]).toMatch(
            /^#KODIPROP:inputstream\.adaptive\.license_key=[0-9a-f]{32}:[0-9a-f]{32}$/,
          );
        },
      ],
      ['extgrp', (l) => expect(l).toContain('#EXTGRP:Compat Group')],
      ['relative-url', (l, id) => expect(l.at(-1)).toBe(`relative/${id}.ts`)],
      ['redirect-url', (l, id) => expect(l.at(-1)).toBe(`${BASE}/redirect/${id}.ts`)],
      [
        'credentials-in-url',
        (l, id) =>
          expect(l.at(-1)).toBe(
            `http://${compat.username}:${compat.password}@127.0.0.1:8080/live/${compat.username}/${compat.password}/${id}.ts`,
          ),
      ],
      ['udp-url', (l) => expect(l.at(-1)).toBe('udp://@239.0.0.1:1234')],
      ['rtp-url', (l) => expect(l.at(-1)).toBe('rtp://@239.0.0.2:5004')],
      ['rtmp-url', (l, id) => expect(l.at(-1)).toBe(`rtmp://127.0.0.1:1935/live/${id}`)],
      [
        'missing-404',
        (l) => expect(l.at(-1)).toBe(`${streamUrl(BASE, compat, 'live', 999999, 'ts')}`),
      ],
      ['no-tvg-id', (l) => expect(l[0]).not.toContain('tvg-id')],
      ['duplicate-id-a', (l) => expect(l[0]).toContain('tvg-id="dup"')],
      ['duplicate-id-b', (l) => expect(l[0]).toContain('tvg-id="dup"')],
      ['empty-name', (l) => expect(l[0]?.endsWith(',')).toBe(true)],
      ['long-name', (l) => expect((l[0] as string).split('",').at(-1)).toHaveLength(300)],
      [
        'quotes-commas',
        (l) => {
          expect(l[0]).toContain(',Channel "Quoted", With, Commas');
          expect(l[0]).toContain('tvg-name="Channel \'Quoted\', With, Commas"');
        },
      ],
      ['turkish-name', (l) => expect(l[0]).toContain(',Kanal İğüşöçı')],
      ['rtl-name', (l) => expect(l[0]).toContain(',قناة ٤٢')],
      ['tvg-shift', (l) => expect(l[0]).toContain('tvg-shift="-2"')],
      ['tvg-rec', (l) => expect(l[0]).toContain('tvg-rec="3"')],
      ['radio', (l) => expect(l[0]).toContain('radio="true"')],
    ];

    it('has a row for every case', () => {
      expect(rows.map((r) => r[0]).sort()).toEqual([...COMPAT_CASES].sort());
    });

    it.each(rows)('%s', (c, check) => {
      const { lines, id } = compatEntry(c);
      check(lines, id);
    });
  });

  it('compat has comment and blank lines', () => {
    const lines = compatText.split('\n');
    expect(lines).toContain('# compat fixture');
    const first = lines.findIndex((l) => l.startsWith('#EXTINF'));
    expect(lines.slice(first, -1)).toContain('');
  });

  it('crlf-bom variant', () => {
    const text = render('compat', compat, { variant: 'crlf-bom' });
    expect(text.startsWith('\uFEFF#EXTM3U')).toBe(true);
    expect(text.slice(1).replaceAll('\r\n', '\n')).toBe(compatText);
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('truncated variant', () => {
    const text = render('compat', compat, { variant: 'truncated' });
    const at = text.lastIndexOf('#EXTINF');
    expect(compatText.startsWith(text.slice(0, at))).toBe(true);
    expect(text.endsWith('\n')).toBe(false);
    const last = text.slice(at);
    expect(last).not.toContain('\n');
    expect(last).not.toContain('",');
    expect((last.match(/"/g) ?? []).length % 2).toBe(1);
  });

  it('large playlist streams in chunks', () => {
    let extinf = 0;
    let max = 0;
    const large = findAccount('large', 'large') as Account;
    for (const chunk of m3uChunks(buildCatalog('large', 1), opts(large))) {
      max = Math.max(max, chunk.length);
      for (const line of chunk.split('\n')) if (line.startsWith('#EXTINF')) extinf++;
    }
    expect(extinf).toBe(100_000);
    expect(max).toBeLessThanOrEqual(65_536);
  });
});
