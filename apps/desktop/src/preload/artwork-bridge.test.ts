import { describe, expect, it, vi } from 'vitest';
import { ARTWORK_CHANNELS, DEFAULT_ARTWORK_CACHE_BYTES } from '../shared/artwork-ipc.ts';
import { createArtworkBridge } from './artwork-bridge.ts';

const SAMPLE_ARTWORK_URL = `elv-art://cache/${'a'.repeat(64)}`;

describe('createArtworkBridge (#405)', () => {
  it('invokes artwork IPC channels cleanly and validates resolve + stats replies', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ARTWORK_CHANNELS.stats) {
        return { bytes: 1024, entries: 2, maxBytes: DEFAULT_ARTWORK_CACHE_BYTES };
      }
      if (channel === ARTWORK_CHANNELS.resolve) {
        return SAMPLE_ARTWORK_URL;
      }
      return undefined;
    });

    const bridge = createArtworkBridge({ invoke });
    expect(Object.isFrozen(bridge)).toBe(true);

    await bridge.clear();
    expect(invoke).toHaveBeenCalledWith(ARTWORK_CHANNELS.clear);

    expect(await bridge.resolve('https://cdn.example/poster.jpg')).toBe(SAMPLE_ARTWORK_URL);
    expect(invoke).toHaveBeenCalledWith(ARTWORK_CHANNELS.resolve, 'https://cdn.example/poster.jpg');

    await bridge.setLimitBytes(64 * 1024 * 1024);
    expect(invoke).toHaveBeenCalledWith(ARTWORK_CHANNELS.setLimit, 64 * 1024 * 1024);

    const stats = await bridge.stats();
    expect(stats).toEqual({ bytes: 1024, entries: 2, maxBytes: DEFAULT_ARTWORK_CACHE_BYTES });
  });

  it('returns null when artwork:resolve returns null and rejects malformed replies from main', async () => {
    const nullBridge = createArtworkBridge({ invoke: vi.fn(async () => null) });
    expect(await nullBridge.resolve('https://cdn.example/miss.jpg')).toBeNull();

    const badResolveBridge = createArtworkBridge({
      invoke: vi.fn(async () => 'file:///etc/passwd'),
    });
    await expect(badResolveBridge.resolve('https://cdn.example/bad.jpg')).rejects.toThrow(
      /unexpected reply/,
    );

    const badStatsBridge = createArtworkBridge({ invoke: vi.fn(async () => ({ bytes: 'nope' })) });
    await expect(badStatsBridge.stats()).rejects.toThrow(/unexpected reply/);
  });
});
