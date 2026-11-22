import { describe, expect, it } from 'vitest';
import {
  inspectMpvTracks,
  parseAudioTrackCommand,
  parseSubtitleTrackCommand,
  sameLanguage,
} from './track-snapshot.ts';
import { createTrackTracker } from './tracks.ts';

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

  it('omits undetermined ("und", "zxx", "mul", "mis") or blank languages', () => {
    const tracks = inspectMpvTracks(
      [
        { id: 1, type: 'audio', lang: 'und', title: '   ', selected: true },
        { id: 2, type: 'audio', lang: 'zxx', selected: false },
      ],
      'auto',
      false,
    );
    expect(tracks.audio).toEqual([{ id: 'a:1' }, { id: 'a:2' }]);
    expect(tracks.selectedAudioId).toBe('a:1');
  });

  it('extracts whole-word language from title when lang is und without substring collisions (#189)', () => {
    const tracks = inspectMpvTracks(
      [
        { id: 1, type: 'audio', lang: 'und', title: 'Chinese (Mandarin)', selected: true },
        { id: 2, type: 'audio', lang: 'und', title: 'Japanese', selected: false },
        { id: 3, type: 'audio', lang: 'und', title: '[ES] Stereo', selected: false },
        { id: 4, type: 'sub', lang: 'und', title: 'No Subtitles', selected: false },
      ],
      'auto',
      false,
    );
    expect(tracks.audio.map((t) => t.language)).toEqual(['zh', 'ja', 'es']);
    expect(tracks.subtitles[0]?.language).toBeUndefined();
  });
});

describe('sameLanguage & parseTrackCommand', () => {
  it('normalizes ISO 639-1, ISO 639-2(T+B) and BCP-47 tags safely (#253)', () => {
    expect(sameLanguage('en', 'eng')).toBe(true);
    expect(sameLanguage('en-US', 'eng')).toBe(true);
    expect(sameLanguage('tr', 'tur')).toBe(true);
    expect(sameLanguage('de', 'deu')).toBe(true);
    expect(sameLanguage('deu', 'ger')).toBe(true);
    expect(sameLanguage('fr', 'fra')).toBe(true);
    expect(sameLanguage('fra', 'fre')).toBe(true);
    expect(sameLanguage('zh-Hant', 'chi')).toBe(true);
    expect(sameLanguage('und', 'und')).toBe(false);
    expect(sameLanguage('constructor', '__proto__')).toBe(false);
  });

  it('formats set_property commands for aid and sid and rejects out-of-range ids', () => {
    expect(parseAudioTrackCommand('a:2')).toEqual(['set_property', 'aid', 2]);
    expect(parseAudioTrackCommand('s:2')).toBeUndefined();
    expect(parseAudioTrackCommand('a:0')).toBeUndefined();
    expect(parseAudioTrackCommand('a:999999999999')).toBeUndefined();

    expect(parseSubtitleTrackCommand('s:1')).toEqual(['set_property', 'sid', 1]);
    expect(parseSubtitleTrackCommand(null)).toEqual(['set_property', 'sid', 'no']);
    expect(parseSubtitleTrackCommand('a:1')).toBeUndefined();
  });
});

