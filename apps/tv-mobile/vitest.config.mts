import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'config/**/*.test.ts',
      'src/gate/**/*.test.ts',
      'src/storage/**/*.test.ts',
      'src/catalog/**/*.test.ts',
    ],
  },
});
