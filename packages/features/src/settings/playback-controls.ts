import type {
  AndroidDecoderMode,
  BufferPreset,
  DefaultResizeModePref,
  SeekStepSecPref,
  SubtitleModePref,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { SettingsPreferencesController } from './appearance-controls';
import type { PlaybackFocusId } from './useTvSettingsNavigation';

export const TRACK_LANGUAGE_CODES: ReadonlyArray<{
  readonly code: '' | 'tr' | 'en' | 'de' | 'fr' | 'es';
  readonly suffix: 'auto' | 'tr' | 'en' | 'de' | 'fr' | 'es';
  readonly endonym?: string;
}> = [
  { code: '', suffix: 'auto' },
  { code: 'tr', suffix: 'tr', endonym: 'Türkçe (tr)' },
  { code: 'en', suffix: 'en', endonym: 'English (en)' },
  { code: 'de', suffix: 'de', endonym: 'Deutsch (de)' },
  { code: 'fr', suffix: 'fr', endonym: 'Français (fr)' },
  { code: 'es', suffix: 'es', endonym: 'Español (es)' },
];

export const SUBTITLE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: SubtitleModePref;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'auto',
    focusId: 'sub-mode-auto',
    testID: 'settings-playback-subtitle-mode-auto',
    labelKey: 'settings.playback.subtitleMode.auto',
  },
  {
    value: 'always',
    focusId: 'sub-mode-always',
    testID: 'settings-playback-subtitle-mode-always',
    labelKey: 'settings.playback.subtitleMode.always',
  },
  {
    value: 'off',
    focusId: 'sub-mode-off',
    testID: 'settings-playback-subtitle-mode-off',
    labelKey: 'settings.playback.subtitleMode.off',
  },
];

export const SEEK_STEP_OPTIONS: ReadonlyArray<{
  readonly seconds: SeekStepSecPref;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
}> = [
  { seconds: 5, focusId: 'seek-step-5', testID: 'settings-playback-seek-5' },
  { seconds: 10, focusId: 'seek-step-10', testID: 'settings-playback-seek-10' },
  { seconds: 15, focusId: 'seek-step-15', testID: 'settings-playback-seek-15' },
  { seconds: 30, focusId: 'seek-step-30', testID: 'settings-playback-seek-30' },
];

export const RESIZE_MODE_OPTIONS: ReadonlyArray<{
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

export const BUFFER_PRESET_OPTIONS: ReadonlyArray<{
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

export const VIDEO_DECODER_OPTIONS: ReadonlyArray<{
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

/** Applies a TV D-pad activation on a Playback settings control (`#401`). */
export function activatePlaybackControl(
  controlId: PlaybackFocusId,
  preferences?: SettingsPreferencesController,
): void {
  if (!preferences) return;
  if (controlId.startsWith('audio-lang-')) {
    const suffix = controlId.slice('audio-lang-'.length);
    const match = TRACK_LANGUAGE_CODES.find((c) => c.suffix === suffix);
    if (match) void preferences.updatePreferences({ preferredAudioLang: match.code });
    return;
  }
  if (controlId.startsWith('sub-lang-')) {
    const suffix = controlId.slice('sub-lang-'.length);
    const match = TRACK_LANGUAGE_CODES.find((c) => c.suffix === suffix);
    if (match) void preferences.updatePreferences({ preferredSubtitleLang: match.code });
    return;
  }
  const subMode = SUBTITLE_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (subMode) {
    void preferences.updatePreferences({ subtitleMode: subMode.value });
    return;
  }
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
  if (controlId === 'toggle-auto-play-next') {
    void preferences.updatePreferences({
      autoPlayNextEpisode: !preferences.preferences.autoPlayNextEpisode,
    });
    return;
  }
  if (controlId === 'toggle-skip-back-subtitles') {
    void preferences.updatePreferences({
      autoSubtitlesOnSkipBack: !preferences.preferences.autoSubtitlesOnSkipBack,
    });
    return;
  }
  if (controlId === 'audio-device-auto') {
    void preferences.updatePreferences({ preferredAudioDevice: 'auto' });
  }
}
