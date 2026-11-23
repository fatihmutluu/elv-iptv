import type { CatalogService } from '@elv/data';
import type { PlaybackStatus, StreamRequest } from '@elv/playback';
import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { OpenVideoEngine } from '../ports/video-host';

/** Parameters of {@link useGaplessEpisodeQueue}. */
export interface UseGaplessEpisodeQueueParams {
  readonly activeTarget: PlayTarget;
  readonly nextEpisode: PlayableEntry | undefined;
  readonly autoPlayNextEpisode?: boolean | undefined;
  readonly statusKind: PlaybackStatus['kind'];
  readonly openedEngine: OpenVideoEngine | null | undefined;
  readonly catalogRef: MutableRefObject<Pick<CatalogService, 'resolveStream'>>;
  readonly preferHevcOverDolbyVision?: boolean | undefined;
  readonly filterSdhSubtitles?: boolean | undefined;
  readonly onQueueAdvanced: (
    advancedItemKey: string,
    nextEpisode: PlayableEntry | undefined,
    queuedStream?: StreamRequest,
  ) => void;
}

/** Return value of {@link useGaplessEpisodeQueue}. */
export interface GaplessEpisodeQueueResult {
  /** True while the next episode is actively queued via engine `append-play` for the current item. */
  readonly isGaplessArmed: boolean;
}

/**
 * Resolveswhether `target` represents a VOD series episode eligible for gapless `append-play` (`#205`).
 */
export function isEpisodePlayTarget(target: PlayTarget): boolean {
  return (
    target.kind === 'vod' &&
    (target.itemKind === 'episode' ||
      target.seriesKey != null ||
      target.season != null ||
      target.episode != null ||
      (target.nextEpisodes !== undefined && target.nextEpisodes.length > 0))
  );
}

/**
 * Lazily resolves and queues the next series episode onto an engine supporting `queueNext`
 * (e.g. desktop `libmpv` `loadfile <url> append-play` with `--prefetch-playlist=no`, `#205`),
 * clears the queue when disabled/non-episode/unmounted, and promotes `activeTarget` seamlessly
 * when `onQueueAdvanced` fires (including across season boundaries!).
 */
export function useGaplessEpisodeQueue(
  params: UseGaplessEpisodeQueueParams,
): GaplessEpisodeQueueResult {
  const {
    activeTarget,
    nextEpisode,
    autoPlayNextEpisode = true,
    statusKind,
    openedEngine,
    catalogRef,
    preferHevcOverDolbyVision,
    filterSdhSubtitles,
    onQueueAdvanced,
  } = params;

  const nextEpisodeRef = useRef<PlayableEntry | undefined>(nextEpisode);
  nextEpisodeRef.current = nextEpisode;
  const onQueueAdvancedRef = useRef(onQueueAdvanced);
  onQueueAdvancedRef.current = onQueueAdvanced;

  const queuedPairRef = useRef<string | null>(null);
  const queuedStreamRef = useRef<{ itemKey: string; stream: StreamRequest } | null>(null);
  const [armedPairKey, setArmedPairKey] = useState<string | null>(null);
  const queueNext = openedEngine?.queueNext;
  const clearQueue = openedEngine?.clearQueue;
  const subscribeQueueAdvanced = openedEngine?.onQueueAdvanced;

  const isEpisode = isEpisodePlayTarget(activeTarget);
  const isActivelyPlaying = statusKind === 'playing' || statusKind === 'paused';
  const nextItemKey = nextEpisode?.itemKey;
  const activeItemKey = activeTarget.itemKey;
  const canArm =
    queueNext !== undefined &&
    autoPlayNextEpisode === true &&
    isEpisode &&
    isActivelyPlaying &&
    nextItemKey !== undefined &&
    nextItemKey !== activeItemKey;
  const pairKey =
    canArm && nextItemKey !== undefined
      ? `${activeItemKey}->${nextItemKey}:${preferHevcOverDolbyVision ? '1' : '0'}:${filterSdhSubtitles ? '1' : '0'}`
      : null;

  useEffect(() => {
    if (subscribeQueueAdvanced === undefined) return;
    return subscribeQueueAdvanced((advancedItemKey) => {
      const matchedStream =
        queuedStreamRef.current?.itemKey === advancedItemKey
          ? queuedStreamRef.current.stream
          : undefined;
      queuedPairRef.current = null;
      queuedStreamRef.current = null;
      setArmedPairKey(null);
      onQueueAdvancedRef.current(advancedItemKey, nextEpisodeRef.current, matchedStream);
    });
  }, [subscribeQueueAdvanced]);

  useEffect(() => {
    if (!canArm || nextItemKey === undefined || queueNext === undefined || pairKey === null) {
      if (queuedPairRef.current !== null) {
        queuedPairRef.current = null;
        queuedStreamRef.current = null;
        setArmedPairKey(null);
        clearQueue?.();
      } else if (!autoPlayNextEpisode || !isEpisode || nextItemKey === undefined) {
        queuedStreamRef.current = null;
        setArmedPairKey(null);
        clearQueue?.();
      }
      return;
    }

    if (queuedPairRef.current === pairKey) return;

    let cancelled = false;

    void Promise.resolve(catalogRef.current.resolveStream(nextItemKey))
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          if (queuedPairRef.current !== null) {
            queuedPairRef.current = null;
            queuedStreamRef.current = null;
            setArmedPairKey(null);
            clearQueue?.();
          }
          return;
        }
        const stream =
          res.value.allowLegacyTls === true ? { ...res.value, allowLegacyTls: true } : res.value;
        queuedPairRef.current = pairKey;
        queuedStreamRef.current = { itemKey: nextItemKey, stream };
        setArmedPairKey(pairKey);
        queueNext({
          itemKey: nextItemKey,
          stream,
          ...(preferHevcOverDolbyVision !== undefined ? { preferHevcOverDolbyVision } : {}),
          ...(filterSdhSubtitles !== undefined ? { filterSdhSubtitles } : {}),
        });
      })
      .catch(() => {
        if (cancelled) return;
        if (queuedPairRef.current !== null) {
          queuedPairRef.current = null;
          queuedStreamRef.current = null;
          setArmedPairKey(null);
          clearQueue?.();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    autoPlayNextEpisode,
    canArm,
    catalogRef,
    clearQueue,
    filterSdhSubtitles,
    isEpisode,
    nextItemKey,
    pairKey,
    preferHevcOverDolbyVision,
    queueNext,
  ]);

  useEffect(() => {
    return () => {
      if (queuedPairRef.current !== null) {
        queuedPairRef.current = null;
        queuedStreamRef.current = null;
        clearQueue?.();
      }
    };
  }, [clearQueue]);

  return { isGaplessArmed: pairKey !== null && armedPairKey === pairKey };
}
