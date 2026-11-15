import { describe, expect, it } from 'vitest';
import {
  createTrackTracker,
  inspectMpvTracks,
  parseAudioTrackCommand,
  parseSubtitleTrackCommand,
} from './tracks.ts';

const SAMPLE_TRACK_LIST = [
  { id: 1, type: 'video', codec: 'h264', selected: true },
  {
    id: 1,
    type: 'audio',
    lang: 'tur',
    title: 'Turkish',
    codec: 'aac',
    'demux-channel-count': 2,
    default: true,
    selected: true,
  },
  {
    id: 2,
    type: 'audio',
    lang: 'eng',
    title: 'English',
    codec: 'eac3',
    'demux-channel-count': 6,
    selected: false,
  },
  {
    id: 1,
    type: 'sub',
    lang: 'tur',
    title: 'Turkish SRT',
    codec: 'subrip',
    forced: true,
    selected: true,
  },
  {
    id: 2,
    type: 'sub',
    lang: 'eng',
    title: 'English SRT',
    codec: 'subrip',
    selected: false,
  },
];

describe('inspectMpvTracks', () => {
  it('maps audio and sub tracks to a:<id> and s:<id> with active selections', () => {
    const snapshot = inspectMpvTracks(SAMPLE_TRACK_LIST, 1, 1);
    expect(snapshot).toEqual({
      audio: [
        {
          id: 'a:1',
          language: 'tur',
          label: 'Turkish',
          codec: 'aac',
          channels: 2,
          isDefault: true,
        },
        {
          id: 'a:2',
          language: 'eng',
          label: 'English',
          codec: 'eac3',
          channels: 6,
        },
      ],
      subtitles: [
        {
          id: 's:1',
          language: 'tur',
          label: 'Turkish SRT',
          codec: 'subrip',
          forced: true,
        },
        {
          id: 's:2',
          language: 'eng',
          label: 'English SRT',
          codec: 'subrip',
        },
      ],
      selectedAudioId: 'a:1',
      selectedSubtitleId: 's:1',
    });
  });

  it('reports selectedSubtitleId as null when sid is false or "no"', () => {
    expect(inspectMpvTracks(SAMPLE_TRACK_LIST, 2, false).selectedAudioId).toBe('a:2');
    expect(inspectMpvTracks(SAMPLE_TRACK_LIST, 2, false).selectedSubtitleId).toBeNull();
    expect(inspectMpvTracks(SAMPLE_TRACK_LIST, 2, 'no').selectedSubtitleId).toBeNull();
  });

  it('omits undetermined ("und") or blank languages', () => {
    const tracks = inspectMpvTracks(
      [{ id: 1, type: 'audio', lang: 'und', title: '   ', selected: true }],
      'auto',
      false,
    );
    expect(tracks.audio).toEqual([{ id: 'a:1' }]);
    expect(tracks.selectedAudioId).toBe('a:1');
  });
});

describe('parseAudioTrackCommand & parseSubtitleTrackCommand', () => {
  it('formats set_property commands for aid and sid including "no" for null Off', () => {
    expect(parseAudioTrackCommand('a:2')).toEqual(['set_property', 'aid', 2]);
    expect(parseAudioTrackCommand('s:2')).toBeUndefined();
    expect(parseAudioTrackCommand('a:0')).toBeUndefined();

    expect(parseSubtitleTrackCommand('s:1')).toEqual(['set_property', 'sid', 1]);
    expect(parseSubtitleTrackCommand(null)).toEqual(['set_property', 'sid', 'no']);
    expect(parseSubtitleTrackCommand('a:1')).toBeUndefined();
  });
});

describe('createTrackTracker', () => {
  it('deduplicates identical MediaTracks snapshots and resolves language+label across reloads', () => {
    const tracker = createTrackTracker();
    tracker.onLoad();
    tracker.beginMedia(1);

    const first = tracker.property('track-list', SAMPLE_TRACK_LIST);
    expect(first).toHaveLength(1);
    expect(tracker.property('track-list', SAMPLE_TRACK_LIST)).toEqual([]);

    expect(tracker.selectAudio('a:2')).toEqual(['set_property', 'aid', 2]);
    expect(tracker.selectSubtitle(null)).toEqual(['set_property', 'sid', 'no']);

    // Simulate recovery reload where English audio moved from id=2 to id=3
    tracker.onLoad({ audioTrackId: 'a:2', subtitleTrackId: null });
    tracker.beginMedia(2);
    tracker.property('track-list', [
      { id: 1, type: 'audio', lang: 'tur', title: 'Turkish', selected: true },
      { id: 2, type: 'audio', lang: 'fra', title: 'French', selected: false },
      { id: 3, type: 'audio', lang: 'eng', title: 'English', selected: false },
      { id: 1, type: 'sub', lang: 'tur', title: 'Turkish SRT', selected: true },
    ]);
    tracker.property('aid', 1);
    tracker.property('sid', 1);

    expect(tracker.reconcileCommands()).toEqual([
      ['set_property', 'aid', 3],
      ['set_property', 'sid', 'no'],
    ]);
  });
});
