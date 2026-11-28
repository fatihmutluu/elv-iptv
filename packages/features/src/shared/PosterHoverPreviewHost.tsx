import { computeResumePositionMs } from '@elv/data';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { TrailerExternalPort } from '../ports/trailer-port';
import type { VideoHost } from '../ports/video-host';
import type { DetailTarget } from './detail-target';
import { PosterHoverPreviewCard } from './PosterHoverPreviewCard';
import {
  usePosterHoverPreview,
  usePosterHoverPreviewActions,
  usePosterHoverPreviewState,
} from './PosterHoverPreviewContext';

/** Render callback props supplied by {@link PosterHoverPreviewHost} to display the trailer modal. */
interface HoverTrailerModalRenderProps {
  readonly visible: boolean;
  readonly title: string;
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
  readonly videoHost?: VideoHost;
  readonly trailerExternal?: TrailerExternalPort;
  readonly onClose: () => void;
}

/** Props of {@link PosterHoverPreviewHost}. */
export interface PosterHoverPreviewHostProps {
  readonly videoHost?: VideoHost;
  readonly trailerExternal?: TrailerExternalPort;
  readonly suppressed?: boolean;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly renderTrailerModal?: (props: HoverTrailerModalRenderProps) => ReactElement | null;
}

interface ActiveTrailerState {
  readonly title: string;
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
}

/**
 * Root portal host rendering the active Desktop {@link PosterHoverPreviewCard} and launching
 * the injected trailer modal cleanly above scroll containers and horizontal rails.
 */
export function PosterHoverPreviewHost({
  videoHost,
  trailerExternal,
  suppressed = false,
  onPlay,
  onOpenDetail,
  renderTrailerModal,
}: PosterHoverPreviewHostProps): ReactElement | null {
  const active = usePosterHoverPreviewState();
  const { dismissNow } = usePosterHoverPreview();
  const actions = usePosterHoverPreviewActions();
  const [activeTrailer, setActiveTrailer] = useState<ActiveTrailerState | null>(null);

  useEffect(() => {
    if (suppressed) {
      setActiveTrailer(null);
      dismissNow();
    }
  }, [dismissNow, suppressed]);

  const handleOpenDetail = useCallback(() => {
    if (!active) return;
    const { entry, hydration } = active;
    dismissNow();
    if (entry.onOpenDetail) {
      entry.onOpenDetail();
      return;
    }
    onOpenDetail({
      itemKey: entry.itemKey,
      sourceId: entry.sourceId,
      kind: entry.kind,
      title: hydration.title || entry.title,
      ...(entry.categoryId !== undefined ? { categoryId: entry.categoryId } : {}),
      posterUri: entry.posterUri,
      backdropUri: hydration.backdropUri ?? entry.backdropUri ?? null,
      year: hydration.year,
      rating: hydration.rating,
    });
  }, [active, dismissNow, onOpenDetail]);

  const handlePlay = useCallback(() => {
    if (!active) return;
    const { entry, hydration } = active;
    dismissNow();
    if (entry.onPlay) {
      entry.onPlay();
      return;
    }
    if (entry.kind === 'movie') {
      const startPositionMs = computeResumePositionMs({
        positionMs: entry.positionMs ?? 0,
        watched: active.isWatched,
      });
      onPlay({
        itemKey: entry.itemKey,
        sourceId: entry.sourceId,
        title: hydration.title || entry.title,
        kind: 'vod',
        itemKind: 'movie',
        logo: entry.posterUri ?? hydration.backdropUri ?? null,
        startPositionMs,
      });
      return;
    }
    if (entry.onOpenDetail) {
      entry.onOpenDetail();
      return;
    }
    onOpenDetail({
      itemKey: entry.itemKey,
      sourceId: entry.sourceId,
      kind: entry.kind,
      title: hydration.title || entry.title,
      ...(entry.categoryId !== undefined ? { categoryId: entry.categoryId } : {}),
      posterUri: entry.posterUri,
      backdropUri: hydration.backdropUri ?? entry.backdropUri ?? null,
      year: hydration.year,
      rating: hydration.rating,
    });
  }, [active, dismissNow, onOpenDetail, onPlay]);

  const handleOpenTrailer = useCallback(() => {
    if (!active) return;
    const { hydration, entry } = active;
    dismissNow();
    setActiveTrailer({
      title: hydration.title || entry.title,
      trailerStreamUrl: hydration.trailerStreamUrl,
      trailerYoutubeId: hydration.trailerYoutubeId,
    });
  }, [active, dismissNow]);

  const handleCloseTrailer = useCallback(() => {
    setActiveTrailer(null);
  }, []);

  if (suppressed) return null;

  return (
    <>
      {active !== null ? (
        <PosterHoverPreviewCard
          entry={active.entry}
          anchorRect={active.anchorRect}
          {...(active.cardWidth !== undefined ? { cardWidth: active.cardWidth } : {})}
          hydration={active.hydration}
          metadataSettled={active.metadataSettled}
          isFavorite={active.isFavorite}
          isWatched={active.isWatched}
          userRating={active.userRating}
          onPreviewPointerEnter={actions.onPreviewPointerEnter}
          onPreviewPointerLeave={actions.onPreviewPointerLeave}
          onPlay={handlePlay}
          onOpenDetail={handleOpenDetail}
          onOpenTrailer={handleOpenTrailer}
          onToggleFavorite={actions.toggleFavorite}
          onToggleWatched={actions.toggleWatched}
          onToggleRating={actions.toggleRating}
          onDismissRecommendation={actions.dismissRecommendation}
        />
      ) : null}

      {renderTrailerModal
        ? renderTrailerModal({
            visible: activeTrailer !== null,
            title: activeTrailer?.title ?? '',
            trailerStreamUrl: activeTrailer?.trailerStreamUrl ?? null,
            trailerYoutubeId: activeTrailer?.trailerYoutubeId ?? null,
            ...(videoHost !== undefined ? { videoHost } : {}),
            ...(trailerExternal !== undefined ? { trailerExternal } : {}),
            onClose: handleCloseTrailer,
          })
        : null}
    </>
  );
}
