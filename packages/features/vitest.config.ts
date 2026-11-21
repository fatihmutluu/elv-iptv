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
        'src/live/live-model.ts',
        'src/catalog/catalog-model.ts',
        'src/detail/detail-model.ts',
        'src/detail/episode-chunks.ts',
        'src/search/search-model.ts',
        'src/browse/browse-model.ts',
        'src/player/errors.ts',
        'src/player/player-overlay-model.ts',
        'src/player/settings-menu-nav.ts',
        'src/sources/validate.ts',
        'src/sources/errors.ts',
        'src/sources/lazy-catalog.ts',
        'src/sources/account-warning.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
