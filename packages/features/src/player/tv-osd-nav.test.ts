import { describe, expect, it } from 'vitest';
import {
  availableTvOsdActions,
  clampTvOsdAction,
  initialTvOsdAction,
  moveTvOsdAction,
  routeTvOsdKey,
  routeTvScrubberKey,
  type TvOsdAvailability,
} from './tv-osd-nav';

const FULL: TvOsdAvailability = {
  isVod: true,
  hasService: true,
  hasSubtitles: true,
  hasAudio: true,
  showRetry: true,
};

describe('availableTvOsdActions', () => {
  it('lists every mounted VOD button in OSD order', () => {
    expect(availableTvOsdActions(FULL)).toEqual([
      'back',
      'seekBack',
      'playPause',
      'seekForward',
      'subtitles',
      'audio',
      'retry',
    ]);
  });

  it('hides transport and subtitle/audio buttons without a service', () => {
    expect(availableTvOsdActions({ ...FULL, hasService: false, showRetry: false })).toEqual([
      'back',
    ]);
  });

  it('hides transport buttons for live targets', () => {
    expect(availableTvOsdActions({ ...FULL, isVod: false, showRetry: false })).toEqual([
      'back',
      'subtitles',
      'audio',
    ]);
  });

  it('hides subtitles, audio, and retry when unavailable', () => {
    expect(
      availableTvOsdActions({ ...FULL, hasSubtitles: false, hasAudio: false, showRetry: false }),
    ).toEqual(['back', 'seekBack', 'playPause', 'seekForward']);
  });

  it('orders optional settings, nextEpisode, channelList, and prevChannel actions cleanly', () => {
    expect(
      availableTvOsdActions({
        ...FULL,
        hasSettings: true,
        hasNextEpisode: true,
        hasPreviousChannel: true,
      }),
    ).toEqual([
      'back',
      'seekBack',
      'playPause',
      'seekForward',
      'subtitles',
      'audio',
      'settings',
      'nextEpisode',
      'retry',
    ]);

    expect(
      availableTvOsdActions({
        isVod: false,
        hasService: true,
        hasSubtitles: true,
        hasAudio: true,
        showRetry: true,
        hasPreviousChannel: true,
        hasChannelList: true,
        hasSettings: true,
        hasNextEpisode: true,
      }),
    ).toEqual(['back', 'prevChannel', 'channelList', 'subtitles', 'audio', 'settings', 'retry']);

    expect(
      availableTvOsdActions({
        isVod: false,
        hasService: false,
        hasSubtitles: true,
        hasAudio: true,
        showRetry: false,
        hasPreviousChannel: true,
        hasSettings: true,
        hasNextEpisode: true,
      }),
    ).toEqual(['back']);
  });
});

describe('initialTvOsdAction', () => {
  it('prefers subtitles, then audio, then play/pause, then back', () => {
    expect(initialTvOsdAction(['back', 'playPause', 'subtitles', 'audio'])).toBe('subtitles');
    expect(initialTvOsdAction(['back', 'playPause', 'audio'])).toBe('audio');
    expect(initialTvOsdAction(['back', 'playPause'])).toBe('playPause');
    expect(initialTvOsdAction(['back'])).toBe('back');
  });
});

describe('clampTvOsdAction', () => {
  it('keeps an action that is still mounted', () => {
    expect(clampTvOsdAction('seekBack', availableTvOsdActions(FULL))).toBe('seekBack');
  });

  it('falls back to the nearest earlier mounted button when the focused one vanishes', () => {
    expect(clampTvOsdAction('retry', ['back', 'playPause', 'seekBack', 'seekForward'])).toBe(
      'seekForward',
    );
    expect(clampTvOsdAction('subtitles', ['back', 'playPause', 'seekBack', 'seekForward'])).toBe(
      'seekForward',
    );
    expect(clampTvOsdAction('playPause', ['back', 'subtitles'])).toBe('back');
  });

  it('falls back to the first button when nothing earlier is mounted', () => {
    expect(clampTvOsdAction('back', ['subtitles'])).toBe('subtitles');
  });
});

