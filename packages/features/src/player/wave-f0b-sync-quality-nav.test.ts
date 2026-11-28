import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  clampSettingsMenu,
  formatSyncDelayMs,
  initialSettingsMenu,
  routeSettingsMenuKey,
  SYNC_DELAY_RESET_INDEX,
  settingsRowCount,
} from './settings-menu-nav';
import { buildSettingsNavRows, buildSettingsRadioItems } from './settings-sheet-items';

const TRACKS_WITH_QUALITIES: MediaTracks = {
  audio: [{ id: 'a:1', language: 'en' }],
  subtitles: [{ id: 's:1', language: 'en' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
  videoQualities: [
    { id: 'v:1080', label: '1080p', width: 1920, height: 1080, bitrateBps: 5_000_000, fps: 50 },
    { id: 'v:720', label: '720p', width: 1280, height: 720, bitrateBps: 850_000, fps: 25 },
  ],
  selectedVideoQualityId: null,
};

describe('Wave F0B / Wave R4 sync delay & multi-variant video quality navigation (#59)', () => {
  it('formats signed sync delay offsets cleanly', () => {
    expect(formatSyncDelayMs(0)).toBe('0 ms');
    expect(formatSyncDelayMs(100)).toBe('+100 ms');
    expect(formatSyncDelayMs(-500)).toBe('-500 ms');
    expect(formatSyncDelayMs(Number.NaN)).toBe('0 ms');
  });

  it('routes audioSettings delay, subtitleSettings delay, and multi-variant videoQuality sub-views and intents', () => {
    const opts = {
      isVod: false,
      hasAudioDelay: true,
      audioDelayMs: 100,
      hasSubtitleDelay: true,
      subtitleDelayMs: -500,
      hasVideoQuality: true,
      selectedVideoQualityId: 'v:720',
    };

    expect(initialSettingsMenu('audioSettings', opts)).toEqual({
      view: 'audioSettings',
      index: SYNC_DELAY_RESET_INDEX,
    });
    expect(settingsRowCount('audioSettings', TRACKS_WITH_QUALITIES, opts)).toBe(5);
    expect(settingsRowCount('subtitleSettings', TRACKS_WITH_QUALITIES, opts)).toBe(5);
    expect(settingsRowCount('videoQuality', TRACKS_WITH_QUALITIES, opts)).toBe(3);

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'audioSettings', index: 4 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'audioDelay', deltaMs: 500 });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'audioSettings', index: 2 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'audioDelay', deltaMs: 0, reset: true });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'subtitleSettings', index: 1 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'subtitleDelay', deltaMs: -100 });

    // Open videoQuality from root index 2 (subtitles, audio, videoQuality) pre-selects v:720 (index 2)
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 2 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'videoQuality', index: 2 } });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'videoQuality', index: 0 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'videoQuality', id: null });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'videoQuality', index: 1 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'videoQuality', id: 'v:1080' });

    // Clamps cleanly when capabilities are absent or only <=1 video quality exists
    expect(
      clampSettingsMenu({ view: 'audioSettings', index: 2 }, TRACKS_WITH_QUALITIES, {
        hasAudioDelay: false,
      }),
    ).toEqual({ view: 'audio', index: 0 });
    expect(
      clampSettingsMenu({ view: 'videoQuality', index: 1 }, TRACKS_WITH_QUALITIES, {
        hasVideoQuality: false,
      }),
    ).toEqual({ view: 'root', index: 0 });
    expect(
      settingsRowCount(
        'videoQuality',
        {
          ...TRACKS_WITH_QUALITIES,
          videoQualities: [{ id: 'v:1080', label: '1080p', width: 1920, height: 1080 }],
        },
        { hasVideoQuality: true },
      ),
    ).toBe(0);
  });

  it('builds streamlined root nav rows and videoQuality radio items', () => {
    const i18n = createAppI18n('en');
    const rows = buildSettingsNavRows(TRACKS_WITH_QUALITIES, false, 1, i18n, undefined, undefined, {
      showVideoQuality: true,
      selectedVideoQualityId: null,
    });

    // delay/style/device are inside level-2 settings, not on root
    expect(rows.find((r) => r[0] === 'player-settings-row-audio-delay')).toBeUndefined();
    expect(rows.find((r) => r[0] === 'player-settings-row-subtitle-delay')).toBeUndefined();
    expect(rows.find((r) => r[0] === 'player-settings-row-video-quality')?.[3]).toBe('Auto');

    const onSelectVideoQuality = vi.fn();
    const qualityItems = buildSettingsRadioItems({
      view: 'videoQuality',
      tracks: TRACKS_WITH_QUALITIES,
      playbackSpeed: 1,
      selectedVideoQualityId: 'v:1080',
      i18n,
      onSelectAudio: vi.fn(),
      onSelectSubtitle: vi.fn(),
      onSelectVideoQuality,
    });
    expect(qualityItems.map((i) => [i.label, i.selected])).toEqual([
      ['Auto', false],
      ['1080p · 50 fps · 5.0 Mbps', true],
      ['720p · 25 fps · 850 kbps', false],
    ]);
    qualityItems[0]?.onPress();
    expect(onSelectVideoQuality).toHaveBeenCalledWith(null);
  });
});
