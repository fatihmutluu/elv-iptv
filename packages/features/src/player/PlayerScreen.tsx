import type { CatalogService } from '@elv/data';
import {
  createPlaybackService,
  EMPTY_TRACKS,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackState,
  type PlaybackTimers,
} from '@elv/playback';
import { useFormFactor, useI18n } from '@elv/ui-kit';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { View } from 'react-native';
import { type AppLifecyclePort, noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { OpenVideoEngine, VideoHost } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { formatStatusLine, PlayerOsd, playerStyles } from './PlayerScreenParts';
import { TrackPickerModal } from './TrackPickerModal';
import { usePlayerControls } from './usePlayerControls';

const DEFAULT_CLOCK: PlaybackClock = { now: () => performance.now() };
const DEFAULT_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const OPENING_PLAYBACK_STATE: PlaybackState = {
  status: { kind: 'tuning' },
  attempt: 0,
  tracks: EMPTY_TRACKS,
  staleEventsDropped: 0,
};

/** Props of {@link PlayerScreen}. */
export interface PlayerScreenProps {
  catalog: Pick<CatalogService, 'resolveStream'>;
  videoHost: VideoHost;
  target: PlayTarget;
  appLifecycle?: AppLifecyclePort;
  clock?: PlaybackClock;
  timers?: PlaybackTimers;
  onTargetChange?: (next: PlayTarget) => void;
  onExit: () => void;
}

type SessionState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly opened: OpenVideoEngine;
      readonly service: PlaybackService;
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
 * Cross-platform playback screen over injected {@link VideoHost} and {@link AppLifecyclePort} ports.
 * Owns `PlayerEngine` + `PlaybackService` strictly inside `useEffect`, stops playback on
 * `'background'` and re-tunes on `'active'`, supports live channel Up/Down zapping, VOD pause/seek,
 * and plain localized audio/subtitle track selection.
 */
export function PlayerScreen({
  catalog,
  videoHost,
  target,
  appLifecycle = noopAppLifecycle,
  clock = DEFAULT_CLOCK,
  timers = DEFAULT_TIMERS,
  onTargetChange,
  onExit,
}: PlayerScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';

  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'opening' });
  const [activeTarget, setActiveTarget] = useState<PlayTarget>(target);

  const mountedRef = useRef(true);
  const serviceRef = useRef<PlaybackService | null>(null);
  const activeTargetRef = useRef<PlayTarget>(target);
  const prevPropKeyRef = useRef(target.itemKey);
  const playlistIndexRef = useRef(target.playlist?.currentIndex ?? 0);
  const zapSeqRef = useRef(0);
  const backgroundedRef = useRef(false);
  const resumeOnActiveRef = useRef(false);

  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const timersRef = useRef(timers);
  timersRef.current = timers;
  const onTargetChangeRef = useRef(onTargetChange);
  onTargetChangeRef.current = onTargetChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const tuneEntry = useCallback((service: PlaybackService, entry: PlayableEntry): void => {
    service.tune({
      item: entry.itemKey,
      accountKey: entry.sourceId,
      kind: entry.kind,
      resolve: () => catalogRef.current.resolveStream(entry.itemKey),
    });
  }, []);

  const zapBy = useCallback(
    (delta: 1 | -1): void => {
      const current = activeTargetRef.current;
      const playlist = current.playlist;
      if (current.kind !== 'live' || playlist === undefined || playlist.count <= 0) {
        return;
      }
      const nextIndex =
        (((playlistIndexRef.current + delta) % playlist.count) + playlist.count) % playlist.count;
      playlistIndexRef.current = nextIndex;
      const seq = ++zapSeqRef.current;

      void playlist.getAt(nextIndex).then(
        (entry) => {
          if (!mountedRef.current || seq !== zapSeqRef.current || entry === undefined) {
            return;
          }
          const nextTarget: PlayTarget = {
            ...entry,
            playlist: { ...playlist, currentIndex: nextIndex },
          };
          prevPropKeyRef.current = nextTarget.itemKey;
          activeTargetRef.current = nextTarget;
          setActiveTarget(nextTarget);
          playlist.onChangeIndex(nextIndex);
          onTargetChangeRef.current?.(nextTarget);

          const svc = serviceRef.current;
          if (backgroundedRef.current) {
            resumeOnActiveRef.current = true;
          } else if (svc !== null) {
            tuneEntry(svc, nextTarget);
          }
        },
        () => undefined,
      );
    },
    [tuneEntry],
  );

  const zapByRef = useRef(zapBy);
  zapByRef.current = zapBy;
  const hostBackRef = useRef<() => void>(() => onExitRef.current());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prevPropKeyRef.current === target.itemKey) return;
    prevPropKeyRef.current = target.itemKey;
    zapSeqRef.current += 1;
    playlistIndexRef.current = target.playlist?.currentIndex ?? 0;
    activeTargetRef.current = target;
    setActiveTarget(target);
    const svc = serviceRef.current;
    if (backgroundedRef.current) {
      resumeOnActiveRef.current = true;
    } else if (svc !== null) {
      tuneEntry(svc, target);
    }
  }, [target, tuneEntry]);

  useEffect(() => {
    let cancelled = false;
    let activeSession: {
      opened: OpenVideoEngine;
      service: PlaybackService;
      offHostKey?: () => void;
    } | null = null;

    const attachOpened = (opened: OpenVideoEngine | null): void => {
      if (cancelled) {
        opened?.engine.release();
        return;
      }
      if (opened === null) {
        serviceRef.current = null;
        setSessionState({ kind: 'unavailable' });
        return;
      }
      const service = createPlaybackService({
        engine: opened.engine,
        clock: clockRef.current,
        timers: timersRef.current,
      });
      const offHostKey = opened.onHostKey?.((key) => {
        if (key === 'back') hostBackRef.current();
        else zapByRef.current(key === 'channel-up' ? 1 : -1);
      });
      activeSession = {
        opened,
        service,
        ...(offHostKey !== undefined ? { offHostKey } : {}),
      };
      serviceRef.current = service;
      setSessionState({ kind: 'ready', opened, service });
      if (backgroundedRef.current) {
        resumeOnActiveRef.current = true;
      } else {
        tuneEntry(service, activeTargetRef.current);
      }
    };

    setSessionState({ kind: 'opening' });
    try {
      const openedOrPromise = videoHost.open();
      if (isPromiseLike(openedOrPromise)) {
        openedOrPromise.then(attachOpened, () => {
          if (!cancelled) {
            serviceRef.current = null;
            setSessionState({ kind: 'unavailable' });
          }
        });
      } else {
        attachOpened(openedOrPromise);
      }
    } catch {
      if (!cancelled) {
        serviceRef.current = null;
        setSessionState({ kind: 'unavailable' });
      }
    }

    return () => {
      cancelled = true;
      serviceRef.current = null;
      if (activeSession !== null) {
        activeSession.offHostKey?.();
        activeSession.service.dispose();
        activeSession.opened.engine.release();
        activeSession = null;
      }
    };
  }, [tuneEntry, videoHost]);

  useEffect(() => {
    return appLifecycle.subscribe((lifecycleState) => {
      if (lifecycleState === 'background') {
        backgroundedRef.current = true;
        const svc = serviceRef.current;
        if (svc === null) {
          resumeOnActiveRef.current = true;
          return;
        }
        if (svc.getState().status.kind !== 'idle') {
          resumeOnActiveRef.current = true;
          svc.stop();
        }
        return;
      }
      backgroundedRef.current = false;
      const svc = serviceRef.current;
      if (resumeOnActiveRef.current && svc !== null) {
        resumeOnActiveRef.current = false;
        tuneEntry(svc, activeTargetRef.current);
      }
    });
  }, [appLifecycle, tuneEntry]);

  const activeService = sessionState.kind === 'ready' ? sessionState.service : null;
  const subscribePlayback = useCallback(
    (cb: () => void) => (activeService === null ? () => undefined : activeService.subscribe(cb)),
    [activeService],
  );
  const getPlaybackSnapshot = useCallback(
    () => (activeService === null ? OPENING_PLAYBACK_STATE : activeService.getState()),
    [activeService],
  );
  const playbackState = useSyncExternalStore(
    subscribePlayback,
    getPlaybackSnapshot,
    getPlaybackSnapshot,
  );

  const status = playbackState.status;
  const tracks = playbackState.tracks;
  const hasTracks = tracks.audio.length > 0 || tracks.subtitles.length > 0;
  const showRetry = status.kind === 'failed' && activeService !== null;
  const statusLine =
    sessionState.kind === 'unavailable'
      ? i18n.t('player.unavailable')
      : formatStatusLine(status, i18n);
  const failure = status.kind === 'failed' ? describePlaybackFailure(status.error) : null;
  const canZap =
    activeTarget.kind === 'live' &&
    activeTarget.playlist !== undefined &&
    activeTarget.playlist.count > 1;

  const controls = usePlayerControls({
    formFactor,
    activeTarget,
    status,
    tracks,
    hasTracks,
    showRetry,
    serviceRef,
    clockRef,
    onExitRef,
    zapByRef,
  });
  hostBackRef.current = controls.handleBack;

  return (
    <View testID="player-screen" style={playerStyles.root} {...controls.desktopFallbackKeyProps}>
      {isTv ? (
        <View
          testID="player-tv-focus-anchor"
          focusable
          hasTVPreferredFocus
          style={playerStyles.tvFocusAnchor}
        />
      ) : null}

      {sessionState.kind === 'ready' ? (
        <View
          testID="player-surface-layer"
          style={
            formFactor === 'desktop' ? playerStyles.surfaceLayerDesktop : playerStyles.surfaceLayer
          }
        >
          {sessionState.opened.renderSurface({
            statusText: `${activeTarget.title} — ${statusLine}`,
            failed: status.kind === 'failed',
            testID: 'player-surface',
          })}
        </View>
      ) : null}

      {controls.tracksOpen && activeService !== null ? (
        <TrackPickerModal
          tracks={tracks}
          cursor={controls.pickerCursor}
          isTv={isTv}
          formFactor={formFactor}
          i18n={i18n}
          onSelectAudio={controls.selectAudio}
          onSelectSubtitle={controls.selectSubtitle}
          onClose={controls.closeTracks}
        />
      ) : null}

      <PlayerOsd
        title={activeTarget.title}
        statusLine={statusLine}
        failure={failure}
        isVod={activeTarget.kind === 'vod'}
        isPausedOrEnded={controls.isPausedOrEnded}
        canZap={canZap}
        hasTracks={hasTracks}
        showRetry={showRetry}
        isTv={isTv}
        tvOsdFocused={controls.tvOsdFocused}
        tvOsdAction={controls.tvOsdAction}
        i18n={i18n}
        service={activeService}
        clock={clock}
        onExit={onExit}
        onTogglePlayPause={controls.togglePlayPause}
        onSeekBack={controls.seekStepBack}
        onSeekForward={controls.seekStepForward}
        onSeekRatio={controls.seekToRatio}
        onOpenTracks={controls.openTracks}
        onPrev={() => zapBy(-1)}
        onNext={() => zapBy(1)}
        onRetry={() => activeService?.retry()}
      />
    </View>
  );
}