describe('moveTvOsdAction', () => {
  const actions = availableTvOsdActions(FULL);

  it('moves left and right and stops at both ends', () => {
    expect(moveTvOsdAction('playPause', actions, 1)).toBe('seekForward');
    expect(moveTvOsdAction('playPause', actions, -1)).toBe('seekBack');
    expect(moveTvOsdAction('seekBack', actions, -1)).toBe('back');
    expect(moveTvOsdAction('back', actions, -1)).toBe('back');
    expect(moveTvOsdAction('retry', actions, 1)).toBe('retry');
  });

  it('moves from the clamped action when the current one vanished', () => {
    expect(moveTvOsdAction('retry', ['back', 'playPause', 'subtitles'], -1)).toBe('playPause');
  });

  it('degrades to back for an empty list', () => {
    expect(clampTvOsdAction('subtitles', [])).toBe('back');
    expect(moveTvOsdAction('subtitles', [], 1)).toBe('back');
  });
});

describe('routeTvOsdKey', () => {
  const actions = availableTvOsdActions(FULL);

  it('blurs on Up, moves on Left/Right press or repeat, and clamps on Select', () => {
    expect(routeTvOsdKey({ key: 'up', kind: 'press', time: 0 }, 'audio', actions)).toEqual({
      kind: 'blur',
    });
    expect(routeTvOsdKey({ key: 'left', kind: 'repeat', time: 0 }, 'audio', actions)).toEqual({
      kind: 'focus',
      action: 'subtitles',
    });
    expect(routeTvOsdKey({ key: 'right', kind: 'press', time: 0 }, 'audio', actions)).toEqual({
      kind: 'focus',
      action: 'retry',
    });
    expect(
      routeTvOsdKey({ key: 'select', kind: 'press', time: 0 }, 'retry', ['back', 'playPause']),
    ).toEqual({
      kind: 'activate',
      action: 'playPause',
    });
    expect(routeTvOsdKey({ key: 'down', kind: 'press', time: 0 }, 'subtitles', actions)).toBeNull();
  });
});

describe('routeTvScrubberKey', () => {
  it('traps horizontal scrub keys, handles select/playPause/down/up, and ignores others', () => {
    expect(routeTvScrubberKey({ key: 'left', kind: 'press', time: 0 })).toEqual({
      kind: 'step',
      direction: -1,
      stepKind: 'press',
    });
    expect(routeTvScrubberKey({ key: 'right', kind: 'repeat', time: 0 })).toEqual({
      kind: 'step',
      direction: 1,
      stepKind: 'repeat',
    });
    expect(routeTvScrubberKey({ key: 'rewind', kind: 'press', time: 0 })).toEqual({
      kind: 'step',
      direction: -1,
      stepKind: 'press',
    });
    expect(routeTvScrubberKey({ key: 'fastForward', kind: 'repeat', time: 0 })).toEqual({
      kind: 'step',
      direction: 1,
      stepKind: 'repeat',
    });
    expect(routeTvScrubberKey({ key: 'select', kind: 'press', time: 0 })).toEqual({
      kind: 'commitOrToggle',
    });
    expect(routeTvScrubberKey({ key: 'playPause', kind: 'press', time: 0 })).toEqual({
      kind: 'togglePlayPause',
    });
    expect(routeTvScrubberKey({ key: 'down', kind: 'press', time: 0 })).toEqual({
      kind: 'toOsd',
    });
    expect(routeTvScrubberKey({ key: 'up', kind: 'press', time: 0 })).toEqual({
      kind: 'blur',
    });
    expect(routeTvScrubberKey({ key: 'select', kind: 'repeat', time: 0 })).toBeNull();
    expect(routeTvScrubberKey({ key: 'digit5', kind: 'press', time: 0 })).toBeNull();
  });
});
