import type { CatalogService, ItemRow, SourceRow } from '@elv/data';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
import { useProfile } from '../shared';
import type { LiveMode, LiveTabMemory } from './live-model';
import type { LiveCatalogState } from './useLiveCatalog';
import { type LiveEmbeddedPreviewState, useLiveEmbeddedPreview } from './useLiveEmbeddedPreview';

/** Active channel previewed in two-step OK mode (`#145`). */
export interface TwoStepPreviewEntry {
  readonly channel: ItemRow;
  readonly index: number;
}

/** Options accepted by {@link useLiveTwoStepPreview}. */
export interface UseLiveTwoStepPreviewOptions {
  readonly mode: LiveMode;
  readonly liveOkTwoStepPreview: boolean;
  readonly activeFavoriteChannel: ItemRow | null;
  readonly readySources: readonly SourceRow[];
  readonly catalog: CatalogService;
  readonly live: Pick<LiveCatalogState, 'tuneChannel' | 'buildPlayTarget'>;
  readonly memoryRef: MutableRefObject<LiveTabMemory>;
  readonly onPlay: (target: PlayTarget) => void;
  /** Suppresses embedded live previews (e.g. while Floating Mini-Player owns the active stream). */
  readonly suppressEmbeddedPreview?: boolean;
  readonly videoHost?: VideoHost;
  readonly playbackGuard?: PlaybackGuard;
}

/**
 * Coordinates single-connection-safe embedded live previews across `Favorites` stage and optional
 * `liveOkTwoStepPreview` in `Channels` / `TV Guide`, releasing the preview engine before fullscreen
 * `onPlay` handoff (`#145`).
 */
export function useLiveTwoStepPreview(opts: UseLiveTwoStepPreviewOptions): {
  readonly preview: LiveEmbeddedPreviewState;
  readonly previewedChannel: TwoStepPreviewEntry | null;
  readonly twoStepPreviewActive: boolean;
  readonly clearTwoStepPreview: () => void;
  readonly handleWatchAndPlay: (channel: ItemRow, index: number) => void;
  readonly handleWatchFromFavorites: (channel: ItemRow, index: number) => void;
} {
  const {
    mode,
    liveOkTwoStepPreview,
    activeFavoriteChannel,
    readySources,
    catalog,
    live,
    memoryRef,
    onPlay,
    suppressEmbeddedPreview = false,
    videoHost,
    playbackGuard,
  } = opts;

  const { activeProfileId, parentalUnlocked } = useProfile();
  const [previewedChannel, setPreviewedChannel] = useState<TwoStepPreviewEntry | null>(null);
  const [previewResetSeq, setPreviewResetSeq] = useState(0);
  const previewedRef = useRef<TwoStepPreviewEntry | null>(null);
  previewedRef.current = previewedChannel;
  const modeRef = useRef<LiveMode>(mode);
  modeRef.current = mode;
  const prevProfileIdRef = useRef(activeProfileId);
  const prevUnlockedRef = useRef(parentalUnlocked);
  const mountedRef = useRef(true);
  const handoffInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearTwoStepPreview = useCallback(() => {
    previewedRef.current = null;
    setPreviewedChannel(null);
  }, []);

  // Stop & clear embedded preview immediately on profile switch or parental re-lock (#15, #31).
  useEffect(() => {
    const profileChanged = prevProfileIdRef.current !== activeProfileId;
    const relocked = prevUnlockedRef.current && !parentalUnlocked;
    prevProfileIdRef.current = activeProfileId;
    prevUnlockedRef.current = parentalUnlocked;
    if (profileChanged || relocked) {
      clearTwoStepPreview();
      setPreviewResetSeq((n) => n + 1);
    }
  }, [activeProfileId, clearTwoStepPreview, parentalUnlocked]);

  useEffect(() => {
    if (!liveOkTwoStepPreview || mode === 'favorites' || suppressEmbeddedPreview) {
      clearTwoStepPreview();
    }
  }, [clearTwoStepPreview, liveOkTwoStepPreview, mode, suppressEmbeddedPreview]);

  const twoStepPreviewActive =
    !suppressEmbeddedPreview &&
    liveOkTwoStepPreview &&
    (mode === 'channels' || mode === 'epg') &&
    previewedChannel !== null;
  const previewChannel =
    mode === 'favorites'
      ? activeFavoriteChannel
      : twoStepPreviewActive
        ? previewedChannel.channel
        : null;

  const preview = useLiveEmbeddedPreview({
    enabled: !suppressEmbeddedPreview && previewChannel !== null,
    activeChannel: previewChannel,
    sources: readySources,
    catalog,
    sessionResetKey: previewResetSeq,
    ...(videoHost !== undefined ? { videoHost } : {}),
    ...(playbackGuard !== undefined ? { playbackGuard } : {}),
  });

  const handleWatchAndPlay = useCallback(
    (ch: ItemRow, idx: number) => {
      if (!liveOkTwoStepPreview) {
        live.tuneChannel(ch, idx);
        onPlay(live.buildPlayTarget(ch, idx, 'category'));
        return;
      }
      if (handoffInFlightRef.current) return;
      if (previewedRef.current?.channel.key !== ch.key) {
        live.tuneChannel(ch, idx);
        const next: TwoStepPreviewEntry = { channel: ch, index: idx };
        previewedRef.current = next;
        setPreviewedChannel(next);
        return;
      }
      live.tuneChannel(ch, idx);
      const target = live.buildPlayTarget(ch, idx, 'category');
      if (videoHost === undefined) {
        clearTwoStepPreview();
        onPlay(target);
        return;
      }
      const capturedMode = modeRef.current;
      const capturedCategoryId = memoryRef.current.categoryId;
      handoffInFlightRef.current = true;
      void (async () => {
        let releasedOk = false;
        try {
          await preview.stopAndRelease();
          releasedOk = true;
        } catch {
          releasedOk = false;
        } finally {
          handoffInFlightRef.current = false;
        }
        if (
          releasedOk &&
          mountedRef.current &&
          modeRef.current === capturedMode &&
          memoryRef.current.mode === capturedMode &&
          memoryRef.current.categoryId === capturedCategoryId
        ) {
          clearTwoStepPreview();
          onPlay(target);
        }
      })();
    },
    [
      clearTwoStepPreview,
      live.buildPlayTarget,
      live.tuneChannel,
      liveOkTwoStepPreview,
      memoryRef,
      onPlay,
      preview.stopAndRelease,
      videoHost,
    ],
  );

  const handleWatchFromFavorites = useCallback(
    (ch: ItemRow, idx: number) => {
      if (handoffInFlightRef.current) return;
      live.tuneChannel(ch, idx);
      const target = live.buildPlayTarget(ch, idx, 'favorites');
      if (videoHost === undefined) return onPlay(target);
      handoffInFlightRef.current = true;
      void (async () => {
        let releasedOk = false;
        try {
          await preview.stopAndRelease();
          releasedOk = true;
        } catch {
          releasedOk = false;
        } finally {
          handoffInFlightRef.current = false;
        }
        if (releasedOk && mountedRef.current && memoryRef.current.mode === 'favorites') {
          onPlay(target);
        }
      })();
    },
    [live.buildPlayTarget, live.tuneChannel, memoryRef, onPlay, preview.stopAndRelease, videoHost],
  );

  return {
    preview,
    previewedChannel,
    twoStepPreviewActive,
    clearTwoStepPreview,
    handleWatchAndPlay,
    handleWatchFromFavorites,
  };
}
