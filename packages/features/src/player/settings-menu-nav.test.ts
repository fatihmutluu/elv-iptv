import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  clampSettingsMenu,
  initialSettingsMenu,
  routeSettingsMenuKey,
  SETTINGS_ROOT_ITEMS,
  type SettingsMenuState,
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
    expect(SETTINGS_ROOT_ITEMS).toEqual(['subtitles', 'audio', 'stats']);
    expect(initialSettingsMenu()).toEqual({ view: 'root', index: 0 });
    expect(initialSettingsMenu('audio')).toEqual({ view: 'audio', index: 0 });
    expect(initialSettingsMenu('subtitles')).toEqual({ view: 'subtitles', index: 0 });
  });

  it('computes row counts for root, subtitles (including Off), and audio views', () => {
    expect(settingsRowCount('root', TRACKS)).toBe(3);
    expect(settingsRowCount('subtitles', TRACKS)).toBe(3);
    expect(settingsRowCount('audio', TRACKS)).toBe(2);
    expect(settingsRowCount('audio', EMPTY_AUDIO)).toBe(0);
  });

  it('clamps indices cleanly and preserves identity when already in bounds', () => {
    const valid: SettingsMenuState = { view: 'root', index: 1 };
    expect(clampSettingsMenu(valid, TRACKS)).toBe(valid);
    expect(clampSettingsMenu({ view: 'root', index: 9 }, TRACKS)).toEqual({
      view: 'root',
      index: 2,
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

    // Stats row: select toggles, right ignored
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        TRACKS,
      ),
    ).toEqual({ kind: 'toggleStats' });
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
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
});
