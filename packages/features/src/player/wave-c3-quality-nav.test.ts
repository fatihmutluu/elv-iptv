import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  clampSettingsMenu,
  initialSettingsMenu,
  routeSettingsMenuKey,
  settingsRowCount,
} from './settings-menu-nav';
import { buildSettingsNavRows, buildSettingsRadioItems } from './settings-sheet-items';

const EMPTY_TRACKS: MediaTracks = {
  audio: [],
  subtitles: [],
  selectedAudioId: null,
  selectedSubtitleId: null,
};

const VARIANTS = [
  { key: 'x:s1:live:1', title: 'Sports 4K', qualityLabel: '4K', qualityRank: 40 },
  { key: 'x:s1:live:2', title: 'Sports FHD', qualityLabel: 'FHD', qualityRank: 30 },
  { key: 'x:s1:live:3', title: 'Sports HD', qualityLabel: 'HD', qualityRank: 20 },
] as const;

describe('Wave C3 live quality variant menu navigation (#218)', () => {
  it('exposes quality row and sub-view when > 1 variants exist and routes selection', () => {
    const opts = {
      isVod: false,
      hasQuality: true,
      qualityVariants: VARIANTS,
      activeQualityKey: 'x:s1:live:2',
    };

    expect(initialSettingsMenu('quality', opts)).toEqual({ view: 'quality', index: 1 });
    expect(settingsRowCount('quality', EMPTY_TRACKS, opts)).toBe(3);

    const openIntent = routeSettingsMenuKey(
      { kind: 'press', key: 'select', time: 0 },
      { view: 'root', index: 2 },
      EMPTY_TRACKS,
      opts,
    );
    expect(openIntent).toEqual({ kind: 'state', state: { view: 'quality', index: 1 } });

    const pickIntent = routeSettingsMenuKey(
      { kind: 'press', key: 'select', time: 0 },
      { view: 'quality', index: 0 },
      EMPTY_TRACKS,
      opts,
    );
    expect(pickIntent).toEqual({ kind: 'quality', itemKey: 'x:s1:live:1' });

    const clamped = clampSettingsMenu({ view: 'quality', index: 1 }, EMPTY_TRACKS, {
      isVod: false,
      hasQuality: false,
    });
    expect(clamped).toEqual({ view: 'root', index: 0 });
  });

  it('builds localized Stream quality nav row and radio items', () => {
    const i18n = createAppI18n('en');
    const rows = buildSettingsNavRows(EMPTY_TRACKS, false, 1, i18n, undefined, undefined, {
      qualityVariants: VARIANTS,
      activeQualityKey: 'x:s1:live:2',
    });
    const qualityRow = rows.find((r) => r[0] === 'player-settings-row-quality');
    expect(qualityRow).toBeDefined();
    expect(qualityRow?.[3]).toBe('FHD');

    const onSelect = vi.fn();
    const radios = buildSettingsRadioItems({
      view: 'quality',
      tracks: EMPTY_TRACKS,
      playbackSpeed: 1,
      qualityVariants: VARIANTS,
      activeQualityKey: 'x:s1:live:2',
      i18n,
      onSelectAudio: vi.fn(),
      onSelectSubtitle: vi.fn(),
      onSelectQualityVariant: onSelect,
    });
    expect(radios.map((r) => [r.label, r.selected])).toEqual([
      ['4K', false],
      ['FHD', true],
      ['HD', false],
    ]);
    radios[0]?.onPress();
    expect(onSelect).toHaveBeenCalledWith('x:s1:live:1');
  });
});
