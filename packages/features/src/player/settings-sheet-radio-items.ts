import type { LiveVariantOption } from '@elv/data';
import { ANDROID_DECODER_MODES, type AndroidDecoderMode } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { MediaTracks, VideoQualityOption } from '@elv/playback';
import type { IconName } from '@elv/ui-kit';
import type { AudioDeviceInfo } from '../ports/video-host';
import {
  audioMenuEntries,
  effectiveTracksForView,
  formatPlaybackSpeed,
  formatSyncDelayMs,
  hasAudioSettingsView,
  hasSubtitleSettingsView,
  normalizeAudioDeviceChoices,
  PLAYBACK_SPEED_OPTIONS,
  type SettingsMenuView,
  SYNC_DELAY_STEP_ACTIONS,
  subtitleMenuEntries,
} from './settings-menu-nav';
import { SLEEP_TIMER_PRESETS_MIN, type SleepTimerSnapshot } from './sleep-timer';
import { formatTrackLabel } from './track-labels';
import { buildSubtitleColumnEntries } from './track-picker-nav';

/** Option descriptor for radio/action rows rendered inside sub-views of `PlayerSettingsSheet`. */
export interface SettingsRadioItem {
  readonly key: string;
  readonly testID: string;
  readonly label: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly badgeLabel?: string;
  readonly disabledHint?: string;
  readonly trailingIcon?: IconName;
  readonly sectionHeader?: string;
  readonly role?: 'radio' | 'button';
  readonly tabular?: boolean;
  readonly onPress: () => void;
}

/** @internal Formats a localized decoder label shared with `settings-sheet-items.ts`. */
export function formatVideoDecoderLabel(mode: AndroidDecoderMode, i18n: AppI18n): string {
  if (mode === 'hardware') return i18n.t('settings.playback.videoDecoder.hardware');
  if (mode === 'software') return i18n.t('settings.playback.videoDecoder.software');
  return i18n.t('settings.playback.videoDecoder.auto');
}

function formatVideoQualityLabel(option: VideoQualityOption): string {
  const parts: string[] = [option.label];
  if (option.fps !== undefined && Number.isFinite(option.fps) && option.fps > 0) {
    parts.push(`${Math.round(option.fps)} fps`);
  }
  if (
    option.bitrateBps !== undefined &&
    Number.isFinite(option.bitrateBps) &&
    option.bitrateBps > 0
  ) {
    parts.push(
      option.bitrateBps >= 1_000_000
        ? `${(option.bitrateBps / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(option.bitrateBps / 1_000)} kbps`,
    );
  }
  return parts.join(' · ');
}

function syncDelayStepTestId(prefix: string, step: number): string {
  if (step === 0) return `${prefix}-reset`;
  return step > 0 ? `${prefix}-plus-${step}` : `${prefix}-minus-${Math.abs(step)}`;
}

/** Shared delay stepper item builder used by `PlayerSubtitleSettingsView` & `PlayerAudioSettingsView`. */
export function buildDelayStepperItems(params: {
  readonly kind: 'audio' | 'subtitle';
  readonly delayMs: number;
  readonly i18n: AppI18n;
  readonly onAdjust: ((deltaMs: number, reset?: boolean) => void) | undefined;
}): readonly SettingsRadioItem[] {
  const isAudio = params.kind === 'audio';
  const prefix = isAudio ? 'player-settings-audio-delay' : 'player-settings-subtitle-delay';
  return SYNC_DELAY_STEP_ACTIONS.map((step) => ({
    key: `${params.kind}-delay-${step}`,
    testID: syncDelayStepTestId(prefix, step),
    label: step === 0 ? params.i18n.t('player.delayReset') : formatSyncDelayMs(step),
    selected: step === 0 && params.delayMs === 0,
    tabular: true,
    onPress: () => params.onAdjust?.(step, step === 0),
  }));
}

