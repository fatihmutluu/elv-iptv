import {
  type AndroidDecoderMode,
  AUDIO_PASSTHROUGH_CODECS,
  type AudioChannelLayout,
  type AudioPassthroughCodec,
  type BufferPreset,
  type DefaultResizeModePref,
  type ExternalPlayerMode,
  type NightModeDrcPreset,
  normalizeAudioPassthroughCodecs,
  type SeekStepSecPref,
} from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';
import type { SettingsPreferencesController } from './appearance-controls';
import type { SettingsDropdownOption } from './SettingsDropdownRow';
import type { SettingsChipOption } from './SettingsRowParts';
import type { PlaybackFocusId } from './useTvSettingsNavigation';

/** Toggles a single passthrough codec while preserving canonical {@link AUDIO_PASSTHROUGH_CODECS} order. */
export function toggleAudioPassthroughCodec(
  current: readonly AudioPassthroughCodec[],
  codec: AudioPassthroughCodec,
): readonly AudioPassthroughCodec[] {
  const active = new Set(current);
  if (active.has(codec)) {
    active.delete(codec);
  } else {
    active.add(codec);
  }
  const ordered = AUDIO_PASSTHROUGH_CODECS.filter((entry) => active.has(entry));
  return normalizeAudioPassthroughCodecs(ordered, []);
}

const SEEK_STEP_OPTIONS: ReadonlyArray<{
  readonly seconds: SeekStepSecPref;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
}> = [
  { seconds: 5, focusId: 'seek-step-5', testID: 'settings-playback-seek-5' },
  { seconds: 10, focusId: 'seek-step-10', testID: 'settings-playback-seek-10' },
  { seconds: 15, focusId: 'seek-step-15', testID: 'settings-playback-seek-15' },
  { seconds: 30, focusId: 'seek-step-30', testID: 'settings-playback-seek-30' },
];

const RESIZE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: DefaultResizeModePref;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'fit',
    focusId: 'aspect-fit',
    testID: 'settings-playback-aspect-fit',
    labelKey: 'player.aspect.fit',
  },
  {
    value: 'fill',
    focusId: 'aspect-fill',
    testID: 'settings-playback-aspect-fill',
    labelKey: 'player.aspect.fill',
  },
  {
    value: 'stretch',
    focusId: 'aspect-stretch',
    testID: 'settings-playback-aspect-stretch',
    labelKey: 'player.aspect.stretch',
  },
];

const BUFFER_PRESET_OPTIONS: ReadonlyArray<{
  readonly value: BufferPreset;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'auto',
    focusId: 'buffer-auto',
    testID: 'settings-playback-buffer-auto',
    labelKey: 'settings.playback.buffer.fast',
  },
  {
    value: 'balanced',
    focusId: 'buffer-balanced',
    testID: 'settings-playback-buffer-balanced',
    labelKey: 'settings.playback.buffer.auto',
  },
  {
    value: 'large',
    focusId: 'buffer-large',
    testID: 'settings-playback-buffer-large',
    labelKey: 'settings.playback.buffer.resilient',
  },
];

const VIDEO_DECODER_OPTIONS: ReadonlyArray<{
  readonly value: AndroidDecoderMode;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'auto',
    focusId: 'video-decoder-auto',
    testID: 'settings-playback-decoder-auto',
    labelKey: 'settings.playback.videoDecoder.auto',
  },
  {
    value: 'hardware',
    focusId: 'video-decoder-hardware',
    testID: 'settings-playback-decoder-hardware',
    labelKey: 'settings.playback.videoDecoder.hardware',
  },
  {
    value: 'software',
    focusId: 'video-decoder-software',
    testID: 'settings-playback-decoder-software',
    labelKey: 'settings.playback.videoDecoder.software',
  },
];

const NIGHT_MODE_DRC_OPTIONS: ReadonlyArray<{
  readonly value: NightModeDrcPreset;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'off',
    focusId: 'night-drc-off',
    testID: 'settings-playback-night-drc-off',
    labelKey: 'settings.playback.nightModeDrcOff',
  },
  {
    value: 'light',
    focusId: 'night-drc-light',
    testID: 'settings-playback-night-drc-light',
    labelKey: 'settings.playback.nightModeDrcLight',
  },
  {
    value: 'night',
    focusId: 'night-drc-night',
    testID: 'settings-playback-night-drc-night',
    labelKey: 'settings.playback.nightModeDrcNight',
  },
];

const AUDIO_CHANNEL_LAYOUT_OPTIONS: ReadonlyArray<{
  readonly value: AudioChannelLayout;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'auto',
    testID: 'settings-playback-channel-layout-auto',
    labelKey: 'settings.desktop.audioChannelLayoutAuto',
  },
  {
    value: 'stereo',
    testID: 'settings-playback-channel-layout-stereo',
    labelKey: 'settings.desktop.audioChannelLayoutStereo',
  },
  {
    value: '5.1',
    testID: 'settings-playback-channel-layout-5.1',
    labelKey: 'settings.desktop.audioChannelLayout51',
  },
  {
    value: '7.1',
    testID: 'settings-playback-channel-layout-7.1',
    labelKey: 'settings.desktop.audioChannelLayout71',
  },
];

