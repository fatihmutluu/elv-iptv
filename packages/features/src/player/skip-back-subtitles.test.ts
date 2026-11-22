import type { MediaTracks, PlaybackTimers } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  createSkipBackSubtitlesController,
  SKIP_BACK_SUBTITLES_WINDOW_MS,
} from './skip-back-subtitles';

function createManualTimers(): {
  timers: PlaybackTimers;
  advance: (ms: number) => void;
  pendingCount: () => number;
} {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  return {
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        scheduled.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout(handle) {
        scheduled.delete(handle as number);
      },
    },
    advance(ms) {
      now += ms;
      for (const [id, item] of [...scheduled.entries()]) {
        if (item.at <= now) {
          scheduled.delete(id);
          item.fn();
        }
      }
    },
    pendingCount: () => scheduled.size,
  };
}

const SUBS_OFF_TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng' }],
  subtitles: [
    { id: 's:1', language: 'eng' },
    { id: 's:2', language: 'tur' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const SUBS_ON_TRACKS: MediaTracks = {
  ...SUBS_OFF_TRACKS,
  selectedSubtitleId: 's:2',
};

const NO_SUBS_TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng' }],
  subtitles: [],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

describe('createSkipBackSubtitlesController (#114)', () => {
  it('exports the default 15s skip-back window constant', () => {
    expect(SKIP_BACK_SUBTITLES_WINDOW_MS).toBe(15_000);
  });

  it('is a no-op when disabled or when no subtitle tracks exist', () => {
    const manual = createManualTimers();
    const onSelectSubtitle = vi.fn();
    const ctrl = createSkipBackSubtitlesController({
      timers: manual.timers,
      onSelectSubtitle,
    });

    expect(ctrl.onBackwardSeek({ enabled: false, tracks: SUBS_OFF_TRACKS })).toBe(false);
    expect(ctrl.onBackwardSeek({ enabled: true, tracks: NO_SUBS_TRACKS })).toBe(false);
    expect(onSelectSubtitle).not.toHaveBeenCalled();
    expect(ctrl.isActive()).toBe(false);
    expect(manual.pendingCount()).toBe(0);
  });

  it('never interferes when the user already has subtitles enabled before rewinding', () => {
    const manual = createManualTimers();
    const onSelectSubtitle = vi.fn();
    const ctrl = createSkipBackSubtitlesController({
      timers: manual.timers,
      onSelectSubtitle,
    });

    expect(ctrl.onBackwardSeek({ enabled: true, tracks: SUBS_ON_TRACKS })).toBe(false);
    manual.advance(30_000);
    expect(onSelectSubtitle).not.toHaveBeenCalled();
    expect(ctrl.isActive()).toBe(false);
  });

  it('temporarily enables the first (or preferred) subtitle track and auto-restores off after 15s', () => {
    const manual = createManualTimers();
    const onSelectSubtitle = vi.fn();
    const ctrl = createSkipBackSubtitlesController({
      timers: manual.timers,
      onSelectSubtitle,
    });

    expect(ctrl.onBackwardSeek({ enabled: true, tracks: SUBS_OFF_TRACKS })).toBe(true);
    expect(ctrl.isActive()).toBe(true);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(1);
    expect(onSelectSubtitle).toHaveBeenLastCalledWith('s:1');

    manual.advance(14_999);
    expect(ctrl.isActive()).toBe(true);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(1);

    manual.advance(1);
    expect(ctrl.isActive()).toBe(false);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(2);
    expect(onSelectSubtitle).toHaveBeenLastCalledWith(null);

    // Preferred track selection when provided
    expect(
      ctrl.onBackwardSeek({
        enabled: true,
        tracks: SUBS_OFF_TRACKS,
        preferredTrackId: 's:2',
      }),
    ).toBe(true);
    expect(onSelectSubtitle).toHaveBeenLastCalledWith('s:2');
    manual.advance(15_000);
    expect(onSelectSubtitle).toHaveBeenLastCalledWith(null);
  });

  it('extends the active timer window on repeat backward seeks without re-selecting', () => {
    const manual = createManualTimers();
    const onSelectSubtitle = vi.fn();
    const ctrl = createSkipBackSubtitlesController({
      timers: () => manual.timers,
      windowMs: 10_000,
      onSelectSubtitle,
    });

    expect(ctrl.onBackwardSeek({ enabled: true, tracks: SUBS_OFF_TRACKS })).toBe(true);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(1);

    manual.advance(7_000);
    expect(
      ctrl.onBackwardSeek({
        enabled: true,
        tracks: { ...SUBS_OFF_TRACKS, selectedSubtitleId: 's:1' },
      }),
    ).toBe(true);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(1);

    manual.advance(9_999);
    expect(ctrl.isActive()).toBe(true);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(1);

    manual.advance(1);
    expect(ctrl.isActive()).toBe(false);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(2);
    expect(onSelectSubtitle).toHaveBeenLastCalledWith(null);
  });

  it('cancels pending auto-restore on manual subtitle change, reset, or dispose without reverting', () => {
    const manual = createManualTimers();
    const onSelectSubtitle = vi.fn();
    const ctrl = createSkipBackSubtitlesController({
      timers: manual.timers,
      onSelectSubtitle,
    });

    ctrl.onBackwardSeek({ enabled: true, tracks: SUBS_OFF_TRACKS });
    expect(ctrl.isActive()).toBe(true);
    ctrl.onManualSubtitleChange();
    expect(ctrl.isActive()).toBe(false);
    expect(manual.pendingCount()).toBe(0);
    manual.advance(20_000);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(1);

    ctrl.onBackwardSeek({ enabled: true, tracks: SUBS_OFF_TRACKS });
    ctrl.reset();
    expect(ctrl.isActive()).toBe(false);
    expect(manual.pendingCount()).toBe(0);
    manual.advance(20_000);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(2);

    ctrl.onBackwardSeek({ enabled: true, tracks: SUBS_OFF_TRACKS });
    ctrl.dispose();
    expect(ctrl.isActive()).toBe(false);
    expect(manual.pendingCount()).toBe(0);
    manual.advance(20_000);
    expect(onSelectSubtitle).toHaveBeenCalledTimes(3);
  });
});
