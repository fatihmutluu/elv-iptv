import type {
  TvHomeChannelDescriptor,
  TvHomeChannelsPort,
  TvHomeChannelsSyncSummary,
} from '@elv/features';
import {
  clearTvHomeChannels,
  isTvHomeChannelsSupported,
  syncTvHomeChannels,
} from '@elv/tv-home-channels';

const UNSUPPORTED_SYNC_SUMMARY: TvHomeChannelsSyncSummary = {
  supported: false,
  syncedChannels: 0,
  syncedPrograms: 0,
};

/**
 * Creates the mobile/TV {@link TvHomeChannelsPort} bridging `@elv/tv-home-channels` (`#273`).
 * Safely short-circuits on non-Android platforms or Android devices without Leanback launcher support.
 */
export function createTvHomeChannelsPort(): TvHomeChannelsPort {
  return {
    isSupported(): boolean {
      return isTvHomeChannelsSupported();
    },

    async syncChannels(
      channels: readonly TvHomeChannelDescriptor[],
    ): Promise<TvHomeChannelsSyncSummary> {
      if (!isTvHomeChannelsSupported()) {
        return UNSUPPORTED_SYNC_SUMMARY;
      }
      return syncTvHomeChannels(channels);
    },

    async clearChannels(): Promise<void> {
      if (!isTvHomeChannelsSupported()) return;
      await clearTvHomeChannels();
    },
  };
}
