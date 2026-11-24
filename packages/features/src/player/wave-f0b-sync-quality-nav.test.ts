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

describe('Wave F0B sync delay & adaptive video quality navigation (#59)', () => {
  it('formats signed sync delay offsets cleanly', () => {
    expect(formatSyncDelayMs(0)).toBe('0 ms');
    expect(formatSyncDelayMs(150)).toBe('+150 ms');
    expect(formatSyncDelayMs(-50)).toBe('-50 ms');
    expect(formatSyncDelayMs(Number.NaN)).toBe('0 ms');
  });

  it('routes audioDelay, subtitleDelay, and videoQuality sub-views and intents', () => {
    const opts = {
      isVod: false,
      hasAudioDelay: true,
      audioDelayMs: 150,
      hasSubtitleDelay: true,
      subtitleDelayMs: -50,
      hasVideoQuality: true,
      selectedVideoQualityId: 'v:720',
    };

    expect(initialSettingsMenu('audioDelay', opts)).toEqual({
      view: 'audioDelay',
      index: SYNC_DELAY_RESET_INDEX,
    });
    expect(settingsRowCount('audioDelay', TRACKS_WITH_QUALITIES, opts)).toBe(5);
    expect(settingsRowCount('subtitleDelay', TRACKS_WITH_QUALITIES, opts)).toBe(5);
    expect(settingsRowCount('videoQuality', TRACKS_WITH_QUALITIES, opts)).toBe(3);

    // Root row 2 is audioDelay, 3 is subtitleDelay, 4 is videoQuality
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 2 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'audioDelay', index: SYNC_DELAY_RESET_INDEX } });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'audioDelay', index: 4 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'audioDelay', deltaMs: 250 });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'audioDelay', index: 2 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'audioDelay', deltaMs: 0, reset: true });

    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'subtitleDelay', index: 1 },
        TRACKS_WITH_QUALITIES,
        opts,
      ),
    ).toEqual({ kind: 'subtitleDelay', deltaMs: -50 });

    // Open videoQuality pre-selects v:720 (index 2: 0=Auto, 1=1080p, 2=720p)
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'root', index: 4 },
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

    // Clamps back to root when capabilities are absent
    expect(
      clampSettingsMenu({ view: 'audioDelay', index: 2 }, TRACKS_WITH_QUALITIES, {
        hasAudioDelay: false,
      }),
    ).toEqual({ view: 'root', index: 0 });
    expect(
      clampSettingsMenu({ view: 'videoQuality', index: 1 }, TRACKS_WITH_QUALITIES, {
        hasVideoQuality: false,
      }),
    ).toEqual({ view: 'root', index: 0 });
  });

  it('builds localized nav rows and stepper/quality radio items', () => {
    const i18n = createAppI18n('en');
    const rows = buildSettingsNavRows(TRACKS_WITH_QUALITIES, false, 1, i18n, undefined, undefined, {
      showAudioDelay: true,
      audioDelayMs: 150,
      showSubtitleDelay: true,
      subtitleDelayMs: -50,
      showVideoQuality: true,
      selectedVideoQualityId: null,
    });

    expect(rows.find((r) => r[0] === 'player-settings-row-audio-delay')?.[3]).toBe('+150 ms');
    expect(rows.find((r) => r[0] === 'player-settings-row-subtitle-delay')?.[3]).toBe('-50 ms');
    expect(rows.find((r) => r[0] === 'player-settings-row-video-quality')?.[3]).toBe('Auto');

    const onAdjustAudioDelay = vi.fn();
    const audioDelayItems = buildSettingsRadioItems({
      view: 'audioDelay',
      tracks: TRACKS_WITH_QUALITIES,
      playbackSpeed: 1,
      audioDelayMs: 0,
      i18n,
      onSelectAudio: vi.fn(),
      onSelectSubtitle: vi.fn(),
      onAdjustAudioDelay,
    });
    expect(audioDelayItems.map((i) => i.label)).toEqual([
      '-250 ms',
      '-50 ms',
      'Reset (0 ms)',
      '+50 ms',
      '+250 ms',
    ]);
    expect(audioDelayItems[2]?.selected).toBe(true);
    audioDelayItems[4]?.onPress();
    expect(onAdjustAudioDelay).toHaveBeenCalledWith(250, false);
    audioDelayItems[2]?.onPress();
    expect(onAdjustAudioDelay).toHaveBeenCalledWith(0, true);

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
