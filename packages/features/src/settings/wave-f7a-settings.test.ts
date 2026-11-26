import { DEFAULT_PREFERENCES, mergeSubtitleStyle, ok, type PreferencesPatch } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { activatePlaybackControl, toggleAudioPassthroughCodec } from './playback-controls';

describe('Wave F7A / P7 playback pure helpers (#115, #213)', () => {
  it('toggles desktop passthrough codecs in canonical order', () => {
    expect(toggleAudioPassthroughCodec(['ac3', 'eac3', 'dts'], 'truehd')).toEqual([
      'ac3',
      'eac3',
      'dts',
      'truehd',
    ]);
    expect(toggleAudioPassthroughCodec(['ac3', 'eac3', 'dts'], 'eac3')).toEqual(['ac3', 'dts']);
  });

  it('activates Night-Mode DRC, seek step, aspect, buffer, decoder, OSD time, and external player controls', () => {
    const patches: PreferencesPatch[] = [];
    let current = { ...DEFAULT_PREFERENCES };
    const controller = {
      get preferences() {
        return current;
      },
      updatePreferences: vi.fn(async (patch: PreferencesPatch) => {
        patches.push(patch);
        current = {
          ...current,
          ...patch,
          subtitleStyle: mergeSubtitleStyle(current.subtitleStyle, patch.subtitleStyle),
        };
        return ok(current);
      }),
      resetPreferences: vi.fn(async () => ok(DEFAULT_PREFERENCES)),
    };

    activatePlaybackControl('seek-step-15', controller);
    activatePlaybackControl('aspect-fill', controller);
    activatePlaybackControl('buffer-large', controller);
    activatePlaybackControl('video-decoder-hardware', controller);
    activatePlaybackControl('night-drc-night', controller);
    activatePlaybackControl('osd-time-endsAt', controller);
    activatePlaybackControl('external-player-ask', controller);

    expect(patches).toEqual([
      { seekStepSec: 15 },
      { defaultResizeMode: 'fill' },
      { bufferPreset: 'large' },
      { androidDecoderMode: 'hardware' },
      { nightModeDrc: 'night' },
      { osdTimeDisplayMode: 'endsAt' },
      { externalPlayerMode: 'ask' },
    ]);
  });
});
