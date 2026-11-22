import { describe, expect, it } from 'vitest';
import { chunksOf, randomSplits, utf8 } from './test-chunks';
import { collect, expectSameEverywhere, guide, gunzipper, gzip } from './xmltv-test-helpers';

/** Encodes a string containing ASCII + Latin-1/Windows-1252 characters as single-byte Latin-1/CP1252. */
function latin1Bytes(text: string): Uint8Array {
  const cp1252 = new Map<number, number>([
    [0x20ac, 0x80],
    [0x2018, 0x91],
    [0x2019, 0x92],
    [0x201c, 0x93],
    [0x201d, 0x94],
    [0x2013, 0x96],
    [0x2014, 0x97],
  ]);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    const mapped = cp1252.get(cp);
    if (mapped !== undefined) out[i] = mapped;
    else if (cp <= 0xff) out[i] = cp;
    else throw new Error(`Cannot encode U+${cp.toString(16)} as Latin-1/CP1252`);
  }
  return out;
}

describe('XMLTV programme flags & Unicode superscripts (#170, #181)', () => {
  it('parses <live/>, <new/>, and <previously-shown/> elements in self-closing and paired forms', async () => {
    const text = guide(
      `<programme start="20260101000000 +0000" channel="c1"><title>Match</title><live/></programme>` +
        `<programme start="20260101010000 +0000" channel="c1"><title>Premiere</title><new></new></programme>` +
        `<programme start="20260101020000 +0000" channel="c1"><title>Encore</title><previously-shown start="20250101000000 +0000"/></programme>` +
        `<programme start="20260101030000 +0000" channel="c1"><title>Live Special</title><live>1</live><new>true</new><previously-shown>old</previously-shown></programme>` +
        `<programme start="20260101040000 +0000" channel="c1"><title>Plain</title><meta><live/><new/><previously-shown/></meta></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(
      r.programmes.map((p) => ({
        title: p.title,
        isLive: p.isLive,
        isNew: p.isNew,
        previouslyShown: p.previouslyShown,
      })),
    ).toEqual([
      { title: 'Match', isLive: true, isNew: undefined, previouslyShown: undefined },
      { title: 'Premiere', isLive: undefined, isNew: true, previouslyShown: undefined },
      { title: 'Encore', isLive: undefined, isNew: undefined, previouslyShown: true },
      { title: 'Live Special', isLive: true, isNew: true, previouslyShown: true },
      { title: 'Plain', isLive: undefined, isNew: undefined, previouslyShown: undefined },
    ]);
  });

  it('strips Unicode superscript badge runs from <title> while preserving legitimate titles, apostrophes, ordinals, and exponents', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c1"><title>Championship Finals ᴸᴵⱽᴱ</title></programme>` +
        `<programme start="20260101010000" channel="c1"><title>ᴺᴱᵂ  Evening Report  ᴴᴰ</title></programme>` +
        `<programme start="20260101020000" channel="c1"><title>Classic Film ᴿ</title></programme>` +
        `<programme start="20260101030000" channel="c1"><title>Match ˡⁱᵛᵉ ⁿᵉʷ ²³¹</title></programme>` +
        `<programme start="20260101040000" channel="c1"><title>Movie ᴴᴰ</title></programme>` +
        `<programme start="20260101050000" channel="c1"><title>Hawaiʻi</title></programme>` +
        `<programme start="20260101060000" channel="c1"><title>LʼÉcran</title></programme>` +
        `<programme start="20260101070000" channel="c1"><title>Title²</title></programme>` +
        `<programme start="20260101080000" channel="c1"><title>2²</title></programme>` +
        `<programme start="20260101090000" channel="c1"><title>1ᵉʳ Mai</title></programme>` +
        `<programme start="20260101100000" channel="c1"><title>MᶜDonald</title></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(
      r.programmes.map((p) => ({
        title: p.title,
        isLive: p.isLive,
        isNew: p.isNew,
      })),
    ).toEqual([
      { title: 'Championship Finals', isLive: true, isNew: undefined },
      { title: 'Evening Report', isLive: undefined, isNew: true },
      { title: 'Classic Film', isLive: undefined, isNew: undefined },
      { title: 'Match', isLive: true, isNew: true },
      { title: 'Movie', isLive: undefined, isNew: undefined },
      { title: 'Hawaiʻi', isLive: undefined, isNew: undefined },
      { title: 'LʼÉcran', isLive: undefined, isNew: undefined },
      { title: 'Title²', isLive: undefined, isNew: undefined },
      { title: '2²', isLive: undefined, isNew: undefined },
      { title: '1ᵉʳ Mai', isLive: undefined, isNew: undefined },
      { title: 'MᶜDonald', isLive: undefined, isNew: undefined },
    ]);
  });
});

describe('XMLTV inline HTML stripping in <title> and <sub-title> (#181)', () => {
  it('strips real and entity-escaped inline HTML formatting tags while preserving stray <', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c1">` +
        `<title>&lt;b&gt;Evening News&lt;/b&gt;</title>` +
        `<sub-title>&lt;i&gt;Part 1&lt;/i&gt; &lt;br/&gt; &lt;span class="x"&gt;Update&lt;/span&gt;</sub-title>` +
        `</programme>` +
        `<programme start="20260101010000" channel="c1">` +
        `<title><b>Headline</b><br/><span class="k">Live</span> ᴸᴵⱽᴱ</title>` +
        `<sub-title>&lt;strong&gt;Top&lt;/strong&gt; &lt;em&gt;Story&lt;/em&gt; &lt;font color="red"&gt;Now&lt;/font&gt;</sub-title>` +
        `</programme>` +
        `<programme start="20260101020000" channel="c1">` +
        `<title>Age &lt; 18 &amp; 1 &lt; 2 &amp; 3 &gt; 0</title>` +
        `<sub-title>Score 1 < 2 &amp; &lt;x&gt; kept</sub-title>` +
        `</programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(
      r.programmes.map((p) => ({
        title: p.title,
        subTitle: p.subTitle,
        isLive: p.isLive,
      })),
    ).toEqual([
      { title: 'Evening News', subTitle: 'Part 1 Update', isLive: undefined },
      { title: 'Headline Live', subTitle: 'Top Story Now', isLive: true },
      { title: 'Age < 18 & 1 < 2 & 3 > 0', subTitle: 'Score 1 < 2 & <x> kept', isLive: undefined },
    ]);
  });
});

describe('XMLTV episode-num precedence, xmltv_ns validation & desc fallback (#175, #181)', () => {
  it('ranks xmltv_ns > onscreen > dd_progid > other regardless of order', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c1"><title>P1</title>` +
        `<episode-num>untyped</episode-num>` +
        `<episode-num system="dd_progid">EP001234.0001</episode-num>` +
        `<episode-num system="onscreen">S02E05</episode-num>` +
        `<episode-num system="xmltv_ns">1.4.0/1</episode-num>` +
        `</programme>` +
        `<programme start="20260101010000" channel="c1"><title>P2</title>` +
        `<episode-num system="xmltv_ns">2.1.</episode-num>` +
        `<episode-num system="onscreen">S03E02</episode-num>` +
        `<episode-num system="xmltv_ns">9.9.</episode-num>` +
        `</programme>` +
        `<programme start="20260101020000" channel="c1"><title>P3</title>` +
        `<episode-num system="dd_progid">EP9999.0002</episode-num>` +
        `<episode-num system="onscreen">S04E08</episode-num>` +
        `</programme>` +
        `<programme start="20260101030000" channel="c1"><title>P4</title>` +
        `<episode-num system="custom">custom-1</episode-num>` +
        `<episode-num system="dd_progid">EP1234.0001</episode-num>` +
        `</programme>` +
        `<programme start="20260101040000" channel="c1"><title>P5</title>` +
        `<episode-num>plain-id</episode-num>` +
        `</programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.episodeNum)).toEqual([
      '1.4.0/1',
      '2.1.',
      'S04E08',
      'EP1234.0001',
      'plain-id',
    ]);
  });

  it('rejects malformed alphabetic xmltv_ns IDs and accepts valid numeric xmltv_ns forms', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c1"><title>Bad1</title>` +
        `<episode-num system="xmltv_ns">EP012345.0001</episode-num>` +
        `<episode-num system="onscreen">S01E03</episode-num>` +
        `</programme>` +
        `<programme start="20260101010000" channel="c1"><title>Bad2</title>` +
        `<episode-num system="xmltv_ns">tt12345.0</episode-num>` +
        `</programme>` +
        `<programme start="20260101020000" channel="c1"><title>BadDots</title>` +
        `<episode-num system="xmltv_ns">..</episode-num>` +
        `</programme>` +
        `<programme start="20260101030000" channel="c1"><title>GoodPartial</title>` +
        `<episode-num system="xmltv_ns"> . 5 . </episode-num>` +
        `</programme>` +
        `<programme start="20260101040000" channel="c1"><title>GoodTotal</title>` +
        `<episode-num system="xmltv_ns">2/10.5/12.0/1</episode-num>` +
        `</programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.episodeNum)).toEqual([
      'S01E03',
      undefined,
      undefined,
      '. 5 .',
      '2/10.5/12.0/1',
    ]);
  });

  it('falls back to leading S##E## in <desc> only when no valid <episode-num> is present', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c1"><title>FromDesc</title>` +
        `<desc>  s02e14 - The Investigation begins</desc></programme>` +
        `<programme start="20260101010000" channel="c1"><title>AfterBadXmltvNs</title>` +
        `<episode-num system="xmltv_ns">EP012345.0001</episode-num>` +
        `<desc>S1E9: Finale</desc></programme>` +
        `<programme start="20260101020000" channel="c1"><title>KeptExplicit</title>` +
        `<episode-num system="onscreen">S03E01</episode-num>` +
        `<desc>S09E99 ignored</desc></programme>` +
        `<programme start="20260101030000" channel="c1"><title>NotLeading</title>` +
        `<desc>Watch S02E05 tonight</desc></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.episodeNum)).toEqual(['S02E14', 'S1E9', 'S03E01', undefined]);
  });
});

describe('XMLTV Latin-1 / Windows-1252 XML prolog decoding (#181)', () => {
  it('decodes ISO-8859-1, Latin-1, Windows-1252 and cp1252 feeds cleanly across arbitrary chunk splits', async () => {
    for (const enc of ['ISO-8859-1', 'latin1', 'latin-1', 'Windows-1252', 'cp1252']) {
      const xml =
        `<?xml version="1.0" encoding="${enc}"?>\n<tv>` +
        `<channel id="café.1"><display-name>Émission Café</display-name></channel>` +
        `<programme start="20260101000000 +0000" channel="café.1">` +
        `<title>Café &amp; Über</title>` +
        `<sub-title>Ñoño — €10</sub-title>` +
        `<desc><![CDATA[Émission “Spéciale”]]></desc>` +
        `<category>Cinéma</category>` +
        `</programme></tv>\n`;
      const bytes = latin1Bytes(xml);
      for (const stream of [
        chunksOf(bytes, [bytes.length]),
        chunksOf(bytes, [1, 1, 1]),
        randomSplits(bytes, 19, 11),
      ]) {
        const r = await collect(stream);
        expect(r.result).toEqual({ ok: true, value: undefined });
        expect(r.channels).toEqual([{ id: 'café.1', names: ['Émission Café'] }]);
        expect(r.programmes).toHaveLength(1);
        expect(r.programmes[0]).toMatchObject({
          channel: 'café.1',
          title: 'Café & Über',
          subTitle: 'Ñoño — €10',
          desc: 'Émission “Spéciale”',
          categories: ['Cinéma'],
        });
        expect(r.programmes[0]?.title).not.toContain('\ufffd');
      }
    }
  });

  it('decodes long (> 4096 byte) Latin-1 payloads and single-quoted prologs without truncation', async () => {
    const longText = 'Café '.repeat(900).trim();
    const xml =
      `<?xml version='1.0' encoding='ISO-8859-1'?>\n<tv>` +
      `<programme start="20260101000000 +0000" channel="c1">` +
      `<title>Long</title><sub-title>&lt;p&gt;Part A&lt;/p&gt;&lt;p&gt;Part B&lt;/p&gt;</sub-title>` +
      `<desc>${longText}</desc></programme></tv>`;
    const r = await collect(chunksOf(latin1Bytes(xml), [512]));
    expect(r.result).toEqual({ ok: true, value: undefined });
    expect(r.programmes[0]?.desc).toBe(longText);
    expect(r.programmes[0]?.subTitle).toBe('Part A Part B');
  });
});

function encodeSingleByte(text: string, encoding: string): Uint8Array {
  const td = new TextDecoder(encoding);
  const reverse = new Map<string, number>();
  for (let b = 0; b <= 0xff; b++) {
    if (encoding === 'iso-8859-6' && b >= 0x80 && b <= 0x9f) continue;
    const ch = td.decode(new Uint8Array([b]));
    if (ch !== '\ufffd' && !reverse.has(ch)) reverse.set(ch, b);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const b = reverse.get(ch);
    if (b === undefined) throw new Error(`Cannot encode ${ch} in ${encoding}`);
    out[i] = b;
  }
  return out;
}

function encodeUtf16(text: string, le: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const cu = text.charCodeAt(i);
    out[2 + i * 2] = le ? cu & 0xff : cu >> 8;
    out[2 + i * 2 + 1] = le ? cu >> 8 : cu & 0xff;
  }
  return out;
}

function encodeUtf32(text: string, le: boolean): Uint8Array {
  const cps: number[] = [];
  for (const ch of text) cps.push(ch.codePointAt(0) as number);
  const out = new Uint8Array(4 + cps.length * 4);
  if (le) {
    out[0] = 0xff;
    out[1] = 0xfe;
  } else {
    out[2] = 0xfe;
    out[3] = 0xff;
  }
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] as number;
    const off = 4 + i * 4;
    if (le) {
      out[off] = cp & 0xff;
      out[off + 1] = (cp >> 8) & 0xff;
      out[off + 2] = (cp >> 16) & 0xff;
      out[off + 3] = (cp >>> 24) & 0xff;
    } else {
      out[off] = (cp >>> 24) & 0xff;
      out[off + 1] = (cp >> 16) & 0xff;
      out[off + 2] = (cp >> 8) & 0xff;
      out[off + 3] = cp & 0xff;
    }
  }
  return out;
}

function wrapInUstarTar(filename: string, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(utf8(filename), 0);
  header.set(utf8('ustar\x0000'), 257);
  const trailer = new Uint8Array(1024);
  const out = new Uint8Array(header.length + payload.length + trailer.length);
  out.set(header, 0);
  out.set(payload, 512);
  out.set(trailer, 512 + payload.length);
  return out;
}

describe('XMLTV codepages, BOMs, ustar tar headers & trimmed IDs (#429)', () => {
  it('decodes Windows-1254/ISO-8859-9/latin5, Windows-1251/cp1251, Windows-1256, and ISO-8859-6 XML prologs', async () => {
    const cases = [
      {
        prologs: ['windows-1254', 'ISO-8859-9', 'latin5'],
        encoder: 'windows-1254',
        chanName: 'İstanbul Şehir TV',
        title: 'Akşam Haberleri: Öğle Bülteni — ĞğİıŞş',
      },
      {
        prologs: ['windows-1251', 'cp1251'],
        encoder: 'windows-1251',
        chanName: 'Первый Канал',
        title: 'Новости №1: Ёлка и Їжак — €5',
      },
      {
        prologs: ['windows-1256'],
        encoder: 'windows-1256',
        chanName: 'الأخبار العربية',
        title: 'نشرة المساء — پخش',
      },
      {
        prologs: ['iso-8859-6'],
        encoder: 'iso-8859-6',
        chanName: 'القناة الأولى',
        title: 'فيلم وثائقي',
      },
    ];
    for (const c of cases) {
      for (const enc of c.prologs) {
        const xml =
          `<?xml version="1.0" encoding="${enc}"?>\n<tv>` +
          `<channel id="ch1"><display-name>${c.chanName}</display-name></channel>` +
          `<programme start="20260101000000 UTC" channel="ch1"><title>${c.title}</title></programme></tv>`;
        const bytes = encodeSingleByte(xml, c.encoder);
        const r = await collect(randomSplits(bytes, 31, 13));
        expect(r.result, enc).toEqual({ ok: true, value: undefined });
        expect(r.channels, enc).toEqual([{ id: 'ch1', names: [c.chanName] }]);
        expect(r.programmes[0]?.title, enc).toBe(c.title);
        expect(r.programmes[0]?.title, enc).not.toContain('\ufffd');
      }
    }
  });

  it('transcodes UTF-16LE, UTF-16BE, UTF-32LE, and UTF-32BE BOM XMLTV streams across arbitrary splits', async () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-16"?>\n<tv>` +
      `<channel id="c1"><display-name>İstanbul</display-name></channel>` +
      `<programme start="20260101000000 +0000" channel="c1"><title>Café 日本</title></programme></tv>`;
    for (const bytes of [
      encodeUtf16(xml, true),
      encodeUtf16(xml, false),
      encodeUtf32(xml, true),
      encodeUtf32(xml, false),
    ]) {
      const r = await collect(chunksOf(bytes, [1, 1, 3, 7, bytes.length]));
      expect(r.result).toEqual({ ok: true, value: undefined });
      expect(r.channels).toEqual([{ id: 'c1', names: ['İstanbul'] }]);
      expect(r.programmes[0]?.title).toBe('Café 日本');
    }
  });

  it('locks UTF-8 decoding when a BOM is present even if the XML prolog declares a legacy single-byte encoding', async () => {
    const utf16Xml =
      `<?xml version="1.0" encoding="windows-1254"?>\n<tv>` +
      `<channel id="c1"><display-name>İstanbul Şehir TV</display-name></channel>` +
      `<programme start="20260101000000 +0000" channel="c1"><title>Akşam Haberleri</title></programme></tv>`;
    const utf16Bytes = encodeUtf16(utf16Xml, true);
    const r16 = await collect(chunksOf(utf16Bytes, [1, 1, 7, utf16Bytes.length]));
    expect(r16.result).toEqual({ ok: true, value: undefined });
    expect(r16.channels).toEqual([{ id: 'c1', names: ['İstanbul Şehir TV'] }]);
    expect(r16.programmes[0]?.title).toBe('Akşam Haberleri');

    const utf8Xml =
      `\uFEFF<?xml version="1.0" encoding="iso-8859-1"?>\n<tv>` +
      `<channel id="c2"><display-name>Café Über</display-name></channel>` +
      `<programme start="20260101000000 +0000" channel="c2"><title>Émission Spéciale</title></programme></tv>`;
    const utf8Bytes = utf8(utf8Xml);
    const r8 = await collect(chunksOf(utf8Bytes, [1, 1, 1, 11, utf8Bytes.length]));
    expect(r8.result).toEqual({ ok: true, value: undefined });
    expect(r8.channels).toEqual([{ id: 'c2', names: ['Café Über'] }]);
    expect(r8.programmes[0]?.title).toBe('Émission Spéciale');
  });

  it('strips leading 512-byte POSIX ustar tar headers in plain .tar and .tar.gz XMLTV feeds', async () => {
    const xml = guide(
      `<channel id="t1"><display-name>Tar TV</display-name></channel>` +
        `<programme start="20260101000000 GMT" channel="t1"><title>Tar Show</title></programme>`,
    );
    const tar = wrapInUstarTar('guide.xml', utf8(xml));
    for (const stream of [
      chunksOf(tar, [tar.length]),
      chunksOf(tar, [100, 160, 260, tar.length]),
      randomSplits(tar, 7, 19),
    ]) {
      const r = await collect(stream);
      expect(r.result).toEqual({ ok: true, value: undefined });
      expect(r.channels).toEqual([{ id: 't1', names: ['Tar TV'] }]);
      expect(r.programmes[0]?.title).toBe('Tar Show');
    }

    const targz = await gzip(wrapInUstarTar('utf16.xml', encodeUtf16(xml, true)));
    const rGz = await collect(chunksOf(targz, [3, 17, targz.length]), { decompressor: gunzipper });
    expect(rGz.result).toEqual({ ok: true, value: undefined });
    expect(rGz.channels).toEqual([{ id: 't1', names: ['Tar TV'] }]);
    expect(rGz.programmes[0]?.title).toBe('Tar Show');
  });

  it('trims <channel id> and <programme channel> and rejects whitespace-only IDs with warnings', async () => {
    const xml = guide(
      `<channel id="  ch.1  "><display-name>One</display-name></channel>` +
        `<channel id="   "><display-name>Blank</display-name></channel>` +
        `<programme start="20260101000000" channel="  ch.1\t"><title>Matched</title></programme>` +
        `<programme start="20260101010000" channel="   "><title>BlankProg</title></programme>`,
    );
    const r = await expectSameEverywhere(xml);
    expect(r.channels).toEqual([{ id: 'ch.1', names: ['One'] }]);
    expect(r.programmes.map((p) => ({ channel: p.channel, title: p.title }))).toEqual([
      { channel: 'ch.1', title: 'Matched' },
    ]);
    expect(r.stats?.warnings.map((w) => w.code)).toEqual([
      'channel-missing-id',
      'programme-missing-channel',
    ]);
  });
});

describe('XMLTV preferredLanguages selection (#121, #429)', () => {
  it('scores <title>, <sub-title>, and <desc> by exact BCP-47 -> primary subtag & ISO-639-2 aliases -> untagged -> first seen', async () => {
    const xml = guide(
      `<programme start="20260101000000" channel="c1">` +
        `<title lang="fr">Bonjour</title>` +
        `<title>Untagged Title</title>` +
        `<title lang="pt-PT">Olá PT</title>` +
        `<title lang="pt-BR">Olá BR</title>` +
        `<sub-title lang="de">Teil 1</sub-title>` +
        `<sub-title lang="por">Parte Um</sub-title>` +
        `<desc lang="en">S01E01 English summary</desc>` +
        `<desc>S02E03 Untagged summary</desc>` +
        `</programme>`,
    );
    const r = await collect(chunksOf(utf8(xml), [utf8(xml).length]), {
      preferredLanguages: ['pt-BR', 'es'],
    });
    expect(r.programmes[0]).toMatchObject({
      title: 'Olá BR',
      subTitle: 'Parte Um',
      desc: 'S02E03 Untagged summary',
      episodeNum: 'S02E03',
    });
  });

  it('supports ISO-639-2/B/T aliases (tur, eng, deu/ger, fra/fre, spa, ara, rus) and preference order', async () => {
    const xml = guide(
      `<programme start="20260101000000" channel="c1">` +
        `<title lang="eng">English News</title>` +
        `<title lang="tur">Türkçe Haberler</title>` +
        `</programme>` +
        `<programme start="20260101010000" channel="c1">` +
        `<title lang="fre">Français</title>` +
        `<title lang="ger">Deutsch</title>` +
        `</programme>` +
        `<programme start="20260101020000" channel="c1">` +
        `<title lang="spa">Español</title>` +
        `<title lang="ara">عربي</title>` +
        `<title lang="rus">Русский</title>` +
        `</programme>` +
        `<programme start="20260101030000" channel="c1">` +
        `<title lang="it">Primo</title>` +
        `<title lang="nl">Tweede</title>` +
        `</programme>`,
    );
    const bytes = utf8(xml);
    const rTr = await collect(chunksOf(bytes, [bytes.length]), {
      preferredLanguages: ['tr-TR', 'en'],
    });
    expect(rTr.programmes[0]?.title).toBe('Türkçe Haberler');
    expect(rTr.programmes[3]?.title).toBe('Primo');

    const rDe = await collect(chunksOf(bytes, [bytes.length]), {
      preferredLanguages: ['de', 'fr'],
    });
    expect(rDe.programmes[1]?.title).toBe('Deutsch');

    const rRu = await collect(chunksOf(bytes, [bytes.length]), {
      preferredLanguages: ['ru', 'ar', 'es'],
    });
    expect(rRu.programmes[2]?.title).toBe('Русский');
  });

  it('keeps <live/> and <new/> tag flags independent from title-badge flags when a higher-priority title wins', async () => {
    const xml = guide(
      `<programme start="20260101000000" channel="c1">` +
        `<title lang="en">Match ᴸᴵⱽᴱ ᴺᴱᵂ</title>` +
        `<title lang="tr">Maç</title>` +
        `</programme>` +
        `<programme start="20260101010000" channel="c1">` +
        `<live/>` +
        `<title lang="en">Match ᴸᴵⱽᴱ</title>` +
        `<title lang="tr">Maç ᴺᴱᵂ</title>` +
        `</programme>`,
    );
    const r = await collect(chunksOf(utf8(xml), [utf8(xml).length]), {
      preferredLanguages: ['tr', 'en'],
    });
    expect(r.programmes[0]).toMatchObject({ title: 'Maç' });
    expect(r.programmes[0]?.isLive).toBeUndefined();
    expect(r.programmes[0]?.isNew).toBeUndefined();

    expect(r.programmes[1]).toMatchObject({ title: 'Maç', isLive: true, isNew: true });
  });
});
