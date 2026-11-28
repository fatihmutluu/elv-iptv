import type { LiveVariantOption } from '@elv/data';
import { ANDROID_DECODER_MODES, type AndroidDecoderMode } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks } from '@elv/playback';
import {
  type AudioSettingsEntry,
  advancedSettingsItems,
  audioMenuEntries,
  audioSettingsMenuEntries,
  effectiveTracksForView,
  hasAudioSettingsView,
  hasSubtitleSettingsView,
  PLAYBACK_SPEED_OPTIONS,
  type SettingsMenuIntent,
  type SettingsMenuOptions,
  type SettingsMenuState,
  type SettingsMenuView,
  type SettingsRootItem,
  SYNC_DELAY_RESET_INDEX,
  settingsRootItemsFromOptions,
  showLiveQualityItem,
  showVideoQualityItem,
  subtitleMenuEntries,
  subtitleSettingsMenuEntries,
} from './settings-menu-model';
import { SLEEP_TIMER_PRESETS_MIN } from './sleep-timer';

export {
  advancedSettingsItems,
  audioMenuEntries,
  audioSettingsMenuEntries,
  effectiveTracksForView,
  formatPlaybackSpeed,
  formatSyncDelayMs,
  hasAudioSettingsView,
  hasSubtitleSettingsView,
  normalizeAudioDeviceChoices,
  PLAYBACK_SPEED_OPTIONS,
  SETTINGS_ROOT_ITEMS,
  type SettingsMenuIntent,
  type SettingsMenuOptions,
  type SettingsMenuState,
  type SettingsMenuView,
  SYNC_DELAY_RESET_INDEX,
  SYNC_DELAY_STEP_ACTIONS,
  settingsRootItemsFromOptions,
  subtitleMenuEntries,
  subtitleSettingsMenuEntries,
} from './settings-menu-model';

function selectedAudioIndex(tracks: MediaTracks, options?: SettingsMenuOptions): number {
  const entries = audioMenuEntries(tracks, options);
  const idx = entries.findIndex((e) => e.kind === 'audio' && e.track.id === tracks.selectedAudioId);
  if (idx >= 0) return idx;
  const firstAudio = entries.findIndex((e) => e.kind === 'audio');
  return Math.max(0, firstAudio);
}

function selectedAudioDeviceEntryIndex(
  entries: readonly AudioSettingsEntry[],
  activeAudioDevice: string | undefined,
): number {
  if (!activeAudioDevice || activeAudioDevice === 'auto') {
    return Math.max(
      0,
      entries.findIndex((e) => e.kind === 'deviceAuto'),
    );
  }
  const matchIdx = entries.findIndex(
    (e) => e.kind === 'device' && e.device.name === activeAudioDevice,
  );
  if (matchIdx >= 0) return matchIdx;
  return Math.max(
    0,
    entries.findIndex((e) => e.kind === 'deviceAuto'),
  );
}

function selectedSubtitleIndex(tracks: MediaTracks): number {
  const effective = effectiveTracksForView(tracks);
  return effective.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId) + 1;
}

function selectedSpeedIndex(playbackSpeed: number | undefined): number {
  const rate = playbackSpeed ?? 1;
  const idx = PLAYBACK_SPEED_OPTIONS.indexOf(rate as (typeof PLAYBACK_SPEED_OPTIONS)[number]);
  return idx >= 0 ? idx : PLAYBACK_SPEED_OPTIONS.indexOf(1);
}

function selectedVideoDecoderIndex(mode: AndroidDecoderMode | undefined): number {
  return Math.max(ANDROID_DECODER_MODES.indexOf(mode ?? 'auto'), 0);
}

function selectedSleepTimerIndex(minutes: number | undefined, isVod: boolean): number {
  const idx = SLEEP_TIMER_PRESETS_MIN.indexOf(
    (minutes ?? 0) as (typeof SLEEP_TIMER_PRESETS_MIN)[number],
  );
  if (!isVod) return Math.max(idx, 0);
  // On VOD, row 0 is the action toggle (Stop vs Pause); presets start at index 1
  return idx >= 0 ? idx + 1 : 1;
}

function selectedQualityIndex(
  variants: readonly LiveVariantOption[] | undefined,
  activeKey: string | undefined,
): number {
  if (!variants || variants.length === 0 || !activeKey) return 0;
  return Math.max(
    0,
    variants.findIndex((v) => v.key === activeKey),
  );
}

