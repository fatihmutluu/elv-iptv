import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/main/player/mpv/codec.ts',
        'src/main/player/mpv/client.ts',
        'src/main/player/mpv/process.ts',
      ],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
