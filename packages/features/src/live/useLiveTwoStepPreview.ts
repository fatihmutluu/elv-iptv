import type { CatalogService, ItemRow, SourceRow } from '@elv/data';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
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
    videoHost,
    playbackGuard,
  } = opts;

  const [previewedChannel, setPreviewedChannel] = useState<TwoStepPreviewEntry | null>(null);
  const previewedRef = useRef<TwoStepPreviewEntry | null>(null);
  previewedRef.current = previewedChannel;
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

  useEffect(() => {
    if (!liveOkTwoStepPreview || mode === 'favorites') {
      clearTwoStepPreview();
    }
  }, [clearTwoStepPreview, liveOkTwoStepPreview, mode]);

  const twoStepPreviewActive =
    liveOkTwoStepPreview && (mode === 'channels' || mode === 'epg') && previewedChannel !== null;
  const previewChannel =
    mode === 'favorites'
      ? activeFavoriteChannel
      : twoStepPreviewActive
        ? previewedChannel.channel
        : null;

  const preview = useLiveEmbeddedPreview({
    enabled: previewChannel !== null,
    activeChannel: previewChannel,
    sources: readySources,
    catalog,
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
      handoffInFlightRef.current = true;
      void preview.stopAndRelease().then(() => {
        handoffInFlightRef.current = false;
        if (mountedRef.current) {
          clearTwoStepPreview();
          onPlay(target);
        }
      });
    },
    [
      clearTwoStepPreview,
      live.buildPlayTarget,
      live.tuneChannel,
      liveOkTwoStepPreview,
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
      void preview.stopAndRelease().then(() => {
        handoffInFlightRef.current = false;
        if (mountedRef.current && memoryRef.current.mode === 'favorites') onPlay(target);
      });
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