describe('createTrackTracker', () => {
  it('deduplicates identical MediaTracks snapshots and resolves ISO 639-1/639-2 across reloads', () => {
    const tracker = createTrackTracker();
    tracker.onLoad();
    tracker.beginMedia(1);

    const first = tracker.property('track-list', SAMPLE_TRACK_LIST);
    expect(first).toHaveLength(1);
    expect(tracker.property('track-list', SAMPLE_TRACK_LIST)).toEqual([]);

    expect(tracker.selectAudio('a:2')).toEqual(['set_property', 'aid', 2]);
    expect(tracker.selectSubtitle(null)).toEqual(['set_property', 'sid', 'no']);

    // Reload where HLS rendition switched from 'eng' to 'en-US' and moved to id=3
    tracker.onLoad({ audioTrackId: 'a:2', subtitleTrackId: null });
    tracker.beginMedia(2);
    tracker.property('track-list', [
      { id: 1, type: 'audio', lang: 'tr', title: 'Turkish', selected: true },
      { id: 2, type: 'audio', lang: 'fr', title: 'French', selected: false },
      { id: 3, type: 'audio', lang: 'en-US', title: 'English', selected: false },
      { id: 1, type: 'sub', lang: 'tr', title: 'Turkish SRT', selected: true },
    ]);
    tracker.property('aid', 1);
    tracker.property('sid', 1);

    expect(tracker.reconcileCommands()).toEqual([
      ['set_property', 'aid', 3],
      ['set_property', 'sid', 'no'],
    ]);
  });

  it('does not prematurely latch subPref="off" on transient sid === false when tracks appear', () => {
    const tracker = createTrackTracker();
    tracker.onLoad({ subtitleTrackId: null });
    tracker.beginMedia(1);
    tracker.property('sid', false);
    tracker.property('track-list', []);
    expect(tracker.reconcileCommands()).toEqual([]);

    // Tracks arrive while mpv's observed sid is still transient false (sid=auto before default sub selection)
    tracker.property('track-list', SAMPLE_TRACK_LIST);
    expect(tracker.reconcileCommands()).toEqual([['set_property', 'sid', 'no']]);
    // Never sends duplicate sid='no' for the same media
    expect(tracker.reconcileCommands()).toEqual([]);
  });

  it('sends sid="no" once on file-loaded when subPref="off" even if no subtitle tracks exist yet', () => {
    const tracker = createTrackTracker();
    tracker.onLoad({ subtitleTrackId: null });
    tracker.beginMedia(1);
    tracker.property('sid', false);
    tracker.property('track-list', []);
    expect(tracker.reconcileCommands()).toEqual([]);

    tracker.onFileLoaded();
    expect(tracker.reconcileCommands()).toEqual([['set_property', 'sid', 'no']]);
    expect(tracker.reconcileCommands()).toEqual([]);
  });

  it('does not latch reconciled on empty or audio-only initial track-list updates', () => {
    const tracker = createTrackTracker();
    tracker.onLoad();
    tracker.beginMedia(1);
    tracker.property('track-list', SAMPLE_TRACK_LIST);
    expect(tracker.selectAudio('a:2')).toEqual(['set_property', 'aid', 2]);
    expect(tracker.selectSubtitle('s:2')).toEqual(['set_property', 'sid', 2]);

    tracker.onLoad({ audioTrackId: 'a:2', subtitleTrackId: 's:2' });
    tracker.beginMedia(2);
    tracker.property('track-list', []);
    tracker.property('aid', false);
    tracker.property('sid', false);
    expect(tracker.reconcileCommands()).toEqual([]);

    tracker.property('track-list', [
      { id: 1, type: 'audio', lang: 'tur', title: 'Turkish', selected: true },
      { id: 3, type: 'audio', lang: 'eng', title: 'English', selected: false },
    ]);
    tracker.property('aid', 1);
    expect(tracker.reconcileCommands()).toEqual([['set_property', 'aid', 3]]);

    tracker.property('track-list', [
      { id: 1, type: 'audio', lang: 'tur', title: 'Turkish', selected: false },
      { id: 3, type: 'audio', lang: 'eng', title: 'English', selected: true },
      { id: 1, type: 'sub', lang: 'tur', title: 'Turkish SRT', selected: true },
      { id: 4, type: 'sub', lang: 'eng', title: 'English SRT', selected: false },
    ]);
    tracker.property('aid', 3);
    tracker.property('sid', 1);
    expect(tracker.reconcileCommands()).toEqual([['set_property', 'sid', 4]]);
    expect(tracker.reconcileCommands()).toEqual([]);
  });
});