/** Builds secondary & external subtitle radio/action rows rendered inside `'subtitleSettings'`. */
export function buildSubtitleSettingsExtraItems(params: {
  readonly tracks: MediaTracks;
  readonly dualSubtitles: boolean;
  readonly i18n: AppI18n;
  readonly onSelectSecondarySubtitle?: ((id: string | null) => void) | undefined;
  readonly onPickSubtitleFile?: (() => void) | undefined;
  readonly onLoadSubtitleUrl?: (() => void) | undefined;
}): readonly SettingsRadioItem[] {
  const {
    tracks,
    dualSubtitles,
    i18n,
    onSelectSecondarySubtitle,
    onPickSubtitleFile,
    onLoadSubtitleUrl,
  } = params;
  const effective = effectiveTracksForView(tracks);
  const entries = buildSubtitleColumnEntries(effective, {
    dualSubtitles: dualSubtitles && onSelectSecondarySubtitle !== undefined,
    canPickSubtitleFile: onPickSubtitleFile !== undefined,
    canLoadSubtitleUrl: onLoadSubtitleUrl !== undefined,
  }).filter((e) => e.kind !== 'primaryOff' && e.kind !== 'primaryTrack');

  const externalBadge = i18n.t('player.externalSubtitle.badge');
  const sameAsPrimaryHint = i18n.t('player.secondarySameAsPrimary');
  const firstExternalIdx = entries.findIndex(
    (entry) => entry.kind === 'pickSubtitleFile' || entry.kind === 'loadSubtitleUrl',
  );

  return entries.map((entry, idx): SettingsRadioItem => {
    if (entry.kind === 'secondaryOff') {
      return {
        key: 'secondary-off',
        testID: 'player-settings-secondary-sub-off',
        label: i18n.t('player.subtitlesOff'),
        selected: (effective.selectedSecondarySubtitleId ?? null) === null,
        sectionHeader: i18n.t('player.secondarySubtitleTracks'),
        onPress: () => onSelectSecondarySubtitle?.(null),
      };
    }
    if (entry.kind === 'secondaryTrack') {
      return {
        key: `secondary-${entry.track.id}`,
        testID: `player-settings-secondary-sub-${entry.track.id}`,
        label: formatTrackLabel(entry.track, entry.trackIndex, effective.subtitles, i18n),
        selected: !entry.disabled && effective.selectedSecondarySubtitleId === entry.track.id,
        disabled: entry.disabled,
        ...(entry.track.external === true ? { badgeLabel: externalBadge } : {}),
        ...(entry.disabled ? { disabledHint: sameAsPrimaryHint } : {}),
        onPress: () => {
          if (!entry.disabled) onSelectSecondarySubtitle?.(entry.track.id);
        },
      };
    }
    const isPick = entry.kind === 'pickSubtitleFile';
    return {
      key: entry.kind,
      testID: isPick ? 'player-settings-external-sub-pick' : 'player-settings-external-sub-url',
      label: i18n.t(
        isPick ? 'player.externalSubtitle.pickFile' : 'player.externalSubtitle.fromUrl',
      ),
      selected: false,
      role: 'button',
      ...(idx === firstExternalIdx
        ? { sectionHeader: i18n.t('player.externalSubtitle.load') }
        : {}),
      onPress: () => {
        if (isPick) onPickSubtitleFile?.();
        else onLoadSubtitleUrl?.();
      },
    };
  });
}

/** Builds audio output device radio rows rendered inside `'audioSettings'`. */
export function buildAudioDeviceRadioItems(params: {
  readonly audioDevices: readonly AudioDeviceInfo[] | undefined;
  readonly activeAudioDevice: string;
  readonly i18n: AppI18n;
  readonly onSelectAudioDevice: ((name: string) => void) | undefined;
}): readonly SettingsRadioItem[] {
  const normalized = normalizeAudioDeviceChoices(params.audioDevices);
  const isAuto = params.activeAudioDevice === '' || params.activeAudioDevice === 'auto';
  return [
    {
      key: 'auto',
      testID: 'player-settings-audio-device-auto',
      label: params.i18n.t('player.audioDeviceAuto'),
      selected: isAuto,
      sectionHeader: params.i18n.t('player.audioDevice'),
      onPress: () => params.onSelectAudioDevice?.('auto'),
    },
    ...normalized.map((device, idx) => ({
      key: device.name,
      testID: `player-settings-audio-device-${idx}`,
      label: device.description || device.name,
      selected: params.activeAudioDevice === device.name,
      onPress: () => params.onSelectAudioDevice?.(device.name),
    })),
  ];
}

