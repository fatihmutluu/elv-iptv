import type { MediaTracks } from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import { useEffect, useRef, useState } from 'react';
import {
  clampSettingsMenu,
  initialSettingsMenu,
  type SettingsMenuState,
  type SettingsMenuView,
} from './settings-menu-nav';
import { clampPickerCursor, initialPickerCursor, type TrackPickerCursor } from './track-picker-nav';
import { availableTvOsdActions, clampTvOsdAction, type TvOsdAction } from './tv-osd-nav';

/** Live mutable snapshot shared with synchronous key handlers in {@link usePlayerControls}. */
export interface PlayerOverlayLive {
  tracksOpen: boolean;
  pickerCursor: TrackPickerCursor;
  settingsOpen: boolean;
  settingsMenu: SettingsMenuState;
  locked: boolean;
  tvOsdFocused: boolean;
  tvOsdAction: TvOsdAction;
  availableOsd: TvOsdAction[];
  tracks: MediaTracks;
  hasTracks: boolean;
  hasService: boolean;
}

/**
 * Owns track picker, 2-level Settings menu, Stats HUD toggle, mobile Touch Lock, and TV OSD
 * focus state for {@link usePlayerControls}, resetting overlays and lock on item changes.
 */
export function usePlayerOverlayState(params: {
  formFactor: FormFactor;
  itemKey: string;
  isVod: boolean;
  tracks: MediaTracks;
  hasTracks: boolean;
  hasService: boolean;
  showRetry: boolean;
  hasSettings: boolean;
  hasNextEpisode: boolean;
  hasPreviousChannel: boolean;
  cancelScrub: () => void;
}) {
  const { formFactor, itemKey, isVod, tracks, hasTracks, hasService, showRetry } = params;
  const { hasSettings, hasNextEpisode, hasPreviousChannel, cancelScrub } = params;
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
  const [tvOsdFocused, setTvOsdFocused] = useState(false);
  const [rawTvOsdAction, setTvOsdAction] = useState<TvOsdAction>('playPause');

  const tracksOpen = rawTracksOpen && hasTracks;
  const settingsOpen = rawSettingsOpen && hasService;
  const locked = canLock && rawLocked;
  const pickerCursor = clampPickerCursor(rawPickerCursor, tracks);
  const settingsMenu = clampSettingsMenu(rawSettingsMenu, tracks);
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

  const liveRef = useRef<PlayerOverlayLive>({
    tracksOpen,
    pickerCursor,
    settingsOpen,
    settingsMenu,
    locked,
    tvOsdFocused,
    tvOsdAction,
    availableOsd,
    tracks,
    hasTracks,
    hasService,
  });
  liveRef.current = {
    tracksOpen,
    pickerCursor,
    settingsOpen,
    settingsMenu,
    locked,
    tvOsdFocused,
    tvOsdAction,
    availableOsd,
    tracks,
    hasTracks,
    hasService,
  };

  useEffect(() => {
    if (rawTracksOpen && !hasTracks) setTracksOpen(false);
    else if (tracksOpen && pickerCursor !== rawPickerCursor) setPickerCursor(pickerCursor);
    if (rawSettingsOpen && !hasService) setSettingsOpen(false);
    else if (settingsOpen && settingsMenu !== rawSettingsMenu) setSettingsMenu(settingsMenu);
    if (tvOsdAction !== rawTvOsdAction) setTvOsdAction(tvOsdAction);
  }, [
    hasService,
    hasTracks,
    pickerCursor,
    rawPickerCursor,
    rawSettingsMenu,
    rawSettingsOpen,
    rawTracksOpen,
    rawTvOsdAction,
    settingsMenu,
    settingsOpen,
    tracksOpen,
    tvOsdAction,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset overlays, lock & scrub on item change/unmount
  useEffect(() => {
    cancelScrub();
    liveRef.current.tracksOpen = false;
    liveRef.current.settingsOpen = false;
    liveRef.current.locked = false;
    liveRef.current.tvOsdFocused = false;
    setTracksOpen(false);
    setSettingsOpen(false);
    setLocked(false);
    setTvOsdFocused(false);
    return () => cancelScrub();
  }, [itemKey, cancelScrub]);

  const blurTvOsd = (): void => {
    liveRef.current.tvOsdFocused = false;
    setTvOsdFocused(false);
  };

  const focusTvOsd = (action: TvOsdAction): void => {
    liveRef.current.tvOsdAction = action;
    liveRef.current.tvOsdFocused = true;
    setTvOsdAction(action);
    setTvOsdFocused(true);
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
    liveRef.current.tvOsdFocused = false;
    setPickerCursor(initial);
    setSettingsOpen(false);
    setTvOsdFocused(false);
    setTracksOpen(true);
  };

  const closeTracks = (): void => {
    liveRef.current.tracksOpen = false;
    setTracksOpen(false);
  };

  const openSettings = (view: SettingsMenuView = 'root'): void => {
    if (!liveRef.current.hasService) return;
    cancelScrub();
    const initial = clampSettingsMenu(initialSettingsMenu(view), liveRef.current.tracks);
    liveRef.current.settingsMenu = initial;
    liveRef.current.settingsOpen = true;
    liveRef.current.tracksOpen = false;
    liveRef.current.tvOsdFocused = false;
    setSettingsMenu(initial);
    setTracksOpen(false);
    setTvOsdFocused(false);
    setSettingsOpen(true);
  };

  const closeSettings = (): void => {
    liveRef.current.settingsOpen = false;
    setSettingsOpen(false);
  };

  const openSettingsView = (view: SettingsMenuView): void => {
    updateSettingsMenu(clampSettingsMenu(initialSettingsMenu(view), liveRef.current.tracks));
  };

  const toggleStats = (): void => {
    setStatsVisible((prev) => !prev);
  };

  const lockControls = (): void => {
    if (!canLock) return;
    cancelScrub();
    liveRef.current.tracksOpen = false;
    liveRef.current.settingsOpen = false;
    liveRef.current.tvOsdFocused = false;
    liveRef.current.locked = true;
    setTracksOpen(false);
    setSettingsOpen(false);
    setTvOsdFocused(false);
    setLocked(true);
  };

  const unlockControls = (): void => {
    liveRef.current.locked = false;
    setLocked(false);
  };

  return {
    liveRef,
    tracksOpen,
    pickerCursor,
    settingsOpen,
    settingsMenu,
    statsVisible,
    canLock,
    locked,
    tvOsdFocused,
    tvOsdAction,
    blurTvOsd,
    focusTvOsd,
    updatePickerCursor,
    updateSettingsMenu,
    openTracks,
    closeTracks,
    openSettings,
    closeSettings,
    openSettingsView,
    toggleStats,
    lockControls,
    unlockControls,
  };
}
