import { describe, expect, it } from 'vitest';
import {
  availableTvOsdActions,
  clampTvOsdAction,
  initialTvOsdAction,
  moveTvOsdAction,
  routeTvOsdKey,
  type TvOsdAvailability,
} from './tv-osd-nav';

const FULL: TvOsdAvailability = {
  isVod: true,
  hasService: true,
  hasTracks: true,
  showRetry: true,
};

describe('availableTvOsdActions', () => {
  it('lists every mounted VOD button in OSD order', () => {
    expect(availableTvOsdActions(FULL)).toEqual([
      'back',
      'playPause',
      'seekBack',
      'seekForward',
      'tracks',
      'retry',
    ]);
  });

  it('hides transport and tracks buttons without a service', () => {
    expect(availableTvOsdActions({ ...FULL, hasService: false, showRetry: false })).toEqual([
      'back',
    ]);
  });

  it('hides transport buttons for live targets', () => {
    expect(availableTvOsdActions({ ...FULL, isVod: false, showRetry: false })).toEqual([
      'back',
      'tracks',
    ]);
  });

  it('hides tracks and retry when unavailable', () => {
    expect(availableTvOsdActions({ ...FULL, hasTracks: false, showRetry: false })).toEqual([
      'back',
      'playPause',
      'seekBack',
      'seekForward',
    ]);
  });
});

describe('initialTvOsdAction', () => {
  it('prefers tracks, then play/pause, then back', () => {
    expect(initialTvOsdAction(['back', 'playPause', 'tracks'])).toBe('tracks');
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
    expect(clampTvOsdAction('tracks', ['back', 'playPause', 'seekBack', 'seekForward'])).toBe(
      'seekForward',
    );
    expect(clampTvOsdAction('playPause', ['back', 'tracks'])).toBe('back');
  });

  it('falls back to the first button when nothing earlier is mounted', () => {
    expect(clampTvOsdAction('back', ['tracks'])).toBe('tracks');
  });
});

describe('moveTvOsdAction', () => {
  const actions = availableTvOsdActions(FULL);

  it('moves left and right and stops at both ends', () => {
    expect(moveTvOsdAction('playPause', actions, 1)).toBe('seekBack');
    expect(moveTvOsdAction('playPause', actions, -1)).toBe('back');
    expect(moveTvOsdAction('back', actions, -1)).toBe('back');
    expect(moveTvOsdAction('retry', actions, 1)).toBe('retry');
  });

  it('moves from the clamped action when the current one vanished', () => {
    expect(moveTvOsdAction('retry', ['back', 'playPause', 'tracks'], -1)).toBe('playPause');
  });

  it('degrades to back for an empty list', () => {
    expect(clampTvOsdAction('tracks', [])).toBe('back');
    expect(moveTvOsdAction('tracks', [], 1)).toBe('back');
  });
});

describe('routeTvOsdKey', () => {
  const actions = availableTvOsdActions(FULL);

  it('blurs on Up, moves on Left/Right press or repeat, and clamps on Select', () => {
    expect(routeTvOsdKey({ key: 'up', kind: 'press', time: 0 }, 'tracks', actions)).toEqual({
      kind: 'blur',
    });
    expect(routeTvOsdKey({ key: 'left', kind: 'repeat', time: 0 }, 'tracks', actions)).toEqual({
      kind: 'focus',
      action: 'seekForward',
    });
    expect(routeTvOsdKey({ key: 'right', kind: 'press', time: 0 }, 'tracks', actions)).toEqual({
      kind: 'focus',
      action: 'retry',
    });
    expect(
      routeTvOsdKey({ key: 'select', kind: 'press', time: 0 }, 'retry', ['back', 'playPause']),
    ).toEqual({
      kind: 'activate',
      action: 'playPause',
    });
    expect(routeTvOsdKey({ key: 'down', kind: 'press', time: 0 }, 'tracks', actions)).toBeNull();
  });
});
