import { describe, expect, it } from 'vitest';
import { installRuntimePolyfills } from '../polyfills';

describe('installRuntimePolyfills', () => {
  it('defines Symbol.asyncIterator via Symbol.for when missing (Hermes runtime)', () => {
    const target: { asyncIterator?: symbol } = {};
    installRuntimePolyfills(target);
    expect(target.asyncIterator).toBe(Symbol.for('Symbol.asyncIterator'));
    const descriptor = Object.getOwnPropertyDescriptor(target, 'asyncIterator');
    expect(descriptor?.enumerable).toBe(false);
  });

  it('leaves an existing Symbol.asyncIterator untouched', () => {
    const existing = Symbol('existing-async-iterator');
    const target: { asyncIterator?: symbol } = { asyncIterator: existing };
    installRuntimePolyfills(target);
    expect(target.asyncIterator).toBe(existing);
  });
});
