module.exports = {
  preset: 'jest-expo',
  // Tests run on fake timers; the timeout only catches hangs. A cold CI runner spends seconds on the first render.
  testTimeout: 20_000,
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}'],
};
