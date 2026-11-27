import {
  type CatalogService,
  type ItemRow,
  resolveAccountPoolKey,
  type SourceRow,
} from '@elv/data';
import { originOf } from '@elv/domain';
import {
  createMonotonicClock,
  createPlaybackService,
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  type StreamVideoInfo,
} from '@elv/playback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackGuard } from '../ports/playback-guard';
import type {
  AudioDeviceInfo,
  OpenVideoEngine,
  VideoHost,
  VideoResizeMode,
} from '../ports/video-host';
import { useRouteActive, useStreamHealth } from '../shared';

const PREVIEW_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const IDLE_STATUS: PlaybackStatus = { kind: 'idle' };
const RESIZE_CYCLE: readonly LiveSplitResizeMode[] = ['contain', 'cover', 'stretch'];

/** Aspect / resize mode exposed by {@link useLiveEmbeddedPreview} for the embedded live split player. */
export type LiveSplitResizeMode = 'contain' | 'cover' | 'stretch';

/** Maps split-player resize modes to the platform host's {@link VideoResizeMode}. */
export function toVideoResizeMode(mode: LiveSplitResizeMode): VideoResizeMode {
  if (mode === 'cover') return 'fill';
  if (mode === 'stretch') return 'stretch';
  return 'fit';
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function isPromiseLike<T>(v: T | Promise<T>): v is Promise<T> {
  return (
    typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
  );
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best-effort teardown */
  }
}

/** Options accepted by {@link useLiveEmbeddedPreview}. */
export interface UseLiveEmbeddedPreviewOptions {
  readonly enabled: boolean;
  readonly activeChannel: ItemRow | null;
  readonly sources: readonly SourceRow[];
  readonly catalog: Pick<CatalogService, 'resolveStream'> &
    Partial<Pick<CatalogService, 'reportStreamOutcome'>>;
  readonly videoHost?: VideoHost;
  readonly playbackGuard?: PlaybackGuard;
  /** Default presentation overlay mode when host omits `opened.overlayMode`. */
  readonly defaultOverlayMode?: 'floating' | 'docked';
  /** Changing this key tears down any active preview session immediately (e.g. profile switch or parental re-lock). */
  readonly sessionResetKey?: string | number;
}

/** Embedded live preview session state and controls returned by {@link useLiveEmbeddedPreview}. */
export interface LiveEmbeddedPreviewState {
  readonly opened: OpenVideoEngine | null;
  readonly statusText: string;
  readonly failed: boolean;
  readonly status: PlaybackStatus;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly resizeMode: LiveSplitResizeMode;
  readonly tracks: MediaTracks;
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly overlayMode: 'floating' | 'docked';
  readonly audioDevices: readonly AudioDeviceInfo[];
  readonly activeAudioDevice: string;
  readonly togglePlayPause: () => void;
  readonly toggleMute: () => void;
  readonly setVolume: (volume: number) => void;
  readonly cycleResizeMode: () => void;
  readonly selectAudio: (id: string) => void;
  readonly selectSubtitle: (id: string | null) => void;
  readonly selectAudioDevice: (name: string) => void;
  readonly stopAndRelease: () => Promise<void>;
}

interface ActivePreviewSession {
  readonly opened: OpenVideoEngine;
  readonly service: PlaybackService;
  readonly unsubService: () => void;
  readonly unsubOverlayMode?: () => void;
  readonly unsubAudioDevices?: () => void;
  readonly unregGuard?: () => void;
}

interface ReactivePlaybackSnapshot {
  readonly status: PlaybackStatus;
  readonly statusText: string;
  readonly failed: boolean;
  readonly tracks: MediaTracks;
  readonly videoInfo: StreamVideoInfo | undefined;
}

const EMPTY_SNAPSHOT: ReactivePlaybackSnapshot = {
  status: IDLE_STATUS,
  statusText: '',
  failed: false,
  tracks: EMPTY_TRACKS,
  videoInfo: undefined,
};

/**
 * Single-connection-safe embedded live preview hook for `LiveWatchStage` (`Favorites` mode):
 * opens `videoHost` once per session, zaps favorites on the same engine, exposes full live
 * playback controls (play/pause, mute/volume, resize mode, tracks, audio devices, overlayMode),
 * registers with `playbackGuard`, recovers cleanly on surviving sources after source removal, and
 * stops+releases before fullscreen/Multi-View/Popout handoff, mode leave, route freeze, or unmount.
 */
