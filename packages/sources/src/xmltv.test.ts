import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunksOf, randomSplits, utf8 } from './test-chunks';
import { scanXmltv, type XmltvProgramme } from './xmltv';
import { collect, D, expectSameEverywhere, guide, whole } from './xmltv-test-helpers';

describe('scanXmltv content', () => {
  it('reads channels and programmes', async () => {
    const text = guide(
      `<channel id="a.example"><display-name>Alpha</display-name><display-name lang="de">Alpha DE</display-name><icon src="http://img.example/a.png"/><url>http://x.example</url></channel>` +
        `<channel id="b.example"><display-name>Beta</display-name></channel>` +
        `<programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="a.example">` +
        `<title lang="en">Morning</title><sub-title>Part one</sub-title><desc>Some text</desc>` +
        `<credits><actor>Someone</actor></credits><category>News</category><category>Live</category>` +
        `<episode-num system="onscreen">S1 E2</episode-num><icon src="http://img.example/p.png"/>` +
        `<rating system="x"><value>PG</value><icon src="http://img.example/rating.png"/></rating></programme>` +
        `<programme start="20260101010000 +0000" channel="b.example"><title>No stop</title></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.channels).toEqual([
      { id: 'a.example', names: ['Alpha', 'Alpha DE'], icon: 'http://img.example/a.png' },
      { id: 'b.example', names: ['Beta'] },
    ]);
    expect(r.programmes).toEqual([
      {
        channel: 'a.example',
        start: D('0000'),
        stop: D('0100'),
        title: 'Morning',
        subTitle: 'Part one',
        desc: 'Some text',
        categories: ['News', 'Live'],
        episodeNum: 'S1 E2',
        icon: 'http://img.example/p.png',
      },
      { channel: 'b.example', start: D('0100'), title: 'No stop', categories: [] },
    ]);
    expect(r.stats?.entries).toBe(4);
    expect(r.stats?.warnings).toEqual([]);
  });

  it('tolerates the prolog, comments, quote styles and attribute order', async () => {
    const text =
      `﻿<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<!-- a <programme start="x"> comment -->\n` +
      `<tv>\n<!-- <channel id="no"> -->\n<channel id='q'><display-name>Q</display-name></channel>\n` +
      `<programme channel='q' stop='20260101020000 +0100' start='20260101010000 +0100' >\n  <!-- c -->\n  <title>T</title>\n</programme>\n` +
      `<programme channel="q" start="20260101030000 +0100"  unknown = "1" ><title>U</title><unknown-el a="b">x</unknown-el></programme>\n</tv>`;
    const r = await expectSameEverywhere(text);
    expect(r.channels.map((c) => c.id)).toEqual(['q']);
    expect(r.programmes.map((p) => [p.title, p.start, p.stop])).toEqual([
      ['T', Date.UTC(2026, 0, 1, 0), Date.UTC(2026, 0, 1, 1)],
      ['U', Date.UTC(2026, 0, 1, 2), undefined],
    ]);
    expect(r.stats?.warnings).toEqual([]);
  });

  it('decodes entities, numeric entities and CDATA; the first title wins', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c&amp;d">` +
        `<title>A &amp; B &lt;x&gt; &#233; &#x4E2D; &quot;q&quot; &unknown;</title><title lang="fr">Second</title>` +
        `<desc><![CDATA[Raw <b>&amp;</b> text]]> and &apos;more&apos;</desc><desc>other</desc></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes[0]?.channel).toBe('c&d');
    expect(r.programmes[0]?.title).toBe('A & B <x> é 中 "q" &unknown;');
    expect(r.programmes[0]?.desc).toBe("Raw <b>&amp;</b> text and 'more'");
  });

  it('keeps multi-byte text across chunk boundaries', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c"><title>é中\u{1f600}x</title></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes[0]?.title).toBe('é中\u{1f600}x');
  });

  it('handles self-closing elements, nested tags in text and empty values', async () => {
    const text = guide(
      `<channel id="s"/><channel id="e"><display-name></display-name><icon/></channel>` +
        `<programme start="20260101000000" channel="s"/>` +
        `<programme start="20260101000000" channel="s"><title>Has <i>tag</i><!-- c --> text</title><category> </category><desc/></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.channels).toEqual([
      { id: 's', names: [] },
      { id: 'e', names: [] },
    ]);
    expect(r.programmes.map((p) => p.title)).toEqual(['', 'Has tag text']);
    expect(r.programmes[1]?.categories).toEqual([]);
  });

  it('handles a DOCTYPE with an internal subset', async () => {
    const text = `<?xml version="1.0"?><!DOCTYPE tv [ <!ELEMENT tv (channel)*> <!ENTITY x "<y>"> ]><tv><channel id="z"><display-name>Z</display-name></channel></tv>`;
    const r = await expectSameEverywhere(text);
    expect(r.channels.map((c) => c.id)).toEqual(['z']);
  });
});

