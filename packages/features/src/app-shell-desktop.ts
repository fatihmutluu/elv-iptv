import type { DownloadManagerPort } from '@elv/domain';
import { resolveHardwareMultiViewCap } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveMultiViewCapabilities } from './player';
import type {
  DesktopWindowPort,
  PopoutDockPayload,
  PopoutLaunchPayload,
} from './ports/desktop-window-host';
import type { PlayTarget } from './ports/play-target';
import type { AdoptedPlaybackSession, ThermalDevicePort, VideoHost } from './ports/video-host';

/** Builds a sanitized {@link PopoutLaunchPayload} from an active {@link PlayTarget} (`#158`, `Wave P3`). */
export function buildPopoutLaunchPayload(
  target: PlayTarget,
  positionMs?: number,
  transferEngineId?: string,
): PopoutLaunchPayload {
  const kind: PopoutLaunchPayload['kind'] =
    target.kind === 'live' ? 'live' : target.itemKind === 'episode' ? 'episode' : 'movie';
  const resumePositionMs =
    positionMs !== undefined && Number.isFinite(positionMs) && positionMs >= 0
      ? Math.round(positionMs)
      : target.startPositionMs;
  const trimmedTransferId = transferEngineId?.trim();
  const offlineUri =
    target.isLocalOffline === true &&
    typeof target.localFileUri === 'string' &&
    target.localFileUri.trim().length > 0
      ? target.localFileUri.trim()
      : undefined;
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
    ...(trimmedTransferId !== undefined && trimmedTransferId.length > 0
      ? { transferEngineId: trimmedTransferId }
      : {}),
    ...(offlineUri !== undefined ? { isLocalOffline: true, localFileUri: offlineUri } : {}),
  };
}

/** Converts a docked {@link PopoutDockPayload} back into a {@link PlayTarget} for `AppShell` (`#158`). */
export function buildPlayTargetFromPopoutDock(payload: PopoutDockPayload): PlayTarget {
  const offlineUri =
    payload.isLocalOffline === true &&
    typeof payload.localFileUri === 'string' &&
    payload.localFileUri.trim().length > 0
      ? payload.localFileUri.trim()
      : undefined;
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
    ...(offlineUri !== undefined ? { isLocalOffline: true, localFileUri: offlineUri } : {}),
  };
}

function disposeAdoptedSession(session: AdoptedPlaybackSession): void {
  try {
    session.service.stop();
    session.service.dispose();
  } finally {
    session.opened.engine.release();
  }
}

/** Options for {@link useShellPlaybackModes}. */
export interface UseShellPlaybackModesOptions {
  readonly desktopWindow?: DesktopWindowPort | undefined;
  readonly thermalDevice?: ThermalDevicePort | undefined;
  readonly downloadManager?: DownloadManagerPort | undefined;
  readonly videoHost: VideoHost;
  readonly stopActivePlayerRef: MutableRefObject<(() => Promise<void>) | null>;
  readonly stopEmbeddedPreviewRef?: MutableRefObject<(() => Promise<void>) | null> | undefined;
  readonly minimizeToTray: boolean;
  readonly backgroundAudioPlayback: boolean;
  readonly playTarget?: PlayTarget | null;
  readonly liveEmbeddedPlaybackActive?: boolean;
  readonly playTargetRef: MutableRefObject<PlayTarget | null>;
  readonly onStopActivePlayback: () => void;
  readonly onRequestPlay: (target: PlayTarget) => void;
  /** Direct play setter for zero-reload handoffs (0 new connections), bypassing connection limit & external player interception (`Wave P3`). */
  readonly onAdoptPlay?: ((target: PlayTarget) => void) | undefined;
}

function runAfterEmbeddedPreview(
  stopEmbeddedPreviewRef: MutableRefObject<(() => Promise<void>) | null> | undefined,
  action: () => void,
): void {
  const stopPreview = stopEmbeddedPreviewRef?.current;
  if (stopPreview != null) {
    void Promise.resolve(stopPreview())
      .catch(() => undefined)
      .finally(action);
    return;
  }
  action();
}

/**
 * Coordinates Wave F6 & Wave P3 shell playback modes (`#34`, `#158`, `#232`, `#233`):
 * floating corner mini-player state (`'full' | 'mini'`), zero-reload Multi-View handoff,
 * desktop minimize-to-tray sync & hidden-tray stream teardown, cursor restore on tray unhide, and
 * zero-reload standalone Popout detach/dock handoff via `transferEngineId`.
 */
