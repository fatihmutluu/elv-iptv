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
import { availableTvOsdActions, clampTvOsdAction, type TvOsdAction } from './tv-osd-nav';
import { useOsdAutoHide } from './useOsdAutoHide';
import { usePlayerOverlayPrefs } from './usePlayerOverlayPrefs';

export type { PlayerOverlayLive };

type SheetOpener = 'subtitles' | 'audio' | 'settings' | 'channelList' | null;

/**
 * Owns 2-level Settings menu, desktop Window Mode popover, Channel drawer (`#57`),
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
  const hasPitchLock = isVod && params.hasPitchLock === true;
  const hasAudioNormalization = params.hasAudioNormalization === true;
  const hasAutoPlayNextEpisode = isVod && params.hasAutoPlayNextEpisode === true;
  const hasAudioDevice = params.hasAudioDevice === true;
  const audioDevices = params.audioDevices;
  const activeAudioDevice = params.activeAudioDevice;
  const hasAudioDelay = params.hasAudioDelay === true;
  const audioDelayMs = params.audioDelayMs;
  const hasSubtitleDelay = params.hasSubtitleDelay === true;
  const subtitleDelayMs = params.subtitleDelayMs;
  const hasSubtitleStyle = params.hasSubtitleStyle === true;
  const hasDualSubtitles = params.hasDualSubtitles === true;
  const canPickSubtitleFile = params.canPickSubtitleFile === true;
  const canLoadSubtitleUrl = params.canLoadSubtitleUrl === true;
  const hasVideoQuality =
    params.hasVideoQuality === true && (tracks.videoQualities?.length ?? 0) > 1;
  const selectedVideoQualityId = params.selectedVideoQualityId;
  const qualityVariants = params.qualityVariants;
  const hasQuality = !isVod && (qualityVariants?.length ?? 0) > 1;
  const hasVideoDecoder = params.hasVideoDecoder === true;
  const androidDecoderMode = params.androidDecoderMode;
  const hasSleepTimer = params.hasSleepTimer === true;
  const sleepTimerMinutes = params.sleepTimerMinutes;
  const hasPip = params.hasPip === true;
  const hasMultiView = params.hasMultiView === true;
  const hasWindowModeMenu = params.hasWindowModeMenu === true;
  const canOpenChannelList = !isVod && params.hasChannelList === true;

  const hasSubtitlesAction = hasTracks;
  const hasAudioAction =
    hasTracks &&
    (tracks.audio.length > 0 ||
      (tracks.programs?.length ?? 0) > 1 ||
      tracks.subtitles.length === 0);

  const [rawSettingsOpen, setSettingsOpen] = useState(false);
  const [rawSettingsMenu, setSettingsMenu] = useState<SettingsMenuState>(() =>
    initialSettingsMenu(),
  );
  const [rawWindowModeOpen, setWindowModeOpen] = useState(false);
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

  const effectiveResetKey = params.resetKey ?? itemKey;
  const canFocusScrubber = isVod || params.liveTimeShiftSupported === true;
  const settingsOpen = rawSettingsOpen && hasService;
  const windowModeOpen = rawWindowModeOpen && hasService && hasWindowModeMenu;
  const channelListOpen = rawChannelListOpen && canOpenChannelList;
  const locked = canLock && rawLocked;
  const anySheetOpen = settingsOpen || windowModeOpen || channelListOpen;
  const osdTier: OsdTier = locked ? 'hidden' : anySheetOpen ? 'controls' : rawOsdTier;
  const osdHidden = osdTier === 'hidden';
  const tvScrubberFocused =
    isTv &&
    canFocusScrubber &&
    rawTvScrubberFocused &&
    !locked &&
    !anySheetOpen &&
    osdTier === 'controls';

  const settingsOptsBag = {
    isVod,
    hasAspect,
    hasDeinterlace,
    hasPitchLock,
    hasAudioNormalization,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
    ...(audioDevices !== undefined ? { audioDevices } : {}),
    ...(activeAudioDevice !== undefined ? { activeAudioDevice } : {}),
    hasAudioDelay,
    ...(audioDelayMs !== undefined ? { audioDelayMs } : {}),
    hasSubtitleDelay,
    ...(subtitleDelayMs !== undefined ? { subtitleDelayMs } : {}),
    hasSubtitleStyle,
    hasDualSubtitles,
    canPickSubtitleFile,
    canLoadSubtitleUrl,
    hasVideoQuality,
    ...(selectedVideoQualityId !== undefined ? { selectedVideoQualityId } : {}),
    hasQuality,
    ...(qualityVariants !== undefined ? { qualityVariants, activeQualityKey: itemKey } : {}),
    hasVideoDecoder,
    ...(androidDecoderMode !== undefined ? { androidDecoderMode } : {}),
    hasSleepTimer,
    ...(sleepTimerMinutes !== undefined ? { sleepTimerMinutes } : {}),
    hasPip,
    hasMultiView,
  };

  const settingsMenu = clampSettingsMenu(rawSettingsMenu, tracks, settingsOptsBag);
  const availableOsd = availableTvOsdActions({
    isVod,
    hasService,
    hasSubtitles: hasSubtitlesAction,
    hasAudio: hasAudioAction,
    showRetry,
    hasSettings,
    hasChannelList: params.hasChannelList === true,
    hasNextEpisode,
    hasPreviousChannel,
    ...(params.hasBackToLive === true ? { hasBackToLive: true } : {}),
    ...(params.liveTimeShiftSupported === true ? { liveTimeShiftSupported: true } : {}),
    ...(params.hasJumpToLive === true ? { hasJumpToLive: true } : {}),
  });
  const tvOsdAction = clampTvOsdAction(rawTvOsdAction, availableOsd);

  const liveSnapshot: PlayerOverlayLive = {
    settingsOpen,
    settingsMenu,
    windowModeOpen,
    channelListOpen,
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
  const prevResetKeyRef = useRef(effectiveResetKey);
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
    itemKey: effectiveResetKey,
    timersRef,
    onAutoHide: () => {
      liveRef.current.osdTier = 'hidden';
      liveRef.current.osdHidden = true;
      clearTvFocus();
      setOsdTier('hidden');
    },
  });

  useEffect(() => {
    if (rawSettingsOpen && !hasService) {
      sheetOpenerRef.current = null;
      setSettingsOpen(false);
    } else if (settingsOpen && settingsMenu !== rawSettingsMenu) setSettingsMenu(settingsMenu);
    if (rawWindowModeOpen && (!hasService || !hasWindowModeMenu)) {
      sheetOpenerRef.current = null;
      setWindowModeOpen(false);
    }
    if (rawChannelListOpen && !canOpenChannelList) {
      sheetOpenerRef.current = null;
      setChannelListOpen(false);
    }
    if (rawTvScrubberFocused && (!isTv || !canFocusScrubber)) setTvScrubberFocused(false);
    if (tvOsdAction !== rawTvOsdAction) setTvOsdAction(tvOsdAction);
  }, [
    canFocusScrubber,
    canOpenChannelList,
    hasService,
    hasWindowModeMenu,
    isTv,
    rawChannelListOpen,
    rawSettingsMenu,
    rawSettingsOpen,
    rawTvOsdAction,
    rawTvScrubberFocused,
    rawWindowModeOpen,
    settingsMenu,
    settingsOpen,
    tvOsdAction,
  ]);

  useEffect(() => {
    cancelScrub();
    releaseOrientationLock();
    sheetOpenerRef.current = null;
    liveRef.current.settingsOpen = false;
    liveRef.current.windowModeOpen = false;
    liveRef.current.channelListOpen = false;
    liveRef.current.locked = false;
    clearTvFocus();
    setSettingsOpen(false);
    setWindowModeOpen(false);
    setChannelListOpen(false);
    setLocked(false);
    if (prevResetKeyRef.current !== effectiveResetKey) {
      prevResetKeyRef.current = effectiveResetKey;
      liveRef.current.osdTier = 'controls';
      liveRef.current.osdHidden = false;
      notifyOsdActivity();
      setOsdTier('controls');
    }
    return () => cancelScrub();
  }, [effectiveResetKey, cancelScrub, clearTvFocus, notifyOsdActivity, releaseOrientationLock]);

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
    if (!canLock || s.locked || s.settingsOpen || s.windowModeOpen || s.channelListOpen) {
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

  const setExclusiveSheet = (
    target: 'settings' | 'windowMode' | 'channelList',
    opener: SheetOpener,
  ): void => {
    cancelScrub();
    sheetOpenerRef.current = opener;
    liveRef.current.settingsOpen = target === 'settings';
    liveRef.current.windowModeOpen = target === 'windowMode';
    liveRef.current.channelListOpen = target === 'channelList';
    liveRef.current.osdTier = 'controls';
    liveRef.current.osdHidden = false;
    clearTvFocus();
    setSettingsOpen(target === 'settings');
    setWindowModeOpen(target === 'windowMode');
    setChannelListOpen(target === 'channelList');
    setOsdTier('controls');
  };

  const readSettingsOpts = () => ({
    isVod: liveRef.current.isVod,
    playbackSpeed: liveRef.current.playbackSpeed,
    hasAspect,
    hasDeinterlace,
    hasPitchLock,
    hasAudioNormalization,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
    ...(audioDevices !== undefined ? { audioDevices } : {}),
    ...(activeAudioDevice !== undefined ? { activeAudioDevice } : {}),
    hasAudioDelay,
    ...(audioDelayMs !== undefined ? { audioDelayMs } : {}),
    hasSubtitleDelay,
    ...(subtitleDelayMs !== undefined ? { subtitleDelayMs } : {}),
    hasSubtitleStyle,
    hasDualSubtitles,
    canPickSubtitleFile,
    canLoadSubtitleUrl,
    hasVideoQuality,
    ...(selectedVideoQualityId !== undefined ? { selectedVideoQualityId } : {}),
    hasQuality,
    ...(qualityVariants !== undefined ? { qualityVariants, activeQualityKey: itemKey } : {}),
    hasVideoDecoder,
    ...(androidDecoderMode !== undefined ? { androidDecoderMode } : {}),
    hasSleepTimer,
    ...(sleepTimerMinutes !== undefined ? { sleepTimerMinutes } : {}),
    hasPip,
    hasMultiView,
  });

  const openSettings = (view: SettingsMenuView = 'root', opener?: SheetOpener): void => {
    if (!liveRef.current.hasService) return;
    const opts = readSettingsOpts();
    const initial = clampSettingsMenu(
      initialSettingsMenu(view, opts, liveRef.current.tracks),
      liveRef.current.tracks,
      opts,
    );
    liveRef.current.settingsMenu = initial;
    setSettingsMenu(initial);
    const resolvedOpener: SheetOpener =
      opener !== undefined
        ? opener
        : isTv
          ? view === 'subtitles' || view === 'subtitleSettings'
            ? 'subtitles'
            : view === 'audio' || view === 'audioSettings'
              ? 'audio'
              : 'settings'
          : null;
    setExclusiveSheet('settings', resolvedOpener);
  };

  const openWindowMode = (): void => {
    if (!liveRef.current.hasService || !hasWindowModeMenu) return;
    setExclusiveSheet('windowMode', null);
  };

  const openChannelList = (): void => {
    if (!liveRef.current.canOpenChannelList) return;
    setExclusiveSheet('channelList', isTv ? 'channelList' : null);
  };

  const closeSettings = (): void => {
    if (!liveRef.current.settingsOpen) return;
    liveRef.current.settingsOpen = false;
    setSettingsOpen(false);
    restoreSheetOpenerFocus();
  };

  const closeWindowMode = (): void => {
    if (!liveRef.current.windowModeOpen) return;
    liveRef.current.windowModeOpen = false;
    setWindowModeOpen(false);
  };

  const closeChannelList = (): void => {
    if (!liveRef.current.channelListOpen) return;
    liveRef.current.channelListOpen = false;
    setChannelListOpen(false);
    restoreSheetOpenerFocus();
  };

  const toggleWindowMode = (): void => {
    if (liveRef.current.windowModeOpen) closeWindowMode();
    else openWindowMode();
  };

  const toggleChannelList = (): void => {
    if (liveRef.current.channelListOpen) closeChannelList();
    else openChannelList();
  };

  const openSettingsView = (view: SettingsMenuView): void => {
    const opts = readSettingsOpts();
    updateSettingsMenu(
      clampSettingsMenu(
        initialSettingsMenu(view, opts, liveRef.current.tracks),
        liveRef.current.tracks,
        opts,
      ),
    );
  };

  const lockControls = (): void => {
    if (!canLock) return;
    cancelScrub();
    sheetOpenerRef.current = null;
    liveRef.current.settingsOpen = false;
    liveRef.current.windowModeOpen = false;
    liveRef.current.channelListOpen = false;
    liveRef.current.locked = true;
    liveRef.current.osdTier = 'hidden';
    liveRef.current.osdHidden = true;
    clearTvFocus();
    setSettingsOpen(false);
    setWindowModeOpen(false);
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
    updateSettingsMenu,
    openSettings,
    closeSettings,
    openWindowMode,
    closeWindowMode,
    toggleWindowMode,
    openChannelList,
    closeChannelList,
    toggleChannelList,
    toggleResizeMode: publicPrefs.toggleResizeMode,
    toggleDeinterlace: publicPrefs.toggleDeinterlace,
    toggleStats: publicPrefs.toggleStats,
    unlockControls,
    publicState: {
      settingsOpen,
      settingsMenu,
      windowModeOpen,
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
      openSettings,
      closeSettings,
      openSettingsView,
      openWindowMode,
      closeWindowMode,
      toggleWindowMode,
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
