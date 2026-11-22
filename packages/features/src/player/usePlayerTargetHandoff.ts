import type { CatalogService } from '@elv/data';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { AppLifecyclePort } from '../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import { resolveChannelJump } from './channel-digit-entry';
import {
  buildChannelJumpTarget,
  buildNextEpisodeTarget,
  buildPreviousChannelTarget,
  hasTargetMetaChanged,
  isPromiseLike,
  toPlayableEntry,
} from './player-overlay-model';
import { resolveVodStartPositionMs } from './useWatchProgressSync';
import { createZapController, type ZapController } from './zap-controller';

/** Parameters of {@link usePlayerTargetHandoff}. */
export interface PlayerTargetHandoffParams {
  target: PlayTarget;
  playbackGuard?: PlaybackGuard | undefined;
  appLifecycle: AppLifecyclePort;
  catalogRef: MutableRefObject<
    Pick<CatalogService, 'resolveStream' | 'getProgress' | 'saveProgress'> &
      Partial<Pick<CatalogService, 'channelByNumber'>>
  >;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  flushProgressRef: MutableRefObject<(overridePosMs?: number) => void>;
  cancelScrubRef: MutableRefObject<() => void>;
  onTargetChangeRef: MutableRefObject<((next: PlayTarget) => void) | undefined>;
}

/**
 * Owns active `PlayTarget` state, VOD resume lookup, live zapping, single-connection Next Episode
 * (`#353`) and Previous Channel handoffs, `playbackGuard`, and `appLifecycle` suspend/resume.
 */