export function useLiveEmbeddedPreview(
  opts: UseLiveEmbeddedPreviewOptions,
): LiveEmbeddedPreviewState {
  const {
    enabled,
    activeChannel,
    sources,
    catalog,
    videoHost,
    playbackGuard,
    defaultOverlayMode = 'floating',
    sessionResetKey,
  } = opts;
  const isRouteActive = useRouteActive();
  const streamHealth = useStreamHealth();
  const streamHealthRef = useRef(streamHealth);
  streamHealthRef.current = streamHealth;

  const [opened, setOpened] = useState<OpenVideoEngine | null>(null);
  const [snapshot, setSnapshot] = useState<ReactivePlaybackSnapshot>(EMPTY_SNAPSHOT);
  const [muted, setMuted] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [resizeMode, setResizeModeState] = useState<LiveSplitResizeMode>('contain');
  const [hostOverlayMode, setHostOverlayMode] = useState<'floating' | 'docked' | null>(null);
  const [audioDevices, setAudioDevices] = useState<readonly AudioDeviceInfo[]>([]);
  const [activeAudioDevice, setActiveAudioDevice] = useState('auto');
  const [reopenSeq, setReopenSeq] = useState(0);

  const sessionRef = useRef<ActivePreviewSession | null>(null);
  const sessionGenRef = useRef(0);
  const pendingTeardownRef = useRef<Promise<void> | null>(null);
  const tunedKeyRef = useRef<string | null>(null);
  const handoffReleasedRef = useRef(false);
  const guardStoppedSourceRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const volumeRef = useRef(1);
  const lastNonZeroVolumeRef = useRef(1);
  const resizeModeRef = useRef<LiveSplitResizeMode>('contain');
  const refs = useRef({ activeChannel, sources, catalog });
  refs.current = { activeChannel, sources, catalog };

  const enqueueEngineRelease = useCallback((engine: OpenVideoEngine['engine']): Promise<void> => {
    const prev = pendingTeardownRef.current;
    let asyncRelease: Promise<void> | null = null;
    try {
      const res = engine.release();
      if (isPromiseLike(res)) {
        asyncRelease = res.then(
          () => undefined,
          () => undefined,
        );
      }
    } catch {
      /* best-effort release so callers (e.g. fullscreen handoff) are never blocked */
    }
    if (prev === null && asyncRelease === null) {
      return Promise.resolve();
    }
    const nextStep = asyncRelease ?? Promise.resolve();
    const chained: Promise<void> = (
      prev !== null
        ? prev.then(
            () => nextStep,
            () => nextStep,
          )
        : nextStep
    ).finally(() => {
      if (pendingTeardownRef.current === chained) {
        pendingTeardownRef.current = null;
      }
    });
    pendingTeardownRef.current = chained;
    return chained;
  }, []);

  const tuneChannelOnService = useCallback((service: PlaybackService, ch: ItemRow): void => {
    const src = refs.current.sources.find((s) => s.id === ch.sourceId);
    tunedKeyRef.current = ch.key;
    service.tune({
      item: ch.key,
      accountKey: src ? resolveAccountPoolKey(src) : ch.sourceId,
      kind: 'live',
      resolve: () => refs.current.catalog.resolveStream(ch.key),
    });
  }, []);

  const tearDownSession = useCallback(
    async (markHandoff: boolean): Promise<void> => {
      sessionGenRef.current += 1;
      tunedKeyRef.current = null;
      if (markHandoff) handoffReleasedRef.current = true;
      const current = sessionRef.current;
      sessionRef.current = null;
      setOpened(null);
      setHostOverlayMode(null);
      setAudioDevices([]);
      setActiveAudioDevice('auto');
      setSnapshot(EMPTY_SNAPSHOT);
      if (current === null) {
        if (pendingTeardownRef.current !== null) {
          await pendingTeardownRef.current;
        }
        return;
      }
      current.unregGuard?.();
      current.unsubOverlayMode?.();
      current.unsubAudioDevices?.();
      current.unsubService();
      safeCall(() => current.service.stop());
      safeCall(() => current.service.dispose());
      await enqueueEngineRelease(current.opened.engine);
    },
    [enqueueEngineRelease],
  );

  const stopAndRelease = useCallback(() => tearDownSession(true), [tearDownSession]);
  const shouldOpen = enabled && activeChannel !== null && videoHost !== undefined && isRouteActive;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reopenSeq and sessionResetKey deliberately restart/teardown preview on guard recovery or profile/parental transitions
  useEffect(() => {
    if (!shouldOpen || videoHost === undefined) {
      handoffReleasedRef.current = false;
      guardStoppedSourceRef.current = null;
      void tearDownSession(false);
      return undefined;
    }
    if (handoffReleasedRef.current) return undefined;

    const gen = ++sessionGenRef.current;
    const attachOpened = (nextOpened: OpenVideoEngine | null): void => {
      if (sessionGenRef.current !== gen) {
        if (nextOpened !== null) void enqueueEngineRelease(nextOpened.engine);
        return;
      }
      if (nextOpened === null) {
        setOpened(null);
        setHostOverlayMode(null);
        return;
      }
      const health = streamHealthRef.current;
      const service = createPlaybackService({
        engine: nextOpened.engine,
        clock: createMonotonicClock(),
        timers: PREVIEW_TIMERS,
        healthCache: health.healthCache,
        healthScorer: health.healthScorer,
        idleProbeController: health.idleProbeController,
        canAcquireAlternate: (accountKey, maxConnections) =>
          streamHealthRef.current.canAcquireAlternate(accountKey, maxConnections),
        onStreamOutcome: (stream, outcome) => {
          if (stream.sourceId !== undefined && stream.sourceId.length > 0) {
            const origin = originOf(stream.url);
            if (
              origin !== undefined &&
              (origin.startsWith('http://') || origin.startsWith('https://'))
            ) {
              refs.current.catalog.reportStreamOutcome?.(
                stream.sourceId,
                origin,
                outcome === 'success',
              );
            }
          }
        },
      });
      const unsubService = service.subscribe(() => {
        if (sessionGenRef.current !== gen) return;
        const st = service.getState();
        const failed = st.status.kind === 'failed';
        const statusText = st.status.kind === 'playing' ? '' : st.status.kind;
        setSnapshot((p) =>
          p.status === st.status &&
          p.statusText === statusText &&
          p.failed === failed &&
          p.tracks === st.tracks &&
          p.videoInfo === st.videoInfo
            ? p
            : {
                status: st.status,
                statusText,
                failed,
                tracks: st.tracks,
                videoInfo: st.videoInfo,
              },
        );
      });

      const unsubOverlayMode = nextOpened.onOverlayModeChange?.((nextMode) => {
        if (sessionGenRef.current === gen) setHostOverlayMode(nextMode);
      });
      setHostOverlayMode(nextOpened.overlayMode ?? null);

      if (nextOpened.initialVolume !== undefined) {
        const initVol = clampUnit(nextOpened.initialVolume / 100);
        volumeRef.current = initVol;
        if (initVol > 0) lastNonZeroVolumeRef.current = initVol;
        setVolumeState(initVol);
        const initMuted = initVol === 0;
        mutedRef.current = initMuted;
        setMuted(initMuted);
      } else {
        if (mutedRef.current) nextOpened.setMuted?.(true);
        if (volumeRef.current !== 1) nextOpened.setVolume?.(Math.round(volumeRef.current * 100));
      }
      if (resizeModeRef.current !== 'contain') {
        nextOpened.setResizeMode?.(toVideoResizeMode(resizeModeRef.current));
      }

      if (nextOpened.getAudioDevices) {
        setAudioDevices(nextOpened.getAudioDevices());
      }
      if (nextOpened.getActiveAudioDevice) {
        setActiveAudioDevice(nextOpened.getActiveAudioDevice());
      }
      const unsubAudioDevices = nextOpened.onAudioDevicesChange?.((devices, active) => {
        if (sessionGenRef.current !== gen) return;
        setAudioDevices(devices);
        setActiveAudioDevice(active);
      });

      const unregGuard = playbackGuard?.registerSession?.({
        getSourceId: () => refs.current.activeChannel?.sourceId,
        stop: () => {
          guardStoppedSourceRef.current = refs.current.activeChannel?.sourceId ?? null;
          void tearDownSession(false);
        },
      });
      sessionRef.current = {
        opened: nextOpened,
        service,
        unsubService,
        ...(unsubOverlayMode !== undefined ? { unsubOverlayMode } : {}),
        ...(unsubAudioDevices !== undefined ? { unsubAudioDevices } : {}),
        ...(unregGuard !== undefined ? { unregGuard } : {}),
      };
      setOpened(nextOpened);
      if (refs.current.activeChannel !== null) {
        tuneChannelOnService(service, refs.current.activeChannel);
      }
    };

    const openSession = (): void => {
      if (sessionGenRef.current !== gen) return;
      try {
        const result = videoHost.open();
        if (isPromiseLike(result)) {
          result.then(attachOpened, () => {
            if (sessionGenRef.current === gen) setOpened(null);
          });
        } else {
          attachOpened(result);
        }
      } catch {
        if (sessionGenRef.current === gen) setOpened(null);
      }
    };

    if (pendingTeardownRef.current !== null) {
      void (async () => {
        while (pendingTeardownRef.current !== null) {
          await pendingTeardownRef.current;
          if (sessionGenRef.current !== gen) return;
        }
        openSession();
      })();
    } else {
      openSession();
    }

    return () => {
      void tearDownSession(false);
    };
  }, [
    enqueueEngineRelease,
    playbackGuard,
    reopenSeq,
    sessionResetKey,
    shouldOpen,
    tearDownSession,
    tuneChannelOnService,
    videoHost,
  ]);

  const activeChannelKey = activeChannel?.key ?? null;
  const statusKind = snapshot.status.kind;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-send resizeMode on channel/status transitions so desktop mpv --reset-on-next-file keeps the chosen aspect mode
  useEffect(() => {
    if (opened === null) return;
    if (statusKind === 'playing' || statusKind === 'paused') {
      opened.setResizeMode?.(toVideoResizeMode(resizeMode));
    }
  }, [opened, activeChannelKey, statusKind, resizeMode]);

  useEffect(() => {
    if (!shouldOpen || activeChannel === null) return;
    const current = sessionRef.current;
    if (current !== null) {
      if (tunedKeyRef.current !== activeChannel.key) {
        tuneChannelOnService(current.service, activeChannel);
      }
      return;
    }
    if (
      !handoffReleasedRef.current &&
      guardStoppedSourceRef.current !== null &&
      activeChannel.sourceId !== guardStoppedSourceRef.current
    ) {
      guardStoppedSourceRef.current = null;
      setReopenSeq((n) => n + 1);
    }
  }, [activeChannel, shouldOpen, tuneChannelOnService]);

  const togglePlayPause = useCallback(() => {
    const current = sessionRef.current;
    if (current === null) return;
    const kind = current.service.getState().status.kind;
    if (kind === 'playing') current.service.pause();
    else if (kind === 'paused') current.service.play();
    else if (kind === 'failed' || kind === 'ended') current.service.retry();
    else current.service.play();
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    const current = sessionRef.current;
    if (!nextMuted && volumeRef.current === 0) {
      const restored = lastNonZeroVolumeRef.current > 0 ? lastNonZeroVolumeRef.current : 0.5;
      volumeRef.current = restored;
      setVolumeState(restored);
      current?.opened.setVolume?.(Math.round(restored * 100));
    }
    if (current?.opened.setMuted) {
      current.opened.setMuted(nextMuted);
    } else if (current?.opened.toggleMute) {
      current.opened.toggleMute();
    } else if (current?.opened.setVolume) {
      current.opened.setVolume(nextMuted ? 0 : Math.round(volumeRef.current * 100));
    }
  }, []);

  const setVolume = useCallback((nextValue: number) => {
    const clamped = clampUnit(nextValue);
    volumeRef.current = clamped;
    if (clamped > 0) lastNonZeroVolumeRef.current = clamped;
    setVolumeState(clamped);
    const nextMuted = clamped === 0;
    if (mutedRef.current !== nextMuted) {
      mutedRef.current = nextMuted;
      setMuted(nextMuted);
      sessionRef.current?.opened.setMuted?.(nextMuted);
    }
    sessionRef.current?.opened.setVolume?.(Math.round(clamped * 100));
  }, []);

  const cycleResizeMode = useCallback(() => {
    const curIdx = RESIZE_CYCLE.indexOf(resizeModeRef.current);
    const next = RESIZE_CYCLE[(curIdx + 1) % RESIZE_CYCLE.length] ?? 'contain';
    resizeModeRef.current = next;
    setResizeModeState(next);
    sessionRef.current?.opened.setResizeMode?.(toVideoResizeMode(next));
  }, []);

  const selectAudio = useCallback((id: string) => {
    sessionRef.current?.service.selectAudioTrack(id);
  }, []);

  const selectSubtitle = useCallback((id: string | null) => {
    sessionRef.current?.service.selectSubtitleTrack(id);
  }, []);

  const selectAudioDevice = useCallback((name: string) => {
    setActiveAudioDevice(name);
    sessionRef.current?.opened.setAudioDevice?.(name);
  }, []);

  const overlayMode = hostOverlayMode ?? defaultOverlayMode;

  return useMemo<LiveEmbeddedPreviewState>(
    () => ({
      opened,
      statusText: snapshot.statusText,
      failed: snapshot.failed,
      status: snapshot.status,
      playing: snapshot.status.kind === 'playing',
      paused: snapshot.status.kind === 'paused',
      muted,
      volume,
      resizeMode,
      tracks: snapshot.tracks,
      videoInfo: snapshot.videoInfo,
      overlayMode,
      audioDevices,
      activeAudioDevice,
      togglePlayPause,
      toggleMute,
      setVolume,
      cycleResizeMode,
      selectAudio,
      selectSubtitle,
      selectAudioDevice,
      stopAndRelease,
    }),
    [
      activeAudioDevice,
      audioDevices,
      cycleResizeMode,
      muted,
      opened,
      overlayMode,
      resizeMode,
      selectAudio,
      selectAudioDevice,
      selectSubtitle,
      setVolume,
      snapshot,
      stopAndRelease,
      toggleMute,
      togglePlayPause,
      volume,
    ],
  );
}
