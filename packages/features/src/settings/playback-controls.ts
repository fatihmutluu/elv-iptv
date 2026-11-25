import type {
  AndroidDecoderMode,
  BufferPreset,
  DefaultResizeModePref,
  DeinterlaceMode,
  OsdTimeDisplayMode,
  SeekStepSecPref,
  SubtitleModePref,
} from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';
import type { SettingsPreferencesController } from './appearance-controls';
import type { SettingsChipOption } from './SettingsRowParts';
import type { PlaybackFocusId } from './useTvSettingsNavigation';

const TRACK_LANGUAGE_CODES: ReadonlyArray<{
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

const SUBTITLE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: SubtitleModePref;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'default',
    focusId: 'sub-mode-default',
    testID: 'settings-playback-subtitle-mode-default',
    labelKey: 'settings.playback.subtitleModeDefault',
  },
  {
    value: 'smart',
    focusId: 'sub-mode-smart',
    testID: 'settings-playback-subtitle-mode-smart',
    labelKey: 'settings.playback.subtitleModeSmart',
  },
  {
    value: 'onlyForced',
    focusId: 'sub-mode-onlyForced',
    testID: 'settings-playback-subtitle-mode-onlyForced',
    labelKey: 'settings.playback.subtitleModeOnlyForced',
  },
  {
    value: 'always',
    focusId: 'sub-mode-always',
    testID: 'settings-playback-subtitle-mode-always',
    labelKey: 'settings.playback.subtitleModeAlways',
  },
  {
    value: 'off',
    focusId: 'sub-mode-off',
    testID: 'settings-playback-subtitle-mode-off',
    labelKey: 'settings.playback.subtitleModeOff',
  },
];

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

const DEINTERLACE_MODE_OPTIONS: ReadonlyArray<{
  readonly value: DeinterlaceMode;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
  readonly labelKey: MessageId;
}> = [
  {
    value: 'off',
    focusId: 'deinterlace-off',
    testID: 'settings-playback-deinterlace-off',
    labelKey: 'settings.deinterlaceOff',
  },
  {
    value: 'auto',
    focusId: 'deinterlace-auto',
    testID: 'settings-playback-deinterlace-auto',
    labelKey: 'settings.deinterlaceAuto',
  },
  {
    value: 'bwdif',
    focusId: 'deinterlace-bwdif',
    testID: 'settings-playback-deinterlace-bwdif',
    labelKey: 'settings.deinterlaceBwdif',
  },
];

const OSD_TIME_MODE_OPTIONS: ReadonlyArray<{
  readonly value: OsdTimeDisplayMode;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
}> = [
  { value: 'total', focusId: 'osd-time-total', testID: 'settings-playback-osd-time-total' },
  {
    value: 'remaining',
    focusId: 'osd-time-remaining',
    testID: 'settings-playback-osd-time-remaining',
  },
  { value: 'endsAt', focusId: 'osd-time-endsAt', testID: 'settings-playback-osd-time-endsAt' },
];

const OLED_SCREENSAVER_OPTIONS: ReadonlyArray<{
  readonly minutes: number;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
}> = [
  { minutes: 0, focusId: 'oled-0', testID: 'settings-playback-oled-0' },
  { minutes: 5, focusId: 'oled-5', testID: 'settings-playback-oled-5' },
  { minutes: 10, focusId: 'oled-10', testID: 'settings-playback-oled-10' },
  { minutes: 15, focusId: 'oled-15', testID: 'settings-playback-oled-15' },
  { minutes: 30, focusId: 'oled-30', testID: 'settings-playback-oled-30' },
];

const STILL_WATCHING_OPTIONS: ReadonlyArray<{
  readonly minutes: number;
  readonly hours: number;
  readonly focusId: PlaybackFocusId;
  readonly testID: string;
}> = [
  {
    minutes: 0,
    hours: 0,
    focusId: 'still-watching-0',
    testID: 'settings-playback-still-watching-0',
  },
  {
    minutes: 60,
    hours: 1,
    focusId: 'still-watching-60',
    testID: 'settings-playback-still-watching-60',
  },
  {
    minutes: 120,
    hours: 2,
    focusId: 'still-watching-120',
    testID: 'settings-playback-still-watching-120',
  },
  {
    minutes: 180,
    hours: 3,
    focusId: 'still-watching-180',
    testID: 'settings-playback-still-watching-180',
  },
  {
    minutes: 240,
    hours: 4,
    focusId: 'still-watching-240',
    testID: 'settings-playback-still-watching-240',
  },
];

