import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  clampSettingsMenu,
  formatPlaybackSpeed,
  initialSettingsMenu,
  PLAYBACK_SPEED_OPTIONS,
  routeSettingsMenuKey,
  SETTINGS_ROOT_ITEMS,
  type SettingsMenuState,
  settingsRootItems,
  settingsRowCount,
} from './settings-menu-nav';

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur' },
    { id: 'a:2', language: 'eng' },
  ],
  subtitles: [
    { id: 's:1', language: 'tur' },
    { id: 's:2', language: 'eng' },
  ],
  selectedAudioId: 'a:2',
  selectedSubtitleId: 's:2',
};

const EMPTY_AUDIO: MediaTracks = { ...TRACKS, audio: [], selectedAudioId: null };

describe('settings-menu-nav', () => {
  it('initializes root or sub-view state at index 0 and exposes root item order', () => {
    expect(SETTINGS_ROOT_ITEMS).toEqual(['subtitles', 'audio', 'aspect', 'stats']);
    expect(initialSettingsMenu()).toEqual({ view: 'root', index: 0 });
    expect(initialSettingsMenu('audio')).toEqual({ view: 'audio', index: 0 });
    expect(initialSettingsMenu('subtitles')).toEqual({ view: 'subtitles', index: 0 });
  });

  it('computes row counts for root, subtitles (including Off), and audio views', () => {
    expect(settingsRowCount('root', TRACKS)).toBe(4);
    expect(settingsRowCount('subtitles', TRACKS)).toBe(3);
    expect(settingsRowCount('audio', TRACKS)).toBe(2);
    expect(settingsRowCount('audio', EMPTY_AUDIO)).toBe(0);
  });

  it('clamps indices cleanly and preserves identity when already in bounds', () => {
    const valid: SettingsMenuState = { view: 'root', index: 1 };
    expect(clampSettingsMenu(valid, TRACKS)).toBe(valid);
    expect(clampSettingsMenu({ view: 'root', index: 9 }, TRACKS)).toEqual({
      view: 'root',
      index: 3,
    });
    expect(clampSettingsMenu({ view: 'root', index: -2 }, TRACKS)).toEqual({
      view: 'root',
      index: 0,
    });
    expect(clampSettingsMenu({ view: 'subtitles', index: 5 }, TRACKS)).toEqual({
      view: 'subtitles',
      index: 2,
    });
    expect(clampSettingsMenu({ view: 'audio', index: 4 }, EMPTY_AUDIO)).toEqual({
      view: 'audio',
      index: 0,
    });
  });

  it('routes root keys: up/down moves, right/select enters sub-views on selected row, stats toggles, back closes', () => {
    const root0: SettingsMenuState = { view: 'root', index: 0 };
    expect(routeSettingsMenuKey({ key: 'down', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'state',
      state: { view: 'root', index: 1 },
    });
    expect(
      routeSettingsMenuKey(
        { key: 'down', kind: 'repeat', time: 0 },
        { view: 'root', index: 1 },
        TRACKS,
      ),
    ).toEqual({
      kind: 'state',
      state: { view: 'root', index: 2 },
    });
    expect(
      routeSettingsMenuKey(
        { key: 'up', kind: 'press', time: 0 },
        { view: 'root', index: 0 },
        TRACKS,
      ),
    ).toEqual({
      kind: 'state',
      state: { view: 'root', index: 0 },
    });
    expect(routeSettingsMenuKey({ key: 'left', kind: 'press', time: 0 }, root0, TRACKS)).toBeNull();
    expect(routeSettingsMenuKey({ key: 'back', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'close',
    });

    // Enter subtitles via select or right -> lands on selected subtitle (index 2 for s:2)
    expect(routeSettingsMenuKey({ key: 'select', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'state',
      state: { view: 'subtitles', index: 2 },
    });
    expect(routeSettingsMenuKey({ key: 'right', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'state',
      state: { view: 'subtitles', index: 2 },
    });

    // Enter audio via select or right -> lands on selected audio (index 1 for a:2)
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 1 },
        TRACKS,
      ),
    ).toEqual({
      kind: 'state',
      state: { view: 'audio', index: 1 },
    });
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'root', index: 1 },
        TRACKS,
      ),
    ).toEqual({
      kind: 'state',
      state: { view: 'audio', index: 1 },
    });

    // Aspect row (index 2 on Live): select toggles resizeMode, right ignored
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        TRACKS,
      ),
    ).toEqual({ kind: 'toggleResizeMode' });
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        TRACKS,
      ),
    ).toBeNull();

    // Stats row (index 3 on Live): select toggles, right ignored
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 3 },
        TRACKS,
      ),
    ).toEqual({ kind: 'toggleStats' });
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'root', index: 3 },
        TRACKS,
      ),
    ).toBeNull();
  });

  it('routes sub-view keys: up/down clamps, select picks audio/subtitle, left or back returns to root row', () => {
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitles', index: 0 },
        TRACKS,
      ),
    ).toEqual({ kind: 'subtitle', id: null });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitles', index: 1 },
        TRACKS,
      ),
    ).toEqual({ kind: 'subtitle', id: 's:1' });
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'subtitles', index: 2 },
        TRACKS,
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 0 } });
    expect(
      routeSettingsMenuKey(
        { key: 'back', kind: 'press', time: 0 },
        { view: 'subtitles', index: 1 },
        TRACKS,
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 0 } });

    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'audio', index: 0 },
        TRACKS,
      ),
    ).toEqual({ kind: 'audio', id: 'a:1' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'audio', index: 0 },
        EMPTY_AUDIO,
      ),
    ).toBeNull();
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'audio', index: 1 },
        TRACKS,
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 1 } });
    expect(
      routeSettingsMenuKey(
        { key: 'back', kind: 'press', time: 0 },
        { view: 'audio', index: 1 },
        TRACKS,
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 1 } });
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'audio', index: 0 },
        TRACKS,
      ),
    ).toBeNull();
    expect(
      routeSettingsMenuKey(
        { key: 'play', kind: 'press', time: 0 },
        { view: 'root', index: 0 },
        TRACKS,
      ),
    ).toBeNull();
  });

  it('supports VOD playback speed submenu (0.5x-2x) with D-pad navigation and clamping', () => {
    expect(PLAYBACK_SPEED_OPTIONS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
    expect(initialSettingsMenu('speed', { playbackSpeed: 1.5 })).toEqual({
      view: 'speed',
      index: 4,
    });
    expect(formatPlaybackSpeed(1)).toBe('1×');
    expect(formatPlaybackSpeed(1.25)).toBe('1.25×');
    expect(settingsRootItems(false)).toEqual(['subtitles', 'audio', 'aspect', 'stats']);
    expect(settingsRootItems(true)).toEqual(['subtitles', 'audio', 'speed', 'aspect', 'stats']);
    expect(settingsRowCount('root', TRACKS, { isVod: true })).toBe(5);
    expect(settingsRowCount('speed', TRACKS, { isVod: true })).toBe(6);

    // Clamping speed view on non-VOD returns to root
    expect(clampSettingsMenu({ view: 'speed', index: 2 }, TRACKS, { isVod: false })).toEqual({
      view: 'root',
      index: 0,
    });

    // Enter speed from root index 2 on VOD -> lands on current playbackSpeed (1.5 -> index 4)
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        TRACKS,
        { isVod: true, playbackSpeed: 1.5 },
      ),
    ).toEqual({
      kind: 'state',
      state: { view: 'speed', index: 4 },
    });

    // Select speed option emits speed intent
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'speed', index: 5 },
        TRACKS,
        { isVod: true, playbackSpeed: 1 },
      ),
    ).toEqual({ kind: 'speed', rate: 2 });

    // Left / Back from speed returns to root index 2
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'speed', index: 2 },
        TRACKS,
        { isVod: true },
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 2 } });

    // Aspect on VOD is index 3, Stats on VOD is index 4
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 3 },
        TRACKS,
        { isVod: true },
      ),
    ).toEqual({ kind: 'toggleResizeMode' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 4 },
        TRACKS,
        { isVod: true },
      ),
    ).toEqual({ kind: 'toggleStats' });
  });

  it('omits aspect row when hasAspect is false (desktop) and keeps stats/clamping indices exact (#440)', () => {
    expect(settingsRootItems(false, false)).toEqual(['subtitles', 'audio', 'stats']);
    expect(settingsRootItems(true, false)).toEqual(['subtitles', 'audio', 'speed', 'stats']);
    expect(settingsRowCount('root', TRACKS, { isVod: false, hasAspect: false })).toBe(3);
    expect(settingsRowCount('root', TRACKS, { isVod: true, hasAspect: false })).toBe(4);
    expect(clampSettingsMenu({ view: 'root', index: 9 }, TRACKS, { hasAspect: false })).toEqual({
      view: 'root',
      index: 2,
    });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        TRACKS,
        { isVod: false, hasAspect: false },
      ),
    ).toEqual({ kind: 'toggleStats' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 3 },
        TRACKS,
        { isVod: true, hasAspect: false },
      ),
    ).toEqual({ kind: 'toggleStats' });
  });
});
