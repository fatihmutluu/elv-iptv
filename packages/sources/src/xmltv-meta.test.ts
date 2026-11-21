import { describe, expect, it } from 'vitest';
import { chunksOf, randomSplits } from './test-chunks';
import { collect, expectSameEverywhere, guide } from './xmltv-test-helpers';

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
