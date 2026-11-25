import type { DesktopAudioOutputConfig } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  AC3_ENCODE_FILTER,
  AC3_ENCODE_LABEL,
  desktopAudioOutputCommands,
  isAc3EncodeActive,
  isLoudnormSuppressedByOutput,
  isPassthroughAudioFailureLog,
  mapAudioChannelLayout,
  normalizeDesktopAudioOutputConfig,
  passthroughFallbackCommands,
  sameDesktopAudioOutputConfig,
} from './audio-output.ts';

describe('mpv desktop audio output mapping (#213)', () => {
  it('maps channel layouts to mpv audio-channels values', () => {
    expect(mapAudioChannelLayout('auto')).toBe('auto-safe');
    expect(mapAudioChannelLayout('stereo')).toBe('stereo');
    expect(mapAudioChannelLayout('5.1')).toBe('5.1');
    expect(mapAudioChannelLayout('7.1')).toBe('7.1');
  });

  it('builds exact mpv commands when passthrough is enabled with exclusive mode', () => {
    const config: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const cmds = desktopAudioOutputCommands(config);
    expect(cmds).toEqual([
      ['set_property', 'audio-spdif', 'ac3,eac3,dts,dts-hd,truehd'],
      ['set_property', 'audio-exclusive', 'yes'],
      ['set_property', 'audio-channels', 'auto-safe'],
      ['af', 'remove', AC3_ENCODE_LABEL],
    ]);
    expect(cmds.some((c) => c[0] === 'set_property' && c[1] === 'af')).toBe(false);
  });

  it('disables audio-spdif and audio-exclusive when passthrough is false, even if exclusive is true', () => {
    const config: DesktopAudioOutputConfig = {
      passthrough: false,
      codecs: ['ac3', 'eac3'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: '5.1',
    };
    expect(desktopAudioOutputCommands(config)).toEqual([
      ['set_property', 'audio-spdif', ''],
      ['set_property', 'audio-exclusive', 'no'],
      ['set_property', 'audio-channels', '5.1'],
      ['af', 'remove', AC3_ENCODE_LABEL],
    ]);
  });

  it('adds labeled @ac3:lavcac3enc filter only when !passthrough && ac3Encode', () => {
    const ac3On: DesktopAudioOutputConfig = {
      passthrough: false,
      codecs: ['ac3'],
      exclusive: false,
      ac3Encode: true,
      channelLayout: '5.1',
    };
    expect(isAc3EncodeActive(ac3On)).toBe(true);
    expect(desktopAudioOutputCommands(ac3On)).toEqual([
      ['set_property', 'audio-spdif', ''],
      ['set_property', 'audio-exclusive', 'no'],
      ['set_property', 'audio-channels', '5.1'],
      ['af', 'add', AC3_ENCODE_FILTER],
    ]);
    expect(AC3_ENCODE_FILTER).toBe('@ac3:lavcac3enc=yes:640:3');

    const passthroughAndAc3: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3'],
      exclusive: false,
      ac3Encode: true,
      channelLayout: 'auto',
    };
    expect(isAc3EncodeActive(passthroughAndAc3)).toBe(false);
    expect(desktopAudioOutputCommands(passthroughAndAc3)).toContainEqual([
      'af',
      'remove',
      AC3_ENCODE_LABEL,
    ]);
  });

  it('sanitizes and deduplicates passthrough codecs against the allowlist', () => {
    const raw = {
      passthrough: true,
      codecs: [
        'ac3',
        'invalid-codec',
        'ac3',
        'truehd',
        'eac3',
      ] as unknown as DesktopAudioOutputConfig['codecs'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: '7.1',
    } satisfies DesktopAudioOutputConfig;

    const normalized = normalizeDesktopAudioOutputConfig(raw);
    expect(normalized.codecs).toEqual(['ac3', 'truehd', 'eac3']);
    expect(desktopAudioOutputCommands(raw)[0]).toEqual([
      'set_property',
      'audio-spdif',
      'ac3,truehd,eac3',
    ]);
  });

  it('reports loudnorm suppression whenever spdif passthrough or ac3Encode is active', () => {
    const pcm: DesktopAudioOutputConfig = {
      passthrough: false,
      codecs: ['ac3'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const spdif: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const spdifEmpty: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: [],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const ac3: DesktopAudioOutputConfig = {
      passthrough: false,
      codecs: ['ac3'],
      exclusive: false,
      ac3Encode: true,
      channelLayout: '5.1',
    };

    expect(isLoudnormSuppressedByOutput(false, undefined)).toBe(false);
    expect(isLoudnormSuppressedByOutput(true, undefined)).toBe(true);
    expect(isLoudnormSuppressedByOutput(false, pcm)).toBe(false);
    expect(isLoudnormSuppressedByOutput(false, spdif)).toBe(true);
    expect(isLoudnormSuppressedByOutput(false, spdifEmpty)).toBe(false);
    expect(isLoudnormSuppressedByOutput(false, ac3)).toBe(true);
  });

  it('builds safe PCM fallback commands without clobbering unrelated filters', () => {
    expect(passthroughFallbackCommands()).toEqual([
      ['set_property', 'audio-spdif', ''],
      ['set_property', 'audio-exclusive', 'no'],
      ['af', 'remove', AC3_ENCODE_LABEL],
      ['ao-reload'],
    ]);
  });

  it('compares normalized desktop audio output configs accurately', () => {
    const a: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'dts'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const b: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'dts'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    const c: DesktopAudioOutputConfig = { ...a, exclusive: true };
    expect(sameDesktopAudioOutputConfig(a, b)).toBe(true);
    expect(sameDesktopAudioOutputConfig(a, c)).toBe(false);
    expect(sameDesktopAudioOutputConfig(a, undefined)).toBe(false);
  });
});

describe('isPassthroughAudioFailureLog (#213)', () => {
  it('detects WASAPI/CoreAudio/ALSA/Pulse/PipeWire AO and ad/spdif open failures', () => {
    const failures = [
      {
        prefix: 'ao/wasapi',
        level: 'error',
        text: 'Device does not support format (AUDCLNT_E_UNSUPPORTED_FORMAT)',
      },
      {
        prefix: 'ao/wasapi',
        level: 'error',
        text: 'Exclusive mode not allowed (AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED)',
      },
      {
        prefix: 'ao/wasapi',
        level: 'error',
        text: 'Device in use (AUDCLNT_E_DEVICE_IN_USE)',
      },
      {
        prefix: 'ao/coreaudio',
        level: 'error',
        text: 'Failed to open audio device in exclusive mode',
      },
      {
        prefix: 'ao/alsa',
        level: 'error',
        text: 'Could not open/initialize audio device -> no sound.',
      },
      {
        prefix: 'ao',
        level: 'error',
        text: 'Failed to initialize audio driver',
      },
      {
        prefix: 'ad/spdif',
        level: 'error',
        text: 'spdif passthrough initialization failed',
      },
      {
        prefix: 'cplayer',
        level: 'warn',
        text: 'Audio: no audio (falling back to null)',
      },
      {
        prefix: 'ao/pulse',
        level: 'warn',
        text: 'Falling back to null audio output',
      },
    ];
    for (const line of failures) {
      expect(isPassthroughAudioFailureLog(line)).toBe(true);
    }
  });

  it('ignores benign info/verbose AO logs and unrelated network/video errors', () => {
    const ignored = [
      { prefix: 'ao/wasapi', level: 'info', text: 'Using WASAPI shared mode' },
      { prefix: 'ao/wasapi', level: 'v', text: 'Opening device with exclusive=no' },
      { prefix: 'ffmpeg', level: 'error', text: 'HTTP error 403 Forbidden' },
      { prefix: 'vd', level: 'error', text: 'Error while decoding frame' },
      { prefix: 'cplayer', level: 'error', text: 'Failed to open http://example.test/stream.ts' },
      { prefix: 'cplayer', level: 'warn', text: 'Audio/Video desynchronisation detected' },
    ];
    for (const line of ignored) {
      expect(isPassthroughAudioFailureLog(line)).toBe(false);
    }
  });
});
