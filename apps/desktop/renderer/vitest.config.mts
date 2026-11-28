import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: [
        'src/catalog/desktop-catalog.ts',
        'src/player/**/*.ts',
        'src/gate/params.ts',
        'src/gate/metrics.ts',
        'src/gate/driver.ts',
        'src/workbench/remote-catalog.ts',
      ],
      exclude: ['src/**/*.test.{ts,tsx}'],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
