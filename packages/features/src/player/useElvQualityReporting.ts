import type { CatalogService, LiveVariantOption } from '@elv/data';
import type { ElvError } from '@elv/domain';
import type { PlaybackStatus, StreamVideoInfo } from '@elv/playback';
import { useEffect, useRef } from 'react';
import type { PlayTarget } from '../ports/play-target';
import { useLiveQualityVariants } from './useLiveQualityVariants';

const NON_STREAM_ERROR_CODES = new Set([
  'parental-locked',
  'source-excluded',
  'connection-limit',
  'aborted',
  'abort',
  'cancelled',
  'canceled',
  'user-cancelled',
  'user-aborted',
]);

function isNonStreamPlaybackError(error: ElvError | undefined): boolean {
  if (error === undefined) return false;
  if (error.category === 'auth') return true;
  const code = error.code.toLowerCase();
  return NON_STREAM_ERROR_CODES.has(code) || code.includes('cancel') || code.includes('abort');
}

/** Parameters for {@link useElvQualityReporting}. */
export interface UseElvQualityReportingParams {
  readonly catalog: Partial<
    Pick<CatalogService, 'recordPlaybackQuality' | 'recordPlaybackVariantFailure'>
  >;
  readonly activeTarget: PlayTarget;
  readonly status: PlaybackStatus;
  readonly videoInfo?: StreamVideoInfo | undefined;
  readonly verifyRealQuality?: boolean | undefined;
  readonly liveAutoFailover?: boolean | undefined;
  readonly liveVariants?: readonly LiveVariantOption[] | undefined;
  readonly onFailoverVariant?: ((itemKey: string, title?: string) => void) | undefined;
}

/**
 * Reports verified stream resolution (`width > 0 && height > 0`) once per played item when
 * `status.kind === 'playing'` and records terminal stream errors via
 * `recordPlaybackVariantFailure` (`#511`). Guards reporting behind `seenActiveTuneKeyRef`
 * so stale `playing`/`failed` states across `zapBy` or live auto-failover never poison quality
 * memory or trigger cascading multi-variant failover burn-through.
 */
