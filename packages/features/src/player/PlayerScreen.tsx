import type { CatalogService } from '@elv/data';
import {
  createPlaybackService,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackState,
  type PlaybackTimers,
} from '@elv/playback';
import { useFormFactor, useI18n, useKeyInterpreter } from '@elv/ui-kit';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Platform, View } from 'react-native';
import { type AppLifecyclePort, noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { OpenVideoEngine, VideoHost } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { formatStatusLine, PlayerOsd, playerStyles } from './PlayerScreenParts';

const DEFAULT_CLOCK: PlaybackClock = { now: () => performance.now() };
const DEFAULT_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const OPENING_PLAYBACK_STATE: PlaybackState = {
  status: { kind: 'tuning' },
  attempt: 0,
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
 * `'background'` and re-tunes on `'active'`, and supports live channel Up/Down zapping.
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
        zapByRef.current(key === 'channel-up' ? 1 : -1);
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

  useKeyInterpreter((event) => {
    if (event.kind === 'press' && event.key === 'back') {
      onExitRef.current();
      return;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const svc = serviceRef.current;
      if (svc?.getState().status.kind === 'failed') svc.retry();
      return;
    }
    if (event.kind === 'press' || event.kind === 'repeat') {
      if (event.key === 'channelUp' || event.key === 'up') zapByRef.current(1);
      else if (event.key === 'channelDown' || event.key === 'down') zapByRef.current(-1);
    }
  });

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
  const statusLine =
    sessionState.kind === 'unavailable'
      ? i18n.t('player.unavailable')
      : formatStatusLine(status, i18n);
  const failure = status.kind === 'failed' ? describePlaybackFailure(status.error) : null;
  const canZap =
    activeTarget.kind === 'live' &&
    activeTarget.playlist !== undefined &&
    activeTarget.playlist.count > 1;

  const desktopFallbackKeyProps: Record<string, unknown> =
    formFactor === 'desktop' && (Platform.OS as string) !== 'web'
      ? {
          onKeyDown: (e: { key?: unknown; preventDefault?: () => void }) => {
            if (e.key === 'Escape') {
              e.preventDefault?.();
              onExitRef.current();
            } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
              e.preventDefault?.();
              zapByRef.current(1);
            } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
              e.preventDefault?.();
              zapByRef.current(-1);
            } else if (
              e.key === 'Enter' &&
              serviceRef.current?.getState().status.kind === 'failed'
            ) {
              e.preventDefault?.();
              serviceRef.current.retry();
            }
          },
        }
      : {};

  return (
    <View testID="player-screen" style={playerStyles.root} {...desktopFallbackKeyProps}>
      {isTv ? (
        <View
          testID="player-tv-focus-anchor"
          focusable
          hasTVPreferredFocus
          style={playerStyles.tvFocusAnchor}
        />
      ) : null}

      {sessionState.kind === 'ready' ? (
        <View style={playerStyles.surfaceLayer}>
          {sessionState.opened.renderSurface({
            statusText: `${activeTarget.title} — ${statusLine}`,
            failed: status.kind === 'failed',
            testID: 'player-surface',
          })}
        </View>
      ) : null}

      <PlayerOsd
        title={activeTarget.title}
        statusLine={statusLine}
        failure={failure}
        canZap={canZap}
        showRetry={status.kind === 'failed' && activeService !== null}
        isTv={isTv}
        i18n={i18n}
        service={activeService}
        clock={clock}
        onExit={onExit}
        onPrev={() => zapBy(-1)}
        onNext={() => zapBy(1)}
        onRetry={() => activeService?.retry()}
      />
    </View>
  );
}
