import type { Decompressor } from '@elv/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ScanStats } from './stats';
import { chunksOf, everySplit, randomSplits, utf8 } from './test-chunks';
import { scanXmltv, type XmltvChannel, type XmltvOptions, type XmltvProgramme } from './xmltv';

interface Out {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  batches: number[];
  stats?: ScanStats;
  result?: unknown;
}

async function collect(chunks: AsyncIterable<Uint8Array>, opts?: XmltvOptions): Promise<Out> {
  const out: Out = { channels: [], programmes: [], batches: [] };
  const gen = scanXmltv(chunks, opts);
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      out.result = r.value;
      return out;
    }
    out.channels.push(...r.value.channels);
    out.programmes.push(...r.value.programmes);
    out.batches.push(r.value.programmes.length);
    if (r.value.stats) out.stats = r.value.stats;
  }
}

const whole = (text: string): AsyncIterable<Uint8Array> => {
  const bytes = utf8(text);
  return chunksOf(bytes, [bytes.length]);
};

async function expectSameEverywhere(text: string, opts?: XmltvOptions): Promise<Out> {
  const base = await collect(whole(text), opts);
  for (const split of everySplit(utf8(text))) {
    const r = await collect(split, opts);
    expect(r.channels).toEqual(base.channels);
    expect(r.programmes).toEqual(base.programmes);
    expect(r.stats?.warnings).toEqual(base.stats?.warnings);
  }
  return base;
}

