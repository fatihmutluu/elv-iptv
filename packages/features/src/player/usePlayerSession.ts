import {
  createPlaybackService,
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
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
import type { HostKey, OpenVideoEngine, VideoHost } from '../ports/video-host';

type SessionState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly opened: OpenVideoEngine; readonly service: PlaybackService };

interface PlaybackUiSlice {
  readonly status: PlaybackStatus;
  readonly tracks: MediaTracks;
}

const OPENING_STATUS: PlaybackStatus = { kind: 'tuning' };
const OPENING_PLAYBACK_SLICE: PlaybackUiSlice = { status: OPENING_STATUS, tracks: EMPTY_TRACKS };

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
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  hostKeyRef: MutableRefObject<(key: HostKey) => void>;
  onExitRef: MutableRefObject<() => void>;
  onServiceReady: (service: PlaybackService) => void;
}) {
  const { videoHost, activeTarget, serviceRef, clockRef, timersRef, hostKeyRef, onExitRef } =
    params;
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
      const service = createPlaybackService({
        engine: opened.engine,
        clock: clockRef.current,
        timers: timersRef.current,
      });
      const offHostKey = opened.onHostKey?.((key) => {
        if ((key as string) === 'close') onExitRef.current();
        else hostKeyRef.current(key);
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
  }, [clockRef, hostKeyRef, onExitRef, serviceRef, timersRef, videoHost]);

  const openedEngine = sessionState.kind === 'ready' ? sessionState.opened : null;
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
    const { status: st, tracks: tr } = activeService.getState();
    const prev = sliceRef.current;
    if (prev.status === st && prev.tracks === tr) return prev;
    sliceRef.current = { status: st, tracks: tr };
    return sliceRef.current;
  }, [activeService]);
  const { status, tracks } = useSyncExternalStore(
    subscribePlayback,
    getPlaybackSnapshot,
    getPlaybackSnapshot,
  );

  return { sessionState, activeService, status, tracks };
}