/** Builds localized chip options for the Playback settings panel. */
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

  const mapLang = (prefix: 'audio' | 'subtitle', focusPrefix: 'audio-lang' | 'sub-lang') =>
    TRACK_LANGUAGE_CODES.map((entry) => ({
      value: entry.code,
      label: entry.endonym ?? i18n.t('settings.playback.langAuto'),
      focusId: `${focusPrefix}-${entry.suffix}`,
      testID: `settings-playback-${prefix}-${entry.suffix}`,
    }));

  return {
    audioLangOptions: mapLang('audio', 'audio-lang'),
    subtitleLangOptions: mapLang('subtitle', 'sub-lang'),
    subtitleModeOptions: mapLabeled(SUBTITLE_MODE_OPTIONS),
    seekStepOptions: SEEK_STEP_OPTIONS.map((opt) => ({
      value: opt.seconds,
      label: i18n.t('settings.playback.seekStepValue', { seconds: opt.seconds }),
      focusId: opt.focusId,
      testID: opt.testID,
    })),
    aspectOptions: mapLabeled(RESIZE_MODE_OPTIONS),
    bufferOptions: mapLabeled(BUFFER_PRESET_OPTIONS),
    videoDecoderOptions: mapLabeled(VIDEO_DECODER_OPTIONS),
    deinterlaceOptions: mapLabeled(DEINTERLACE_MODE_OPTIONS),
    osdTimeOptions: OSD_TIME_MODE_OPTIONS.map((opt) => ({
      value: opt.value,
      label:
        opt.value === 'total'
          ? i18n.t('player.totalDuration')
          : opt.value === 'remaining'
            ? i18n.t('player.remainingTime')
            : i18n.t('player.endsAt', { time: 'HH:MM' }),
      focusId: opt.focusId,
      testID: opt.testID,
    })),
    oledOptions: OLED_SCREENSAVER_OPTIONS.map((opt) => ({
      value: opt.minutes,
      label:
        opt.minutes === 0
          ? i18n.t('settings.playback.off')
          : i18n.t('settings.playback.minutesOption', { minutes: opt.minutes }),
      focusId: opt.focusId,
      testID: opt.testID,
    })),
    stillWatchingOptions: STILL_WATCHING_OPTIONS.map((opt) => ({
      value: opt.minutes,
      label:
        opt.hours === 0
          ? i18n.t('settings.playback.off')
          : i18n.t('settings.playback.hoursOption', { hours: opt.hours }),
      focusId: opt.focusId,
      testID: opt.testID,
    })),
  };
}

/** Applies a TV D-pad activation on a Playback settings control (`#401`, `#393`, `#310`, `#124`, `#160`, `#118`). */
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
  const deintOpt = DEINTERLACE_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (deintOpt) {
    void preferences.updatePreferences({ deinterlaceMode: deintOpt.value });
    return;
  }
  const osdTimeOpt = OSD_TIME_MODE_OPTIONS.find((o) => o.focusId === controlId);
  if (osdTimeOpt) {
    void preferences.updatePreferences({ osdTimeDisplayMode: osdTimeOpt.value });
    return;
  }
  const oledOpt = OLED_SCREENSAVER_OPTIONS.find((o) => o.focusId === controlId);
  if (oledOpt) {
    void preferences.updatePreferences({ oledScreensaverTimeoutMin: oledOpt.minutes });
    return;
  }
  const stillOpt = STILL_WATCHING_OPTIONS.find((o) => o.focusId === controlId);
  if (stillOpt) {
    void preferences.updatePreferences({ stillWatchingTimeoutMin: stillOpt.minutes });
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
  if (controlId === 'toggle-group-vod-versions') {
    void preferences.updatePreferences({
      groupVodVersions: !preferences.preferences.groupVodVersions,
    });
    return;
  }
  if (controlId === 'toggle-prefer-default-audio') {
    void preferences.updatePreferences({
      preferDefaultAudioTrack: !preferences.preferences.preferDefaultAudioTrack,
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
  if (controlId === 'toggle-window-aspect-ratio-lock') {
    void preferences.updatePreferences({
      windowAspectRatioLock: !preferences.preferences.windowAspectRatioLock,
    });
    return;
  }
  if (controlId === 'toggle-minimize-to-tray') {
    void preferences.updatePreferences({
      minimizeToTray: !preferences.preferences.minimizeToTray,
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
  if (controlId === 'audio-device-auto') {
    void preferences.updatePreferences({ preferredAudioDevice: 'auto' });
  }
}
