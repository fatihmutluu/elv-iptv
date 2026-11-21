import type { MediaTracks, PlaybackClock, PlaybackStatus, PlaybackTimers } from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  clampSettingsMenu,
  initialSettingsMenu,
  type SettingsMenuState,
  type SettingsMenuView,
} from './settings-menu-nav';
import { createTouchHoverGuard, type TouchHoverGuard } from './touch-hover-guard';
import { clampPickerCursor, initialPickerCursor, type TrackPickerCursor } from './track-picker-nav';
import { availableTvOsdActions, clampTvOsdAction, type TvOsdAction } from './tv-osd-nav';

/** Live mutable snapshot shared with synchronous key handlers in {@link usePlayerControls}. */
export interface PlayerOverlayLive {
  tracksOpen: boolean;
  pickerCursor: TrackPickerCursor;
  settingsOpen: boolean;
  settingsMenu: SettingsMenuState;
  locked: boolean;
  osdHidden: boolean;
  tvOsdFocused: boolean;
  tvScrubberFocused: boolean;
  tvOsdAction: TvOsdAction;
  availableOsd: TvOsdAction[];
  tracks: MediaTracks;
  hasTracks: boolean;
  hasService: boolean;
  isVod: boolean;
  playbackSpeed: number;
}

/**
 * Owns track picker, 2-level Settings menu, Stats HUD toggle, mobile Touch Lock, TV OSD
 * visibility/auto-hide, and TV OSD/scrubber focus state for {@link usePlayerControls}.
 */
