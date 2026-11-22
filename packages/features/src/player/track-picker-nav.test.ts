import type { MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  activatePickerCursor,
  clampPickerCursor,
  initialPickerCursor,
  movePickerCursor,
  routePickerKey,
} from './track-picker-nav';

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur' },
    { id: 'a:2', language: 'eng' },
    { id: 'a:3', language: 'deu' },
  ],
  subtitles: [
    { id: 's:1', language: 'tur' },
    { id: 's:2', language: 'eng' },
  ],
  selectedAudioId: 'a:2',
  selectedSubtitleId: 's:2',
};

const NO_AUDIO: MediaTracks = { ...TRACKS, audio: [], selectedAudioId: null };

describe('initialPickerCursor', () => {
  it('starts on the selected audio track', () => {
    expect(initialPickerCursor(TRACKS)).toEqual({ column: 'audio', index: 1 });
  });

  it('falls back to the first audio row when the selection is unknown', () => {
    expect(initialPickerCursor({ ...TRACKS, selectedAudioId: 'zz' })).toEqual({
      column: 'audio',
      index: 0,
    });
  });

  it('starts on the selected subtitle row (Off is row 0) without audio', () => {
    expect(initialPickerCursor(NO_AUDIO)).toEqual({ column: 'subtitles', index: 2 });
    expect(initialPickerCursor({ ...NO_AUDIO, selectedSubtitleId: null })).toEqual({
      column: 'subtitles',
      index: 0,
    });
    expect(initialPickerCursor({ ...NO_AUDIO, selectedSubtitleId: 'zz' })).toEqual({
      column: 'subtitles',
      index: 0,
    });
  });

  it('honors preferredColumn for captions/audioTrack shortcut opening', () => {
    expect(initialPickerCursor(TRACKS, 'subtitles')).toEqual({ column: 'subtitles', index: 2 });
    expect(initialPickerCursor(TRACKS, 'audio')).toEqual({ column: 'audio', index: 1 });
    expect(initialPickerCursor(NO_AUDIO, 'audio')).toEqual({ column: 'subtitles', index: 2 });
  });
});

describe('clampPickerCursor', () => {
  it('returns the same cursor object when it is still valid', () => {
    const cursor = { column: 'audio', index: 2 } as const;
    expect(clampPickerCursor(cursor, TRACKS)).toBe(cursor);
  });

  it('clamps an audio index past the end after the list shrinks', () => {
    const shrunk: MediaTracks = { ...TRACKS, audio: [{ id: 'a:1', language: 'tur' }] };
    expect(clampPickerCursor({ column: 'audio', index: 2 }, shrunk)).toEqual({
      column: 'audio',
      index: 0,
    });
  });

  it('moves to the subtitle selection when the audio column disappears', () => {
    expect(clampPickerCursor({ column: 'audio', index: 2 }, NO_AUDIO)).toEqual({
      column: 'subtitles',
      index: 2,
    });
  });

  it('clamps a subtitle index to the Off row plus subtitle count', () => {
    const fewer: MediaTracks = { ...TRACKS, subtitles: [], selectedSubtitleId: null };
    expect(clampPickerCursor({ column: 'subtitles', index: 2 }, fewer)).toEqual({
      column: 'subtitles',
      index: 0,
    });
  });

  it('clamps a negative index to zero', () => {
    expect(clampPickerCursor({ column: 'subtitles', index: -3 }, TRACKS)).toEqual({
      column: 'subtitles',
      index: 0,
    });
  });
});

