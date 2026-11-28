import type { LiveVariantOption } from '@elv/data';
import type { AndroidDecoderMode, DeinterlaceMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { MediaTracks, TrackInfo } from '@elv/playback';
import type { IconName } from '@elv/ui-kit';
import type { AudioDeviceInfo, VideoResizeMode } from '../ports/video-host';
import { formatPlaybackSpeed, type SettingsMenuView } from './settings-menu-nav';
import { formatVideoDecoderLabel } from './settings-sheet-radio-items';
import type { SleepTimerSnapshot } from './sleep-timer';
import { formatTrackLabel } from './track-labels';

export {
  buildAudioDeviceRadioItems,
  buildDelayStepperItems,
  buildSettingsRadioItems,
  buildSubtitleSettingsExtraItems,
  type SettingsRadioItem,
} from './settings-sheet-radio-items';

export type SettingsNavRow = readonly [
  testID: string,
  icon: IconName,
  label: string,
  summary: string,
  targetView: SettingsMenuView,
  tabular: boolean,
  description: string,
];

export interface SettingsToggleDescriptor {
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly description: string;
  readonly pillLabel: string;
  readonly active: boolean;
  readonly role: 'button' | 'switch';
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}

export type SettingsOrderedRootEntry =
  | { readonly kind: 'nav'; readonly row: SettingsNavRow }
  | { readonly kind: 'toggle'; readonly toggle: SettingsToggleDescriptor };

export type SettingsOrderedAdvancedEntry =
  | { readonly kind: 'nav'; readonly row: SettingsNavRow }
  | { readonly kind: 'toggle'; readonly toggle: SettingsToggleDescriptor };

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

/** Builds the shared Loudness Normalization toggle descriptor for Audio & Advanced views. */
export function buildAudioNormalizationToggle(
  audioNormalization: boolean | undefined,
  i18n: AppI18n,
  onToggle: () => void,
): SettingsToggleDescriptor {
  const on = audioNormalization === true;
  return {
    testID: 'player-audio-normalization-toggle',
    icon: 'audio',
    label: i18n.t('settings.audioNormalization'),
    description: i18n.t('player.settings.desc.audioNormalization'),
    pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
    active: on,
    role: 'switch',
    accessibilityLabel: i18n.t('settings.audioNormalization'),
    onPress: onToggle,
  };
}

/** Builds the shared VOD Pitch Lock toggle descriptor for Audio & Advanced views. */
export function buildPitchLockToggle(
  pitchLock: boolean | undefined,
  i18n: AppI18n,
  onToggle: () => void,
): SettingsToggleDescriptor {
  const on = pitchLock !== false;
  return {
    testID: 'player-pitch-lock-toggle',
    icon: 'speed',
    label: i18n.t('settings.pitchLock'),
    description: i18n.t('player.settings.desc.pitchLock'),
    pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
    active: on,
    role: 'switch',
    accessibilityLabel: i18n.t('settings.pitchLock'),
    onPress: onToggle,
  };
}

/** Builds streamlined top-level navigation rows matching `settingsRootItemsFromOptions`. */
export function buildSettingsNavRows(
  tracks: MediaTracks,
  isVod: boolean,
  playbackSpeed: number,
  i18n: AppI18n,
  _audioDevice?: {
    readonly show: boolean;
    readonly devices: readonly AudioDeviceInfo[];
    readonly activeDevice: string;
  },
  videoDecoder?: {
    readonly show: boolean;
    readonly mode: AndroidDecoderMode;
  },
  extras?: {
    readonly showSleepTimer?: boolean | undefined;
    readonly sleepTimer?: SleepTimerSnapshot | undefined;
    readonly qualityVariants?: readonly LiveVariantOption[] | undefined;
    readonly activeQualityKey?: string | undefined;
    readonly showVideoQuality?: boolean | undefined;
    readonly selectedVideoQualityId?: string | null | undefined;
    readonly showAdvanced?: boolean | undefined;
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
      i18n.t('player.settings.desc.subtitles'),
    ],
    [
      'player-settings-row-audio',
      'audio',
      i18n.t('player.audioTracks'),
      audioSummary,
      'audio',
      false,
      i18n.t('player.settings.desc.audio'),
    ],
  ];
  if (isVod) {
    rows.push([
      'player-settings-row-speed',
      'speed',
      i18n.t('player.speed'),
      formatPlaybackSpeed(playbackSpeed),
      'speed',
      true,
      i18n.t('player.settings.desc.speed'),
    ]);
  }
  const videoQualities = tracks.videoQualities;
  if (
    extras?.showVideoQuality === true &&
    videoQualities !== undefined &&
    videoQualities.length > 1
  ) {
    const activeQualityId =
      extras.selectedVideoQualityId !== undefined
        ? extras.selectedVideoQualityId
        : (tracks.selectedVideoQualityId ?? null);
    const activeOption =
      activeQualityId !== null ? videoQualities.find((q) => q.id === activeQualityId) : undefined;
    rows.push([
      'player-settings-row-video-quality',
      'layers',
      i18n.t('player.videoQuality'),
      activeOption?.label ?? i18n.t('player.videoQualityAuto'),
      'videoQuality',
      true,
      i18n.t('player.settings.desc.videoQuality'),
    ]);
  }
  const qualityVariants = extras?.qualityVariants;
  if (!isVod && qualityVariants !== undefined && qualityVariants.length > 1) {
    const activeVariant = qualityVariants.find((v) => v.key === extras?.activeQualityKey);
    const qualitySummary =
      activeVariant?.qualityLabel ||
      i18n.t('player.qualityVariantCount', { count: qualityVariants.length });
    rows.push([
      'player-settings-row-quality',
      'layers',
      i18n.t('player.qualityVariant'),
      qualitySummary,
      'quality',
      false,
      i18n.t('player.settings.desc.quality'),
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
      i18n.t('player.settings.desc.sleepTimer'),
    ]);
  }
  if (extras?.showAdvanced === true || videoDecoder?.show === true) {
    rows.push([
      'player-settings-row-advanced',
      'settings',
      i18n.t('player.advancedSettings'),
      '',
      'advanced',
      false,
      i18n.t('player.settings.desc.advanced'),
    ]);
  }
  return rows;
}

