import { describe, expect, it } from 'vitest';
import { LAUNCH_OPTIONS, loadfileCommand } from './options.ts';
import { OBSERVED_PROPERTIES, TRACK_PROPERTIES } from './session-constants.ts';
import {
  inspectMpvTracks,
  mediaTracksEqual,
  parseProgramCommand,
  parseProgramNumber,
} from './track-snapshot.ts';
import { createTrackTracker } from './tracks.ts';

const MULTI_PROGRAM_TRACK_LIST = [
  {
    id: 1,
    type: 'video',
    codec: 'h264',
    'demux-w': 1920,
    'demux-h': 1080,
    'program-id': 202,
    'service-name': 'Sports HD',
    selected: false,
  },
  {
    id: 2,
    type: 'video',
    codec: 'h264',
    'demux-w': 1920,
    'demux-h': 1080,
    'program-id': 101,
    'service-name': 'News HD',
    selected: true,
  },
  {
    id: 1,
    type: 'audio',
    lang: 'eng',
    title: 'English',
    codec: 'aac',
    'demux-channel-count': 2,
    'program-id': 101,
    selected: true,
  },
  {
    id: 2,
    type: 'audio',
    lang: 'tur',
    title: 'Turkish',
    codec: 'aac',
    'demux-channel-count': 2,
    'program-id': 101,
    selected: false,
  },
  {
    id: 3,
    type: 'audio',
    lang: 'eng',
    title: 'English',
    codec: 'eac3',
    'demux-channel-count': 6,
    'program-id': 202,
    selected: false,
  },
  {
    id: 1,
    type: 'sub',
    lang: 'eng',
    title: 'English DVB',
    codec: 'dvb_subtitle',
    'program-id': 101,
    selected: false,
  },
  {
    id: 2,
    type: 'sub',
    lang: 'eng',
    title: 'English DVB',
    codec: 'dvb_subtitle',
    'program-id': 202,
    selected: false,
  },
  {
    id: 3,
    type: 'sub',
    lang: 'tur',
    title: 'External Sidecar',
    codec: 'subrip',
    external: true,
    selected: false,
  },
];

describe('Wave F7B mpv multi-program options & constants (#304)', () => {
  it('observes program property and routes it to TrackTracker', () => {
    expect(OBSERVED_PROPERTIES).toContain('program');
    expect(TRACK_PROPERTIES.has('program')).toBe(true);
  });

  it('resets program on next file so a selected service never leaks across channels', () => {
    const resetOpt = LAUNCH_OPTIONS.find((opt) => opt.startsWith('--reset-on-next-file='));
    expect(resetOpt).toBeDefined();
    const names = resetOpt?.slice('--reset-on-next-file='.length).split(',') ?? [];
    expect(names).toContain('program');
  });

  it('passes program=<num> in loadfileCommand when a valid programId is supplied', () => {
    const base = { url: 'http://sim.test/live/mux.ts', headers: {}, kind: 'live' as const };
    const withProg = loadfileCommand({ ...base, programId: '202' })[4] as Record<string, string>;
    expect(withProg['program']).toBe('202');

    const withZero = loadfileCommand({ ...base, programId: '0' })[4] as Record<string, string>;
    expect(withZero['program']).toBe('0');

    const withInvalid = loadfileCommand({ ...base, programId: 'not-a-number' })[4] as Record<
      string,
      string
    >;
    expect(withInvalid).not.toHaveProperty('program');
  });
});