export function usePlayerTargetHandoff({
  target,
  playbackGuard,
  appLifecycle,
  catalogRef,
  serviceRef,
  clockRef,
  timersRef,
  flushProgressRef,
  cancelScrubRef,
  onTargetChangeRef,
}: PlayerTargetHandoffParams) {
  const [activeTarget, setActiveTarget] = useState<PlayTarget>(target);

  const mountedRef = useRef(true);
  const activeTargetRef = useRef<PlayTarget>(target);
  const prevPropKeyRef = useRef(target.itemKey);
  const transitioningToRef = useRef<string | null>(null);
  const backgroundedRef = useRef(false);
  const resumeOnActiveRef = useRef(false);
  const vodResumeMsRef = useRef<number | undefined>(undefined);
  const tuneGenRef = useRef(0);
  const pendingResumeRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear double-tap transition lock once React commits the target
  useEffect(() => {
    transitioningToRef.current = null;
  }, [activeTarget.itemKey]);

  const cancelPendingResume = useCallback((): void => {
    tuneGenRef.current += 1;
    pendingResumeRef.current = false;
  }, []);

  const tuneEntry = useCallback(
    (service: PlaybackService, entry: PlayableEntry, startMs?: number): void => {
      service.tune({
        item: entry.itemKey,
        accountKey: entry.accountKey ?? entry.sourceId,
        kind: entry.kind,
        resolve: () => catalogRef.current.resolveStream(entry.itemKey),
        ...(startMs !== undefined ? { startMs } : {}),
      });
    },
    [catalogRef],
  );

  const tuneWithResume = useCallback(
    (service: PlaybackService, entry: PlayableEntry, explicitStartMs?: number): void => {
      const gen = ++tuneGenRef.current;
      pendingResumeRef.current = false;
      if (explicitStartMs !== undefined) {
        tuneEntry(service, entry, explicitStartMs);
        return;
      }
      const startOrPromise = resolveVodStartPositionMs(entry, catalogRef.current);
      if (!isPromiseLike(startOrPromise)) {
        tuneEntry(service, entry, startOrPromise);
        return;
      }
      pendingResumeRef.current = true;
      void startOrPromise.then((startMs) => {
        if (
          !mountedRef.current ||
          gen !== tuneGenRef.current ||
          backgroundedRef.current ||
          serviceRef.current !== service ||
          activeTargetRef.current.itemKey !== entry.itemKey
        ) {
          return;
        }
        pendingResumeRef.current = false;
        tuneEntry(service, entry, startMs);
      });
    },
    [catalogRef, serviceRef, tuneEntry],
  );

  const zapControllerRef = useRef<ZapController | null>(null);
  if (zapControllerRef.current === null) {
    zapControllerRef.current = createZapController({
      timers: () => timersRef.current,
      current: () => activeTargetRef.current,
      show: (nextTarget) => {
        if (!mountedRef.current) return;
        const prevTarget = activeTargetRef.current;
        const prevIdx = prevTarget.playlist?.currentIndex;
        const enriched: PlayTarget =
          nextTarget.itemKey !== prevTarget.itemKey
            ? {
                ...nextTarget,
                previousChannel: toPlayableEntry(prevTarget),
                ...(prevIdx !== undefined ? { previousChannelIndex: prevIdx } : {}),
              }
            : {
                ...nextTarget,
                ...(prevTarget.previousChannel !== undefined
                  ? { previousChannel: prevTarget.previousChannel }
                  : {}),
                ...(prevTarget.previousChannelIndex !== undefined
                  ? { previousChannelIndex: prevTarget.previousChannelIndex }
                  : {}),
              };
        vodResumeMsRef.current = undefined;
        prevPropKeyRef.current = enriched.itemKey;
        activeTargetRef.current = enriched;
        setActiveTarget(enriched);
        onTargetChangeRef.current?.(enriched);
      },
      tune: (nextTarget) => {
        if (!mountedRef.current) return;
        cancelPendingResume();
        const svc = serviceRef.current;
        if (backgroundedRef.current) resumeOnActiveRef.current = true;
        else if (svc !== null) tuneEntry(svc, nextTarget);
      },
    });
  }
  const zapController = zapControllerRef.current;

  const zapBy = useCallback(
    (delta: 1 | -1, repeat = false): void => {
      cancelPendingResume();
      zapController.zap(delta, repeat);
    },
    [cancelPendingResume, zapController],
  );

  const handlePlayNextEpisode = useCallback(
    (expectedNextKey?: string): void => {
      const current = activeTargetRef.current;
      if (transitioningToRef.current === current.itemKey) return;
      const next = buildNextEpisodeTarget(current);
      if (next === null) return;
      if (expectedNextKey !== undefined && next.itemKey !== expectedNextKey) return;
      transitioningToRef.current = next.itemKey;
      cancelScrubRef.current();
      flushProgressRef.current();
      cancelPendingResume();
      vodResumeMsRef.current = undefined;
      prevPropKeyRef.current = next.itemKey;
      activeTargetRef.current = next;
      setActiveTarget(next);
      onTargetChangeRef.current?.(next);
      const svc = serviceRef.current;
      if (backgroundedRef.current) resumeOnActiveRef.current = true;
      else if (svc !== null) {
        svc.stop();
        tuneEntry(svc, next, 0);
      }
    },
    [
      cancelPendingResume,
      cancelScrubRef,
      flushProgressRef,
      onTargetChangeRef,
      serviceRef,
      tuneEntry,
    ],
  );

  const handleJumpPreviousChannel = useCallback((): void => {
    const current = activeTargetRef.current;
    const next = buildPreviousChannelTarget(current);
    if (next === null) return;
    cancelScrubRef.current();
    cancelPendingResume();
    vodResumeMsRef.current = undefined;
    const nextIndex = next.playlist?.currentIndex ?? 0;
    zapController.reset(nextIndex);
    if (
      next.playlist !== undefined &&
      current.previousChannelIndex !== undefined &&
      nextIndex === current.previousChannelIndex
    ) {
      next.playlist.onChangeIndex(nextIndex);
    }
    prevPropKeyRef.current = next.itemKey;
    activeTargetRef.current = next;
    setActiveTarget(next);
    onTargetChangeRef.current?.(next);
    const svc = serviceRef.current;
    if (backgroundedRef.current) resumeOnActiveRef.current = true;
    else if (svc !== null) {
      svc.stop();
      tuneEntry(svc, next);
    }
  }, [
    cancelPendingResume,
    cancelScrubRef,
    onTargetChangeRef,
    serviceRef,
    tuneEntry,
    zapController,
  ]);

  const jumpToChannel = useCallback(
    (channelNumber: number): void => {
      const current = activeTargetRef.current;
      if (current.kind !== 'live' || !Number.isInteger(channelNumber) || channelNumber <= 0) return;
      const gen = ++tuneGenRef.current;
      void resolveChannelJump(channelNumber, current, catalogRef.current)
        .then((resolved) => {
          if (!mountedRef.current || gen !== tuneGenRef.current || resolved === null) return;
          const latest = activeTargetRef.current;
          const next =
            latest.kind === 'live'
              ? buildChannelJumpTarget(latest, resolved.entry, resolved.index)
              : null;
          if (next === null) return;
          cancelScrubRef.current();
          vodResumeMsRef.current = undefined;
          zapController.reset(next.playlist?.currentIndex ?? 0);
          if (resolved.index !== undefined) next.playlist?.onChangeIndex(resolved.index);
          prevPropKeyRef.current = next.itemKey;
          activeTargetRef.current = next;
          setActiveTarget(next);
          onTargetChangeRef.current?.(next);
          const svc = serviceRef.current;
          if (backgroundedRef.current) resumeOnActiveRef.current = true;
          else if (svc !== null) {
            svc.stop();
            tuneEntry(svc, next);
          }
        })
        .catch(() => undefined);
    },
    [catalogRef, cancelScrubRef, onTargetChangeRef, serviceRef, tuneEntry, zapController],
  );

  const onServiceReady = useCallback(
    (service: PlaybackService): void => {
      if (backgroundedRef.current) resumeOnActiveRef.current = true;
      else {
        const startMs = activeTargetRef.current.kind === 'vod' ? vodResumeMsRef.current : undefined;
        tuneWithResume(service, activeTargetRef.current, startMs);
      }
    },
    [tuneWithResume],
  );

  useEffect(() => {
    return () => {
      cancelPendingResume();
      flushProgressRef.current();
    };
  }, [cancelPendingResume, flushProgressRef]);

  useEffect(() => {
    mountedRef.current = true;
    const unregGuard = playbackGuard?.registerSession?.({
      getSourceId: () => activeTargetRef.current.sourceId,
      stop: () => {
        cancelPendingResume();
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
  }, [cancelPendingResume, playbackGuard, serviceRef, zapController]);

  useEffect(() => {
    if (prevPropKeyRef.current === target.itemKey) {
      if (hasTargetMetaChanged(activeTargetRef.current, target)) {
        zapController.sync(target.playlist?.currentIndex ?? 0);
        activeTargetRef.current = target;
        setActiveTarget(target);
      }
      return;
    }
    flushProgressRef.current();
    cancelPendingResume();
    prevPropKeyRef.current = target.itemKey;
    vodResumeMsRef.current = undefined;
    zapController.reset(target.playlist?.currentIndex ?? 0);
    activeTargetRef.current = target;
    setActiveTarget(target);
    const svc = serviceRef.current;
    if (backgroundedRef.current) resumeOnActiveRef.current = true;
    else if (svc !== null) tuneWithResume(svc, target);
  }, [cancelPendingResume, flushProgressRef, serviceRef, target, tuneWithResume, zapController]);

  useEffect(() => {
    return appLifecycle.subscribe((lifecycleState) => {
      if (lifecycleState === 'background') {
        backgroundedRef.current = true;
        const hadPendingZap = zapController.takePendingTune();
        const hadPendingResume = pendingResumeRef.current;
        cancelPendingResume();
        const svc = serviceRef.current;
        if (svc === null) {
          resumeOnActiveRef.current = true;
          return;
        }
        flushProgressRef.current();
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
        } else if (hadPendingZap || hadPendingResume) {
          resumeOnActiveRef.current = true;
        }
        return;
      }
      backgroundedRef.current = false;
      const svc = serviceRef.current;
      if (resumeOnActiveRef.current && svc !== null) {
        resumeOnActiveRef.current = false;
        const startMs = activeTargetRef.current.kind === 'vod' ? vodResumeMsRef.current : undefined;
        tuneWithResume(svc, activeTargetRef.current, startMs);
      }
    });
  }, [
    appLifecycle,
    cancelPendingResume,
    clockRef,
    flushProgressRef,
    serviceRef,
    tuneWithResume,
    zapController,
  ]);

  return {
    activeTarget,
    zapBy,
    jumpToChannel,
    onServiceReady,
    handlePlayNextEpisode,
    handleJumpPreviousChannel,
  };
}
