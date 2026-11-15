import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/ports/**/*.ts',
        'src/browse/paged-list-source.ts',
        'src/browse/browse-model.ts',
        'src/sources/validate.ts',
        'src/sources/errors.ts',
        'src/sources/lazy-catalog.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
