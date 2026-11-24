import type { TvHomeChannelDescriptor } from '@elv/features';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supported: true,
  syncTvHomeChannels: vi.fn(),
  clearTvHomeChannels: vi.fn(),
}));

vi.mock('@elv/tv-home-channels', () => ({
  isTvHomeChannelsSupported: () => mocks.supported,
  syncTvHomeChannels: (...args: unknown[]) => mocks.syncTvHomeChannels(...args),
  clearTvHomeChannels: (...args: unknown[]) => mocks.clearTvHomeChannels(...args),
}));

import { createTvHomeChannelsPort } from './adapter';

beforeEach(() => {
  mocks.supported = true;
  mocks.syncTvHomeChannels.mockReset().mockResolvedValue({
    supported: true,
    syncedChannels: 2,
    syncedPrograms: 5,
  });
  mocks.clearTvHomeChannels.mockReset().mockResolvedValue(undefined);
});

describe('createTvHomeChannelsPort', () => {
  const sampleChannels: readonly TvHomeChannelDescriptor[] = [
    {
      internalId: 'continue_watching',
      displayName: 'Continue Watching',
      isDefaultBrowsable: true,
      programs: [
        {
          itemKey: 'movie:123',
          title: 'Synthetic Film',
          kind: 'movie',
          durationMs: 7_200_000,
          lastPlaybackPositionMs: 1_200_000,
        },
      ],
    },
    {
      internalId: 'favorites',
      displayName: 'Favorites',
      programs: [
        {
          itemKey: 'live:ch1',
          title: 'News 24',
          kind: 'live',
          isLive: true,
        },
      ],
    },
  ];

  it('mirrors isTvHomeChannelsSupported()', () => {
    const port = createTvHomeChannelsPort();
    mocks.supported = true;
    expect(port.isSupported()).toBe(true);
    mocks.supported = false;
    expect(port.isSupported()).toBe(false);
  });

  it('forwards syncChannels and clearChannels to @elv/tv-home-channels when supported', async () => {
    const port = createTvHomeChannelsPort();
    const result = await port.syncChannels(sampleChannels);
    expect(mocks.syncTvHomeChannels).toHaveBeenCalledWith(sampleChannels);
    expect(result).toEqual({
      supported: true,
      syncedChannels: 2,
      syncedPrograms: 5,
    });

    await port.clearChannels();
    expect(mocks.clearTvHomeChannels).toHaveBeenCalledTimes(1);
  });

  it('short-circuits syncChannels and clearChannels without calling native when unsupported', async () => {
    mocks.supported = false;
    const port = createTvHomeChannelsPort();
    const result = await port.syncChannels(sampleChannels);
    expect(result).toEqual({
      supported: false,
      syncedChannels: 0,
      syncedPrograms: 0,
    });
    expect(mocks.syncTvHomeChannels).not.toHaveBeenCalled();

    await port.clearChannels();
    expect(mocks.clearTvHomeChannels).not.toHaveBeenCalled();
  });
});
