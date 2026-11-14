import type { Decompressor } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { chunksOf, randomSplits, utf8 } from './test-chunks';
import { scanXmltv } from './xmltv';
import { collect, expectSameEverywhere, guide, gunzipper, gzip, whole } from './xmltv-test-helpers';

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

  it('fails on a corrupt gzip stream without a done batch', async () => {
    const zipped = await gzip(utf8(text));
    const cut = zipped.slice(0, zipped.length - 12);
    const r = await collect(chunksOf(cut, [cut.length]), { decompressor: gunzipper });
    expect(r.result).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'gzip-corrupt' },
    });
    expect(r.stats).toBeUndefined();
  });

  it('treats short and empty inputs as plain', async () => {
    const one = await collect(chunksOf(utf8('<'), [1]), { decompressor: gunzipper });
    expect(one.programmes).toEqual([]);
    const empty = await collect(chunksOf(new Uint8Array(0), []), { decompressor: gunzipper });
    expect(empty.stats?.entries).toBe(0);
    expect(empty.result).toEqual({ ok: true, value: undefined });
  });
});

async function* failing(first: Uint8Array, error: unknown): AsyncGenerator<Uint8Array> {
  yield first;
  throw error;
}

describe('scanXmltv input failures', () => {
  const body = guide('<programme start="20260101000000" channel="c"><title>T</title></programme>');
  const network = { category: 'network', code: 'aborted' };

  it('returns an unknown input error as network/stream-failed, never as done', async () => {
    const r = await collect(failing(utf8(body.slice(0, 40)), new Error('socket hang up')));
    expect(r.result).toEqual({ ok: false, error: { category: 'network', code: 'stream-failed' } });
    expect(r.stats).toBeUndefined();
  });

  it('keeps the category and code of an ElvError-shaped input error', async () => {
    const r = await collect(failing(utf8(body.slice(0, 40)), { ...network, detail: 'x' }));
    expect(r.result).toEqual({ ok: false, error: { ...network, detail: 'x' } });
  });

  it('applies the same rule on the gzip path', async () => {
    const zipped = await gzip(utf8(body));
    const r = await collect(failing(zipped.slice(0, 20), network), { decompressor: gunzipper });
    expect(r.result).toEqual({ ok: false, error: network });
    expect(r.stats).toBeUndefined();
  });

  it('reports a failure before the first two bytes arrive', async () => {
    async function* nothing(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(0);
      throw network;
    }
    const r = await collect(nothing());
    expect(r.result).toEqual({ ok: false, error: network });
  });

  it('does not wrap a non-object throw as an ElvError', async () => {
    const r = await collect(failing(utf8('<tv>'), null));
    expect(r.result).toEqual({ ok: false, error: { category: 'network', code: 'stream-failed' } });
  });
});

describe('scanXmltv hostile bodies and error attribution', () => {
  /**
   * Time budget for scanning a hostile body of `size` characters: 2 s, or 20 times a well-formed guide of the same
   * size on a slow runner. A quadratic scan of these bodies is hundreds of times slower than the control, so the
   * check still catches it while a loaded CI machine no longer fails it.
   */
  async function linearBudget(size: number): Promise<number> {
    const filler = 'x'.repeat(Math.max(0, size - 200));
    const control = guide(
      `<programme start="20260101000000" channel="c"><title>${filler}</title></programme>`,
    );
    const t = performance.now();
    await collect(whole(control));
    return Math.max(2000, (performance.now() - t) * 20);
  }

  it('stays linear on a body of unclosed unknown tags and keeps the next programme', async () => {
    const unclosed = '<a>'.repeat(Math.floor(((1 << 20) - 4096) / 3));
    const text = guide(
      `<programme start="20260101000000" channel="c"><title>Hostile</title>${unclosed}</programme>` +
        `<programme start="20260101010000" channel="c"><title>Next</title></programme>`,
    );
    const budget = await linearBudget(text.length);
    const t0 = performance.now();
    const r = await collect(whole(text));
    expect(performance.now() - t0).toBeLessThan(budget);
    expect(r.programmes.map((p) => p.title)).toEqual(['Hostile', 'Next']);
    const distinct = Array.from({ length: 50000 }, (_, i) => `<x${i}>`).join('');
    const distinctText = guide(
      `<programme start="20260101000000" channel="c">${distinct}<title>T</title></programme>`,
    );
    const distinctBudget = await linearBudget(distinctText.length);
    const t1 = performance.now();
    const r2 = await collect(whole(distinctText));
    expect(performance.now() - t1).toBeLessThan(distinctBudget);
    expect(r2.programmes.map((p) => p.title)).toEqual(['T']);
  });

  it('reads fields after an unclosed unknown tag and never takes a nested icon', async () => {
    const text = guide(
      `<programme start="20260101000000" channel="c"><br><rating><icon src="r.png"/></rating><title>T</title><icon src="p.png"/></programme>`,
    );
    const r = await collect(whole(text));
    expect(r.programmes[0]?.title).toBe('T');
    expect(r.programmes[0]?.icon).not.toBe('r.png');
  });

  it('lets scanner bugs propagate instead of reporting them as input errors', async () => {
    const boom = {
      has: () => {
        throw new RangeError('scanner bug');
      },
    } as unknown as ReadonlySet<string>;
    const text = guide(
      '<programme start="20260101000000" channel="c"><title>T</title></programme>',
    );
    await expect(collect(whole(text), { channels: boom })).rejects.toThrow('scanner bug');
  });

  it('reports a source error that a decompressor swallowed', async () => {
    const zipped = await gzip(
      utf8(guide('<programme start="20260101000000" channel="c"><title>T</title></programme>')),
    );
    const swallowing: Decompressor = {
      async *gunzip(chunks) {
        try {
          for await (const c of chunks) yield c;
        } catch {
          return;
        }
      },
    };
    const r = await collect(failing(zipped, { category: 'network', code: 'aborted' }), {
      decompressor: swallowing,
    });
    expect(r.result).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(r.stats).toBeUndefined();
  });
});
