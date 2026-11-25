import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  positionAt,
  type StreamVideoInfo,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { AdoptedPlaybackSession, OpenVideoEngine } from '../ports/video-host';

/** Handoff disposition recorded on `PlayerScreen` unmount (`Wave P3`). */
export type PlayerHandoffMode = 'none' | 'session' | 'parked';

/**
 * Coordinates zero-reload session extraction (for `PlayerScreen -> MultiView`) and
 * `parkForTransfer()` window transfer (for Desktop Popout Detach & Dock, `Wave P3`).
 */
export function usePlayerWindowHandoff(params: {
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly activeService: PlaybackService | null;
  readonly activeTarget: PlayTarget;
  readonly mutedRef: MutableRefObject<boolean>;
  readonly volumeRef: MutableRefObject<number>;
  readonly handoffModeRef: MutableRefObject<PlayerHandoffMode>;
  readonly serviceRef: MutableRefObject<PlaybackService | null>;
  readonly clockRef: MutableRefObject<PlaybackClock>;
  readonly flushProgress: (overridePosMs?: number) => void;
  readonly onRegisterHandoffSession?:
    | ((fn: (() => AdoptedPlaybackSession | null) | null) => void)
    | undefined;
  readonly onPopoutPlayer?:
    | ((target: PlayTarget, positionMs?: number, transferEngineId?: string) => void)
    | undefined;
  readonly onDockPopout?:
    | ((target: PlayTarget, positionMs?: number, transferEngineId?: string) => void)
    | undefined;
}) {
  const latestRef = useRef(params);
  latestRef.current = params;
  const transferInFlightRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset re-entry guard whenever a new engine attaches
  useEffect(() => {
    transferInFlightRef.current = false;
  }, [params.openedEngine]);

  const extractSession = useCallback((): AdoptedPlaybackSession | null => {
    const p = latestRef.current;
    if (p.openedEngine === undefined || p.activeService === null) return null;
    p.handoffModeRef.current = 'session';
    const svcState = p.activeService.getState();
    return {
      opened: p.openedEngine,
      service: p.activeService,
      target: p.activeTarget,
      muted: p.mutedRef.current,
      volume: p.volumeRef.current,
      status: svcState.status,
      tracks: svcState.tracks,
      ...(svcState.videoInfo !== undefined ? { mediaInfo: svcState.videoInfo } : {}),
    };
  }, []);

  useEffect(() => {
    const register = params.onRegisterHandoffSession;
    if (register === undefined) return;
    register(extractSession);
    return () => register(null);
  }, [extractSession, params.onRegisterHandoffSession]);

  const triggerTransfer = useCallback(
    (cb: (target: PlayTarget, positionMs?: number, transferEngineId?: string) => void): void => {
      if (transferInFlightRef.current) return;
      const p = latestRef.current;
      const posMs = readServicePositionMs(p.serviceRef.current, p.clockRef.current);
      p.flushProgress(posMs);
      const park = p.openedEngine?.parkForTransfer;
      if (park === undefined) {
        cb(p.activeTarget, posMs);
        return;
      }
      transferInFlightRef.current = true;
      void Promise.resolve(park())
        .then((engineId) => {
          if (engineId !== null && engineId.length > 0) {
            p.handoffModeRef.current = 'parked';
            cb(p.activeTarget, posMs, engineId);
          } else {
            transferInFlightRef.current = false;
            cb(p.activeTarget, posMs);
          }
        })
        .catch(() => {
          transferInFlightRef.current = false;
          cb(p.activeTarget, posMs);
        });
    },
    [],
  );

  const handlePopoutPlayer =
    params.onPopoutPlayer !== undefined && params.onDockPopout === undefined
      ? () => {
          const cb = latestRef.current.onPopoutPlayer;
          if (cb !== undefined) triggerTransfer(cb);
        }
      : undefined;

  const handleDockPopout =
    params.onDockPopout !== undefined
      ? () => {
          const cb = latestRef.current.onDockPopout;
          if (cb !== undefined) triggerTransfer(cb);
        }
      : undefined;

  return { handlePopoutPlayer, handleDockPopout };
}