const D = (s: string): number => Date.UTC(2026, 0, 1, Number(s.slice(0, 2)), Number(s.slice(2)));
const guide = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="t">${body}</tv>\n`;

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

describe('scanXmltv recovery', () => {
  it('skips a programme with an unclosed title and keeps the rest', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c"><title>Good 1</title></programme>\n` +
        `<programme start="20260101010000" channel="c"><title>Broken</programme>\n` +
        `<programme start="20260101020000" channel="c"><title>Good 2</title></programme>` +
        `<programme start="20260101030000" channel="c"><title>Good 3</title></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.title)).toEqual(['Good 1', 'Good 2', 'Good 3']);
    expect(r.stats?.skipped).toBe(1);
    expect(r.stats?.warnings).toHaveLength(1);
    expect(r.stats?.warnings[0]?.line).toBe(3);
  });

  it('skips an unclosed programme up to the next programme or channel', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c"><title>Open` +
        `<programme start="20260101010000" channel="c"><title>Next</title></programme>` +
        `<programme start="20260101020000" channel="c"><title>Open 2</title>` +
        `<channel id="after"><display-name>After</display-name></channel>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.title)).toEqual(['Next']);
    expect(r.channels.map((c) => c.id)).toEqual(['after']);
    expect(r.stats?.skipped).toBe(2);
    expect(r.stats?.warnings).toHaveLength(2);
  });

  it('skips programmes without start, channel or with invalid times', async () => {
    const text = guide(
      `<programme stop="20260101010000" channel="c"><title>No start</title></programme>` +
        `<programme start="20260101000000"><title>No channel</title></programme>` +
        `<programme start="2026-01-01" channel="c"><title>Bad start</title></programme>` +
        `<programme start="20260101000000" stop="soon" channel="c"><title>Bad stop</title></programme>` +
        `<programme start="20260101000000" channel="c"><title>Fine</title></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.title)).toEqual(['Fine']);
    expect(r.stats?.skipped).toBe(4);
    expect(r.stats?.warnings.map((w) => w.code)).toEqual([
      'programme-missing-start',
      'programme-missing-channel',
      'programme-bad-time',
      'programme-bad-time',
    ]);
  });

  it('skips a channel without id and a broken open tag', async () => {
    const text = guide(
      `<channel><display-name>Nameless</display-name></channel>` +
        `<programme start="20260101000000 channel="c"><title>Bad tag</title></programme>` +
        `<programme start="20260101000000" channel="c"><title>Fine</title></programme>`,
    );
    const r = await expectSameEverywhere(text);
    expect(r.channels).toEqual([]);
    expect(r.programmes.map((p) => p.title)).toEqual(['Fine']);
    expect(r.stats?.skipped).toBe(2);
  });

  it('drops a truncated last element with a warning', async () => {
    const text = `${guide(
      `<programme start="20260101000000" channel="c"><title>Ok</title></programme>`,
    ).replace('</tv>\n', '')}<programme start="20260101010000" channel="c"><title>Cut off`;
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.title)).toEqual(['Ok']);
    expect(r.stats?.warnings.map((w) => w.code)).toEqual(['programme-truncated']);
  });

  it('drops an element over the size cap and resumes after it', async () => {
    const filler = 'x'.repeat((1 << 20) + 10);
    const text = guide(
      `<programme start="20260101000000" channel="c"><title>${filler}</title></programme>` +
        `<programme start="20260101010000" channel="c"><title>After</title></programme>`,
    );
    const bytes = utf8(text);
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 8192) yield bytes.slice(i, i + 8192);
    }
    const r = await collect(source());
    expect(r.programmes.map((p) => p.title)).toEqual(['After']);
    expect(r.stats?.warnings.map((w) => w.code)).toEqual(['element-too-long']);
    const one = await collect(whole(text));
    expect(one.programmes.map((p) => p.title)).toEqual(['After']);
  });

  it('skips junk, stray closers and unterminated markup without losing later data', async () => {
    const text =
      `junk </stray> <![CDATA[ not <programme start="x"> ]]> <?pi x?><tv><a b="c>d">text</a>` +
      `<programme start="20260101000000" channel="c"><title>Fine</title></programme><!-- never closed`;
    const r = await expectSameEverywhere(text);
    expect(r.programmes.map((p) => p.title)).toEqual(['Fine']);
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

async function concat(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const gunzipper: Decompressor = {
  async *gunzip(chunks) {
    const data = await concat(chunks);
    const reader = new Blob([data as BlobPart])
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

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('scanXmltv gzip', () => {
  const text = guide(
    `<channel id="g"><display-name>G</display-name></channel><programme start="20260101000000" channel="g"><title>Zipped</title></programme>`,
  );

  it('decodes gzip through the decompressor, in any chunking', async () => {
    const plain = await collect(whole(text));
    const zipped = await gzip(utf8(text));
    for (const sizes of [[zipped.length], [1, 1, 1], [2, 5, 7]]) {
      const r = await collect(chunksOf(zipped, sizes), { decompressor: gunzipper });
      expect(r.channels).toEqual(plain.channels);
      expect(r.programmes).toEqual(plain.programmes);
    }
    const split = await collect(randomSplits(zipped, 7, 5), { decompressor: gunzipper });
    expect(split.programmes).toEqual(plain.programmes);
  });

  it('returns gzip-unsupported without a decompressor and yields nothing', async () => {
    const zipped = await gzip(utf8(text));
    const gen = scanXmltv(chunksOf(zipped, [1, zipped.length]));
    const first = await gen.next();
    expect(first.done).toBe(true);
    expect(first.value).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-unsupported' },
    });
  });

  it('turns a corrupt gzip stream into a warning and keeps what was read', async () => {
    const zipped = await gzip(utf8(text));
    const cut = zipped.slice(0, zipped.length - 12);
    const r = await collect(chunksOf(cut, [cut.length]), { decompressor: gunzipper });
    expect(r.stats?.warnings.map((w) => w.code)).toEqual(['gzip-corrupt']);
  });

  it('treats short and empty inputs as plain', async () => {
    const one = await collect(chunksOf(utf8('<'), [1]), { decompressor: gunzipper });
    expect(one.programmes).toEqual([]);
    const empty = await collect(chunksOf(new Uint8Array(0), []), { decompressor: gunzipper });
    expect(empty.stats?.entries).toBe(0);
    expect(empty.result).toEqual({ ok: true, value: undefined });
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