describe('inspectMpvTracks multi-program MPEG-TS support (#304)', () => {
  it('parses program-id onto tracks, builds sorted ProgramInfo[], and preserves per-program video qualities', () => {
    const snapshot = inspectMpvTracks(MULTI_PROGRAM_TRACK_LIST, 1, false, 'no', null, undefined);

    expect(snapshot.programs).toEqual([
      { id: '101', label: 'News HD', serviceName: 'News HD', programNumber: 101 },
      { id: '202', label: 'Sports HD', serviceName: 'Sports HD', programNumber: 202 },
    ]);
    expect(snapshot.selectedProgramId).toBe('101');
    expect(snapshot.audio.map((t) => ({ id: t.id, programId: t.programId }))).toEqual([
      { id: 'a:1', programId: '101' },
      { id: 'a:2', programId: '101' },
      { id: 'a:3', programId: '202' },
    ]);
    expect(snapshot.subtitles.map((t) => ({ id: t.id, programId: t.programId }))).toEqual([
      { id: 's:1', programId: '101' },
      { id: 's:2', programId: '202' },
      { id: 's:3', programId: undefined },
    ]);
    // Both 1080p video tracks belong to different programs so neither is dropped by deduplication
    expect(snapshot.videoQualities?.map((v) => ({ id: v.id, programId: v.programId }))).toEqual([
      { id: '1', programId: '202' },
      { id: '2', programId: '101' },
    ]);
  });

  it('prefers observed mpv program property, then selected video/audio track, then first program', () => {
    // Observed mpv program property overrides selected track fallback
    expect(
      inspectMpvTracks(MULTI_PROGRAM_TRACK_LIST, 1, false, 'no', null, 202).selectedProgramId,
    ).toBe('202');

    // Unknown observed program falls back to selected video track (101)
    expect(
      inspectMpvTracks(MULTI_PROGRAM_TRACK_LIST, 1, false, 'no', null, 999).selectedProgramId,
    ).toBe('101');

    // Without selected video, falls back to selected audio track's programId
    const noSelectedVideo = MULTI_PROGRAM_TRACK_LIST.map((t) =>
      t.type === 'video' ? { ...t, selected: false } : t,
    );
    expect(inspectMpvTracks(noSelectedVideo, 3, false, 'no', null, 'auto').selectedProgramId).toBe(
      '202',
    );

    // Without any selected track, falls back to first sorted program
    const noneSelected = MULTI_PROGRAM_TRACK_LIST.map((t) => ({ ...t, selected: false }));
    expect(
      inspectMpvTracks(noneSelected, 'no', 'no', 'no', null, undefined).selectedProgramId,
    ).toBe('101');
  });

  it('supports demux-via-program fallback and default "Program <id>" labels, and omits programs when <= 1 distinct program exists', () => {
    const fallbackTracks = [
      { id: 1, type: 'video', codec: 'h264', 'demux-via-program': 5, selected: true },
      { id: 2, type: 'video', codec: 'h264', 'demux-via-program': 2, selected: false },
    ];
    const multi = inspectMpvTracks(fallbackTracks, false, false, 'no', null, undefined);
    expect(multi.programs).toEqual([
      { id: '2', label: 'Program 2', programNumber: 2 },
      { id: '5', label: 'Program 5', programNumber: 5 },
    ]);
    expect(multi.selectedProgramId).toBe('5');

    const singleProgram = [
      { id: 1, type: 'video', codec: 'h264', 'program-id': 101, selected: true },
      { id: 1, type: 'audio', lang: 'eng', 'program-id': 101, selected: true },
    ];
    const single = inspectMpvTracks(singleProgram, 1, false, 'no', null, 101);
    expect(single.programs).toBeUndefined();
    expect(single.selectedProgramId).toBeUndefined();
    expect(single.audio[0]?.programId).toBe('101');
  });

  it('detects changes in programs, selectedProgramId, and track programId in mediaTracksEqual', () => {
    const a = inspectMpvTracks(MULTI_PROGRAM_TRACK_LIST, 1, false, 'no', null, 101);
    const b = inspectMpvTracks(MULTI_PROGRAM_TRACK_LIST, 1, false, 'no', null, 202);
    const aCopy = inspectMpvTracks(MULTI_PROGRAM_TRACK_LIST, 1, false, 'no', null, 101);
    expect(mediaTracksEqual(a, aCopy)).toBe(true);
    expect(mediaTracksEqual(a, b)).toBe(false);

    const changedProgramTrack = inspectMpvTracks(
      [{ id: 1, type: 'audio', lang: 'eng', 'program-id': 1, selected: true }],
      1,
      false,
    );
    const changedProgramTrack2 = inspectMpvTracks(
      [{ id: 1, type: 'audio', lang: 'eng', 'program-id': 2, selected: true }],
      1,
      false,
    );
    expect(mediaTracksEqual(changedProgramTrack, changedProgramTrack2)).toBe(false);
  });

  it('validates and builds set_property program commands safely', () => {
    expect(parseProgramNumber('0')).toBe(0);
    expect(parseProgramNumber('101')).toBe(101);
    expect(parseProgramNumber('2147483647')).toBe(2147483647);
    expect(parseProgramNumber('2147483648')).toBeUndefined();
    expect(parseProgramNumber('-1')).toBeUndefined();
    expect(parseProgramNumber('01')).toBeUndefined();
    expect(parseProgramNumber('p:101')).toBeUndefined();
    expect(parseProgramNumber('')).toBeUndefined();

    expect(parseProgramCommand('202')).toEqual(['set_property', 'program', 202]);
    expect(parseProgramCommand('0')).toEqual(['set_property', 'program', 0]);
    expect(parseProgramCommand('bad')).toBeUndefined();
  });
});