/** Builds ordered root entries in exact `settingsRootItemsFromOptions` index order (`Wave R4`). */
export function buildOrderedRootSettingsEntries(params: {
  readonly tracks: MediaTracks;
  readonly isVod: boolean;
  readonly playbackSpeed: number;
  readonly resizeMode: VideoResizeMode;
  readonly statsVisible: boolean;
  readonly sleepTimer?: SleepTimerSnapshot | undefined;
  readonly qualityVariants?: readonly LiveVariantOption[] | undefined;
  readonly activeQualityKey?: string | undefined;
  readonly showVideoQuality: boolean;
  readonly selectedVideoQualityId?: string | null | undefined;
  readonly showSleepTimer: boolean;
  readonly hasAdvanced: boolean;
  readonly i18n: AppI18n;
  readonly onToggleResizeMode?: (() => void) | undefined;
  readonly onEnterMultiView?: (() => void) | undefined;
  readonly onToggleStats: () => void;
  readonly onClose: () => void;
}): readonly SettingsOrderedRootEntry[] {
  const { i18n, statsVisible } = params;
  const navRows = buildSettingsNavRows(
    params.tracks,
    params.isVod,
    params.playbackSpeed,
    i18n,
    undefined,
    undefined,
    {
      showSleepTimer: params.showSleepTimer,
      sleepTimer: params.sleepTimer,
      qualityVariants: params.qualityVariants,
      activeQualityKey: params.activeQualityKey,
      showVideoQuality: params.showVideoQuality,
      selectedVideoQualityId: params.selectedVideoQualityId,
      showAdvanced: params.hasAdvanced,
    },
  );
  const byTarget = new Map<SettingsMenuView, SettingsNavRow>();
  for (const row of navRows) byTarget.set(row[4], row);

  const entries: SettingsOrderedRootEntry[] = [];
  const pushNav = (view: SettingsMenuView): void => {
    const row = byTarget.get(view);
    if (row !== undefined) entries.push({ kind: 'nav', row });
  };

  pushNav('subtitles');
  pushNav('audio');
  pushNav('speed');
  pushNav('videoQuality');
  pushNav('quality');

  if (params.onToggleResizeMode !== undefined) {
    const rm = params.resizeMode;
    const rmLabel =
      rm === 'fill'
        ? i18n.t('player.aspect.fill')
        : rm === 'stretch'
          ? i18n.t('player.aspect.stretch')
          : i18n.t('player.aspect.fit');
    entries.push({
      kind: 'toggle',
      toggle: {
        testID: 'player-resize-mode-toggle',
        icon: 'aspect',
        label: i18n.t('player.aspect'),
        description: i18n.t('player.settings.desc.resizeMode'),
        pillLabel: rmLabel,
        active: rm !== 'fit',
        role: 'button',
        accessibilityLabel: `${i18n.t('player.aspect')}: ${rmLabel}`,
        onPress: params.onToggleResizeMode,
      },
    });
  }
  if (params.onEnterMultiView !== undefined) {
    const onEnterMultiView = params.onEnterMultiView;
    entries.push({
      kind: 'toggle',
      toggle: {
        testID: 'player-settings-multiview',
        icon: 'multiview',
        label: i18n.t('player.multiView.enter'),
        description: i18n.t('player.settings.desc.multiView'),
        pillLabel: i18n.t('player.multiView.title'),
        active: false,
        role: 'button',
        accessibilityLabel: i18n.t('player.multiView.enter'),
        onPress: () => {
          params.onClose();
          onEnterMultiView();
        },
      },
    });
  }

  pushNav('sleepTimer');

  entries.push({
    kind: 'toggle',
    toggle: {
      testID: 'player-stats-toggle',
      icon: 'info',
      label: i18n.t('player.statsHud'),
      description: i18n.t('player.settings.desc.stats'),
      pillLabel: statsVisible ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
      active: statsVisible,
      role: 'switch',
      accessibilityLabel: i18n.t('player.statsHud'),
      onPress: params.onToggleStats,
    },
  });

  pushNav('advanced');
  return entries;
}

