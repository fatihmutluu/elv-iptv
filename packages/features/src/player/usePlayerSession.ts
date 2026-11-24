import type { CatalogService } from '@elv/data';
import type { AccessibilityFontFamily, DeinterlaceMode } from '@elv/domain';
import {
  type ChapterInfo,
  createPlaybackService,
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
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
import type { AudioDeviceInfo, HostKey, OpenVideoEngine, VideoHost } from '../ports/video-host';
import { useStreamHealth } from '../shared';

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
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Opens `videoHost` inside `useEffect`, creates the bound `PlaybackService`, routes out-of-DOM host
 * keys (including desktop `'close'`), and subscribes to `{ status, tracks }` snapshots.
 */
export function usePlayerSession(params: {
  videoHost: VideoHost;
  activeTarget: PlayTarget;
  isDesktop?: boolean;
  subtitleFontFamily?: AccessibilityFontFamily;
  deinterlaceMode?: DeinterlaceMode;
  pitchLock?: boolean;
  audioNormalization?: boolean;
  backgroundAudioPlayback?: boolean;
  windowAspectRatioLock?: boolean;
  onWindowAspectRatioLockChange?: (enabled: boolean) => void;
  catalogRef?: MutableRefObject<Partial<Pick<CatalogService, 'reportStreamOutcome'>>>;
  canAcquireAlternate?: (accountKey: string, maxConnections: number) => boolean;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  hostKeyRef: MutableRefObject<(key: HostKey) => void>;
  onExitRef: MutableRefObject<() => void>;
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
    serviceRef,
    clockRef,
    timersRef,
    hostKeyRef,
    onExitRef,
  } = params;
  const streamHealth = useStreamHealth();
  const streamHealthRef = useRef(streamHealth);
  streamHealthRef.current = streamHealth;
  const canAcquireAlternateRef = useRef(canAcquireAlternate);
  canAcquireAlternateRef.current = canAcquireAlternate;
  const onReadyRef = useRef(params.onServiceReady);
  onReadyRef.current = params.onServiceReady;

  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'opening' });

  useEffect(() => {
    let cancelled = false;
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

    const attachOpened = (opened: OpenVideoEngine | null): void => {
      if (cancelled) {
        opened?.engine.release();
        return;
      }
      if (opened === null) {
        markUnavailable();
        return;
      }
      const health = streamHealthRef.current;
      const service = createPlaybackService({
        engine: opened.engine,
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
            catalogRef?.current.reportStreamOutcome?.(
              stream.sourceId,
              stream.url,
              outcome === 'success',
            );
          }
        },
      });
      const offHostKey = opened.onHostKey?.((key) => {
        if ((key as string) === 'close') onExitRef.current();
        else if (key === 'stop') {
          service.stop();
          onExitRef.current();
        } else hostKeyRef.current(key);
      });
      activeSession = { opened, service, ...(offHostKey !== undefined ? { offHostKey } : {}) };
      serviceRef.current = service;
      setSessionState({ kind: 'ready', opened, service });
      onReadyRef.current(service);
    };

    setSessionState({ kind: 'opening' });
    try {
      const openedOrPromise = videoHost.open();
      if (isPromiseLike(openedOrPromise)) openedOrPromise.then(attachOpened, markUnavailable);
      else attachOpened(openedOrPromise);
    } catch {
      markUnavailable();
    }

    return () => {
      cancelled = true;
      serviceRef.current = null;
      if (activeSession !== null) {
        activeSession.opened.setMediaMetadata?.(null);
        activeSession.offHostKey?.();
        activeSession.service.dispose();
        activeSession.opened.engine.release();
        activeSession = null;
      }
    };
  }, [catalogRef, clockRef, hostKeyRef, onExitRef, serviceRef, timersRef, videoHost]);

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
    } = activeService.getState();
    const audioDelayMs = rawAudioDelay ?? 0;
    const subtitleDelayMs = rawSubDelay ?? 0;
    const selectedVideoQualityId = rawQualityId ?? tr.selectedVideoQualityId ?? null;
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
      prev.selectedVideoQualityId === selectedVideoQualityId
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
    inPip,
    isFullscreen,
    alwaysOnTop,
    overlayMode,
    audioDevices,
    activeAudioDevice,
  };
}