/** Reads current playback position in milliseconds from an active service, if anchored. */
function readServicePositionMs(
  service: PlaybackService | null,
  clock: PlaybackClock,
): number | undefined {
  const anchor = service?.getState().anchor;
  return anchor !== undefined
    ? Math.max(0, Math.round(positionAt(anchor, clock.now())))
    : undefined;
}

/** Triggers `showOsd` whenever `token` increments while the player is not minimized (`#158`). */
export function useRestoreOsdOnToken(token: number, isMini: boolean, showOsd: () => void): void {
  const showOsdRef = useRef(showOsd);
  showOsdRef.current = showOsd;
  const lastTokenRef: MutableRefObject<number> = useRef(token);
  useEffect(() => {
    if (token > 0 && token !== lastTokenRef.current && !isMini) {
      lastTokenRef.current = token;
      showOsdRef.current();
    } else if (token !== lastTokenRef.current) {
      lastTokenRef.current = token;
    }
  }, [isMini, token]);
}

/** Resolves a safe positive integer aspect ratio pair `(width, height)` for OS Picture-in-Picture (`#34`). */
export function resolvePipAspectRatio(
  videoInfo: StreamVideoInfo | undefined,
): readonly [number, number] {
  const w = videoInfo?.width;
  const h = videoInfo?.height;
  if (
    w !== undefined &&
    h !== undefined &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
  ) {
    return [Math.round(w), Math.round(h)];
  }
  return [16, 9];
}

/** Parameters of {@link usePlayerPip}. */
export interface UsePlayerPipParams {
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly statusKind: PlaybackStatus['kind'];
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly autoEnterPip: boolean;
  readonly onMinimizeToMiniPlayer?: (() => void) | undefined;
}

/** Return value of {@link usePlayerPip}. */
export interface PlayerPipController {
  readonly canShowPipAction: boolean;
  readonly enterPip: () => boolean;
}

/**
 * Syncs `autoEnterPip` preference to the native engine (`setAutoEnterPictureInPicture`, clearing
 * `false` on stop/unmount) and wires manual OS PiP entry with automatic fallback to the in-app
 * floating corner mini-player when the active stream route does not support OS PiP (`#34`, `#233`).
 */
export function usePlayerPip({
  openedEngine,
  statusKind,
  videoInfo,
  autoEnterPip,
  onMinimizeToMiniPlayer,
}: UsePlayerPipParams): PlayerPipController {
  const [aspectW, aspectH] = resolvePipAspectRatio(videoInfo);
  const isPlaying = statusKind === 'playing';

  useEffect(() => {
    const setAutoEnter = openedEngine?.setAutoEnterPictureInPicture;
    if (setAutoEnter === undefined) return;
    setAutoEnter(autoEnterPip && isPlaying, aspectW, aspectH);
    return () => {
      setAutoEnter(false, aspectW, aspectH);
    };
  }, [openedEngine, autoEnterPip, isPlaying, aspectW, aspectH]);

  const canShowPipAction = openedEngine?.enterPictureInPicture !== undefined;

  const enterPip = useCallback((): boolean => {
    const engine = openedEngine;
    if (engine?.enterPictureInPicture === undefined) {
      onMinimizeToMiniPlayer?.();
      return false;
    }
    if (engine.canStartPictureInPicture?.() === false) {
      onMinimizeToMiniPlayer?.();
      return false;
    }
    const entered = engine.enterPictureInPicture(aspectW, aspectH);
    if (!entered) {
      onMinimizeToMiniPlayer?.();
    }
    return entered;
  }, [aspectH, aspectW, onMinimizeToMiniPlayer, openedEngine]);

  return { canShowPipAction, enterPip };
}