export function useElvQualityReporting({
  catalog,
  activeTarget,
  status,
  videoInfo,
  verifyRealQuality = false,
  liveAutoFailover = false,
  liveVariants,
  onFailoverVariant,
}: UseElvQualityReportingParams): void {
  const itemKey = activeTarget.itemKey;
  const targetTitle = activeTarget.title;
  const isLive = activeTarget.kind === 'live';

  const prevItemKeyRef = useRef<string>(itemKey);
  const seenActiveTuneKeyRef = useRef<string | null>(itemKey);
  const reportedSuccessKeyRef = useRef<string | null>(null);
  const reportedFailureKeyRef = useRef<string | null>(null);
  const failedVariantKeysRef = useRef<Set<string>>(new Set());
  const lastLiveTitleRef = useRef<string | null>(null);

  const statusKind: string = status.kind;
  const isTuningOrBuffering = statusKind === 'tuning' || statusKind === 'buffering';
  const failedError = status.kind === 'failed' ? status.error : undefined;

  useEffect(() => {
    const targetChanged = prevItemKeyRef.current !== itemKey;
    if (targetChanged) {
      prevItemKeyRef.current = itemKey;
      reportedSuccessKeyRef.current = null;
      reportedFailureKeyRef.current = null;
      seenActiveTuneKeyRef.current = isTuningOrBuffering ? itemKey : null;
      return;
    }
    if (isTuningOrBuffering) {
      seenActiveTuneKeyRef.current = itemKey;
      reportedSuccessKeyRef.current = null;
      reportedFailureKeyRef.current = null;
    }
  }, [isTuningOrBuffering, itemKey]);

  useEffect(() => {
    if (!isLive) {
      failedVariantKeysRef.current.clear();
      lastLiveTitleRef.current = null;
      return;
    }
    const baseKeys = liveVariants?.map((v) => v.key);
    if (
      lastLiveTitleRef.current !== null &&
      lastLiveTitleRef.current !== itemKey &&
      (baseKeys === undefined || !baseKeys.includes(lastLiveTitleRef.current))
    ) {
      failedVariantKeysRef.current.clear();
    }
    lastLiveTitleRef.current = itemKey;
  }, [isLive, itemKey, liveVariants]);

  useEffect(() => {
    if (!verifyRealQuality) return;
    if (status.kind !== 'playing') return;
    if (seenActiveTuneKeyRef.current !== itemKey) return;
    const width = videoInfo?.width ?? 0;
    const height = videoInfo?.height ?? 0;
    if (width <= 0 || height <= 0) return;
    if (reportedSuccessKeyRef.current === itemKey) return;
    reportedSuccessKeyRef.current = itemKey;
    void catalog.recordPlaybackQuality?.({
      itemKey,
      actualWidth: width,
      actualHeight: height,
      actualVideoCodec: videoInfo?.codec ?? null,
      actualHdr: videoInfo?.hdr ?? null,
      claimedLabel: targetTitle,
    });
  }, [
    catalog,
    itemKey,
    status.kind,
    targetTitle,
    verifyRealQuality,
    videoInfo?.codec,
    videoInfo?.hdr,
    videoInfo?.height,
    videoInfo?.width,
  ]);

  useEffect(() => {
    if (status.kind !== 'failed') return;
    if (seenActiveTuneKeyRef.current !== itemKey) return;
    if (isNonStreamPlaybackError(failedError)) return;

    if (verifyRealQuality && reportedFailureKeyRef.current !== itemKey) {
      reportedFailureKeyRef.current = itemKey;
      void catalog.recordPlaybackVariantFailure?.(itemKey);
    }

    if (
      liveAutoFailover &&
      isLive &&
      onFailoverVariant !== undefined &&
      liveVariants !== undefined &&
      liveVariants.length > 1
    ) {
      failedVariantKeysRef.current.add(itemKey);
      const nextHealthy = liveVariants.find(
        (v) =>
          v.key !== itemKey && v.isUnreliable !== true && !failedVariantKeysRef.current.has(v.key),
      );
      if (nextHealthy !== undefined) {
        onFailoverVariant(nextHealthy.key, nextHealthy.title);
      }
    }
  }, [
    catalog,
    failedError,
    isLive,
    itemKey,
    liveAutoFailover,
    liveVariants,
    onFailoverVariant,
    status.kind,
    verifyRealQuality,
  ]);
}

/** Composes live channel quality variants and ELV Mode quality/failover reporting for `PlayerScreen` (`#511`). */
export function usePlayerLiveVariantsAndElvQuality(params: {
  readonly catalog: Partial<
    Pick<CatalogService, 'liveVariants' | 'recordPlaybackQuality' | 'recordPlaybackVariantFailure'>
  >;
  readonly activeTarget: PlayTarget;
  readonly status: PlaybackStatus;
  readonly videoInfo?: StreamVideoInfo | undefined;
  readonly verifyRealQuality?: boolean | undefined;
  readonly elvLiveEnhance?: boolean | undefined;
  readonly onSelectVariant: (itemKey: string, title?: string) => void;
}) {
  const quality = useLiveQualityVariants({
    catalog: params.catalog,
    activeTarget: params.activeTarget,
    crossCategory: params.elvLiveEnhance,
    onSelect: params.onSelectVariant,
  });
  useElvQualityReporting({
    catalog: params.catalog,
    activeTarget: params.activeTarget,
    status: params.status,
    videoInfo: params.videoInfo,
    verifyRealQuality: params.verifyRealQuality,
    liveAutoFailover: params.elvLiveEnhance,
    liveVariants: quality.variants,
    onFailoverVariant: params.onSelectVariant,
  });
  return quality;
}
