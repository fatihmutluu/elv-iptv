import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  advancedSettingsItems,
  audioMenuEntries,
  audioSettingsMenuEntries,
  clampSettingsMenu,
  formatPlaybackSpeed,
  getParentSettingsView,
  initialSettingsMenu,
  normalizeAudioDeviceChoices,
  PLAYBACK_SPEED_OPTIONS,
  parentStateForSettingsView,
  rootIndexForSettingsViewOptions,
  routeSettingsMenuKey,
  SETTINGS_ROOT_ITEMS,
  type SettingsMenuState,
  settingsRootItemsFromOptions,
  settingsRowCount,
  subtitleMenuEntries,
  subtitleSettingsMenuEntries,
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

describe('settings-menu-nav (Wave R4 streamlined 2-level hierarchy)', () => {
  it('initializes root and sub-view states and exposes streamlined root items', () => {
    expect(SETTINGS_ROOT_ITEMS).toEqual(['subtitles', 'audio', 'aspect', 'stats']);
    expect(initialSettingsMenu()).toEqual({ view: 'root', index: 0 });
    expect(initialSettingsMenu('audio', undefined, TRACKS)).toEqual({ view: 'audio', index: 1 });
    expect(initialSettingsMenu('subtitles', undefined, TRACKS)).toEqual({
      view: 'subtitles',
      index: 2,
    });
    expect(settingsRootItemsFromOptions({ isVod: false })).toEqual([
      'subtitles',
      'audio',
      'aspect',
      'stats',
    ]);
    expect(settingsRootItemsFromOptions({ isVod: true })).toEqual([
      'subtitles',
      'audio',
      'speed',
      'aspect',
      'stats',
    ]);
  });

  it('computes row counts and enforces videoQualities.length > 1 guard', () => {
    expect(settingsRowCount('root', TRACKS)).toBe(4);
    expect(settingsRowCount('subtitles', TRACKS)).toBe(3);
    expect(settingsRowCount('audio', TRACKS)).toBe(2);
    expect(settingsRowCount('audio', EMPTY_AUDIO)).toBe(0);

    const singleQuality: MediaTracks = {
      ...TRACKS,
      videoQualities: [{ id: 'v:1080', label: '1080p', width: 1920, height: 1080 }],
    };
    expect(
      settingsRootItemsFromOptions({ isVod: true, hasVideoQuality: true }, singleQuality),
    ).not.toContain('videoQuality');
    expect(settingsRowCount('videoQuality', singleQuality, { hasVideoQuality: true })).toBe(0);
    expect(
      clampSettingsMenu({ view: 'videoQuality', index: 1 }, singleQuality, {
        hasVideoQuality: true,
      }),
    ).toEqual({ view: 'root', index: 0 });
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

  it('routes root navigation, audio/subtitle selections, speed, and back/parent hierarchy', () => {
    const root0: SettingsMenuState = { view: 'root', index: 0 };
    expect(routeSettingsMenuKey({ key: 'down', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'state',
      state: { view: 'root', index: 1 },
    });
    expect(routeSettingsMenuKey({ key: 'left', kind: 'press', time: 0 }, root0, TRACKS)).toBeNull();
    expect(routeSettingsMenuKey({ key: 'back', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'close',
    });

    // Subtitles & Audio entry
    expect(routeSettingsMenuKey({ key: 'select', kind: 'press', time: 0 }, root0, TRACKS)).toEqual({
      kind: 'state',
      state: { view: 'subtitles', index: 2 },
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

    // Aspect & Stats
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        TRACKS,
      ),
    ).toEqual({ kind: 'toggleResizeMode' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 3 },
        TRACKS,
      ),
    ).toEqual({ kind: 'toggleStats' });

    // Selections inside subtitles and audio
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

    // Parent view mapping
    expect(getParentSettingsView('root')).toBeNull();
    expect(getParentSettingsView('subtitleSettings')).toBe('subtitles');
    expect(getParentSettingsView('audioSettings')).toBe('audio');
    expect(getParentSettingsView('videoDecoder')).toBe('advanced');
    expect(getParentSettingsView('speed')).toBe('root');
  });

  it('supports VOD playback speed, sleepTimer, and multi-program MPEG-TS selection (#304)', () => {
    expect(PLAYBACK_SPEED_OPTIONS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
    expect(formatPlaybackSpeed(1.25)).toBe('1.25×');
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'speed', index: 4 },
        TRACKS,
        { isVod: true, playbackSpeed: 1 },
      ),
    ).toEqual({ kind: 'speed', rate: 1.5 });

    const sleepOpts = { isVod: true, hasSleepTimer: true, sleepTimerMinutes: 30 };
    expect(settingsRowCount('sleepTimer', TRACKS, sleepOpts)).toBe(10);
    expect(initialSettingsMenu('sleepTimer', sleepOpts)).toEqual({ view: 'sleepTimer', index: 3 });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'sleepTimer', index: 0 },
        TRACKS,
        sleepOpts,
      ),
    ).toEqual({ kind: 'toggleSleepTimerAction' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'sleepTimer', index: 4 },
        TRACKS,
        sleepOpts,
      ),
    ).toEqual({ kind: 'sleepTimer', minutes: 45 });

    const multiProgram: MediaTracks = {
      programs: [
        { id: 'p:101', label: 'News HD', serviceName: 'News HD', programNumber: 101 },
        { id: 'p:102', label: 'Sports HD', serviceName: 'Sports HD', programNumber: 102 },
      ],
      selectedProgramId: 'p:102',
      audio: [
        { id: 'a:101-1', language: 'eng', programId: 'p:101' },
        { id: 'a:102-1', language: 'tur', programId: 'p:102' },
      ],
      subtitles: [
        { id: 's:101-1', language: 'eng', programId: 'p:101' },
        { id: 's:102-1', language: 'tur', programId: 'p:102' },
      ],
      selectedAudioId: 'a:102-1',
      selectedSubtitleId: 's:102-1',
    };
    expect(audioMenuEntries(multiProgram).map((e) => e.kind)).toEqual([
      'program',
      'program',
      'audio',
    ]);
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'audio', index: 0 },
        multiProgram,
      ),
    ).toEqual({ kind: 'program', id: 'p:101' });
    expect(subtitleMenuEntries(multiProgram).map((e) => e.kind)).toEqual([
      'primaryOff',
      'primaryTrack',
    ]);
  });

  it('navigates 2-level subtitles -> subtitleSettings, audio -> audioSettings, and advanced -> videoDecoder', () => {
    const devices = [
      { name: 'auto', description: 'Autoselect' },
      { name: 'wasapi/hdmi', description: 'HDMI' },
      { name: 'wasapi/hdmi', description: 'Duplicate' },
      { name: '', description: 'Blank' },
      { name: 'wasapi/usb', description: 'USB DAC' },
    ];
    expect(normalizeAudioDeviceChoices(devices)).toEqual([
      { name: 'wasapi/hdmi', description: 'HDMI' },
      { name: 'wasapi/usb', description: 'USB DAC' },
    ]);
    expect(normalizeAudioDeviceChoices(undefined)).toEqual([]);

    const opts = {
      isVod: true,
      hasAspect: false,
      hasDeinterlace: true,
      hasPitchLock: true,
      hasAudioNormalization: true,
      hasAutoPlayNextEpisode: true,
      hasAudioDevice: true,
      audioDevices: devices,
      activeAudioDevice: 'wasapi/usb',
      hasAudioDelay: true,
      hasSubtitleDelay: true,
      hasSubtitleStyle: true,
      hasDualSubtitles: true,
      canPickSubtitleFile: true,
      canLoadSubtitleUrl: true,
      hasVideoDecoder: true,
      androidDecoderMode: 'hardware' as const,
      hasPip: true,
      hasMultiView: true,
    };

    // Root contains ONLY streamlined items (last item is 'advanced')
    expect(settingsRootItemsFromOptions(opts, TRACKS)).toEqual([
      'subtitles',
      'audio',
      'speed',
      'multiView',
      'stats',
      'advanced',
    ]);
    expect(advancedSettingsItems(opts)).toEqual([
      'deinterlace',
      'videoDecoder',
      'audioNormalization',
      'pitchLock',
      'autoPlayNextEpisode',
      'pip',
    ]);

    // Subtitles -> trailing openSubtitleSettings row -> enters subtitleSettings
    const subEntries = subtitleMenuEntries(TRACKS, opts);
    expect(subEntries.at(-1)).toEqual({ kind: 'openSubtitleSettings' });
    const enterSubSettings = routeSettingsMenuKey(
      { key: 'select', kind: 'press', time: 0 },
      { view: 'subtitles', index: subEntries.length - 1 },
      TRACKS,
      opts,
    );
    expect(enterSubSettings).toEqual({
      kind: 'state',
      state: { view: 'subtitleSettings', index: 2 },
    });

    // subtitleSettings contains delay (5) + style (6) + secondary (3) + external (2) = 16
    const subSettingsEntries = subtitleSettingsMenuEntries(TRACKS, opts);
    expect(subSettingsEntries.slice(0, 5)).toEqual([
      { kind: 'delayStep', step: -500 },
      { kind: 'delayStep', step: -100 },
      { kind: 'delayStep', step: 0 },
      { kind: 'delayStep', step: 100 },
      { kind: 'delayStep', step: 500 },
    ]);
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 0 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'subtitleDelay', deltaMs: -500 });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 2 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'subtitleDelay', deltaMs: 0, reset: true });
    // Right/Left on style row steps field; Back goes to subtitles
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 5 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'fontSize', delta: 1 });
    expect(
      routeSettingsMenuKey(
        { key: 'back', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 5 },
        TRACKS,
        opts,
      ),
    ).toEqual({
      kind: 'state',
      state: { view: 'subtitles', index: subEntries.length - 1 },
    });

    // Audio -> trailing openAudioSettings row -> enters audioSettings
    const audEntries = audioMenuEntries(TRACKS, opts);
    expect(audEntries.at(-1)).toEqual({ kind: 'openAudioSettings' });
    const enterAudioSettings = routeSettingsMenuKey(
      { key: 'select', kind: 'press', time: 0 },
      { view: 'audio', index: audEntries.length - 1 },
      TRACKS,
      opts,
    );
    expect(enterAudioSettings).toEqual({
      kind: 'state',
      state: { view: 'audioSettings', index: 2 },
    });
    const audioSettings = audioSettingsMenuEntries(opts);
    expect(audioSettings.map((e) => e.kind)).toEqual([
      'delayStep',
      'delayStep',
      'delayStep',
      'delayStep',
      'delayStep',
      'deviceAuto',
      'device',
      'device',
      'audioNormalization',
      'pitchLock',
    ]);
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'audioSettings', index: 6 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'audioDevice', name: 'wasapi/hdmi' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'audioSettings', index: 8 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'toggleAudioNormalization' });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'audioSettings', index: 9 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'togglePitchLock' });
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'audioSettings', index: 6 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'audio', index: audEntries.length - 1 } });

    // Advanced -> videoDecoder -> back returns to advanced row 1!
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'advanced', index: 1 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'videoDecoder', index: 1 } });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'videoDecoder', index: 2 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'videoDecoder', mode: 'software' });
    expect(
      routeSettingsMenuKey(
        { key: 'back', kind: 'press', time: 0 },
        { view: 'videoDecoder', index: 2 },
        TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'advanced', index: 1 } });
    expect(parentStateForSettingsView('advanced', TRACKS, opts)).toEqual({
      view: 'root',
      index: rootIndexForSettingsViewOptions('advanced', opts, TRACKS),
    });
  });
});
