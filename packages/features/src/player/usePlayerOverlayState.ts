import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canAutoHideOsd,
  type OsdTier,
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

type SheetOpener = 'tracks' | 'settings' | 'info' | 'channelList' | null;

/**
 * Owns track picker, 2-level Settings menu, Info sheet (`#58`), Channel drawer (`#57`),
 * Stats HUD toggle, mobile Touch Lock, 3-tier OSD visibility/auto-hide (`#391`), and TV focus state.
 */
export function usePlayerOverlayState(params: PlayerOverlayStateParams) {
  const { formFactor, itemKey, isVod, statusKind, tracks, hasTracks, hasService, showRetry } =
    params;
  const { hasSettings, hasNextEpisode, hasPreviousChannel, initialOsdHidden, autoHideOsdMs } =
    params;
  const { isScrubbing, clockRef, timersRef, cancelScrub } = params;
  const isTv = formFactor === 'tv';
  const canLock = formFactor === 'phone' || formFactor === 'tablet';
  const hasAspect = true;
  const hasDeinterlace = params.onSetDeinterlace !== undefined;
  const hasPitchLock = params.hasPitchLock === true;
  const hasAudioNormalization = params.hasAudioNormalization === true;
  const hasAutoSubtitlesOnSkipBack = params.hasAutoSubtitlesOnSkipBack === true;
  const hasAutoPlayNextEpisode = params.hasAutoPlayNextEpisode === true;
  const hasAudioDevice = params.hasAudioDevice === true;
  const audioDevices = params.audioDevices;
  const activeAudioDevice = params.activeAudioDevice;
  const hasAudioDelay = params.hasAudioDelay === true;
  const audioDelayMs = params.audioDelayMs;
  const hasSubtitleDelay = params.hasSubtitleDelay === true;
  const subtitleDelayMs = params.subtitleDelayMs;
  const hasVideoQuality =
    params.hasVideoQuality === true && (tracks.videoQualities?.length ?? 0) > 0;
  const selectedVideoQualityId = params.selectedVideoQualityId;
  const qualityVariants = params.qualityVariants;
  const hasQuality = !isVod && (qualityVariants?.length ?? 0) > 1;
  const hasVideoDecoder = params.hasVideoDecoder === true;
  const androidDecoderMode = params.androidDecoderMode;
  const chapters = params.chapters;
  const hasChapters = isVod && (chapters?.length ?? 0) > 0;
  const hasSleepTimer = params.hasSleepTimer === true;
  const sleepTimerMinutes = params.sleepTimerMinutes;
  const hasTimeDisplay = params.hasTimeDisplay === true;
  const hasAlwaysOnTop = params.hasAlwaysOnTop === true;
  const canOpenInfo = params.hasInfo !== false;
  const canOpenChannelList = !isVod && params.hasChannelList === true;

  const [rawTracksOpen, setTracksOpen] = useState(false);
  const [rawPickerCursor, setPickerCursor] = useState<TrackPickerCursor>({
    column: 'audio',
    index: 0,
  });
  const [rawSettingsOpen, setSettingsOpen] = useState(false);
  const [rawSettingsMenu, setSettingsMenu] = useState<SettingsMenuState>(() =>
    initialSettingsMenu(),
  );
  const [rawInfoOpen, setInfoOpen] = useState(false);
  const [rawChannelListOpen, setChannelListOpen] = useState(false);
  const { publicPrefs, acquireOrientationLock, releaseOrientationLock } = usePlayerOverlayPrefs({
    itemKey,
    hasService,
    defaultResizeMode: params.defaultResizeMode,
    onResizeModeChange: params.onResizeModeChange,
    onSetDeinterlace: params.onSetDeinterlace,
    onSetOrientationLocked: params.onSetOrientationLocked,
  });
  const [rawLocked, setLocked] = useState(false);
  const [rawOsdTier, setOsdTier] = useState<OsdTier>(
    initialOsdHidden === true ? 'hidden' : 'controls',
  );
  const [tvOsdFocused, setTvOsdFocused] = useState(false);
  const [rawTvScrubberFocused, setTvScrubberFocused] = useState(false);
  const [rawTvOsdAction, setTvOsdAction] = useState<TvOsdAction>('playPause');

  const statusKindRef = useRef(statusKind);
  statusKindRef.current = statusKind;
  const sheetOpenerRef = useRef<SheetOpener>(null);

  const tracksOpen = rawTracksOpen && hasTracks;
  const settingsOpen = rawSettingsOpen && hasService;
  const infoOpen = rawInfoOpen && canOpenInfo;
  const channelListOpen = rawChannelListOpen && canOpenChannelList;
  const locked = canLock && rawLocked;
  const anySheetOpen = tracksOpen || settingsOpen || infoOpen || channelListOpen;
  const osdTier: OsdTier = locked ? 'hidden' : anySheetOpen ? 'controls' : rawOsdTier;
  const osdHidden = osdTier === 'hidden';
  const tvScrubberFocused =
    isTv && isVod && rawTvScrubberFocused && !locked && !anySheetOpen && osdTier === 'controls';
  const pickerCursor = clampPickerCursor(rawPickerCursor, tracks);
  const settingsMenu = clampSettingsMenu(rawSettingsMenu, tracks, {
    isVod,
    hasAspect,
    hasDeinterlace,
    hasPitchLock,
    hasAudioNormalization,
    hasAutoSubtitlesOnSkipBack,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
    ...(audioDevices !== undefined ? { audioDevices } : {}),
    ...(activeAudioDevice !== undefined ? { activeAudioDevice } : {}),
    hasAudioDelay,
    ...(audioDelayMs !== undefined ? { audioDelayMs } : {}),
    hasSubtitleDelay,
    ...(subtitleDelayMs !== undefined ? { subtitleDelayMs } : {}),
    hasVideoQuality,
    ...(selectedVideoQualityId !== undefined ? { selectedVideoQualityId } : {}),
    hasQuality,
    ...(qualityVariants !== undefined ? { qualityVariants, activeQualityKey: itemKey } : {}),
    hasVideoDecoder,
    ...(androidDecoderMode !== undefined ? { androidDecoderMode } : {}),
    hasChapters,
    ...(chapters !== undefined ? { chapters } : {}),
    hasSleepTimer,
    ...(sleepTimerMinutes !== undefined ? { sleepTimerMinutes } : {}),
    hasTimeDisplay,
    hasInfo: canOpenInfo,
    hasAlwaysOnTop,
  });
  const availableOsd = availableTvOsdActions({
    isVod,
    hasService,
    hasTracks,
    showRetry,
    hasSettings,
    hasInfo: false,
    hasChannelList: params.hasChannelList === true,
    hasNextEpisode,
    hasPreviousChannel,
    ...(params.hasBackToLive === true ? { hasBackToLive: true } : {}),
    ...(params.liveTimeShiftSupported === true ? { liveTimeShiftSupported: true } : {}),
    ...(params.hasJumpToLive === true ? { hasJumpToLive: true } : {}),
  });
  const tvOsdAction = clampTvOsdAction(rawTvOsdAction, availableOsd);

  const liveSnapshot: PlayerOverlayLive = {
    tracksOpen,
    pickerCursor,
    settingsOpen,
    settingsMenu,
    infoOpen,
    channelListOpen,
    canOpenInfo,
    canOpenChannelList,
    locked,
    osdTier,
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
    osdTier,
    active: canAutoHideOsd(statusKind, liveSnapshot, isScrubbing),
    itemKey,
    timersRef,
    onAutoHide: () => {
      liveRef.current.osdTier = 'hidden';
      liveRef.current.osdHidden = true;
      clearTvFocus();
      setOsdTier('hidden');
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
    if (rawInfoOpen && !canOpenInfo) {
      sheetOpenerRef.current = null;
      setInfoOpen(false);
    }
    if (rawChannelListOpen && !canOpenChannelList) {
      sheetOpenerRef.current = null;
      setChannelListOpen(false);
    }
    if (rawTvScrubberFocused && (!isTv || !isVod)) setTvScrubberFocused(false);
    if (tvOsdAction !== rawTvOsdAction) setTvOsdAction(tvOsdAction);
  }, [
    canOpenChannelList,
    canOpenInfo,
    hasService,
    hasTracks,
    isTv,
    isVod,
    pickerCursor,
    rawChannelListOpen,
    rawInfoOpen,
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
    liveRef.current.infoOpen = false;
    liveRef.current.channelListOpen = false;
    liveRef.current.locked = false;
    clearTvFocus();
    setTracksOpen(false);
    setSettingsOpen(false);
    setInfoOpen(false);
    setChannelListOpen(false);
    setLocked(false);
    if (prevItemKeyRef.current !== itemKey) {
      prevItemKeyRef.current = itemKey;
      liveRef.current.osdTier = 'controls';
      liveRef.current.osdHidden = false;
      notifyOsdActivity();
      setOsdTier('controls');
    }
    return () => cancelScrub();
  }, [itemKey, cancelScrub, clearTvFocus, notifyOsdActivity, releaseOrientationLock]);

  useEffect(() => {
    if (statusKind === 'failed' || statusKind === 'paused' || statusKind === 'ended') {
      liveRef.current.osdTier = 'controls';
      liveRef.current.osdHidden = false;
      notifyOsdActivity();
      setOsdTier('controls');
    }
  }, [notifyOsdActivity, statusKind]);

  const hideOsd = (): void => {
    cancelScrub();
    clearAutoHide();
    sheetOpenerRef.current = null;
    liveRef.current.osdTier = 'hidden';
    liveRef.current.osdHidden = true;
    clearTvFocus();
    setOsdTier('hidden');
  };

  const showControlsOsd = (): void => {
    notifyOsdActivity();
    liveRef.current.osdTier = 'controls';
    liveRef.current.osdHidden = false;
    setOsdTier('controls');
  };

  const showProgressOsd = (): void => {
    if (liveRef.current.locked) return;
    notifyOsdActivity();
    if (liveRef.current.osdTier === 'controls') return;
    liveRef.current.osdTier = 'progress';
    liveRef.current.osdHidden = false;
    setOsdTier('progress');
  };

  const showOsd = showControlsOsd;

  const handleTouchActivity = (): void => hoverGuardRef.current?.markTouch();

  const handlePointerHover = (pointerType?: string, point?: PointerPoint): void => {
    if (!hoverGuardRef.current?.shouldAllowHover(pointerType, point)) return;
    if (liveRef.current.osdTier !== 'controls') showControlsOsd();
    else notifyOsdActivity();
  };

  const toggleOsdByTouch = (): void => {
    const s = liveRef.current;
    if (!canLock || s.locked || s.tracksOpen || s.settingsOpen || s.infoOpen || s.channelListOpen) {
      return;
    }
    if (s.osdTier !== 'controls') {
      showControlsOsd();
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

  const setExclusiveSheet = (target: Exclude<SheetOpener, null>, opener: SheetOpener): void => {
    cancelScrub();
    sheetOpenerRef.current = opener;
    liveRef.current.tracksOpen = target === 'tracks';
    liveRef.current.settingsOpen = target === 'settings';
    liveRef.current.infoOpen = target === 'info';
    liveRef.current.channelListOpen = target === 'channelList';
    liveRef.current.osdTier = 'controls';
    liveRef.current.osdHidden = false;
    clearTvFocus();
    setTracksOpen(target === 'tracks');
    setSettingsOpen(target === 'settings');
    setInfoOpen(target === 'info');
    setChannelListOpen(target === 'channelList');
    setOsdTier('controls');
  };

  const openTracks = (preferredColumn?: TrackPickerColumn): void => {
    if (!liveRef.current.hasTracks) return;
    const initial = initialPickerCursor(liveRef.current.tracks, preferredColumn);
    liveRef.current.pickerCursor = initial;
    setPickerCursor(initial);
    setExclusiveSheet('tracks', isTv ? 'tracks' : null);
  };

  const readSettingsOpts = () => ({
    isVod: liveRef.current.isVod,
    playbackSpeed: liveRef.current.playbackSpeed,
    hasAspect,
    hasDeinterlace,
    hasPitchLock,
    hasAudioNormalization,
    hasAutoSubtitlesOnSkipBack,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
    ...(audioDevices !== undefined ? { audioDevices } : {}),
    ...(activeAudioDevice !== undefined ? { activeAudioDevice } : {}),
    hasAudioDelay,
    ...(audioDelayMs !== undefined ? { audioDelayMs } : {}),
    hasSubtitleDelay,
    ...(subtitleDelayMs !== undefined ? { subtitleDelayMs } : {}),
    hasVideoQuality,
    ...(selectedVideoQualityId !== undefined ? { selectedVideoQualityId } : {}),
    hasQuality,
    ...(qualityVariants !== undefined ? { qualityVariants, activeQualityKey: itemKey } : {}),
    hasVideoDecoder,
    ...(androidDecoderMode !== undefined ? { androidDecoderMode } : {}),
    hasChapters,
    ...(chapters !== undefined ? { chapters } : {}),
    hasSleepTimer,
    ...(sleepTimerMinutes !== undefined ? { sleepTimerMinutes } : {}),
    hasTimeDisplay,
    hasInfo: canOpenInfo,
    hasAlwaysOnTop,
  });

  const openSettings = (view: SettingsMenuView = 'root'): void => {
    if (!liveRef.current.hasService) return;
    const opts = readSettingsOpts();
    const initial = clampSettingsMenu(
      initialSettingsMenu(view, opts),
      liveRef.current.tracks,
      opts,
    );
    liveRef.current.settingsMenu = initial;
    setSettingsMenu(initial);
    setExclusiveSheet('settings', isTv ? 'settings' : null);
  };

  const openInfo = (): void => {
    if (!liveRef.current.canOpenInfo) return;
    setExclusiveSheet('info', isTv ? 'info' : null);
  };

  const openChannelList = (): void => {
    if (!liveRef.current.canOpenChannelList) return;
    setExclusiveSheet('channelList', isTv ? 'channelList' : null);
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

  const closeInfo = (): void => {
    if (!liveRef.current.infoOpen) return;
    liveRef.current.infoOpen = false;
    setInfoOpen(false);
    restoreSheetOpenerFocus();
  };

  const closeChannelList = (): void => {
    if (!liveRef.current.channelListOpen) return;
    liveRef.current.channelListOpen = false;
    setChannelListOpen(false);
    restoreSheetOpenerFocus();
  };

  const toggleInfo = (): void => {
    if (liveRef.current.infoOpen) closeInfo();
    else openInfo();
  };

  const toggleChannelList = (): void => {
    if (liveRef.current.channelListOpen) closeChannelList();
    else openChannelList();
  };

  const openSettingsView = (view: SettingsMenuView): void => {
    const opts = readSettingsOpts();
    updateSettingsMenu(
      clampSettingsMenu(initialSettingsMenu(view, opts), liveRef.current.tracks, opts),
    );
  };

  const lockControls = (): void => {
    if (!canLock) return;
    cancelScrub();
    sheetOpenerRef.current = null;
    liveRef.current.tracksOpen = false;
    liveRef.current.settingsOpen = false;
    liveRef.current.infoOpen = false;
    liveRef.current.channelListOpen = false;
    liveRef.current.locked = true;
    liveRef.current.osdTier = 'hidden';
    liveRef.current.osdHidden = true;
    clearTvFocus();
    setTracksOpen(false);
    setSettingsOpen(false);
    setInfoOpen(false);
    setChannelListOpen(false);
    setLocked(true);
    acquireOrientationLock();
  };

  const unlockControls = (): void => {
    liveRef.current.locked = false;
    liveRef.current.osdTier = 'controls';
    liveRef.current.osdHidden = false;
    setLocked(false);
    setOsdTier('controls');
    notifyOsdActivity();
    releaseOrientationLock();
  };

  return {
    liveRef,
    hideOsd,
    showOsd,
    showProgressOsd,
    showControlsOsd,
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
    openInfo,
    closeInfo,
    toggleInfo,
    openChannelList,
    closeChannelList,
    toggleChannelList,
    toggleResizeMode: publicPrefs.toggleResizeMode,
    toggleDeinterlace: publicPrefs.toggleDeinterlace,
    toggleStats: publicPrefs.toggleStats,
    unlockControls,
    publicState: {
      tracksOpen,
      pickerCursor,
      settingsOpen,
      settingsMenu,
      infoOpen,
      channelListOpen,
      ...publicPrefs,
      canLock,
      locked,
      osdTier,
      osdHidden,
      tvOsdFocused,
      tvScrubberFocused,
      tvOsdAction,
      showProgressOsd,
      showControlsOsd,
      showOsd,
      hideOsd,
      openTracks,
      closeTracks,
      openSettings,
      closeSettings,
      openSettingsView,
      openInfo,
      closeInfo,
      toggleInfo,
      openChannelList,
      closeChannelList,
      toggleChannelList,
      lockControls,
      unlockControls,
      toggleOsdByTouch,
      handleTouchActivity,
      handlePointerHover,
    },
  };
}
