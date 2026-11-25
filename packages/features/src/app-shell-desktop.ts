import { resolveHardwareMultiViewCap } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveMultiViewCapabilities } from './player';
import type {
  DesktopWindowPort,
  PopoutDockPayload,
  PopoutLaunchPayload,
} from './ports/desktop-window-host';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { ThermalDevicePort, VideoHost } from './ports/video-host';

/** Builds a sanitized {@link PopoutLaunchPayload} from an active {@link PlayTarget} (`#158`). */
export function buildPopoutLaunchPayload(
  target: PlayTarget,
  positionMs?: number,
): PopoutLaunchPayload {
  const kind: PopoutLaunchPayload['kind'] =
    target.kind === 'live' ? 'live' : target.itemKind === 'episode' ? 'episode' : 'movie';
  const resumePositionMs =
    positionMs !== undefined && Number.isFinite(positionMs) && positionMs >= 0
      ? Math.round(positionMs)
      : target.startPositionMs;
  return {
    itemKey: target.itemKey,
    kind,
    title: target.title,
    ...(target.subtitle !== undefined && target.subtitle !== null
      ? { subtitle: target.subtitle }
      : {}),
    ...(target.logo !== undefined && target.logo !== null ? { logo: target.logo } : {}),
    sourceId: target.sourceId,
    ...(resumePositionMs !== undefined ? { resumePositionMs } : {}),
  };
}

/** Converts a docked {@link PopoutDockPayload} back into a {@link PlayTarget} for `AppShell` (`#158`). */
export function buildPlayTargetFromPopoutDock(payload: PopoutDockPayload): PlayTarget {
  return {
    itemKey: payload.itemKey,
    sourceId: payload.sourceId ?? '',
    title: payload.title,
    kind: payload.kind === 'live' ? 'live' : 'vod',
    itemKind: payload.kind,
    ...(payload.subtitle !== undefined ? { subtitle: payload.subtitle } : {}),
    ...(payload.logo !== undefined ? { logo: payload.logo } : {}),
    ...(payload.positionMs !== undefined && Number.isFinite(payload.positionMs)
      ? { startPositionMs: Math.max(0, Math.round(payload.positionMs)) }
      : {}),
  };
}

/** Options for {@link useShellPlaybackModes}. */
export interface UseShellPlaybackModesOptions {
  readonly desktopWindow?: DesktopWindowPort | undefined;
  readonly thermalDevice?: ThermalDevicePort | undefined;
  readonly videoHost: VideoHost;
  readonly playbackGuard: PlaybackGuard;
  readonly minimizeToTray: boolean;
  readonly backgroundAudioPlayback: boolean;
  readonly playTargetRef: MutableRefObject<PlayTarget | null>;
  readonly onStopActivePlayback: () => void;
  readonly onRequestPlay: (target: PlayTarget) => void;
}

/**
 * Coordinates Wave F6 shell playback modes (`#34`, `#158`, `#232`, `#233`):
 * floating corner mini-player state (`'full' | 'mini'`), Multi-View single-connection-safe handoff,
 * desktop minimize-to-tray sync & hidden-tray stream teardown, cursor restore on tray unhide, and
 * standalone Popout detach/dock handoff.
 */
