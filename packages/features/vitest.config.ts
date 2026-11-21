import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/ports/**/*.ts',
        'src/shared/**/*.ts',
        'src/home/home-model.ts',
        'src/catalog/catalog-model.ts',
        'src/detail/detail-model.ts',
        'src/search/search-model.ts',
        'src/browse/browse-model.ts',
        'src/player/errors.ts',
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