const EXTERNAL_PLAYER_MODE_OPTIONS: ReadonlyArray<{
  readonly value: ExternalPlayerMode;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'off',
    focusId: 'external-player-off',
    testID: 'settings-playback-external-player-off',
    labelKey: 'settings.playback.externalPlayerOff',
  },
  {
    value: 'ask',
    focusId: 'external-player-ask',
    testID: 'settings-playback-external-player-ask',
    labelKey: 'settings.playback.externalPlayerAsk',
  },
  {
    value: 'always',
    focusId: 'external-player-always',
    testID: 'settings-playback-external-player-always',
    labelKey: 'settings.playback.externalPlayerAlways',
  },
];

/** Builds localized option arrays for the Playback settings panel. */
export function buildPlaybackChipOptions(i18n: AppI18n) {
  const mapLabeled = <T>(
    list: ReadonlyArray<{
      readonly value: T;
      readonly focusId: PlaybackFocusId;
      readonly testID: string;
      readonly labelKey: MessageId;
    }>,
  ): readonly SettingsChipOption<T>[] =>
    list.map((opt) => ({
      value: opt.value,
      label: i18n.t(opt.labelKey),
      focusId: opt.focusId,
      testID: opt.testID,
    }));

  const audioChannelLayoutOptions: readonly SettingsDropdownOption<AudioChannelLayout>[] =
    AUDIO_CHANNEL_LAYOUT_OPTIONS.map((opt) => ({
      value: opt.value,
      label: i18n.t(opt.labelKey),
      testID: opt.testID,
    }));

  return {
    seekStepOptions: SEEK_STEP_OPTIONS.map((opt) => ({
      value: opt.seconds,
      label: i18n.t('settings.playback.seekStepValue', { seconds: opt.seconds }),
      focusId: opt.focusId,
      testID: opt.testID,
    })),
    aspectOptions: mapLabeled(RESIZE_MODE_OPTIONS),
    bufferOptions: mapLabeled(BUFFER_PRESET_OPTIONS),
    videoDecoderOptions: mapLabeled(VIDEO_DECODER_OPTIONS),
    nightModeDrcOptions: mapLabeled(NIGHT_MODE_DRC_OPTIONS),
    externalPlayerModeOptions: mapLabeled(EXTERNAL_PLAYER_MODE_OPTIONS),
    audioChannelLayoutOptions,
  };
}

/** Applies a TV D-pad activation on a Playback settings control. */
export function activatePlaybackControl(
  controlId: PlaybackFocusId,
  preferences?: SettingsPreferencesController,
): void {
  if (!preferences) return;
  const seekOpt = SEEK_STEP_OPTIONS.find((o) => o.focusId === controlId);
  if (seekOpt) {
    void preferences.updatePreferences({ seekStepSec: seekOpt.seconds });
    return;
  }
  const aspectOpt = RESIZE_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (aspectOpt) {
    void preferences.updatePreferences({ defaultResizeMode: aspectOpt.value });
    return;
  }
  const bufferOpt = BUFFER_PRESET_OPTIONS.find((o) => o.focusId === controlId);
  if (bufferOpt) {
    void preferences.updatePreferences({ bufferPreset: bufferOpt.value });
    return;
  }
  const decoderOpt = VIDEO_DECODER_OPTIONS.find((o) => o.focusId === controlId);
  if (decoderOpt) {
    void preferences.updatePreferences({ androidDecoderMode: decoderOpt.value });
    return;
  }
  const drcOpt = NIGHT_MODE_DRC_OPTIONS.find((o) => o.focusId === controlId);
  if (drcOpt) {
    void preferences.updatePreferences({ nightModeDrc: drcOpt.value });
    return;
  }
  if (controlId === 'toggle-auto-play-next') {
    void preferences.updatePreferences({
      autoPlayNextEpisode: !preferences.preferences.autoPlayNextEpisode,
    });
    return;
  }
  if (controlId === 'toggle-auto-replace-single-connection') {
    void preferences.updatePreferences({
      autoReplaceSingleConnection: !preferences.preferences.autoReplaceSingleConnection,
    });
    return;
  }
  if (controlId === 'toggle-filter-sdh') {
    void preferences.updatePreferences({
      filterSdhSubtitles: !preferences.preferences.filterSdhSubtitles,
    });
    return;
  }
  if (controlId === 'toggle-prefer-hevc-dv') {
    void preferences.updatePreferences({
      preferHevcOverDolbyVision: !preferences.preferences.preferHevcOverDolbyVision,
    });
    return;
  }
  if (controlId === 'toggle-pitch-lock') {
    void preferences.updatePreferences({
      pitchLock: !preferences.preferences.pitchLock,
    });
    return;
  }
  if (controlId === 'toggle-audio-normalization') {
    void preferences.updatePreferences({
      audioNormalization: !preferences.preferences.audioNormalization,
    });
    return;
  }
  if (controlId === 'toggle-auto-enter-pip') {
    void preferences.updatePreferences({
      autoEnterPip: !preferences.preferences.autoEnterPip,
    });
    return;
  }
  if (controlId === 'toggle-background-audio') {
    void preferences.updatePreferences({
      backgroundAudioPlayback: !preferences.preferences.backgroundAudioPlayback,
    });
    return;
  }
  const externalPlayerOpt = EXTERNAL_PLAYER_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (externalPlayerOpt) {
    void preferences.updatePreferences({ externalPlayerMode: externalPlayerOpt.value });
  }
}
