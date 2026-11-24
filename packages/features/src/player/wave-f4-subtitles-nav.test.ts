import { DEFAULT_SUBTITLE_STYLE } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { clampSettingsMenu, routeSettingsMenuKey, settingsRowCount } from './settings-menu-nav';
import {
  formatSubtitleStyleSummary,
  isValidExternalSubtitleHttpUrl,
  SUBTITLE_STYLE_ROW_COUNT,
  stepSubtitleStyleField,
} from './subtitle-style-helpers';
import {
  activatePickerCursor,
  buildSubtitleColumnEntries,
  clampPickerCursor,
  routePickerKey,
} from './track-picker-nav';

const DUAL_TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng' }],
  subtitles: [
    { id: 's:1', language: 'eng' },
    { id: 's:2', language: 'tur' },
    { id: 'ext:1', language: 'deu', label: 'German External', external: true },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
  selectedSecondarySubtitleId: 's:2',
};

describe('Wave F4 track-picker-nav dual & external subtitles (#32, #402)', () => {
  it('appends secondary subtitle rows (marking active primary disabled) and external subtitle actions', () => {
    const opts = {
      dualSubtitles: true,
      canPickSubtitleFile: true,
      canLoadSubtitleUrl: true,
    };
    const entries = buildSubtitleColumnEntries(DUAL_TRACKS, opts);
    // 1 primaryOff + 3 primary + 1 secondaryOff + 3 secondary + 2 external actions = 10
    expect(entries).toHaveLength(10);
    expect(entries[4]).toEqual({ kind: 'secondaryOff' });
    expect(entries[5]).toMatchObject({ kind: 'secondaryTrack', disabled: true });
    expect(entries[6]).toMatchObject({ kind: 'secondaryTrack', disabled: false });
    expect(entries[8]).toEqual({ kind: 'pickSubtitleFile' });
    expect(entries[9]).toEqual({ kind: 'loadSubtitleUrl' });

    // Selecting disabled secondary track (same as primary s:1) returns null
    expect(activatePickerCursor({ column: 'subtitles', index: 5 }, DUAL_TRACKS, opts)).toBeNull();
    // Selecting secondary Off clears secondary subtitle
    expect(activatePickerCursor({ column: 'subtitles', index: 4 }, DUAL_TRACKS, opts)).toEqual({
      kind: 'secondarySubtitle',
      id: null,
    });
    // Selecting another secondary track selects it
    expect(activatePickerCursor({ column: 'subtitles', index: 7 }, DUAL_TRACKS, opts)).toEqual({
      kind: 'secondarySubtitle',
      id: 'ext:1',
    });
    // Selecting external file picker / URL rows emits their actions
    expect(activatePickerCursor({ column: 'subtitles', index: 8 }, DUAL_TRACKS, opts)).toEqual({
      kind: 'pickSubtitleFile',
    });
    expect(activatePickerCursor({ column: 'subtitles', index: 9 }, DUAL_TRACKS, opts)).toEqual({
      kind: 'loadSubtitleUrl',
    });

    // TV D-pad routing reaches external action rows cleanly
    const moved = routePickerKey(
      { key: 'down', kind: 'press', time: 0 },
      { column: 'subtitles', index: 8 },
      DUAL_TRACKS,
      opts,
    );
    expect(moved).toEqual({ kind: 'move', cursor: { column: 'subtitles', index: 9 } });
    expect(
      routePickerKey(
        { key: 'select', kind: 'press', time: 0 },
        { column: 'subtitles', index: 9 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'loadSubtitleUrl' });
    // Clamping drops back when dual/external options turn off
    expect(clampPickerCursor({ column: 'subtitles', index: 9 }, DUAL_TRACKS)).toEqual({
      column: 'subtitles',
      index: 3,
    });
  });
});

describe('Wave F4 settings-menu-nav subtitle styling & dual/external subtitles (#32, #402)', () => {
  it('routes Left/Right/Select inside subtitleStyle sub-view and resets on row 5', () => {
    const opts = { hasSubtitleStyle: true };
    expect(settingsRowCount('subtitleStyle', DUAL_TRACKS, opts)).toBe(SUBTITLE_STYLE_ROW_COUNT);
    expect(settingsRowCount('subtitleStyle', DUAL_TRACKS, { hasSubtitleStyle: false })).toBe(0);
    expect(
      clampSettingsMenu({ view: 'subtitleStyle', index: 2 }, DUAL_TRACKS, {
        hasSubtitleStyle: false,
      }),
    ).toEqual({ view: 'root', index: 0 });

    // Enter subtitleStyle from root index 2 (subtitles, audio, subtitleStyle)
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'root', index: 2 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'subtitleStyle', index: 0 } });

    // Left / Right / Select step fontSize on row 0
    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'subtitleStyle', index: 0 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'fontSize', delta: 1 });
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'subtitleStyle', index: 1 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'textColor', delta: -1 });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitleStyle', index: 4 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'verticalPosition', delta: 1 });

    // Row 5 (Reset): Select emits resetSubtitleStyle, Left returns to root index 2
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitleStyle', index: 5 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'resetSubtitleStyle' });
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'subtitleStyle', index: 5 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 2 } });

    // Back from any subtitleStyle row returns to root index 2
    expect(
      routeSettingsMenuKey(
        { key: 'back', kind: 'press', time: 0 },
        { view: 'subtitleStyle', index: 2 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'root', index: 2 } });
  });

  it('cycles every SubtitleStyleConfig field cleanly and formats localized summary', () => {
    const i18n = createAppI18n('en');
    expect(formatSubtitleStyleSummary(DEFAULT_SUBTITLE_STYLE, i18n)).toBe('Medium · White');

    const s1 = stepSubtitleStyleField(DEFAULT_SUBTITLE_STYLE, 'fontSize', 1);
    expect(s1.fontSize).toBe('large');
    const s2 = stepSubtitleStyleField(s1, 'textColor', -1);
    expect(s2.textColor).toBe('green');
    const s3 = stepSubtitleStyleField(s2, 'backgroundColor', 1);
    expect(s3.backgroundColor).toBe('opaque');
    const s4 = stepSubtitleStyleField(s3, 'edgeStyle', 1);
    expect(s4.edgeStyle).toBe('dropShadow');
    const s5 = stepSubtitleStyleField(s4, 'verticalPosition', -1);
    expect(s5.verticalPosition).toBe('top');
    expect(formatSubtitleStyleSummary(s5, i18n)).toBe('Large · Green');
  });

  it('validates external subtitle HTTP(S) URLs strictly and rejects non-HTTP schemes (#32, #308)', () => {
    expect(isValidExternalSubtitleHttpUrl('https://example.invalid/subs/movie.srt')).toBe(true);
    expect(isValidExternalSubtitleHttpUrl('http://127.0.0.1:8080/captions.vtt')).toBe(true);
    expect(isValidExternalSubtitleHttpUrl('  https://example.invalid/a.ass  ')).toBe(true);
    expect(isValidExternalSubtitleHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidExternalSubtitleHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isValidExternalSubtitleHttpUrl('content://media/sub.srt')).toBe(false);
    expect(isValidExternalSubtitleHttpUrl('data:text/plain;base64,QQ==')).toBe(false);
    expect(isValidExternalSubtitleHttpUrl('')).toBe(false);
    expect(isValidExternalSubtitleHttpUrl('https://example.invalid/sub\r\n.srt')).toBe(false);
  });
});
