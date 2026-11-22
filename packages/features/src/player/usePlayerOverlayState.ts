import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canAutoHideOsd,
  type PlayerOverlayLive,
  type PlayerOverlayStateParams,
} from './player-overlay-model';
import {
  clampSettingsMenu,
  initialSettingsMenu,
  type SettingsMenuState,
  type SettingsMenuView,
} from './settings-menu-nav';
import {
  createTouchHoverGuard,
  type PointerPoint,
  type TouchHoverGuard,
} from './touch-hover-guard';
import {
  clampPickerCursor,
  initialPickerCursor,
  type TrackPickerColumn,
  type TrackPickerCursor,
} from './track-picker-nav';
import { availableTvOsdActions, clampTvOsdAction, type TvOsdAction } from './tv-osd-nav';
import { useOsdAutoHide } from './useOsdAutoHide';
import { usePlayerOverlayPrefs } from './usePlayerOverlayPrefs';

export type { PlayerOverlayLive };

/**
 * Owns track picker, 2-level Settings menu, Stats HUD toggle, mobile Touch Lock, TV OSD
 * visibility/auto-hide, and TV OSD/scrubber focus state for {@link usePlayerControls}.
 */
export function usePlayerOverlayState(params: PlayerOverlayStateParams) {
  const { formFactor, itemKey, isVod, statusKind, tracks, hasTracks, hasService, showRetry } =
    params;
  const { hasSettings, hasNextEpisode, hasPreviousChannel, initialOsdHidden, autoHideOsdMs } =
    params;
  const { isScrubbing, clockRef, timersRef, cancelScrub } = params;
  const isTv = formFactor === 'tv';
  const canLock = formFactor === 'phone' || formFactor === 'tablet';
  const hasAspect = formFactor !== 'desktop';
  const hasDeinterlace = params.onSetDeinterlace !== undefined;

  const [rawTracksOpen, setTracksOpen] = useState(false);
  const [rawPickerCursor, setPickerCursor] = useState<TrackPickerCursor>({
    column: 'audio',
    index: 0,
  });
  const [rawSettingsOpen, setSettingsOpen] = useState(false);
  const [rawSettingsMenu, setSettingsMenu] = useState<SettingsMenuState>(() =>
    initialSettingsMenu(),
  );
  const { publicPrefs, acquireOrientationLock, releaseOrientationLock } = usePlayerOverlayPrefs({
    itemKey,
    hasService,
    onSetDeinterlace: params.onSetDeinterlace,
    onSetOrientationLocked: params.onSetOrientationLocked,
  });
  const [rawLocked, setLocked] = useState(false);
  const [rawOsdHidden, setOsdHidden] = useState(initialOsdHidden === true);
  const [tvOsdFocused, setTvOsdFocused] = useState(false);
  const [rawTvScrubberFocused, setTvScrubberFocused] = useState(false);
  const [rawTvOsdAction, setTvOsdAction] = useState<TvOsdAction>('playPause');

  const statusKindRef = useRef(statusKind);
  statusKindRef.current = statusKind;
  const sheetOpenerRef = useRef<'tracks' | 'settings' | null>(null);

  const tracksOpen = rawTracksOpen && hasTracks;
  const settingsOpen = rawSettingsOpen && hasService;
  const locked = canLock && rawLocked;
  const osdHidden = rawOsdHidden && !locked && !tracksOpen && !settingsOpen;
  const tvScrubberFocused =
    isTv && isVod && rawTvScrubberFocused && !locked && !tracksOpen && !settingsOpen && !osdHidden;
  const pickerCursor = clampPickerCursor(rawPickerCursor, tracks);
  const settingsMenu = clampSettingsMenu(rawSettingsMenu, tracks, {
    isVod,
    hasAspect,
    hasDeinterlace,
  });
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

  const { clearAutoHide, notifyOsdActivity } = useOsdAutoHide({
    autoHideOsdMs,
    active: canAutoHideOsd(statusKind, liveSnapshot, isScrubbing),
    itemKey,
    timersRef,
    onAutoHide: () => {
      liveRef.current.osdHidden = true;
      clearTvFocus();
      setOsdHidden(true);
    },
  });

  useEffect(() => {
    if (rawTracksOpen && !hasTracks) {
      sheetOpenerRef.current = null;
      setTracksOpen(false);
    } else if (tracksOpen && pickerCursor !== rawPickerCursor) setPickerCursor(pickerCursor);
    if (rawSettingsOpen && !hasService) {
      sheetOpenerRef.current = null;
      setSettingsOpen(false);
    } else if (settingsOpen && settingsMenu !== rawSettingsMenu) setSettingsMenu(settingsMenu);
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
    releaseOrientationLock();
    sheetOpenerRef.current = null;
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
      notifyOsdActivity();
      setOsdHidden(false);
    }
    return () => cancelScrub();
  }, [itemKey, cancelScrub, clearTvFocus, notifyOsdActivity, releaseOrientationLock]);

  useEffect(() => {
    if (statusKind === 'failed' || statusKind === 'paused' || statusKind === 'ended') {
      liveRef.current.osdHidden = false;
      notifyOsdActivity();
      setOsdHidden(false);
    }
  }, [notifyOsdActivity, statusKind]);

  const hideOsd = (): void => {
    cancelScrub();
    clearAutoHide();
    sheetOpenerRef.current = null;
    liveRef.current.osdHidden = true;
    clearTvFocus();
    setOsdHidden(true);
  };

  const showOsd = (): void => {
    notifyOsdActivity();
    liveRef.current.osdHidden = false;
    setOsdHidden(false);
  };

  const handleTouchActivity = (): void => hoverGuardRef.current?.markTouch();

  const handlePointerHover = (pointerType?: string, point?: PointerPoint): void => {
    if (!hoverGuardRef.current?.shouldAllowHover(pointerType, point)) return;
    if (liveRef.current.osdHidden) showOsd();
    else notifyOsdActivity();
  };

  const toggleOsdByTouch = (): void => {
    const s = liveRef.current;
    if (!canLock || s.locked || s.tracksOpen || s.settingsOpen) return;
    if (s.osdHidden) {
      showOsd();
      return;
    }
    if (statusKindRef.current === 'playing') hideOsd();
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

  const restoreSheetOpenerFocus = (): void => {
    const opener = sheetOpenerRef.current;
    sheetOpenerRef.current = null;
    if (isTv && opener !== null && liveRef.current.availableOsd.includes(opener)) {
      focusTvOsd(opener);
    }
  };

  const openTracks = (preferredColumn?: TrackPickerColumn): void => {
    if (!liveRef.current.hasTracks) return;
    cancelScrub();
    const initial = initialPickerCursor(liveRef.current.tracks, preferredColumn);
    sheetOpenerRef.current = isTv ? 'tracks' : null;
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

  const readSettingsOpts = () => ({
    isVod: liveRef.current.isVod,
    playbackSpeed: liveRef.current.playbackSpeed,
    hasAspect,
    hasDeinterlace,
  });

  const openSettings = (view: SettingsMenuView = 'root'): void => {
    if (!liveRef.current.hasService) return;
    cancelScrub();
    const opts = readSettingsOpts();
    const initial = clampSettingsMenu(
      initialSettingsMenu(view, opts),
      liveRef.current.tracks,
      opts,
    );
    sheetOpenerRef.current = isTv ? 'settings' : null;
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
    sheetOpenerRef.current = null;
    liveRef.current.tracksOpen = false;
    liveRef.current.settingsOpen = false;
    liveRef.current.locked = true;
    clearTvFocus();
    setTracksOpen(false);
    setSettingsOpen(false);
    setLocked(true);
    acquireOrientationLock();
  };

  const closeTracks = (): void => {
    if (!liveRef.current.tracksOpen) return;
    liveRef.current.tracksOpen = false;
    setTracksOpen(false);
    restoreSheetOpenerFocus();
  };
  const closeSettings = (): void => {
    if (!liveRef.current.settingsOpen) return;
    liveRef.current.settingsOpen = false;
    setSettingsOpen(false);
    restoreSheetOpenerFocus();
  };
  const openSettingsView = (view: SettingsMenuView): void => {
    const opts = readSettingsOpts();
    updateSettingsMenu(
      clampSettingsMenu(initialSettingsMenu(view, opts), liveRef.current.tracks, opts),
    );
  };
  const unlockControls = (): void => {
    liveRef.current.locked = false;
    setLocked(false);
    releaseOrientationLock();
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
    toggleResizeMode: publicPrefs.toggleResizeMode,
    toggleDeinterlace: publicPrefs.toggleDeinterlace,
    toggleStats: publicPrefs.toggleStats,
    unlockControls,
    publicState: {
      tracksOpen,
      pickerCursor,
      settingsOpen,
      settingsMenu,
      ...publicPrefs,
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
      lockControls,
      unlockControls,
      toggleOsdByTouch,
      handleTouchActivity,
      handlePointerHover,
    },
  };
}
