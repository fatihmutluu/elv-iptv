import type { CatalogService } from '@elv/data';
import type { DeinterlaceMode, OsdTimeDisplayMode, SleepTimerAction } from '@elv/domain';
import {
  type ChapterInfo,
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { OpenVideoEngine, VideoResizeMode } from '../ports/video-host';
import { resolveChapterJumpTarget } from './chapters';
import { mapRecentChannelRows } from './PlayerScreenParts';
import { resolveTrackPreferenceScopeKey } from './track-preferences';
import { useSleepTimer } from './useSleepTimer';
import { useStillWatching } from './useStillWatching';
import { cycleOsdTimeDisplayMode } from './vod-progress-math';

const MAX_IPC_TRACK_LANG = 16;
const MAX_IPC_TRACK_LABEL = 128;

function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) out += value[i];
  }
  return out;
}

/** @internal Sanitizes & truncates track language/label metadata before catalog IPC persistence (`#208`). */
export function sanitizeTrackMetaForIpc(
  value: string | null | undefined,
  maxLen: number,
): string | null {
  if (typeof value !== 'string') return null;
  const clean = stripControlChars(value).trim();
  if (clean.length === 0) return null;
  return clean.slice(0, maxLen);
}

/**
 * Bundles Wave C1 player extras (`#118` sleep timer, chapters, still-watching prompt,
 * `#160` OSD time-display toggle, `#208` per-item track/aspect persistence, `#124`/`#310`
 * live host sync) so `PlayerScreen` stays focused on composition.
 */