/** Builds ordered items for the `'advanced'` sub-view matching `advancedSettingsItems`. */
export function buildOrderedAdvancedEntries(params: {
  readonly isVod: boolean;
  readonly deinterlace?: boolean | undefined;
  readonly deinterlaceMode?: DeinterlaceMode | undefined;
  readonly pitchLock?: boolean | undefined;
  readonly audioNormalization?: boolean | undefined;
  readonly autoPlayNextEpisode?: boolean | undefined;
  readonly androidDecoderMode?: AndroidDecoderMode | undefined;
  readonly i18n: AppI18n;
  readonly onToggleDeinterlace?: (() => void) | undefined;
  readonly onCycleDeinterlaceMode?: (() => void) | undefined;
  readonly onSelectAndroidDecoderMode?: ((mode: AndroidDecoderMode) => void) | undefined;
  readonly onToggleAudioNormalization?: (() => void) | undefined;
  readonly onTogglePitchLock?: (() => void) | undefined;
  readonly onToggleAutoPlayNextEpisode?: (() => void) | undefined;
  readonly onEnterPip?: (() => void) | undefined;
  readonly onClose: () => void;
}): readonly SettingsOrderedAdvancedEntry[] {
  const { i18n } = params;
  const entries: SettingsOrderedAdvancedEntry[] = [];

  if (params.onCycleDeinterlaceMode !== undefined) {
    const mode: DeinterlaceMode =
      params.deinterlaceMode ?? (params.deinterlace === true ? 'auto' : 'off');
    const modeLabel =
      mode === 'bwdif'
        ? i18n.t('settings.deinterlaceBwdif')
        : mode === 'auto'
          ? i18n.t('settings.deinterlaceAuto')
          : i18n.t('settings.deinterlaceOff');
    entries.push({
      kind: 'toggle',
      toggle: {
        testID: 'player-deinterlace-toggle',
        icon: 'layers',
        label: i18n.t('player.deinterlace'),
        description: i18n.t('player.settings.desc.deinterlace'),
        pillLabel: modeLabel,
        active: mode !== 'off',
        role: 'button',
        accessibilityLabel: `${i18n.t('player.deinterlace')}: ${modeLabel}`,
        onPress: params.onCycleDeinterlaceMode,
      },
    });
  } else if (params.onToggleDeinterlace !== undefined) {
    const on = params.deinterlace === true;
    entries.push({
      kind: 'toggle',
      toggle: {
        testID: 'player-deinterlace-toggle',
        icon: 'layers',
        label: i18n.t('player.deinterlace'),
        description: i18n.t('player.settings.desc.deinterlace'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('player.deinterlace'),
        onPress: params.onToggleDeinterlace,
      },
    });
  }

  if (params.androidDecoderMode !== undefined && params.onSelectAndroidDecoderMode !== undefined) {
    entries.push({
      kind: 'nav',
      row: [
        'player-settings-row-video-decoder',
        'layers',
        i18n.t('player.videoDecoder'),
        formatVideoDecoderLabel(params.androidDecoderMode, i18n),
        'videoDecoder',
        false,
        i18n.t('player.settings.desc.videoDecoder'),
      ],
    });
  }

  if (params.onToggleAudioNormalization !== undefined) {
    entries.push({
      kind: 'toggle',
      toggle: buildAudioNormalizationToggle(
        params.audioNormalization,
        i18n,
        params.onToggleAudioNormalization,
      ),
    });
  }

  if (params.isVod && params.onTogglePitchLock !== undefined) {
    entries.push({
      kind: 'toggle',
      toggle: buildPitchLockToggle(params.pitchLock, i18n, params.onTogglePitchLock),
    });
  }

  if (params.isVod && params.onToggleAutoPlayNextEpisode !== undefined) {
    const on = params.autoPlayNextEpisode !== false;
    entries.push({
      kind: 'toggle',
      toggle: {
        testID: 'player-auto-play-next-toggle',
        icon: 'play',
        label: i18n.t('player.autoPlayNextEpisode'),
        description: i18n.t('player.settings.desc.autoPlayNextEpisode'),
        pillLabel: on ? i18n.t('player.stats.on') : i18n.t('player.stats.off'),
        active: on,
        role: 'switch',
        accessibilityLabel: i18n.t('player.autoPlayNextEpisode'),
        onPress: params.onToggleAutoPlayNextEpisode,
      },
    });
  }

  if (params.onEnterPip !== undefined) {
    const onEnterPip = params.onEnterPip;
    entries.push({
      kind: 'toggle',
      toggle: {
        testID: 'player-settings-pip',
        icon: 'pip',
        label: i18n.t('player.pip.enter'),
        description: i18n.t('player.settings.desc.pip'),
        pillLabel: i18n.t('player.pip.enter'),
        active: false,
        role: 'button',
        accessibilityLabel: i18n.t('player.pip.enter'),
        onPress: () => {
          params.onClose();
          onEnterPip();
        },
      },
    });
  }

  return entries;
}
