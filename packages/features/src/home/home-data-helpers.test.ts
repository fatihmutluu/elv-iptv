import type { FavoriteRow, MyListNewEpisodeRow, WatchProgressRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import type { CachedHomeSnapshot } from '../shared';
import {
  applyHomeFavUpdate,
  applyHomeWatchedUpdate,
  EMPTY_HOME_SNAPSHOT,
  mergeOptimisticHomeSnapshot,
} from './home-data-helpers';

const EP_A1: MyListNewEpisodeRow = {
  profileId: 'default',
  episodeKey: 'x:s1:episode:101',
  seriesKey: 'x:s1:series:10',
  sourceId: 's1',
  seriesTitle: 'Starlight Harbor',
  seriesLogo: null,
  season: 2,
  episode: 1,
  episodeTitle: 'Arrival',
  detectedAt: 2_000,
};

const EP_B1: MyListNewEpisodeRow = {
  profileId: 'default',
  episodeKey: 'x:s1:episode:201',
  seriesKey: 'x:s1:series:20',
  sourceId: 's1',
  seriesTitle: 'Glass Orbit',
  seriesLogo: null,
  season: 1,
  episode: 4,
  episodeTitle: 'Drift',
  detectedAt: 1_000,
};

const FAV_A: FavoriteRow = {
  profileId: 'default',
  sourceId: 's1',
  itemKey: 'x:s1:series:10',
  kind: 'series',
  title: 'Starlight Harbor',
  logo: null,
  year: 2025,
  rating: 8.5,
  addedAt: 100,
};

const EP_A1_WATCHED: WatchProgressRow = {
  profileId: 'default',
  sourceId: 's1',
  itemKey: 'x:s1:episode:101',
  kind: 'episode',
  title: 'Starlight Harbor',
  subtitle: 'S2 · E1 — Arrival',
  logo: null,
  seriesKey: 'x:s1:series:10',
  season: 2,
  episode: 1,
  positionMs: 0,
  durationMs: 0,
  watched: true,
  updatedAt: 3_000,
};

describe('home-data-helpers optimistic newEpisodes sync (#502 P1-1)', () => {
  it('removes a series from newEpisodes when unfavorited via applyHomeFavUpdate', () => {
    const prev: CachedHomeSnapshot = {
      ...EMPTY_HOME_SNAPSHOT,
      favorites: [FAV_A],
      favoriteKeys: new Set([FAV_A.itemKey]),
      newEpisodes: [EP_A1, EP_B1],
    };

    const next = applyHomeFavUpdate(prev, FAV_A.itemKey, false, undefined);
    expect(next.favoriteKeys.has(FAV_A.itemKey)).toBe(false);
    expect(next.newEpisodes).toEqual([EP_B1]);

    const added = applyHomeFavUpdate(prev, 'x:s1:series:30', true, {
      ...FAV_A,
      itemKey: 'x:s1:series:30',
    });
    expect(added.newEpisodes).toEqual([EP_A1, EP_B1]);
  });

  it('removes a watched episode from newEpisodes via applyHomeWatchedUpdate', () => {
    const prev: CachedHomeSnapshot = {
      ...EMPTY_HOME_SNAPSHOT,
      newEpisodes: [EP_A1, EP_B1],
    };

    const next = applyHomeWatchedUpdate(prev, EP_A1.episodeKey, EP_A1_WATCHED, undefined);
    expect(next.newEpisodes).toEqual([EP_B1]);

    const unwatched = applyHomeWatchedUpdate(
      prev,
      EP_A1.episodeKey,
      { ...EP_A1_WATCHED, watched: false },
      undefined,
    );
    expect(unwatched.newEpisodes).toEqual([EP_A1, EP_B1]);
  });

  it('preserves optimistic unfavorite and watched newEpisodes removals across mergeOptimisticHomeSnapshot', () => {
    const fetched: CachedHomeSnapshot = {
      ...EMPTY_HOME_SNAPSHOT,
      favorites: [FAV_A],
      favoriteKeys: new Set([FAV_A.itemKey]),
      newEpisodes: [EP_A1, EP_B1],
    };
    const current: CachedHomeSnapshot = {
      ...EMPTY_HOME_SNAPSHOT,
      favorites: [],
      favoriteKeys: new Set(),
      progressByKey: new Map([[EP_B1.episodeKey, { ...EP_A1_WATCHED, itemKey: EP_B1.episodeKey }]]),
      newEpisodes: [],
    };

    const merged = mergeOptimisticHomeSnapshot(
      fetched,
      current,
      new Map([[FAV_A.itemKey, 1]]),
      new Map([[EP_B1.episodeKey, 1]]),
    );
    expect(merged.favoriteKeys.has(FAV_A.itemKey)).toBe(false);
    expect(merged.newEpisodes).toEqual([]);
  });
});
