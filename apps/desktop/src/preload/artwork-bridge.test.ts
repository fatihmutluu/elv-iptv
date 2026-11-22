import { describe, expect, it, vi } from 'vitest';
import { ARTWORK_CHANNELS, DEFAULT_ARTWORK_CACHE_BYTES } from '../shared/artwork-ipc.ts';
import { createArtworkBridge } from './artwork-bridge.ts';

describe('createArtworkBridge (#405)', () => {
  it('invokes artwork IPC channels cleanly and validates stats replies', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ARTWORK_CHANNELS.stats) {
        return { bytes: 1024, entries: 2, maxBytes: DEFAULT_ARTWORK_CACHE_BYTES };
      }
      return undefined;
    });

    const bridge = createArtworkBridge({ invoke });
    expect(Object.isFrozen(bridge)).toBe(true);

    await bridge.clear();
    expect(invoke).toHaveBeenCalledWith(ARTWORK_CHANNELS.clear);

    await bridge.setLimitBytes(64 * 1024 * 1024);
    expect(invoke).toHaveBeenCalledWith(ARTWORK_CHANNELS.setLimit, 64 * 1024 * 1024);

    const stats = await bridge.stats();
    expect(stats).toEqual({ bytes: 1024, entries: 2, maxBytes: DEFAULT_ARTWORK_CACHE_BYTES });
  });

  it('rejects malformed stats responses from main', async () => {
    const invoke = vi.fn(async () => ({ bytes: 'nope' }));
    const bridge = createArtworkBridge({ invoke });
    await expect(bridge.stats()).rejects.toThrow(/unexpected reply/);
  });
});
