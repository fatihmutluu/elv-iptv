import type { CatalogService } from '@elv/data';
import {
  type AndroidDecoderMode,
  type BufferPreset,
  elvError,
  err,
  type LiveChannelSwitchModePref,
  ok,
  type SubtitleStyleConfig,
} from '@elv/domain';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackTimers,
  positionAt,
  type StreamRequest,
  type TuneRequest,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { AppLifecyclePort } from '../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import { resolveChannelJump } from './channel-digit-entry';
import { targetIdentityKey } from './live-timeshift-model';
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
      Partial<
        Pick<CatalogService, 'channelByNumber' | 'recordRecentChannel' | 'resolveCatchupStream'>
      >
  >;
  serviceRef: MutableRefObject<PlaybackService | null>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  flushProgressRef: MutableRefObject<(overridePosMs?: number) => void>;
  flushEndedProgressRef?: MutableRefObject<() => void>;
  cancelScrubRef: MutableRefObject<() => void>;
  onTargetChangeRef: MutableRefObject<((next: PlayTarget) => void) | undefined>;
  bufferPresetRef?: MutableRefObject<BufferPreset>;
  decoderModeRef?: MutableRefObject<AndroidDecoderMode | undefined>;
  preferHevcOverDolbyVisionRef?: MutableRefObject<boolean>;
  filterSdhSubtitlesRef?: MutableRefObject<boolean>;
  subtitleStyleRef?: MutableRefObject<SubtitleStyleConfig>;
  liveChannelSwitchModeRef?: MutableRefObject<LiveChannelSwitchModePref>;
  resolvedNextEpisodeRef?: MutableRefObject<PlayableEntry | undefined>;
  backgroundAudioPlaybackRef?: MutableRefObject<boolean>;
  onRegisterStopActivePlayer?: ((stop: (() => Promise<void>) | null) => void) | undefined;
}