function selectedVideoQualityIndex(
  tracks: MediaTracks,
  selectedId: string | null | undefined,
): number {
  const effectiveId =
    selectedId !== undefined ? selectedId : (tracks.selectedVideoQualityId ?? null);
  if (effectiveId === null) return 0;
  const idx = (tracks.videoQualities ?? []).findIndex((q) => q.id === effectiveId);
  return idx >= 0 ? idx + 1 : 0;
}

/** Returns the parent view when pressing Back inside `view`, or `null` when closing from `root`. */
export function getParentSettingsView(view: SettingsMenuView): SettingsMenuView | null {
  switch (view) {
    case 'root':
      return null;
    case 'subtitleSettings':
      return 'subtitles';
    case 'audioSettings':
      return 'audio';
    case 'videoDecoder':
      return 'advanced';
    default:
      return 'root';
  }
}

/** Returns the parent {@link SettingsMenuState} for `view`, restoring focus to its opener row. */
export function parentStateForSettingsView(
  view: SettingsMenuView,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuState | null {
  if (view === 'root') return null;
  const parent = getParentSettingsView(view);
  if (parent === null) return null;
  if (parent === 'subtitles') {
    const entries = subtitleMenuEntries(tracks, options);
    const idx = entries.findIndex((e) => e.kind === 'openSubtitleSettings');
    return { view: 'subtitles', index: Math.max(idx, 0) };
  }
  if (parent === 'audio') {
    const entries = audioMenuEntries(tracks, options);
    const idx = entries.findIndex((e) => e.kind === 'openAudioSettings');
    return { view: 'audio', index: Math.max(idx, 0) };
  }
  if (parent === 'advanced') {
    const idx = advancedSettingsItems(options).indexOf('videoDecoder');
    return { view: 'advanced', index: Math.max(0, idx) };
  }
  return {
    view: 'root',
    index: rootIndexForSettingsViewOptions(view, options, tracks),
  };
}

/** Creates the initial focused state for the given Settings menu view (`root` by default). */
export function initialSettingsMenu(
  view: SettingsMenuView = 'root',
  options?: SettingsMenuOptions,
  tracks?: MediaTracks,
): SettingsMenuState {
  if (view === 'subtitles' && tracks !== undefined) {
    return { view, index: selectedSubtitleIndex(tracks) };
  }
  if (view === 'audio' && tracks !== undefined) {
    return { view, index: selectedAudioIndex(tracks, options) };
  }
  if (view === 'subtitleSettings') {
    return { view, index: options?.hasSubtitleDelay === true ? SYNC_DELAY_RESET_INDEX : 0 };
  }
  if (view === 'audioSettings') {
    if (options?.hasAudioDelay === true) {
      return { view, index: SYNC_DELAY_RESET_INDEX };
    }
    const entries = audioSettingsMenuEntries(options);
    return {
      view,
      index: selectedAudioDeviceEntryIndex(entries, options?.activeAudioDevice),
    };
  }
  if (view === 'speed' && options?.playbackSpeed !== undefined) {
    return { view, index: selectedSpeedIndex(options.playbackSpeed) };
  }
  if (view === 'videoQuality' && tracks !== undefined) {
    return {
      view,
      index: selectedVideoQualityIndex(tracks, options?.selectedVideoQualityId),
    };
  }
  if (view === 'quality') {
    return {
      view,
      index: selectedQualityIndex(options?.qualityVariants, options?.activeQualityKey),
    };
  }
  if (view === 'videoDecoder') {
    return { view, index: selectedVideoDecoderIndex(options?.androidDecoderMode) };
  }
  if (view === 'sleepTimer') {
    return {
      view,
      index: selectedSleepTimerIndex(options?.sleepTimerMinutes, options?.isVod === true),
    };
  }
  return { view, index: 0 };
}

/** Number of focusable rows in `view`. */
export function settingsRowCount(
  view: SettingsMenuView,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): number {
  switch (view) {
    case 'root':
      return settingsRootItemsFromOptions(options, tracks).length;
    case 'subtitles':
      return subtitleMenuEntries(tracks, options).length;
    case 'subtitleSettings':
      return subtitleSettingsMenuEntries(tracks, options).length;
    case 'audio':
      return audioMenuEntries(tracks, options).length;
    case 'audioSettings':
      return audioSettingsMenuEntries(options).length;
    case 'videoQuality':
      return showVideoQualityItem(tracks, options) ? (tracks.videoQualities?.length ?? 0) + 1 : 0;
    case 'quality':
      return showLiveQualityItem(options) ? (options?.qualityVariants?.length ?? 0) : 0;
    case 'speed':
      return options?.isVod === true ? PLAYBACK_SPEED_OPTIONS.length : 0;
    case 'sleepTimer':
      if (options?.hasSleepTimer !== true) return 0;
      return options.isVod === true
        ? SLEEP_TIMER_PRESETS_MIN.length + 1
        : SLEEP_TIMER_PRESETS_MIN.length;
    case 'advanced':
      return advancedSettingsItems(options).length;
    case 'videoDecoder':
      return options?.hasVideoDecoder === true ? ANDROID_DECODER_MODES.length : 0;
  }
}

/** Keeps `state` and `state.index` within valid bounds, returning `state` unchanged when valid. */
export function clampSettingsMenu(
  state: SettingsMenuState,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuState {
  if (state.view === 'speed' && options?.isVod !== true) return { view: 'root', index: 0 };
  if (state.view === 'subtitleSettings' && !hasSubtitleSettingsView(tracks, options)) {
    return { view: 'subtitles', index: selectedSubtitleIndex(tracks) };
  }
  if (state.view === 'audioSettings' && !hasAudioSettingsView(options)) {
    return { view: 'audio', index: selectedAudioIndex(tracks, options) };
  }
  if (state.view === 'videoQuality' && !showVideoQualityItem(tracks, options)) {
    return { view: 'root', index: 0 };
  }
  if (state.view === 'quality' && !showLiveQualityItem(options)) {
    return { view: 'root', index: 0 };
  }
  if (state.view === 'sleepTimer' && options?.hasSleepTimer !== true) {
    return { view: 'root', index: 0 };
  }
  if (state.view === 'advanced' && advancedSettingsItems(options).length === 0) {
    return { view: 'root', index: 0 };
  }
  if (state.view === 'videoDecoder' && options?.hasVideoDecoder !== true) {
    return advancedSettingsItems(options).length > 0
      ? { view: 'advanced', index: 0 }
      : { view: 'root', index: 0 };
  }
  const count = settingsRowCount(state.view, tracks, options);
  const index = Math.max(0, Math.min(Math.max(0, count - 1), state.index));
  return index === state.index ? state : { view: state.view, index };
}

/** Returns the root-level row index corresponding to `view`. */
export function rootIndexForSettingsViewOptions(
  view: Exclude<SettingsMenuView, 'root'>,
  options?: SettingsMenuOptions,
  tracks?: MediaTracks,
): number {
  const mappedRoot: SettingsRootItem =
    view === 'subtitleSettings'
      ? 'subtitles'
      : view === 'audioSettings'
        ? 'audio'
        : view === 'videoDecoder'
          ? 'advanced'
          : view;
  return Math.max(settingsRootItemsFromOptions(options, tracks).indexOf(mappedRoot), 0);
}

function openSubView(
  item: SettingsRootItem,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  if (item === 'subtitles') {
    return { kind: 'state', state: { view: 'subtitles', index: selectedSubtitleIndex(tracks) } };
  }
  if (item === 'audio') {
    return {
      kind: 'state',
      state: { view: 'audio', index: selectedAudioIndex(tracks, options) },
    };
  }
  if (item === 'speed' && options?.isVod === true) {
    return {
      kind: 'state',
      state: { view: 'speed', index: selectedSpeedIndex(options.playbackSpeed) },
    };
  }
  if (item === 'videoQuality' && showVideoQualityItem(tracks, options)) {
    return {
      kind: 'state',
      state: {
        view: 'videoQuality',
        index: selectedVideoQualityIndex(tracks, options?.selectedVideoQualityId),
      },
    };
  }
  if (item === 'quality' && showLiveQualityItem(options)) {
    return {
      kind: 'state',
      state: {
        view: 'quality',
        index: selectedQualityIndex(options?.qualityVariants, options?.activeQualityKey),
      },
    };
  }
  if (item === 'sleepTimer' && options?.hasSleepTimer === true) {
    return {
      kind: 'state',
      state: {
        view: 'sleepTimer',
        index: selectedSleepTimerIndex(options.sleepTimerMinutes, options.isVod === true),
      },
    };
  }
  if (item === 'advanced' && advancedSettingsItems(options).length > 0) {
    return { kind: 'state', state: { view: 'advanced', index: 0 } };
  }
  return null;
}

function routeSelectOnRoot(
  item: SettingsRootItem | undefined,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  if (item === undefined) return null;
  if (item === 'aspect') return { kind: 'toggleResizeMode' };
  if (item === 'multiView') return { kind: 'enterMultiView' };
  if (item === 'stats') return { kind: 'toggleStats' };
  return openSubView(item, tracks, options);
}

function routeSelectOnSubtitles(
  index: number,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const entry = subtitleMenuEntries(tracks, options)[index];
  if (entry === undefined) return null;
  if (entry.kind === 'primaryOff') return { kind: 'subtitle', id: null };
  if (entry.kind === 'primaryTrack') return { kind: 'subtitle', id: entry.track.id };
  return { kind: 'state', state: initialSettingsMenu('subtitleSettings', options, tracks) };
}

function routeSelectOnSubtitleSettings(
  index: number,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const entry = subtitleSettingsMenuEntries(tracks, options)[index];
  if (entry === undefined) return null;
  if (entry.kind === 'delayStep') {
    return entry.step === 0
      ? { kind: 'subtitleDelay', deltaMs: 0, reset: true }
      : { kind: 'subtitleDelay', deltaMs: entry.step };
  }
  if (entry.kind === 'styleField') {
    return { kind: 'stepSubtitleStyle', field: entry.field, delta: 1 };
  }
  if (entry.kind === 'styleReset') return { kind: 'resetSubtitleStyle' };
  if (entry.kind === 'secondaryOff') return { kind: 'secondarySubtitle', id: null };
  if (entry.kind === 'secondaryTrack') {
    return entry.disabled ? null : { kind: 'secondarySubtitle', id: entry.track.id };
  }
  if (entry.kind === 'pickSubtitleFile') return { kind: 'pickSubtitleFile' };
  return { kind: 'loadSubtitleUrl' };
}

function routeSelectOnAudio(
  index: number,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const entry = audioMenuEntries(tracks, options)[index];
  if (entry === undefined) return null;
  if (entry.kind === 'program') return { kind: 'program', id: entry.program.id };
  if (entry.kind === 'audio') return { kind: 'audio', id: entry.track.id };
  return { kind: 'state', state: initialSettingsMenu('audioSettings', options, tracks) };
}

function routeSelectOnAudioSettings(
  index: number,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const entry = audioSettingsMenuEntries(options)[index];
  if (entry === undefined) return null;
  if (entry.kind === 'delayStep') {
    return entry.step === 0
      ? { kind: 'audioDelay', deltaMs: 0, reset: true }
      : { kind: 'audioDelay', deltaMs: entry.step };
  }
  if (entry.kind === 'deviceAuto') return { kind: 'audioDevice', name: 'auto' };
  if (entry.kind === 'device') return { kind: 'audioDevice', name: entry.device.name };
  if (entry.kind === 'audioNormalization') return { kind: 'toggleAudioNormalization' };
  return { kind: 'togglePitchLock' };
}

function routeSelectOnAdvanced(
  index: number,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const item = advancedSettingsItems(options)[index];
  if (item === undefined) return null;
  if (item === 'deinterlace') return { kind: 'toggleDeinterlace' };
  if (item === 'videoDecoder') {
    return {
      kind: 'state',
      state: {
        view: 'videoDecoder',
        index: selectedVideoDecoderIndex(options?.androidDecoderMode),
      },
    };
  }
  if (item === 'audioNormalization') return { kind: 'toggleAudioNormalization' };
  if (item === 'pitchLock') return { kind: 'togglePitchLock' };
  if (item === 'autoPlayNextEpisode') return { kind: 'toggleAutoPlayNextEpisode' };
  return { kind: 'enterPip' };
}

/** Routes a key event while the Player Settings menu is open. */
export function routeSettingsMenuKey(
  event: KeyEvent,
  state: SettingsMenuState,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const rootItems = settingsRootItemsFromOptions(options, tracks);
  const cur = clampSettingsMenu(state, tracks, options);

  if (event.kind === 'press' && event.key === 'back') {
    const parent = parentStateForSettingsView(cur.view, tracks, options);
    return parent === null ? { kind: 'close' } : { kind: 'state', state: parent };
  }

  if (
    (event.kind === 'press' || event.kind === 'repeat') &&
    (event.key === 'up' || event.key === 'down')
  ) {
    const delta = event.key === 'down' ? 1 : -1;
    return {
      kind: 'state',
      state: clampSettingsMenu({ view: cur.view, index: cur.index + delta }, tracks, options),
    };
  }

  if (event.kind === 'press' && event.key === 'left') {
    if (cur.view === 'root') return null;
    if (cur.view === 'subtitleSettings') {
      const entry = subtitleSettingsMenuEntries(tracks, options)[cur.index];
      if (entry?.kind === 'styleField') {
        return { kind: 'stepSubtitleStyle', field: entry.field, delta: -1 };
      }
    }
    const parent = parentStateForSettingsView(cur.view, tracks, options);
    return parent === null ? null : { kind: 'state', state: parent };
  }

  if (event.kind === 'press' && event.key === 'right') {
    if (cur.view === 'subtitleSettings') {
      const entry = subtitleSettingsMenuEntries(tracks, options)[cur.index];
      return entry?.kind === 'styleField'
        ? { kind: 'stepSubtitleStyle', field: entry.field, delta: 1 }
        : null;
    }
    if (cur.view === 'subtitles') {
      const entry = subtitleMenuEntries(tracks, options)[cur.index];
      return entry?.kind === 'openSubtitleSettings'
        ? { kind: 'state', state: initialSettingsMenu('subtitleSettings', options, tracks) }
        : null;
    }
    if (cur.view === 'audio') {
      const entry = audioMenuEntries(tracks, options)[cur.index];
      return entry?.kind === 'openAudioSettings'
        ? { kind: 'state', state: initialSettingsMenu('audioSettings', options, tracks) }
        : null;
    }
    if (cur.view === 'advanced') {
      return advancedSettingsItems(options)[cur.index] === 'videoDecoder'
        ? routeSelectOnAdvanced(cur.index, options)
        : null;
    }
    if (cur.view !== 'root') return null;
    const item = rootItems[cur.index];
    return item !== undefined ? openSubView(item, tracks, options) : null;
  }

  if (event.kind === 'press' && event.key === 'select') {
    if (cur.view === 'root') return routeSelectOnRoot(rootItems[cur.index], tracks, options);
    if (cur.view === 'subtitles') return routeSelectOnSubtitles(cur.index, tracks, options);
    if (cur.view === 'subtitleSettings') {
      return routeSelectOnSubtitleSettings(cur.index, tracks, options);
    }
    if (cur.view === 'audio') return routeSelectOnAudio(cur.index, tracks, options);
    if (cur.view === 'audioSettings') return routeSelectOnAudioSettings(cur.index, options);
    if (cur.view === 'advanced') return routeSelectOnAdvanced(cur.index, options);
    if (cur.view === 'videoQuality') {
      if (cur.index === 0) return { kind: 'videoQuality', id: null };
      const quality = tracks.videoQualities?.[cur.index - 1];
      return quality !== undefined ? { kind: 'videoQuality', id: quality.id } : null;
    }
    if (cur.view === 'quality') {
      const variant = options?.qualityVariants?.[cur.index];
      return variant !== undefined ? { kind: 'quality', itemKey: variant.key } : null;
    }
    if (cur.view === 'speed') {
      const rate = PLAYBACK_SPEED_OPTIONS[cur.index];
      return rate !== undefined ? { kind: 'speed', rate } : null;
    }
    if (cur.view === 'sleepTimer') {
      if (options?.isVod === true) {
        if (cur.index === 0) return { kind: 'toggleSleepTimerAction' };
        const minutes = SLEEP_TIMER_PRESETS_MIN[cur.index - 1];
        return minutes !== undefined ? { kind: 'sleepTimer', minutes } : null;
      }
      const minutes = SLEEP_TIMER_PRESETS_MIN[cur.index];
      return minutes !== undefined ? { kind: 'sleepTimer', minutes } : null;
    }
    const mode = ANDROID_DECODER_MODES[cur.index];
    return mode !== undefined ? { kind: 'videoDecoder', mode } : null;
  }

  return null;
}
