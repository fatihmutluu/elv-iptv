import { describe, expect, it } from 'vitest';
import { chunksOf, everySplit, randomSplits, utf8 } from './test-chunks';

async function collect(it: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const c of it) out.push([...c]);
  return out;
}

describe('test chunk helpers', () => {
  const bytes = Uint8Array.of(1, 2, 3, 4, 5);

  it('chunksOf follows sizes and appends the remainder', async () => {
    expect(await collect(chunksOf(bytes, [2, 1]))).toEqual([[1, 2], [3], [4, 5]]);
    expect(await collect(chunksOf(bytes, [9, 1]))).toEqual([[1, 2, 3, 4, 5]]);
  });

  it('everySplit yields one split per offset', async () => {
    const splits = [...everySplit(bytes)];
    expect(splits).toHaveLength(6);
    for (const s of splits) expect((await collect(s)).flat()).toEqual([1, 2, 3, 4, 5]);
  });

  it('randomSplits is deterministic and lossless', async () => {
    const big = new Uint8Array(1000).map((_, i) => i & 0xff);
    const a = await collect(randomSplits(big, 7, 10));
    expect(a).toEqual(await collect(randomSplits(big, 7, 10)));
    expect(a.flat()).toEqual([...big]);
    expect(a.every((c) => c.length >= 1 && c.length <= 10)).toBe(true);
    expect(utf8('é')).toEqual(Uint8Array.of(0xc3, 0xa9));
  });
});
