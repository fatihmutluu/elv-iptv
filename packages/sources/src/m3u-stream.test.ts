import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type M3uBatch, type M3uEntry, scanM3u } from './m3u';
import type { ScanStats } from './stats';
import { chunksOf, randomSplits, utf8 } from './test-chunks';

async function collect(
  chunks: AsyncIterable<Uint8Array>,
  opts?: { batchSize?: number },
): Promise<{ entries: M3uEntry[]; batches: number[]; stats?: ScanStats }> {
  const out: { entries: M3uEntry[]; batches: number[]; stats?: ScanStats } = {
    entries: [],
    batches: [],
  };
  for await (const batch of scanM3u(chunks, opts)) {
    out.entries.push(...batch.entries);
    out.batches.push(batch.entries.length);
    if (batch.stats) out.stats = batch.stats;
  }
  return out;
}

const generate = (count: number): string => {
  let text = '#EXTM3U\r\n';
  for (let i = 0; i < count; i++) {
    text += `#EXTINF:-1 xui-id="${i}" tvg-id="c${i}" group-title="G${i % 7}",Channel ${i}\r\nhttp://h.example/live/${i}.ts\r\n`;
  }
  return text;
};

describe('scanM3u batching and chunking', () => {
  it('yields batches of batchSize with header and stats only on the last', async () => {
    const batches: M3uBatch[] = [];
    const chunks = chunksOf(utf8(generate(1201)), [4096, 4096]);
    for await (const b of scanM3u(chunks, { batchSize: 500 })) batches.push(b);
    expect(batches.map((b) => b.entries.length)).toEqual([500, 500, 201]);
    expect(batches.map((b) => b.done)).toEqual([false, false, true]);
    expect(batches.slice(0, 2).every((b) => !b.header && !b.stats)).toBe(true);
    expect(batches[2]?.stats?.entries).toBe(1201);
    expect(batches[2]?.header).toBeDefined();
  });

  it('ends with an empty done batch when the count is an exact multiple', async () => {
    const bytes = utf8(generate(1000));
    const r = await collect(chunksOf(bytes, [bytes.length]), { batchSize: 500 });
    expect(r.batches).toEqual([500, 500, 0]);
  });

  it('yields the first batch before the last chunk is read', async () => {
    const bytes = utf8(generate(1201));
    let read = 0;
    const total = Math.ceil(bytes.length / 1000);
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < total; i++) {
        read++;
        yield bytes.slice(i * 1000, (i + 1) * 1000);
      }
    }
    const first = await scanM3u(source(), { batchSize: 500 }).next();
    expect((first.value as M3uBatch).entries).toHaveLength(500);
    expect(read).toBeLessThan(total);
  });

  it('gives identical output for random chunkings of a 5,000-entry playlist', async () => {
    const bytes = utf8(generate(5000));
    const whole = await collect(chunksOf(bytes, [bytes.length]));
    expect(whole.entries).toHaveLength(5000);
    for (const seed of [1, 2, 3]) {
      const got = await collect(randomSplits(bytes, seed, 700));
      expect(got.entries).toEqual(whole.entries);
      expect(got.stats).toEqual(whole.stats);
    }
  });

  it('copes with tiny chunks and small batches', async () => {
    const bytes = utf8(generate(300));
    const sizes = Array.from({ length: bytes.length }, () => 3);
    const r = await collect(chunksOf(bytes, sizes), { batchSize: 50 });
    expect(r.entries).toHaveLength(300);
    expect(r.batches).toEqual([50, 50, 50, 50, 50, 50, 0]);
  });
});

describe('scanM3u property', () => {
  const chars = [...'abcXYZ019 ,;"\'=:/.-_éüß日本😀'];
  const text = fc.string({ unit: fc.constantFrom(...chars), minLength: 1, maxLength: 12 });
  const value = text.filter((s) => !s.includes('"') && s === s.trim());
  const token = fc.string({ unit: fc.constantFrom(...'abc09-_é日'), minLength: 1, maxLength: 8 });
  const name = text.filter((s) => s === s.trim());
  const entry = fc.record({
    name,
    tvgId: fc.option(value, { nil: undefined }),
    tvgName: fc.option(value, { nil: undefined }),
    chno: fc.option(fc.integer({ min: 0, max: 9999 }), { nil: undefined }),
    groups: fc.array(token, { maxLength: 3 }),
    extra: fc.option(value, { nil: undefined }),
    path: token,
  });

  it('round-trips written entries under random chunking', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entry, { maxLength: 8 }),
        fc.integer({ min: 1, max: 1000 }),
        async (entries, seed) => {
          let out = '#EXTM3U\n';
          for (const e of entries) {
            const attrs = [
              e.tvgId === undefined ? '' : ` tvg-id="${e.tvgId}"`,
              e.tvgName === undefined ? '' : ` tvg-name="${e.tvgName}"`,
              e.chno === undefined ? '' : ` tvg-chno="${e.chno}"`,
              e.groups.length === 0 ? '' : ` group-title="${e.groups.join(';')}"`,
              e.extra === undefined ? '' : ` xui-id="${e.extra}"`,
            ].join('');
            out += `#EXTINF:-1${attrs},${e.name}\nhttp://h.example/${e.path}\n`;
          }
          const got = await collect(randomSplits(utf8(out), seed, 16));
          expect(got.entries).toHaveLength(entries.length);
          entries.forEach((e, i) => {
            const g = got.entries[i] as M3uEntry;
            expect(g.name).toBe(e.name);
            expect(g.tvgId).toBe(e.tvgId);
            expect(g.tvgName).toBe(e.tvgName);
            expect(g.chno).toBe(e.chno);
            expect(g.groups).toEqual(e.groups);
            expect(g.extra).toEqual(e.extra === undefined ? {} : { 'xui-id': e.extra });
            expect(g.url).toBe(`http://h.example/${e.path}`);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
