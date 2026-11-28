import type { RatingValue } from '@elv/data';
import {
  ArtworkImage,
  CtaButton,
  IconButton,
  Scrim,
  TABULAR_NUMS_STYLE,
  Tooltip,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { isValidTrailerStreamUrl, isValidYoutubeId } from './detail-trailer-utils';
import {
  computeHoverPreviewRect,
  formatHoverPreviewMeta,
  type HoverPreviewHydratedMetadata,
  type HoverPreviewRect,
  type PosterHoverPreviewEntry,
  translateHoverCardKey,
} from './poster-hover-preview-model';

/** Props of {@link PosterHoverPreviewCard}. */
export interface PosterHoverPreviewCardProps {
  readonly entry: PosterHoverPreviewEntry;
  readonly anchorRect: HoverPreviewRect;
  readonly cardWidth?: number;
  readonly hydration: HoverPreviewHydratedMetadata;
  readonly metadataSettled: boolean;
  readonly isFavorite: boolean;
  readonly isWatched: boolean;
  readonly userRating: RatingValue | null;
  readonly onPreviewPointerEnter: () => void;
  readonly onPreviewPointerLeave: () => void;
  readonly onPlay: () => void;
  readonly onOpenDetail: () => void;
  readonly onOpenTrailer: () => void;
  readonly onToggleFavorite: () => void;
  readonly onToggleWatched: () => void;
  readonly onToggleRating: (next: RatingValue) => void;
  readonly onDismissRecommendation: () => void;
}

/**
 * Floating Desktop expanded hover preview card anchored cleanly to a vertical `2:3` poster card
 * via fixed portal coordinates (`zIndex: 42`, Cinema Quietude v3).
 */
export const PosterHoverPreviewCard = memo(function PosterHoverPreviewCardInner({
  entry,
  anchorRect,
  cardWidth,
  hydration,
  metadataSettled,
  isFavorite,
  isWatched,
  userRating,
  onPreviewPointerEnter,
  onPreviewPointerLeave,
  onPlay,
  onOpenDetail,
  onOpenTrailer,
  onToggleFavorite,
  onToggleWatched,
  onToggleRating,
  onDismissRecommendation,
}: PosterHoverPreviewCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();

  const position = useMemo(
    () =>
      computeHoverPreviewRect(
        anchorRect,
        { width: viewport.width, height: viewport.height },
        cardWidth,
      ),
    [anchorRect, cardWidth, viewport.height, viewport.width],
  );

  const hasTrailer =
    isValidTrailerStreamUrl(hydration.trailerStreamUrl) ||
    isValidYoutubeId(hydration.trailerYoutubeId);

  const formatRuntime = useCallback(
    (minutes: number) => i18n.t('detail.runtimeMin', { minutes }),
    [i18n],
  );
  const metaText = useMemo(
    () =>
      formatHoverPreviewMeta({
        year: hydration.year,
        rating: hydration.rating,
        runtimeMin: hydration.runtimeMin,
        formatRuntime,
      }),
    [formatRuntime, hydration.rating, hydration.runtimeMin, hydration.year],
  );

  const playLabel = translateHoverCardKey(i18n, 'card.hoverPlay');
  const trailerLabel = translateHoverCardKey(i18n, 'card.hoverTrailer');
  const unavailableLabel = translateHoverCardKey(i18n, 'card.hoverUnavailable');
  const dontRecommendLabel = translateHoverCardKey(i18n, 'card.dontRecommend');
  const trailerTooltip = hasTrailer || !metadataSettled ? trailerLabel : unavailableLabel;

  const cursor = webCursorPointer();
  const blur = webBackdropBlur(16);
  const shadow = webShadow('0 18px 44px rgba(0, 0, 0, 0.72)');
  const cardTransition = webTransition(theme, 'opacity, transform');

  const fixedPositionStyle: ViewStyle = {
    position: 'fixed',
    left: position.left,
    top: position.top,
    width: position.width,
    maxHeight: position.maxHeight,
    zIndex: 42,
  } as unknown as ViewStyle;

  const artworkUri = hydration.backdropUri ?? entry.posterUri;
  const plotText = hydration.plot?.trim() ?? '';
  const allowDismiss = entry.allowDismissRecommendation !== false;

  return (
    <View
      testID="poster-hover-preview-card"
      onPointerEnter={onPreviewPointerEnter}
      onPointerLeave={onPreviewPointerLeave}
      style={[
        styles.card,
        fixedPositionStyle,
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.glassBorder,
          borderRadius: theme.radius.modal,
        },
        shadow,
        blur,
        cardTransition,
      ]}
    >
      <Pressable
        testID="hover-preview-artwork"
        accessibilityRole="button"
        accessibilityLabel={hydration.title}
        onPress={onOpenDetail}
        style={({ pressed }) => [styles.artworkPress, { opacity: pressed ? 0.92 : 1 }, cursor]}
      >
        <ArtworkImage
          uri={artworkUri}
          label={hydration.title}
          aspectRatio={16 / 9}
          maxDecodePx={480}
          borderRadius={0}
          testID="hover-preview-artwork-image"
        />
        <Scrim direction="bottom" color={theme.colors.bgElevated} />
      </Pressable>

      <View style={[styles.body, { padding: 14, gap: 10 }]}>
        <Pressable
          testID="hover-preview-title"
          accessibilityRole="button"
          accessibilityLabel={hydration.title}
          onPress={onOpenDetail}
          style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }, cursor]}
        >
          <Text
            numberOfLines={2}
            style={[theme.typography.title, styles.title, { color: theme.colors.textPrimary }]}
          >
            {hydration.title}
          </Text>
        </Pressable>

        <CtaButton
          testID="hover-preview-play"
          variant="primary"
          icon="play"
          label={playLabel}
          onPress={onPlay}
          style={styles.playButton}
        />

        <View testID="hover-preview-actions-grid" style={styles.actionsGrid}>
          <View style={styles.actionsRow}>
            <Tooltip
              content={trailerTooltip}
              placement="top"
              testID="hover-preview-trailer-tooltip"
            >
              <IconButton
                testID="hover-preview-trailer"
                icon="film"
                size={42}
                tooltip={false}
                disabled={!hasTrailer}
                accessibilityLabel={trailerTooltip}
                {...(hasTrailer ? { onPress: onOpenTrailer } : {})}
              />
            </Tooltip>

            <IconButton
              testID="hover-preview-mylist"
              icon={isFavorite ? 'check' : 'plus'}
              size={42}
              tooltipPlacement="top"
              active={isFavorite}
              accessibilityLabel={isFavorite ? i18n.t('home.inMyList') : i18n.t('home.addToList')}
              onPress={onToggleFavorite}
            />

            <IconButton
              testID="hover-preview-watched"
              icon="check"
              size={42}
              tooltipPlacement="top"
              active={isWatched}
              accessibilityLabel={
                isWatched ? i18n.t('home.markUnwatched') : i18n.t('home.markWatched')
              }
              onPress={onToggleWatched}
            />
          </View>

          <View style={styles.actionsRow}>
            <IconButton
              testID="hover-preview-like"
              icon={userRating === 'like' ? 'likeFilled' : 'like'}
              size={42}
              tooltipPlacement="top"
              active={userRating === 'like'}
              accessibilityLabel={
                userRating === 'like' ? i18n.t('rating.clearLike') : i18n.t('rating.like')
              }
              onPress={() => onToggleRating('like')}
            />

            <IconButton
              testID="hover-preview-dislike"
              icon={userRating === 'dislike' ? 'dislikeFilled' : 'dislike'}
              size={42}
              tooltipPlacement="top"
              active={userRating === 'dislike'}
              accessibilityLabel={
                userRating === 'dislike' ? i18n.t('rating.clearDislike') : i18n.t('rating.dislike')
              }
              onPress={() => onToggleRating('dislike')}
            />

            {allowDismiss ? (
              <IconButton
                testID="hover-preview-dismiss"
                icon="ban"
                size={42}
                tooltipPlacement="top"
                accessibilityLabel={dontRecommendLabel}
                onPress={onDismissRecommendation}
              />
            ) : (
              <View style={styles.actionSpacer} />
            )}
          </View>
        </View>

        {metaText !== undefined ? (
          <Text
            testID="hover-preview-meta"
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {metaText}
          </Text>
        ) : null}

        {plotText.length > 0 ? (
          <Text
            testID="hover-preview-synopsis"
            numberOfLines={3}
            style={[theme.typography.caption, styles.synopsis, { color: theme.colors.textMuted }]}
          >
            {plotText}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

PosterHoverPreviewCard.displayName = 'PosterHoverPreviewCard';

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    overflow: 'hidden',
    elevation: 16,
  },
  artworkPress: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
  },
  body: {
    flexShrink: 1,
  },
  title: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  playButton: {
    width: '100%',
    alignSelf: 'stretch',
  },
  actionsGrid: {
    gap: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionSpacer: {
    width: 42,
    height: 42,
  },
  synopsis: {
    lineHeight: 17,
  },
});
