import type { FavoriteRow, ItemDetailRow, WatchProgressRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  buildEpisodeDeepLinkPlayTarget,
  resolveDeepLinkActionFromDetail,
} from './app-shell-deep-link';
import {
  buildTvHomeChannelsPayload,
  computeTvHomeChannelsSignature,
  TV_HOME_CHANNELS_MAX_PROGRAMS,
} from './app-shell-tv-channels';

describe('app-shell-tv-channels (#273)', () => {
  it('builds bounded preview channels without raw stream URLs and skips watched/series entries', () => {
    const continueWatching: WatchProgressRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: '  Inception  ',
        subtitle: '2010',
        logo: 'https://cdn.example.test/inception.jpg',
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 120_000,
        durationMs: 600_000,
        watched: false,
        updatedAt: 1000,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:movie:2',
        kind: 'movie',
        title: 'Completed Film',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 590_000,
        durationMs: 600_000,
        watched: true,
        updatedAt: 900,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:ep:3',
        kind: 'episode',
        title: 'Episode 1',
        subtitle: 'S01E01',
        logo: 'file:///local/bad.png',
        seriesKey: 'x:s1:series:1',
        season: 1,
        episode: 1,
        positionMs: 30_000,
        durationMs: 1800_000,
        watched: false,
        updatedAt: 800,
      },
    ];

    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:live:10',
        kind: 'live',
        title: 'News HD',
        logo: 'https://cdn.example.test/news.png',
        year: null,
        rating: null,
        addedAt: 500,
      },
      {
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:series:99',
        kind: 'series',
        title: 'Series Item',
        logo: null,
        year: 2025,
        rating: 8.1,
        addedAt: 400,
      },
    ];

    const channels = buildTvHomeChannelsPayload({
      continueWatching,
      favorites,
      continueWatchingLabel: 'Continue watching',
      favoritesLabel: 'Favorite channels',
    });

    expect(channels).toHaveLength(2);
    expect(channels[0]).toEqual({
      internalId: 'continue_watching',
      displayName: 'Continue watching',
      isDefaultBrowsable: true,
      programs: [
        {
          itemKey: 'x:s1:movie:1',
          title: 'Inception',
          subtitle: '2010',
          kind: 'movie',
          logoUrl: 'https://cdn.example.test/inception.jpg',
          durationMs: 600_000,
          lastPlaybackPositionMs: 120_000,
          isLive: false,
        },
        {
          itemKey: 'x:s1:ep:3',
          title: 'Episode 1',
          subtitle: 'S01E01',
          kind: 'episode',
          durationMs: 1800_000,
          lastPlaybackPositionMs: 30_000,
          isLive: false,
        },
      ],
    });
    expect(channels[1]).toEqual({
      internalId: 'favorites',
      displayName: 'Favorite channels',
      isDefaultBrowsable: true,
      programs: [
        {
          itemKey: 'x:s1:live:10',
          title: 'News HD',
          kind: 'live',
          logoUrl: 'https://cdn.example.test/news.png',
          isLive: true,
        },
      ],
    });

    const sig1 = computeTvHomeChannelsSignature(channels);
    const sig2 = computeTvHomeChannelsSignature(channels);
    expect(sig1).toBe(sig2);
  });

  it('caps each channel at TV_HOME_CHANNELS_MAX_PROGRAMS', () => {
    const manyFavorites: FavoriteRow[] = Array.from({ length: 30 }, (_, i) => ({
      profileId: 'default',
      sourceId: 's1',
      itemKey: `x:s1:live:${i}`,
      kind: 'live',
      title: `Channel ${i}`,
      logo: null,
      year: null,
      rating: null,
      addedAt: i,
    }));
    const channels = buildTvHomeChannelsPayload({
      continueWatching: [],
      favorites: manyFavorites,
      continueWatchingLabel: 'Continue watching',
      favoritesLabel: 'Favorite channels',
    });
    expect(channels[1]?.programs).toHaveLength(TV_HOME_CHANNELS_MAX_PROGRAMS);
  });

  it('maps ItemDetailRow and episode targets for deep-link playback', () => {
    const liveRow: ItemDetailRow = {
      id: 1,
      key: 'x:s1:live:1',
      kind: 'live',
      sourceId: 's1',
      providerId: '1',
      name: 'Sports 1',
      logo: 'https://cdn.example.test/s1.png',
      rating: null,
      year: null,
      num: 12,
      plot: null,
    };
    expect(resolveDeepLinkActionFromDetail(liveRow)).toEqual({
      kind: 'play',
      target: {
        kind: 'live',
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        title: 'Sports 1',
        logo: 'https://cdn.example.test/s1.png',
        channelNumber: 12,
      },
    });

    const movieRow: ItemDetailRow = {
      ...liveRow,
      key: 'x:s1:movie:5',
      kind: 'movie',
      name: 'Movie 5',
      num: null,
    };
    expect(resolveDeepLinkActionFromDetail(movieRow)).toEqual({
      kind: 'play',
      target: {
        kind: 'vod',
        itemKey: 'x:s1:movie:5',
        sourceId: 's1',
        title: 'Movie 5',
        logo: 'https://cdn.example.test/s1.png',
      },
    });

    const seriesRow: ItemDetailRow = {
      ...movieRow,
      key: 'x:s1:series:8',
      kind: 'series',
      name: 'Series 8',
    };
    expect(resolveDeepLinkActionFromDetail(seriesRow).kind).toBe('detail');

    expect(
      buildEpisodeDeepLinkPlayTarget({ itemKey: 'x:s1:ep:44', kind: 'episode' }, 'Episode 44'),
    ).toEqual({
      kind: 'vod',
      itemKey: 'x:s1:ep:44',
      sourceId: 's1',
      title: 'Episode 44',
    });
    expect(buildEpisodeDeepLinkPlayTarget({ itemKey: 'malformed' }, 'Title')).toBeNull();
  });
});