describe('createTrackTracker multi-program scoping & reconciliation (#304)', () => {
  it('emits tracks events on program property changes and sends set_property program on selectProgram', () => {
    const tracker = createTrackTracker();
    tracker.onLoad();
    tracker.beginMedia(1);

    const first = tracker.property('track-list', MULTI_PROGRAM_TRACK_LIST);
    expect(first).toHaveLength(1);
    expect(first[0]?.type === 'tracks' && first[0].tracks.selectedProgramId).toBe('101');

    expect(tracker.selectProgram('202')).toEqual(['set_property', 'program', 202]);
    expect(tracker.selectProgram('invalid')).toBeUndefined();

    const updated = tracker.property('program', 202);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.type === 'tracks' && updated[0].tracks.selectedProgramId).toBe('202');
  });

  it('scopes audio and subtitle preference reconciliation to selectedProgramId while preserving external subtitles', () => {
    const tracker = createTrackTracker();
    tracker.onLoad();
    tracker.beginMedia(1);
    tracker.property('track-list', MULTI_PROGRAM_TRACK_LIST);
    tracker.property('program', 101);

    // User selected English audio (a:1) and English sub (s:1) on Program 101
    expect(tracker.selectAudio('a:1')).toEqual(['set_property', 'aid', 1]);
    expect(tracker.selectSubtitle('s:1')).toEqual(['set_property', 'sid', 1]);

    // Reload directly into Program 202: reconciliation MUST pick Program 202's English tracks (a:3, s:2), NOT Program 101's (a:1, s:1)
    tracker.onLoad({ programId: '202', audioTrackId: 'a:1', subtitleTrackId: 's:1' });
    tracker.beginMedia(2);
    tracker.property('track-list', MULTI_PROGRAM_TRACK_LIST);
    tracker.property('program', 202);
    tracker.property('aid', 1);
    tracker.property('sid', 1);

    expect(tracker.reconcileCommands()).toEqual([
      ['set_property', 'aid', 3],
      ['set_property', 'sid', 2],
    ]);
  });

  it('re-applies saved programId on retry/reload when mpv defaults to another program', () => {
    const tracker = createTrackTracker();
    tracker.onLoad({ programId: '202' });
    tracker.beginMedia(1);
    tracker.property('track-list', MULTI_PROGRAM_TRACK_LIST);
    tracker.property('program', 101);
    tracker.property('aid', 1);

    expect(tracker.reconcileCommands()).toEqual([['set_property', 'program', 202]]);
    // Already reconciled
    expect(tracker.reconcileCommands()).toEqual([]);
  });
});
