import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/ports/**/*.ts', 'src/sources/validate.ts', 'src/sources/errors.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
