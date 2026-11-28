import { DEFAULT_SUBTITLE_STYLE } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  clampSettingsMenu,
  routeSettingsMenuKey,
  settingsRowCount,
  subtitleSettingsMenuEntries,
} from './settings-menu-nav';
import { buildSubtitleSettingsExtraItems } from './settings-sheet-radio-items';
import {
  formatSubtitleStyleSummary,
  isValidExternalSubtitleHttpUrl,
  SUBTITLE_STYLE_ROW_COUNT,
  stepSubtitleStyleField,
} from './subtitle-style-helpers';
import { buildSubtitleColumnEntries } from './track-picker-nav';

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

describe('Wave F4 / Wave R4 2-level subtitleSettings styling & dual/external subtitles (#32, #402)', () => {
  it('builds secondary subtitle rows and external actions in buildSubtitleColumnEntries', () => {
    const entries = buildSubtitleColumnEntries(DUAL_TRACKS, {
      dualSubtitles: true,
      canPickSubtitleFile: true,
      canLoadSubtitleUrl: true,
    });
    expect(entries).toHaveLength(10);
    expect(entries[4]).toEqual({ kind: 'secondaryOff' });
    expect(entries[5]).toMatchObject({ kind: 'secondaryTrack', disabled: true });
    expect(entries[8]).toEqual({ kind: 'pickSubtitleFile' });
    expect(entries[9]).toEqual({ kind: 'loadSubtitleUrl' });
  });

  it('routes Left/Right/Select inside subtitleSettings style rows and returns back to subtitles', () => {
    const opts = { hasSubtitleStyle: true };
    expect(settingsRowCount('subtitleSettings', DUAL_TRACKS, opts)).toBe(SUBTITLE_STYLE_ROW_COUNT);
    expect(settingsRowCount('subtitleSettings', DUAL_TRACKS, { hasSubtitleStyle: false })).toBe(0);
    expect(
      clampSettingsMenu({ view: 'subtitleSettings', index: 2 }, DUAL_TRACKS, {
        hasSubtitleStyle: false,
      }),
    ).toEqual({ view: 'subtitles', index: 1 });

    // From subtitles row 4 (Off + 3 primary tracks + Subtitle settings link) -> enters subtitleSettings
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitles', index: 4 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'subtitleSettings', index: 0 } });

    expect(
      routeSettingsMenuKey(
        { key: 'right', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 0 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'fontSize', delta: 1 });
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 1 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'textColor', delta: -1 });
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 4 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'stepSubtitleStyle', field: 'verticalPosition', delta: 1 });

    // Row 5 (Reset): Select emits resetSubtitleStyle, Left or Back returns to subtitles opener row (4)
    expect(
      routeSettingsMenuKey(
        { key: 'select', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 5 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'resetSubtitleStyle' });
    expect(
      routeSettingsMenuKey(
        { key: 'left', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 5 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'subtitles', index: 4 } });
    expect(
      routeSettingsMenuKey(
        { key: 'back', kind: 'press', time: 0 },
        { view: 'subtitleSettings', index: 2 },
        DUAL_TRACKS,
        opts,
      ),
    ).toEqual({ kind: 'state', state: { view: 'subtitles', index: 4 } });
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

  it('aligns multi-program MPEG-TS subtitleSettingsMenuEntries and buildSubtitleSettingsExtraItems per selected program', () => {
    const i18n = createAppI18n('en');
    const multiProgramBase: MediaTracks = {
      programs: [
        { id: 'p:1', label: 'News HD', serviceName: 'News HD' },
        { id: 'p:2', label: 'Cinema HD', serviceName: 'Cinema HD' },
      ],
      audio: [
        { id: 'a:1', programId: 'p:1', language: 'eng' },
        { id: 'a:2', programId: 'p:2', language: 'eng' },
      ],
      subtitles: [
        { id: 's:1', programId: 'p:1', language: 'eng' },
        { id: 's:2', programId: 'p:2', language: 'eng' },
        { id: 's:3', programId: 'p:2', language: 'tur' },
        { id: 'ext:1', language: 'deu', label: 'German External', external: true },
      ],
      selectedProgramId: 'p:1',
      selectedAudioId: 'a:1',
      selectedSubtitleId: 's:1',
      selectedSecondarySubtitleId: 'ext:1',
    };

    const opts = {
      hasSubtitleDelay: true,
      hasSubtitleStyle: true,
      hasDualSubtitles: true,
      canPickSubtitleFile: true,
      canLoadSubtitleUrl: true,
    };

    const p1Extra = buildSubtitleSettingsExtraItems({
      tracks: multiProgramBase,
      dualSubtitles: true,
      i18n,
      onSelectSecondarySubtitle: () => undefined,
      onPickSubtitleFile: () => undefined,
      onLoadSubtitleUrl: () => undefined,
    });
    const p1NavExtra = subtitleSettingsMenuEntries(multiProgramBase, opts).filter(
      (e) => e.kind !== 'delayStep' && e.kind !== 'styleField' && e.kind !== 'styleReset',
    );
    expect(p1Extra).toHaveLength(p1NavExtra.length);
    expect(p1Extra.map((item) => item.testID)).toEqual([
      'player-settings-secondary-sub-off',
      'player-settings-secondary-sub-s:1',
      'player-settings-secondary-sub-ext:1',
      'player-settings-external-sub-pick',
      'player-settings-external-sub-url',
    ]);
    // Unfiltered program 2 English track is excluded, so English on program 1 has no '#1' suffix
    expect(p1Extra[1]?.label).toBe('English');
    expect(p1Extra[1]?.disabled).toBe(true);

    const p2Tracks: MediaTracks = {
      ...multiProgramBase,
      selectedProgramId: 'p:2',
      selectedAudioId: 'a:2',
      selectedSubtitleId: 's:3',
    };
    const p2Extra = buildSubtitleSettingsExtraItems({
      tracks: p2Tracks,
      dualSubtitles: true,
      i18n,
      onSelectSecondarySubtitle: () => undefined,
      onPickSubtitleFile: () => undefined,
      onLoadSubtitleUrl: () => undefined,
    });
    const p2NavExtra = subtitleSettingsMenuEntries(p2Tracks, opts).filter(
      (e) => e.kind !== 'delayStep' && e.kind !== 'styleField' && e.kind !== 'styleReset',
    );
    expect(p2Extra).toHaveLength(p2NavExtra.length);
    expect(p2Extra.map((item) => item.testID)).toEqual([
      'player-settings-secondary-sub-off',
      'player-settings-secondary-sub-s:2',
      'player-settings-secondary-sub-s:3',
      'player-settings-secondary-sub-ext:1',
      'player-settings-external-sub-pick',
      'player-settings-external-sub-url',
    ]);
  });
});
