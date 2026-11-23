import { describe, expect, it, vi } from 'vitest';
import { SOURCES_CHANNELS } from '../shared/sources-ipc.ts';
import { createSourcesBridge } from './sources-bridge.ts';

describe('createSourcesBridge (#51)', () => {
  it('invokes clipboard and playlist picker channels and validates replies', async () => {
    const bytes = new Uint8Array([35, 69, 88, 84]);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === SOURCES_CHANNELS.readClipboardText) return 'https://example.test/a.m3u';
      if (channel === SOURCES_CHANNELS.pickPlaylistFile) return { name: 'a.m3u', bytes };
      return null;
    });
    const bridge = createSourcesBridge({ invoke });
    expect(Object.isFrozen(bridge)).toBe(true);

    expect(await bridge.readClipboardText()).toBe('https://example.test/a.m3u');
    expect(await bridge.pickPlaylistFile()).toEqual({ name: 'a.m3u', bytes });

    invoke.mockResolvedValueOnce(null);
    expect(await bridge.readClipboardText()).toBeNull();

    invoke.mockResolvedValueOnce(null);
    expect(await bridge.pickPlaylistFile()).toBeNull();

    invoke.mockResolvedValueOnce({ name: 'bad', bytes: 'not-bytes' } as never);
    await expect(bridge.pickPlaylistFile()).rejects.toThrow();
  });
});
