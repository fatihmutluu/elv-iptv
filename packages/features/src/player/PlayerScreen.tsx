import type { CatalogService } from '@elv/data';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { useFormFactor, useI18n } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { type AppLifecyclePort, noopAppLifecycle } from '../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import { formatStatusLine, PlayerOsd, playerStyles } from './PlayerScreenParts';
import { TrackPickerModal } from './TrackPickerModal';
import { usePlayerControls } from './usePlayerControls';
import { usePlayerSession } from './usePlayerSession';
import { createZapController, type ZapController } from './zap-controller';

const DEFAULT_CLOCK: PlaybackClock = { now: () => performance.now() };
const DEFAULT_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Props of {@link PlayerScreen}. */
export interface PlayerScreenProps {
  catalog: Pick<CatalogService, 'resolveStream'>;
  videoHost: VideoHost;
  target: PlayTarget;
  playbackGuard?: PlaybackGuard;
  appLifecycle?: AppLifecyclePort;
  clock?: PlaybackClock;
  timers?: PlaybackTimers;
  onTargetChange?: (next: PlayTarget) => void;
  onExit: () => void;
}

/** Cross-platform playback screen over injected {@link VideoHost} and {@link AppLifecyclePort} ports. */
export function PlayerScreen({
  catalog,
  videoHost,
  target,
  playbackGuard,
  appLifecycle = noopAppLifecycle,
  clock = DEFAULT_CLOCK,
  timers = DEFAULT_TIMERS,
  onTargetChange,
  onExit,
}: PlayerScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';

  const [activeTarget, setActiveTarget] = useState<PlayTarget>(target);

  const mountedRef = useRef(true);
  const serviceRef = useRef<PlaybackService | null>(null);
  const activeTargetRef = useRef<PlayTarget>(target);
  const prevPropKeyRef = useRef(target.itemKey);
  const backgroundedRef = useRef(false);
  const resumeOnActiveRef = useRef(false);
  const vodResumeMsRef = useRef<number | undefined>(undefined);

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

  const tuneEntry = useCallback(
    (service: PlaybackService, entry: PlayableEntry, startMs?: number): void => {
      service.tune({
        item: entry.itemKey,
        accountKey: entry.sourceId,
        kind: entry.kind,
        resolve: () => catalogRef.current.resolveStream(entry.itemKey),
        ...(startMs !== undefined ? { startMs } : {}),
      });
    },
    [],
  );

  const zapControllerRef = useRef<ZapController | null>(null);
  if (zapControllerRef.current === null) {
    zapControllerRef.current = createZapController({
      timers: () => timersRef.current,
      current: () => activeTargetRef.current,
      show: (nextTarget) => {
        if (!mountedRef.current) return;
        vodResumeMsRef.current = undefined;
        prevPropKeyRef.current = nextTarget.itemKey;
        activeTargetRef.current = nextTarget;
        setActiveTarget(nextTarget);
        onTargetChangeRef.current?.(nextTarget);
      },
      tune: (nextTarget) => {
        if (!mountedRef.current) return;
        const svc = serviceRef.current;
        if (backgroundedRef.current) resumeOnActiveRef.current = true;
        else if (svc !== null) tuneEntry(svc, nextTarget);
      },
    });
  }
  const zapController = zapControllerRef.current;

  const zapBy = useCallback(
    (delta: 1 | -1, repeat = false): void => {
      zapController.zap(delta, repeat);
    },
    [zapController],
  );

  const zapByRef = useRef<(delta: 1 | -1, repeat?: boolean) => void>(zapBy);
  zapByRef.current = zapBy;
  const hostBackRef = useRef<() => void>(() => onExitRef.current());

  const { sessionState, activeService, status, tracks } = usePlayerSession({
    videoHost,
    serviceRef,
    clockRef,
    timersRef,
    hostBackRef,
    onExitRef,
    zapByRef,
    onServiceReady: (service) => {
      if (backgroundedRef.current) resumeOnActiveRef.current = true;
      else {
        const startMs = activeTargetRef.current.kind === 'vod' ? vodResumeMsRef.current : undefined;
        tuneEntry(service, activeTargetRef.current, startMs);
      }
    },
  });

  useEffect(() => {
    mountedRef.current = true;
    const unregGuard = playbackGuard?.registerSession?.({
      getSourceId: () =>
        serviceRef.current?.getState().accountKey ?? activeTargetRef.current.sourceId,
      stop: () => {
        vodResumeMsRef.current = undefined;
        zapController.reset(activeTargetRef.current.playlist?.currentIndex ?? 0);
        resumeOnActiveRef.current = false;
        serviceRef.current?.stop();
      },
    });
    return () => {
      mountedRef.current = false;
      zapController.reset(activeTargetRef.current.playlist?.currentIndex ?? 0);
      unregGuard?.();
    };
  }, [playbackGuard, zapController]);

  useEffect(() => {
    if (prevPropKeyRef.current === target.itemKey) {
      const prev = activeTargetRef.current;
      if (
        prev.playlist !== target.playlist ||
        prev.title !== target.title ||
        prev.sourceId !== target.sourceId
      ) {
        zapController.sync(target.playlist?.currentIndex ?? 0);
        activeTargetRef.current = target;
        setActiveTarget(target);
      }
      return;
    }
    prevPropKeyRef.current = target.itemKey;
    vodResumeMsRef.current = undefined;
    zapController.reset(target.playlist?.currentIndex ?? 0);
    activeTargetRef.current = target;
    setActiveTarget(target);
    const svc = serviceRef.current;
    if (backgroundedRef.current) resumeOnActiveRef.current = true;
    else if (svc !== null) tuneEntry(svc, target);
  }, [target, tuneEntry, zapController]);

  useEffect(() => {
    return appLifecycle.subscribe((lifecycleState) => {
      if (lifecycleState === 'background') {
        backgroundedRef.current = true;
        const hadPendingZap = zapController.takePendingTune();
        const svc = serviceRef.current;
        if (svc === null) {
          resumeOnActiveRef.current = true;
          return;
        }
        const { anchor, status: st } = svc.getState();
        if (activeTargetRef.current.kind === 'vod') {
          if (st.kind === 'ended') vodResumeMsRef.current = undefined;
          else if (anchor !== undefined) {
            vodResumeMsRef.current = Math.round(positionAt(anchor, clockRef.current.now()));
          }
        }
        if (st.kind !== 'idle') {
          resumeOnActiveRef.current = true;
          svc.stop();
        } else if (hadPendingZap) {
          resumeOnActiveRef.current = true;
        }
        return;
      }
      backgroundedRef.current = false;
      const svc = serviceRef.current;
      if (resumeOnActiveRef.current && svc !== null) {
        resumeOnActiveRef.current = false;
        const startMs = activeTargetRef.current.kind === 'vod' ? vodResumeMsRef.current : undefined;
        tuneEntry(svc, activeTargetRef.current, startMs);
      }
    });
  }, [appLifecycle, tuneEntry, zapController]);

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
    hasService: activeService !== null,
    serviceRef,
    clockRef,
    timersRef,
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
        tracksOpen={controls.tracksOpen}
        previewPositionMs={controls.previewPositionMs}
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
        onRetry={controls.retry}
      />
    </View>
  );
}
