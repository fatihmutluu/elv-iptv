import { describe, expect, it } from 'vitest';
import { isAsyncIterable, openAsyncIterator } from './async-iterable';

async function withoutSymbolAsyncIterator<T>(fn: () => Promise<T> | T): Promise<T> {
  const OriginalSymbol = globalThis.Symbol;
  const FakeSymbol = Object.assign(
    ((description?: string | number) => OriginalSymbol(description)) as typeof Symbol,
    {
      for: OriginalSymbol.for.bind(OriginalSymbol),
      keyFor: OriginalSymbol.keyFor.bind(OriginalSymbol),
      iterator: OriginalSymbol.iterator,
      toStringTag: OriginalSymbol.toStringTag,
      asyncIterator: undefined as unknown as typeof Symbol.asyncIterator,
    },
  );
  (globalThis as { Symbol: typeof Symbol }).Symbol = FakeSymbol;
  try {
    return await fn();
  } finally {
    (globalThis as { Symbol: typeof Symbol }).Symbol = OriginalSymbol;
  }
}

describe('isAsyncIterable & openAsyncIterator', () => {
  it('recognizes standard [Symbol.asyncIterator] iterables and rejects non-iterables', async () => {
    expect(isAsyncIterable(null)).toBe(false);
    expect(isAsyncIterable(undefined)).toBe(false);
    expect(isAsyncIterable(42)).toBe(false);
    expect(isAsyncIterable('abc')).toBe(false);
    expect(isAsyncIterable({})).toBe(false);
    expect(isAsyncIterable({ getReader: () => ({}) })).toBe(false);

    async function* gen() {
      yield 1;
      yield 2;
    }
    const g = gen();
    expect(isAsyncIterable(g)).toBe(true);
    const it = openAsyncIterator(g);
    expect(await it.next()).toEqual({ done: false, value: 1 });
    expect(await it.next()).toEqual({ done: false, value: 2 });
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });

  it('falls back to Babel @@asyncIterator with receiver preserved when Symbol.asyncIterator is undefined', async () => {
    await withoutSymbolAsyncIterator(async () => {
      const proto = {
        '@@asyncIterator'(this: unknown) {
          return this;
        },
      };
      let step = 0;
      const babelGenerator = Object.assign(Object.create(proto), {
        next: async () =>
          step++ === 0 ? { done: false, value: 'chunk' } : { done: true, value: undefined },
      }) as AsyncIterable<string>;

      expect(isAsyncIterable(babelGenerator)).toBe(true);
      expect(isAsyncIterable({ getReader: () => ({}) })).toBe(false);

      const it = openAsyncIterator(babelGenerator);
      expect(it).toBe(babelGenerator);
      expect(await it.next()).toEqual({ done: false, value: 'chunk' });
      expect(await it.next()).toEqual({ done: true, value: undefined });
    });
  });

  it('throws TypeError when given an object with neither Symbol.asyncIterator nor @@asyncIterator', async () => {
    expect(() => openAsyncIterator({} as AsyncIterable<number>)).toThrow(TypeError);
    await withoutSymbolAsyncIterator(() => {
      expect(() => openAsyncIterator({} as AsyncIterable<number>)).toThrow(TypeError);
    });
  });
});