export function usePlayerCinemaExtras(params: {
  readonly activeTarget: PlayTarget;
  readonly status: PlaybackStatus;
  readonly tracks: MediaTracks;
  readonly chapters: readonly ChapterInfo[] | undefined;
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly catalogRef: MutableRefObject<
    Partial<Pick<CatalogService, 'saveTrackPreference' | 'nowNext' | 'listRecentChannels'>> & {
      readonly epgNowNext?: CatalogService['nowNext'];
    }
  >;
  readonly wallClockRef?: MutableRefObject<() => number> | undefined;
  readonly serviceRef: MutableRefObject<PlaybackService | null>;
  readonly clockRef: MutableRefObject<PlaybackClock>;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly flushProgressRef: MutableRefObject<(overridePosMs?: number) => void>;
  readonly onExitRef: MutableRefObject<() => void>;
  readonly filterSdhSubtitles: boolean;
  readonly osdTimeDisplayMode: OsdTimeDisplayMode;
  readonly onPersistOsdTimeDisplayMode?: ((mode: OsdTimeDisplayMode) => void) | undefined;
  readonly onPersistResizeMode?: ((mode: VideoResizeMode) => void) | undefined;
  readonly sleepTimerDefaultAction: SleepTimerAction;
  readonly onPersistSleepTimerAction?: ((action: SleepTimerAction) => void) | undefined;
  readonly stillWatchingTimeoutMin: number;
  readonly onPlaybackActiveChange?: ((active: boolean) => void) | undefined;
  readonly deinterlaceMode?: DeinterlaceMode | undefined;
  readonly onPersistDeinterlaceMode?: ((mode: DeinterlaceMode) => void) | undefined;
  readonly pitchLock?: boolean | undefined;
  readonly onPersistPitchLock?: ((locked: boolean) => void) | undefined;
  readonly audioNormalization?: boolean | undefined;
  readonly onPersistAudioNormalization?: ((enabled: boolean) => void) | undefined;
  readonly initialVolume?: number | undefined;
  readonly volume?: number | undefined;
  readonly resizeMode?: VideoResizeMode | undefined;
  readonly preferredAudioDevice?: string | undefined;
}) {
  const {
    activeTarget,
    status,
    tracks,
    chapters,
    openedEngine,
    catalogRef,
    wallClockRef,
    serviceRef,
    clockRef,
    timersRef,
    flushProgressRef,
    onExitRef,
    filterSdhSubtitles,
    osdTimeDisplayMode: initialTimeMode,
    onPersistOsdTimeDisplayMode,
    onPersistResizeMode,
    sleepTimerDefaultAction,
    onPersistSleepTimerAction,
    stillWatchingTimeoutMin,
    onPlaybackActiveChange,
    deinterlaceMode,
    onPersistDeinterlaceMode,
    pitchLock,
    onPersistPitchLock,
    audioNormalization,
    onPersistAudioNormalization,
    initialVolume,
    volume,
    resizeMode,
    preferredAudioDevice,
  } = params;

  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const openedEngineRef = useRef(openedEngine);
  openedEngineRef.current = openedEngine;
  const onPersistTimeModeRef = useRef(onPersistOsdTimeDisplayMode);
  onPersistTimeModeRef.current = onPersistOsdTimeDisplayMode;
  const onPersistResizeModeRef = useRef(onPersistResizeMode);
  onPersistResizeModeRef.current = onPersistResizeMode;

  const [timeDisplayMode, setTimeDisplayMode] = useState<OsdTimeDisplayMode>(initialTimeMode);
  useEffect(() => {
    setTimeDisplayMode(initialTimeMode);
  }, [initialTimeMode]);

  const [activeDeinterlaceMode, setActiveDeinterlaceMode] = useState<DeinterlaceMode>(
    deinterlaceMode ?? 'off',
  );
  const [activePitchLock, setActivePitchLock] = useState<boolean>(pitchLock ?? true);
  const [activeAudioNorm, setActiveAudioNorm] = useState<boolean>(audioNormalization ?? false);
  useEffect(() => {
    if (deinterlaceMode !== undefined) setActiveDeinterlaceMode(deinterlaceMode);
  }, [deinterlaceMode]);
  useEffect(() => {
    if (pitchLock !== undefined) setActivePitchLock(pitchLock);
  }, [pitchLock]);
  useEffect(() => {
    if (audioNormalization !== undefined) setActiveAudioNorm(audioNormalization);
  }, [audioNormalization]);

  const cycleDeinterlaceMode =
    openedEngine?.setDeinterlaceMode !== undefined || onPersistDeinterlaceMode !== undefined
      ? () => {
          const next: DeinterlaceMode =
            activeDeinterlaceMode === 'off'
              ? 'auto'
              : activeDeinterlaceMode === 'auto'
                ? 'bwdif'
                : 'off';
          setActiveDeinterlaceMode(next);
          openedEngineRef.current?.setDeinterlaceMode?.(next);
          onPersistDeinterlaceMode?.(next);
        }
      : undefined;
  const togglePitchLock =
    openedEngine?.setPitchLock !== undefined || onPersistPitchLock !== undefined
      ? () => {
          const next = !activePitchLock;
          setActivePitchLock(next);
          openedEngineRef.current?.setPitchLock?.(next);
          onPersistPitchLock?.(next);
        }
      : undefined;
  const toggleAudioNormalization =
    openedEngine?.setAudioNormalization !== undefined || onPersistAudioNormalization !== undefined
      ? () => {
          const next = !activeAudioNorm;
          setActiveAudioNorm(next);
          openedEngineRef.current?.setAudioNormalization?.(next);
          onPersistAudioNormalization?.(next);
        }
      : undefined;

  const handleCycleTimeDisplayMode = useCallback((): void => {
    setTimeDisplayMode((prev) => {
      const next = cycleOsdTimeDisplayMode(prev);
      onPersistTimeModeRef.current?.(next);
      return next;
    });
  }, []);

  // Forward live SDH filter changes to engine host (#310)
  useEffect(() => {
    openedEngine?.setFilterSdh?.(filterSdhSubtitles);
  }, [filterSdhSubtitles, openedEngine]);

  const latestVolumeRef = useRef(volume);
  latestVolumeRef.current = volume;
  const latestResizeModeRef = useRef<VideoResizeMode>(resizeMode ?? 'fit');
  latestResizeModeRef.current = resizeMode ?? 'fit';
  const initialVolumeRef = useRef(initialVolume);
  initialVolumeRef.current = initialVolume;
  const preferredAudioDeviceRef = useRef(preferredAudioDevice);
  preferredAudioDeviceRef.current = preferredAudioDevice;

  useEffect(() => {
    if (openedEngine === undefined) return;
    const effective =
      initialVolumeRef.current ?? openedEngine.initialVolume ?? latestVolumeRef.current ?? 100;
    openedEngine.setVolume?.(Math.max(0, Math.min(100, Math.round(effective))));
    openedEngine.setResizeMode?.(latestResizeModeRef.current);
    const savedDevice = preferredAudioDeviceRef.current?.trim();
    if (savedDevice && savedDevice !== 'auto') {
      openedEngine.setAudioDevice?.(savedDevice);
    }
  }, [openedEngine]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-send resizeMode when activeTarget.itemKey changes so mpv --reset-on-next-file never reverts to fit
  useEffect(() => {
    if (openedEngine === undefined || resizeMode === undefined) return;
    if (status.kind === 'playing' || status.kind === 'paused') {
      openedEngine.setResizeMode?.(resizeMode);
    }
  }, [openedEngine, activeTarget.itemKey, status.kind, resizeMode]);

  const [stillWatchingAction, setStillWatchingAction] = useState<'continue' | 'stop'>('continue');
  const stillWatchingActionRef = useRef(stillWatchingAction);
  stillWatchingActionRef.current = stillWatchingAction;

  // Notify AppShell OLED screensaver whether playback is actively running (#160)
  const isPlaybackActive =
    status.kind === 'playing' || status.kind === 'tuning' || status.kind === 'recovering';
  useEffect(() => {
    onPlaybackActiveChange?.(isPlaybackActive);
  }, [isPlaybackActive, onPlaybackActiveChange]);
  useEffect(
    () => () => {
      onPlaybackActiveChange?.(false);
    },
    [onPlaybackActiveChange],
  );

  const stopAndExit = useCallback((): void => {
    flushProgressRef.current();
    serviceRef.current?.stop();
    onExitRef.current();
  }, [flushProgressRef, onExitRef, serviceRef]);

  const {
    sleepTimer,
    selectMinutes: selectSleepTimer,
    toggleAction: toggleSleepTimerAction,
  } = useSleepTimer({
    defaultAction: sleepTimerDefaultAction,
    clockRef,
    timersRef,
    onPersistAction: onPersistSleepTimerAction,
    onExpire: (action) => {
      if (action === 'pause' && activeTargetRef.current.kind === 'vod') {
        serviceRef.current?.pause();
        return;
      }
      stopAndExit();
    },
  });

  const stillWatching = useStillWatching({
    timeoutMin: stillWatchingTimeoutMin,
    statusKind: status.kind,
    clockRef,
    timersRef,
    onStop: stopAndExit,
  });

  useEffect(() => {
    if (stillWatching.promptVisible) setStillWatchingAction('continue');
  }, [stillWatching.promptVisible]);

  const handleStillWatchingKey = useCallback(
    (key: string): void => {
      if (key === 'left' || key === 'up') setStillWatchingAction('continue');
      else if (key === 'right' || key === 'down') setStillWatchingAction('stop');
      else if (key === 'back') stillWatching.keepWatching();
      else if (key === 'select') {
        if (stillWatchingActionRef.current === 'stop') stillWatching.stopNow();
        else stillWatching.keepWatching();
      }
    },
    [stillWatching],
  );

  const handleAudioTrackSelected = useCallback(
    (id: string): void => {
      const save = catalogRef.current.saveTrackPreference;
      if (save === undefined) return;
      const track = tracksRef.current.audio.find((t) => t.id === id);
      if (track === undefined) return;
      const cur = activeTargetRef.current;
      void Promise.resolve(
        save({
          scopeKey: resolveTrackPreferenceScopeKey(cur),
          sourceId: cur.sourceId,
          audioLang: sanitizeTrackMetaForIpc(track.language, MAX_IPC_TRACK_LANG),
          audioLabel: sanitizeTrackMetaForIpc(track.label, MAX_IPC_TRACK_LABEL),
        }),
      ).catch(() => undefined);
    },
    [catalogRef],
  );

  const handleSubtitleTrackSelected = useCallback(
    (id: string | null): void => {
      const save = catalogRef.current.saveTrackPreference;
      if (save === undefined) return;
      const cur = activeTargetRef.current;
      const scopeKey = resolveTrackPreferenceScopeKey(cur);
      if (id === null) {
        void Promise.resolve(
          save({
            scopeKey,
            sourceId: cur.sourceId,
            subLang: null,
            subLabel: null,
            subDisabled: true,
          }),
        ).catch(() => undefined);
        return;
      }
      const track = tracksRef.current.subtitles.find((t) => t.id === id);
      void Promise.resolve(
        save({
          scopeKey,
          sourceId: cur.sourceId,
          subLang: sanitizeTrackMetaForIpc(track?.language, MAX_IPC_TRACK_LANG),
          subLabel: sanitizeTrackMetaForIpc(track?.label, MAX_IPC_TRACK_LABEL),
          subDisabled: false,
        }),
      ).catch(() => undefined);
    },
    [catalogRef],
  );

  const handleResizeModeChange = useCallback(
    (mode: VideoResizeMode): void => {
      openedEngineRef.current?.setResizeMode?.(mode);
      onPersistResizeModeRef.current?.(mode);
      const save = catalogRef.current.saveTrackPreference;
      if (save === undefined) return;
      const cur = activeTargetRef.current;
      void Promise.resolve(
        save({
          scopeKey: resolveTrackPreferenceScopeKey(cur),
          sourceId: cur.sourceId,
          resizeMode: mode,
        }),
      ).catch(() => undefined);
    },
    [catalogRef],
  );

  const handleSelectChapter = useCallback(
    (startMs: number): void => {
      const svc = serviceRef.current;
      if (svc === null || activeTargetRef.current.kind !== 'vod') return;
      svc.seek(startMs);
      flushProgressRef.current(startMs);
    },
    [flushProgressRef, serviceRef],
  );

  const stepChapter = useCallback(
    (direction: 'prev' | 'next'): void => {
      const list = chaptersRef.current;
      const svc = serviceRef.current;
      if (!list || list.length === 0 || svc === null || activeTargetRef.current.kind !== 'vod') {
        return;
      }
      const anchor = svc.getState().anchor;
      const posMs = anchor !== undefined ? positionAt(anchor, clockRef.current.now()) : 0;
      const targetMs = resolveChapterJumpTarget(list, posMs, direction);
      if (targetMs !== undefined) handleSelectChapter(targetMs);
    },
    [clockRef, handleSelectChapter, serviceRef],
  );

  const handlePrevChapter = useCallback((): void => stepChapter('prev'), [stepChapter]);
  const handleNextChapter = useCallback((): void => stepChapter('next'), [stepChapter]);

  const fetchChannelNowNext = useCallback(
    async (itemKey: string) => {
      const query = catalogRef.current.nowNext ?? catalogRef.current.epgNowNext;
      if (query === undefined) return null;
      const now = wallClockRef?.current() ?? Date.now();
      const rows = await query([itemKey], now);
      return rows.find((r) => r.channelKey === itemKey) ?? rows[0] ?? null;
    },
    [catalogRef, wallClockRef],
  );
  const fetchRecentChannels = useCallback(
    async () => mapRecentChannelRows((await catalogRef.current.listRecentChannels?.(20)) ?? []),
    [catalogRef],
  );

  return {
    timeDisplayMode,
    handleCycleTimeDisplayMode,
    activeDeinterlaceMode,
    cycleDeinterlaceMode,
    activePitchLock,
    togglePitchLock,
    activeAudioNorm,
    toggleAudioNormalization,
    sleepTimer,
    selectSleepTimer,
    toggleSleepTimerAction,
    stillWatching,
    stillWatchingAction,
    handleStillWatchingKey,
    handleAudioTrackSelected,
    handleSubtitleTrackSelected,
    handleResizeModeChange,
    handleSelectChapter,
    handlePrevChapter,
    handleNextChapter,
    fetchChannelNowNext,
    fetchRecentChannels,
  };
}