describe('scanXmltv filters', () => {
  const text = guide(
    `<channel id="keep"><display-name>K</display-name></channel><channel id="drop"><display-name>D</display-name></channel>` +
      `<programme start="20260101000000" stop="20260101010000" channel="keep"><title>P1</title></programme>` +
      `<programme start="20260101010000" stop="20260101020000" channel="drop"><title>P2</title></programme>` +
      `<programme start="20260101020000" stop="20260101030000" channel="keep"><title>P3</title></programme>` +
      `<programme start="20260101030000" stop="20260101040000" channel="keep"><title>P4</title></programme>` +
      `<programme start="20260101050000" channel="keep"><title>P5 no stop</title></programme>`,
  );

  it('keeps only the wanted channels', async () => {
    const r = await expectSameEverywhere(text, { channels: new Set(['keep']) });
    expect(r.channels.map((c) => c.id)).toEqual(['keep']);
    expect(r.programmes.map((p) => p.title)).toEqual(['P1', 'P3', 'P4', 'P5 no stop']);
    expect(r.stats?.skipped).toBe(0);
  });

  it('drops programmes outside the window and keeps overlapping ones', async () => {
    const r = await collect(whole(text), { from: D('0230'), to: D('0300') + 1 });
    expect(r.programmes.map((p) => p.title)).toEqual(['P3', 'P4']);
    const edge = await collect(whole(text), { from: D('0100'), to: D('0300') });
    expect(edge.programmes.map((p) => p.title)).toEqual(['P2', 'P3']);
    const open = await collect(whole(text), { from: D('0450') });
    expect(open.programmes.map((p) => p.title)).toEqual(['P5 no stop']);
    const early = await collect(whole(text), { to: D('0100') });
    expect(early.programmes.map((p) => p.title)).toEqual(['P1']);
    const late = await collect(whole(text), { from: D('0510') });
    expect(late.programmes).toEqual([]);
  });

  it('does not look into the text of filtered programmes', async () => {
    const bad = guide(
      `<programme start="20260101000000" channel="x"><title>unclosed child of a filtered programme</programme>` +
        `<programme start="20260101000000" channel="y"><title>Wanted</title></programme>`,
    );
    const r = await collect(whole(bad), { channels: new Set(['y']) });
    expect(r.programmes.map((p) => p.title)).toEqual(['Wanted']);
    expect(r.stats?.skipped).toBe(0);
  });
});

