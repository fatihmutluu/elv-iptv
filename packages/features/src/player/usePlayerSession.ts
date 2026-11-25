import type { CatalogService } from '@elv/data';
import { type AccessibilityFontFamily, type DeinterlaceMode, originOf } from '@elv/domain';
import {
  type AttemptToken,
  type ChapterInfo,
  createPlaybackService,
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  type PlayerEngine,
  type StreamVideoInfo,
} from '@elv/playback';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PlayTarget } from '../ports/play-target';
import type {
  AdoptedPlaybackSession,
  AudioDeviceInfo,
  HostKey,
  OpenVideoEngine,
  VideoHost,
} from '../ports/video-host';
import { useStreamHealth } from '../shared';
import { createAdoptedPlaybackService } from './adopted-playback-service';
import {
  type WaveF7aLoadOptions,
  wrapEngineWithWaveF7aLoadOptions,
} from './usePlayerDisplayAndAudioSync';
import type { PlayerHandoffMode } from './usePlayerPip';

type SessionState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly opened: OpenVideoEngine; readonly service: PlaybackService };

interface PlaybackUiSlice {
  readonly status: PlaybackStatus;
  readonly tracks: MediaTracks;
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly chapters: readonly ChapterInfo[] | undefined;
  readonly droppedFrames: number | undefined;
  readonly surfaceRecreationToken: number;
  readonly audioDelayMs: number;
  readonly subtitleDelayMs: number;
  readonly selectedVideoQualityId: string | null;
  readonly externalPlaybackActive: boolean;
}