export function usePlayerOverlayState(params: {
  formFactor: FormFactor;
  itemKey: string;
  isVod: boolean;
  playbackSpeed?: number;
  statusKind: PlaybackStatus['kind'];
  tracks: MediaTracks;
  hasTracks: boolean;
  hasService: boolean;
  showRetry: boolean;
  hasSettings: boolean;
  hasNextEpisode: boolean;
  hasPreviousChannel: boolean;
  initialOsdHidden?: boolean | undefined;
  autoHideOsdMs?: number | undefined;
  isScrubbing: boolean;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  cancelScrub: () => void;
}) {
  const { formFactor, itemKey, isVod, statusKind, tracks, hasTracks, hasService, showRetry } =
    params;
  const { hasSettings, hasNextEpisode, hasPreviousChannel, initialOsdHidden, autoHideOsdMs } =
    params;
  const { isScrubbing, clockRef, timersRef, cancelScrub } = params;
  const isTv = formFactor === 'tv';
  const canLock = formFactor === 'phone' || formFactor === 'tablet';

  const [rawTracksOpen, setTracksOpen] = useState(false);
  const [rawPickerCursor, setPickerCursor] = useState<TrackPickerCursor>({
    column: 'audio',
    index: 0,
  });
  const [rawSettingsOpen, setSettingsOpen] = useState(false);
  const [rawSettingsMenu, setSettingsMenu] = useState<SettingsMenuState>(() =>
    initialSettingsMenu(),
  );
  const [statsVisible, setStatsVisible] = useState(false);
  const [rawLocked, setLocked] = useState(false);
  const [rawOsdHidden, setOsdHidden] = useState(initialOsdHidden === true);
  const [tvOsdFocused, setTvOsdFocused] = useState(false);
  const [rawTvScrubberFocused, setTvScrubberFocused] = useState(false);
  const [rawTvOsdAction, setTvOsdAction] = useState<TvOsdAction>('playPause');
  const [osdActivitySeq, setOsdActivitySeq] = useState(0);

  const tracksOpen = rawTracksOpen && hasTracks;
  const settingsOpen = rawSettingsOpen && hasService;
  const locked = canLock && rawLocked;
  const osdHidden = rawOsdHidden && !locked && !tracksOpen && !settingsOpen;
  const tvScrubberFocused =
    isTv && isVod && rawTvScrubberFocused && !locked && !tracksOpen && !settingsOpen && !osdHidden;
  const pickerCursor = clampPickerCursor(rawPickerCursor, tracks);
  const settingsMenu = clampSettingsMenu(rawSettingsMenu, tracks, { isVod });
  const availableOsd = availableTvOsdActions({
    isVod,
    hasService,
    hasTracks,
    showRetry,
    hasSettings,
    hasNextEpisode,
    hasPreviousChannel,
  });
  const tvOsdAction = clampTvOsdAction(rawTvOsdAction, availableOsd);

  const liveSnapshot: PlayerOverlayLive = {
    tracksOpen,
    pickerCursor,
    settingsOpen,
    settingsMenu,
    locked,
    osdHidden,
    tvOsdFocused,
    tvScrubberFocused,
    tvOsdAction,
    availableOsd,
    tracks,
    hasTracks,
    hasService,
    isVod,
    playbackSpeed: params.playbackSpeed ?? 1,
  };
  const liveRef = useRef<PlayerOverlayLive>(liveSnapshot);
  liveRef.current = liveSnapshot;
  const prevItemKeyRef = useRef(itemKey);
  const hoverGuardRef = useRef<TouchHoverGuard | null>(null);
  hoverGuardRef.current ??= createTouchHoverGuard({ now: () => clockRef.current.now() });
  const clearTvFocus = useCallback((): void => {
    liveRef.current.tvOsdFocused = false;
    liveRef.current.tvScrubberFocused = false;
    setTvOsdFocused(false);
    setTvScrubberFocused(false);
  }, []);
  const autoHideHandleRef = useRef<unknown>(undefined);
  const clearAutoHide = useCallback(() => {
    if (autoHideHandleRef.current !== undefined) {
      timersRef.current.clearTimeout(autoHideHandleRef.current);
      autoHideHandleRef.current = undefined;
    }
  }, [timersRef]);

  useEffect(() => {
    if (rawTracksOpen && !hasTracks) setTracksOpen(false);
    else if (tracksOpen && pickerCursor !== rawPickerCursor) setPickerCursor(pickerCursor);
    if (rawSettingsOpen && !hasService) setSettingsOpen(false);
    else if (settingsOpen && settingsMenu !== rawSettingsMenu) setSettingsMenu(settingsMenu);
    if (rawTvScrubberFocused && (!isTv || !isVod)) setTvScrubberFocused(false);
    if (tvOsdAction !== rawTvOsdAction) setTvOsdAction(tvOsdAction);
  }, [
    hasService,
    hasTracks,
    isTv,
    isVod,
    pickerCursor,
    rawPickerCursor,
    rawSettingsMenu,
    rawSettingsOpen,
    rawTracksOpen,
    rawTvOsdAction,
    rawTvScrubberFocused,
    settingsMenu,
    settingsOpen,
    tracksOpen,
    tvOsdAction,
  ]);

  useEffect(() => {
    cancelScrub();
    liveRef.current.tracksOpen = false;
    liveRef.current.settingsOpen = false;
    liveRef.current.locked = false;
    clearTvFocus();
    setTracksOpen(false);
    setSettingsOpen(false);
    setLocked(false);
    if (prevItemKeyRef.current !== itemKey) {
      prevItemKeyRef.current = itemKey;
      liveRef.current.osdHidden = false;
      setOsdHidden(false);
    }
    return () => cancelScrub();
  }, [itemKey, cancelScrub, clearTvFocus]);

  useEffect(() => {
    if (statusKind === 'failed' || statusKind === 'paused' || statusKind === 'ended') {
      liveRef.current.osdHidden = false;
      setOsdHidden(false);
    }
  }, [statusKind]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: osdActivitySeq and itemKey intentionally re-arm the auto-hide timer
  useEffect(() => {
    clearAutoHide();
    if (
      autoHideOsdMs === undefined ||
      autoHideOsdMs <= 0 ||
      statusKind !== 'playing' ||
      osdHidden ||
      isScrubbing ||
      tracksOpen ||
      settingsOpen ||
      locked ||
      tvOsdFocused ||
      tvScrubberFocused
    ) {
      return clearAutoHide;
    }
    autoHideHandleRef.current = timersRef.current.setTimeout(() => {
      autoHideHandleRef.current = undefined;
      liveRef.current.osdHidden = true;
      clearTvFocus();
      setOsdHidden(true);
    }, autoHideOsdMs);
    return clearAutoHide;
  }, [
    autoHideOsdMs,
    statusKind,
    osdHidden,
    isScrubbing,
    tracksOpen,
    settingsOpen,
    locked,
    tvOsdFocused,
    tvScrubberFocused,
    itemKey,
    osdActivitySeq,
    timersRef,
    clearAutoHide,
    clearTvFocus,
  ]);

  const notifyOsdActivity = (): void => {
    const wasArmed = autoHideHandleRef.current !== undefined;
    clearAutoHide();
    if (wasArmed) setOsdActivitySeq((n) => n + 1);
  };

  const hideOsd = (): void => {
    cancelScrub();
    clearAutoHide();
    liveRef.current.osdHidden = true;
    clearTvFocus();
    setOsdHidden(true);
  };

  const showOsd = (): void => {
    clearAutoHide();
    liveRef.current.osdHidden = false;
    setOsdHidden(false);
  };

  const handleTouchActivity = (): void => hoverGuardRef.current?.markTouch();

  const handlePointerHover = (pointerType?: string): void => {
    if (!hoverGuardRef.current?.shouldAllowHover(pointerType)) return;
    if (liveRef.current.osdHidden) showOsd();
    else notifyOsdActivity();
  };

  const blurTvOsd = (): void => {
    liveRef.current.tvOsdFocused = false;
    setTvOsdFocused(false);
  };

  const focusTvOsd = (action: TvOsdAction): void => {
    liveRef.current.tvScrubberFocused = false;
    liveRef.current.tvOsdAction = action;
    liveRef.current.tvOsdFocused = true;
    setTvScrubberFocused(false);
    setTvOsdAction(action);
    setTvOsdFocused(true);
  };

  const focusTvScrubber = (): void => {
    liveRef.current.tvOsdFocused = false;
    liveRef.current.tvScrubberFocused = true;
    setTvOsdFocused(false);
    setTvScrubberFocused(true);
  };

  const blurTvScrubber = (): void => {
    liveRef.current.tvScrubberFocused = false;
    setTvScrubberFocused(false);
  };

  const updatePickerCursor = (cursor: TrackPickerCursor): void => {
    liveRef.current.pickerCursor = cursor;
    setPickerCursor(cursor);
  };

  const updateSettingsMenu = (next: SettingsMenuState): void => {
    liveRef.current.settingsMenu = next;
    setSettingsMenu(next);
  };

  const openTracks = (): void => {
    if (!liveRef.current.hasTracks) return;
    cancelScrub();
    const initial = initialPickerCursor(liveRef.current.tracks);
    liveRef.current.pickerCursor = initial;
    liveRef.current.tracksOpen = true;
    liveRef.current.settingsOpen = false;
    liveRef.current.osdHidden = false;
    clearTvFocus();
    setPickerCursor(initial);
    setSettingsOpen(false);
    setOsdHidden(false);
    setTracksOpen(true);
  };

  const openSettings = (view: SettingsMenuView = 'root'): void => {
    if (!liveRef.current.hasService) return;
    cancelScrub();
    const opts = { isVod: liveRef.current.isVod, playbackSpeed: liveRef.current.playbackSpeed };
    const initial = clampSettingsMenu(
      initialSettingsMenu(view, opts),
      liveRef.current.tracks,
      opts,
    );
    liveRef.current.settingsMenu = initial;
    liveRef.current.settingsOpen = true;
    liveRef.current.tracksOpen = false;
    liveRef.current.osdHidden = false;
    clearTvFocus();
    setSettingsMenu(initial);
    setTracksOpen(false);
    setOsdHidden(false);
    setSettingsOpen(true);
  };

  const lockControls = (): void => {
    if (!canLock) return;
    cancelScrub();
    liveRef.current.tracksOpen = false;
    liveRef.current.settingsOpen = false;
    liveRef.current.locked = true;
    clearTvFocus();
    setTracksOpen(false);
    setSettingsOpen(false);
    setLocked(true);
  };

  const closeTracks = (): void => {
    liveRef.current.tracksOpen = false;
    setTracksOpen(false);
  };
  const closeSettings = (): void => {
    liveRef.current.settingsOpen = false;
    setSettingsOpen(false);
  };
  const openSettingsView = (view: SettingsMenuView): void => {
    const opts = { isVod: liveRef.current.isVod, playbackSpeed: liveRef.current.playbackSpeed };
    updateSettingsMenu(
      clampSettingsMenu(initialSettingsMenu(view, opts), liveRef.current.tracks, opts),
    );
  };
  const toggleStats = (): void => setStatsVisible((prev) => !prev);
  const unlockControls = (): void => {
    liveRef.current.locked = false;
    setLocked(false);
  };

  return {
    liveRef,
    hideOsd,
    showOsd,
    notifyOsdActivity,
    blurTvOsd,
    focusTvOsd,
    focusTvScrubber,
    blurTvScrubber,
    updatePickerCursor,
    updateSettingsMenu,
    openTracks,
    closeTracks,
    openSettings,
    closeSettings,
    toggleStats,
    unlockControls,
    publicState: {
      tracksOpen,
      pickerCursor,
      settingsOpen,
      settingsMenu,
      statsVisible,
      canLock,
      locked,
      osdHidden,
      tvOsdFocused,
      tvScrubberFocused,
      tvOsdAction,
      openTracks,
      closeTracks,
      openSettings,
      closeSettings,
      openSettingsView,
      toggleStats,
      lockControls,
      unlockControls,
      handleTouchActivity,
      handlePointerHover,
    },
  };
}