/**
 * Owns active `PlayTarget` state, VOD resume lookup, live zapping, single-connection Next Episode
 * (`#353`, `#392`), Channel Drawer selection (`#57`), Previous Channel handoffs, `playbackGuard`,
 * and `appLifecycle` suspend/resume.
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
  flushEndedProgressRef,
  cancelScrubRef,
  onTargetChangeRef,
  bufferPresetRef,
  decoderModeRef,
  preferHevcOverDolbyVisionRef,
  filterSdhSubtitlesRef,
  subtitleStyleRef,
  liveChannelSwitchModeRef,
  resolvedNextEpisodeRef,
  backgroundAudioPlaybackRef,
  onRegisterStopActivePlayer,
}: PlayerTargetHandoffParams) {
  const [activeTarget, setActiveTarget] = useState<PlayTarget>(target);
  const [previewTarget, setPreviewTarget] = useState<PlayTarget | null>(null);

  const mountedRef = useRef(true);
  const activeTargetRef = useRef<PlayTarget>(target);
  const previewTargetRef = useRef<PlayTarget | null>(null);
  const previewIndexRef = useRef<number | null>(null);
  const previewSeqRef = useRef(0);
  const burstOriginRef = useRef<PlayTarget | null>(null);
  const lastRecordedRecentKeyRef = useRef<string | null>(null);
  const prevPropKeyRef = useRef(targetIdentityKey(target));
  const transitioningToRef = useRef<string | null>(null);
  const backgroundedRef = useRef(false);
  const resumeOnActiveRef = useRef(false);
  const vodResumeMsRef = useRef<number | undefined>(undefined);
  const tuneGenRef = useRef(0);
  const pendingResumeRef = useRef(false);

  const activeIdentity = targetIdentityKey(activeTarget);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear double-tap transition lock once React commits the target
  useEffect(() => {
    transitioningToRef.current = null;
  }, [activeIdentity]);

  const cancelPendingResume = useCallback((): void => {
    tuneGenRef.current += 1;
    pendingResumeRef.current = false;
  }, []);

  const cancelPreviewChannel = useCallback((): void => {
    previewSeqRef.current += 1;
    previewIndexRef.current = null;
    if (previewTargetRef.current !== null) {
      previewTargetRef.current = null;
      setPreviewTarget(null);
    }
  }, []);

  const recordSettledRecentChannel = useCallback(
    (entry: PlayableEntry): void => {
      if (entry.kind !== 'live') return;
      if (lastRecordedRecentKeyRef.current === entry.itemKey) return;
      lastRecordedRecentKeyRef.current = entry.itemKey;
      void catalogRef.current
        .recordRecentChannel?.(entry.itemKey, entry.sourceId)
        ?.catch(() => undefined);
    },
    [catalogRef],
  );

  const buildTuneRequest = useCallback(
    (entry: PlayableEntry, startMs?: number): TuneRequest => {
      const bufferPreset = bufferPresetRef?.current;
      const decoderMode = decoderModeRef?.current;
      const preferHevcOverDolbyVision = preferHevcOverDolbyVisionRef?.current;
      const filterSdhSubtitles = filterSdhSubtitlesRef?.current;
      const subtitleStyle = subtitleStyleRef?.current;
      return {
        item: entry.itemKey,
        accountKey: entry.accountKey ?? entry.sourceId,
        kind: entry.kind,
        resolve: async () => {
          if (
            entry.isLocalOffline === true &&
            typeof entry.localFileUri === 'string' &&
            entry.localFileUri.length > 0
          ) {
            return ok({
              url: entry.localFileUri,
              headers: {},
              sourceId: entry.sourceId,
              channelKey: entry.itemKey,
            });
          }
          const catchup = entry.catchup;
          const res =
            catchup !== undefined
              ? catalogRef.current.resolveCatchupStream !== undefined
                ? await catalogRef.current.resolveCatchupStream(entry.itemKey, {
                    startMs: catchup.startMs,
                    stopMs: catchup.stopMs,
                    ...(catchup.hasArchive !== undefined ? { hasArchive: catchup.hasArchive } : {}),
                    title: catchup.programmeTitle,
                  })
                : err(elvError('storage', 'unsupported'))
              : await catalogRef.current.resolveStream(entry.itemKey);
          if (res.ok && res.value.allowLegacyTls === true) {
            return { ok: true, value: { ...res.value, allowLegacyTls: true } };
          }
          return res;
        },
        ...(startMs !== undefined ? { startMs } : {}),
        ...(bufferPreset !== undefined ? { bufferPreset } : {}),
        ...(decoderMode !== undefined ? { decoderMode } : {}),
        ...(preferHevcOverDolbyVision !== undefined ? { preferHevcOverDolbyVision } : {}),
        ...(filterSdhSubtitles !== undefined ? { filterSdhSubtitles } : {}),
        ...(subtitleStyle !== undefined ? { subtitleStyle } : {}),
      };
    },
    [
      bufferPresetRef,
      catalogRef,
      decoderModeRef,
      filterSdhSubtitlesRef,
      preferHevcOverDolbyVisionRef,
      subtitleStyleRef,
    ],
  );

  const tuneEntry = useCallback(
    (service: PlaybackService, entry: PlayableEntry, startMs?: number): void => {
      recordSettledRecentChannel(entry);
      service.tune(buildTuneRequest(entry, startMs));
    },
    [buildTuneRequest, recordSettledRecentChannel],
  );

  const reloadActiveTarget = useCallback((): void => {
    const svc = serviceRef.current;
    if (backgroundedRef.current) {
      resumeOnActiveRef.current = true;
      return;
    }
    if (svc === null) return;
    const current = activeTargetRef.current;
    let resumeStartMs: number | undefined;
    if (current.kind === 'vod') {
      const { anchor, status: st } = svc.getState();
      if (st.kind === 'ended') {
        resumeStartMs = 0;
      } else if (anchor !== undefined) {
        resumeStartMs = Math.max(0, Math.round(positionAt(anchor, clockRef.current.now())));
      } else {
        resumeStartMs = vodResumeMsRef.current ?? current.startPositionMs;
      }
      flushProgressRef.current(resumeStartMs);
    }
    cancelScrubRef.current();
    cancelPendingResume();
    tuneEntry(svc, current, current.kind === 'vod' ? resumeStartMs : undefined);
  }, [cancelPendingResume, cancelScrubRef, clockRef, flushProgressRef, serviceRef, tuneEntry]);

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
        if (burstOriginRef.current === null) {
          burstOriginRef.current = activeTargetRef.current;
        }
        const originTarget = burstOriginRef.current;
        const originIdx = originTarget.playlist?.currentIndex;
        const enriched: PlayTarget =
          nextTarget.itemKey !== originTarget.itemKey
            ? {
                ...nextTarget,
                previousChannel: toPlayableEntry(originTarget),
                ...(originIdx !== undefined ? { previousChannelIndex: originIdx } : {}),
              }
            : {
                ...nextTarget,
                ...(originTarget.previousChannel !== undefined
                  ? { previousChannel: originTarget.previousChannel }
                  : {}),
                ...(originTarget.previousChannelIndex !== undefined
                  ? { previousChannelIndex: originTarget.previousChannelIndex }
                  : {}),
              };
        vodResumeMsRef.current = undefined;
        prevPropKeyRef.current = targetIdentityKey(enriched);
        activeTargetRef.current = enriched;
        setActiveTarget(enriched);
        onTargetChangeRef.current?.(enriched);
      },
      tune: (nextTarget) => {
        if (!mountedRef.current) return;
        burstOriginRef.current = null;
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
      if (liveChannelSwitchModeRef?.current === 'preview') {
        const current = activeTargetRef.current;
        const playlist = current.playlist;
        if (current.kind !== 'live' || playlist === undefined || playlist.count <= 0) return;
        const base = previewIndexRef.current ?? playlist.currentIndex;
        const nextIndex = (((base + delta) % playlist.count) + playlist.count) % playlist.count;
        previewIndexRef.current = nextIndex;
        const seq = ++previewSeqRef.current;
        void playlist.getAt(nextIndex).then(
          (entry) => {
            if (!mountedRef.current || seq !== previewSeqRef.current || entry === undefined) return;
            const nextPreview: PlayTarget = {
              ...entry,
              playlist: { ...playlist, currentIndex: nextIndex },
            };
            previewTargetRef.current = nextPreview;
            setPreviewTarget(nextPreview);
          },
          () => undefined,
        );
        return;
      }
      cancelPreviewChannel();
      cancelPendingResume();
      zapController.zap(delta, repeat);
    },
    [cancelPendingResume, cancelPreviewChannel, liveChannelSwitchModeRef, zapController],
  );

  const handlePlayNextEpisode = useCallback(
    (expectedNextKey?: string, resolvedNext?: PlayableEntry): void => {
      const current = activeTargetRef.current;
      if (transitioningToRef.current === current.itemKey) return;
      const queuedNext = buildNextEpisodeTarget(current);
      const fallbackEntry = resolvedNext ?? resolvedNextEpisodeRef?.current;
      const next: PlayTarget | null =
        queuedNext ??
        (fallbackEntry !== undefined && fallbackEntry.itemKey !== current.itemKey
          ? { ...fallbackEntry, startPositionMs: 0 }
          : null);
      if (next === null) return;
      if (expectedNextKey !== undefined && next.itemKey !== expectedNextKey) return;
      transitioningToRef.current = next.itemKey;
      cancelScrubRef.current();
      flushProgressRef.current();
      cancelPendingResume();
      vodResumeMsRef.current = undefined;
      prevPropKeyRef.current = targetIdentityKey(next);
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
      resolvedNextEpisodeRef,
      serviceRef,
      tuneEntry,
    ],
  );

  const handleQueueAdvanced = useCallback(
    (advancedItemKey: string, resolvedNext?: PlayableEntry, queuedStream?: StreamRequest): void => {
      const current = activeTargetRef.current;
      if (!mountedRef.current || current.itemKey === advancedItemKey) return;
      const queuedNext = buildNextEpisodeTarget(current);
      const fallbackEntry = resolvedNext ?? resolvedNextEpisodeRef?.current;
      const next: PlayTarget | null =
        queuedNext !== null && queuedNext.itemKey === advancedItemKey
          ? queuedNext
          : fallbackEntry !== undefined && fallbackEntry.itemKey === advancedItemKey
            ? { ...fallbackEntry, startPositionMs: 0 }
            : null;
      if (next === null) return;
      transitioningToRef.current = next.itemKey;
      cancelScrubRef.current();
      if (flushEndedProgressRef !== undefined) {
        flushEndedProgressRef.current();
      } else {
        flushProgressRef.current();
      }
      cancelPendingResume();
      vodResumeMsRef.current = undefined;
      prevPropKeyRef.current = targetIdentityKey(next);
      activeTargetRef.current = next;
      serviceRef.current?.adoptQueuedTarget(buildTuneRequest(next, 0), queuedStream);
      setActiveTarget(next);
      onTargetChangeRef.current?.(next);
    },
    [
      buildTuneRequest,
      cancelPendingResume,
      cancelScrubRef,
      flushEndedProgressRef,
      flushProgressRef,
      onTargetChangeRef,
      resolvedNextEpisodeRef,
      serviceRef,
    ],
  );

  const commitLiveTarget = useCallback(
    (next: PlayTarget, syncPlaylistIndex?: number): void => {
      burstOriginRef.current = null;
      cancelPreviewChannel();
      cancelScrubRef.current();
      cancelPendingResume();
      vodResumeMsRef.current = undefined;
      zapController.reset(next.playlist?.currentIndex ?? 0);
      if (syncPlaylistIndex !== undefined) next.playlist?.onChangeIndex(syncPlaylistIndex);
      prevPropKeyRef.current = targetIdentityKey(next);
      activeTargetRef.current = next;
      setActiveTarget(next);
      onTargetChangeRef.current?.(next);
      const svc = serviceRef.current;
      if (backgroundedRef.current) resumeOnActiveRef.current = true;
      else if (svc !== null) {
        svc.stop();
        tuneEntry(svc, next);
      }
    },
    [
      cancelPendingResume,
      cancelPreviewChannel,
      cancelScrubRef,
      onTargetChangeRef,
      serviceRef,
      tuneEntry,
      zapController,
    ],
  );

  const handleJumpPreviousChannel = useCallback((): void => {
    const current = activeTargetRef.current;
    const next = buildPreviousChannelTarget(current);
    if (next === null) return;
    const nextIndex = next.playlist?.currentIndex ?? 0;
    const syncIdx =
      next.playlist !== undefined &&
      current.previousChannelIndex !== undefined &&
      nextIndex === current.previousChannelIndex
        ? nextIndex
        : undefined;
    commitLiveTarget(next, syncIdx);
  }, [commitLiveTarget]);

  const handleBackToLive = useCallback((): void => {
    const current = activeTargetRef.current;
    if (current.catchup === undefined) return;
    serviceRef.current?.setSpeed(1);
    const nextLive: PlayTarget = { ...current.catchup.liveTarget };
    commitLiveTarget(nextLive);
  }, [commitLiveTarget, serviceRef]);

  const selectChannel = useCallback(
    (entry: PlayableEntry, index?: number): void => {
      const current = activeTargetRef.current;
      if (current.kind !== 'live') return;
      const next = buildChannelJumpTarget(current, entry, index);
      if (next === null) return;
      commitLiveTarget(next, index);
    },
    [commitLiveTarget],
  );

  const selectQualityVariant = useCallback(
    (variantKey: string, variantTitle?: string): void => {
      const current = activeTargetRef.current;
      if (current.kind !== 'live' || variantKey === current.itemKey) return;
      const next: PlayTarget = {
        ...current,
        itemKey: variantKey,
        ...(variantTitle !== undefined ? { title: variantTitle } : {}),
      };
      commitLiveTarget(next);
    },
    [commitLiveTarget],
  );

  const confirmPreviewChannel = useCallback((): void => {
    const preview = previewTargetRef.current;
    cancelPreviewChannel();
    if (preview === null) return;
    if (preview.itemKey === activeTargetRef.current.itemKey) return;
    selectChannel(preview, preview.playlist?.currentIndex);
  }, [cancelPreviewChannel, selectChannel]);

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
          commitLiveTarget(next, resolved.index);
        })
        .catch(() => undefined);
    },
    [catalogRef, commitLiveTarget],
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

  const stopSession = useCallback((): Promise<void> => {
    cancelPendingResume();
    vodResumeMsRef.current = undefined;
    zapController.reset(activeTargetRef.current.playlist?.currentIndex ?? 0);
    resumeOnActiveRef.current = false;
    return Promise.resolve(serviceRef.current?.stop());
  }, [cancelPendingResume, serviceRef, zapController]);

  useEffect(() => {
    mountedRef.current = true;
    const unregGuard = playbackGuard?.registerSession?.({
      getSourceId: () => activeTargetRef.current.sourceId,
      stop: stopSession,
    });
    return () => {
      mountedRef.current = false;
      lastRecordedRecentKeyRef.current = null;
      burstOriginRef.current = null;
      zapController.reset(activeTargetRef.current.playlist?.currentIndex ?? 0);
      unregGuard?.();
    };
  }, [playbackGuard, stopSession, zapController]);

  useEffect(() => {
    if (onRegisterStopActivePlayer === undefined) return;
    onRegisterStopActivePlayer(stopSession);
    return () => onRegisterStopActivePlayer(null);
  }, [onRegisterStopActivePlayer, stopSession]);

  useEffect(() => {
    const nextIdentity = targetIdentityKey(target);
    if (prevPropKeyRef.current === nextIdentity) {
      if (hasTargetMetaChanged(activeTargetRef.current, target)) {
        zapController.sync(target.playlist?.currentIndex ?? 0);
        activeTargetRef.current = target;
        setActiveTarget(target);
      }
      return;
    }
    flushProgressRef.current();
    cancelPendingResume();
    burstOriginRef.current = null;
    cancelPreviewChannel();
    prevPropKeyRef.current = nextIdentity;
    vodResumeMsRef.current = undefined;
    zapController.reset(target.playlist?.currentIndex ?? 0);
    activeTargetRef.current = target;
    setActiveTarget(target);
    const svc = serviceRef.current;
    if (backgroundedRef.current) resumeOnActiveRef.current = true;
    else if (svc !== null) {
      svc.stop();
      tuneWithResume(svc, target);
    }
  }, [
    cancelPendingResume,
    cancelPreviewChannel,
    flushProgressRef,
    serviceRef,
    target,
    tuneWithResume,
    zapController,
  ]);

  useEffect(() => {
    return appLifecycle.subscribe((lifecycleState) => {
      if (lifecycleState === 'background') {
        if (backgroundAudioPlaybackRef?.current === true) {
          flushProgressRef.current();
          return;
        }
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
    backgroundAudioPlaybackRef,
    cancelPendingResume,
    clockRef,
    flushProgressRef,
    serviceRef,
    tuneWithResume,
    zapController,
  ]);

  return {
    activeTarget,
    previewTarget,
    zapBy,
    confirmPreviewChannel,
    cancelPreviewChannel,
    selectChannel,
    selectQualityVariant,
    jumpToChannel,
    onServiceReady,
    reloadActiveTarget,
    handlePlayNextEpisode,
    handleQueueAdvanced,
    handleJumpPreviousChannel,
    handleBackToLive,
  };
}