/** Builds level-1 and standard level-2 radio rows for `PlayerSettingsSheet`. */
export function buildSettingsRadioItems(params: {
  view: SettingsMenuView;
  tracks: MediaTracks;
  isVod?: boolean;
  playbackSpeed: number;
  androidDecoderMode?: AndroidDecoderMode | undefined;
  qualityVariants?: readonly LiveVariantOption[] | undefined;
  activeQualityKey?: string | undefined;
  selectedVideoQualityId?: string | null | undefined;
  sleepTimer?: SleepTimerSnapshot | undefined;
  i18n: AppI18n;
  onSelectProgram?: ((id: string) => void) | undefined;
  onSelectAudio: (id: string) => void;
  onSelectVideoQuality?: ((id: string | null) => void) | undefined;
  onSelectQualityVariant?: ((itemKey: string) => void) | undefined;
  onSelectSubtitle: (id: string | null) => void;
  hasSubtitleDelay?: boolean | undefined;
  hasSubtitleStyle?: boolean | undefined;
  dualSubtitles?: boolean | undefined;
  onSelectSecondarySubtitle?: ((id: string | null) => void) | undefined;
  onPickSubtitleFile?: (() => void) | undefined;
  onLoadSubtitleUrl?: (() => void) | undefined;
  hasAudioDelay?: boolean | undefined;
  hasAudioDevice?: boolean | undefined;
  hasAudioNormalization?: boolean | undefined;
  hasPitchLock?: boolean | undefined;
  onOpenView?: ((view: SettingsMenuView) => void) | undefined;
  onSelectSpeed?: ((rate: number) => void) | undefined;
  onSelectSleepTimer?: ((minutes: number) => void) | undefined;
  onToggleSleepTimerAction?: (() => void) | undefined;
  onSelectAndroidDecoderMode?: ((mode: AndroidDecoderMode) => void) | undefined;
}): readonly SettingsRadioItem[] {
  const {
    view,
    tracks,
    isVod = false,
    playbackSpeed,
    androidDecoderMode = 'auto',
    qualityVariants = [],
    activeQualityKey,
    selectedVideoQualityId,
    sleepTimer,
    i18n,
    onSelectProgram,
    onSelectAudio,
    onSelectVideoQuality,
    onSelectQualityVariant,
    onSelectSubtitle,
    onSelectSpeed,
    onSelectSleepTimer,
    onToggleSleepTimerAction,
    onSelectAndroidDecoderMode,
  } = params;

  if (view === 'videoQuality') {
    const activeId =
      selectedVideoQualityId !== undefined
        ? selectedVideoQualityId
        : (tracks.selectedVideoQualityId ?? null);
    return [
      {
        key: 'auto',
        testID: 'player-settings-video-quality-auto',
        label: i18n.t('player.videoQualityAuto'),
        selected: activeId === null,
        onPress: () => onSelectVideoQuality?.(null),
      },
      ...(tracks.videoQualities ?? []).map((option) => ({
        key: option.id,
        testID: `player-settings-video-quality-${option.id}`,
        label: formatVideoQualityLabel(option),
        selected: activeId === option.id,
        tabular: true,
        onPress: () => onSelectVideoQuality?.(option.id),
      })),
    ];
  }
  if (view === 'quality') {
    return qualityVariants.map((variant) => ({
      key: variant.key,
      testID: `player-settings-quality-${variant.key}`,
      label: variant.qualityLabel || variant.title,
      selected: variant.key === activeQualityKey,
      onPress: () => onSelectQualityVariant?.(variant.key),
    }));
  }
  if (view === 'sleepTimer') {
    const activeMin = sleepTimer?.active === true ? sleepTimer.totalMinutes : 0;
    const action = sleepTimer?.action ?? 'stop';
    const actionLabel =
      action === 'pause' ? i18n.t('player.sleepTimerPause') : i18n.t('player.sleepTimerStop');
    const presets: SettingsRadioItem[] = SLEEP_TIMER_PRESETS_MIN.map((minutes) => ({
      key: `sleep-${minutes}`,
      testID: `player-settings-sleep-${minutes}`,
      label:
        minutes === 0
          ? i18n.t('player.sleepTimerOff')
          : i18n.t('player.sleepTimerMinutes', { minutes }),
      selected: activeMin === minutes,
      tabular: true,
      onPress: () => onSelectSleepTimer?.(minutes),
    }));
    if (!isVod) return presets;
    return [
      {
        key: 'sleep-action',
        testID: 'player-settings-sleep-action',
        label: `${i18n.t('player.sleepTimerAction')}: ${actionLabel}`,
        selected: false,
        onPress: () => onToggleSleepTimerAction?.(),
      },
      ...presets,
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
    const subOpts = {
      hasSubtitleDelay: params.hasSubtitleDelay === true,
      hasSubtitleStyle: params.hasSubtitleStyle === true,
      hasDualSubtitles:
        params.dualSubtitles === true && params.onSelectSecondarySubtitle !== undefined,
      canPickSubtitleFile: params.onPickSubtitleFile !== undefined,
      canLoadSubtitleUrl: params.onLoadSubtitleUrl !== undefined,
    };
    const effective = effectiveTracksForView(tracks);
    const entries = subtitleMenuEntries(tracks, subOpts);
    const externalBadge = i18n.t('player.externalSubtitle.badge');
    const items: SettingsRadioItem[] = [];
    for (const entry of entries) {
      if (entry.kind === 'primaryOff') {
        items.push({
          key: 'off',
          testID: 'player-settings-sub-off',
          label: i18n.t('player.subtitlesOff'),
          selected: tracks.selectedSubtitleId === null,
          onPress: () => onSelectSubtitle(null),
        });
      } else if (entry.kind === 'primaryTrack') {
        items.push({
          key: entry.track.id,
          testID: `player-settings-sub-${entry.track.id}`,
          label: formatTrackLabel(entry.track, entry.trackIndex, effective.subtitles, i18n),
          selected: tracks.selectedSubtitleId === entry.track.id,
          ...(entry.track.external === true ? { badgeLabel: externalBadge } : {}),
          onPress: () => onSelectSubtitle(entry.track.id),
        });
      } else if (hasSubtitleSettingsView(tracks, subOpts)) {
        items.push({
          key: 'open-subtitle-settings',
          testID: 'player-settings-open-subtitle-settings',
          label: i18n.t('player.subtitleSettings'),
          selected: false,
          role: 'button',
          trailingIcon: 'chevronRight',
          onPress: () => params.onOpenView?.('subtitleSettings'),
        });
      }
    }
    return items;
  }

  if (view === 'audio') {
    const audOpts = {
      isVod,
      hasAudioDelay: params.hasAudioDelay === true,
      hasAudioDevice: params.hasAudioDevice === true,
      hasAudioNormalization: params.hasAudioNormalization === true,
      hasPitchLock: params.hasPitchLock === true,
    };
    const effective = effectiveTracksForView(tracks);
    const entries = audioMenuEntries(tracks, audOpts);
    const hasPrograms = entries.some((e) => e.kind === 'program');
    let placedAudioHeader = false;
    const items: SettingsRadioItem[] = [];
    for (const entry of entries) {
      if (entry.kind === 'program') {
        const progTitle =
          entry.program.serviceName?.trim() ||
          entry.program.label?.trim() ||
          `Program ${entry.programIndex + 1}`;
        items.push({
          key: `program-${entry.program.id}`,
          testID: `player-settings-program-${entry.program.id}`,
          label:
            entry.program.programNumber !== undefined
              ? `${entry.program.programNumber} · ${progTitle}`
              : progTitle,
          selected: tracks.selectedProgramId === entry.program.id,
          ...(entry.programIndex === 0 ? { sectionHeader: i18n.t('player.tracks.program') } : {}),
          onPress: () => onSelectProgram?.(entry.program.id),
        });
      } else if (entry.kind === 'audio') {
        const sectionHeader =
          hasPrograms && !placedAudioHeader ? i18n.t('player.audioTracks') : undefined;
        placedAudioHeader = true;
        items.push({
          key: entry.track.id,
          testID: `player-settings-audio-${entry.track.id}`,
          label: formatTrackLabel(entry.track, entry.trackIndex, effective.audio, i18n),
          selected: tracks.selectedAudioId === entry.track.id,
          ...(sectionHeader !== undefined ? { sectionHeader } : {}),
          onPress: () => onSelectAudio(entry.track.id),
        });
      } else if (hasAudioSettingsView(audOpts)) {
        items.push({
          key: 'open-audio-settings',
          testID: 'player-settings-open-audio-settings',
          label: i18n.t('player.audioSettings'),
          selected: false,
          role: 'button',
          trailingIcon: 'chevronRight',
          onPress: () => params.onOpenView?.('audioSettings'),
        });
      }
    }
    return items;
  }

  return [];
}
