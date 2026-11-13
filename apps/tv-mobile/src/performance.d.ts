/** React Native provides a monotonic `performance.now()`; the UI tsconfig has no DOM lib to declare it. */
declare const performance: { now(): number };
