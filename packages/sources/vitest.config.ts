import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-chunks.ts', 'src/**/*-test-helpers.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
