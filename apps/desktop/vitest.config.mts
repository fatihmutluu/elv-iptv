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
        'src/main/player/mpv/options.ts',
        'src/main/player/mpv/errors.ts',
        'src/main/player/mpv/redact.ts',
        'src/main/player/presenter/*.ts',
        'src/main/player/engine.ts',
        'src/main/player/ipc.ts',
        'src/main/player/runtime-path.ts',
        'src/preload/player-bridge.ts',
        'src/shared/*.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90 },
    },
  },
});