describe('movePickerCursor', () => {
  it('moves down and up within the audio column and stops at both ends', () => {
    expect(movePickerCursor({ column: 'audio', index: 1 }, TRACKS, 'down')).toEqual({
      column: 'audio',
      index: 2,
    });
    expect(movePickerCursor({ column: 'audio', index: 2 }, TRACKS, 'down')).toEqual({
      column: 'audio',
      index: 2,
    });
    expect(movePickerCursor({ column: 'audio', index: 0 }, TRACKS, 'up')).toEqual({
      column: 'audio',
      index: 0,
    });
  });

  it('counts the Off row in the subtitle column', () => {
    expect(movePickerCursor({ column: 'subtitles', index: 1 }, TRACKS, 'down')).toEqual({
      column: 'subtitles',
      index: 2,
    });
    expect(movePickerCursor({ column: 'subtitles', index: 2 }, TRACKS, 'down')).toEqual({
      column: 'subtitles',
      index: 2,
    });
  });

  it('jumps right to the selected subtitle row and left to the selected audio row', () => {
    expect(movePickerCursor({ column: 'audio', index: 0 }, TRACKS, 'right')).toEqual({
      column: 'subtitles',
      index: 2,
    });
    expect(
      movePickerCursor(
        { column: 'audio', index: 0 },
        { ...TRACKS, selectedSubtitleId: null },
        'right',
      ),
    ).toEqual({ column: 'subtitles', index: 0 });
    expect(movePickerCursor({ column: 'subtitles', index: 0 }, TRACKS, 'left')).toEqual({
      column: 'audio',
      index: 1,
    });
  });

  it('keeps the index when pressing Left in audio or Right in subtitles', () => {
    const inAudio = { column: 'audio', index: 2 } as const;
    const inSubs = { column: 'subtitles', index: 1 } as const;
    expect(movePickerCursor(inAudio, TRACKS, 'left')).toBe(inAudio);
    expect(movePickerCursor(inSubs, TRACKS, 'right')).toBe(inSubs);
  });

  it('ignores Left when there is no audio column', () => {
    const cursor = { column: 'subtitles', index: 1 } as const;
    expect(movePickerCursor(cursor, NO_AUDIO, 'left')).toBe(cursor);
  });

  it('clamps a stale cursor before moving', () => {
    expect(movePickerCursor({ column: 'audio', index: 5 }, NO_AUDIO, 'up')).toEqual({
      column: 'subtitles',
      index: 1,
    });
  });
});

describe('activatePickerCursor', () => {
  it('selects the audio track under the cursor', () => {
    expect(activatePickerCursor({ column: 'audio', index: 2 }, TRACKS)).toEqual({
      kind: 'audio',
      id: 'a:3',
    });
  });

  it('selects Off on subtitle row 0 and the subtitle track below it', () => {
    expect(activatePickerCursor({ column: 'subtitles', index: 0 }, TRACKS)).toEqual({
      kind: 'subtitle',
      id: null,
    });
    expect(activatePickerCursor({ column: 'subtitles', index: 1 }, TRACKS)).toEqual({
      kind: 'subtitle',
      id: 's:1',
    });
  });

  it('activates the clamped row for a stale cursor', () => {
    expect(activatePickerCursor({ column: 'audio', index: 9 }, NO_AUDIO)).toEqual({
      kind: 'subtitle',
      id: 's:2',
    });
  });
});

describe('routePickerKey', () => {
  it('moves on arrow presses and up/down repeats, activates on select, and ignores horizontal repeats', () => {
    const cur = { column: 'audio', index: 0 } as const;
    expect(routePickerKey({ key: 'down', kind: 'repeat', time: 0 }, cur, TRACKS)).toEqual({
      kind: 'move',
      cursor: { column: 'audio', index: 1 },
    });
    expect(routePickerKey({ key: 'right', kind: 'repeat', time: 0 }, cur, TRACKS)).toBeNull();
    expect(routePickerKey({ key: 'right', kind: 'press', time: 0 }, cur, TRACKS)).toEqual({
      kind: 'move',
      cursor: { column: 'subtitles', index: 2 },
    });
    expect(routePickerKey({ key: 'select', kind: 'press', time: 0 }, cur, TRACKS)).toEqual({
      kind: 'audio',
      id: 'a:1',
    });
    expect(routePickerKey({ key: 'play', kind: 'press', time: 0 }, cur, TRACKS)).toBeNull();
  });
});