export function useShellPlaybackModes({
  desktopWindow,
  thermalDevice,
  videoHost,
  playbackGuard,
  minimizeToTray,
  backgroundAudioPlayback,
  playTargetRef,
  onStopActivePlayback,
  onRequestPlay,
}: UseShellPlaybackModesOptions) {
  const [playerViewMode, setPlayerViewMode] = useState<'full' | 'mini'>('full');
  const [multiViewSeed, setMultiViewSeed] = useState<PlayTarget | null>(null);
  const [restoreCursorToken, setRestoreCursorToken] = useState(0);

  const bgAudioRef = useRef(backgroundAudioPlayback);
  bgAudioRef.current = backgroundAudioPlayback;
  const multiViewSeedRef = useRef(multiViewSeed);
  multiViewSeedRef.current = multiViewSeed;
  const stopActiveRef = useRef(onStopActivePlayback);
  stopActiveRef.current = onStopActivePlayback;
  const requestPlayRef = useRef(onRequestPlay);
  requestPlayRef.current = onRequestPlay;

  const multiViewSupported = useMemo(
    () => resolveHardwareMultiViewCap(resolveMultiViewCapabilities(thermalDevice, videoHost)) > 1,
    [thermalDevice, videoHost],
  );

  // Sync minimize-to-tray preference into Electron main process (#158).
  useEffect(() => {
    void desktopWindow?.setMinimizeToTray?.(minimizeToTray);
  }, [desktopWindow, minimizeToTray]);

  // Stop invisible active streams when hidden to tray unless background audio is enabled (#158).
  useEffect(() => {
    const sub = desktopWindow?.onHiddenToTray;
    if (sub === undefined) return;
    return sub(() => {
      if (bgAudioRef.current) return;
      if (playTargetRef.current !== null) {
        stopActiveRef.current();
        setPlayerViewMode('full');
      }
      if (multiViewSeedRef.current !== null) {
        setMultiViewSeed(null);
      }
    });
  }, [desktopWindow, playTargetRef]);

  // Trigger OSD/cursor visibility restore when main window returns from tray (#158).
  useEffect(() => {
    const sub = desktopWindow?.onWindowRestored;
    if (sub === undefined) return;
    return sub(() => {
      setRestoreCursorToken((v) => v + 1);
    });
  }, [desktopWindow]);

  // Re-open playTarget in main window when standalone Popout player docks (#158).
  useEffect(() => {
    const sub = desktopWindow?.onPopoutDocked;
    if (sub === undefined) return;
    return sub((payload) => {
      setMultiViewSeed(null);
      setPlayerViewMode('full');
      requestPlayRef.current(buildPlayTargetFromPopoutDock(payload));
    });
  }, [desktopWindow]);

  const minimizeToMiniPlayer = useCallback(() => {
    setPlayerViewMode('mini');
  }, []);

  const expandMiniPlayer = useCallback(() => {
    setPlayerViewMode('full');
  }, []);

  const resetToFullMode = useCallback(() => {
    setPlayerViewMode('full');
  }, []);

  const enterMultiView = useCallback(
    (target: PlayTarget) => {
      if (!multiViewSupported) return;
      setPlayerViewMode('full');
      void Promise.resolve(playbackGuard.stopIfUsingSource(target.sourceId))
        .catch(() => undefined)
        .finally(() => {
          stopActiveRef.current();
          void Promise.resolve().then(() => {
            setMultiViewSeed(target);
          });
        });
    },
    [multiViewSupported, playbackGuard],
  );

  const exitMultiView = useCallback((resumeTarget: PlayTarget | null) => {
    setMultiViewSeed(null);
    setPlayerViewMode('full');
    if (resumeTarget !== null) {
      requestPlayRef.current(resumeTarget);
    }
  }, []);

  const openPopout = desktopWindow?.openPopout;
  const popoutPlayer = useMemo(() => {
    if (openPopout === undefined) return undefined;
    return (target: PlayTarget, positionMs?: number) => {
      const payload = buildPopoutLaunchPayload(target, positionMs);
      setPlayerViewMode('full');
      void Promise.resolve(playbackGuard.stopIfUsingSource(target.sourceId))
        .catch(() => undefined)
        .then(() => {
          stopActiveRef.current();
          return Promise.resolve();
        })
        .then(() => openPopout(payload))
        .then((opened) => {
          if (!opened) {
            requestPlayRef.current(target);
          }
        })
        .catch(() => {
          requestPlayRef.current(target);
        });
    };
  }, [openPopout, playbackGuard]);

  return {
    playerViewMode,
    multiViewSeed,
    multiViewSupported,
    restoreCursorToken,
    minimizeToMiniPlayer,
    expandMiniPlayer,
    resetToFullMode,
    enterMultiView,
    exitMultiView,
    popoutPlayer,
  };
}

/** Return value of {@link useShellPlaybackModes}. */
export type ShellPlaybackModes = ReturnType<typeof useShellPlaybackModes>;
