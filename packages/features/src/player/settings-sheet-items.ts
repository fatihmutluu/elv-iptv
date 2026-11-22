import { ANDROID_DECODER_MODES, type AndroidDecoderMode, type SleepTimerAction } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { ChapterInfo, MediaTracks, TrackInfo } from '@elv/playback';
import type { IconName } from '@elv/ui-kit';
import type { AudioDeviceInfo } from '../ports/video-host';
import {
  formatPlaybackSpeed,
  normalizeAudioDeviceChoices,
  PLAYBACK_SPEED_OPTIONS,
  type SettingsMenuView,
} from './settings-menu-nav';
import { SLEEP_TIMER_PRESETS_MIN, type SleepTimerSnapshot } from './sleep-timer';
import { formatTrackLabel } from './track-labels';
import { formatPlaybackPosition } from './vod-progress-math';

export interface SettingsRadioItem {
  readonly key: string;
  readonly testID: string;
  readonly label: string;
  readonly selected: boolean;
  readonly tabular?: boolean;
  readonly onPress: () => void;
}

export type SettingsNavRow = readonly [
  testID: string,
  icon: IconName,
  label: string,
  summary: string,
  targetView: SettingsMenuView,
  tabular: boolean,
];

function activeTrackSummary(
  list: readonly TrackInfo[],
  selectedId: string | null,
  fallback: string,
  i18n: AppI18n,
): string {
  if (selectedId === null) return fallback;
  const idx = list.findIndex((t) => t.id === selectedId);
  const track = idx >= 0 ? list[idx] : undefined;
  return track !== undefined ? formatTrackLabel(track, idx, list, i18n) : fallback;
}

function activeAudioDeviceSummary(
  devices: readonly AudioDeviceInfo[],
  activeAudioDevice: string,
  i18n: AppI18n,
): string {
  if (activeAudioDevice === '' || activeAudioDevice === 'auto') {
    return i18n.t('player.audioDeviceAuto');
  }
  const match = devices.find((d) => d.name === activeAudioDevice);
  return match !== undefined ? match.description || match.name : activeAudioDevice;
}

function formatVideoDecoderLabel(mode: AndroidDecoderMode, i18n: AppI18n): string {
  if (mode === 'hardware') return i18n.t('settings.playback.videoDecoder.hardware');
  if (mode === 'software') return i18n.t('settings.playback.videoDecoder.software');
  return i18n.t('settings.playback.videoDecoder.auto');
}

/** Builds ordered root navigation rows for `PlayerSettingsSheet`. */
export function buildSettingsNavRows(
  tracks: MediaTracks,
  isVod: boolean,
  playbackSpeed: number,
  i18n: AppI18n,
  audioDevice?: {
    readonly show: boolean;
    readonly devices: readonly AudioDeviceInfo[];
    readonly activeDevice: string;
  },
  videoDecoder?: {
    readonly show: boolean;
    readonly mode: AndroidDecoderMode;
  },
  extras?: {
    readonly chapters?: readonly ChapterInfo[] | undefined;
    readonly showSleepTimer?: boolean | undefined;
    readonly sleepTimer?: SleepTimerSnapshot | undefined;
  },
): readonly SettingsNavRow[] {
  const subSummary = activeTrackSummary(
    tracks.subtitles,
    tracks.selectedSubtitleId,
    i18n.t('player.subtitlesOff'),
    i18n,
  );
  const audioSummary = activeTrackSummary(
    tracks.audio,
    tracks.selectedAudioId,
    i18n.t('player.stats.audioNone'),
    i18n,
  );
  const rows: SettingsNavRow[] = [
    [
      'player-settings-row-subtitles',
      'subtitles',
      i18n.t('player.subtitleTracks'),
      subSummary,
      'subtitles',
      false,
    ],
    [
      'player-settings-row-audio',
      'audio',
      i18n.t('player.audioTracks'),
      audioSummary,
      'audio',
      false,
    ],
  ];
  if (audioDevice?.show === true) {
    rows.push([
      'player-settings-row-audio-device',
      'audio',
      i18n.t('player.audioDevice'),
      activeAudioDeviceSummary(audioDevice.devices, audioDevice.activeDevice, i18n),
      'audioDevice',
      false,
    ]);
  }
  if (isVod) {
    rows.push([
      'player-settings-row-speed',
      'speed',
      i18n.t('player.speed'),
      formatPlaybackSpeed(playbackSpeed),
      'speed',
      true,
    ]);
  }
  if ((extras?.chapters?.length ?? 0) > 0) {
    rows.push([
      'player-settings-row-chapters',
      'chapters',
      i18n.t('player.chapters'),
      i18n.t('player.chapterCount', { count: extras?.chapters?.length ?? 0 }),
      'chapters',
      true,
    ]);
  }
  if (extras?.showSleepTimer === true) {
    const st = extras.sleepTimer;
    const summary =
      st?.active === true
        ? i18n.t('player.sleepTimerRemaining', { minutes: st.remainingMinutes })
        : i18n.t('player.sleepTimerOff');
    rows.push([
      'player-settings-row-sleep-timer',
      'moon',
      i18n.t('player.sleepTimer'),
      summary,
      'sleepTimer',
      true,
    ]);
  }
  if (videoDecoder?.show === true) {
    rows.push([
      'player-settings-row-video-decoder',
      'layers',
      i18n.t('player.videoDecoder'),
      formatVideoDecoderLabel(videoDecoder.mode, i18n),
      'videoDecoder',
      false,
    ]);
  }
  return rows;
}

