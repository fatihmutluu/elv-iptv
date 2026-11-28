import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
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

describe('track-picker-nav buildSubtitleColumnEntries', () => {
  it('builds primary Off + tracks without dual/external options', () => {
    expect(buildSubtitleColumnEntries(DUAL_TRACKS)).toEqual([
      { kind: 'primaryOff' },
      { kind: 'primaryTrack', track: DUAL_TRACKS.subtitles[0], trackIndex: 0 },
      { kind: 'primaryTrack', track: DUAL_TRACKS.subtitles[1], trackIndex: 1 },
      { kind: 'primaryTrack', track: DUAL_TRACKS.subtitles[2], trackIndex: 2 },
    ]);
  });

  it('appends secondary subtitle rows (disabling active primary) and external subtitle actions', () => {
    const entries = buildSubtitleColumnEntries(DUAL_TRACKS, {
      dualSubtitles: true,
      canPickSubtitleFile: true,
      canLoadSubtitleUrl: true,
    });
    expect(entries).toHaveLength(10);
    expect(entries[4]).toEqual({ kind: 'secondaryOff' });
    expect(entries[5]).toMatchObject({ kind: 'secondaryTrack', disabled: true });
    expect(entries[6]).toMatchObject({ kind: 'secondaryTrack', disabled: false });
    expect(entries[8]).toEqual({ kind: 'pickSubtitleFile' });
    expect(entries[9]).toEqual({ kind: 'loadSubtitleUrl' });
  });
});
