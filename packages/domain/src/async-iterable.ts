const BABEL_ASYNC_ITERATOR = '@@asyncIterator';

/**
 * Returns whether `value` exposes an async iterator via `[Symbol.asyncIterator]` or Babel's
 * `'@@asyncIterator'` fallback (used when `Symbol.asyncIterator` is `undefined` in Hermes).
 */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const record = value as Record<PropertyKey, unknown>;
  if (
    typeof Symbol.asyncIterator === 'symbol' &&
    typeof record[Symbol.asyncIterator] === 'function'
  ) {
    return true;
  }
  return typeof record[BABEL_ASYNC_ITERATOR] === 'function';
}

/**
 * Opens an `AsyncIterator<T>` from `source`, preferring `[Symbol.asyncIterator]()` and falling
 * back to Babel's `'@@asyncIterator'()` method with `source` preserved as the receiver.
 */
export function openAsyncIterator<T>(source: AsyncIterable<T>): AsyncIterator<T> {
  const record = source as unknown as Record<PropertyKey, unknown>;
  if (typeof Symbol.asyncIterator === 'symbol') {
    const method = record[Symbol.asyncIterator];
    if (typeof method === 'function') {
      return (method as (this: unknown) => AsyncIterator<T>).call(source);
    }
  }
  const fallback = record[BABEL_ASYNC_ITERATOR];
  if (typeof fallback === 'function') {
    return (fallback as (this: unknown) => AsyncIterator<T>).call(source);
  }
  throw new TypeError('Value is not async iterable');
}
