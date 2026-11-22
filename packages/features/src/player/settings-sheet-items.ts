import type { AppI18n } from '@elv/i18n';
import type { MediaTracks, TrackInfo } from '@elv/playback';
import type { IconName } from '@elv/ui-kit';
import type { AudioDeviceInfo } from '../ports/video-host';
import {
  formatPlaybackSpeed,
  normalizeAudioDeviceChoices,
  PLAYBACK_SPEED_OPTIONS,
  type SettingsMenuView,
} from './settings-menu-nav';
import { formatTrackLabel } from './track-labels';

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

/** Builds ordered root navigation rows for `PlayerSettingsSheet` (`Subtitles`, `Audio`, optional `Audio output`, VOD `Speed`). */
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
  return rows;
}

/** Builds level-2 radio rows for the active `PlayerSettingsSheet` sub-view. */
export function buildSettingsRadioItems(params: {
  view: SettingsMenuView;
  tracks: MediaTracks;
  playbackSpeed: number;
  audioDevices?: readonly AudioDeviceInfo[] | undefined;
  activeAudioDevice?: string | undefined;
  i18n: AppI18n;
  onSelectAudio: (id: string) => void;
  onSelectAudioDevice?: ((name: string) => void) | undefined;
  onSelectSubtitle: (id: string | null) => void;
  onSelectSpeed?: ((rate: number) => void) | undefined;
}): readonly SettingsRadioItem[] {
  const {
    view,
    tracks,
    playbackSpeed,
    audioDevices,
    activeAudioDevice = 'auto',
    i18n,
    onSelectAudio,
    onSelectAudioDevice,
    onSelectSubtitle,
    onSelectSpeed,
  } = params;
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