const OPENING_STATUS: PlaybackStatus = { kind: 'tuning' };
const OPENING_PLAYBACK_SLICE: PlaybackUiSlice = {
  status: OPENING_STATUS,
  tracks: EMPTY_TRACKS,
  videoInfo: undefined,
  chapters: undefined,
  droppedFrames: undefined,
  surfaceRecreationToken: 0,
  audioDelayMs: 0,
  subtitleDelayMs: 0,
  selectedVideoQualityId: null,
  externalPlaybackActive: false,
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function wrapEngineForParkSafeStop(
  engine: PlayerEngine,
  handoffModeRef?: MutableRefObject<PlayerHandoffMode>,
): PlayerEngine {
  if (handoffModeRef === undefined) return engine;
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'stop') {
        return (attempt: AttemptToken): void => {
          if (handoffModeRef.current === 'parked') return;
          target.stop(attempt);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Opens `videoHost` inside `useEffect`, creates the bound `PlaybackService`, routes out-of-DOM host
 * keys (including desktop `'close'`), and subscribes to `{ status, tracks }` snapshots.
 */
export function usePlayerSession(params: {
  videoHost: VideoHost;
  activeTarget: PlayTarget;
  isDesktop?: boolean | undefined;
  subtitleFontFamily?: AccessibilityFontFamily | undefined;
  deinterlaceMode?: DeinterlaceMode | undefined;
  pitchLock?: boolean | undefined;
  audioNormalization?: boolean | undefined;
  backgroundAudioPlayback?: boolean | undefined;
  windowAspectRatioLock?: boolean | undefined;
  onWindowAspectRatioLockChange?: ((enabled: boolean) => void) | undefined;
  catalogRef?: MutableRefObject<Partial<Pick<CatalogService, 'reportStreamOutcome'>>>;
  canAcquireAlternate?: ((accountKey: string, maxConnections: number) => boolean) | undefined;
  adoptedSession?: AdoptedPlaybackSession | undefined;
  adoptEngineId?: string | undefined;
  onConsumeAdoptedSession?: ((session: AdoptedPlaybackSession) => void) | undefined;
  handoffModeRef?: MutableRefObject<PlayerHandoffMode>;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  hostKeyRef: MutableRefObject<(key: HostKey) => void>;
  onExitRef: MutableRefObject<() => void>;
  waveF7aLoadOptionsRef?: MutableRefObject<WaveF7aLoadOptions>;
  onServiceReady: (service: PlaybackService) => void;
}) {
  const {
    videoHost,
    activeTarget,
    isDesktop = false,
    subtitleFontFamily = 'system',
    deinterlaceMode,
    pitchLock,
    audioNormalization,
    backgroundAudioPlayback,
    windowAspectRatioLock,
    onWindowAspectRatioLockChange,
    catalogRef,
    canAcquireAlternate,
    adoptedSession,
    adoptEngineId,
    onConsumeAdoptedSession,
    handoffModeRef,
    serviceRef,
    clockRef,
    timersRef,
    hostKeyRef,
    onExitRef,
    waveF7aLoadOptionsRef,
  } = params;
  const streamHealth = useStreamHealth();
  const streamHealthRef = useRef(streamHealth);
  streamHealthRef.current = streamHealth;
  const canAcquireAlternateRef = useRef(canAcquireAlternate);
  canAcquireAlternateRef.current = canAcquireAlternate;
  const onReadyRef = useRef(params.onServiceReady);
  onReadyRef.current = params.onServiceReady;
  const onConsumeAdoptedRef = useRef(onConsumeAdoptedSession);
  onConsumeAdoptedRef.current = onConsumeAdoptedSession;
  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;

  const handoffVersionRef = useRef(0);
  const lastAdoptedSessionRef = useRef(adoptedSession);
  const lastAdoptEngineIdRef = useRef(adoptEngineId);
  const pendingAdoptedSessionRef = useRef(adoptedSession);
  const pendingAdoptEngineIdRef = useRef(adoptEngineId);
  if (adoptedSession !== undefined && adoptedSession !== lastAdoptedSessionRef.current) {
    lastAdoptedSessionRef.current = adoptedSession;
    pendingAdoptedSessionRef.current = adoptedSession;
    pendingAdoptEngineIdRef.current = undefined;
    handoffVersionRef.current += 1;
  } else if (
    adoptEngineId !== undefined &&
    adoptEngineId.length > 0 &&
    adoptEngineId !== lastAdoptEngineIdRef.current
  ) {
    lastAdoptEngineIdRef.current = adoptEngineId;
    pendingAdoptEngineIdRef.current = adoptEngineId;
    pendingAdoptedSessionRef.current = undefined;
    handoffVersionRef.current += 1;
  }
  const handoffVersion = handoffVersionRef.current;

  const [sessionState, setSessionState] = useState<SessionState>(() =>
    adoptedSession !== undefined
      ? { kind: 'ready', opened: adoptedSession.opened, service: adoptedSession.service }
      : { kind: 'opening' },
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: handoffVersion triggers clean re-adoption when a new adoptEngineId or adoptedSession arrives
  useEffect(() => {
    let cancelled = false;
    if (handoffModeRef !== undefined) handoffModeRef.current = 'none';
    let activeSession: {
      opened: OpenVideoEngine;
      service: PlaybackService;
      offHostKey?: () => void;
    } | null = null;

    const markUnavailable = (): void => {
      if (cancelled) return;
      serviceRef.current = null;
      setSessionState({ kind: 'unavailable' });
    };

    const bindHostKeys = (
      opened: OpenVideoEngine,
      service: PlaybackService,
    ): (() => void) | undefined =>
      opened.onHostKey?.((key) => {
        if ((key as string) === 'close') onExitRef.current();
        else if (key === 'stop') {
          service.stop();
          onExitRef.current();
        } else hostKeyRef.current(key);
      });

    const wrapEngineForService = (rawEngine: PlayerEngine): PlayerEngine => {
      const waveWrapped =
        waveF7aLoadOptionsRef !== undefined
          ? wrapEngineWithWaveF7aLoadOptions(rawEngine, () => waveF7aLoadOptionsRef.current)
          : rawEngine;
      return wrapEngineForParkSafeStop(waveWrapped, handoffModeRef);
    };

    const createServiceForOpened = (opened: OpenVideoEngine): PlaybackService => {
      const health = streamHealthRef.current;
      const boundEngine = wrapEngineForService(opened.engine);
      return createPlaybackService({
        engine: boundEngine,
        clock: clockRef.current,
        timers: timersRef.current,
        healthCache: health.healthCache,
        healthScorer: health.healthScorer,
        idleProbeController: health.idleProbeController,
        canAcquireAlternate: (accountKey, maxConnections) => {
          const explicit = canAcquireAlternateRef.current;
          if (explicit !== undefined && !explicit(accountKey, maxConnections)) {
            return false;
          }
          return streamHealthRef.current.canAcquireAlternate(accountKey, maxConnections);
        },
        onStreamOutcome: (stream, outcome) => {
          if (stream.sourceId !== undefined && stream.sourceId.length > 0) {
            const origin = originOf(stream.url);
            if (
              origin !== undefined &&
              (origin.startsWith('http://') || origin.startsWith('https://'))
            ) {
              catalogRef?.current.reportStreamOutcome?.(
                stream.sourceId,
                origin,
                outcome === 'success',
              );
            }
          }
        },
      });
    };

    const attachOpened = (opened: OpenVideoEngine | null): void => {
      if (cancelled) {
        opened?.engine.release();
        return;
      }
      if (opened === null) {
        markUnavailable();
        return;
      }
      const service = createServiceForOpened(opened);
      const offHostKey = bindHostKeys(opened, service);
      activeSession = { opened, service, ...(offHostKey !== undefined ? { offHostKey } : {}) };
      serviceRef.current = service;
      setSessionState({ kind: 'ready', opened, service });
      onReadyRef.current(service);
    };

    const attachCrossWindowAdopted = (opened: OpenVideoEngine): void => {
      if (cancelled) {
        opened.engine.release();
        return;
      }
      const boundEngine = wrapEngineForService(opened.engine);
      const service = createAdoptedPlaybackService({
        engine: boundEngine,
        clock: clockRef.current,
        timers: timersRef.current,
        target: activeTargetRef.current,
        createDelegateService: () => createServiceForOpened(opened),
      });
      const offHostKey = bindHostKeys(opened, service);
      activeSession = { opened, service, ...(offHostKey !== undefined ? { offHostKey } : {}) };
      serviceRef.current = service;
      setSessionState({ kind: 'ready', opened, service });
    };

    const openFresh = (): void => {
      try {
        const openedOrPromise = videoHost.open();
        if (isPromiseLike(openedOrPromise)) openedOrPromise.then(attachOpened, markUnavailable);
        else attachOpened(openedOrPromise);
      } catch {
        markUnavailable();
      }
    };

    const nextAdopted = pendingAdoptedSessionRef.current;
    const nextEngineId = pendingAdoptEngineIdRef.current;
    if (nextAdopted !== undefined) {
      pendingAdoptedSessionRef.current = undefined;
      onConsumeAdoptedRef.current?.(nextAdopted);
      const { opened, service, muted } = nextAdopted;
      opened.setPrimary?.();
      opened.setMuted?.(muted);
      const offHostKey = bindHostKeys(opened, service);
      activeSession = { opened, service, ...(offHostKey !== undefined ? { offHostKey } : {}) };
      serviceRef.current = service;
      setSessionState({ kind: 'ready', opened, service });
    } else if (
      nextEngineId !== undefined &&
      nextEngineId.length > 0 &&
      videoHost.adoptEngine !== undefined
    ) {
      pendingAdoptEngineIdRef.current = undefined;
      setSessionState({ kind: 'opening' });
      void Promise.resolve(videoHost.adoptEngine(nextEngineId)).then(
        (adoptedOpened) => {
          if (cancelled) {
            adoptedOpened?.engine.release();
            return;
          }
          if (adoptedOpened !== null) {
            attachCrossWindowAdopted(adoptedOpened);
          } else {
            openFresh();
          }
        },
        () => {
          if (!cancelled) openFresh();
        },
      );
    } else {
      setSessionState({ kind: 'opening' });
      openFresh();
    }

    return () => {
      cancelled = true;
      serviceRef.current = null;
      if (activeSession !== null) {
        const mode = handoffModeRef?.current ?? 'none';
        if (mode === 'session') {
          activeSession.offHostKey?.();
          activeSession = null;
          return;
        }
        if (mode === 'parked') {
          activeSession.offHostKey?.();
          activeSession.service.dispose();
          activeSession = null;
          return;
        }
        activeSession.opened.setMediaMetadata?.(null);
        activeSession.offHostKey?.();
        activeSession.service.dispose();
        activeSession.opened.engine.release();
        activeSession = null;
      }
    };
  }, [
    catalogRef,
    clockRef,
    handoffModeRef,
    handoffVersion,
    hostKeyRef,
    onExitRef,
    serviceRef,
    timersRef,
    videoHost,
    waveF7aLoadOptionsRef,
  ]);

  const openedEngine = sessionState.kind === 'ready' ? sessionState.opened : null;
  const [inPip, setInPip] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [overlayMode, setOverlayMode] = useState<'floating' | 'docked'>(
    isDesktop ? 'docked' : 'floating',
  );
  const [audioDevices, setAudioDevices] = useState<readonly AudioDeviceInfo[]>([]);
  const [activeAudioDevice, setActiveAudioDevice] = useState('auto');

  useEffect(() => {
    const subscribePip = openedEngine?.onPictureInPictureChange;
    if (subscribePip === undefined) {
      setInPip(false);
      return;
    }
    return subscribePip((next) => setInPip(next));
  }, [openedEngine]);

  useEffect(() => {
    if (openedEngine === null) {
      setIsFullscreen(false);
      return;
    }
    setIsFullscreen(openedEngine.isFullscreen?.() === true);
    const subscribeFullscreen = openedEngine.onFullscreenChange;
    if (subscribeFullscreen === undefined) return;
    return subscribeFullscreen((next) => setIsFullscreen(next));
  }, [openedEngine]);

  useEffect(() => {
    if (openedEngine === null) {
      setAlwaysOnTop(false);
      return;
    }
    setAlwaysOnTop(openedEngine.isAlwaysOnTop?.() === true);
    const subscribePin = openedEngine.onAlwaysOnTopChange;
    if (subscribePin === undefined) return;
    return subscribePin((next) => setAlwaysOnTop(next));
  }, [openedEngine]);

  useEffect(() => {
    const fallback = isDesktop ? 'docked' : 'floating';
    if (openedEngine === null) {
      setOverlayMode(fallback);
      return;
    }
    setOverlayMode(openedEngine.overlayMode ?? fallback);
    const subscribeOverlay = openedEngine.onOverlayModeChange;
    if (subscribeOverlay === undefined) return;
    return subscribeOverlay((next) => setOverlayMode(next));
  }, [isDesktop, openedEngine]);

  useEffect(() => {
    if (openedEngine === null) {
      setAudioDevices([]);
      setActiveAudioDevice('auto');
      return;
    }
    setAudioDevices(openedEngine.getAudioDevices?.() ?? []);
    setActiveAudioDevice(openedEngine.getActiveAudioDevice?.() ?? 'auto');
    const subscribeDevices = openedEngine.onAudioDevicesChange;
    if (subscribeDevices === undefined) return;
    return subscribeDevices((devices, active) => {
      setAudioDevices(devices);
      setActiveAudioDevice(active || 'auto');
    });
  }, [openedEngine]);

  // Forward live subtitle font family changes to engine host on open & preference update (#163)
  useEffect(() => {
    openedEngine?.setSubtitleFontFamily?.(subtitleFontFamily);
  }, [openedEngine, subtitleFontFamily]);

  // Forward deinterlaceMode, pitchLock, and audioNormalization on open & preference update (#243)
  useEffect(() => {
    if (deinterlaceMode !== undefined) {
      openedEngine?.setDeinterlaceMode?.(deinterlaceMode);
    }
  }, [deinterlaceMode, openedEngine]);

  useEffect(() => {
    if (pitchLock !== undefined) {
      openedEngine?.setPitchLock?.(pitchLock);
    }
  }, [openedEngine, pitchLock]);

  useEffect(() => {
    if (audioNormalization !== undefined) {
      openedEngine?.setAudioNormalization?.(audioNormalization);
    }
  }, [audioNormalization, openedEngine]);

  useEffect(() => {
    if (backgroundAudioPlayback !== undefined) {
      openedEngine?.setBackgroundAudioEnabled?.(backgroundAudioPlayback);
    }
  }, [backgroundAudioPlayback, openedEngine]);

  useEffect(() => {
    if (windowAspectRatioLock !== undefined) {
      onWindowAspectRatioLockChange?.(windowAspectRatioLock);
    }
  }, [onWindowAspectRatioLockChange, windowAspectRatioLock]);

  const canStepTrack = activeTarget.kind === 'live' && (activeTarget.playlist?.count ?? 0) > 1;

  useEffect(() => {
    openedEngine?.setMediaMetadata?.({
      title: activeTarget.title,
      ...(activeTarget.subtitle ? { subtitle: activeTarget.subtitle } : {}),
      ...(activeTarget.logo ? { artworkUrl: activeTarget.logo } : {}),
      kind: activeTarget.kind,
      canStepTrack,
    });
  }, [
    openedEngine,
    activeTarget.title,
    activeTarget.subtitle,
    activeTarget.logo,
    activeTarget.kind,
    canStepTrack,
  ]);

  const activeService = sessionState.kind === 'ready' ? sessionState.service : null;
  const sliceRef = useRef<PlaybackUiSlice>(OPENING_PLAYBACK_SLICE);
  const subscribePlayback = useCallback(
    (cb: () => void) => (activeService === null ? () => undefined : activeService.subscribe(cb)),
    [activeService],
  );
  const getPlaybackSnapshot = useCallback((): PlaybackUiSlice => {
    if (activeService === null) return OPENING_PLAYBACK_SLICE;
    const {
      status: st,
      tracks: tr,
      videoInfo: vi,
      chapters: ch,
      droppedFrames: df,
      surfaceRecreationToken: token,
      audioDelayMs: rawAudioDelay,
      subtitleDelayMs: rawSubDelay,
      selectedVideoQualityId: rawQualityId,
      externalPlaybackActive: rawExternalPlaybackActive,
    } = activeService.getState();
    const audioDelayMs = rawAudioDelay ?? 0;
    const subtitleDelayMs = rawSubDelay ?? 0;
    const selectedVideoQualityId = rawQualityId ?? tr.selectedVideoQualityId ?? null;
    const externalPlaybackActive = rawExternalPlaybackActive === true;
    const prev = sliceRef.current;
    if (
      prev.status === st &&
      prev.tracks === tr &&
      prev.videoInfo === vi &&
      prev.chapters === ch &&
      prev.droppedFrames === df &&
      prev.surfaceRecreationToken === token &&
      prev.audioDelayMs === audioDelayMs &&
      prev.subtitleDelayMs === subtitleDelayMs &&
      prev.selectedVideoQualityId === selectedVideoQualityId &&
      prev.externalPlaybackActive === externalPlaybackActive
    ) {
      return prev;
    }
    sliceRef.current = {
      status: st,
      tracks: tr,
      videoInfo: vi,
      chapters: ch,
      droppedFrames: df,
      surfaceRecreationToken: token,
      audioDelayMs,
      subtitleDelayMs,
      selectedVideoQualityId,
      externalPlaybackActive,
    };
    return sliceRef.current;
  }, [activeService]);
  const {
    status,
    tracks,
    videoInfo,
    chapters,
    droppedFrames,
    surfaceRecreationToken,
    audioDelayMs,
    subtitleDelayMs,
    selectedVideoQualityId,
    externalPlaybackActive,
  } = useSyncExternalStore(subscribePlayback, getPlaybackSnapshot, getPlaybackSnapshot);

  return {
    sessionState,
    activeService,
    status,
    tracks,
    videoInfo,
    chapters,
    droppedFrames,
    surfaceRecreationToken,
    audioDelayMs,
    subtitleDelayMs,
    selectedVideoQualityId,
    externalPlaybackActive,
    inPip,
    isFullscreen,
    alwaysOnTop,
    overlayMode,
    audioDevices,
    activeAudioDevice,
  };
}