describe('scanXmltv batching', () => {
  const many = (n: number): string =>
    guide(
      `<channel id="c"><display-name>C</display-name></channel>` +
        Array.from(
          { length: n },
          (_, i) =>
            `<programme start="20260101000000" channel="c"><title>P${i}</title></programme>\n`,
        ).join(''),
    );

  it('counts programmes and ends with stats and done', async () => {
    const batches = [];
    const gen = scanXmltv(chunksOf(utf8(many(25)), [300, 300]), { batchSize: 10 });
    for (;;) {
      const r = await gen.next();
      if (r.done) {
        expect(r.value).toEqual({ ok: true, value: undefined });
        break;
      }
      batches.push(r.value);
    }
    expect(batches.map((b) => b.programmes.length)).toEqual([10, 10, 5]);
    expect(batches.map((b) => b.done)).toEqual([false, false, true]);
    expect(batches[0]?.channels).toHaveLength(1);
    expect(batches.slice(0, 2).every((b) => b.stats === undefined)).toBe(true);
    expect(batches[2]?.stats?.entries).toBe(26);
  });

  it('yields the first batch before the input ends', async () => {
    const bytes = utf8(many(100));
    let read = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i * 500 < bytes.length; i++) {
        read++;
        yield bytes.slice(i * 500, (i + 1) * 500);
      }
    }
    const first = await scanXmltv(source(), { batchSize: 10 }).next();
    expect(first.done).toBe(false);
    expect(read).toBeLessThan(Math.ceil(bytes.length / 500));
  });

  it('gives the same result for random splits and any batch size', async () => {
    const text = many(40);
    const base = await collect(whole(text), { batchSize: 1 });
    expect(base.batches.slice(0, 40).every((n) => n === 1)).toBe(true);
    for (const seed of [1, 2, 3]) {
      const r = await collect(randomSplits(utf8(text), seed, 64), { batchSize: 7 });
      expect(r.programmes).toEqual(base.programmes);
    }
    const clamped = await collect(whole(text), { batchSize: 0 });
    expect(clamped.programmes).toHaveLength(40);
  });
});

const esc = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

describe('scanXmltv property', () => {
  const chars = ['a', 'Z', ' ', '&', '<', '>', '"', "'", 'é', '中', '\u{1f600}', '1'];
  const word = fc
    .array(fc.constantFrom(...chars), { maxLength: 12 })
    .map((a) => a.join('').trim())
    .filter((s) => s.length > 0);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const fmt = (sec: number, off: number): string => {
    const d = new Date(sec * 1000 + off * 3_600_000);
    return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} ${off < 0 ? '-' : '+'}${pad(Math.abs(off))}00`;
  };

  it('round-trips generated guides', async () => {
    const programme = fc.record({
      channel: word,
      start: fc.integer({ min: Date.UTC(2000, 0, 1) / 1000, max: Date.UTC(2040, 0, 1) / 1000 }),
      len: fc.option(fc.integer({ min: 60, max: 36000 }), { nil: undefined }),
      offset: fc.integer({ min: -12, max: 14 }),
      title: word,
      desc: fc.option(word, { nil: undefined }),
      categories: fc.array(word, { maxLength: 3 }),
      cdata: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(programme, { maxLength: 6 }),
        fc.integer({ min: 1, max: 1000 }),
        async (items, seed) => {
          let xml = '';
          const expected: XmltvProgramme[] = [];
          for (const it of items) {
            const stop = it.len === undefined ? undefined : it.start + it.len;
            const title = it.cdata ? `<![CDATA[${it.title}]]>` : esc(it.title);
            const stopAttr = stop === undefined ? '' : ` stop="${fmt(stop, it.offset)}"`;
            const desc = it.desc === undefined ? '' : `<desc>${esc(it.desc)}</desc>`;
            const cats = it.categories.map((c) => `<category>${esc(c)}</category>`).join('');
            xml += `<programme start="${fmt(it.start, it.offset)}"${stopAttr} channel="${esc(it.channel)}"><title>${title}</title>${desc}${cats}</programme>\n`;
            const p: XmltvProgramme = {
              channel: it.channel,
              start: it.start * 1000,
              title: it.title,
              categories: it.categories,
            };
            if (stop !== undefined) p.stop = stop * 1000;
            if (it.desc !== undefined) p.desc = it.desc;
            expected.push(p);
          }
          const r = await collect(randomSplits(utf8(guide(xml)), seed, 17));
          expect(r.programmes).toEqual(expected);
        },
      ),
      { numRuns: 60 },
    );
  });
});