/** Builds level-2 radio rows for the active `PlayerSettingsSheet` sub-view. */
export function buildSettingsRadioItems(params: {
  view: SettingsMenuView;
  tracks: MediaTracks;
  playbackSpeed: number;
  audioDevices?: readonly AudioDeviceInfo[] | undefined;
  activeAudioDevice?: string | undefined;
  androidDecoderMode?: AndroidDecoderMode | undefined;
  chapters?: readonly ChapterInfo[] | undefined;
  sleepTimer?: SleepTimerSnapshot | undefined;
  i18n: AppI18n;
  onSelectAudio: (id: string) => void;
  onSelectAudioDevice?: ((name: string) => void) | undefined;
  onSelectSubtitle: (id: string | null) => void;
  onSelectSpeed?: ((rate: number) => void) | undefined;
  onSelectChapter?: ((startMs: number) => void) | undefined;
  onSelectSleepTimer?: ((minutes: number) => void) | undefined;
  onToggleSleepTimerAction?: (() => void) | undefined;
  onSelectAndroidDecoderMode?: ((mode: AndroidDecoderMode) => void) | undefined;
}): readonly SettingsRadioItem[] {
  const {
    view,
    tracks,
    playbackSpeed,
    audioDevices,
    activeAudioDevice = 'auto',
    androidDecoderMode = 'auto',
    chapters = [],
    sleepTimer,
    i18n,
    onSelectAudio,
    onSelectAudioDevice,
    onSelectSubtitle,
    onSelectSpeed,
    onSelectChapter,
    onSelectSleepTimer,
    onToggleSleepTimerAction,
    onSelectAndroidDecoderMode,
  } = params;

  if (view === 'chapters') {
    return chapters.map((ch, idx) => ({
      key: ch.id,
      testID: `player-settings-chapter-${ch.id}`,
      label: `${formatPlaybackPosition(ch.startMs)} · ${ch.title?.trim() || `${idx + 1}`}`,
      selected: false,
      tabular: true,
      onPress: () => onSelectChapter?.(ch.startMs),
    }));
  }

  if (view === 'sleepTimer') {
    const activeMin = sleepTimer?.active === true ? sleepTimer.totalMinutes : 0;
    const action: SleepTimerAction = sleepTimer?.action ?? 'stop';
    const actionLabel =
      action === 'pause' ? i18n.t('player.sleepTimerPause') : i18n.t('player.sleepTimerStop');
    return [
      {
        key: 'sleep-action',
        testID: 'player-settings-sleep-action',
        label: `${i18n.t('player.sleepTimerAction')}: ${actionLabel}`,
        selected: false,
        onPress: () => onToggleSleepTimerAction?.(),
      },
      ...SLEEP_TIMER_PRESETS_MIN.map((minutes) => ({
        key: `sleep-${minutes}`,
        testID: `player-settings-sleep-${minutes}`,
        label:
          minutes === 0
            ? i18n.t('player.sleepTimerOff')
            : i18n.t('player.sleepTimerMinutes', { minutes }),
        selected: activeMin === minutes,
        tabular: true,
        onPress: () => onSelectSleepTimer?.(minutes),
      })),
    ];
  }

  if (view === 'videoDecoder') {
    return ANDROID_DECODER_MODES.map((mode) => ({
      key: `decoder-${mode}`,
      testID: `player-settings-decoder-${mode}`,
      label: formatVideoDecoderLabel(mode, i18n),
      selected: androidDecoderMode === mode,
      onPress: () => onSelectAndroidDecoderMode?.(mode),
    }));
  }
  if (view === 'audioDevice') {
    const normalized = normalizeAudioDeviceChoices(audioDevices);
    const isAuto = activeAudioDevice === '' || activeAudioDevice === 'auto';
    return [
      {
        key: 'auto',
        testID: 'player-settings-audio-device-auto',
        label: i18n.t('player.audioDeviceAuto'),
        selected: isAuto,
        onPress: () => onSelectAudioDevice?.('auto'),
      },
      ...normalized.map((device, idx) => ({
        key: device.name,
        testID: `player-settings-audio-device-${idx}`,
        label: device.description || device.name,
        selected: activeAudioDevice === device.name,
        onPress: () => onSelectAudioDevice?.(device.name),
      })),
    ];
  }
  if (view === 'speed') {
    return PLAYBACK_SPEED_OPTIONS.map((rate) => ({
      key: `speed-${rate}`,
      testID: `player-settings-speed-${rate}`,
      label: formatPlaybackSpeed(rate),
      selected: playbackSpeed === rate,
      tabular: true,
      onPress: () => onSelectSpeed?.(rate),
    }));
  }
  if (view === 'subtitles') {
    return [
      {
        key: 'off',
        testID: 'player-settings-sub-off',
        label: i18n.t('player.subtitlesOff'),
        selected: tracks.selectedSubtitleId === null,
        onPress: () => onSelectSubtitle(null),
      },
      ...tracks.subtitles.map((track, idx) => ({
        key: track.id,
        testID: `player-settings-sub-${track.id}`,
        label: formatTrackLabel(track, idx, tracks.subtitles, i18n),
        selected: tracks.selectedSubtitleId === track.id,
        onPress: () => onSelectSubtitle(track.id),
      })),
    ];
  }
  return tracks.audio.map((track, idx) => ({
    key: track.id,
    testID: `player-settings-audio-${track.id}`,
    label: formatTrackLabel(track, idx, tracks.audio, i18n),
    selected: tracks.selectedAudioId === track.id,
    onPress: () => onSelectAudio(track.id),
  }));
}
