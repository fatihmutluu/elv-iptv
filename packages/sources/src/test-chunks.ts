/** Test encoder: UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Yields `bytes` as consecutive chunks of the given sizes; the remainder forms a last chunk. */
export async function* chunksOf(
  bytes: Uint8Array,
  sizes: readonly number[],
): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) return;
    yield bytes.slice(offset, offset + size);
    offset += size;
  }
  if (offset < bytes.length) yield bytes.slice(offset);
}

/** Every two-chunk split of `bytes`, one per offset from 0 to `bytes.length` inclusive. */
export function everySplit(bytes: Uint8Array): Iterable<AsyncIterable<Uint8Array>> {
  const splits: AsyncIterable<Uint8Array>[] = [];
  for (let at = 0; at <= bytes.length; at++) {
    splits.push(chunksOf(bytes, [at, bytes.length - at]));
  }
  return splits;
}

/** Splits `bytes` into pseudo-random chunks of 1..`max` bytes, reproducible from `seed`. */
export function randomSplits(bytes: Uint8Array, seed: number, max = 64): AsyncIterable<Uint8Array> {
  let state = seed >>> 0 || 1;
  const sizes: number[] = [];
  let total = 0;
  while (total < bytes.length) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const size = 1 + (state % max);
    sizes.push(size);
    total += size;
  }
  return chunksOf(bytes, sizes);
}
