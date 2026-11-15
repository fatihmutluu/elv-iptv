/**
 * Installs standard ES globals that Hermes leaves `undefined` (`Symbol.asyncIterator`) before any
 * Babel `_AsyncGenerator` helper or library module initializes.
 */
export function installRuntimePolyfills(sym: { asyncIterator?: symbol } = Symbol): void {
  if (typeof sym.asyncIterator !== 'symbol') {
    Object.defineProperty(sym, 'asyncIterator', {
      value: Symbol.for('Symbol.asyncIterator'),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

installRuntimePolyfills();