export function useShellPlaybackModes({
  desktopWindow,
  thermalDevice,
  downloadManager,
  videoHost,
  stopActivePlayerRef,
  stopEmbeddedPreviewRef,
  minimizeToTray,
  backgroundAudioPlayback,
  playTarget = null,
  liveEmbeddedPlaybackActive = false,
  playTargetRef,
  onStopActivePlayback,
  onRequestPlay,
  onAdoptPlay,
}: UseShellPlaybackModesOptions) {
  const [playerViewMode, setPlayerViewMode] = useState<'full' | 'mini'>('full');
  const [multiViewSeed, setMultiViewSeed] = useState<PlayTarget | null>(null);
  const [multiViewHasOnlineStream, setMultiViewHasOnlineStream] = useState<boolean | null>(null);
  const [multiViewAdoptedSession, setMultiViewAdoptedSession] =
    useState<AdoptedPlaybackSession | null>(null);
  const [pendingAdoptedSession, setPendingAdoptedSession] = useState<AdoptedPlaybackSession | null>(
    null,
  );
  const [pendingAdoptEngineId, setPendingAdoptEngineId] = useState<string | undefined>(undefined);
  const [playerHandoffKey, setPlayerHandoffKey] = useState(0);
  const [restoreCursorToken, setRestoreCursorToken] = useState(0);
  const lastPopoutTargetRef = useRef<PlayTarget | null>(null);

  const consumedAdoptedRef = useRef(new WeakSet<AdoptedPlaybackSession>());
  const markAdoptedSessionConsumed = useCallback((session: AdoptedPlaybackSession) => {
    consumedAdoptedRef.current.add(session);
  }, []);

  const handoffActiveSessionRef = useRef<(() => AdoptedPlaybackSession | null) | null>(null);
  const registerHandoffSession = useCallback((fn: (() => AdoptedPlaybackSession | null) | null) => {
    handoffActiveSessionRef.current = fn;
  }, []);

  const bgAudioRef = useRef(backgroundAudioPlayback);
  bgAudioRef.current = backgroundAudioPlayback;
  const multiViewSeedRef = useRef(multiViewSeed);
  multiViewSeedRef.current = multiViewSeed;
  const stopActiveRef = useRef(onStopActivePlayback);
  stopActiveRef.current = onStopActivePlayback;
  const requestPlayRef = useRef(onRequestPlay);
  requestPlayRef.current = onRequestPlay;
  const adoptPlayRef = useRef(onAdoptPlay ?? onRequestPlay);
  adoptPlayRef.current = onAdoptPlay ?? onRequestPlay;

  // Defensive cleanup: if a pending adopted session is replaced or unmounted without being consumed,
  // dispose its PlaybackService and release its engine so live streams never leak (`Wave P3`).
  useEffect(() => {
    if (pendingAdoptedSession === null) return;
    return () => {
      if (!consumedAdoptedRef.current.has(pendingAdoptedSession)) {
        disposeAdoptedSession(pendingAdoptedSession);
      }
    };
  }, [pendingAdoptedSession]);

  useEffect(() => {
    if (multiViewAdoptedSession === null) return;
    return () => {
      if (!consumedAdoptedRef.current.has(multiViewAdoptedSession)) {
        disposeAdoptedSession(multiViewAdoptedSession);
      }
    };
  }, [multiViewAdoptedSession]);

  const multiViewSupported = useMemo(
    () => resolveHardwareMultiViewCap(resolveMultiViewCapabilities(thermalDevice, videoHost)) > 1,
    [thermalDevice, videoHost],
  );

  useEffect(() => {
    if (multiViewSeed === null) setMultiViewHasOnlineStream(null);
  }, [multiViewSeed]);

  useShellOnlinePlaybackSync({
    downloadManager,
    playTarget,
    liveEmbeddedPlaybackActive,
    multiViewSeed,
    multiViewHasOnlineStream,
  });

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
        setPendingAdoptedSession(null);
        setPendingAdoptEngineId(undefined);
      }
      if (multiViewSeedRef.current !== null) {
        setMultiViewAdoptedSession(null);
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

  // Re-open playTarget in main window when standalone Popout player docks (#158, Wave P3).
  useEffect(() => {
    const sub = desktopWindow?.onPopoutDocked;
    if (sub === undefined) return;
    return sub((payload) => {
      setMultiViewAdoptedSession(null);
      setMultiViewSeed(null);
      setPendingAdoptedSession(null);
      const hasTransfer =
        payload.transferEngineId !== undefined && payload.transferEngineId.length > 0;
      setPendingAdoptEngineId(hasTransfer ? payload.transferEngineId : undefined);
      setPlayerHandoffKey((k) => k + 1);
      setPlayerViewMode('full');
      const rawTarget = buildPlayTargetFromPopoutDock(payload);
      const prevPopout = lastPopoutTargetRef.current;
      const target: PlayTarget =
        rawTarget.isLocalOffline !== true &&
        prevPopout?.itemKey === rawTarget.itemKey &&
        prevPopout.isLocalOffline === true &&
        typeof prevPopout.localFileUri === 'string' &&
        prevPopout.localFileUri.trim().length > 0
          ? {
              ...rawTarget,
              isLocalOffline: true,
              localFileUri: prevPopout.localFileUri.trim(),
            }
          : rawTarget;
      lastPopoutTargetRef.current = null;
      if (hasTransfer) {
        adoptPlayRef.current(target);
      } else {
        requestPlayRef.current(target);
      }
    });
  }, [desktopWindow]);

  const minimizeToMiniPlayer = useCallback(() => {
    setPlayerViewMode('mini');
  }, []);

  const expandMiniPlayer = useCallback(() => {
    setPlayerViewMode('full');
  }, []);

  const resetToFullMode = useCallback((clearAdoption = false) => {
    setPlayerViewMode('full');
    if (clearAdoption) {
      setPendingAdoptedSession(null);
      setPendingAdoptEngineId(undefined);
    }
  }, []);

  const enterMultiView = useCallback(
    (target: PlayTarget) => {
      if (!multiViewSupported) return;
      setPlayerViewMode('full');
      const adopted = handoffActiveSessionRef.current?.() ?? null;
      if (adopted !== null) {
        stopActiveRef.current();
        setMultiViewAdoptedSession(adopted);
        setMultiViewSeed(target);
        return;
      }
      void Promise.resolve(stopActivePlayerRef.current?.())
        .catch(() => undefined)
        .finally(() => {
          stopActiveRef.current();
          void Promise.resolve().then(() => {
            setMultiViewAdoptedSession(null);
            setMultiViewSeed(target);
          });
        });
    },
    [multiViewSupported, stopActivePlayerRef],
  );

  const exitMultiView = useCallback(
    (resumeTarget: PlayTarget | null, adoptedSession?: AdoptedPlaybackSession | null) => {
      setMultiViewAdoptedSession(null);
      setMultiViewSeed(null);
      setPlayerViewMode('full');
      setPendingAdoptEngineId(undefined);
      if (resumeTarget !== null) {
        if (adoptedSession !== undefined && adoptedSession !== null) {
          setPendingAdoptedSession(adoptedSession);
          setPlayerHandoffKey((k) => k + 1);
          adoptPlayRef.current(resumeTarget);
        } else {
          setPendingAdoptedSession(null);
          requestPlayRef.current(resumeTarget);
        }
      } else {
        if (adoptedSession !== undefined && adoptedSession !== null) {
          disposeAdoptedSession(adoptedSession);
        }
        setPendingAdoptedSession(null);
      }
    },
    [],
  );

  const openPopout = desktopWindow?.openPopout;
  const popoutPlayer = useMemo(() => {
    if (openPopout === undefined) return undefined;
    return (target: PlayTarget, positionMs?: number, transferEngineId?: string) => {
      lastPopoutTargetRef.current = target;
      const payload = buildPopoutLaunchPayload(target, positionMs, transferEngineId);
      setPlayerViewMode('full');
      if (transferEngineId !== undefined && transferEngineId.length > 0) {
        stopActiveRef.current();
        const restoreParked = () => {
          setPendingAdoptedSession(null);
          setPendingAdoptEngineId(transferEngineId);
          setPlayerHandoffKey((k) => k + 1);
          adoptPlayRef.current(target);
        };
        void Promise.resolve()
          .then(() => openPopout(payload))
          .then((opened) => {
            if (!opened) restoreParked();
          })
          .catch(restoreParked);
        return;
      }
      void Promise.resolve(stopActivePlayerRef.current?.())
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
  }, [openPopout, stopActivePlayerRef]);

  const openMultiViewFromBrowse = useMemo(
    () =>
      multiViewSupported
        ? (target: PlayTarget) => {
            runAfterEmbeddedPreview(stopEmbeddedPreviewRef, () => enterMultiView(target));
          }
        : undefined,
    [enterMultiView, multiViewSupported, stopEmbeddedPreviewRef],
  );

  const openPopoutFromBrowse = useMemo(
    () =>
      popoutPlayer !== undefined
        ? (target: PlayTarget) => {
            runAfterEmbeddedPreview(stopEmbeddedPreviewRef, () => popoutPlayer(target));
          }
        : undefined,
    [popoutPlayer, stopEmbeddedPreviewRef],
  );

  const browseStageActions = useMemo(
    () => ({
      ...(openMultiViewFromBrowse !== undefined
        ? { onOpenMultiView: openMultiViewFromBrowse }
        : {}),
      ...(openPopoutFromBrowse !== undefined ? { onOpenPopout: openPopoutFromBrowse } : {}),
    }),
    [openMultiViewFromBrowse, openPopoutFromBrowse],
  );

  const tuneFromReminder = useCallback(
    (target: PlayTarget) => {
      if (playTargetRef.current === null) {
        runAfterEmbeddedPreview(stopEmbeddedPreviewRef, () => requestPlayRef.current(target));
        return;
      }
      requestPlayRef.current(target);
    },
    [playTargetRef, stopEmbeddedPreviewRef],
  );

  return {
    playerViewMode,
    multiViewSeed,
    multiViewAdoptedSession,
    pendingAdoptedSession,
    pendingAdoptEngineId,
    playerHandoffKey,
    multiViewSupported,
    restoreCursorToken,
    markAdoptedSessionConsumed,
    registerHandoffSession,
    minimizeToMiniPlayer,
    expandMiniPlayer,
    resetToFullMode,
    enterMultiView,
    exitMultiView,
    onMultiViewOnlineStreamChange: setMultiViewHasOnlineStream,
    popoutPlayer,
    browseStageActions,
    tuneFromReminder,
  };
}

/** Return value of {@link useShellPlaybackModes}. */
export type ShellPlaybackModes = ReturnType<typeof useShellPlaybackModes>;

/**
 * Notifies {@link DownloadManagerPort.notifyOnlinePlaybackActive} whenever online playback
 * starts or stops so `max_connections = 1` accounts auto-pause active downloads cleanly.
 */
export function useShellOnlinePlaybackSync(params: {
  readonly downloadManager?: DownloadManagerPort | undefined;
  readonly playTarget: PlayTarget | null;
  readonly liveEmbeddedPlaybackActive: boolean;
  readonly multiViewSeed: PlayTarget | null;
  readonly multiViewHasOnlineStream?: boolean | null | undefined;
}): void {
  const {
    downloadManager,
    playTarget,
    liveEmbeddedPlaybackActive,
    multiViewSeed,
    multiViewHasOnlineStream,
  } = params;
  const multiViewOnline =
    multiViewSeed !== null &&
    (multiViewHasOnlineStream != null
      ? multiViewHasOnlineStream
      : multiViewSeed.isLocalOffline !== true);
  const isOnlinePlaying =
    (playTarget !== null && playTarget.isLocalOffline !== true) ||
    liveEmbeddedPlaybackActive ||
    multiViewOnline;
  const lastSentRef = useRef(false);

  useEffect(() => {
    const notify = downloadManager?.notifyOnlinePlaybackActive;
    if (notify === undefined) return;
    if (lastSentRef.current === isOnlinePlaying) return;
    lastSentRef.current = isOnlinePlaying;
    void notify.call(downloadManager, isOnlinePlaying);
  }, [downloadManager, isOnlinePlaying]);

  useEffect(() => {
    return () => {
      if (lastSentRef.current) {
        lastSentRef.current = false;
        void downloadManager?.notifyOnlinePlaybackActive?.(false);
      }
    };
  }, [downloadManager]);
}
