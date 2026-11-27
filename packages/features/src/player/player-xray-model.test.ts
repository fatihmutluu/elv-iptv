import { describe, expect, it } from 'vitest';
import type { PlayTarget } from '../ports/play-target';
import {
  isXrayEligibleTarget,
  resolveXrayBaseItemKey,
  shouldShowXrayStrip,
} from './player-xray-model';

const MOVIE_TARGET: PlayTarget = {
  itemKey: 'x:src-1:movie:42',
  sourceId: 'src-1',
  title: 'Inception',
  kind: 'vod',
  itemKind: 'movie',
};

const EPISODE_TARGET: PlayTarget = {
  itemKey: 'x:src-1:ep:101',
  sourceId: 'src-1',
  title: 'Dark — Pilot',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:src-1:series:7',
  season: 1,
  episode: 1,
};

const LIVE_TARGET: PlayTarget = {
  itemKey: 'x:src-1:live:1',
  sourceId: 'src-1',
  title: 'News HD',
  kind: 'live',
};

describe('player-xray-model (#352)', () => {
  it('enables X-Ray strictly for VOD movies, series, and episodes, never live or catchup', () => {
    expect(isXrayEligibleTarget(MOVIE_TARGET)).toBe(true);
    expect(isXrayEligibleTarget(EPISODE_TARGET)).toBe(true);
    expect(isXrayEligibleTarget({ ...MOVIE_TARGET, itemKind: 'series' })).toBe(true);
    expect(isXrayEligibleTarget({ ...MOVIE_TARGET, itemKind: undefined })).toBe(true);
    expect(isXrayEligibleTarget(LIVE_TARGET)).toBe(false);
    expect(
      isXrayEligibleTarget({
        ...MOVIE_TARGET,
        catchup: {
          startMs: 1000,
          stopMs: 2000,
          programmeTitle: 'News',
          liveTarget: LIVE_TARGET,
        },
      }),
    ).toBe(false);
  });

  it('resolves seriesKey for episodes and itemKey for movies', () => {
    expect(resolveXrayBaseItemKey(EPISODE_TARGET)).toBe('x:src-1:series:7');
    expect(resolveXrayBaseItemKey(MOVIE_TARGET)).toBe('x:src-1:movie:42');
  });

  it('auto-shows when paused with metadata unless dismissed, and honors explicit pin toggle', () => {
    expect(
      shouldShowXrayStrip({
        eligible: true,
        suppressed: false,
        statusKind: 'paused',
        userPinnedOpen: false,
        dismissedOnPause: false,
        hasMetadata: true,
      }),
    ).toBe(true);

    expect(
      shouldShowXrayStrip({
        eligible: true,
        suppressed: false,
        statusKind: 'paused',
        userPinnedOpen: false,
        dismissedOnPause: true,
        hasMetadata: true,
      }),
    ).toBe(false);

    expect(
      shouldShowXrayStrip({
        eligible: true,
        suppressed: false,
        statusKind: 'playing',
        userPinnedOpen: false,
        dismissedOnPause: false,
        hasMetadata: true,
      }),
    ).toBe(false);

    expect(
      shouldShowXrayStrip({
        eligible: true,
        suppressed: false,
        statusKind: 'playing',
        userPinnedOpen: true,
        dismissedOnPause: false,
        hasMetadata: false,
      }),
    ).toBe(true);

    expect(
      shouldShowXrayStrip({
        eligible: false,
        suppressed: false,
        statusKind: 'paused',
        userPinnedOpen: true,
        dismissedOnPause: false,
        hasMetadata: true,
      }),
    ).toBe(false);
  });
});
